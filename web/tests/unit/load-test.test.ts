import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  ask,
  checkTarget,
  connectionLogFilter,
  freshPhoto,
  judge,
  loadCompany,
  parseArgs,
  passwordSignIn,
  percentile,
  readPassMarks,
  readTestConfig,
  refusedForInstance,
  statsOf,
  testConfigOf,
  type Records,
} from '../../scripts/load-test';

// The load test kit (S8-7): its percentile arithmetic, its guards and its judging. The run itself,
// the records check included, is exercised against the browser suite's local server
// (tests/e2e/load-test.spec.ts).

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

const TEST_ORIGIN = 'https://dryscope-api-test-570228742694.us-central1.run.app';
const LIVE_ORIGIN = 'https://dryscope-api-live-570228742694.us-central1.run.app';

describe('the target guard', () => {
  it('reads the test settings: the addresses, the instance limit, the project and the resource names', async () => {
    const config = await readTestConfig();
    // More test addresses may be added (S8-13); the run.app address stays one of them.
    expect(config.origins).toContain(TEST_ORIGIN);
    expect(config).toMatchObject({ projectId: 'dryscope', fieldDatabaseId: 'dryscope-field-test', sqlInstance: 'dryscope-test-pg' });
    expect(config.origins).not.toContain(LIVE_ORIGIN);
  });

  it('reads the settings as Terraform does: a commented-out address is not accepted', async () => {
    const text = [
      'project_id = "dryscope"',
      'environment = "test"',
      'allowed_origins = [',
      '  "https://a.example.com",',
      '  # "https://retired.example.com",',
      '  "https://test.example.com/",',
      ']',
      'api_scaling = {',
      '  max_instances = 3 # the budget',
      '}',
      'live_scaling = {',
      '  max_instances = 9',
      '}',
    ].join('\n');
    expect(await testConfigOf(text)).toMatchObject({ origins: ['https://a.example.com', 'https://test.example.com'] });
    await expect(testConfigOf(text.replace('environment = "test"', 'environment = "live"'))).rejects.toThrow(/test environment/);
    await expect(testConfigOf(`${text}\nenvironment = "test"`)).rejects.toThrow(/given twice/);
  });

  it('accepts only an address listed for test, when the service says test', async () => {
    const { doFetch } = fakeFetch({ '/api/health': { status: 200, body: { status: 'ok', env: 'test' } } });
    await expect(checkTarget(`${TEST_ORIGIN}/`, [TEST_ORIGIN], doFetch)).resolves.toBe('test');
    await expect(checkTarget('https://test.example.com/', [TEST_ORIGIN], doFetch)).rejects.toThrow(/refused/);
  });

  it('refuses a live host, by its address or by what it says, and sends nothing to an unlisted one', async () => {
    const live = fakeFetch({ '/api/health': { status: 200, body: { status: 'ok', env: 'live' } } });
    await expect(checkTarget(`${LIVE_ORIGIN}/`, [TEST_ORIGIN], live.doFetch)).rejects.toThrow(/refused/);
    await expect(checkTarget('https://test.example.com/', [TEST_ORIGIN], live.doFetch)).rejects.toThrow(/refused/);
    expect(live.asked).toEqual([]);
    await expect(checkTarget(`${TEST_ORIGIN}/`, [TEST_ORIGIN], live.doFetch)).rejects.toThrow(/refused/);
    expect(live.asked).toEqual([`${TEST_ORIGIN}/api/health`]);
  });

  it('refuses a local server unless the browser suite asks for it, and then only one saying local', async () => {
    const local = fakeFetch({ '/api/health': { status: 200, body: { env: 'local' } } });
    await expect(checkTarget(TEST_ORIGIN.replace('https:', 'http:') + '/', [TEST_ORIGIN], local.doFetch)).rejects.toThrow(/refused/);
    await expect(checkTarget('http://localhost:3100/', [], local.doFetch)).rejects.toThrow(/refused/);
    expect(local.asked).toEqual([]);
    await expect(checkTarget('http://localhost:3100/', [], local.doFetch, true)).resolves.toBe('local');
    const testOnLoopback = fakeFetch({ '/api/health': { status: 200, body: { env: 'test' } } });
    await expect(checkTarget('http://localhost:3100/', [], testOnLoopback.doFetch, true)).rejects.toThrow(/refused/);
    await expect(checkTarget(`${TEST_ORIGIN}/api`, [TEST_ORIGIN], local.doFetch)).rejects.toThrow(/site root/);
  });

  it('refuses a company whose name does not start with load-', async () => {
    const real = fakeFetch({ '/api/sign-in/acme': { status: 200, body: { company: { name: 'Acme Restoration' }, tenantId: 't-1' } } });
    await expect(loadCompany(`${TEST_ORIGIN}/`, 'acme', real.doFetch)).rejects.toThrow(/load-/);
    const load = fakeFetch({ '/api/sign-in/load-one': { status: 200, body: { company: { name: 'load-one' }, tenantId: 't-2' } } });
    await expect(loadCompany(`${TEST_ORIGIN}/`, 'load-one', load.doFetch)).resolves.toEqual({ tenantId: 't-2', name: 'load-one' });
  });
});

