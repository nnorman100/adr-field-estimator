import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROBE_LIMIT_MS,
  ProbeFailure,
  readProbeConfig,
  runProbe,
  type ProbeConfig,
  type ProbeEvent,
} from '../../synthetic/probe';

// The synthetic monitor's probe (TC-10) with `fetch` stubbed. Every failure must name its step and
// carry no email, password, key or token, in the thrown error or in a log line.

const EMAIL = 'synthetic.technician@example.test';
const PASSWORD = 'correct-horse-battery-staple-9';
const API_KEY = 'AIzaSyFakeKeyForTests_000000000000000000';
const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJl';
const COMPANY = '11111111-1111-4111-8111-111111111111';
const JOB = '22222222-2222-4222-8222-222222222222';
const JOB_NAME = 'Synthetic Homeowner';
const APP = 'https://dryscope-test.example.test';

const config: ProbeConfig = {
  appUrl: APP,
  apiKey: API_KEY,
  tenantId: 'tenant-a-abc12',
  email: EMAIL,
  password: PASSWORD,
  companyId: COMPANY,
  jobId: JOB,
  jobName: JOB_NAME,
};
const SECRETS = [EMAIL, PASSWORD, API_KEY, TOKEN, COMPANY, JOB, JOB_NAME];

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const signedIn = () => json(200, { idToken: TOKEN, refreshToken: 'refresh-token-value', localId: 'u1', email: EMAIL });
const meOk = () => json(200, { company: { id: COMPANY, name: 'Test Co' }, role: 'estimator', capabilities: [] });
const jobOk = () => json(200, { job: { id: JOB, status: 'draft' }, customer: { name: JOB_NAME }, claim: {} });

type Call = { url: string; init: RequestInit };
function stub(replies: Array<() => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fetchStub = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = replies[calls.length - 1];
    if (!next) throw new Error('unexpected extra request');
    return next();
  });
  return { calls, fetch: fetchStub as unknown as typeof fetch };
}

async function failureOf(promise: Promise<unknown>): Promise<ProbeFailure> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ProbeFailure);
    return error as ProbeFailure;
  }
  throw new Error('the probe did not fail');
}

function expectNoSecrets(text: string) {
  for (const secret of SECRETS) expect(text).not.toContain(secret);
  expect(text).not.toMatch(/Bearer/i);
  expect(text).not.toMatch(/eyJ/);
}

