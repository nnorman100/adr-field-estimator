import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { contentHash, ENGINE_VERSION, parseTable } from '../../src/engine/table';
import { passwordSignIn, readPassMarks, runLoadTest, type LoadOptions, type LoadUser } from '../../scripts/load-test';
import { JOBS_BASE_URL } from './jobs/backend';
import { adminSql, seedCompany, type Company } from './jobs/seed';
import { FIELD_DATABASE, FIRESTORE_EMULATOR_HOST } from './offline/emulators';
import { withSecondFactor } from './second-step/fake-totp';
import { AUTH_EMULATOR_HOST, E2E_PROJECT, idTokenFor } from './sign-in/emulator';
import { PASSWORD } from './sign-in/seed';

// The load test kit (S8-7, scripts/load-test.ts) run for ten seconds with two load users, a
// technician and an office user, against the browser suite's jobs server (real PostgreSQL, the
// Auth, Firestore and Storage emulators). The technician signs in through the kit's own password
// sign-in against the Auth emulator; the office user's authenticator-app step, which the emulator
// cannot do, is stood in for as the other browser tests do (second-step/fake-totp.ts). No browser
// page is used, so it runs in one engine only.

test.skip(({ browserName }) => browserName !== 'chromium', 'no page: one engine is enough');
test.setTimeout(180_000);

// A `load-` company with price books on, one published price and the profile its documents print.
async function loadCompany(): Promise<Company> {
  const company = await seedCompany('load', { owner: 'owner', tech: 'estimator', tech2: 'estimator', office: 'office' });
  const db = adminSql();
  const name = `load-${randomUUID().slice(0, 8)}`;
  await db`
    UPDATE companies SET name = ${name}, profile_address = '1 Synthetic Way, Testville', profile_phone = '555-0100',
      profile_email = 'office@example.invalid', profile_license = '000001', profile_signoff = 'Pat Example'
    WHERE id = ${company.id}
  `;
  await db`INSERT INTO company_feature_flags (company_id, flag, enabled) VALUES (${company.id}, 'price_books', true)`;
  const table = parseTable({
    items: [{ item_id: 'extraction', group: 'treatment', name: 'Water extraction', unit: 'sf', quantity_source: 'room:wet_floor', unit_price: '2.00' }],
    policy: {
      estimate_mode: 'single',
      range: { first_sf: 1000, first_percent: '0', beyond_percent: '0' },
      after_hours: { multiplier: '1' },
      category_multipliers: { '1': '1', '2': '1', '3': '1' },
      cabinetry: { multiplier: '1', scope: 'finished_only' },
      sales_tax: { enabled: false, percent: '0' },
    },
  });
  const [owner] = await db<{ id: string }[]>`SELECT id::text FROM actors WHERE company_id = ${company.id} AND display_name = 'owner'`;
  await db`
    INSERT INTO price_table_versions (company_id, sequence, content, content_hash, engine_version, reason, source, published_by_actor_id, publish_key)
    VALUES (${company.id}, 1, ${JSON.stringify(table)}::text::jsonb, ${contentHash(table)}, ${ENGINE_VERSION}, 'Prices for a test', 'blank', ${owner!.id}, ${`key-${randomUUID()}`})
  `;
  return { ...company, name };
}

type Stand = 'plain' | 'slow' | 'opening fails' | 'lost answers';

