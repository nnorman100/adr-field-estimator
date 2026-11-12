import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Harness } from './team-harness';

// S4-6, the Prices API through the real route files as the runtime role against Postgres (see
// team-members.test.ts for the setup): reading, the starter list, saving the working copy, preview,
// publish (range choice, blank and zero prices, fresh sign-in, retried keys, racing publishes),
// versions, restore, the CSV export and the operator's audited read-only view.
const live = vi.hoisted(() => ({ harness: null as Harness | null }));
vi.mock('@/lib/auth/services', () => ({
  identityServices: () => live.harness!.identity,
  operatorServices: () => live.harness!.operators,
  serverDatabase: () => live.harness!.handle.db,
}));
vi.mock('@/lib/prices/services', () => ({ pricesServices: () => live.harness!.prices }));
vi.mock('@/lib/platform/services', () => ({ platformServices: () => live.harness!.platform }));

const { GET: readPrices } = await import('@/app/api/prices/route');
const { PUT: saveWorkingCopy } = await import('@/app/api/prices/working-copy/route');
const { POST: preview } = await import('@/app/api/prices/preview/route');
const { POST: publish } = await import('@/app/api/prices/publish/route');
const { GET: listVersions } = await import('@/app/api/prices/versions/route');
const { GET: readVersion } = await import('@/app/api/prices/versions/[versionId]/route');
const { POST: restore } = await import('@/app/api/prices/versions/[versionId]/restore/route');
const { GET: exportList } = await import('@/app/api/prices/export/route');
const { GET: supportPrices } = await import('@/app/api/platform/companies/[companyId]/prices/route');
const { contentHash, parseTable } = await import('@/engine/table');
const { starterTable } = await import('@/lib/prices/starter');
const { everything, operatorClaims, owner, params, request, resetTeamDatabase, startTeamServer } = await import('./team-harness');
type FakeClaims = import('./team-harness').FakeClaims;

let base: Awaited<ReturnType<typeof startTeamServer>>;
let h: Harness;

beforeAll(async () => {
  base = await startTeamServer();
});

beforeEach(async () => {
  h = await resetTeamDatabase(base, live.harness);
  live.harness = h;
  // Company A has price books on; company B has not.
  await h.admin`INSERT INTO company_feature_flags (company_id, flag, enabled) VALUES (${h.seed.a}, 'price_books', true)`;
});

afterAll(async () => {
  await live.harness?.handle.close();
  await base?.admin.end({ timeout: 5 });
  await base?.server.stop();
});

const estimator: FakeClaims = { tenant: 'tenant-a', uid: 'estimator-a' };
const office: FakeClaims = { tenant: 'tenant-a', uid: 'office-a' };
const KEY = 'publish-key-0001';

// Response and table bodies are read loosely here; the routes' own types are checked by the compiler.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const call = async (handler: (r: Request, c: never) => Response | Promise<Response>, claims: FakeClaims | null, init: { method?: string; body?: unknown } = {}, ids: Record<string, string> = {}) => {
  const response = await handler(request(claims, '/api/prices', init), params(ids) as never);
  return { status: response.status, body: (await response.clone().json().catch(() => null)) as Json | null, response };
};
const read = (claims: FakeClaims | null = owner()) => call(readPrices, claims);
const save = (expectedRevision: number, table: unknown, claims: FakeClaims = owner()) =>
  call(saveWorkingCopy, claims, { method: 'PUT', body: { expectedRevision, table } });
const publishAs = (body: unknown, claims: FakeClaims = owner()) => call(publish, claims, { method: 'POST', body });

// The starter with a price on every item, the room-size limits set and one item switched off.
function pricedStarter(): Json {
  const table = starterTable();
  return JSON.parse(
    JSON.stringify({
      ...table,
      policy: { ...table.policy, size_tiers: { s_up_to_sf: 100, m_up_to_sf: 250, l_up_to_sf: 500 } },
      items: table.items.map((item) =>
        item.unit === 'room'
          ? { ...item, tier_prices: { s: '10.00', m: '20.00', l: '30.00', xl: '40.00' } }
          : { ...item, unit_price: '1.50', enabled: item.item_id !== 'moisture_scan' },
      ),
    }),
  ) as Json;
}