describe('runProbe', () => {
  it('signs in with the tenant and the app origin, reads /api/me, opens the fixed job', async () => {
    const { calls, fetch } = stub([signedIn, meOk, jobOk]);
    const events: ProbeEvent[] = [];
    await runProbe(config, { fetch, log: (e) => events.push(e) });

    expect(calls).toHaveLength(3);
    const [signIn, me, job] = calls as [Call, Call, Call];
    expect(signIn.url).toBe(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`);
    expect(signIn.init.method).toBe('POST');
    const headers = signIn.init.headers as Record<string, string>;
    expect(headers.Origin).toBe(APP);
    expect(headers.Referer).toBe(`${APP}/`);
    expect(JSON.parse(String(signIn.init.body))).toEqual({
      email: EMAIL,
      password: PASSWORD,
      tenantId: 'tenant-a-abc12',
      returnSecureToken: true,
    });
    expect(me.url).toBe(`${APP}/api/me`);
    expect(job.url).toBe(`${APP}/api/jobs/${JOB}`);
    for (const call of [me, job]) {
      expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
      // Never follow a redirect with the token.
      expect(call.init.redirect).toBe('error');
    }
    expect(events).toEqual([
      { step: 'sign_in', status: 200 },
      { step: 'me', status: 200 },
      { step: 'job', status: 200 },
    ]);
    expectNoSecrets(JSON.stringify(events));
  });

  it('writes only severity, step and status to the default log', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => void lines.push(String(line)));
    try {
      await runProbe(config, { fetch: stub([signedIn, meOk, jobOk]).fetch });
    } finally {
      spy.mockRestore();
    }
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      { severity: 'INFO', step: 'sign_in', status: 200 },
      { severity: 'INFO', step: 'me', status: 200 },
      { severity: 'INFO', step: 'job', status: 200 },
    ]);
    for (const line of lines) expectNoSecrets(line);
  });

  it('adds only an ERROR severity and the fixed failure code to the default log on failure', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => void lines.push(String(line)));
    try {
      await failureOf(runProbe(config, { fetch: stub([signedIn, () => json(403, { error: `forbidden ${EMAIL}` })]).fetch }));
    } finally {
      spy.mockRestore();
    }
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      { severity: 'INFO', step: 'sign_in', status: 200 },
      { severity: 'ERROR', step: 'me', status: 403, code: 'refused' },
    ]);
    for (const line of lines) expectNoSecrets(line);
  });

  it('wrong password: names the sign-in step and its status, and leaks nothing', async () => {
    const { fetch, calls } = stub([() => json(400, { error: { code: 400, message: `INVALID_PASSWORD ${EMAIL}` } })]);
    const events: ProbeEvent[] = [];
    const failure = await failureOf(runProbe(config, { fetch, log: (e) => events.push(e) }));
    expect(failure).toMatchObject({ step: 'sign_in', code: 'refused', status: 400 });
    expect(failure.message).toBe('synthetic probe failed at step sign_in: refused (status 400)');
    expect(calls).toHaveLength(1);
    expect(events).toEqual([{ step: 'sign_in', status: 400, code: 'refused' }]);
    expectNoSecrets(failure.message + (failure.stack ?? '') + JSON.stringify(events));
  });

  it('a sign-in answer with no token is a bad reply, not a pass', async () => {
    for (const body of [{}, { idToken: '' }, { idToken: 'has space.in.it' }, { idToken: 42 }, 'text']) {
      const { fetch } = stub([() => json(200, body)]);
      const failure = await failureOf(runProbe(config, { fetch, log: () => undefined }));
      expect(failure).toMatchObject({ step: 'sign_in', code: 'bad_reply', status: 200 });
    }
  });

  it('membership removed: /api/me refuses and the probe names the me step', async () => {
    for (const status of [401, 403]) {
      const { fetch, calls } = stub([signedIn, () => json(status, { error: 'unknown_tenant' })]);
      const events: ProbeEvent[] = [];
      const failure = await failureOf(runProbe(config, { fetch, log: (e) => events.push(e) }));
      expect(failure).toMatchObject({ step: 'me', code: 'refused', status });
      expect(calls).toHaveLength(2);
      expect(events.map((e) => e.step)).toEqual(['sign_in', 'me']);
      expectNoSecrets(failure.message + (failure.stack ?? '') + JSON.stringify(events));
    }
  });

  it('/api/me for another company fails the me step', async () => {
    const other = () => json(200, { company: { id: '99999999-9999-4999-8999-999999999999', name: 'Other' } });
    const failure = await failureOf(runProbe(config, { fetch: stub([signedIn, other]).fetch, log: () => undefined }));
    expect(failure).toMatchObject({ step: 'me', code: 'wrong_company', status: 200 });
    expectNoSecrets(failure.message);
  });

  it('/api/me with no company is a bad reply', async () => {
    const failure = await failureOf(runProbe(config, { fetch: stub([signedIn, () => json(200, {})]).fetch, log: () => undefined }));
    expect(failure).toMatchObject({ step: 'me', code: 'bad_reply' });
  });

  it('job 404: names the job step', async () => {
    const { fetch } = stub([signedIn, meOk, () => json(404, { error: 'not_found' })]);
    const events: ProbeEvent[] = [];
    const failure = await failureOf(runProbe(config, { fetch, log: (e) => events.push(e) }));
    expect(failure).toMatchObject({ step: 'job', code: 'job_not_found', status: 404 });
    expect(failure.message).toBe('synthetic probe failed at step job: job_not_found (status 404)');
    expectNoSecrets(failure.message + JSON.stringify(events));
  });

  it('other job statuses are refused, a different name or id is the wrong job', async () => {
    const refused = await failureOf(
      runProbe(config, { fetch: stub([signedIn, meOk, () => json(503, { error: 'jobs_unavailable' })]).fetch, log: () => undefined }),
    );
    expect(refused).toMatchObject({ step: 'job', code: 'refused', status: 503 });

    const renamed = () => json(200, { job: { id: JOB }, customer: { name: 'Someone Else' } });
    const otherJob = () => json(200, { job: { id: '33333333-3333-4333-8333-333333333333' }, customer: { name: JOB_NAME } });
    for (const reply of [renamed, otherJob]) {
      const failure = await failureOf(runProbe(config, { fetch: stub([signedIn, meOk, reply]).fetch, log: () => undefined }));
      expect(failure).toMatchObject({ step: 'job', code: 'wrong_job', status: 200 });
      expectNoSecrets(failure.message);
    }
    const shapeless = await failureOf(
      runProbe(config, { fetch: stub([signedIn, meOk, () => json(200, { job: {} })]).fetch, log: () => undefined }),
    );
    expect(shapeless).toMatchObject({ step: 'job', code: 'bad_reply' });
  });

  it('a network error is named by step only: its own text can quote the address or key', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError(`fetch failed for https://identitytoolkit.googleapis.com/?key=${API_KEY} as ${EMAIL}`);
    }) as unknown as typeof globalThis.fetch;
    const failure = await failureOf(runProbe(config, { fetch, log: () => undefined }));
    expect(failure).toMatchObject({ step: 'sign_in', code: 'network_error', status: null });
    expect(failure.message).toBe('synthetic probe failed at step sign_in: network_error');
    expectNoSecrets(failure.message + (failure.stack ?? ''));
  });

  it('a body that is not JSON is a bad reply, not a crash', async () => {
    const { fetch } = stub([() => new Response('<html>nope</html>', { status: 200 })]);
    const failure = await failureOf(runProbe(config, { fetch, log: () => undefined }));
    expect(failure).toMatchObject({ step: 'sign_in', code: 'bad_reply' });
  });

  describe('time limit', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    const after = (ms: number, make: () => Response) => () => new Promise<Response>((resolve) => setTimeout(() => resolve(make()), ms));

    it('has a 30 second limit', () => {
      expect(PROBE_LIMIT_MS).toBe(30_000);
    });

    it('slow but within the limit still passes', async () => {
      const { fetch } = stub([after(9_000, signedIn), after(9_000, meOk), after(9_000, jobOk)]);
      const events: ProbeEvent[] = [];
      const running = runProbe(config, { fetch, log: (e) => events.push(e) });
      await vi.advanceTimersByTimeAsync(27_000);
      await running;
      expect(events).toEqual([
        { step: 'sign_in', status: 200 },
        { step: 'me', status: 200 },
        { step: 'job', status: 200 },
      ]);
    });

    it('slow answers that add up past the limit fail at the step then running', async () => {
      const { fetch } = stub([after(11_000, signedIn), after(11_000, meOk), after(11_000, jobOk)]);
      const events: ProbeEvent[] = [];
      const running = failureOf(runProbe(config, { fetch, log: (e) => events.push(e) }));
      await vi.advanceTimersByTimeAsync(30_000);
      const failure = await running;
      expect(failure).toMatchObject({ step: 'job', code: 'timeout', status: null });
      expect(events).toEqual([
        { step: 'sign_in', status: 200 },
        { step: 'me', status: 200 },
        { step: 'job', status: null, code: 'timeout' },
      ]);
      expectNoSecrets(failure.message + JSON.stringify(events));
    });

    it('a call that never answers times out at 30 seconds, even when fetch ignores the abort', async () => {
      const fetch = vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof globalThis.fetch;
      const running = failureOf(runProbe(config, { fetch, log: () => undefined }));
      await vi.advanceTimersByTimeAsync(29_999);
      let settled = false;
      void running.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await running).toMatchObject({ step: 'sign_in', code: 'timeout' });
    });

    it('a body that stalls after the headers times out too', async () => {
      const stalled = () =>
        ({ status: 200, json: () => new Promise(() => undefined) }) as unknown as Response;
      const running = failureOf(runProbe(config, { fetch: stub([signedIn, stalled]).fetch, log: () => undefined }));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await running).toMatchObject({ step: 'me', code: 'timeout' });
    });

    it('stops its clock when it finishes: nothing is left running', async () => {
      await runProbe(config, { fetch: stub([signedIn, meOk, jobOk]).fetch, log: () => undefined });
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('points sign-in at the Auth emulator when asked', async () => {
    const { calls, fetch } = stub([signedIn, meOk, jobOk]);
    await runProbe({ ...config, authUrl: 'http://127.0.0.1:9099/identitytoolkit.googleapis.com' }, { fetch, log: () => undefined });
    expect(calls[0]?.url).toBe(`http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`);
  });
});

