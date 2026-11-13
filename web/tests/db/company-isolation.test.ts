import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeClaims, Harness } from './team-harness';
import { contentHash, parseTable } from '@/engine/table';
import { callKey, handlersOf, MATRIX, matrixKey, matrixProblems, pathFor, routeModules, uncalled, type MatrixRow, type RouteModule } from './isolation-matrix';

// S3-17, the company-isolation gate: the standard's required test as one named suite
// (`npm run test:isolation`, the `company-isolation` job in .github/workflows/web.yml).
//
// It seeds two companies in two sign-in tenants, then as each company's owner, estimator and office
// user calls every registered route with the other company's ids, and checks SQL directly as the
// runtime role. The Firestore rules half is tests/emu/rules/company-isolation.test.ts, which needs
// the emulator and runs in the same job. Every refusal is held to 401, 403 or 404, no body may hold
// a trace of the other company, and a refused call changes nothing. The route list is the file
// system's: a route that is not in isolation-matrix.ts fails here (docs/ACCESS.md, "Company isolation gate").
const live = vi.hoisted(() => ({
  harness: null as Harness | null,
  projectionRuns: 0,
  schedulerToken: 'e30.e30.scheduler',
}));
vi.mock('@/lib/auth/services', () => ({
  identityServices: () => live.harness!.identity,
  operatorServices: () => live.harness!.operators,
  serverDatabase: () => live.harness!.handle.db,
}));
vi.mock('@/lib/team/services', () => ({ teamServices: () => live.harness!.team }));
vi.mock('@/lib/prices/services', () => ({ pricesServices: () => live.harness!.prices }));
vi.mock('@/lib/jobs/services', () => ({ jobsServices: () => live.harness!.jobs }));
vi.mock('@/lib/platform/services', () => ({ platformServices: () => live.harness!.platform }));
vi.mock('@/lib/sign-in/services', async () => {
  const { databaseSignInDirectory } = await import('@/lib/sign-in/database-directory');
  return { signInDirectory: () => databaseSignInDirectory(live.harness!.handle.db) };
});
// The scheduler's route: only the one service token below passes the verifier; a person's token never does.
vi.mock('@/lib/auth/service-caller', () => ({
  serviceCallerServices: () => ({
    caller: { email: 'scheduler@example.test', audienceFor: (job: string) => `isolation-${job}` },
    verifier: {
      async verify(token: string) {
        if (token !== live.schedulerToken) throw new Error('not a service token');
        return { email: 'scheduler@example.test', emailVerified: true };
      },
    },
  }),
}));
vi.mock('@/lib/projection/services', () => ({
  renewSignedInAccess: async () => {},
  runQueuedProjection: async () => {
    live.projectionRuns += 1;
    return { processed: 0 };
  },
}));

const { everything, operatorClaims, params, request, resetTeamDatabase, startTeamServer } = await import('./team-harness');

type Handler = (request: Request, context: ReturnType<typeof params>) => Response | Promise<Response>;

const REFUSED = [401, 403, 404];
// What a route that names no company may answer a call by the other company's user: the caller's own
// data (200), a refusal of its role (403) or a write refused for its stale revision (409).
const SELF_ANSWERS = [200, 403, 409];

let base: Awaited<ReturnType<typeof startTeamServer>>;
let h: Harness;
let a: Side;
let b: Side;

// One company as the suite sees it: its ids, its three people, and the strings that would show it
// in a response or a row.
type Side = {
  name: 'A' | 'B';
  companyId: string;
  ids: { membershipId: string; invitationId: string; address: string; versionId: string; jobId: string; draftId: string };
  people: { owner: FakeClaims; estimator: FakeClaims; office: FakeClaims };
  markers: string[];
};

