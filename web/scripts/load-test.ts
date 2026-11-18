// The load test kit (S8-7, docs/plans/S8/S8-7.md), run by the owner against the TEST environment in
// S8-22 at pilot size (L10: five technicians and two office users, 20 minutes). Load users of a
// company whose name starts with `load-` sign in once each (the token is reused, so the test
// measures the app and not Google's sign-in limits), then for 20 minutes:
//
// - the morning opening: everyone opens the app within the first minute (/api/me, the job list);
// - a field day, per technician: the job list, a new job, the job, its item list, the field draft
//   written as the phone writes it, a photo every 30 seconds sent in bursts of ten (1 MB of fresh
//   bytes each; the photo clock runs on across jobs), customer and claim saved, Finish, the
//   estimate and its documents, then the next job;
// - an office day, per office user: the job list refreshed, one job that has documents opened,
//   its documents.
//
// It never calls an AI route. Every record's id is noted before it is written; an answer that is
// lost or a 5xx is sent again with the same id, as the phone does, and whatever stays unknown is
// settled at the end by reading the app. The end lists what the run made through the app and checks
// every record is present exactly once. It prints percentiles, asks the owner for the database
// log's count of refused connections (any fails the run) and the peak Cloud Run instances (shown
// against the limit, not judged), and exits non-zero when a pass mark in web/load/pass-marks.json fails.
//
//   LOAD_TEST_PASSWORD=... node scripts/load-test.ts --url <test address> --company <sign-in address> \
//     --api-key <web API key> --project <project id> --database <field database id> \
//     --technicians t1@example.com,t2@...,t5@... --office o1@example.com,o2@example.com
//
// Guards: only an address listed for test in infra/dryscope/app/envs/test.tfvars (allowed_origins)
// whose /api/health says `test` is accepted, so a live host is refused before any sign-in is sent;
// plain http only for a local server saying `local` (the browser suite's). Only a company named
// `load-...`. The load users' one password comes from LOAD_TEST_PASSWORD or a prompt, never from an
// argument or a file; office users sign in with their authenticator app's code, asked once each.
// Output holds times, counts and status codes only: no token, email, address or record content.
// Plain Node (type stripping), no package needed.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import type { FieldManifest } from '../src/lib/field/canonical';

export type PassMarks = {
  readsP95Ms: number;
  photoP95Ms: number;
  finishMaxMs: number;
  errorRateBelow: number;
  databaseConnectionErrors: number;
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
  retryMs: number;
  // The Google endpoints; only a test points these at the emulators.
  identityToolkitUrl?: string;
  firestoreUrl?: string;
  fetch?: typeof fetch;
};

// What the owner reads after the run: the database log's count of refused connections in the
// run's window, and the web app's peak instances.
export type OwnerReadings = { connectionErrors: number; peakInstances: number };

export type Deps = {
  password: () => Promise<string>;
  // The authenticator app's code for the n-th office user (1-based), asked once at sign-in.
  totpCode: (officeNumber: number) => Promise<string>;
  // A sign-in of the caller's own in place of the password sign-in (the browser suite's office
  // users, whose second step the Auth emulator cannot do).
  signIn?: (user: LoadUser, tenantId: string) => Promise<string>;
  afterRun: (window: { start: string; end: string }) => Promise<OwnerReadings>;
  log?: (line: string) => void;
};

export type Category = 'read' | 'photo' | 'finish' | 'write' | 'field';

type Sample = { category: Category; label: string; ms: number; status: number; error: string | null };

export type Stats = { count: number; p50: number | null; p95: number | null; p99: number | null; max: number | null };

// The outcome of a write: the app said it was made (or already made), refused it, or never said.
type Outcome = 'made' | 'refused' | 'unknown';

type Session = { user: LoadUser; token: string; number: number; nextBurstAt: number };

type SentPhoto = { sha256: string; stored: Outcome; referenced: boolean };

export type MadeJob = {
  session: Session;
  jobId: string;
  created: Outcome;
  photos: Map<string, SentPhoto>;
  submissionId: string | null;
  submitted: Outcome | null;
  estimated: Outcome | null;
};

export type Records = { jobs: number; submissions: number; estimates: number; photos: number; officeDocuments: number; problems: string[] };

