import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Harness } from './team-harness';

// S4-7, POST /api/prices/import through the real route files as the runtime role against Postgres
// (see team-members.test.ts for the setup): a price list applied to the working copy and nothing
// else, the round trip with the export, who may import, and what a refused file leaves behind.
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
const { POST: publish } = await import('@/app/api/prices/publish/route');
const { GET: exportList } = await import('@/app/api/prices/export/route');
const { POST: importList } = await import('@/app/api/prices/import/route');
const { contentHash, parseTable } = await import('@/engine/table');
const { starterTable } = await import('@/lib/prices/starter');
const { everything, owner, params, request, resetTeamDatabase, startTeamServer } = await import('./team-harness');
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const call = async (handler: (r: Request, c: never) => Response | Promise<Response>, claims: FakeClaims | null, init: { method?: string; body?: unknown } = {}) => {
  const response = await handler(request(claims, '/api/prices', init), params({}) as never);
  return { status: response.status, body: (await response.clone().json().catch(() => null)) as Json | null };
};
const save = (expectedRevision: number, table: unknown, claims: FakeClaims = owner()) =>
  call(saveWorkingCopy, claims, { method: 'PUT', body: { expectedRevision, table } });
const importAs = (expectedRevision: number, csv: unknown, claims: FakeClaims | null = owner()) =>
  call(importList, claims, { method: 'POST', body: { expectedRevision, csv } });
const working = async () => (await call(readPrices, owner())).body!.workingCopy as Json;
const exported = async () => (await exportList(request(owner(), '/api/prices/export'), params({}) as never)).text();

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

// A file with the price on one item's default line changed.
const withPrice = (file: string, itemId: string, price: string) =>
  file
    .split('\r\n')
    .map((line) => (line.startsWith(`${itemId},`) && line.includes(',default,') ? `${line.slice(0, line.lastIndexOf(','))},${price}` : line))
    .join('\r\n');

const counts = async () =>
  (
    await h.admin<{ versions: number; copies: number; audits: number }[]>`
      SELECT (SELECT count(*) FROM price_table_versions)::int AS versions,
             (SELECT count(*) FROM price_table_working_copies)::int AS copies,
             (SELECT count(*) FROM audit_events WHERE action LIKE 'price_%')::int AS audits
    `
  )[0]!;