async function seedSides(): Promise<void> {
  const officeB = await h.admin<{ id: string }[]>`
    INSERT INTO actors (company_id, auth_tenant_id, uid, email) VALUES (${h.seed.b}, 'tenant-b', 'office-b', 'office-b@example.test') RETURNING id
  `;
  await h.admin`INSERT INTO memberships (company_id, actor_id, role) VALUES (${h.seed.b}, ${officeB[0]!.id}, 'office')`;
  const invite = async (company: string, by: string, email: string) =>
    (
      await h.admin<{ id: string }[]>`
        INSERT INTO invitations (company_id, email, role, expires_at, created_by_actor_id)
        VALUES (${company}, ${email}, 'estimator', now() + interval '7 days', ${by}) RETURNING id
      `
    )[0]!.id;
  const invitationA = await invite(h.seed.a, h.seed.ownerA.actor, 'shared-invitee@example.test');
  const invitationB = await invite(h.seed.b, h.seed.ownerB.actor, 'invitee-b@example.test');
  for (const [company, by] of [
    [h.seed.a, h.seed.ownerA.actor],
    [h.seed.b, h.seed.ownerB.actor],
  ] as const) {
    await h.admin`INSERT INTO audit_events (company_id, actor_id, action, target) VALUES (${company}, ${by}, 'seeded_event', ${company})`;
    await h.admin`INSERT INTO company_feature_flags (company_id, flag, enabled) VALUES (${company}, 'price_books', true)`;
    await h.admin`INSERT INTO access_projection_outbox (company_id, actor_id) VALUES (${company}, ${by})`;
  }
  // Each company has a working copy and a published version, named so a leak of either shows.
  const prices = async (company: string, by: string, suffix: string) => {
    const table = parseTable({
      items: [{ item_id: 'sample_item', group: 'treatment', name: `zz-price-marker-${suffix}`, unit: 'sf', quantity_source: 'room:wet_floor', unit_price: '2.00' }],
      policy: {
        estimate_mode: 'single',
        range: { first_sf: 1000, first_percent: '0', beyond_percent: '0' },
        after_hours: { multiplier: '1' },
        category_multipliers: { '1': '1', '2': '1', '3': '1' },
        cabinetry: { multiplier: '1', scope: 'finished_only' },
        sales_tax: { enabled: false, percent: '0' },
      },
    });
    const [version] = await h.admin<{ id: string }[]>`
      INSERT INTO price_table_versions (company_id, sequence, content, content_hash, engine_version, reason, source, published_by_actor_id, publish_key)
      VALUES (${company}, 1, ${h.admin.json(table as never)}, ${contentHash(table)}, 'dryscope-v3', ${`zz-reason-${suffix}`}, 'blank', ${by}, ${`zz-key-${suffix}-0001`}) RETURNING id
    `;
    await h.admin`INSERT INTO price_table_working_copies (company_id, base_sequence, content) VALUES (${company}, 1, ${h.admin.json(table as never)})`;
    return version!.id;
  };
  const versionA = await prices(h.seed.a, h.seed.ownerA.actor, 'a');
  const versionB = await prices(h.seed.b, h.seed.ownerB.actor, 'b');
  // One job with a customer and a claim in each company, so a clean answer to the other company is
  // not an empty one. Its strings are markers, like the ids.
  const job = async (company: string, by: string, suffix: string) => {
    const ids = { jobId: randomUUID(), draftId: randomUUID() };
    await h.admin`
      INSERT INTO jobs (id, company_id, created_by_actor_id, field_owner_actor_id, current_draft_id, property_address, request_digest)
      VALUES (${ids.jobId}, ${company}, ${by}, ${by}, ${ids.draftId}, ${`Property Line ${suffix}`}, ${'0'.repeat(64)})
    `;
    await h.admin`INSERT INTO job_customers (company_id, job_id, name, phone, email) VALUES (${company}, ${ids.jobId}, ${`Customer ${suffix}`}, ${`555-01${suffix === 'a' ? '11' : '22'}`}, ${`customer-${suffix}@example.test`})`;
    await h.admin`INSERT INTO job_claims (company_id, job_id, carrier, claim_number) VALUES (${company}, ${ids.jobId}, ${`Carrier ${suffix}`}, ${`Claim ${suffix}`})`;
    return ids;
  };
  const jobA = await job(h.seed.a, h.seed.ownerA.actor, 'a');
  const jobB = await job(h.seed.b, h.seed.ownerB.actor, 'b');
  const side = (
    name: 'A' | 'B',
    companyId: string,
    suffix: string,
    membershipId: string,
    invitationId: string,
    versionId: string,
    ids: string[],
    extra: string[],
    job: { jobId: string; draftId: string },
  ): Side => {
    const tenant = `tenant-${suffix}`;
    const person = (uid: string): FakeClaims => ({ tenant, uid });
    return {
      name,
      companyId,
      ids: { membershipId, invitationId, address: `company-${suffix}`, versionId, ...job },
      people: { owner: person(`owner-${suffix}`), estimator: person(`estimator-${suffix}`), office: person(`office-${suffix}`) },
      markers: [companyId, membershipId, invitationId, versionId, `zz-price-marker-${suffix}`, `zz-reason-${suffix}`, tenant, `company-${suffix}`, `-${suffix}@example.test`, ...ids, ...extra, job.jobId, job.draftId, `Property Line ${suffix}`, `Customer ${suffix}`, `Carrier ${suffix}`, `Claim ${suffix}`].map((value) =>
        value.toLowerCase(),
      ),
    };
  };
  a = side('A', h.seed.a, 'a', h.seed.estimatorA.membership, invitationA, versionA, [h.seed.ownerA.actor, h.seed.estimatorA.actor, h.seed.officeA.actor, h.seed.ownerA.membership], ['shared-invitee@example.test'], jobA);
  b = side('B', h.seed.b, 'b', h.seed.estimatorB.membership, invitationB, versionB, [h.seed.ownerB.actor, h.seed.estimatorB.actor, officeB[0]!.id, h.seed.ownerB.membership], ['invitee-b@example.test'], jobB);
}