export type Report = {
  stats: Record<Category, Stats>;
  requests: number;
  errors: number;
  errorRate: number;
  errorsByKind: Record<string, number>;
  records: Records;
  instances: { peak: number; limit: number | null };
  marks: { name: string; passed: boolean; detail: string }[];
  byHand: string[];
  passed: boolean;
};

const ROOM_ID = 'room-1';
const TIMEOUT_MS = 30_000;
const ATTEMPTS = 3;
const TEST_TFVARS = new URL('../../infra/dryscope/app/envs/test.tfvars', import.meta.url);

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

export type TestConfig = { origins: string[]; maxInstances: number | null };

/** The test environment's configured web addresses and the web app's maximum instances. */
export function parseTestTfvars(text: string): TestConfig {
  const list = /^\s*allowed_origins\s*=\s*\[([^\]]*)\]/m.exec(text)?.[1] ?? '';
  const origins = [...list.matchAll(/"([^"]+)"/g)].map((match) => new URL(match[1]!).origin);
  const scaling = /^\s*api_scaling\s*=\s*\{([^}]*)\}/m.exec(text)?.[1] ?? '';
  const max = /^\s*max_instances\s*=\s*(\d+)/m.exec(scaling)?.[1];
  return { origins, maxInstances: max === undefined ? null : Number(max) };
}

export async function readTestConfig(): Promise<TestConfig> {
  return parseTestTfvars(await readFile(TEST_TFVARS, 'utf8'));
}

/**
 * Accepts only the test address: an origin listed for test (allowed_origins in test.tfvars) whose
 * health answer says `test`, or a loopback server whose health answer says `local` (the browser
 * suite's). Anything else, a live host above all, is refused before any sign-in or password is sent.
 */