// A one-item table whose sample prices can be worked by hand: $2.00 per square foot of wet floor.
function smallTable(price = '2.00'): Json {
  return {
    items: [{ item_id: 'extraction', group: 'treatment', name: 'Extraction', unit: 'sf', quantity_source: 'room:wet_floor', unit_price: price }],
    policy: {
      estimate_mode: 'single',
      range: { first_sf: 1000, first_percent: '0', beyond_percent: '0' },
      after_hours: { multiplier: '1' },
      category_multipliers: { '1': '1', '2': '1', '3': '1' },
      cabinetry: { multiplier: '1', scope: 'finished_only' },
      sales_tax: { enabled: false, percent: '0' },
    },
  };
}

const counts = async () =>
  (
    await h.admin<{ versions: number; copies: number; audits: number }[]>`
      SELECT (SELECT count(*) FROM price_table_versions)::int AS versions,
             (SELECT count(*) FROM price_table_working_copies)::int AS copies,
             (SELECT count(*) FROM audit_events WHERE action LIKE 'price_%' OR action LIKE 'support_prices%')::int AS audits
    `
  )[0]!;
const auditRows = () =>
  h.admin<{ actor_id: string | null; operator_actor_id: string | null; action: string; target: string; details: Json }[]>`
    SELECT actor_id, operator_actor_id, action, target, details FROM audit_events WHERE action LIKE 'price_%' OR action LIKE 'support_prices%' ORDER BY id
  `;