beforeAll(async () => {
  base = await startTeamServer();
  vi.stubEnv('APP_ENV', 'test');
});

beforeEach(async () => {
  h = await resetTeamDatabase(base, live.harness);
  live.harness = h;
  live.projectionRuns = 0;
  made = new Set();
  await seedSides();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await live.harness?.handle.close();
  await base?.admin.end({ timeout: 5 });
  await base?.server.stop();
});

let loaded: Promise<Map<string, RouteModule>> | undefined;
const modules = () => (loaded ??= routeModules());
async function handlerFor(route: string, method: string): Promise<Handler> {
  const found = (await modules()).get(route)?.[method];
  if (typeof found !== 'function') throw new Error(`${method} ${route} is not exported`);
  return found as Handler;
}

// Every call `call` has made in this test, so the suite can say which handlers it really reached.
let made = new Set<string>();

type Answer = { status: number; text: string };
async function call(
  row: Pick<MatrixRow, 'route' | 'method' | 'body'>,
  claims: FakeClaims | null,
  ids: Record<string, string>,
  extra: { query?: string; headers?: Record<string, string> } = {},
): Promise<Answer> {
  const handler = await handlerFor(row.route, row.method);
  const path = pathFor(row.route, ids);
  made.add(callKey(claims?.uid ?? 'no sign-in', row.method, path));
  const built = request(claims, `${path}${extra.query ?? ''}`, { method: row.method, body: row.body });
  for (const [name, value] of Object.entries(extra.headers ?? {})) built.headers.set(name, value);
  const response = await handler(built, params(ids));
  return { status: response.status, text: await response.text() };
}

// Whether any trace of the other company is in `text`: an id, an email, its address or its tenant.
const leaks = (text: string, victim: Side) => victim.markers.filter((marker) => text.toLowerCase().includes(marker));

// The ids of `victim`'s records in the path, with whose company the path names.
const idsOf = (victim: Side, company: Side = victim): Record<string, string> => ({
  companyId: company.companyId,
  membershipId: victim.ids.membershipId,
  invitationId: victim.ids.invitationId,
  versionId: victim.ids.versionId,
  address: victim.ids.address,
  jobId: victim.ids.jobId,
});

const rowsOfKind = (...kinds: MatrixRow['kind'][]) => MATRIX.filter((row) => kinds.includes(row.kind));
// The two directions are built after the seed, so the matrix functions read them lazily.
const directions = (): [Side, Side][] => [
  [b, a],
  [a, b],
];

// The calls a signed-in user of the other company is answered rather than refused, and all each
// answer may hold. Every other row of the matrix must be refused.
type OpenCheck = (answer: Answer, where: string, attacker: Side, victim: Side) => void;
const OPEN: Record<string, OpenCheck> = {
  // The caller's own sign-in, whatever company the path names.
  'GET api/me': (answer, where, attacker, victim) => {
    expect(answer.status, where).toBe(200);
    expect(JSON.parse(answer.text).company.id, where).toBe(attacker.companyId);
    expect(leaks(answer.text, victim), where).toEqual([]);
  },
  // The one open route that names a company: its sign-in page. It is public on purpose and answers
  // exactly two fields, the company's name and its tenant, for an active company with a tenant.
  'GET api/sign-in/[address]': (answer, where, _attacker, victim) => {
    expect(answer.status, where).toBe(200);
    expect(JSON.parse(answer.text), where).toEqual({ company: { name: `Company ${victim.ids.address}` }, tenantId: victim.people.owner.tenant });
  },
  'GET api/health': (answer, where, _attacker, victim) => {
    expect(answer.status, where).toBe(200);
    expect(leaks(answer.text, victim), where).toEqual([]);
  },
  'POST api/echo': (answer, where, _attacker, victim) => {
    expect(answer.status, where).toBe(200);
    expect(JSON.parse(answer.text), where).toEqual({ message: 'hello' });
    expect(leaks(answer.text, victim), where).toEqual([]);
  },
};

describe('the route list', () => {
  it('has a row in the matrix for every handler of every route file, and no other', async () => {
    expect(matrixProblems(handlersOf(await modules()))).toEqual([]);
  });

  it('lists no open answer for a route the matrix does not have', () => {
    expect(Object.keys(OPEN).filter((name) => !MATRIX.some((row) => matrixKey(row) === name))).toEqual([]);
  });

  it('names a handler the matrix lacks, a row no handler has, and a row listed twice', () => {
    const handler = () => new Response();
    const found = handlersOf(new Map([['api/x/[id]', { POST: handler, GET: handler, HEAD: handler, dynamic: 'force-dynamic', helper: handler }]]));
    expect(found).toEqual([
      { route: 'api/x/[id]', method: 'GET' },
      { route: 'api/x/[id]', method: 'HEAD' },
      { route: 'api/x/[id]', method: 'POST' },
    ]);
    const missing = (method: string) => `${method} api/x/[id] is not in the isolation matrix (web/tests/db/isolation-matrix.ts)`;
    expect(matrixProblems(found)).toEqual([
      missing('GET'),
      missing('HEAD'),
      missing('POST'),
      ...MATRIX.map((row) => `${row.method} ${row.route} is in the matrix but no route file has it`),
    ]);
    const rows: MatrixRow[] = [
      { route: 'api/x/[id]', method: 'GET', kind: 'public' },
      { route: 'api/x/[id]', method: 'POST', kind: 'company' },
    ];
    expect(matrixProblems(found, rows)).toEqual([missing('HEAD')]);
    expect(matrixProblems(found.filter((entry) => entry.method !== 'HEAD'), [...rows, rows[0]!])).toEqual(['GET api/x/[id] is in the matrix twice']);
    expect(matrixProblems([], rows)).toEqual([
      'GET api/x/[id] is in the matrix but no route file has it',
      'POST api/x/[id] is in the matrix but no route file has it',
    ]);
  });
});