export async function checkTarget(baseUrl: string, testOrigins: readonly string[], doFetch: typeof fetch = fetch): Promise<'test' | 'local'> {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('--url is not an address');
  }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('--url must be the site root only');
  const local = isLoopback(url.hostname) && (url.protocol === 'http:' || url.protocol === 'https:');
  if (!local && (url.protocol !== 'https:' || !testOrigins.includes(url.origin))) {
    throw new Error('refused: only an address listed for test in infra/dryscope/app/envs/test.tfvars, or a local server, is accepted');
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
  const res = await doFetch(new URL(`/api/sign-in/${address}`, baseUrl), { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status !== 200) throw new Error(`the company sign-in address answered ${res.status}`);
  const body = (await res.json()) as { company?: { name?: unknown }; tenantId?: unknown };
  const name = body.company?.name;
  if (typeof name !== 'string' || !name.startsWith('load-')) throw new Error('refused: the company name does not start with load-');
  if (typeof body.tenantId !== 'string') throw new Error('the company has no sign-in tenant');
  return { tenantId: body.tenantId, name };
}

// --- Arguments -----------------------------------------------------------------------------------

// The pilot (L10).
export const TECHNICIANS = 5;
export const OFFICE_USERS = 2;

export function parseArgs(argv: string[]): LoadOptions {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]!;
    const value = argv[i + 1];
    if (/pass(word)?|secret|token/i.test(name)) throw new Error('the password is read from LOAD_TEST_PASSWORD or a prompt, never from an argument');
    if (!name.startsWith('--') || value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
    flags.set(name.slice(2), value);
  }
  const known = ['url', 'company', 'api-key', 'project', 'database', 'technicians', 'office'];
  for (const name of flags.keys()) if (!known.includes(name)) throw new Error(`unknown option --${name}`);
  const need = (name: string): string => {
    const value = flags.get(name);
    if (!value) throw new Error(`--${name} is required`);
    return value;
  };
  const list = (name: string) => (flags.get(name) ?? '').split(',').map((email) => email.trim()).filter(Boolean);
  const technicians = list('technicians');
  const office = list('office');
  if (technicians.length !== TECHNICIANS) throw new Error(`--technicians needs exactly ${TECHNICIANS} load users`);
  if (office.length !== OFFICE_USERS) throw new Error(`--office needs exactly ${OFFICE_USERS} load users`);
  if (new Set([...technicians, ...office].map((email) => email.toLowerCase())).size !== TECHNICIANS + OFFICE_USERS) {
    throw new Error('each load user must be a different account');
  }
  return {
    baseUrl: need('url').replace(/\/+$/, '') + '/',
    company: need('company'),
    apiKey: need('api-key'),
    projectId: need('project'),
    databaseId: need('database'),
    users: [...technicians.map((email) => ({ email, role: 'estimator' as const })), ...office.map((email) => ({ email, role: 'office' as const }))],
    // The pilot's 20 minutes (L10), with its one-minute opening. ID tokens last an hour.
    durationMs: 20 * 60_000,
    openingMs: 60_000,
    photosPerJob: 20,
    photoGapMs: 30_000,
    thinkMs: 2000,
    officePauseMs: 20_000,
    photoBytes: 1024 * 1024,
    retryMs: 1000,
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

// Finish and review's own digest of the draft (web/src/lib/field/canonical.ts). Loaded by its file
// address so plain Node runs it with type stripping; it imports nothing.
async function manifestDigest(manifest: FieldManifest): Promise<string> {
  const canonical = (await import(new URL('../src/lib/field/canonical.ts', import.meta.url).href)) as typeof import('../src/lib/field/canonical');
  return canonical.manifestDigest(manifest);
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

const sleep = (ms: number, until = Infinity) => new Promise<void>((done) => setTimeout(done, Math.max(0, Math.min(ms, until - Date.now()))));

type Answer = { status: number; body: Record<string, unknown> | null };

// What a write's last answer says about the record: made (or already made), refused, or unknown.
const outcomeOf = (answer: Answer): Outcome => (answer.status === 200 || answer.status === 201 ? 'made' : answer.status >= 400 && answer.status < 500 ? 'refused' : 'unknown');

// A documents answer that carries the documents themselves.
const hasDocuments = (body: Record<string, unknown> | null): string | null => {
  const estimate = body?.estimate as { documents?: { itemizedClaim?: unknown } | null } | null | undefined;
  return estimate?.documents?.itemizedClaim ? null : 'no_documents';
};

export async function runLoadTest(options: LoadOptions, marks: PassMarks, deps: Deps): Promise<Report> {
  const doFetch = options.fetch ?? fetch;
  const log = deps.log ?? (() => {});
  const testConfig = await readTestConfig();
  await checkTarget(options.baseUrl, testConfig.origins, doFetch);
  const company = await loadCompany(options.baseUrl, options.company, doFetch);
  log(`target checked; company ${company.name}; ${options.users.length} load users`);

  // Each load user's membership of the load company, in the role given, checked once before the clock starts.
  async function memberOf(user: LoadUser, token: string): Promise<string> {
    const res = await doFetch(new URL('/api/me', options.baseUrl), { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { authorization: `Bearer ${token}` } });
    if (res.status !== 200) throw new Error(`the app answered ${res.status} for a load user before the run; nothing was written`);
    const body = (await res.json()) as { company?: { id?: unknown; name?: unknown }; role?: unknown };
    if (body.company?.name !== company.name || typeof body.company.id !== 'string' || body.role !== user.role) {
      throw new Error(`refused: a load user is not ${user.role === 'office' ? 'an office user' : 'a technician'} of the load company`);
    }
    return body.company.id;
  }

  // Each load user signs in once, before the clock starts.
  const password = deps.signIn ? '' : await deps.password();
  const sessions: Session[] = [];
  let companyId = '';
  let office = 0;
  for (const user of options.users) {
    const number = user.role === 'office' ? ++office : 0;
    const token = deps.signIn
      ? await deps.signIn(user, company.tenantId)
      : await passwordSignIn(options, company.tenantId, user, password, () => deps.totpCode(number));
    companyId = await memberOf(user, token);
    sessions.push({ user, token, number, nextBurstAt: 0 });
  }

  const samples: Sample[] = [];
  const made: MadeJob[] = [];
  let officeDocuments = 0;

  async function call(
    session: Session,
    category: Category,
    label: string,
    path: string,
    init: RequestInit = {},
    check?: (body: Record<string, unknown> | null) => string | null,
  ): Promise<Answer> {
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
      const code = body?.error;
      if (status >= 400) error = typeof code === 'string' ? code : typeof (code as { status?: unknown })?.status === 'string' ? String((code as { status: string }).status) : 'error';
      else if (check) error = check(body);
    } catch (caught) {
      error = caught instanceof Error ? caught.name : 'error';
    }
    samples.push({ category, label, ms: performance.now() - start, status, error });
    // A lost answer, or a 200 that fails its check, is status 0; a refusal keeps its status.
    return { status: error === null || status >= 400 ? status : 0, body };
  }

  // A write sent again with the same id and body while its answer is lost or a 5xx, as the phone
  // does; every attempt is measured. The last answer decides the outcome.
  async function write(attempt: (first: boolean) => Promise<Answer>): Promise<Answer> {
    let answer = await attempt(true);
    for (let i = 1; i < ATTEMPTS && outcomeOf(answer) === 'unknown'; i += 1) {
      await sleep(options.retryMs);
      answer = await attempt(false);
    }
    return answer;
  }

  const fieldBase = `${options.firestoreUrl ?? 'https://firestore.googleapis.com'}/v1/projects/${options.projectId}/databases/${encodeURIComponent(options.databaseId)}/documents`;
  // A field document write. A create says the document must be new; sent again, it is written whole.
  const fieldWrite = (session: Session, label: string, path: string, field: Record<string, unknown>, create: boolean) =>
    write((first) =>
      call(session, 'field', label, `${fieldBase}/${path}?${create && first ? 'currentDocument.exists=false' : 'updateMask.fieldPaths=field'}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { field: firestoreValue(field) } }),
      }),
    );
  const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  const startedAt = Date.now();
  const deadline = startedAt + options.durationMs;
  const think = () => sleep(options.thinkMs, deadline);
  // Each technician takes a photo every photoGapMs from the start; ten taken are sent at once.
  for (const session of sessions) session.nextBurstAt = startedAt + 10 * options.photoGapMs;

  // The morning opening: each user opens the app at some moment of the first minute.
  async function opening(session: Session) {
    await sleep(Math.random() * Math.min(options.openingMs, options.durationMs));
    await call(session, 'read', 'me', '/api/me');
    await call(session, 'read', 'job list', `/api/jobs?scope=${session.user.role === 'office' ? 'company' : 'mine'}`);
  }

  async function fieldJob(session: Session, sequence: number) {
    const job: MadeJob = { session, jobId: randomUUID(), created: 'unknown', photos: new Map(), submissionId: null, submitted: null, estimated: null };
    const draftId = randomUUID();
    // Noted before it is sent, so a job made behind a lost answer is still looked for at the end.
    made.push(job);
    const created = await write(() => call(session, 'write', 'create job', '/api/jobs', json('POST', { id: job.jobId, draftId, propertyAddress: '' })));
    job.created = outcomeOf(created);
    if (job.created !== 'made') return;
    await think();
    await call(session, 'read', 'job', `/api/jobs/${job.jobId}`);
    await call(session, 'read', 'item list', `/api/jobs/${job.jobId}/scope-lists`);
    const draftPath = `companies/${companyId}/drafts/${draftId}`;
    const manifest: FieldManifest & { photos: { id: string; field: Record<string, unknown> }[] } = {
      draft: { roomOrder: [ROOM_ID], scopeConfirmed: true, summary: 'Load test: category 2 water in one room.', yearBuilt: 1990 },
      rooms: [{ id: ROOM_ID, field: { name: 'Room 1', category: 2, floorSf: 120, wetFloorSf: 80 } }],
      photos: [],
    };
    await fieldWrite(session, 'room', `${draftPath}/rooms/${ROOM_ID}`, manifest.rooms[0]!.field as Record<string, unknown>, true);
    await fieldWrite(session, 'draft', draftPath, manifest.draft as Record<string, unknown>, false);

    // The photos: whenever ten more have been taken on the technician's photo clock, they are sent.
    for (let sent = 0; sent < options.photosPerJob; ) {
      await sleep(session.nextBurstAt - Date.now(), deadline);
      if (Date.now() >= deadline) break;
      const burst = Math.min(10, options.photosPerJob - sent);
      session.nextBurstAt += 10 * options.photoGapMs;
      for (let i = 0; i < burst; i += 1, sent += 1) {
        const photoId = randomUUID();
        const bytes = freshPhoto(options.photoBytes);
        const photo: SentPhoto = { sha256: createHash('sha256').update(bytes).digest('hex'), stored: 'unknown', referenced: false };
        job.photos.set(photoId, photo);
        const put = await write(() => call(session, 'photo', 'photo', `/api/jobs/${job.jobId}/photos/${photoId}?kind=photo`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: bytes }));
        photo.stored = outcomeOf(put);
        if (photo.stored !== 'made') continue;
        const field = { roomId: ROOM_ID };
        if (outcomeOf(await fieldWrite(session, 'photo reference', `${draftPath}/photos/${photoId}`, field, true)) === 'made') {
          photo.referenced = true;
          manifest.photos.push({ id: photoId, field });
        }
      }
    }

    // Each change's own id, made once, so a change sent again is the same change.
    const customerChange = randomUUID();
    const claimChange = randomUUID();
    let revision = Number((created.body?.job as { revision?: unknown } | undefined)?.revision ?? 1);
    const customer = await write(() =>
      call(session, 'write', 'customer', `/api/jobs/${job.jobId}/customer`, json('PUT', {
        revision, changeId: customerChange, name: `Load Customer ${session.number}-${sequence}`, phone: '555-0100', email: '', propertyAddress: `${sequence} Load Test Lane`,
      })),
    );
    revision = Number((customer.body?.job as { revision?: unknown } | undefined)?.revision ?? revision);
    await think();
    await write(() =>
      call(session, 'write', 'claim', `/api/jobs/${job.jobId}/claim`, json('PUT', {
        revision, changeId: claimChange, carrier: 'Load Carrier', claimNumber: `LOAD-${sequence}`, policyNumber: '', dateOfLoss: null,
        lossCause: 'Load test', adjusterName: '', adjusterEmail: '', adjusterPhone: '', deductible: '',
      })),
    );
    await think();
    // Finish (Submit): the draft as written, so a photo whose reference was never written is not in it.
    job.submissionId = randomUUID();
    const body = { id: job.submissionId, draftId, digest: await manifestDigest(manifest) };
    job.submitted = outcomeOf(await write(() => call(session, 'finish', 'finish', `/api/jobs/${job.jobId}/submissions`, json('POST', body))));
    if (job.submitted !== 'made') return;
    job.estimated = outcomeOf(await write(() => call(session, 'write', 'estimate', `/api/jobs/${job.jobId}/estimate`, { method: 'POST' })));
    await call(session, 'read', 'documents', `/api/jobs/${job.jobId}/estimate`, {}, hasDocuments);
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
      await call(session, 'read', 'job list', '/api/jobs?scope=company');
      // A job of this run that has documents (its estimate was made).
      const ready = made.filter((job) => job.estimated === 'made');
      const pick = ready[Math.floor(Math.random() * ready.length)];
      if (pick) {
        await call(session, 'read', 'job', `/api/jobs/${pick.jobId}`);
        if ((await call(session, 'read', 'documents', `/api/jobs/${pick.jobId}/estimate`, {}, hasDocuments)).status === 200) officeDocuments += 1;
      }
      await sleep(options.officePauseMs, deadline);
    }
  }

  log(`run started for ${Math.round(options.durationMs / 1000)} seconds`);
  const ended = await Promise.allSettled(sessions.map((session) => (session.user.role === 'office' ? officeDay(session) : technician(session))));
  const broken = ended.find((result) => result.status === 'rejected');
  if (broken) throw broken.reason;
  const endedAt = Date.now();
  const runSamples = [...samples];
  log(`run finished after ${Math.round((endedAt - startedAt) / 1000)} seconds; checking records`);
  const records = await checkRecords(sessions, made, call);
  records.officeDocuments = officeDocuments;
  // A minute either side, for the database's own log lines of the run.
  const owner = await deps.afterRun({ start: new Date(startedAt - 60_000).toISOString(), end: new Date(Date.now() + 60_000).toISOString() });
  return judge(runSamples, records, marks, owner, testConfig.maxInstances);
}

// --- The records check ---------------------------------------------------------------------------

type Call = (session: Session, category: Category, label: string, path: string) => Promise<Answer>;

type PhotoLogRow = { id?: unknown; sha256?: unknown };

// What the run made, read back through the app. Each job whose creation was answered, or that was
// asked for and never answered, is looked for in its technician's list: a made job must be there
// once, a refused one not at all, an unknown one at most once. A job that holds a record has the one
// submission this run sent and its estimate, whose photo log names each photo the draft referenced
// once with its bytes' hash and nothing else. Every other photo whose sending was made or unknown is
// read back by its id.
export async function checkRecords(sessions: Session[], made: MadeJob[], call: Call): Promise<Records> {
  const problems: string[] = [];
  const listed = new Map<string, Session[]>();
  for (const session of sessions.filter((s) => s.user.role === 'estimator')) {
    let cursor: string | null = null;
    do {
      const page = await call(session, 'read', 'check list', `/api/jobs?scope=mine&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      if (page.status !== 200) {
        problems.push(`the job list answered ${page.status}`);
        break;
      }
      for (const job of (page.body?.jobs as { id: string }[] | undefined) ?? []) listed.set(job.id, [...(listed.get(job.id) ?? []), session]);
      cursor = typeof page.body?.nextCursor === 'string' ? page.body.nextCursor : null;
    } while (cursor);
  }
  const counts = { jobs: 0, submissions: 0, estimates: 0, photos: 0 };
  let n = 0;
  for (const job of made) {
    n += 1;
    const where = listed.get(job.jobId) ?? [];
    const own = where.filter((session) => session === job.session).length;
    const present = where.length === 1 && own === 1;
    if (job.created === 'made' ? !present : job.created === 'refused' ? where.length !== 0 : where.length > 1 || (where.length === 1 && !present)) {
      problems.push(`job ${n}: listed ${where.length} times, ${own} in its technician's list (creation ${job.created})`);
      continue;
    }
    if (!present) continue;
    counts.jobs += 1;
    const state = await call(job.session, 'read', 'check job', `/api/jobs/${job.jobId}`);
    const status = (state.body?.job as { status?: unknown } | undefined)?.status;
    if (state.status !== 200) {
      problems.push(`job ${n}: the job answered ${state.status}`);
      continue;
    }
    const recorded = status === 'submitted';
    if (job.submitted === 'made' && !recorded) problems.push(`job ${n}: Finish was answered but the job holds no record`);
    if ((job.submitted === null || job.submitted === 'refused') && recorded) problems.push(`job ${n}: a record this run did not make`);

    const loose = [...job.photos].filter(([, photo]) => photo.stored !== 'refused' && (!recorded || !photo.referenced));
    if (recorded) {
      const answer = await call(job.session, 'read', 'check estimate', `/api/jobs/${job.jobId}/estimate`);
      const estimate = answer.body?.estimate as { submissionId?: unknown; documents?: { photoLog?: PhotoLogRow[] } | null } | null | undefined;
      if (answer.status !== 200 || !estimate) {
        if (job.estimated === 'made') problems.push(`job ${n}: the estimate was answered but is not there`);
      } else {
        counts.estimates += 1;
        if (estimate.submissionId !== job.submissionId) problems.push(`job ${n}: the estimate is for a record this run did not make`);
        else counts.submissions += 1;
        const rows = estimate.documents?.photoLog ?? [];
        const referenced = [...job.photos].filter(([, photo]) => photo.referenced);
        for (const [photoId, photo] of referenced) {
          const found = rows.filter((row) => row.id === photoId);
          if (found.length !== 1 || found[0]!.sha256 !== photo.sha256) problems.push(`job ${n}: a photo is in the record ${found.length} times`);
          else counts.photos += 1;
        }
        if (rows.length !== referenced.length) problems.push(`job ${n}: the record holds ${rows.length} photos, the draft referenced ${referenced.length}`);
      }
    }
    for (const [photoId, photo] of loose) {
      const answer = await call(job.session, 'read', 'check photo', `/api/jobs/${job.jobId}/photos/${photoId}`);
      if (answer.status === 200) counts.photos += 1;
      else if (photo.stored === 'made') problems.push(`job ${n}: a photo that was answered is not there (${answer.status})`);
    }
  }
  return { ...counts, officeDocuments: 0, problems };
}

// --- Judging -------------------------------------------------------------------------------------

export function judge(samples: readonly Sample[], records: Records, marks: PassMarks, owner: OwnerReadings, instanceLimit: number | null): Report {
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
  const connections = Number.isInteger(owner.connectionErrors) && owner.connectionErrors >= 0 ? owner.connectionErrors : null;
  const result = [
    under('reads, 95th percentile', stats.read.p95, marks.readsP95Ms),
    under('1 MB photo, 95th percentile', stats.photo.p95, marks.photoP95Ms),
    under('Finish, slowest', stats.finish.max, marks.finishMaxMs),
    { name: 'errors', passed: samples.length > 0 && errorRate < marks.errorRateBelow, detail: `${(errorRate * 100).toFixed(2)}% of ${samples.length} (under ${marks.errorRateBelow * 100}%)` },
    {
      name: 'no error from running out of database connections',
      passed: connections !== null && connections <= marks.databaseConnectionErrors,
      detail: connections === null ? 'no count from the database log' : `${connections} refused connections in the database log`,
    },
    {
      name: 'every created record present exactly once',
      passed: records.problems.length === 0 && records.jobs > 0,
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
    instances: { peak: owner.peakInstances, limit: instanceLimit },
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
  lines.push(`office users read documents ${report.records.officeDocuments} times`);
  for (const mark of report.marks) lines.push(`${mark.passed ? 'PASS' : 'FAIL'} ${mark.name}: ${mark.detail}`);
  lines.push(`Cloud Run instances: peak ${report.instances.peak} of a limit of ${report.instances.limit ?? 'unknown'} (not judged: this pass mark waits for the owner)`);
  for (const check of report.byHand) lines.push(`CHECK BY HAND ${check}`);
  lines.push(report.passed ? 'load test: the measured pass marks passed' : 'load test: a pass mark failed');
  return lines;
}

export async function readPassMarks(): Promise<PassMarks> {
  return JSON.parse(await readFile(new URL('../load/pass-marks.json', import.meta.url), 'utf8')) as PassMarks;
}

/** The Cloud Logging filter for the database's refused connections in the run's window. */
export function connectionLogFilter(projectId: string, window: { start: string; end: string }): string {
  return [
    'resource.type="cloudsql_database"',
    `logName="projects/${projectId}/logs/cloudsql.googleapis.com%2Fpostgres.log"`,
    `timestamp>="${window.start}"`,
    `timestamp<="${window.end}"`,
    '("too many clients" OR "remaining connection slots")',
  ].join(' AND ');
}

// --- Prompts -------------------------------------------------------------------------------------

/** Asks for a password or a code; what is typed goes to a stream that shows nothing. */
export async function ask(question: string, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<string> {
  const muted = new Writable({ write: (_chunk, _encoding, done) => done() });
  const rl = createInterface({ input, output: muted, terminal: true });
  output.write(question);
  try {
    return await rl.question('');
  } finally {
    rl.close();
    output.write('\n');
  }
}

async function askCount(question: string): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = (await rl.question(question)).trim();
      if (/^\d+$/.test(answer)) return Number(answer);
    }
  } finally {
    rl.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const marks = await readPassMarks();
  const report = await runLoadTest(options, marks, {
    password: async () => process.env.LOAD_TEST_PASSWORD || (await ask('Load users\' password: ')),
    totpCode: (number) => ask(`Authenticator code for office user ${number}: `),
    afterRun: async (window) => {
      console.log('In Logs Explorer for the test project, run this filter and count the lines it shows:');
      console.log(connectionLogFilter(options.projectId, window));
      const connectionErrors = await askCount('Refused database connections the filter shows: ');
      const peakInstances = await askCount('Peak instances on the web app\'s Cloud Run instance chart during the run: ');
      return { connectionErrors, peakInstances };
    },
    log: (line) => console.log(line),
  });
  for (const line of formatReport(report)) console.log(line);
  process.exit(report.passed ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'the load test failed');
    process.exit(1);
  });
}