describe('readProbeConfig', () => {
  const env = {
    SYNTHETIC_APP_URL: `${APP}/`,
    SYNTHETIC_API_KEY: API_KEY,
    SYNTHETIC_TENANT_ID: 'tenant-a-abc12',
    SYNTHETIC_EMAIL: EMAIL,
    SYNTHETIC_PASSWORD: `${PASSWORD}\n`,
    SYNTHETIC_COMPANY_ID: COMPANY.toUpperCase(),
    SYNTHETIC_JOB_ID: JOB,
    SYNTHETIC_JOB_NAME: JOB_NAME,
  };

  it('reads the settings from the environment', () => {
    expect(readProbeConfig(env)).toEqual({ ...config, appUrl: APP });
  });

  it('keeps the password exactly, dropping only one trailing newline', () => {
    const passwordFrom = (value: string) => readProbeConfig({ ...env, SYNTHETIC_PASSWORD: value }).password;
    expect(passwordFrom(`${PASSWORD}\r\n`)).toBe(PASSWORD);
    expect(passwordFrom(PASSWORD)).toBe(PASSWORD);
    expect(passwordFrom(`  ${PASSWORD}  `)).toBe(`  ${PASSWORD}  `);
    expect(passwordFrom(`\t${PASSWORD} \n`)).toBe(`\t${PASSWORD} `);
    expect(passwordFrom(`${PASSWORD}\n\n`)).toBe(`${PASSWORD}\n`);
    expect(() => readProbeConfig({ ...env, SYNTHETIC_PASSWORD: '\n' })).toThrow(/SYNTHETIC_PASSWORD/);
  });

  it('names a missing or malformed setting by variable name, never by value', () => {
    const bad = { ...env, SYNTHETIC_PASSWORD: undefined, SYNTHETIC_JOB_ID: 'not-a-uuid', SYNTHETIC_EMAIL: '' };
    let failure: ProbeFailure | undefined;
    try {
      readProbeConfig(bad);
    } catch (error) {
      failure = error as ProbeFailure;
    }
    expect(failure).toBeInstanceOf(ProbeFailure);
    expect(failure).toMatchObject({ step: 'config', code: 'invalid_config' });
    expect(failure?.message).toBe(
      'synthetic probe failed at step config: invalid_config: SYNTHETIC_EMAIL, SYNTHETIC_PASSWORD, SYNTHETIC_JOB_ID',
    );
    expectNoSecrets(failure?.message ?? '');
  });

  it('refuses an app address that is not https, or that carries a key or a path', () => {
    for (const url of ['http://dryscope-test.example.test', `${APP}/?key=${API_KEY}`, 'https://user:pass@example.test', 'nonsense']) {
      expect(() => readProbeConfig({ ...env, SYNTHETIC_APP_URL: url })).toThrow(/SYNTHETIC_APP_URL/);
    }
    expect(readProbeConfig({ ...env, SYNTHETIC_APP_URL: 'http://localhost:3100' }).appUrl).toBe('http://localhost:3100');
  });

  it('accepts the Auth emulator override on loopback only', () => {
    const emulator = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com';
    expect(readProbeConfig({ ...env, SYNTHETIC_AUTH_URL: `${emulator}/` }).authUrl).toBe(emulator);
    for (const url of ['https://identitytoolkit.googleapis.com', 'http://example.test:9099', 'nonsense']) {
      expect(() => readProbeConfig({ ...env, SYNTHETIC_AUTH_URL: url })).toThrow(/SYNTHETIC_AUTH_URL/);
    }
  });
});