describe('the calls the suite makes', () => {
  it('fills every path parameter from the ids it is given and refuses one it has no id for', () => {
    const ids = { companyId: 'c1', membershipId: 'm1' };
    expect(pathFor('api/companies/[companyId]/members/[membershipId]', ids)).toBe('/api/companies/c1/members/m1');
    expect(pathFor('api/health', {})).toBe('/api/health');
    expect(() => pathFor('api/jobs/[jobId]', ids)).toThrow('api/jobs/[jobId] has the path parameter [jobId]');
  });

  it('names a call that was expected and not made', () => {
    const reached = new Set([callKey('owner-a', 'GET', '/api/x/1'), callKey('owner-a', 'POST', '/api/x/1')]);
    expect(uncalled([callKey('owner-a', 'GET', '/api/x/1'), callKey('owner-a', 'POST', '/api/x/1')], reached)).toEqual([]);
    expect(uncalled([callKey('owner-a', 'GET', '/api/x/1'), callKey('estimator-a', 'GET', '/api/x/1'), callKey('owner-a', 'GET', '/api/x/2')], reached)).toEqual([
      'estimator-a GET /api/x/1',
      'owner-a GET /api/x/2',
    ]);
  });

  it('lists exactly four open answers: the caller’s own sign-in, the sign-in page, health and echo', () => {
    expect(Object.keys(OPEN).sort()).toEqual(['GET api/health', 'GET api/me', 'GET api/sign-in/[address]', 'POST api/echo']);
  });
});

describe('the leak check itself', () => {
  it('finds each company’s own data when its own owner reads it, so a clean answer to the other is not a blind spot', async () => {
    for (const side of [a, b]) {
      const team = MATRIX.find((row) => row.route.endsWith('/team') && row.kind === 'company')!;
      const own = await call(team, side.people.owner, idsOf(side));
      expect(own.status).toBe(200);
      expect(leaks(own.text, side).length).toBeGreaterThan(0);
      // The Prices read shows the company's own working copy and version too.
      const prices = await call({ route: 'api/prices', method: 'GET' }, side.people.owner, idsOf(side));
      expect(prices.status).toBe(200);
      expect(leaks(prices.text, side)).toEqual(expect.arrayContaining([`zz-price-marker-${side.name.toLowerCase()}`, side.ids.versionId.toLowerCase()]));
      const me = await call({ route: 'api/me', method: 'GET' }, side.people.owner, {});
      expect(me.status).toBe(200);
      expect(leaks(me.text, side)).toContain(side.companyId.toLowerCase());
    }
  });
});

