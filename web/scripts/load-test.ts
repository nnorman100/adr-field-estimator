// The load test kit (S8-7, docs/plans/S8/S8-7.md), run by the owner against the TEST environment in
// S8-22. Load users of a company whose name starts with `load-` sign in once each (the token is
// reused, so the test measures the app and not Google's sign-in limits), then for the run's length:
//
// - the morning opening: everyone opens the app within the first minute (/api/me, the job list);
// - a field day, per technician: the job list, a new job, the job, its item list, the field draft
//   written as the phone writes it, a photo every 30 seconds sent in bursts of ten (1 MB of fresh
//   bytes each), customer and claim saved, Finish, the estimate and its documents, then the next job;
// - an office day, per office user: the job list refreshed, one job opened, its documents.
//
// It never calls an AI route. At the end it lists what it made through the app and checks every
// record is there exactly once, prints percentiles, and exits non-zero when a pass mark in
// web/load/pass-marks.json fails. The pass marks read from charts are printed for the owner.
//
//   LOAD_TEST_PASSWORD=... node scripts/load-test.ts --url https://test.<domain> --company <sign-in address> \
//     --api-key <web API key> --project <project id> --database <field database id> \
//     --technicians a@example.com,b@example.com --office c@example.com [--minutes 20]
//
// Guards: only the test address is accepted (an https host starting `test.` whose /api/health says
// `test`; plain http only for a local server saying `local`), so a live host is refused before any
// sign-in is sent; only a company named `load-...`; the load users' one password comes from
// LOAD_TEST_PASSWORD or a prompt, never from an argument or a file. Office users sign in with their
// authenticator app's code, asked for once each. Output holds times, counts and status codes only:
// no token, email, address or record content. Plain Node (type stripping), no package needed.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

export type PassMarks = {
  readsP95Ms: number;
  photoP95Ms: number;
  finishMaxMs: number;
  errorRateBelow: number;
  everyRecordOnce: boolean;
  byHand: string[];
};

export type LoadUser = { email: string; role: 'estimator' | 'office' };

export type LoadOptions = {
  baseUrl: string;
  company: string;
  apiKey: string;
  projectId: string;
  databaseId: string;
  users: LoadUser[];
  durationMs: number;
  openingMs: number;
  photosPerJob: number;
  photoGapMs: number;
  thinkMs: number;
  officePauseMs: number;
  photoBytes: number;
  // The Google endpoints; only a test points these at the emulators.
  identityToolkitUrl?: string;
  firestoreUrl?: string;
  fetch?: typeof fetch;
};

export type Deps = {
  password: () => Promise<string>;
  // The authenticator app's code for the n-th office user (1-based), asked once at sign-in.
  totpCode: (officeNumber: number) => Promise<string>;
  // A sign-in of the caller's own in place of the password sign-in (the browser suite's office
  // users, whose second step the Auth emulator cannot do).
  signIn?: (user: LoadUser, tenantId: string) => Promise<string>;
  log?: (line: string) => void;
};

export type Category = 'read' | 'photo' | 'finish' | 'write' | 'field';

type Sample = { category: Category; label: string; ms: number; status: number; error: string | null };

export type Stats = { count: number; p50: number | null; p95: number | null; p99: number | null; max: number | null };

export type MadeJob = { jobId: string; submissionId: string | null; estimated: boolean; photos: Map<string, string> };

