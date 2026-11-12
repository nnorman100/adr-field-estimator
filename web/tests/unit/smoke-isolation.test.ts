import { describe, expect, it, vi } from 'vitest';
import { parseIsolationArgs, probes, runIsolationSmoke, type IsolationOptions } from '../../scripts/smoke-isolation';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TOKEN_A = 'token-for-company-a';
const TOKEN_B = 'token-for-company-b';

type Answer = { status: number; body?: unknown } | Error;

// A fake service. Health answers `health`; /api/me answers the company the token belongs to; every
// other path answers `others`.
function fakeService(options: { health?: Answer; others?: Answer | ((path: string, token: string) => Answer) } = {}) {
  const seen: { method: string; path: string; token: string }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? '';
    const token = auth.replace('Bearer ', '');
    seen.push({ method: init?.method ?? 'GET', path, token });
    let answer: Answer;
    if (path === '/api/health') answer = options.health ?? { status: 200, body: { status: 'ok', env: 'test' } };
    else if (path === '/api/me') answer = { status: 200, body: { company: { id: token === TOKEN_A ? A : B } } };
    else if (typeof options.others === 'function') answer = options.others(path, token);
    else answer = options.others ?? { status: 403, body: { error: 'not_found' } };
    if (answer instanceof Error) throw answer;
    return Response.json(answer.body ?? {}, { status: answer.status });
  });
  return { fn: fn as unknown as typeof fetch, seen };
}

const options = (f: typeof fetch): IsolationOptions => ({
  baseUrl: 'https://dryscope-api-test.example.test',
  companyA: A,
  companyB: B,
  tokenA: TOKEN_A,
  tokenB: TOKEN_B,
  fetch: f,
});

describe('A cannot read B smoke check', () => {
  it('passes when every probe with the other company’s ids is refused, in both directions', async () => {
    const { fn, seen } = fakeService();
    expect(await runIsolationSmoke(options(fn))).toEqual([]);
    // Health once, then for each company: its own sign-in and every probe.
    expect(seen).toHaveLength(1 + 2 * (1 + probes.length));
    expect(seen.filter((call) => call.path === `/api/companies/${B}/team`).map((call) => call.token)).toEqual([TOKEN_A]);
    expect(seen.filter((call) => call.path === `/api/companies/${A}/team`).map((call) => call.token)).toEqual([TOKEN_B]);
  });

  it('only reads, and never sends a sign-in to health', async () => {
    const { fn, seen } = fakeService();
    await runIsolationSmoke(options(fn));
    expect(new Set(seen.map((call) => call.method))).toEqual(new Set(['GET']));
    expect(seen[0]).toMatchObject({ path: '/api/health', token: '' });
  });

  it.each([[401], [403], [404]])('accepts %i as a refusal', async (status) => {
    const { fn } = fakeService({ others: { status } });
    expect(await runIsolationSmoke(options(fn))).toEqual([]);
  });

  it.each([[200], [500], [503]])('fails a probe the service answers with %i', async (status) => {
    const { fn } = fakeService({ others: { status } });
    const failures = await runIsolationSmoke(options(fn));
    expect(failures).toHaveLength(2 * probes.length);
    expect(failures[0]).toBe(`A ${probes[0]!.label}: ${status}, expected 401, 403 or 404`);
  });

  it('fails a refusal whose answer names the other company', async () => {
    const { fn } = fakeService({ others: (path, token) => ({ status: 404, body: { error: token === TOKEN_A ? B : A } }) });
    const failures = await runIsolationSmoke(options(fn));
    expect(failures).toContain(`A ${probes[0]!.label}: the answer names the other company`);
    expect(failures).toContain(`B ${probes[0]!.label}: the answer names the other company`);
  });

  it('fails a sign-in that does not work or belongs to the other company, so a refusal is never a dead token', async () => {
    const wrong = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path === '/api/health') return Response.json({ env: 'test' });
      if (path === '/api/me') return Response.json({ company: { id: B } });
      return Response.json({}, { status: 403 });
    }) as unknown as typeof fetch;
    expect(await runIsolationSmoke(options(wrong))).toEqual(['A /api/me: names another company']);
    const refusedEverywhere = vi.fn(async (url: string | URL | Request) =>
      new URL(String(url)).pathname === '/api/health' ? Response.json({ env: 'test' }) : Response.json({}, { status: 401 }),
    ) as unknown as typeof fetch;
    expect(await runIsolationSmoke(options(refusedEverywhere))).toEqual([
      'A /api/me: 401, expected 200 for its own sign-in',
      'B /api/me: 401, expected 200 for its own sign-in',
    ]);
  });

  it.each([
    [{ status: 200, body: { status: 'ok', env: 'live' } } as Answer, /did not report the test environment/],
    [{ status: 200, body: { status: 'ok' } } as Answer, /did not report the test environment/],
    [{ status: 503 } as Answer, /did not report the test environment \(status 503\)/],
    [new TypeError('fetch failed') as Answer, /health: TypeError; no sign-in was sent/],
  ])('sends no sign-in to a service that does not say it is test (%#)', async (health, message) => {
    const { fn, seen } = fakeService({ health });
    const failures = await runIsolationSmoke(options(fn));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(message);
    expect(seen.map((call) => call.path)).toEqual(['/api/health']);
  });

  it('prints and fails with routes and codes, never a token or a company id', async () => {
    const { fn } = fakeService({ others: { status: 200, body: { leaked: B } } });
    const lines: string[] = [];
    const failures = await runIsolationSmoke(options(fn), (line) => lines.push(line));
    for (const text of [...lines, ...failures]) {
      for (const secret of [TOKEN_A, TOKEN_B, A, B]) expect(text).not.toContain(secret);
    }
  });
});

describe('isolation smoke arguments', () => {
  const env = { ISOLATION_TOKEN_A: TOKEN_A, ISOLATION_TOKEN_B: TOKEN_B };
  const args = (url = 'https://x.run.app/', a = A, b = B) => ['--url', url, '--company-a', a, '--company-b', b];

  it('reads the URL and the two companies, and the tokens from the environment only', () => {
    expect(parseIsolationArgs(args(), env)).toEqual({ baseUrl: 'https://x.run.app', companyA: A, companyB: B, tokenA: TOKEN_A, tokenB: TOKEN_B });
  });

  it.each([
    [args('http://x.run.app'), env],
    [args('https://x.run.app', 'not-an-id'), env],
    [args('https://x.run.app', A, A), env],
    [['--url', 'https://x.run.app', '--company-a', A], env],
    [args(), { ISOLATION_TOKEN_A: TOKEN_A }],
    [args(), {}],
  ])('refuses %j', (argv, settings) => {
    expect(() => parseIsolationArgs(argv, settings)).toThrow();
  });
});