describe('reading the prices', () => {
  it('shows a new company’s owner the starter list as an unsaved working copy, and writes nothing', async () => {
    const before = await everything(h.admin);
    const { status, body, response } = await read();
    expect(status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(body!.view).toBe('owner');
    expect(body!.current).toBeNull();
    expect(body!.workingCopy).toMatchObject({ revision: 0, baseSequence: null, updatedAt: null });
    expect(body!.workingCopy.table).toEqual(JSON.parse(JSON.stringify(starterTable())));
    // Every price of the starter is blank.
    expect(JSON.stringify(body!.workingCopy.table)).not.toMatch(/"unit_price":"[0-9]/);
    expect(await everything(h.admin)).toBe(before);
  });

  it('shows an estimator and an office user the current prices only, never the working copy', async () => {
    for (const claims of [estimator, office]) {
      const { status, body } = await read(claims);
      expect({ status, body }).toEqual({ status: 200, body: { view: 'reader', current: null } });
    }
  });

  it('answers 404 on every price route when the company has not got price books switched on', async () => {
    const b = owner('owner-b', 'tenant-b');
    const before = await everything(h.admin);
    const id = h.seed.b;
    const answers = [
      await call(readPrices, b),
      await call(saveWorkingCopy, b, { method: 'PUT', body: { expectedRevision: 0, table: starterTable() } }),
      await call(preview, b, { method: 'POST', body: {} }),
      await call(publish, b, { method: 'POST', body: { expectedRevision: 1, reason: 'First prices', publishKey: KEY, rangeChoice: 'single' } }),
      await call(listVersions, b),
      await call(readVersion, b, {}, { versionId: id }),
      await call(restore, b, { method: 'POST', body: { expectedRevision: 0 } }, { versionId: id }),
      await call(exportList, b),
    ];
    expect(answers.map((a) => [a.status, a.body])).toEqual(answers.map(() => [404, { error: 'not_found' }]));
    expect(await everything(h.admin)).toBe(before);
  });

  it('refuses a call with no sign-in', async () => {
    expect((await read(null)).status).toBe(401);
    expect((await save(0, starterTable(), null as never)).status).toBe(401);
  });
});

describe('who may change prices', () => {
  it('refuses an estimator and an office user on every route but the read, before anything is read or written', async () => {
    expect((await save(0, starterTable())).status).toBe(200);
    const before = await everything(h.admin);
    for (const claims of [estimator, office]) {
      const id = '00000000-0000-4000-8000-000000000000';
      const answers = [
        await call(saveWorkingCopy, claims, { method: 'PUT', body: { expectedRevision: 1, table: starterTable() } }),
        // The refusal comes before the body is looked at.
        await call(saveWorkingCopy, claims, { method: 'PUT', body: 'not json' }),
        await call(preview, claims, { method: 'POST', body: {} }),
        await call(publish, claims, { method: 'POST', body: { expectedRevision: 1, reason: 'First prices', publishKey: KEY, rangeChoice: 'single' } }),
        await call(listVersions, claims),
        await call(readVersion, claims, {}, { versionId: id }),
        await call(restore, claims, { method: 'POST', body: { expectedRevision: 1 } }, { versionId: id }),
        await call(exportList, claims),
      ];
      expect(answers.map((a) => [a.status, a.body])).toEqual(answers.map(() => [403, { error: 'not_allowed' }]));
    }
    expect(await everything(h.admin)).toBe(before);
  });
});

describe('saving the working copy', () => {
  it('creates the row at revision 1 from revision 0, then rises by one, and audits each save', async () => {
    const first = await save(0, starterTable());
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ revision: 1, baseSequence: null });
    const second = await save(1, pricedStarter());
    expect(second.body).toMatchObject({ revision: 2 });
    const stored = await h.admin<{ revision: number; content: Json }[]>`SELECT revision, content FROM price_table_working_copies`;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.revision).toBe(2);
    expect(stored[0]!.content).toEqual(JSON.parse(JSON.stringify(parseTable(pricedStarter()))));
    const items = parseTable(pricedStarter()).items.length;
    expect(await auditRows()).toEqual([
      { actor_id: h.seed.ownerA.actor, operator_actor_id: null, action: 'price_working_copy_saved', target: h.seed.a, details: { revision: 1, items: starterTable().items.length } },
      { actor_id: h.seed.ownerA.actor, operator_actor_id: null, action: 'price_working_copy_saved', target: h.seed.a, details: { revision: 2, items } },
    ]);
    const after = await read();
    expect(after.body!.workingCopy).toMatchObject({ revision: 2 });
    expect(after.body!.workingCopy.table).toEqual(JSON.parse(JSON.stringify(parseTable(pricedStarter()))));
  });

  it('answers 409 to a save made from an old revision, with the current one, and writes nothing', async () => {
    await save(0, starterTable());
    await save(1, pricedStarter());
    const before = await everything(h.admin);
    for (const stale of [0, 1, 7]) {
      const answer = await save(stale, starterTable());
      expect({ stale, status: answer.status, error: answer.body!.error }).toEqual({ stale, status: 409, error: 'stale_revision' });
      expect(answer.body!.revision).toBe(2);
    }
    expect(await everything(h.admin)).toBe(before);
  });

  it('lets only one of two saves from the same revision through', async () => {
    const answers = await Promise.all([save(0, starterTable()), save(0, pricedStarter())]);
    expect(answers.map((a) => a.status).sort()).toEqual([200, 409]);
    expect((await counts()).copies).toBe(1);
  });

  it('refuses a table the schema refuses, naming what to fix, and a malformed body, and writes nothing', async () => {
    const before = await everything(h.admin);
    const bad = pricedStarter();
    bad.items[0].unit_price = '-1';
    const invalid = await save(0, bad);
    expect(invalid.status).toBe(422);
    expect(invalid.body).toMatchObject({ error: 'invalid_table' });
    expect(invalid.body!.detail).toContain('items.0');
    const unknown = pricedStarter();
    unknown.items[0].unit_prise = '1.00';
    expect((await save(0, unknown)).status).toBe(422);
    const formula = pricedStarter();
    formula.items[0].name = '=HYPERLINK("x")';
    expect((await save(0, formula)).status).toBe(422);
    for (const body of ['not json', { table: starterTable() }, { expectedRevision: -1, table: {} }, { expectedRevision: 0, table: {}, extra: 1 }, [] as unknown]) {
      expect({ body, status: (await call(saveWorkingCopy, owner(), { method: 'PUT', body })).status }).toEqual({ body, status: 400 });
    }
    expect(await everything(h.admin)).toBe(before);
  });
});