describe('every route, called with the other company’s ids', () => {
  it('refuses a call with no sign-in on every route that needs one', async () => {
    const before = await everything(h.admin);
    for (const row of rowsOfKind('company', 'invitation', 'operator', 'session', 'service')) {
      const answer = await call(row, null, idsOf(a));
      expect({ route: `${row.method} ${row.route}`, status: answer.status }).toEqual({ route: `${row.method} ${row.route}`, status: 401 });
    }
    expect(await everything(h.admin)).toBe(before);
    expect(live.projectionRuns).toBe(0);
  });

  it('answers 401, 403 or 404 to the other company’s owner, estimator and office user, with nothing of the company and no change', async () => {
    const before = await everything(h.admin);
    const checked: string[] = [];
    const expected: string[] = [];
    // The handlers are the route modules' own exports, not the matrix's rows: a handler with no row
    // fails here by name, and a row cannot stand in for a handler the loop never reached.
    const handlers = handlersOf(await modules()).map((handler) => {
      const row = MATRIX.find((found) => matrixKey(found) === matrixKey(handler));
      if (!row) throw new Error(`${matrixKey(handler)} is not in the isolation matrix (web/tests/db/isolation-matrix.ts)`);
      return row;
    });
    // A create row makes the caller's own record instead of refusing; its own test is below.
    const refused = handlers.filter((row) => row.own !== 'create');
    for (const [attacker, victim] of directions()) {
      for (const [role, claims] of Object.entries(attacker.people)) {
        for (const row of refused) {
          expected.push(callKey(claims.uid, row.method, pathFor(row.route, idsOf(victim))));
          const answer = await call(row, claims, idsOf(victim));
          const where = `${attacker.name} ${role}: ${row.method} ${row.route}`;
          const open = OPEN[matrixKey(row)];
          if (open) {
            open(answer, where, attacker, victim);
          } else if (row.self) {
            // Answered about the caller's own company: never 401 or a server error, and none of the other's.
            expect({ where, status: SELF_ANSWERS.includes(answer.status) ? 'answered' : answer.status }).toEqual({ where, status: 'answered' });
            expect({ where, leaked: leaks(answer.text, victim) }).toEqual({ where, leaked: [] });
          } else {
            expect({ where, status: REFUSED.includes(answer.status) ? 'refused' : answer.status }).toEqual({ where, status: 'refused' });
            expect({ where, leaked: leaks(answer.text, victim) }).toEqual({ where, leaked: [] });
          }
          checked.push(where);
        }
      }
    }
    // 2 directions x 3 people x every handler the route files export but the create handlers, each
    // one called with the other company's ids: the calls are counted where they are made, not where
    // the loop meant to make them.
    expect(checked).toHaveLength(2 * 3 * refused.length);
    expect(uncalled(expected, made)).toEqual([]);
    expect(await everything(h.admin)).toBe(before);
    expect(h.calls).toEqual([]);
    expect(h.projected).toEqual([]);
  });

  it('refuses the other company’s email on an invitation addressed to it, because the invitation is in another company', async () => {
    // The invitee's address registered in the other company's sign-in tenant is a different person.
    const before = await everything(h.admin);
    for (const [attacker, victim] of directions()) {
      for (const row of rowsOfKind('invitation')) {
        const claims: FakeClaims = { tenant: attacker.people.office.tenant, uid: 'impostor', email: victim === a ? 'shared-invitee@example.test' : 'invitee-b@example.test' };
        const answer = await call(row, claims, idsOf(victim));
        expect({ route: `${attacker.name}: ${row.method} ${row.route}`, status: REFUSED.includes(answer.status) }).toEqual({
          route: `${attacker.name}: ${row.method} ${row.route}`,
          status: true,
        });
        expect(leaks(answer.text, victim)).toEqual([]);
      }
    }
    expect(await everything(h.admin)).toBe(before);
  });

  it('refuses the caller’s own company with the other company’s record ids, and lists only the caller’s own rows', async () => {
    const before = await everything(h.admin);
    for (const [attacker, victim] of directions()) {
      for (const [role, claims] of Object.entries(attacker.people)) {
        for (const row of MATRIX.filter((found) => found.own === 'cross')) {
          const answer = await call(row, claims, idsOf(victim, attacker));
          const where = `${attacker.name} ${role}: ${row.method} ${row.route} in its own company`;
          expect({ where, status: REFUSED.includes(answer.status) ? 'refused' : answer.status }).toEqual({ where, status: 'refused' });
          expect({ where, leaked: leaks(answer.text, victim) }).toEqual({ where, leaked: [] });
        }
        for (const row of MATRIX.filter((found) => found.own === 'list')) {
          const answer = await call(row, claims, idsOf(attacker));
          const where = `${attacker.name} ${role}: ${row.method} ${row.route}`;
          expect({ where, status: [200, 403].includes(answer.status) }).toEqual({ where, status: true });
          expect({ where, leaked: leaks(answer.text, victim) }).toEqual({ where, leaked: [] });
        }
      }
    }
    expect(await everything(h.admin)).toBe(before);
  });

  it('lets a create route make only the caller’s own record from the other company’s ids, and changes nothing of the other’s', async () => {
    const creates = MATRIX.filter((row) => row.own === 'create');
    expect(creates.length).toBeGreaterThan(0);
    const tables = ['jobs', 'job_customers', 'job_claims', 'evidence_objects', 'audit_events'];
    const rowsOf = async (company: string) => JSON.stringify(await Promise.all(tables.map((table) => h.admin.unsafe(`SELECT to_jsonb(t) AS row FROM "${table}" t WHERE company_id = '${company}' ORDER BY 1`))));
    for (const row of creates) {
      for (const [attacker, victim] of directions()) {
        const victimBefore = await rowsOf(victim.companyId);
        const draftsBefore = h.drafts.made.size;
        for (const [role, claims] of Object.entries(attacker.people)) {
          // The other company's own job and draft ids, in the body.
          const body = { id: victim.ids.jobId, draftId: victim.ids.draftId };
          const answer = await call({ ...row, body }, claims, idsOf(victim));
          const where = `${attacker.name} ${role}: ${row.method} ${row.route}`;
          // The caller's own record (the owner), or the same request again (office) or another
          // person's id in its own company (the estimator), but never the victim's.
          expect({ where, status: [200, 201, 409].includes(answer.status) }).toEqual({ where, status: true });
          // The answer repeats the two ids the caller itself sent; nothing else of the other company.
          const sent = [victim.ids.jobId, victim.ids.draftId].map((id) => id.toLowerCase());
          expect({ where, leaked: leaks(answer.text, victim).filter((marker) => !sent.includes(marker)) }).toEqual({ where, leaked: [] });
        }
        expect(await rowsOf(victim.companyId)).toBe(victimBefore);
        // The attacker's company holds a job of its own under that id, and only one.
        const own = await h.admin`SELECT company_id FROM jobs WHERE id = ${victim.ids.jobId}`;
        expect(own.map((found) => found.company_id).sort()).toEqual([attacker.companyId, victim.companyId].sort());
        // One draft was made, in the attacker's own company: never a write into the other's.
        const made = [...h.drafts.made.keys()].slice(draftsBefore);
        expect(made).toEqual([`${attacker.companyId}/${victim.ids.draftId}`]);
      }
    }
  });

  it('answers /api/me about the caller’s own sign-in whatever company the request names', async () => {
    for (const [attacker, victim] of directions()) {
      for (const claims of Object.values(attacker.people)) {
        const answer = await call({ route: 'api/me', method: 'GET' }, claims, {}, {
          query: `?companyId=${victim.companyId}&company=${victim.companyId}`,
          headers: { 'x-company-id': victim.companyId, 'x-forwarded-company': victim.companyId },
        });
        expect(answer.status).toBe(200);
        expect(JSON.parse(answer.text).company.id).toBe(attacker.companyId);
        expect(leaks(answer.text, victim)).toEqual([]);
      }
    }
  });

  it('gives a company user no way into the scheduler’s route, and lets only the scheduler’s own token through', async () => {
    const row = { route: 'api/internal/access-projection', method: 'POST' } as const;
    for (const side of [a, b]) {
      for (const claims of [...Object.values(side.people), operatorClaims()]) {
        const token = `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.`;
        const built = request(null, '/api/internal/access-projection', { method: 'POST' });
        built.headers.set('Authorization', `Bearer ${token}`);
        const response = await (await handlerFor(row.route, row.method))(built, params({}));
        expect(REFUSED).toContain(response.status);
      }
    }
    expect(live.projectionRuns).toBe(0);
    const built = request(null, '/api/internal/access-projection', { method: 'POST' });
    built.headers.set('Authorization', `Bearer ${live.schedulerToken}`);
    expect((await (await handlerFor(row.route, row.method))(built, params({}))).status).toBe(200);
    expect(live.projectionRuns).toBe(1);
  });

  it('answers a sign-in page for an address that is not a company the same as for a suspended company', async () => {
    for (const address of ['no-such-company', 'company-s']) {
      const answer = await call({ route: 'api/sign-in/[address]', method: 'GET' }, null, { address });
      expect(answer.status).toBe(404);
    }
  });
});

