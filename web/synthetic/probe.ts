// The synthetic monitor's probe (TC-10): signs in as the synthetic technician of test company A,
// asks /api/me who it is, and opens one fixed job. Pure `fetch`, no packages, so the web app's own
// tests run it (tests/unit/synthetic-probe.test.ts) and the function build (index.ts) reuses it.
//
// What may leave this file (hard rule 6): the step names below, the HTTP status code of each
// answer, and a fixed failure word. Never the email, the password, the API key, a token, a company
// or job id, a name, or any response body. A thrown failure carries only fixed text, because the
// Cloud Monitoring synthetics SDK copies an error's message and stack into the check result.

export const PROBE_LIMIT_MS = 30_000;

export const STEPS = ['sign_in', 'me', 'job'] as const;
export type Step = (typeof STEPS)[number];

// One closed list of reasons; each is fixed text that is safe to log.
export type FailureCode =
  | 'invalid_config'
  | 'timeout'
  | 'network_error'
  | 'refused'
  | 'bad_reply'
  | 'wrong_company'
  | 'job_not_found'
  | 'wrong_job';

export class ProbeFailure extends Error {
  readonly step: Step | 'config';
  readonly code: FailureCode;
  readonly status: number | null;
  constructor(step: Step | 'config', code: FailureCode, status: number | null = null, detail = '') {
    super(`synthetic probe failed at step ${step}: ${code}${status === null ? '' : ` (status ${status})`}${detail}`);
    this.name = 'ProbeFailure';
    this.step = step;
    this.code = code;
    this.status = status;
  }
}

export type ProbeConfig = {
  // The test app's origin and base address, for example https://dryscope-test-xyz.a.run.app.
  appUrl: string;
  // The Identity Platform web API key of the test app (not a secret, but it is never logged).
  apiKey: string;
  tenantId: string;
  email: string;
  password: string;
  // The company the synthetic technician belongs to, and the one fixed job it can open.
  companyId: string;
  jobId: string;
  // The job's fixed customer name.
  jobName: string;
  // Where the sign-in call goes. Absent means Identity Platform; a loopback address, with the
  // emulator's /identitytoolkit.googleapis.com path, means the Auth emulator (local runs only).
  authUrl?: string;
};

export type ProbeEvent = { step: Step; status: number | null; outcome: 'ok' | 'failed'; code?: FailureCode };

export type ProbeDeps = {
  fetch?: typeof fetch;
  // One line per step. The default writes JSON to stdout, where Cloud Run sends it to Cloud Logging.
  log?: (event: ProbeEvent) => void;
  limitMs?: number;
};

const IDENTITY_PLATFORM = 'https://identitytoolkit.googleapis.com';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_ID = /^[A-Za-z0-9-]{1,64}$/;
// A token goes into a header, so it must be plain token characters.
const TOKEN = /^[A-Za-z0-9._-]{1,8192}$/;

const ENV_NAMES = {
  appUrl: 'SYNTHETIC_APP_URL',
  apiKey: 'SYNTHETIC_API_KEY',
  tenantId: 'SYNTHETIC_TENANT_ID',
  email: 'SYNTHETIC_EMAIL',
  password: 'SYNTHETIC_PASSWORD',
  companyId: 'SYNTHETIC_COMPANY_ID',
  jobId: 'SYNTHETIC_JOB_ID',
  jobName: 'SYNTHETIC_JOB_NAME',
} as const;

function isLoopback(url: URL): boolean {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}

// A web address that is https, or http on this machine only. No path, query or credentials, so a
// key or token can never ride along in it.
function parseBase(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const local = isLoopback(url);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return url;
}

// The settings from the function's environment. A bad setting is named by its variable name only,
// never by its value.
export function readProbeConfig(env: Record<string, string | undefined>): ProbeConfig {
  const bad: string[] = [];
  const read = (key: keyof typeof ENV_NAMES): string => {
    const value = env[ENV_NAMES[key]]?.trim() ?? '';
    if (!value) bad.push(ENV_NAMES[key]);
    return value;
  };
  const appUrl = read('appUrl');
  const apiKey = read('apiKey');
  const tenantId = read('tenantId');
  const email = read('email');
  const password = read('password');
  const companyId = read('companyId');
  const jobId = read('jobId');
  const jobName = env[ENV_NAMES.jobName] ?? '';
  if (!jobName.trim()) bad.push(ENV_NAMES.jobName);

  const base = appUrl ? parseBase(appUrl) : null;
  if (appUrl && !base) bad.push(ENV_NAMES.appUrl);
  if (tenantId && !TENANT_ID.test(tenantId)) bad.push(ENV_NAMES.tenantId);
  if (companyId && !UUID.test(companyId)) bad.push(ENV_NAMES.companyId);
  if (jobId && !UUID.test(jobId)) bad.push(ENV_NAMES.jobId);
  if (apiKey && !/^[A-Za-z0-9_-]{1,128}$/.test(apiKey)) bad.push(ENV_NAMES.apiKey);

  const authUrl = env.SYNTHETIC_AUTH_URL?.trim() || undefined;
  if (authUrl) {
    // The emulator override is for a developer machine: it must be on loopback.
    const parsed = parseBase(authUrl);
    if (!parsed || !isLoopback(parsed)) bad.push('SYNTHETIC_AUTH_URL');
  }

  if (bad.length > 0 || !base) {
    throw new ProbeFailure('config', 'invalid_config', null, `: ${[...new Set(bad)].join(', ')}`);
  }
  return {
    appUrl: base.origin,
    apiKey,
    tenantId,
    email,
    password,
    companyId: companyId.toLowerCase(),
    jobId: jobId.toLowerCase(),
    jobName,
    ...(authUrl ? { authUrl: authUrl.replace(/\/+$/, '') } : {}),
  };
}