describe('preview', () => {
  it('prices the sample jobs from a table in the body, by hand-worked numbers, and writes nothing', async () => {
    const before = await everything(h.admin);
    const { status, body } = await call(preview, owner(), { method: 'POST', body: { table: smallTable() } });
    expect(status).toBe(200);
    const totals = Object.fromEntries((body!.samples as Json[]).map((sample) => [sample.id, sample.result.totals?.low.total]));
    // $2.00 per sq ft of wet floor: 150, 60 and 570 sq ft.
    expect(totals).toMatchObject({ kitchen_cat1: '300.00', bathroom_cat3: '120.00', three_rooms_cat2: '1140.00' });
    expect(body!.publishCheck).toEqual({ ok: true });
    expect(await everything(h.admin)).toBe(before);
  });

  it('prices the stored working copy when the body names no table, and says why the starter cannot be priced', async () => {
    const starter = await call(preview, owner(), { method: 'POST', body: {} });
    expect(starter.status).toBe(200);
    expect(starter.body!.publishCheck.ok).toBe(false);
    expect((starter.body!.samples as Json[]).every((sample) => sample.result.ok === false && sample.result.stage === 'table')).toBe(true);
    await save(0, smallTable('3.00'));
    const stored = await call(preview, owner(), { method: 'POST', body: {} });
    expect((stored.body!.samples as Json[])[0]!.result.totals.low.total).toBe('450.00');
    expect((await counts()).audits).toBe(1);
  });

  it('lists the zero prices that still need confirming, and refuses a table that does not parse', async () => {
    const zero = smallTable('0');
    (zero.items as Json[])[0]!.allow_zero = true;
    const { body } = await call(preview, owner(), { method: 'POST', body: { table: zero } });
    expect(body!.zeroPrices).toEqual(['extraction']);
    expect(body!.publishCheck).toEqual({ ok: false, error: 'extraction: confirm the zero price' });
    const invalid = await call(preview, owner(), { method: 'POST', body: { table: { items: [] } } });
    expect(invalid.status).toBe(422);
  });
});