describe('the platform operator', () => {
  it('writes an audit row naming the operator and the company for a view of the company’s team, and none for the other', async () => {
    const team = MATRIX.find((row) => row.route === 'api/platform/companies/[companyId]/team')!;
    const rows = () =>
      h.admin<{ company_id: string | null; actor_id: string | null; operator_actor_id: string | null; action: string; target: string }[]>`
        SELECT company_id, actor_id, operator_actor_id, action, target FROM audit_events WHERE action = 'support_team_viewed' ORDER BY id
      `;
    expect(await rows()).toEqual([]);
    for (const side of [a, b]) {
      const answer = await call(team, operatorClaims(), idsOf(side));
      expect(answer.status).toBe(200);
      expect(leaks(answer.text, side).length).toBeGreaterThan(0);
      // The view shows this company and no other.
      expect(leaks(answer.text, side === a ? b : a)).toEqual([]);
    }
    expect(await rows()).toEqual([
      { company_id: h.seed.a, actor_id: null, operator_actor_id: h.seed.operator, action: 'support_team_viewed', target: h.seed.a },
      { company_id: h.seed.b, actor_id: null, operator_actor_id: h.seed.operator, action: 'support_team_viewed', target: h.seed.b },
    ]);
  });

  it('writes an audit row naming the operator and the company for a view of the company’s prices, which show that company only', async () => {
    const prices = MATRIX.find((row) => row.route === 'api/platform/companies/[companyId]/prices')!;
    const rows = () =>
      h.admin<{ company_id: string | null; actor_id: string | null; operator_actor_id: string | null; action: string; target: string }[]>`
        SELECT company_id, actor_id, operator_actor_id, action, target FROM audit_events WHERE action = 'support_prices_viewed' ORDER BY id
      `;
    expect(await rows()).toEqual([]);
    for (const side of [a, b]) {
      const answer = await call(prices, operatorClaims(), idsOf(side));
      expect(answer.status).toBe(200);
      expect(leaks(answer.text, side)).toEqual(expect.arrayContaining([`zz-price-marker-${side.name.toLowerCase()}`, side.ids.versionId.toLowerCase()]));
      expect(leaks(answer.text, side === a ? b : a)).toEqual([]);
    }
    expect(await rows()).toEqual([
      { company_id: h.seed.a, actor_id: null, operator_actor_id: h.seed.operator, action: 'support_prices_viewed', target: h.seed.a },
      { company_id: h.seed.b, actor_id: null, operator_actor_id: h.seed.operator, action: 'support_prices_viewed', target: h.seed.b },
    ]);
  });

  it('keeps that audit row out of reach of the other company, whose own rows it can read', async () => {
    const team = MATRIX.find((row) => row.route === 'api/platform/companies/[companyId]/team')!;
    await call(team, operatorClaims(), idsOf(a));
    const asB = await withContext(h.seed.b, (tx) => tx<{ company_id: string; action: string }[]>`SELECT company_id, action FROM audit_events ORDER BY id`);
    expect(asB).toEqual([{ company_id: h.seed.b, action: 'seeded_event' }]);
    const asA = await withContext(h.seed.a, (tx) => tx<{ action: string }[]>`SELECT action FROM audit_events ORDER BY id`);
    expect(asA.map((found) => found.action)).toEqual(['seeded_event', 'support_team_viewed']);
  });
});