describe('the arguments', () => {
  const technicians = ['t1@example.com', 't2@example.com', 't3@example.com', 't4@example.com', 't5@example.com'];
  const office = ['o1@example.com', 'o2@example.com'];
  const args = (techs = technicians, offs = office) => [
    '--url', `${TEST_ORIGIN}`, '--company', 'load-one', '--api-key', 'k',
    '--technicians', techs.join(','), '--office', offs.join(','),
  ];

  const config = { origins: [TEST_ORIGIN], projectId: 'dryscope', fieldDatabaseId: 'dryscope-field-test', sqlInstance: 'dryscope-test-pg' };
  const parse = (argv: string[]) => parseArgs(argv, config);

  it('takes the pilot: five technicians and two office users, for 20 minutes with a one-minute opening', () => {
    const options = parse(args());
    expect(options.users).toEqual([...technicians.map((email) => ({ email, role: 'estimator' })), ...office.map((email) => ({ email, role: 'office' }))]);
    expect(options).toMatchObject({ durationMs: 20 * 60_000, openingMs: 60_000, burstsPerJob: 2, photoGapMs: 30_000 });
    // The test project and its field database come from the test settings, never an argument.
    expect(options).toMatchObject({ projectId: 'dryscope', databaseId: 'dryscope-field-test' });
    // The owner's command line never reaches a local server.
    expect(options.allowLocal).toBeUndefined();
    expect(options.finishMarginMs).toBe(90_000);
  });

  it('refuses another roster, or one account twice', () => {
    expect(() => parse(args(technicians.slice(0, 4)))).toThrow(/exactly 5/);
    expect(() => parse(args([...technicians, 't6@example.com']))).toThrow(/exactly 5/);
    expect(() => parse(args(technicians, office.slice(0, 1)))).toThrow(/exactly 2/);
    expect(() => parse(args([...technicians.slice(0, 4), 'T1@example.com']))).toThrow(/different account/);
    expect(() => parse(args(technicians, ['o1@example.com', 't2@example.com']))).toThrow(/different account/);
  });

  it('has no option to shorten the run, widen the opening or change the photos', () => {
    expect(() => parse([...args(), '--minutes', '1'])).toThrow(/unknown option/);
    expect(() => parse([...args(), '--opening-seconds', '600'])).toThrow(/unknown option/);
    expect(() => parse([...args(), '--photos-per-job', '1'])).toThrow(/unknown option/);
    expect(() => parse([...args(), '--project', 'other'])).toThrow(/unknown option/);
    expect(() => parse([...args(), '--database', 'other'])).toThrow(/unknown option/);
  });

  it('never takes the password from an argument', () => {
    expect(() => parse([...args(), '--password', 'secret'])).toThrow(/never from an argument/);
    expect(() => parse([...args(), '--pass', 'secret'])).toThrow(/never from an argument/);
  });

  it('shows the question but never what is typed for the password or the authenticator code', async () => {
    for (const [question, typed] of [["Load users' password: ", 'Sw0rdfish-load'], ['Authenticator code for office user 1: ', '492817']] as const) {
      const input = new PassThrough();
      const output = new PassThrough();
      let shown = '';
      output.on('data', (chunk: Buffer) => (shown += chunk.toString('utf8')));
      const answer = ask(question, input, output);
      input.write(`${typed}\r`);
      await expect(answer).resolves.toBe(typed);
      expect(shown).toContain(question);
      expect(shown).not.toContain(typed);
    }
  });
});