function optionsFor(company: Company, stand: Stand): LoadOptions {
  const slowReads = stand === 'slow';
  const users: LoadUser[] = [
    { email: company.people.tech!.email, role: 'estimator' },
    ...(stand === 'opening fails' ? [{ email: company.people.tech2!.email, role: 'estimator' as const }] : []),
    { email: company.people.office!.email, role: 'office' },
  ];
  // The slow stand-in: every read of the app answers 2.1 seconds late, past the 2-second mark.
  const slow: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const read = url.origin === new URL(JOBS_BASE_URL).origin && (init?.method ?? 'GET') === 'GET' && url.pathname.startsWith('/api/jobs');
    if (read) await new Promise((done) => setTimeout(done, 2100));
    return fetch(input, init);
  };
  // The app's first answer to a load user opening it, once every user has signed in, is a 503.
  let meCalls = 0;
  const openingFails: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin === new URL(JOBS_BASE_URL).origin && url.pathname === '/api/me' && ++meCalls === users.length + 1) {
      return Response.json({ error: 'identity_unavailable' }, { status: 503 });
    }
    return fetch(input, init);
  };
  // The first answer to making a job and to sending a photo is lost after the app acted on it.
  const lost = new Set<string>();
  const lostAnswers: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const kind = url.origin !== new URL(JOBS_BASE_URL).origin ? null : init?.method === 'POST' && url.pathname === '/api/jobs' ? 'jobs' : init?.method === 'PUT' && url.pathname.includes('/photos/') ? 'photos' : null;
    const answer = await fetch(input, init);
    if (!kind || lost.has(kind)) return answer;
    lost.add(kind);
    await answer.arrayBuffer();
    return Response.json({ error: `${kind}_unavailable` }, { status: 503 });
  };
  const stands: Partial<Record<Stand, typeof fetch>> = { slow, 'opening fails': openingFails, 'lost answers': lostAnswers };
  return {
    baseUrl: `${JOBS_BASE_URL}/`,
    company: company.address,
    apiKey: 'fake-api-key',
    projectId: E2E_PROJECT,
    databaseId: FIELD_DATABASE,
    users,
    durationMs: 10_000,
    openingMs: 1000,
    photosPerJob: slowReads ? 1 : 10,
    // A photo every 100 ms on each technician's clock, so a burst of ten comes every second.
    photoGapMs: 100,
    thinkMs: 0,
    officePauseMs: 1000,
    photoBytes: 1024 * 1024,
    retryMs: 200,
    identityToolkitUrl: `http://${AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com`,
    firestoreUrl: `http://${FIRESTORE_EMULATOR_HOST}`,
    ...(stands[stand] ? { fetch: stands[stand] } : {}),
  };
}

// The technician signs in through the kit's own password sign-in against the Auth emulator; the
// office user's token also carries the authenticator-app claim the server requires of office users.
function signInFor(options: LoadOptions, company: Company) {
  return async (user: LoadUser, tenantId: string) => {
    expect(tenantId).toBe(company.tenantId);
    if (user.role === 'estimator') {
      return passwordSignIn(options, tenantId, user, PASSWORD, async () => {
        throw new Error('a technician has no second step here');
      });
    }
    return withSecondFactor(await idTokenFor(tenantId, user.email, PASSWORD));
  };
}

async function run(stand: Stand) {
  const company = await loadCompany();
  const options = optionsFor(company, stand);
  const report = await runLoadTest(options, await readPassMarks(), {
    password: async () => PASSWORD,
    totpCode: async () => '',
    signIn: signInFor(options, company),
    // The owner's readings from the database log and the instance chart.
    afterRun: async () => ({ connectionErrors: 0, peakInstances: 1 }),
  });
  return { company, report };
}

