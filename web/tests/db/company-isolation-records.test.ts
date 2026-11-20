import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GENERATED_API_ROUTES } from '@/lib/api-routes.generated';
import { linkFlow, type Body } from './link-flow';
import type { FakeClaims, Harness } from './team-harness';
import { callKey, handlersOf, MATRIX, matrixKey, pathFor, routeModules, uncalled, type MatrixRow, type RouteModule } from './isolation-matrix';
import { digestOf } from './job-harness';

// S5a-12, the S5a half of the company-isolation gate (`npm run test:isolation`, beside
// company-isolation.test.ts; docs/access/isolation-gate.md). That suite calls every route with ids
// of a company that holds a job, a customer, a claim and a photo; this one first gives both
// companies everything S5a makes, through the real routes: a job signed through a homeowner link
// (its submission, price pin, estimate, agreement, signature and the two document links made at
// signing) and a second job with a pending signing link. Then, with those real ids and tokens:
//
// - every S5a route (found from the generated route list, src/lib/api-routes.generated.ts) as the
//   other company's owner, estimator and office user is refused (401, 403 or 404) with nothing of
//   the company in the answer and no change anywhere; the link routes also with the other
//   company's own live tokens, which open only that company's own records;
// - each company's own lists and reads hold its own rows and none of the other's;
// - every table with a company column, found from the catalog, holds rows of both companies (so
//   no check is blind), and as the runtime role in one company's context shows none of the other's
//   and refuses to insert, change or delete them.
const live = vi.hoisted(() => ({ harness: null as Harness | null }));
vi.mock('@/lib/auth/services', () => ({
  identityServices: () => live.harness!.identity,
  operatorServices: () => live.harness!.operators,
  serverDatabase: () => live.harness!.handle.db,
}));
vi.mock('@/lib/team/services', () => ({ teamServices: () => live.harness!.team }));
vi.mock('@/lib/prices/services', () => ({ pricesServices: () => live.harness!.prices }));
vi.mock('@/lib/jobs/services', () => ({ jobsServices: () => live.harness!.jobs }));
vi.mock('@/lib/photos/services', () => ({ photosServices: () => live.harness!.photos }));
vi.mock('@/lib/submissions/services', () => ({
  submissionsServices: () => live.harness!.submissions,
  runQueuedSubmissionRepair: async () => ({ aborted: 0, marked: 0, failed: 0 }),
}));
vi.mock('@/lib/estimates/services', async () => {
  const { estimatesService } = await import('@/lib/estimates/service');
  return { estimatesServices: () => estimatesService(live.harness!.handle.db) };
});
vi.mock('@/lib/agreements/services', async () => {
  const { agreementsService } = await import('@/lib/agreements/service');
  return { agreementsServices: () => agreementsService(live.harness!.handle.db) };
});
vi.mock('@/lib/links/services', async () => {
  const { signingLinksService } = await import('@/lib/links/signing');
  const { documentLinksService } = await import('@/lib/links/documents');
  return {
    signingLinksServices: () => signingLinksService(live.harness!.handle.db, live.harness!.photos),
    documentLinksServices: () => documentLinksService(live.harness!.handle.db, live.harness!.photos),
  };
});

const jobsRoute = await import('@/app/api/jobs/route');
const photoRoute = await import('@/app/api/jobs/[jobId]/photos/[photoId]/route');
const submissionsRoute = await import('@/app/api/jobs/[jobId]/submissions/route');
const draftsRoute = await import('@/app/api/jobs/[jobId]/drafts/route');
const customerRoute = await import('@/app/api/jobs/[jobId]/customer/route');
const estimateRoute = await import('@/app/api/jobs/[jobId]/estimate/route');
const agreementsRoute = await import('@/app/api/jobs/[jobId]/agreements/route');
const signingLinkRoute = await import('@/app/api/jobs/[jobId]/signing-link/route');
const assignmentsRoute = await import('@/app/api/jobs/[jobId]/assignments/route');
const coordinationRoute = await import('@/app/api/jobs/[jobId]/coordination/route');
const signRoute = await import('@/app/api/sign/route');
const signatureRoute = await import('@/app/api/sign/signature/[signatureId]/route');
const signedSignatureRoute = await import('@/app/api/sign/signature/route');
const { contentHash, ENGINE_VERSION, parseTable } = await import('@/engine/table');
const { everything, params, request, resetTeamDatabase, startTeamServer } = await import('./team-harness');

const REFUSED = [401, 403, 404];