export type Report = {
  stats: Record<Category, Stats>;
  requests: number;
  errors: number;
  errorRate: number;
  errorsByKind: Record<string, number>;
  records: { jobs: number; submissions: number; estimates: number; photos: number; problems: string[] };
  marks: { name: string; passed: boolean; detail: string }[];
  byHand: string[];
  passed: boolean;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROOM_ID = 'room-1';
const MAX_MINUTES = 50;
const TIMEOUT_MS = 30_000;

// --- Percentiles ---------------------------------------------------------------------------------

/** The nearest-rank percentile (p in 0..100) of the samples; null when there are none. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  if (!(p >= 0 && p <= 100)) throw new Error('a percentile is between 0 and 100');
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
}

export function statsOf(values: readonly number[]): Stats {
  return {
    count: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: values.length === 0 ? null : Math.max(...values),
  };
}

// --- Guards --------------------------------------------------------------------------------------

const isLoopback = (host: string) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]';

/**
 * Accepts only the test address: an https host starting `test.` whose health answer says `test`,
 * or a loopback http server whose health answer says `local` (the browser suite's). Anything else,
 * a live host above all, is refused before any sign-in or password is sent.
 */
export async function checkTarget(baseUrl: string, doFetch: typeof fetch = fetch): Promise<'test' | 'local'> {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('--url is not an address');
  }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('--url must be the site root only');
  const local = isLoopback(url.hostname);
  if (local ? url.protocol !== 'http:' && url.protocol !== 'https:' : url.protocol !== 'https:' || !url.hostname.startsWith('test.')) {
    throw new Error('refused: only the test address (https://test.<domain>) or a local server is accepted');
  }
  let env: unknown;
  try {
    const res = await doFetch(new URL('/api/health', url), { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    env = res.status === 200 ? ((await res.json()) as { env?: unknown }).env : null;
  } catch (error) {
    throw new Error(`refused: the health check failed (${error instanceof Error ? error.name : 'error'}); nothing was sent`);
  }
  const expected = local ? 'local' : 'test';
  if (env !== expected) throw new Error(`refused: the service did not say it is the ${expected} environment; nothing was sent`);
  return expected;
}

/** The company's sign-in tenant, refusing any company whose name does not start with `load-`. */
export async function loadCompany(baseUrl: string, address: string, doFetch: typeof fetch = fetch): Promise<{ tenantId: string; name: string }> {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(address)) throw new Error('--company must be the company sign-in address');
  const res = await doFetch(new URL(`/api/sign-in/${address}`, baseUrl), { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status !== 200) throw new Error(`the company sign-in address answered ${res.status}`);
  const body = (await res.json()) as { company?: { name?: unknown }; tenantId?: unknown };
  const name = body.company?.name;
  if (typeof name !== 'string' || !name.startsWith('load-')) throw new Error('refused: the company name does not start with load-');
  if (typeof body.tenantId !== 'string') throw new Error('the company has no sign-in tenant');
  return { tenantId: body.tenantId, name };
}

// --- Arguments -----------------------------------------------------------------------------------

export function parseArgs(argv: string[]): LoadOptions {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]!;
    const value = argv[i + 1];
    if (!name.startsWith('--') || value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
    if (/pass(word)?|secret|token/i.test(name)) throw new Error('the password is read from LOAD_TEST_PASSWORD or a prompt, never from an argument');
    flags.set(name.slice(2), value);
  }
  const known = ['url', 'company', 'api-key', 'project', 'database', 'technicians', 'office', 'minutes', 'opening-seconds', 'photos-per-job'];
  for (const name of flags.keys()) if (!known.includes(name)) throw new Error(`unknown option --${name}`);
  const need = (name: string): string => {
    const value = flags.get(name);
    if (!value) throw new Error(`--${name} is required`);
    return value;
  };
  const list = (name: string) => (flags.get(name) ?? '').split(',').map((email) => email.trim()).filter(Boolean);
  const users: LoadUser[] = [
    ...list('technicians').map((email) => ({ email, role: 'estimator' as const })),
    ...list('office').map((email) => ({ email, role: 'office' as const })),
  ];
  if (!users.some((user) => user.role === 'estimator')) throw new Error('--technicians needs at least one load user');
  const number = (name: string, fallback: number, max: number) => {
    const value = Number(flags.get(name) ?? fallback);
    if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`--${name} must be a whole number from 1 to ${max}`);
    return value;
  };
  return {
    baseUrl: need('url').replace(/\/+$/, '') + '/',
    company: need('company'),
    apiKey: need('api-key'),
    projectId: need('project'),
    databaseId: need('database'),
    users,
    // ID tokens last an hour, and each is fetched once.
    durationMs: number('minutes', 20, MAX_MINUTES) * 60_000,
    openingMs: number('opening-seconds', 60, 600) * 1000,
    photosPerJob: number('photos-per-job', 20, 300),
    photoGapMs: 30_000,
    thinkMs: 2000,
    officePauseMs: 20_000,
    photoBytes: 1024 * 1024,
  };
}

