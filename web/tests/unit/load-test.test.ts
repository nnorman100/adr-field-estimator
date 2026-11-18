import { describe, expect, it } from 'vitest';
import { manifestDigest } from '@/lib/field/canonical';
import { checkTarget, draftDigest, freshPhoto, judge, loadCompany, parseArgs, percentile, readPassMarks, statsOf, type Manifest } from '../../scripts/load-test';

// The load test kit (S8-7): its percentile arithmetic, its guards and its judging. The run itself
// is exercised against the browser suite's local server (tests/e2e/load-test.spec.ts).

// A fetch that answers from a table of paths and records every address it was asked for.
function fakeFetch(answers: Record<string, { status: number; body: unknown }>) {
  const asked: string[] = [];
  const doFetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    asked.push(url.toString());
    const answer = answers[url.pathname] ?? { status: 404, body: { error: 'not_found' } };
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as typeof fetch;
  return { doFetch, asked };
}

describe('percentiles', () => {
  it('takes the nearest rank', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile(values, 99)).toBe(99);
    expect(percentile(values, 100)).toBe(100);
    expect(percentile(values, 0)).toBe(1);
  });

  it('sorts the samples first and rounds the rank up', () => {
    expect(percentile([30, 10, 20], 50)).toBe(20);
    expect(percentile([5, 1, 4, 2, 3], 95)).toBe(5);
    expect(percentile([5, 1, 4, 2, 3], 20)).toBe(1);
    expect(percentile([5, 1, 4, 2, 3], 21)).toBe(2);
    expect(percentile([7], 95)).toBe(7);
  });

  it('has no value without samples and refuses a percentile outside 0 to 100', () => {
    expect(percentile([], 95)).toBeNull();
    expect(() => percentile([1], 101)).toThrow();
    expect(() => percentile([1], Number.NaN)).toThrow();
    expect(statsOf([])).toEqual({ count: 0, p50: null, p95: null, p99: null, max: null });
    expect(statsOf([3, 1, 2])).toEqual({ count: 3, p50: 2, p95: 3, p99: 3, max: 3 });
  });
});

describe('the target guard', () => {
  it('accepts the test address when the service says test', async () => {
    const { doFetch } = fakeFetch({ '/api/health': { status: 200, body: { status: 'ok', env: 'test' } } });
    await expect(checkTarget('https://test.example.com/', doFetch)).resolves.toBe('test');
  });

  it('refuses a live host, by its name or by what it says, before anything is sent', async () => {
    const live = fakeFetch({ '/api/health': { status: 200, body: { status: 'ok', env: 'live' } } });
    await expect(checkTarget('https://app.example.com/', live.doFetch)).rejects.toThrow(/refused/);
    await expect(checkTarget('https://example.com/', live.doFetch)).rejects.toThrow(/refused/);
    expect(live.asked).toEqual([]);
    await expect(checkTarget('https://test.example.com/', live.doFetch)).rejects.toThrow(/refused/);
    expect(live.asked).toEqual(['https://test.example.com/api/health']);
  });

  it('refuses plain http away from this machine, and a local server that is not the local environment', async () => {
    const local = fakeFetch({ '/api/health': { status: 200, body: { env: 'local' } } });
    await expect(checkTarget('http://test.example.com/', local.doFetch)).rejects.toThrow(/refused/);
    await expect(checkTarget('http://localhost:3100/', local.doFetch)).resolves.toBe('local');
    const testOnLoopback = fakeFetch({ '/api/health': { status: 200, body: { env: 'test' } } });
    await expect(checkTarget('http://localhost:3100/', testOnLoopback.doFetch)).rejects.toThrow(/refused/);
    await expect(checkTarget('https://test.example.com/api', local.doFetch)).rejects.toThrow(/site root/);
  });

  it('refuses a company whose name does not start with load-', async () => {
    const real = fakeFetch({ '/api/sign-in/acme': { status: 200, body: { company: { name: 'Acme Restoration' }, tenantId: 't-1' } } });
    await expect(loadCompany('https://test.example.com/', 'acme', real.doFetch)).rejects.toThrow(/load-/);
    const load = fakeFetch({ '/api/sign-in/load-one': { status: 200, body: { company: { name: 'load-one' }, tenantId: 't-2' } } });
    await expect(loadCompany('https://test.example.com/', 'load-one', load.doFetch)).resolves.toEqual({ tenantId: 't-2', name: 'load-one' });
  });
});