function logToStdout(event: ProbeEvent): void {
  console.log(
    JSON.stringify({
      severity: event.outcome === 'ok' ? 'INFO' : 'ERROR',
      component: 'synthetic-probe',
      event: 'step',
      ...event,
    }),
  );
}

// The one clock for the whole probe: every call and every body read shares it.
function startClock(limitMs: number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('limit'));
    }, limitMs);
  });
  // Nobody may be waiting on it when it fires; that must not be an unhandled rejection.
  expired.catch(() => undefined);
  return {
    signal: controller.signal,
    expired,
    stop: () => clearTimeout(timer),
  };
}

type Reply = { status: number; body: unknown };

// A JSON object, or null for anything else.
function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export async function runProbe(config: ProbeConfig, deps: ProbeDeps = {}): Promise<{ steps: ProbeEvent[] }> {
  const doFetch = deps.fetch ?? fetch;
  const log = deps.log ?? logToStdout;
  const clock = startClock(deps.limitMs ?? PROBE_LIMIT_MS);
  const steps: ProbeEvent[] = [];

  const fail = (step: Step, code: FailureCode, status: number | null = null): never => {
    const event: ProbeEvent = { step, status, outcome: 'failed', code };
    steps.push(event);
    log(event);
    throw new ProbeFailure(step, code, status);
  };
  const pass = (step: Step, status: number): void => {
    const event: ProbeEvent = { step, status, outcome: 'ok' };
    steps.push(event);
    log(event);
  };

  // One call and the read of its body, both inside the probe's time limit. Whatever goes wrong,
  // the caller sees a fixed reason: the original error can quote a host name or a body.
  async function call(step: Step, url: string, init: RequestInit): Promise<Reply> {
    const work = (async (): Promise<Reply> => {
      // A redirect is never followed: the token must go only where the settings point.
      const response = await doFetch(url, { ...init, signal: clock.signal, redirect: 'error' });
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      return { status: response.status, body };
    })();
    // If the limit wins the race, `work` may still reject later (its request is aborted); that
    // rejection is expected and must not be reported.
    work.catch(() => undefined);
    try {
      return await Promise.race([work, clock.expired]);
    } catch {
      return fail(step, clock.signal.aborted ? 'timeout' : 'network_error');
    }
  }

  try {
    // 1. Sign in through Identity Platform's REST API, as a browser of the test app would: the
    // app's origin goes with the request (the web API key is limited to the app's own address).
    const authBase = config.authUrl ?? IDENTITY_PLATFORM;
    const signIn = await call('sign_in', `${authBase}/v1/accounts:signInWithPassword?key=${encodeURIComponent(config.apiKey)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: config.appUrl,
        Referer: `${config.appUrl}/`,
      },
      body: JSON.stringify({
        email: config.email,
        password: config.password,
        tenantId: config.tenantId,
        returnSecureToken: true,
      }),
    });
    if (signIn.status !== 200) fail('sign_in', 'refused', signIn.status);
    const idToken = asObject(signIn.body)?.idToken;
    if (typeof idToken !== 'string' || !TOKEN.test(idToken)) fail('sign_in', 'bad_reply', signIn.status);
    pass('sign_in', signIn.status);

    const authorized: RequestInit = {
      method: 'GET',
      headers: { Authorization: `Bearer ${idToken as string}`, Accept: 'application/json' },
    };

    // 2. The app must know the token's owner as a member of the synthetic company.
    const me = await call('me', `${config.appUrl}/api/me`, authorized);
    // A removed membership, a turned-off company and a wrong tenant all answer 401 or 403.
    if (me.status !== 200) fail('me', 'refused', me.status);
    const company = asObject(asObject(me.body)?.company);
    if (typeof company?.id !== 'string') fail('me', 'bad_reply', me.status);
    if (String(company?.id).toLowerCase() !== config.companyId) fail('me', 'wrong_company', me.status);
    pass('me', me.status);

    // 3. The fixed job opens, with its fixed customer name.
    const jobResponse = await call('job', `${config.appUrl}/api/jobs/${config.jobId}`, authorized);
    if (jobResponse.status === 404) fail('job', 'job_not_found', 404);
    if (jobResponse.status !== 200) fail('job', 'refused', jobResponse.status);
    const detail = asObject(jobResponse.body);
    const job = asObject(detail?.job);
    const customer = asObject(detail?.customer);
    if (typeof job?.id !== 'string' || typeof customer?.name !== 'string') fail('job', 'bad_reply', jobResponse.status);
    if (String(job?.id).toLowerCase() !== config.jobId || customer?.name !== config.jobName) {
      fail('job', 'wrong_job', jobResponse.status);
    }
    pass('job', jobResponse.status);
  } finally {
    clock.stop();
  }
  return { steps };
}