// The S5a routes (docs/plans/S5.md): the jobs and their records, the company profile and its
// document settings, and the homeowner's link pages. Read from the generated route list, so a
// route added under one of these folders is called below without an edit here.
const S5A_FOLDERS = ['/api/jobs', '/api/companies/[companyId]/profile', '/api/sign', '/api/documents'];
const isS5a = (route: string) => S5A_FOLDERS.some((folder) => route === folder || route.startsWith(`${folder}/`));
const S5A_ROUTES = GENERATED_API_ROUTES.filter(isS5a);

let base: Awaited<ReturnType<typeof startTeamServer>>;
let h: Harness;

async function publish(company: string, price: string) {
  const table = parseTable({
    items: [{ item_id: 'extraction', group: 'treatment', name: 'Extraction', unit: 'sf', quantity_source: 'room:wet_floor', unit_price: price }],
    policy: {
      estimate_mode: 'single',
      range: { first_sf: 1000, first_percent: '0', beyond_percent: '0' },
      after_hours: { multiplier: '1' },
      category_multipliers: { '1': '1', '2': '1', '3': '1' },
      cabinetry: { multiplier: '1', scope: 'finished_only' },
      sales_tax: { enabled: false, percent: '0' },
    },
  });
  const owner = company === h.seed.a ? h.seed.ownerA.actor : h.seed.ownerB.actor;
  await h.admin`
    INSERT INTO price_table_versions (company_id, sequence, content, content_hash, engine_version, reason, source, published_by_actor_id, publish_key)
    SELECT ${company}, coalesce(max(sequence), 0) + 1, ${JSON.stringify(table)}::text::jsonb, ${contentHash(table)}, ${ENGINE_VERSION}, 'Prices for a test', 'blank', ${owner}, ${`key-${randomUUID()}`}
    FROM price_table_versions WHERE company_id = ${company}
  `;
}

const l = linkFlow(
  () => h,
  {
    createJob: jobsRoute.POST,
    putPhoto: photoRoute.PUT,
    submit: submissionsRoute.POST,
    nextDraft: draftsRoute.POST,
    request,
    params,
    customer: customerRoute.PUT,
    estimate: estimateRoute.POST,
    agreements: agreementsRoute.POST,
    signingLink: signingLinkRoute,
    sign: signRoute,
    signature: signatureRoute,
    signedSignature: signedSignatureRoute,
  },
  publish,
);

// One company with everything S5a makes, as the suite attacks it.
type Side = {
  name: 'A' | 'B';
  companyId: string;
  people: { owner: FakeClaims; estimator: FakeClaims; office: FakeClaims };
  // The job signed through a link, and the job with a pending signing link.
  signed: {
    jobId: string;
    photoId: string;
    signatureId: string;
    assignmentId: string;
    homeowner: { id: string; token: string };
    adjuster: { id: string; token: string };
    usedToken: string;
  };
  pending: { jobId: string; photoId: string; assignmentId: string; token: string };
  // Every id, hash and name of the company's rows that the other company's rows do not share, its
  // live tokens and its customers' names: what would show the company in an answer or a row.
  markers: string[];
};

let a: Side;
let b: Side;

// Every table of the public schema with a company column, from the catalog.
async function companyTables(): Promise<string[]> {
  return (
    await h.admin<{ name: string }[]>`
      SELECT c.relname AS name FROM pg_class c JOIN pg_attribute col ON col.attrelid = c.oid
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND col.attname = 'company_id' AND NOT col.attisdropped
      ORDER BY c.relname
    `
  ).map((found) => found.name);
}