describe('the arguments', () => {
  const base = ['--url', 'https://test.example.com', '--company', 'load-one', '--api-key', 'k', '--project', 'p', '--database', 'd', '--technicians', 'a@example.com,b@example.com', '--office', 'c@example.com'];

  it('reads the load users and the run length', () => {
    const options = parseArgs([...base, '--minutes', '20']);
    expect(options.users).toEqual([
      { email: 'a@example.com', role: 'estimator' },
      { email: 'b@example.com', role: 'estimator' },
      { email: 'c@example.com', role: 'office' },
    ]);
    expect(options.durationMs).toBe(20 * 60_000);
    expect(options.photoBytes).toBe(1024 * 1024);
  });

  it('never takes the password from an argument', () => {
    expect(() => parseArgs([...base, '--password', 'secret'])).toThrow(/never from an argument/);
    expect(() => parseArgs([...base, '--pass', 'secret'])).toThrow(/never from an argument/);
  });
});

describe('the field draft and the photos', () => {
  it('hashes the draft exactly as Finish and review does', async () => {
    const manifest: Manifest = {
      draft: { summary: 'Water in one room.', scopeConfirmed: true, roomOrder: ['room-1'], yearBuilt: 1990 },
      rooms: [{ id: 'room-1', field: { wetFloorSf: 80, name: 'Room 1', category: 2, floorSf: 120 } }],
      photos: [
        { id: 'f0000000-0000-4000-8000-000000000000', field: { roomId: 'room-1' } },
        { id: '10000000-0000-4000-8000-000000000000', field: { roomId: 'room-1' } },
      ],
    };
    expect(draftDigest(manifest)).toBe(await manifestDigest(manifest));
  });

  it('makes every photo a new JPEG file of the size asked', () => {
    const one = freshPhoto(1024 * 1024);
    const two = freshPhoto(1024 * 1024);
    expect(one.byteLength).toBe(1024 * 1024);
    expect([...one.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect(Buffer.from(one).equals(Buffer.from(two))).toBe(false);
  });
});

describe('judging the run against the pass marks', () => {
  const records = { jobs: 2, submissions: 2, estimates: 2, photos: 20, problems: [] };
  const sample = (category: 'read' | 'photo' | 'finish', ms: number, error: string | null = null) => ({ category, label: category, ms, status: error ? 503 : 200, error });
  const quick = [...Array.from({ length: 40 }, () => sample('read', 100)), ...Array.from({ length: 20 }, () => sample('photo', 800)), sample('finish', 900), sample('finish', 1200)];

  it('passes a run inside every mark', async () => {
    const report = judge(quick, records, await readPassMarks());
    expect(report.marks.map((mark) => [mark.name, mark.passed])).toEqual([
      ['reads, 95th percentile', true],
      ['1 MB photo, 95th percentile', true],
      ['Finish, slowest', true],
      ['errors', true],
      ['every created record present exactly once', true],
    ]);
    expect(report.passed).toBe(true);
  });

  it('fails slow reads, a slow Finish, too many errors and a record seen twice', async () => {
    const marks = await readPassMarks();
    const slowReads = [...quick.filter((s) => s.category !== 'read'), ...Array.from({ length: 40 }, () => sample('read', 2500))];
    expect(judge(slowReads, records, marks).marks.find((mark) => mark.name.startsWith('reads'))!.passed).toBe(false);
    expect(judge([...quick, sample('finish', 5000)], records, marks).passed).toBe(false);
    expect(judge([...quick, sample('read', 100, 'jobs_unavailable'), sample('read', 100, 'jobs_unavailable')], records, marks).errorsByKind).toEqual({ 'read 503 jobs_unavailable': 2 });
    expect(judge([...quick, sample('read', 100, 'jobs_unavailable'), sample('read', 100, 'jobs_unavailable')], records, marks).passed).toBe(false);
    expect(judge(quick, { ...records, problems: ['job 1: listed 2 times'] }, marks).passed).toBe(false);
  });

  it('fails a mark it has no samples for', async () => {
    const report = judge(quick.filter((s) => s.category !== 'finish'), records, await readPassMarks());
    expect(report.marks.find((mark) => mark.name === 'Finish, slowest')).toMatchObject({ passed: false, detail: 'no samples' });
  });

  it('holds the marks written before any run', async () => {
    expect(await readPassMarks()).toMatchObject({ readsP95Ms: 2000, photoP95Ms: 5000, finishMaxMs: 5000, errorRateBelow: 0.02, everyRecordOnce: true });
  });
});