// --- Sign-in -------------------------------------------------------------------------------------

/** A password sign-in to the company's tenant, with the authenticator app's code when asked. */
export async function passwordSignIn(
  options: LoadOptions,
  tenantId: string,
  user: LoadUser,
  password: string,
  totpCode: () => Promise<string>,
): Promise<string> {
  const doFetch = options.fetch ?? fetch;
  const base = options.identityToolkitUrl ?? 'https://identitytoolkit.googleapis.com';
  const post = async (path: string, body: unknown) => {
    const res = await doFetch(`${base}${path}?key=${encodeURIComponent(options.apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const reply = (await res.json()) as Record<string, unknown>;
    // Only Google's error code, never the address or the answer.
    if (!res.ok) throw new Error(`sign-in refused: ${String((reply.error as { message?: unknown } | undefined)?.message ?? res.status)}`);
    return reply;
  };
  const first = await post('/v1/accounts:signInWithPassword', { email: user.email, password, tenantId, returnSecureToken: true });
  if (typeof first.idToken === 'string' && first.idToken) return first.idToken;
  const enrolment = (first.mfaInfo as { mfaEnrollmentId?: unknown; totpInfo?: unknown }[] | undefined)?.find((info) => info.totpInfo !== undefined);
  if (typeof first.mfaPendingCredential !== 'string' || typeof enrolment?.mfaEnrollmentId !== 'string') {
    throw new Error('sign-in refused: no authenticator app second step to finish');
  }
  const second = await post('/v2/accounts/mfaSignIn:finalize', {
    mfaPendingCredential: first.mfaPendingCredential,
    mfaEnrollmentId: enrolment.mfaEnrollmentId,
    tenantId,
    totpVerificationInfo: { verificationCode: (await totpCode()).trim() },
  });
  if (typeof second.idToken !== 'string') throw new Error('sign-in refused: no token after the second step');
  return second.idToken;
}

// --- The field draft, as the phone writes it -----------------------------------------------------

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// The field draft's canonical form (web/src/lib/field/canonical.ts, kept equal by a unit test):
// object keys sorted by code unit, rooms and photo references sorted by id, no spaces.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort(byCodeUnit).map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export type Manifest = { draft: Record<string, unknown>; rooms: { id: string; field: Record<string, unknown> }[]; photos: { id: string; field: Record<string, unknown> }[] };

/** SHA-256 of the draft's canonical form, as Finish and review sends it. */
export function draftDigest(manifest: Manifest): string {
  const sorted = (docs: Manifest['rooms']) => [...docs].sort((a, b) => byCodeUnit(a.id, b.id)).map((doc) => ({ id: doc.id, field: doc.field }));
  const text = canonicalJson({ draft: manifest.draft, photos: sorted(manifest.photos), rooms: sorted(manifest.rooms) });
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// A JavaScript value as a Firestore REST value.
function firestoreValue(value: unknown): unknown {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(firestoreValue) } };
  if (value !== null && typeof value === 'object') {
    return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, firestoreValue(inner)])) } };
  }
  throw new Error('a field value Firestore cannot hold');
}

/** One photo's bytes: a JPEG start and fresh random bytes, so every upload is a new file. */
export function freshPhoto(size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(randomBytes(size));
  bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
  return bytes;
}

// --- The run -------------------------------------------------------------------------------------

type Session = { user: LoadUser; token: string; number: number };

const sleep = (ms: number, until = Infinity) => new Promise<void>((done) => setTimeout(done, Math.max(0, Math.min(ms, until - Date.now()))));

export async function runLoadTest(options: LoadOptions, marks: PassMarks, deps: Deps): Promise<Report> {
  const doFetch = options.fetch ?? fetch;
  const log = deps.log ?? (() => {});
  await checkTarget(options.baseUrl, doFetch);
  const company = await loadCompany(options.baseUrl, options.company, doFetch);
  log(`target checked; company ${company.name}; ${options.users.length} load users`);

  // Each load user signs in once, before the clock starts.
  const password = deps.signIn ? '' : await deps.password();
  const sessions: Session[] = [];
  let office = 0;
  for (const user of options.users) {
    const number = user.role === 'office' ? ++office : 0;
    const token = deps.signIn
      ? await deps.signIn(user, company.tenantId)
      : await passwordSignIn(options, company.tenantId, user, password, () => deps.totpCode(number));
    sessions.push({ user, token, number });
  }

  const samples: Sample[] = [];
  const made: MadeJob[] = [];
  let companyId = '';

  async function call(session: Session, category: Category, label: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown> | null }> {
    const url = path.startsWith('http') ? path : new URL(path, options.baseUrl).toString();
    const start = performance.now();
    let status = 0;
    let body: Record<string, unknown> | null = null;
    let error: string | null = null;
    try {
      const res = await doFetch(url, {
        ...init,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { authorization: `Bearer ${session.token}`, ...(init.headers as Record<string, string> | undefined) },
      });
      status = res.status;
      const text = await res.text();
      try {
        body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
      } catch {
        body = null;
      }
      if (status >= 400) error = typeof body?.error === 'string' ? body.error : typeof (body?.error as { status?: unknown })?.status === 'string' ? String((body!.error as { status: string }).status) : 'error';
    } catch (caught) {
      error = caught instanceof Error ? caught.name : 'error';
    }
    samples.push({ category, label, ms: performance.now() - start, status, error });
    return { status: error ? 0 : status, body };
  }

  const fieldBase = `${options.firestoreUrl ?? 'https://firestore.googleapis.com'}/v1/projects/${options.projectId}/databases/${encodeURIComponent(options.databaseId)}/documents`;
  const fieldWrite = (session: Session, label: string, path: string, field: Record<string, unknown>, create: boolean) =>
    call(session, 'field', label, `${fieldBase}/${path}?${create ? 'currentDocument.exists=false' : 'updateMask.fieldPaths=field'}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { field: firestoreValue(field) } }),
    });

  const startedAt = Date.now();
  const deadline = startedAt + options.durationMs;
  const think = () => sleep(options.thinkMs, deadline);

  // The morning opening: each user opens the app at some moment of the first minute.
  async function opening(session: Session) {
    await sleep(Math.random() * Math.min(options.openingMs, options.durationMs));
    const me = await call(session, 'read', 'me', '/api/me');
    const meCompany = (me.body?.company as { id?: unknown; name?: unknown } | undefined) ?? {};
    if (me.status !== 200 || meCompany.name !== company.name || me.body?.role !== session.user.role) {
      throw new Error(`refused: a load user is not ${session.user.role === 'office' ? 'an office user' : 'a technician'} of the load company`);
    }
    companyId ||= String(meCompany.id);
    await call(session, 'read', 'job list', `/api/jobs?scope=${session.user.role === 'office' ? 'company' : 'mine'}`);
  }

  async function fieldJob(session: Session, sequence: number) {
    const job: MadeJob = { jobId: randomUUID(), submissionId: null, estimated: false, photos: new Map() };
    const draftId = randomUUID();
    const created = await call(session, 'write', 'create job', '/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: job.jobId, draftId, propertyAddress: '' }),
    });
    if (created.status !== 201) return;
    made.push(job);
    await think();
    await call(session, 'read', 'job', `/api/jobs/${job.jobId}`);
    await call(session, 'read', 'item list', `/api/jobs/${job.jobId}/scope-lists`);
    const draftPath = `companies/${companyId}/drafts/${draftId}`;
    const manifest: Manifest = {
      draft: { roomOrder: [ROOM_ID], scopeConfirmed: true, summary: 'Load test: category 2 water in one room.', yearBuilt: 1990 },
      rooms: [{ id: ROOM_ID, field: { name: 'Room 1', category: 2, floorSf: 120, wetFloorSf: 80 } }],
      photos: [],
    };
    await fieldWrite(session, 'room', `${draftPath}/rooms/${ROOM_ID}`, manifest.rooms[0]!.field, true);
    await fieldWrite(session, 'draft', draftPath, manifest.draft, false);

    // A photo every 30 seconds, sent ten at a time; at the deadline the job is finished with what it has.
    for (let sent = 0; sent < options.photosPerJob && Date.now() < deadline; ) {
      for (let i = 0; i < 10 && sent < options.photosPerJob; i += 1, sent += 1) {
        const photoId = randomUUID();
        const bytes = freshPhoto(options.photoBytes);
        const put = await call(session, 'photo', 'photo', `/api/jobs/${job.jobId}/photos/${photoId}?kind=photo`, {
          method: 'PUT',
          headers: { 'Content-Type': 'image/jpeg' },
          body: bytes,
        });
        if (put.status !== 201) continue;
        job.photos.set(photoId, createHash('sha256').update(bytes).digest('hex'));
        const field = { roomId: ROOM_ID };
        if ((await fieldWrite(session, 'photo reference', `${draftPath}/photos/${photoId}`, field, true)).status === 200) {
          manifest.photos.push({ id: photoId, field });
        }
      }
      if (sent < options.photosPerJob) await sleep(10 * options.photoGapMs, deadline);
    }

    let revision = Number((created.body?.job as { revision?: unknown } | undefined)?.revision ?? 1);
    const customer = await call(session, 'write', 'customer', `/api/jobs/${job.jobId}/customer`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision, changeId: randomUUID(), name: `Load Customer ${session.number}-${sequence}`, phone: '555-0100', email: '', propertyAddress: `${sequence} Load Test Lane` }),
    });
    revision = Number((customer.body?.job as { revision?: unknown } | undefined)?.revision ?? revision);
    await think();
    await call(session, 'write', 'claim', `/api/jobs/${job.jobId}/claim`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revision, changeId: randomUUID(), carrier: 'Load Carrier', claimNumber: `LOAD-${sequence}`, policyNumber: '', dateOfLoss: null,
        lossCause: 'Load test', adjusterName: '', adjusterEmail: '', adjusterPhone: '', deductible: '',
      }),
    });
    await think();
    // Finish (Submit). A photo whose reference write failed is not in the draft, so not in the record.
    for (const [id] of job.photos) if (!manifest.photos.some((photo) => photo.id === id)) job.photos.delete(id);
    const submissionId = randomUUID();
    const finish = await call(session, 'finish', 'finish', `/api/jobs/${job.jobId}/submissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: submissionId, draftId, digest: draftDigest(manifest) }),
    });
    if (finish.status !== 201) return;
    job.submissionId = submissionId;
    const estimate = await call(session, 'write', 'estimate', `/api/jobs/${job.jobId}/estimate`, { method: 'POST' });
    job.estimated = estimate.status === 201;
    await call(session, 'read', 'documents', `/api/jobs/${job.jobId}/estimate`);
  }

  async function technician(session: Session) {
    await opening(session);
    for (let sequence = 1; Date.now() < deadline; sequence += 1) {
      await call(session, 'read', 'job list', '/api/jobs?scope=mine');
      await fieldJob(session, sequence);
      await think();
    }
  }

  async function officeDay(session: Session) {
    await opening(session);
    while (Date.now() < deadline) {
      const list = await call(session, 'read', 'job list', '/api/jobs?scope=company');
      const jobs = ((list.body?.jobs as { id?: unknown }[] | undefined) ?? []).map((job) => String(job.id)).filter((id) => UUID.test(id));
      const pick = jobs[Math.floor(Math.random() * jobs.length)];
      if (pick) {
        await call(session, 'read', 'job', `/api/jobs/${pick}`);
        await call(session, 'read', 'documents', `/api/jobs/${pick}/estimate`);
      }
      await sleep(options.officePauseMs, deadline);
    }
  }

  log(`run started for ${Math.round(options.durationMs / 1000)} seconds`);
  await Promise.all(sessions.map((session) => (session.user.role === 'office' ? officeDay(session) : technician(session))));
  const runSamples = [...samples];
  log(`run finished after ${Math.round((Date.now() - startedAt) / 1000)} seconds; checking records`);
  const records = await checkRecords(sessions, made, call);
  return judge(runSamples, records, marks);
}

// --- The records check ---------------------------------------------------------------------------

type Call = (session: Session, category: Category, label: string, path: string) => Promise<{ status: number; body: Record<string, unknown> | null }>;

// What the run made, read back through the app: each job once in its technician's list, each
// finished job with its one submission and its estimate, whose photo log names every photo sent
// exactly once with the bytes' hash.
async function checkRecords(sessions: Session[], made: MadeJob[], call: Call): Promise<Report['records']> {
  const problems: string[] = [];
  const listed = new Map<string, number>();
  for (const session of sessions.filter((s) => s.user.role === 'estimator')) {
    let cursor: string | null = null;
    do {
      const page = await call(session, 'read', 'check list', `/api/jobs?scope=mine&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      if (page.status !== 200) {
        problems.push(`the job list answered ${page.status}`);
        break;
      }
      for (const job of (page.body?.jobs as { id: string }[] | undefined) ?? []) listed.set(job.id, (listed.get(job.id) ?? 0) + 1);
      cursor = typeof page.body?.nextCursor === 'string' ? page.body.nextCursor : null;
    } while (cursor);
  }
  const owner = sessions.find((s) => s.user.role === 'estimator')!;
  const counts = { jobs: 0, submissions: 0, estimates: 0, photos: 0 };
  let n = 0;
  for (const job of made) {
    n += 1;
    const seen = listed.get(job.jobId) ?? 0;
    if (seen !== 1) problems.push(`job ${n}: listed ${seen} times`);
    else counts.jobs += 1;
    if (!job.submissionId) continue;
    const answer = await call(owner, 'read', 'check estimate', `/api/jobs/${job.jobId}/estimate`);
    const estimate = answer.body?.estimate as { submissionId?: unknown; documents?: { photoLog?: { id?: unknown; sha256?: unknown }[] } | null } | null | undefined;
    if (answer.status !== 200 || !estimate) {
      problems.push(`job ${n}: no estimate for its record`);
      continue;
    }
    if (estimate.submissionId !== job.submissionId) problems.push(`job ${n}: the estimate is for another record`);
    else counts.submissions += 1;
    if (job.estimated) counts.estimates += 1;
    else problems.push(`job ${n}: the estimate was not made by this run`);
    const log = estimate.documents?.photoLog ?? [];
    const logged = new Map<string, number>();
    for (const row of log) logged.set(String(row.id), (logged.get(String(row.id)) ?? 0) + 1);
    for (const [photoId, sha256] of job.photos) {
      const times = logged.get(photoId) ?? 0;
      const row = log.find((entry) => entry.id === photoId);
      if (times !== 1 || row?.sha256 !== sha256) problems.push(`job ${n}: a photo is in the record ${times} times`);
      else counts.photos += 1;
    }
    if (log.length !== job.photos.size) problems.push(`job ${n}: the record holds ${log.length} photos, ${job.photos.size} were sent`);
  }
  return { ...counts, problems };
}