describe('importing a price list', () => {
  it('applies the changed prices to the working copy, raises its revision by one and audits the import', async () => {
    await save(0, starterTable());
    await save(1, pricedStarter());
    const before = await working();
    const file = withPrice(withPrice(await exported(), 'service_call', '99.50'), 'water_extraction', '3');
    const { status, body } = await importAs(2, file);
    expect(status).toBe(200);
    expect(body).toMatchObject({ changed: 2, workingCopy: { revision: 3, baseSequence: null } });
    const after = await working();
    expect(after.revision).toBe(3);
    const price = (copy: Json, id: string) => copy.table.items.find((item: Json) => item.item_id === id).unit_price;
    expect([price(after, 'service_call'), price(after, 'water_extraction')]).toEqual(['99.50', '3.00']);
    // Nothing but those two prices moved: the other items, the trades and the policy are as they were.
    const moved = after.table.items.filter((item: Json, index: number) => JSON.stringify(item) !== JSON.stringify(before.table.items[index]));
    expect(moved.map((item: Json) => item.item_id).sort()).toEqual(['service_call', 'water_extraction']);
    expect(after.table.policy).toEqual(before.table.policy);
    expect(after.table.trades).toEqual(before.table.trades);
    const [row] = await h.admin<{ actor_id: string; operator_actor_id: string | null; action: string; target: string; details: Json }[]>`
      SELECT actor_id, operator_actor_id, action, target, details FROM audit_events WHERE action = 'price_working_copy_imported'`;
    expect(row).toEqual({ actor_id: h.seed.ownerA.actor, operator_actor_id: null, action: 'price_working_copy_imported', target: h.seed.a, details: { revision: 3, prices: 2 } });
    // Counts only: no price, no file text.
    expect(JSON.stringify(row)).not.toContain('99.50');
  });

  it('gives the same content hash from an exported file, and writes nothing when no price changes', async () => {
    await save(0, starterTable());
    await save(1, pricedStarter());
    const hash = contentHash(parseTable((await working()).table));
    const before = await everything(h.admin);
    const { status, body } = await importAs(2, await exported());
    expect(status).toBe(200);
    expect(body).toMatchObject({ changed: 0, workingCopy: { revision: 2 } });
    expect(contentHash(parseTable(body!.workingCopy.table))).toBe(hash);
    // No new revision and no audit row for a file that changes nothing.
    expect(await everything(h.admin)).toBe(before);
  });

  it('round-trips an edited file: what the export says after an import is what the file said', async () => {
    await save(0, starterTable());
    await save(1, pricedStarter());
    const file = withPrice(await exported(), 'service_call', '12.34');
    expect((await importAs(2, file)).status).toBe(200);
    expect(await exported()).toBe(file);
  });

  it('fills the starter list from revision 0, creating the working copy at revision 1', async () => {
    const blank = await exported();
    expect((await call(readPrices, owner())).body!.workingCopy.revision).toBe(0);
    expect((await call(exportList, owner())).status).toBe(200);
    const { status, body } = await importAs(0, withPrice(blank, 'service_call', '75'));
    expect(status).toBe(200);
    expect(body).toMatchObject({ changed: 1, workingCopy: { revision: 1 } });
    expect((await working()).table.items.find((item: Json) => item.item_id === 'service_call').unit_price).toBe('75.00');
    expect(await counts()).toEqual({ versions: 0, copies: 1, audits: 1 });
  });

  it('never publishes, and leaves published versions as they were', async () => {
    await save(0, starterTable());
    await save(1, pricedStarter());
    expect((await call(publish, owner(), { method: 'POST', body: { expectedRevision: 2, reason: 'First prices', publishKey: 'publish-key-0001', rangeChoice: 'single' } })).status).toBe(201);
    const [version] = await h.admin<{ content: Json; content_hash: string }[]>`SELECT content, content_hash FROM price_table_versions`;
    expect((await importAs(3, withPrice(await exported(), 'service_call', '5'))).status).toBe(200);
    expect(await counts()).toMatchObject({ versions: 1 });
    expect(await h.admin`SELECT content, content_hash FROM price_table_versions`).toEqual([version]);
    // The current prices are still the published ones.
    const view = (await call(readPrices, owner())).body!;
    expect(view.current.contentHash).toBe(version!.content_hash);
    expect(view.workingCopy.table.items.find((item: Json) => item.item_id === 'service_call').unit_price).toBe('5.00');
  });

  it('lets the next publish say it came from an import, until the copy is edited again', async () => {
    await save(0, starterTable());
    await save(1, pricedStarter());
    await call(publish, owner(), { method: 'POST', body: { expectedRevision: 2, reason: 'First prices', publishKey: 'publish-key-0001', rangeChoice: 'single' } });
    expect((await importAs(3, withPrice(await exported(), 'service_call', '5'))).body!.workingCopy.revision).toBe(4);
    const imported = await call(publish, owner(), { method: 'POST', body: { expectedRevision: 4, reason: 'From the spreadsheet', publishKey: 'publish-key-0002' } });
    expect(imported.body!.version).toMatchObject({ sequence: 2, source: 'import' });
    // An import, then an edit in the editor, is not an import.
    expect((await importAs(5, withPrice(await exported(), 'service_call', '6'))).status).toBe(200);
    const edited = (await working()).table as Json;
    edited.items[1].unit_price = '7.77';
    expect((await save(6, edited)).status).toBe(200);
    const mixed = await call(publish, owner(), { method: 'POST', body: { expectedRevision: 7, reason: 'Then edited', publishKey: 'publish-key-0003' } });
    expect(mixed.body!.version).toMatchObject({ sequence: 3, source: 'blank' });
  });
});