describe('signing in', () => {
  it('sends the test address with the password and the authenticator steps, as the key is limited to it', async () => {
    const seen: { path: string; origin: string | null; referer: string | null }[] = [];
    const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      seen.push({ path: url.pathname, origin: headers.get('origin'), referer: headers.get('referer') });
      const body = url.pathname.endsWith('accounts:signInWithPassword')
        ? { mfaPendingCredential: 'pending', mfaInfo: [{ mfaEnrollmentId: 'e-1', totpInfo: {} }] }
        : { idToken: 'token-1' };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const config = { origins: [TEST_ORIGIN], projectId: 'dryscope', fieldDatabaseId: 'dryscope-field-test', sqlInstance: 'dryscope-test-pg' };
    const options = parseArgs(
      ['--url', TEST_ORIGIN, '--company', 'load-one', '--api-key', 'k', '--technicians', 'a@x.io,b@x.io,c@x.io,d@x.io,e@x.io', '--office', 'f@x.io,g@x.io'],
      config,
    );
    const token = await passwordSignIn({ ...options, fetch: doFetch }, 't-1', options.users[0]!, 'pw', async () => '123456');
    expect(token).toBe('token-1');
    expect(seen).toEqual([
      { path: '/v1/accounts:signInWithPassword', origin: TEST_ORIGIN, referer: `${TEST_ORIGIN}/` },
      { path: '/v2/accounts/mfaSignIn:finalize', origin: TEST_ORIGIN, referer: `${TEST_ORIGIN}/` },
    ]);
  });
});