describe('publishing', () => {
  const publishBody = (extra: Json = {}) => ({ expectedRevision: 2, reason: 'First prices', publishKey: KEY, rangeChoice: 'range', ...extra });
  async function ready() {
    await save(0, starterTable());
    await save(1, pricedStarter());
  }

  it('publishes the working copy as version 1 with the owner’s range choice, and writes one audit row', async () => {
    await ready();
    const { status, body } = await publishAs(publishBody());
    expect(status).toBe(201);
    expect(body!.replayed).toBe(false);
    expect(body!.version).toMatchObject({ sequence: 1, engineVersion: 'dryscope-v3', reason: 'First prices', source: 'blank', publishedBy: h.seed.ownerA.actor });
    const [row] = await h.admin<{ content: Json; content_hash: string; publish_key: string }[]>`SELECT content, content_hash, publish_key FROM price_table_versions`;
    expect(row!.content.policy.estimate_mode).toBe('range');
    expect(row!.content_hash).toBe(contentHash(parseTable(row!.content)));
    expect(body!.version.contentHash).toBe(row!.content_hash);
    expect(row!.publish_key).toBe(KEY);
    // The working copy is now that version, and is shown with it.
    expect(body!.workingCopy).toMatchObject({ revision: 3, baseSequence: 1 });
    const view = (await read()).body!;
    expect(view.current).toMatchObject({ sequence: 1, contentHash: row!.content_hash });
    expect(view.workingCopy.table.policy.estimate_mode).toBe('range');
    expect((await auditRows()).filter((entry) => entry.action === 'price_table_published')).toEqual([
      { actor_id: h.seed.ownerA.actor, operator_actor_id: null, action: 'price_table_published', target: body!.version.id, details: { sequence: 1, source: 'blank', items: parseTable(pricedStarter()).items.length, zeroPricesConfirmed: 0 } },
    ]);
    // The audit row holds ids and counts, never the reason or a price.
    expect(JSON.stringify(await auditRows())).not.toContain('First prices');
  });

  it('needs the owner to choose a range setting at the first publish, and not after', async () => {
    await ready();
    const before = await everything(h.admin);
    const refused = await publishAs(publishBody({ rangeChoice: undefined }));
    expect({ status: refused.status, error: refused.body!.error }).toEqual({ status: 422, error: 'range_choice_required' });
    expect(await everything(h.admin)).toBe(before);
    expect((await publishAs(publishBody({ rangeChoice: 'single' }))).status).toBe(201);
    const next = pricedStarter();
    next.items[0].unit_price = '2.50';
    await save(3, next);
    const second = await publishAs({ expectedRevision: 4, reason: 'Raised the call-out', publishKey: 'publish-key-0002' });
    expect(second.status).toBe(201);
    expect(second.body!.version.sequence).toBe(2);
    // The choice carries over: the second version keeps the first one's setting.
    expect(((await read()).body!.current.table as Json).policy.estimate_mode).toBe('single');
  });

  it('refuses a blank price and an unconfirmed zero price, naming the item, and writes nothing', async () => {
    await save(0, starterTable());
    const before = await everything(h.admin);
    const blank = await publishAs(publishBody({ expectedRevision: 1 }));
    expect({ status: blank.status, error: blank.body!.error }).toEqual({ status: 422, error: 'not_publishable' });
    expect(blank.body!.detail).toMatch(/price is blank|size_tiers/);
    expect(await everything(h.admin)).toBe(before);

    const zero = smallTable('0');
    (zero.items as Json[])[0]!.allow_zero = true;
    await save(1, zero);
    const refused = await publishAs(publishBody({ expectedRevision: 2 }));
    expect({ status: refused.status, detail: refused.body!.detail }).toEqual({ status: 422, detail: 'extraction: confirm the zero price' });
    const confirmed = await publishAs(publishBody({ expectedRevision: 2, confirmZeroPrices: ['extraction'] }));
    expect(confirmed.status).toBe(201);
    expect((await auditRows()).at(-1)!.details).toMatchObject({ zeroPricesConfirmed: 1 });
  });

  it('answers a retried publish with the same version, once', async () => {
    await ready();
    const first = await publishAs(publishBody());
    const retry = await publishAs(publishBody());
    expect(retry.status).toBe(200);
    expect(retry.body!.replayed).toBe(true);
    expect(retry.body!.version).toEqual(first.body!.version);
    expect(await counts()).toMatchObject({ versions: 1 });
    expect((await auditRows()).filter((entry) => entry.action === 'price_table_published')).toHaveLength(1);
    // The same key for a different publish is refused, not answered with the old version.
    const other = await publishAs(publishBody({ reason: 'A different reason' }));
    expect({ status: other.status, error: other.body!.error }).toEqual({ status: 409, error: 'publish_key_used' });
  });

  it('gives two publishes at once one version, never two with the same number', async () => {
    await ready();
    const answers = await Promise.all([publishAs(publishBody()), publishAs(publishBody({ publishKey: 'publish-key-0002' }))]);
    expect(answers.map((a) => a.status).sort()).toEqual([201, 409]);
    expect(answers.find((a) => a.status === 409)!.body!.error).toBe('stale_revision');
    expect(await counts()).toMatchObject({ versions: 1 });
  });

  it('refuses a stale revision, an unchanged table and a bad request, and writes nothing', async () => {
    await ready();
    await publishAs(publishBody());
    const before = await everything(h.admin);
    const stale = await publishAs(publishBody({ publishKey: 'publish-key-0002', expectedRevision: 2 }));
    expect({ status: stale.status, error: stale.body!.error, revision: stale.body!.revision }).toEqual({ status: 409, error: 'stale_revision', revision: 3 });
    const same = await publishAs(publishBody({ publishKey: 'publish-key-0003', expectedRevision: 3 }));
    expect({ status: same.status, error: same.body!.error }).toEqual({ status: 409, error: 'no_changes' });
    for (const body of [{}, publishBody({ reason: 'ab' }), publishBody({ reason: 'x'.repeat(501) }), publishBody({ publishKey: 'short' }), publishBody({ expectedRevision: 0 }), publishBody({ rangeChoice: 'both' }), publishBody({ extra: 1 })]) {
      expect((await publishAs(body)).status).toBe(400);
    }
    expect(await everything(h.admin)).toBe(before);
  });

  it('needs a sign-in under 15 minutes old, though a save does not', async () => {
    await ready();
    const stale: FakeClaims = { ...owner(), signedInAgo: 20 * 60 };
    const before = await everything(h.admin);
    const refused = await publishAs(publishBody(), stale);
    expect({ status: refused.status, error: refused.body!.error }).toEqual({ status: 401, error: 'sign_in_again' });
    expect(await everything(h.admin)).toBe(before);
    expect((await save(2, pricedStarter(), stale)).status).toBe(200);
    expect((await publishAs(publishBody({ expectedRevision: 3 }), { ...owner(), signedInAgo: 60 })).status).toBe(201);
  });

  it('refuses an estimator and an office user, and a company without the flag', async () => {
    await ready();
    for (const claims of [estimator, office]) expect((await publishAs(publishBody(), claims)).status).toBe(403);
    expect((await publishAs(publishBody(), owner('owner-b', 'tenant-b'))).status).toBe(404);
    expect(await counts()).toMatchObject({ versions: 0 });
  });
});