describe('who may import', () => {
  it('refuses an estimator and an office user before the body is read, and writes nothing', async () => {
    await save(0, starterTable());
    const before = await everything(h.admin);
    for (const claims of [estimator, office]) {
      const answers = [
        await importAs(1, await exported(), claims),
        // The refusal comes before the body is looked at.
        await call(importList, claims, { method: 'POST', body: 'not json' }),
      ];
      expect(answers.map((a) => [a.status, a.body])).toEqual(answers.map(() => [403, { error: 'not_allowed' }]));
    }
    expect(await everything(h.admin)).toBe(before);
  });

  it('refuses a call with no sign-in, and answers 404 for a company without price books', async () => {
    expect((await importAs(0, 'x', null)).status).toBe(401);
    const before = await everything(h.admin);
    const refused = await call(importList, owner('owner-b', 'tenant-b'), { method: 'POST', body: { expectedRevision: 0, csv: 'x' } });
    expect([refused.status, refused.body]).toEqual([404, { error: 'not_found' }]);
    expect(await everything(h.admin)).toBe(before);
  });
});

describe('what an import refuses', () => {
  it('refuses a stale revision with the current one, and a file read against revision 0 once a copy is saved', async () => {
    await save(0, starterTable());
    await save(1, pricedStarter());
    const file = withPrice(await exported(), 'service_call', '5');
    const before = await everything(h.admin);
    for (const stale of [0, 1, 3]) {
      const refused = await importAs(stale, file);
      expect([refused.status, refused.body]).toEqual([409, { error: 'stale_revision', revision: 2 }]);
    }
    expect(await everything(h.admin)).toBe(before);
  });

  it('refuses a formula cell, naming the line and column but not the cell, and writes nothing', async () => {
    await save(0, starterTable());
    await save(1, pricedStarter());
    const before = await everything(h.admin);
    for (const cell of ['=HYPERLINK("http://x")', '+1', '-1', '@SUM(A1)']) {
      const file = withPrice(await exported(), 'service_call', cell.includes(',') || cell.includes('"') ? `"${cell.replaceAll('"', '""')}"` : cell);
      const refused = await importAs(2, file);
      expect(refused.status, cell).toBe(422);
      expect(refused.body).toMatchObject({ error: 'invalid_import' });
      expect(refused.body!.detail).toMatch(/^Line \d+, column price:/);
      expect(JSON.stringify(refused.body)).not.toContain('HYPERLINK');
    }
    // In another column too.
    const name = (await exported()).replace('Emergency service call', '=Emergency service call');
    const refusedName = await importAs(2, name);
    expect([refusedName.status, refusedName.body!.error, refusedName.body!.detail]).toEqual([422, 'invalid_import', expect.stringContaining('column name')]);
    expect(await everything(h.admin)).toBe(before);
  });

  it('refuses a price the table refuses, a line it has no price for, and a changed name, naming the item or line', async () => {
    await save(0, starterTable());
    await save(1, pricedStarter());
    const before = await everything(h.admin);
    const text = await exported();
    const refusals = [
      await importAs(2, withPrice(text, 'service_call', '12.345')),
      await importAs(2, withPrice(text, 'service_call', 'free')),
      await importAs(2, `${text}no_such_item,X,Nothing,treatment,,sf,true,default,,,,1.00\r\n`),
      await importAs(2, text.replace('Emergency service call', 'Call-out')),
      await importAs(2, text.replace('item_id,', 'id,')),
    ];
    expect(refusals.map((r) => [r.status, r.body!.error])).toEqual(refusals.map(() => [422, 'invalid_import']));
    expect(refusals[0]!.body!.detail).toContain('service_call');
    expect(refusals[2]!.body!.detail).toMatch(/^Line \d+:/);
    expect(refusals[3]!.body!.detail).toContain('name differs');
    expect(await everything(h.admin)).toBe(before);
  });

  it('refuses a malformed request, and writes nothing', async () => {
    await save(0, starterTable());
    const before = await everything(h.admin);
    for (const body of ['not json', [], {}, { csv: 'x' }, { expectedRevision: 1 }, { expectedRevision: -1, csv: 'x' }, { expectedRevision: 1, csv: 5 }, { expectedRevision: 1, csv: 'x', extra: 1 }]) {
      expect({ body, status: (await call(importList, owner(), { method: 'POST', body })).status }).toEqual({ body, status: 400 });
    }
    // Over the body limit.
    expect((await importAs(1, 'x'.repeat(2_100_000))).status).toBe(400);
    expect(await everything(h.admin)).toBe(before);
  });
});