// --- Judging -------------------------------------------------------------------------------------

export function judge(samples: readonly Sample[], records: Report['records'], marks: PassMarks): Report {
  const of = (category: Category) => samples.filter((s) => s.category === category).map((s) => s.ms);
  const stats = { read: statsOf(of('read')), photo: statsOf(of('photo')), finish: statsOf(of('finish')), write: statsOf(of('write')), field: statsOf(of('field')) };
  const failed = samples.filter((s) => s.error !== null);
  const errorsByKind: Record<string, number> = {};
  for (const s of failed) {
    const key = `${s.label} ${s.status || 'no answer'} ${s.error}`;
    errorsByKind[key] = (errorsByKind[key] ?? 0) + 1;
  }
  const errorRate = samples.length === 0 ? 1 : failed.length / samples.length;
  const under = (name: string, value: number | null, limit: number) => ({
    name,
    passed: value !== null && value < limit,
    detail: value === null ? 'no samples' : `${Math.round(value)} ms (under ${limit} ms)`,
  });
  const result = [
    under('reads, 95th percentile', stats.read.p95, marks.readsP95Ms),
    under('1 MB photo, 95th percentile', stats.photo.p95, marks.photoP95Ms),
    under('Finish, slowest', stats.finish.max, marks.finishMaxMs),
    { name: 'errors', passed: samples.length > 0 && errorRate < marks.errorRateBelow, detail: `${(errorRate * 100).toFixed(2)}% of ${samples.length} (under ${marks.errorRateBelow * 100}%)` },
    {
      name: 'every created record present exactly once',
      passed: !marks.everyRecordOnce || (records.problems.length === 0 && records.jobs > 0),
      detail: records.problems.length ? records.problems.slice(0, 10).join('; ') : `${records.jobs} jobs, ${records.submissions} records, ${records.estimates} estimates, ${records.photos} photos`,
    },
  ];
  return {
    stats,
    requests: samples.length,
    errors: failed.length,
    errorRate,
    errorsByKind,
    records,
    marks: result,
    byHand: marks.byHand,
    passed: result.every((mark) => mark.passed),
  };
}