describe('versions and restore', () => {
  async function twoVersions() {
    await save(0, starterTable());
    await save(1, pricedStarter());
    await publishAs({ expectedRevision: 2, reason: 'First prices', publishKey: KEY, rangeChoice: 'range' });
    const next = pricedStarter();
    next.items[0].unit_price = '9.99';
    await save(3, next);
    await publishAs({ expectedRevision: 4, reason: 'Raised the call-out', publishKey: 'publish-key-0002' });
    return (await call(listVersions, owner())).body!.versions as Json[];
  }

  it('lists versions newest first and reads one whole', async () => {
    const versions = await twoVersions();
    expect(versions.map((v) => [v.sequence, v.reason])).toEqual([
      [2, 'Raised the call-out'],
      [1, 'First prices'],
    ]);
    expect(versions[0]!.table).toBeUndefined();
    const one = await call(readVersion, owner(), {}, { versionId: versions[1]!.id });
    expect(one.status).toBe(200);
    expect(one.body!.sequence).toBe(1);
    expect(one.body!.table.items[0].unit_price).toBe('1.50');
    for (const versionId of ['not-a-uuid', '00000000-0000-4000-8000-000000000000']) {
      expect((await call(readVersion, owner(), {}, { versionId })).status).toBe(404);
    }
  });

  it('copies an old version into the working copy without publishing, and a publish of it says so', async () => {
    const versions = await twoVersions();
    const first = versions[1]!;
    const before = await counts();
    const restored = await call(restore, owner(), { method: 'POST', body: { expectedRevision: 5 } }, { versionId: first.id });
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({ revision: 6, baseSequence: 1 });
    expect(restored.body!.table.items[0].unit_price).toBe('1.50');
    expect(await counts()).toMatchObject({ versions: before.versions, audits: before.audits + 1 });
    expect((await auditRows()).at(-1)).toEqual({ actor_id: h.seed.ownerA.actor, operator_actor_id: null, action: 'price_version_restored', target: first.id, details: { sequence: 1, revision: 6 } });
    // Version 2 is still the current prices until the restored copy is published.
    expect(((await read()).body!.current as Json).sequence).toBe(2);
    const published = await publishAs({ expectedRevision: 6, reason: 'Back to the first prices', publishKey: 'publish-key-0003' });
    expect(published.status).toBe(201);
    expect(published.body!.version).toMatchObject({ sequence: 3, source: 'restore' });
    // A restored table that was then edited is not called a restore.
    const edited = parseTable(pricedStarter());
    await save(7, { ...edited, items: edited.items.map((item, index) => (index === 1 ? { ...item, unit_price: '7.77' } : item)) });
    const after = await publishAs({ expectedRevision: 8, reason: 'Changed one price', publishKey: 'publish-key-0004' });
    expect(after.body!.version).toMatchObject({ sequence: 4, source: 'blank' });
  });

  it('refuses a restore from a stale revision, a version that is not the company’s, and a malformed request', async () => {
    const versions = await twoVersions();
    const before = await everything(h.admin);
    const stale = await call(restore, owner(), { method: 'POST', body: { expectedRevision: 1 } }, { versionId: versions[1]!.id });
    expect({ status: stale.status, error: stale.body!.error }).toEqual({ status: 409, error: 'stale_revision' });
    const missing = await call(restore, owner(), { method: 'POST', body: { expectedRevision: 5 } }, { versionId: '00000000-0000-4000-8000-000000000000' });
    expect(missing.status).toBe(404);
    expect((await call(restore, owner(), { method: 'POST', body: { expectedRevision: 5 } }, { versionId: 'nope' })).status).toBe(404);
    expect((await call(restore, owner(), { method: 'POST', body: {} }, { versionId: versions[1]!.id })).status).toBe(400);
    expect(await everything(h.admin)).toBe(before);
  });
});

