import { describe, expect, it, vi } from 'vitest';
import { parseArgs, runSmoke, signedOutProbes, type SmokeOptions } from '../../scripts/smoke-release';

const commit = '0123456789abcdef0123456789abcdef01234567';

type Answer = { status: number; body?: unknown } | Error;

// A fake server: health answers from a queue, every other path with one status.
function fakeFetch(health: Answer[], others: number) {
  const seen: string[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    seen.push(`${init?.method} ${path}`);
    const answer: Answer = path === '/api/health' ? (health.shift() ?? { status: 503 }) : { status: others };
    if (answer instanceof Error) throw answer;
    return Response.json(answer.body ?? {}, { status: answer.status });
  });
  return { fn: fn as unknown as typeof fetch, seen };
}

const options = (f: typeof fetch): SmokeOptions => ({
  baseUrl: 'https://candidate---dryscope-api-test-abc-uc.a.run.app',
  commit,
  env: 'test',
  fetch: f,
  attempts: 3,
  delayMs: 0,
});

const healthy = { status: 200, body: { status: 'ok', env: 'test', commit } };

describe('release smoke check', () => {
  it('passes a revision on the right commit that refuses signed-out callers', async () => {
    const { fn, seen } = fakeFetch([healthy], 401);
    expect(await runSmoke(options(fn))).toEqual([]);
    expect(seen).toEqual(['GET /api/health', ...signedOutProbes.map((p) => `${p.method} ${p.path}`)]);
  });

  it('accepts 403 as a refusal', async () => {
    const { fn } = fakeFetch([healthy], 403);
    expect(await runSmoke(options(fn))).toEqual([]);
  });

  it('retries health while a new revision warms up', async () => {
    const { fn } = fakeFetch([new TypeError('fetch failed'), { status: 503 }, healthy], 401);
    expect(await runSmoke(options(fn))).toEqual([]);
  });

  it('fails when health never answers', async () => {
    const { fn } = fakeFetch([{ status: 503 }, { status: 503 }, { status: 503 }], 401);
    expect(await runSmoke(options(fn))).toEqual(['health: status 503 after 3 tries']);
  });

  it('fails a revision running another commit', async () => {
    const other = 'f'.repeat(40);
    const { fn } = fakeFetch([{ status: 200, body: { status: 'ok', env: 'test', commit: other } }], 401);
    expect(await runSmoke(options(fn))).toEqual([`health: commit is ${other}, expected ${commit}`]);
  });

  it('fails a revision without a commit or in the wrong environment', async () => {
    const { fn } = fakeFetch([{ status: 200, body: { status: 'ok', env: 'live' } }], 401);
    expect(await runSmoke(options(fn))).toEqual([
      'health: env is live, expected test',
      `health: commit is undefined, expected ${commit}`,
    ]);
  });

  it.each([[200], [404], [500]])('fails when a signed-out business route answers %i', async (status) => {
    const { fn } = fakeFetch([healthy], status);
    const failures = await runSmoke(options(fn));
    expect(failures).toHaveLength(signedOutProbes.length);
    expect(failures[0]).toMatch(new RegExp(`: ${status}, expected 401 or 403$`));
  });

  it('does not follow redirects or send credentials', async () => {
    const { fn } = fakeFetch([healthy], 401);
    await runSmoke(options(fn));
    for (const [, init] of vi.mocked(fn).mock.calls) {
      expect(init?.redirect).toBe('manual');
      expect(init?.headers ?? {}).not.toHaveProperty('authorization');
    }
  });
});

describe('smoke arguments', () => {
  const args = (url: string, c = commit, env = 'test') => ['--url', url, '--commit', c, '--env', env];

  it('reads the tagged URL, commit and environment', () => {
    expect(parseArgs(args('https://candidate---x.a.run.app/'))).toEqual({
      baseUrl: 'https://candidate---x.a.run.app',
      commit,
      env: 'test',
    });
  });

  it('allows plain http only for a local container', () => {
    expect(parseArgs(args('http://127.0.0.1:8080')).baseUrl).toBe('http://127.0.0.1:8080');
    expect(() => parseArgs(args('http://candidate---x.a.run.app'))).toThrow(/https/);
  });

  it.each([
    [['--url', 'https://x.run.app', '--env', 'test']],
    [args('https://x.run.app', 'abc')],
    [args('https://x.run.app', commit, 'prod')],
    [args('https://x.run.app', commit, 'live')],
    [args('http://127.0.0.1:8080', commit, 'local')],
  ])('refuses %j', (argv) => {
    expect(() => parseArgs(argv)).toThrow();
  });
});