describe('the photos', () => {
  it('makes every photo a new 1 MB JPEG file', () => {
    const one = freshPhoto();
    const two = freshPhoto();
    expect(one.byteLength).toBe(1024 * 1024);
    expect([...one.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect(Buffer.from(one).equals(Buffer.from(two))).toBe(false);
  });
});

describe('judging the run against the pass marks', () => {
  const records: Records = { jobs: 2, submissions: 2, estimates: 2, photos: 20, officeReads: [3, 2], problems: [] };
  const clean = { connectionErrors: 0, peakCpuPercent: 42.5, peakConnections: 9, maxConnections: 25 };
  const sample = (category: 'read' | 'photo' | 'finish', ms: number, error: string | null = null, noInstance = false) => ({ category, label: category, ms, status: error ? 503 : 200, error, noInstance });
  const quick = [...Array.from({ length: 40 }, () => sample('read', 100)), ...Array.from({ length: 20 }, () => sample('photo', 800)), sample('finish', 900), sample('finish', 1200)];

  it('passes a run inside every mark', async () => {
    const report = judge(quick, records, await readPassMarks(), clean);
    expect(report.marks.map((mark) => [mark.name, mark.passed])).toEqual([
      ['reads, 95th percentile', true],
      ['1 MB photo, 95th percentile', true],
      ['Finish, slowest', true],
      ['errors', true],
      ['no error from running out of database connections', true],
      ['no request refused for lack of an instance', true],
      ['database processor under 80%', true],
      ['database connections under max_connections less 10', true],
      ['office day: each office user read documents', true],
      ['every created record present exactly once', true],
    ]);
    expect(report.passed).toBe(true);
  });

  it('fails slow reads, a slow Finish, too many errors and a record seen twice', async () => {
    const marks = await readPassMarks();
    const slowReads = [...quick.filter((s) => s.category !== 'read'), ...Array.from({ length: 40 }, () => sample('read', 2500))];
    expect(judge(slowReads, records, marks, clean).marks.find((mark) => mark.name.startsWith('reads'))!.passed).toBe(false);
    expect(judge([...quick, sample('finish', 5000)], records, marks, clean).passed).toBe(false);
    const failing = [...quick, sample('read', 100, 'jobs_unavailable'), sample('read', 100, 'jobs_unavailable')];
    expect(judge(failing, records, marks, clean).errorsByKind).toEqual({ 'read 503 jobs_unavailable': 2 });
    expect(judge(failing, records, marks, clean).passed).toBe(false);
    expect(judge(quick, { ...records, problems: ['job 1: listed 2 times'] }, marks, clean).passed).toBe(false);
  });

  it('fails the run on a single refused database connection, however low the error rate', async () => {
    const report = judge(quick, records, await readPassMarks(), { ...clean, connectionErrors: 1 });
    expect(report.marks.find((mark) => mark.name === 'errors')!.passed).toBe(true);
    expect(report.marks.find((mark) => mark.name.startsWith('no error from running out'))).toMatchObject({ passed: false, detail: '1 refused connections in the database log' });
    expect(report.passed).toBe(false);
    expect(judge(quick, records, await readPassMarks(), { ...clean, connectionErrors: Number.NaN }).passed).toBe(false);
  });

  it('fails a busy database or a missing reading', async () => {
    const marks = await readPassMarks();
    const mark = (owner: typeof clean, name: string) => judge(quick, records, marks, owner).marks.find((found) => found.name === name)!;
    expect(mark({ ...clean, peakCpuPercent: 80 }, 'database processor under 80%')).toMatchObject({ passed: false, detail: 'peak 80% (under 80%)' });
    expect(mark({ ...clean, peakCpuPercent: Number.NaN }, 'database processor under 80%')).toMatchObject({ passed: false, detail: 'no reading' });
    expect(mark({ ...clean, peakConnections: 15 }, 'database connections under max_connections less 10').passed).toBe(false);
    expect(mark({ ...clean, peakConnections: 14 }, 'database connections under max_connections less 10').passed).toBe(true);
    expect(mark({ ...clean, maxConnections: Number.NaN }, 'database connections under max_connections less 10')).toMatchObject({ passed: false, detail: 'no reading' });
  });

  it('fails the run on any request Cloud Run refused for lack of an instance', async () => {
    const report = judge([...quick, sample('read', 100, 'error', true)], records, await readPassMarks(), clean);
    expect(report.marks.find((mark) => mark.name === 'errors')!.passed).toBe(true);
    expect(report.marks.find((mark) => mark.name === 'no request refused for lack of an instance')).toMatchObject({ passed: false, detail: '1 requests refused by Cloud Run for lack of an instance' });
    expect(report.passed).toBe(false);
  });

  it('tells Cloud Run\'s own refusals from the app\'s answers', () => {
    // Cloud Run's own answers when no instance is available.
    expect(refusedForInstance(429, '<html><body>Rate exceeded.</body></html>')).toBe(true);
    expect(refusedForInstance(503, 'Service Unavailable')).toBe(true);
    expect(refusedForInstance(500, 'The request was aborted because there was no available instance.')).toBe(true);
    // The app's own answers, which are JSON naming their code.
    expect(refusedForInstance(429, '{"error":"too_many_requests"}')).toBe(false);
    expect(refusedForInstance(503, '{"error":"jobs_unavailable"}')).toBe(false);
    // A 500 without Cloud Run's text, and any other status, are not.
    expect(refusedForInstance(500, 'Internal Server Error')).toBe(false);
    expect(refusedForInstance(502, 'Bad Gateway')).toBe(false);
    expect(refusedForInstance(200, '')).toBe(false);
  });

  it('fails the run when an office user never read documents', async () => {
    const report = judge(quick, { ...records, officeReads: [4, 0] }, await readPassMarks(), clean);
    expect(report.marks.find((mark) => mark.name.startsWith('office day'))).toMatchObject({ passed: false, detail: 'documents read 4, 0 times' });
    expect(report.passed).toBe(false);
  });

  it('gives the owner the test database\'s log filter for the run\'s window', () => {
    expect(connectionLogFilter({ projectId: 'dryscope', sqlInstance: 'dryscope-test-pg' }, { start: '2026-11-18T01:00:00.000Z', end: '2026-11-18T01:22:00.000Z' })).toBe(
      'resource.type="cloudsql_database" AND resource.labels.database_id="dryscope:dryscope-test-pg" AND logName="projects/dryscope/logs/cloudsql.googleapis.com%2Fpostgres.log" AND timestamp>="2026-11-18T01:00:00.000Z" AND timestamp<="2026-11-18T01:22:00.000Z" AND ("too many clients" OR "remaining connection slots")',
    );
  });

  it('fails a mark it has no samples for', async () => {
    const report = judge(quick.filter((s) => s.category !== 'finish'), records, await readPassMarks(), clean);
    expect(report.marks.find((mark) => mark.name === 'Finish, slowest')).toMatchObject({ passed: false, detail: 'no samples' });
  });

  it('holds the marks written before any run', async () => {
    const marks = await readPassMarks();
    expect(marks).toMatchObject({ readsP95Ms: 2000, photoP95Ms: 5000, finishMaxMs: 5000, errorRateBelow: 0.02, databaseConnectionErrors: 0, instanceRefusals: 0, databaseCpuBelowPercent: 80, connectionHeadroom: 10 });
  });
});