test('a ten-second run with two load users measures every pass mark and finds every record exactly once', async () => {
  const { company, report } = await run('plain');
  expect(report.errorsByKind).toEqual({});
  // The time marks are the owner's run's to judge (S8-22): this server is a cold local build on a
  // shared CI runner. Here each must have been measured, and the error and record marks must pass.
  const mark = (name: string) => report.marks.find((found) => found.name === name)!;
  for (const name of ['reads, 95th percentile', '1 MB photo, 95th percentile', 'Finish, slowest']) expect(mark(name).detail).toMatch(/^\d+ ms/);
  expect(mark('errors').passed, mark('errors').detail).toBe(true);
  expect(mark('every created record present exactly once').passed, mark('every created record present exactly once').detail).toBe(true);
  expect(report.records.problems).toEqual([]);
  expect(report.records.jobs).toBeGreaterThanOrEqual(1);
  expect(report.records.submissions).toBe(report.records.jobs);
  expect(report.records.estimates).toBe(report.records.jobs);
  expect(report.records.photos).toBe(10 * report.records.jobs);
  expect(report.stats.read.count).toBeGreaterThan(0);
  expect(report.stats.photo.count).toBe(10 * report.records.jobs);
  expect(report.stats.finish.count).toBe(report.records.jobs);
  expect(report.byHand.length).toBe(2);
  expect(mark('no error from running out of database connections').passed).toBe(true);
  // The office user opened jobs that have documents, and got them.
  expect(report.records.officeDocuments).toBeGreaterThanOrEqual(1);
  expect(report.instances).toEqual({ peak: 1, limit: 1 });

  // What the database holds for the company is exactly what the report counted.
  const db = adminSql();
  const [counts] = await db<{ jobs: number; submissions: number; estimates: number; photos: number }[]>`
    SELECT (SELECT count(*)::int FROM jobs WHERE company_id = ${company.id}) AS jobs,
      (SELECT count(*)::int FROM job_submissions WHERE company_id = ${company.id} AND status = 'committed') AS submissions,
      (SELECT count(*)::int FROM job_estimates WHERE company_id = ${company.id}) AS estimates,
      (SELECT count(*)::int FROM evidence_objects WHERE company_id = ${company.id} AND kind = 'photo') AS photos
  `;
  expect(counts).toEqual({ jobs: report.records.jobs, submissions: report.records.jobs, estimates: report.records.jobs, photos: report.records.photos });
});

test('a deliberately slow stand-in for the app fails the reads pass mark', async () => {
  const { report } = await run('slow');
  const reads = report.marks.find((mark) => mark.name === 'reads, 95th percentile')!;
  expect(reads.passed).toBe(false);
  expect(report.stats.read.p95!).toBeGreaterThan(2000);
  expect(report.passed).toBe(false);
});

test('two technicians, one opening answered 503: the run still reports, and each technician\'s records are found', async () => {
  const { company, report } = await run('opening fails');
  expect(report.errorsByKind).toEqual({ 'me 503 identity_unavailable': 1 });
  expect(report.records.problems).toEqual([]);
  const mark = report.marks.find((found) => found.name === 'every created record present exactly once')!;
  expect(mark.passed, mark.detail).toBe(true);

  const db = adminSql();
  const [counts] = await db<{ jobs: number; technicians: number; estimates: number }[]>`
    SELECT count(*)::int AS jobs, count(DISTINCT created_by_actor_id)::int AS technicians,
      (SELECT count(*)::int FROM job_estimates WHERE company_id = ${company.id}) AS estimates
    FROM jobs WHERE company_id = ${company.id}
  `;
  expect(counts).toEqual({ jobs: report.records.jobs, technicians: 2, estimates: report.records.estimates });
  expect(report.records.estimates).toBe(report.records.jobs);
});

test('answers lost after the app made a job and stored a photo: sent again with the same ids, each record is there exactly once', async () => {
  const { company, report } = await run('lost answers');
  expect(report.errorsByKind).toEqual({ 'create job 503 jobs_unavailable': 1, 'photo 503 photos_unavailable': 1 });
  expect(report.records.problems).toEqual([]);
  const mark = report.marks.find((found) => found.name === 'every created record present exactly once')!;
  expect(mark.passed, mark.detail).toBe(true);
  expect(report.records.photos).toBe(10 * report.records.jobs);

  const db = adminSql();
  const [counts] = await db<{ jobs: number; submissions: number; photos: number }[]>`
    SELECT (SELECT count(*)::int FROM jobs WHERE company_id = ${company.id}) AS jobs,
      (SELECT count(*)::int FROM job_submissions WHERE company_id = ${company.id} AND status = 'committed') AS submissions,
      (SELECT count(*)::int FROM evidence_objects WHERE company_id = ${company.id} AND kind = 'photo') AS photos
  `;
  expect(counts).toEqual({ jobs: report.records.jobs, submissions: report.records.submissions, photos: report.records.photos });
});