describe('what a reader sees of published prices', () => {
  it('shows an estimator and an office user the enabled items only, without the reason or who published', async () => {
    await save(0, starterTable());
    await save(1, pricedStarter());
    await publishAs({ expectedRevision: 2, reason: 'First prices', publishKey: KEY, rangeChoice: 'range' });
    const owners = (await read()).body!.current.table as Json;
    expect(owners.items.some((item: Json) => item.item_id === 'moisture_scan')).toBe(true);
    for (const claims of [estimator, office]) {
      const { status, body } = await read(claims);
      expect(status).toBe(200);
      expect(Object.keys(body!)).toEqual(['view', 'current']);
      expect(Object.keys(body!.current).sort()).toEqual(['contentHash', 'engineVersion', 'id', 'publishedAt', 'sequence', 'table']);
      expect(body!.current.table.items.some((item: Json) => item.item_id === 'moisture_scan')).toBe(false);
      expect(body!.current.table.items.every((item: Json) => item.enabled)).toBe(true);
      // Still a table the schema accepts, and its suggested lists name only the items it holds.
      expect(() => parseTable(body!.current.table)).not.toThrow();
      expect(JSON.stringify(body)).not.toContain('First prices');
      expect(JSON.stringify(body)).not.toContain(h.seed.ownerA.actor);
    }
  });
});