// A company's rows of every company table (and its own company row), as text: what a refused call
// must leave as it was.
async function rowsOf(companyId: string): Promise<string> {
  const dump: Record<string, unknown> = { companies: await h.admin`SELECT * FROM companies WHERE id = ${companyId}` };
  for (const table of await companyTables()) dump[table] = await h.admin.unsafe(`SELECT * FROM "${table}" WHERE company_id = $1 ORDER BY 1`, [companyId]);
  return JSON.stringify(dump);
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const HEX64 = /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/g;
const valuesIn = (text: string) => new Set([...(text.toLowerCase().match(UUID) ?? []), ...(text.toLowerCase().match(HEX64) ?? [])]);

async function signedSide(name: 'A' | 'B', companyId: string, estimator: FakeClaims) {
  const customer = { name: `Customer Line ${name}`, address: `${name} Property Lane, Testville` };
  // A job signed by the homeowner through a link; the document links are made at signing.
  const linked = await l.linkedJob(estimator, companyId, customer);
  const signed = await l.homeownerSigns(linked.token, `Signer Line ${name}`);
  expect(signed.answer.status).toBe(201);
  const issued = Object.fromEntries(
    (signed.answer.body.documentLinks as { link: { id: string; set: string }; token: string }[]).map((found) => [found.link.set, { id: found.link.id, token: found.token }]),
  ) as Record<'homeowner' | 'adjuster', { id: string; token: string }>;
  // A claim on it too, so the claim table holds the company's rows.
  await h.admin`INSERT INTO job_claims (company_id, job_id, carrier, claim_number) VALUES (${companyId}, ${linked.jobId}, ${`Carrier Line ${name}`}, ${`Claim Line ${name}`})`;
  // A second job whose signing link is still pending.
  const pending = await l.linkedJob(estimator, companyId, { name: `Second Customer ${name}`, address: `${name} Second Lane, Testville` });
  // S5b-1: office assigns the company's estimator to both jobs and keeps office notes on each.
  const office: FakeClaims = { tenant: estimator.tenant, uid: `office-${name.toLowerCase()}` };
  const estimatorActorId = name === 'A' ? h.seed.estimatorA.actor : h.seed.estimatorB.actor;
  const coordinate = async (jobId: string, notes: string) => {
    const id = randomUUID();
    const assigned = await assignmentsRoute.POST(
      request(office, `/api/jobs/${jobId}/assignments`, { method: 'POST', body: { id, estimatorActorId } }),
      params({ jobId }),
    );
    expect(assigned.status).toBe(201);
    const saved = await coordinationRoute.PUT(
      request(office, `/api/jobs/${jobId}/coordination`, { method: 'PUT', body: { revision: 0, changeId: randomUUID(), notes } }),
      params({ jobId }),
    );
    expect(saved.status).toBe(200);
    return id;
  };
  const signedAssignment = await coordinate(linked.jobId, `Office Notes Line ${name}`);
  const pendingAssignment = await coordinate(pending.jobId, `Office Notes Second ${name}`);
  // S5b-10 (0020, no routes yet): a drying reading on each job, and on the signed job a close, its
  // estimate history sample (the close's baseline) and a drying watch action, written as slice 10B will.
  const [agreement] = await h.admin<{ id: string }[]>`SELECT id::text FROM agreements WHERE job_id = ${linked.jobId}`;
  for (const jobId of [linked.jobId, pending.jobId]) {
    const readingId = randomUUID();
    await h.admin`
      INSERT INTO drying_readings (id, company_id, job_id, kind, room_id, room_label, taken_at, payload, request_digest, created_by_actor_id)
      VALUES (${readingId}, ${companyId}, ${jobId}, 'material', 'room-1', ${`Drying Room ${name}`}, now(),
              ${h.admin.json({ material: 'Drywall', moisture: 18, unit: '%WME', dry_standard: 12, affected: true, note: `Drying Note ${name}` })},
              ${digestOf(readingId)}, ${estimatorActorId})
    `;
  }
  await h.admin`
    INSERT INTO estimate_history (company_id, job_id, agreement_id, signed_at, price_mode, low_cents, high_cents)
    VALUES (${companyId}, ${linked.jobId}, ${agreement!.id}, now(), 'range', 110000, 140000)
  `;
  const closeId = randomUUID();
  await h.admin`
    INSERT INTO job_closes (id, company_id, job_id, agreement_id, revision, request_digest, final_cents, actual_days, note, baseline_agreement_id, price_mode,
                            baseline_low_cents, baseline_high_cents, landed, closed_by_actor_id)
    VALUES (${closeId}, ${companyId}, ${linked.jobId}, ${agreement!.id}, 1, ${digestOf(closeId)}, 125000, 4, ${`Close Note ${name}`}, ${agreement!.id}, 'range',
            110000, 140000, 'inside', ${estimatorActorId})
  `;
  const watchRequest = randomUUID();
  const watch = {
    revision: 1,
    receipts: [{ action: 'extend', agreement_id: agreement!.id, reason: `Watch Reason ${name}`, actor_id: estimatorActorId, request_id: watchRequest, request_digest: digestOf(watchRequest) }],
  };
  await h.admin`UPDATE job_coordination SET drying_watch = ${h.admin.json(watch)} WHERE job_id = ${linked.jobId}`;
  return {
    signed: {
      jobId: linked.jobId,
      photoId: linked.photoId,
      signatureId: signed.signatureId,
      assignmentId: signedAssignment,
      homeowner: issued.homeowner,
      adjuster: issued.adjuster,
      usedToken: linked.token,
    },
    pending: { jobId: pending.jobId, photoId: pending.photoId, assignmentId: pendingAssignment, token: pending.token },
    names: [
      customer.name,
      customer.address,
      `Second Customer ${name}`,
      `Signer Line ${name}`,
      `Carrier Line ${name}`,
      `Claim Line ${name}`,
      `Terms Line ${name}`,
      `Office Notes Line ${name}`,
      `Office Notes Second ${name}`,
      `Drying Room ${name}`,
      `Drying Note ${name}`,
      `Close Note ${name}`,
      `Watch Reason ${name}`,
    ],
    tokens: [linked.token, pending.token, issued.homeowner.token, issued.adjuster.token],
  };
}

async function seedSides(): Promise<void> {
  await l.setUp();
  const [officeB] = await h.admin<{ id: string }[]>`
    INSERT INTO actors (company_id, auth_tenant_id, uid, email) VALUES (${h.seed.b}, 'tenant-b', 'office-b', 'office-b@example.test') RETURNING id
  `;
  await h.admin`INSERT INTO memberships (company_id, actor_id, role) VALUES (${h.seed.b}, ${officeB!.id}, 'office')`;
  // Each company's own signing settings, with a marker, so its documents can be signed.
  for (const [companyId, name] of [
    [h.seed.a, 'A'],
    [h.seed.b, 'B'],
  ] as const) {
    await h.admin`
      UPDATE companies SET profile_address = ${`Profile Line ${name}`}, profile_phone = '555-0100', profile_email = ${`office-${name.toLowerCase()}@example.invalid`},
        profile_license = ${`Licence Line ${name}`}, profile_signoff = ${`Signoff Line ${name}`},
        profile_documents = ${JSON.stringify({ authorization_text: `Terms Line ${name}`, payment_terms_text: `Payment Line ${name}` })}::text::jsonb
      WHERE id = ${companyId}
    `;
  }
  const made = {
    A: await signedSide('A', h.seed.a, { tenant: 'tenant-a', uid: 'estimator-a' }),
    B: await signedSide('B', h.seed.b, { tenant: 'tenant-b', uid: 'estimator-b' }),
  };
  const valuesA = valuesIn(await rowsOf(h.seed.a));
  const valuesB = valuesIn(await rowsOf(h.seed.b));
  const side = (name: 'A' | 'B', companyId: string, own: Set<string>, other: Set<string>): Side => {
    const suffix = name.toLowerCase();
    const person = (role: string): FakeClaims => ({ tenant: `tenant-${suffix}`, uid: `${role}-${suffix}` });
    const { signed, pending, names, tokens } = made[name];
    return {
      name,
      companyId,
      people: { owner: person('owner'), estimator: person('estimator'), office: person('office') },
      signed,
      pending,
      markers: [...[...own].filter((value) => !other.has(value)), ...names.map((value) => value.toLowerCase()), ...tokens, `tenant-${suffix}`, `profile line ${suffix}`],
    };
  };
  a = side('A', h.seed.a, valuesA, valuesB);
  b = side('B', h.seed.b, valuesB, valuesA);
}

beforeAll(async () => {
  base = await startTeamServer();
  vi.stubEnv('APP_ENV', 'test');
});

beforeEach(async () => {
  h = await resetTeamDatabase(base, live.harness);
  live.harness = h;
  made = new Set();
  await seedSides();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await live.harness?.handle.close();
  await base?.admin.end({ timeout: 5 });
  await base?.server.stop();
});

type Handler = (request: Request, context: ReturnType<typeof params>) => Response | Promise<Response>;
let loaded: Promise<Map<string, RouteModule>> | undefined;
const modules = () => (loaded ??= routeModules());
async function handlerFor(route: string, method: string): Promise<Handler> {
  const found = (await modules()).get(route)?.[method];
  if (typeof found !== 'function') throw new Error(`${method} ${route} is not exported`);
  return found as Handler;
}

let made = new Set<string>();
type Answer = { status: number; text: string };
async function call(row: Pick<MatrixRow, 'route' | 'method' | 'body' | 'query'>, who: string, claims: FakeClaims | null, ids: Record<string, string>, token?: string): Promise<Answer> {
  const handler = await handlerFor(row.route, row.method);
  const path = pathFor(row.route, ids);
  made.add(callKey(who, row.method, path));
  const built = request(claims, `${path}${row.query ?? ''}`, { method: row.method, body: row.body });
  if (token !== undefined) built.headers.set('x-link-token', token);
  const response = await handler(built, params(ids));
  return { status: response.status, text: await response.text() };
}

const leaks = (text: string, victim: Side) => victim.markers.filter((marker) => text.toLowerCase().includes(marker.toLowerCase()));

// The victim's real record ids for every path parameter an S5a route has, on one of its two jobs.
const idsOf = (victim: Side, job: 'signed' | 'pending', company: Side = victim): Record<string, string> => ({
  companyId: company.companyId,
  jobId: victim[job].jobId,
  photoId: victim[job].photoId,
  linkId: victim.signed.homeowner.id,
  signatureId: victim.signed.signatureId,
  assignmentId: victim[job].assignmentId,
});

const directions = (): [Side, Side][] => [
  [b, a],
  [a, b],
];
const rowsFor = (route: string) => MATRIX.filter((row) => `/${row.route}` === route);
const s5aRows = () => MATRIX.filter((row) => isS5a(`/${row.route}`));

describe('the S5a routes', () => {
  it('are the generated route list’s, which agrees with the route files the matrix reads, and each has a row', async () => {
    const folders = [...(await modules()).keys()].filter((route) => route.startsWith('api/')).map((route) => `/${route}`);
    expect([...GENERATED_API_ROUTES].sort()).toEqual(folders.sort());
    // Every S5a area has routes (a renamed folder would leave this suite with nothing to call).
    for (const folder of S5A_FOLDERS) expect({ folder, routes: S5A_ROUTES.some((route) => route === folder || route.startsWith(`${folder}/`)) }).toEqual({ folder, routes: true });
    expect(S5A_ROUTES.filter((route) => rowsFor(route).length === 0)).toEqual([]);
    // And every handler of those routes has its row (the whole list is company-isolation.test.ts's).
    const handlers = handlersOf(await modules()).filter((handler) => isS5a(`/${handler.route}`));
    expect(handlers.filter((handler) => !MATRIX.some((row) => matrixKey(row) === matrixKey(handler))).map(matrixKey)).toEqual([]);
  });

  it('refuse the other company’s owner, estimator and office user on both of the company’s jobs, with nothing of it and no change', async () => {
    const before = await everything(h.admin);
    const expected: string[] = [];
    // The signed-in routes: the jobs (but the create and the list, below) and the profile.
    const rows = s5aRows().filter((row) => row.kind === 'company' && row.own !== 'create' && !row.self);
    expect(rows.length).toBeGreaterThan(15);
    for (const [attacker, victim] of directions()) {
      for (const [role, claims] of Object.entries(attacker.people)) {
        for (const job of ['signed', 'pending'] as const) {
          for (const row of rows) {
            const ids = idsOf(victim, job);
            const answer = await call(row, claims.uid, claims, ids);
            expected.push(callKey(claims.uid, row.method, pathFor(row.route, ids)));
            const where = `${attacker.name} ${role}: ${row.method} ${row.route} on ${victim.name}'s ${job} job`;
            expect({ where, status: REFUSED.includes(answer.status) ? 'refused' : answer.status }).toEqual({ where, status: 'refused' });
            expect({ where, leaked: leaks(answer.text, victim) }).toEqual({ where, leaked: [] });
          }
        }
      }
    }
    expect(uncalled(expected, made)).toEqual([]);
    expect(await everything(h.admin)).toBe(before);
  });

  // Reads and deletes: a photo stored under the caller's own job is the caller's own, whatever its id.
  it('refuse the caller’s own job with the other company’s link, photo or signature ids', async () => {
    const before = await everything(h.admin);
    const rows = s5aRows().filter((row) => row.kind === 'company' && row.own === 'cross' && row.method !== 'PUT' && /\[(linkId|photoId|signatureId|assignmentId)\]/.test(row.route));
    expect(rows.map(matrixKey)).toEqual(
      expect.arrayContaining(['DELETE api/jobs/[jobId]/document-links/[linkId]', 'GET api/jobs/[jobId]/photos/[photoId]', 'DELETE api/jobs/[jobId]/assignments/[assignmentId]']),
    );
    for (const [attacker, victim] of directions()) {
      for (const [role, claims] of Object.entries(attacker.people)) {
        for (const row of rows) {
          const answer = await call(row, claims.uid, claims, { ...idsOf(victim, 'signed', attacker), jobId: attacker.signed.jobId });
          const where = `${attacker.name} ${role}: ${row.method} ${row.route} with ${victim.name}'s ids`;
          expect({ where, status: REFUSED.includes(answer.status) ? 'refused' : answer.status }).toEqual({ where, status: 'refused' });
          expect({ where, leaked: leaks(answer.text, victim) }).toEqual({ where, leaked: [] });
        }
      }
    }
    expect(await everything(h.admin)).toBe(before);
  });

  it('answer each company’s own people with its own records and lists, and never the other’s', async () => {
    const reads = s5aRows().filter((row) => row.kind === 'company' && row.method === 'GET' && !/\[(linkId|photoId|signatureId|assignmentId)\]/.test(row.route));
    for (const [self, other] of directions()) {
      for (const [role, claims] of Object.entries(self.people)) {
        for (const job of ['signed', 'pending'] as const) {
          for (const row of reads) {
            const answer = await call(row, claims.uid, claims, idsOf(self, job));
            const where = `${self.name} ${role}: ${row.method} ${row.route} on its ${job} job`;
            expect({ where, status: [200, 403, 404].includes(answer.status) }).toEqual({ where, status: true });
            expect({ where, leaked: leaks(answer.text, other) }).toEqual({ where, leaked: [] });
          }
        }
      }
      // The owner's answers do show the company's own records, so the clean answers are not empty ones.
      for (const route of ['api/jobs', 'api/jobs/[jobId]/estimate', 'api/jobs/[jobId]/agreements', 'api/jobs/[jobId]/document-links', 'api/jobs/[jobId]/coordination']) {
        const answer = await call({ route, method: 'GET' }, 'owner', self.people.owner, idsOf(self, 'signed'));
        expect({ route, as: self.name, status: answer.status, own: leaks(answer.text, self).length > 0 }).toEqual({ route, as: self.name, status: 200, own: true });
      }
      const link = await call({ route: 'api/jobs/[jobId]/signing-link', method: 'GET' }, 'owner', self.people.owner, idsOf(self, 'pending'));
      expect({ as: self.name, status: link.status, own: leaks(link.text, self).length > 0 }).toEqual({ as: self.name, status: 200, own: true });
    }
  });
});

describe('the link routes, with each company’s own live tokens', () => {
  it('open only the token’s own company: the other company’s photo, signature and records are refused or absent', async () => {
    const rows = s5aRows().filter((row) => row.kind === 'link');
    expect(rows.length).toBeGreaterThanOrEqual(8);
    const expected: string[] = [];
    for (const [attacker, victim] of directions()) {
      const victimBefore = await rowsOf(victim.companyId);
      const tokens = { pending: attacker.pending.token, used: attacker.signed.usedToken, homeowner: attacker.signed.homeowner.token, adjuster: attacker.signed.adjuster.token };
      for (const [kind, token] of Object.entries(tokens)) {
        for (const row of rows) {
          // A sign request names the other company's signature: never one this link uploaded.
          const body = row.method === 'POST' ? { ...(row.body as Body), signatureId: victim.signed.signatureId } : row.body;
          const ids = idsOf(victim, 'signed');
          const who = `${attacker.name} ${kind} token`;
          const answer = await call({ ...row, body }, who, null, ids, token);
          expected.push(callKey(who, row.method, pathFor(row.route, ids)));
          const where = `${who}: ${row.method} ${row.route} with ${victim.name}'s ids`;
          // A write may repeat the id the caller itself sent (a signature stored under that id is the
          // token's own company's); nothing else of the other company.
          const sent = row.method === 'GET' ? [] : [victim.signed.signatureId];
          expect({ where, leaked: leaks(answer.text, victim).filter((marker) => !sent.includes(marker)) }).toEqual({ where, leaked: [] });
          // A read named by the other company's id is refused outright; so is a signature claimed as this link's.
          if (/\[photoId\]/.test(row.route) || row.method === 'POST') {
            expect({ where, status: answer.status >= 400 && answer.status < 500 }).toEqual({ where, status: true });
          }
        }
      }
      expect(await rowsOf(victim.companyId)).toBe(victimBefore);
    }
    expect(uncalled(expected, made)).toEqual([]);
  });

  it('show each token’s own company, so the clean answers above are not empty ones', async () => {
    for (const side of [a, b]) {
      const page = await call({ route: 'api/sign', method: 'GET' }, 'pending', null, {}, side.pending.token);
      expect({ as: side.name, status: page.status, own: leaks(page.text, side).length > 0 }).toEqual({ as: side.name, status: 200, own: true });
      const documents = await call({ route: 'api/documents', method: 'GET' }, 'homeowner', null, {}, side.signed.homeowner.token);
      expect({ as: side.name, status: documents.status, own: leaks(documents.text, side).length > 0 }).toEqual({ as: side.name, status: 200, own: true });
    }
  });
});

// --- SQL, directly, as the runtime role ----------------------------------------------------------

// A transaction as the runtime role with the company the request's sign-in would have set.
async function asRuntime<T>(companyId: string, run: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  const sql = postgres(h.apiUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
  try {
    return (await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.company_id', ${companyId}, true)`;
      return run(tx);
    })) as T;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function outcomeOf(companyId: string, statement: string, values: unknown[] = []): Promise<string> {
  try {
    const result = await asRuntime(companyId, (tx) => tx.unsafe(statement, values as never[]));
    return result.count === 0 ? 'no rows' : `changed ${result.count} rows`;
  } catch (error) {
    return `error ${(error as { code?: string }).code ?? 'unknown'}`;
  }
}

// Company tables the S5a flow does not fill, each with where its own two-company check is. A new
// company table fails the suite until it is filled above or named here with its reason.
const NOT_FILLED: Record<string, string> = {
  agreement_corrections: 'S5b-1 table for S5b-4: office-tables.test.ts checks it; S5b-4 adds its routes',
  access_projection_outbox: 'S3 identity: company-isolation.test.ts seeds and attacks it',
  ai_ledger: 'S7 AI: ai-tables.test.ts and row-level-security.test.ts',
  ai_results: 'S7 AI: ai-tables.test.ts and row-level-security.test.ts',
  company_ai_settings: 'S7 AI: ai-tables.test.ts and row-level-security.test.ts',
  invitations: 'S3 identity: company-isolation.test.ts seeds and attacks it',
  live_sessions: 'S7 Live: live-tables.test.ts',
  live_turns: 'S7 Live: live-tables.test.ts',
  live_usage: 'S7 Live: live-tables.test.ts',
  member_voice_settings: 'S7 Live: live-tables.test.ts',
  voice_notes: 'S7 Live: live-tables.test.ts',
  price_table_working_copies: 'S4 Prices: company-isolation.test.ts seeds and attacks it',
  job_price_approvals: 'S5b-8 table: price-approvals-table.test.ts checks it; the S5b-8 server slice adds its routes',
};

// What a copied row needs to look new, so a table's own insert guard (which runs before the row
// policy) lets it through to the policy: a planted row is then refused by the policy itself.
const FRESH: Record<string, Record<string, unknown>> = {
  jobs: { revision: 1, status: 'draft', last_change_id: null, field_revision: 0, field_synced_revision: 0 },
  job_submissions: { status: 'pending', snapshot_bytes: null, snapshot_sha256: null, decided_at: null, marker_state: 'pending' },
  price_table_versions: { sequence: 1 },
};

describe('SQL as the runtime role, on every company table', () => {
  it('finds both companies’ rows in every table the S5a flow fills, so no check below is blind', async () => {
    const tables = await companyTables();
    expect(tables).toEqual(expect.arrayContaining(['jobs', 'job_customers', 'job_claims', 'evidence_objects', 'job_submissions', 'job_price_pins', 'job_estimates', 'agreements', 'signing_links', 'document_links']));
    const counts: Record<string, string> = {};
    for (const table of tables) {
      const [found] = await h.admin.unsafe<{ a: number; b: number }[]>(`SELECT count(*) FILTER (WHERE company_id = $1)::int AS a, count(*) FILTER (WHERE company_id = $2)::int AS b FROM "${table}"`, [a.companyId, b.companyId]);
      counts[table] = found!.a > 0 && found!.b > 0 ? 'both' : (NOT_FILLED[table] ?? 'missing a company');
    }
    expect(Object.entries(counts).filter(([, value]) => value === 'missing a company')).toEqual([]);
    // A table named as not filled that the flow now fills, or that no longer exists, is stale.
    expect(Object.keys(NOT_FILLED).filter((table) => counts[table] === undefined || counts[table] === 'both')).toEqual([]);
  });

  it('shows one company none of the other’s rows in any company table, and its own rows in each it fills', async () => {
    const tables = await companyTables();
    for (const [self, other] of directions()) {
      const seen = await asRuntime(self.companyId, async (tx) => {
        const found: Record<string, { own: number; other: number; text: string }> = {};
        for (const table of tables) {
          found[table] = await tx
            .savepoint(async (sp) => {
              const rows = await sp.unsafe(`SELECT to_jsonb(t) AS row FROM "${table}" t ORDER BY 1`);
              const companies = rows.map((row) => (row.row as { company_id: string }).company_id);
              return { own: companies.filter((id) => id === self.companyId).length, other: companies.filter((id) => id !== self.companyId).length, text: JSON.stringify(rows) };
            })
            // A table the runtime holds no grant on is refused outright, which is as closed as it gets.
            .catch((error: { code?: string }) => (error.code === '42501' ? { own: 0, other: 0, text: '[]' } : Promise.reject(error)));
        }
        return found;
      });
      for (const table of tables) {
        const { own, other: others, text } = seen[table]!;
        expect({ table, as: self.name, others, leaked: leaks(text, other) }).toEqual({ table, as: self.name, others: 0, leaked: [] });
        if (!NOT_FILLED[table]) expect({ table, as: self.name, own: own > 0 }).toEqual({ table, as: self.name, own: true });
      }
    }
  });

  it('refuses to insert, change or delete the other company’s rows in every company table, and leaves them as they were', async () => {
    const before = await everything(h.admin);
    const tables = (await companyTables()).filter((table) => !NOT_FILLED[table]);
    const outcomes: Record<string, string[]> = {};
    for (const [attacker, victim] of directions()) {
      for (const table of tables) {
        // The columns a row is written with (not the generated ones), and those the runtime may
        // change, so an update below reaches the row policy and not only the grant.
        const columns = await asRuntime(attacker.companyId, (tx) =>
          tx<{ name: string; updatable: boolean }[]>`
            SELECT attname AS name, has_column_privilege(attrelid, attnum, 'UPDATE') AS updatable FROM pg_attribute
            WHERE attrelid = ${table}::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = '' AND attidentity <> 'a' ORDER BY attnum
          `,
        );
        const list = columns.map((column) => `"${column.name}"`).join(', ');
        const updatable = columns.find((column) => column.updatable && column.name !== 'company_id');
        // One of the victim's own rows, copied as the attacker would plant it again (with a new id).
        const [sample] = await h.admin.unsafe<{ row: Record<string, unknown> }[]>(`SELECT to_jsonb(t) AS row FROM "${table}" t WHERE company_id = $1 LIMIT 1`, [victim.companyId]);
        const copy = { ...sample!.row, ...(typeof sample!.row.id === 'string' ? { id: randomUUID() } : {}), ...FRESH[table] };
        const tried = {
          insert: await outcomeOf(attacker.companyId, `INSERT INTO "${table}" (${list}) SELECT ${list} FROM jsonb_populate_record(NULL::"${table}", $1)`, [copy]),
          change: updatable ? await outcomeOf(attacker.companyId, `UPDATE "${table}" SET "${updatable.name}" = "${updatable.name}" WHERE company_id = $1`, [victim.companyId]) : 'no rows',
          take: await outcomeOf(attacker.companyId, `UPDATE "${table}" SET company_id = $2 WHERE company_id = $1`, [victim.companyId, attacker.companyId]),
          give: await outcomeOf(attacker.companyId, `UPDATE "${table}" SET company_id = $2 WHERE company_id = $1`, [attacker.companyId, victim.companyId]),
          delete: await outcomeOf(attacker.companyId, `DELETE FROM "${table}" WHERE company_id = $1`, [victim.companyId]),
        };
        // Either the policy or the grant refuses (42501), or the policy hides every row (no rows).
        outcomes[`${attacker.name} on ${table}`] = Object.entries(tried)
          .filter(([, outcome]) => outcome !== 'no rows' && outcome !== 'error 42501')
          .map(([what, outcome]) => `${what}: ${outcome}`);
      }
    }
    expect(Object.entries(outcomes).filter(([, wrong]) => wrong.length > 0)).toEqual([]);
    expect(await everything(h.admin)).toBe(before);
  });

  it('cannot reach the other company’s rows through a join from its own', async () => {
    for (const [attacker, victim] of directions()) {
      const rows = await asRuntime(attacker.companyId, (tx) =>
        tx.unsafe(
          `SELECT a.id FROM agreements a JOIN job_estimates e ON e.id = a.estimate_id JOIN document_links d ON d.agreement_id = a.id
           JOIN signing_links s ON s.job_id = a.job_id JOIN evidence_objects o ON o.id = a.signature_evidence_id WHERE a.company_id = $1 OR e.company_id = $1 OR d.company_id = $1`,
          [victim.companyId],
        ),
      );
      expect({ as: attacker.name, rows: rows.length }).toEqual({ as: attacker.name, rows: 0 });
    }
  });
});