// --- SQL, directly, as the runtime role ----------------------------------------------------------

const runtime = () => postgres(h.apiUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });

// A transaction as the runtime role with the company the request's sign-in would have set.
async function withContext<T>(companyId: string | null, run: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  const sql = runtime();
  try {
    return (await sql.begin(async (tx) => {
      if (companyId !== null) await tx`SELECT set_config('app.company_id', ${companyId}, true)`;
      return run(tx);
    })) as T;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function publicTables(): Promise<string[]> {
  return (
    await h.admin<{ name: string }[]>`
      SELECT relname AS name FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p') ORDER BY relname
    `
  ).map((found) => found.name);
}

async function refusedOrNothing(companyId: string, statement: string): Promise<string> {
  try {
    const result = await withContext(companyId, (tx) => tx.unsafe(statement));
    return result.count === 0 ? 'no rows' : `changed ${result.count} rows`;
  } catch (error) {
    return `error ${(error as { code?: string }).code ?? 'unknown'}`;
  }
}

describe('SQL as the runtime role', () => {
  it('reads every table of the schema, found by searching it, and sees nothing of the other company', async () => {
    const tables = await publicTables();
    // A table added later is read here too: the list is the catalog's, not a copy of the schema.
    expect(tables).toEqual(
      expect.arrayContaining(['access_projection_outbox', 'actors', 'audit_events', 'auth_tenants', 'companies', 'company_feature_flags', 'invitations', 'memberships', 'migration_ledger', 'platform_admins', 'price_table_versions', 'price_table_working_copies']),
    );
    for (const [self, other] of [[b, a], [a, b]] as const) {
      // A table the runtime holds no grant on is refused outright, which is as closed as it gets.
      const seen = await withContext(self.companyId, async (tx) => {
        const found: Record<string, string> = {};
        for (const table of tables) {
          found[table] = await tx
            .savepoint(async (sp) => JSON.stringify(await sp.unsafe(`SELECT to_jsonb(t) AS row FROM "${table}" t ORDER BY 1`)))
            .catch((error: { code?: string }) => (error.code === '42501' ? '[]' : Promise.reject(error)));
        }
        return found;
      });
      for (const table of tables) {
        expect({ table, as: self.name, leaked: leaks(seen[table]!, other) }).toEqual({ table, as: self.name, leaked: [] });
      }
      // Each side's own rows do show, so a clean read is not an empty one.
      expect(leaks(seen.memberships!, self).length).toBeGreaterThan(0);
      expect(leaks(seen.audit_events!, self).length).toBeGreaterThan(0);
      expect(leaks(seen.invitations!, self).length).toBeGreaterThan(0);
      expect(leaks(seen.price_table_versions!, self).length).toBeGreaterThan(0);
      expect(leaks(seen.price_table_working_copies!, self).length).toBeGreaterThan(0);
      expect(JSON.parse(seen.companies!)).toHaveLength(1);
      expect(JSON.parse(seen.auth_tenants!)).toHaveLength(1);
      expect(JSON.parse(seen.platform_admins!)).toEqual([]);
      expect(JSON.parse(seen.migration_ledger!)).toEqual([]);
    }
  });

  it('sees nothing at all when no company is set, or the setting is not a company', async () => {
    const tables = await publicTables();
    for (const context of [null, '', 'not-a-uuid', '00000000-0000-4000-8000-000000000000']) {
      for (const table of tables) {
        let outcome: string;
        try {
          outcome = String((await withContext(context, (tx) => tx.unsafe(`SELECT count(*)::int AS n FROM "${table}"`)))[0]!.n);
        } catch (error) {
          outcome = `error ${(error as { code?: string }).code ?? 'unknown'}`;
        }
        // Zero rows, or the database refusing the setting; never another company's rows.
        expect({ context, table, outcome: outcome === '0' || outcome.startsWith('error') }).toEqual({ context, table, outcome: true });
      }
    }
  });

  it('refuses to create, change or remove the other company’s rows, and leaves them as they were', async () => {
    const before = await everything(h.admin);
    const victim = h.seed.a;
    const attempts: [string, string][] = [
      ['insert a member', `INSERT INTO memberships (company_id, actor_id, role) VALUES ('${victim}', '${h.seed.estimatorA.actor}', 'owner')`],
      ['insert an actor', `INSERT INTO actors (company_id, auth_tenant_id, uid, email) VALUES ('${victim}', 'tenant-a', 'planted', 'planted@example.test')`],
      ['insert an invitation', `INSERT INTO invitations (company_id, email, role, expires_at) VALUES ('${victim}', 'planted@example.test', 'owner', now() + interval '1 day')`],
      ['insert an audit event', `INSERT INTO audit_events (company_id, action) VALUES ('${victim}', 'planted')`],
      ['insert an outbox row', `INSERT INTO access_projection_outbox (company_id, actor_id) VALUES ('${victim}', '${h.seed.ownerA.actor}')`],
      ['insert a feature flag', `INSERT INTO company_feature_flags (company_id, flag, enabled) VALUES ('${victim}', 'planted', true)`],
      ['insert a job', `INSERT INTO jobs (id, company_id, created_by_actor_id, current_draft_id, request_digest) VALUES (gen_random_uuid(), '${victim}', '${h.seed.ownerA.actor}', gen_random_uuid(), '${'0'.repeat(64)}')`],
      ['insert a customer', `INSERT INTO job_customers (company_id, job_id, name) VALUES ('${victim}', '${h.seed.ownerA.actor}', 'planted')`],
      ['change a job', `UPDATE jobs SET property_address = 'taken', revision = revision + 1 WHERE company_id = '${victim}'`],
      ['change a customer', `UPDATE job_customers SET name = 'taken' WHERE company_id = '${victim}'`],
      ['change a claim', `UPDATE job_claims SET carrier = 'taken' WHERE company_id = '${victim}'`],
      ['delete jobs', `DELETE FROM jobs WHERE company_id = '${victim}'`],
      ['change a role', `UPDATE memberships SET role = 'owner' WHERE company_id = '${victim}'`],
      ['change a status', `UPDATE memberships SET status = 'disabled' WHERE company_id = '${victim}'`],
      ['change an email', `UPDATE actors SET email = 'taken@example.test' WHERE company_id = '${victim}'`],
      ['cancel an invitation', `UPDATE invitations SET status = 'cancelled' WHERE company_id = '${victim}'`],
      ['change the company', `UPDATE companies SET name = 'taken', status = 'suspended' WHERE id = '${victim}'`],
      ['turn a flag off', `UPDATE company_feature_flags SET enabled = false WHERE company_id = '${victim}'`],
      ['move the company to another company', `UPDATE memberships SET company_id = '${h.seed.b}' WHERE company_id = '${victim}'`],
      ['delete members', `DELETE FROM memberships WHERE company_id = '${victim}'`],
      ['delete the company', `DELETE FROM companies WHERE id = '${victim}'`],
      ['insert a price version', `INSERT INTO price_table_versions (company_id, sequence, content, content_hash, engine_version, reason, source, published_by_actor_id, publish_key) VALUES ('${victim}', 1, '{}', '${'0'.repeat(64)}', 'dryscope-v3', 'planted', 'blank', '${h.seed.ownerA.actor}', 'planted-key-0001')`],
      ['insert a working copy', `INSERT INTO price_table_working_copies (company_id, content) VALUES ('${victim}', '{}')`],
      ['change a working copy', `UPDATE price_table_working_copies SET revision = 2, content = '{}'::jsonb WHERE company_id = '${victim}'`],
      ['change a price version', `UPDATE price_table_versions SET reason = 'changed' WHERE company_id = '${victim}'`],
      ['delete a price version', `DELETE FROM price_table_versions WHERE company_id = '${victim}'`],
      ['delete a working copy', `DELETE FROM price_table_working_copies WHERE company_id = '${victim}'`],
      ['delete audit events', `DELETE FROM audit_events WHERE company_id = '${victim}'`],
      ['read through a join to the company', `SELECT 1 FROM memberships m JOIN companies c ON c.id = m.company_id WHERE c.id = '${victim}'`],
    ];
    for (const [what, statement] of attempts) {
      const outcome = await refusedOrNothing(h.seed.b, statement);
      // Either the policy or the grant refuses (42501), or the policy hides every row (no rows).
      expect({ what, outcome: outcome === 'no rows' || outcome === 'error 42501' ? 'stopped' : outcome }).toEqual({ what, outcome: 'stopped' });
    }
    expect(await everything(h.admin)).toBe(before);
  });
});