describe('the CSV price list', () => {
  it('exports the working copy, one line per price, as a download for the owner only', async () => {
    await save(0, starterTable());
    const response = await exportList(request(owner(), '/api/prices/export'), params({}) as never);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="price-list.csv"');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const lines = (await response.text()).trim().split('\r\n');
    expect(lines[0]).toBe('item_id,code,name,group,trade,unit,enabled,row,room_type,up_to_sf,tier,price');
    const table = starterTable();
    // A per-room item has four lines (one per size), any other item one; every price is blank.
    const expected = table.items.reduce((sum, item) => sum + (item.unit === 'room' ? 4 : 1), 0);
    expect(lines).toHaveLength(1 + expected);
    expect(lines.slice(1).every((line) => line.endsWith(','))).toBe(true);
    expect(lines).toContain('service_call,SERVICE-CALL,Emergency service call,job_charges,job_charges,each,true,default,,,,');
    expect(lines).toContain('contents_manipulation,CONTENTS,Contents manipulation,treatment,water_mitigation,room,true,default,,,xl,');
    expect((await call(exportList, estimator)).status).toBe(403);
  });

  it('writes a price into its line', async () => {
    await save(0, smallTable('2.50'));
    const text = await (await exportList(request(owner(), '/api/prices/export'), params({}) as never)).text();
    expect(text).toContain('extraction,EXTRACTION,Extraction,treatment,,sf,true,default,,,,2.50');
  });
});

describe('the operator’s view of a company’s prices', () => {
  const as = (companyId: string, claims: FakeClaims | null = operatorClaims()) =>
    supportPrices(request(claims, `/api/platform/companies/${companyId}/prices`), params({ companyId }) as never);

  it('shows the current prices, the working copy and the versions, and audits the view naming the operator', async () => {
    await save(0, starterTable());
    await save(1, pricedStarter());
    await publishAs({ expectedRevision: 2, reason: 'First prices', publishKey: KEY, rangeChoice: 'range' });
    const response = await as(h.seed.a);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Json;
    expect(body.company.id).toBe(h.seed.a);
    expect(body.prices.view).toBe('owner');
    expect(body.prices.current.sequence).toBe(1);
    expect(body.prices.workingCopy.revision).toBe(3);
    expect(body.versions.map((v: Json) => v.sequence)).toEqual([1]);
    expect((await auditRows()).at(-1)).toEqual({ actor_id: null, operator_actor_id: h.seed.operator, action: 'support_prices_viewed', target: h.seed.a, details: {} });
  });

  it('writes nothing but that row, shows a company with no prices the starter list, and refuses everyone but an operator', async () => {
    const before = await counts();
    const body = (await (await as(h.seed.b)).json()) as Json;
    expect(body.prices.current).toBeNull();
    expect(body.prices.workingCopy.revision).toBe(0);
    expect(await counts()).toEqual({ versions: before.versions, copies: before.copies, audits: before.audits + 1 });
    const unknown = await as('00000000-0000-4000-8000-000000000000');
    expect(unknown.status).toBe(404);
    expect((await as(h.seed.a, owner())).status).toBe(403);
    expect((await as(h.seed.a, estimator)).status).toBe(403);
    expect((await as(h.seed.a, null)).status).toBe(401);
    expect(await counts()).toEqual({ versions: before.versions, copies: before.copies, audits: before.audits + 1 });
  });

  it('cannot change a company’s prices in the database either', async () => {
    await save(0, starterTable());
    const sql = (await import('postgres')).default(h.apiUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
    try {
      // The policy refuses an active operator, so the statement changes no row (or is refused outright).
      const changed = await sql
        .begin(async (tx) => {
          await tx`SELECT set_config('app.operator_id', ${h.seed.operator}, true)`;
          await tx`SELECT set_config('app.company_id', ${h.seed.a}, true)`;
          return (await tx`UPDATE price_table_working_copies SET revision = 2, content = '{}'::jsonb WHERE company_id = ${h.seed.a}`).count;
        })
        .catch(() => 0);
      expect(changed).toBe(0);
    } finally {
      await sql.end({ timeout: 5 });
    }
    const [row] = await h.admin<{ revision: number; content: Json }[]>`SELECT revision, content FROM price_table_working_copies`;
    expect(row!.revision).toBe(1);
    expect(row!.content).not.toEqual({});
  });
});