export function formatReport(report: Report): string[] {
  const ms = (value: number | null) => (value === null ? '-' : String(Math.round(value)));
  const lines = ['category   count    p50    p95    p99    max  (ms)'];
  for (const [name, s] of Object.entries(report.stats)) {
    lines.push(`${name.padEnd(9)} ${String(s.count).padStart(6)} ${ms(s.p50).padStart(6)} ${ms(s.p95).padStart(6)} ${ms(s.p99).padStart(6)} ${ms(s.max).padStart(6)}`);
  }
  for (const [kind, count] of Object.entries(report.errorsByKind)) lines.push(`error: ${kind} x${count}`);
  for (const mark of report.marks) lines.push(`${mark.passed ? 'PASS' : 'FAIL'} ${mark.name}: ${mark.detail}`);
  for (const check of report.byHand) lines.push(`CHECK BY HAND ${check}`);
  lines.push(report.passed ? 'load test: the measured pass marks passed' : 'load test: a pass mark failed');
  return lines;
}

export async function readPassMarks(): Promise<PassMarks> {
  return JSON.parse(await readFile(new URL('../load/pass-marks.json', import.meta.url), 'utf8')) as PassMarks;
}

// --- Prompts -------------------------------------------------------------------------------------

async function ask(question: string, hidden: boolean): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    // Echo nothing of what is typed.
    (rl as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = (text: string) => {
      if (text.includes(question)) process.stdout.write(question);
    };
  }
  try {
    return await rl.question(question);
  } finally {
    rl.close();
    if (hidden) process.stdout.write('\n');
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const marks = await readPassMarks();
  const report = await runLoadTest(options, marks, {
    password: async () => process.env.LOAD_TEST_PASSWORD || (await ask('Load users\' password: ', true)),
    totpCode: (number) => ask(`Authenticator code for office user ${number}: `, false),
    log: (line) => console.log(line),
  });
  for (const line of formatReport(report)) console.log(line);
  const file = `load-test-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await writeFile(file, JSON.stringify(report, null, 2));
  console.log(`report written to ${file}`);
  process.exit(report.passed ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'the load test failed');
    process.exit(1);
  });
}
