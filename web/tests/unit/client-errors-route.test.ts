import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/client-errors/route';
import { limitedReports, resetClientErrorLimit } from '@/lib/client-error-intake';

// The server side of TC-2 (docs/plans/TC.md): a public route that takes error reports from a browser
// and writes each as an Error Reporting event. Nothing a caller sends may reach the log except the
// fixed fields, scrubbed again; no body is ever logged; the route touches no database.

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const EMAIL = 'jane.doe@example.com';
const BEARER = 'Bearer sekritvalue4ever';
const COORDS = '34.05223, -118.24368';

let lines: string[];

beforeEach(() => {
  lines = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  vi.stubEnv('APP_COMMIT', COMMIT);
  vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'dryscope-test');
  resetClientErrorLimit();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const report = (extra: Record<string, unknown> = {}) => ({
  kind: 'error',
  name: 'TypeError',
  message: 'x is not a function',
  stack: ['    at fn (/_next/static/chunks/app-0123.js:10:20)', '    at /_next/static/chunks/main.js:3:4'],
  route: '/sign-in/[address]',
  browser: 'safari',
  ...extra,
});

function send(reports: unknown, init: { headers?: Record<string, string>; raw?: string } = {}): Promise<Response> {
  const body = init.raw ?? JSON.stringify({ reports });
  return POST(
    new Request('http://localhost/api/client-errors', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...init.headers },
      body,
    }),
  );
}

const events = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);

describe('POST /api/client-errors: what it writes', () => {
  it('writes one Error Reporting event per report, in the documented shape', async () => {
    const res = await send([report(), report({ kind: 'rejection', name: 'RangeError', message: 'too far', stack: [] })], {
      headers: { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' },
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 2 });
    expect(res.headers.get('cache-control')).toBe('no-store');

    const [first, second] = events();
    expect(first).toMatchObject({
      '@type': 'type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent',
      severity: 'ERROR',
      serviceContext: { service: 'dryscope-web-client', version: COMMIT },
      message: 'TypeError: x is not a function\n    at fn (/_next/static/chunks/app-0123.js:10:20)\n    at /_next/static/chunks/main.js:3:4',
      context: { httpRequest: { url: '/sign-in/[address]' } },
      kind: 'error',
      browser: 'safari',
      'logging.googleapis.com/trace': 'projects/dryscope-test/traces/4bf92f3577b34da6a3ce929d0e0e4736',
    });
    expect((first as { stack_trace: string }).stack_trace).toBe((first as { message: string }).message);
    expect(second).toMatchObject({ kind: 'rejection', message: 'RangeError: too far' });
    expect(lines.every((line) => line.endsWith('\n') && line.trim().split('\n').length === 1)).toBe(true);
  });

  it('writes only the fixed fields, whatever else the body carries', async () => {
    await send([{ ...report(), user: EMAIL, headers: { authorization: BEARER }, extra: { deep: COORDS } }]);
    expect(Object.keys(events()[0]!).sort()).toEqual(
      ['@type', 'browser', 'context', 'kind', 'message', 'serviceContext', 'severity', 'stack_trace'].sort(),
    );
    expect(lines.join('')).not.toMatch(/example\.com|sekritvalue|34\.05/);
  });

  it('scrubs again: an email, a token and a coordinate pair never come out, whatever the browser sent', async () => {
    await send([
      report({
        name: EMAIL,
        message: `failed for ${EMAIL} with ${BEARER} at ${COORDS} job 123e4567-e89b-12d3-a456-426614174000 ?token=abc`,
        stack: [
          `    at ${EMAIL} (/_next/static/chunks/a.js:1:2)`,
          '    at fn (https://evil.example/_next/static/chunks/a.js:1:2)',
          `free text ${COORDS}`,
          '    at fn (/_next/static/chunks/ok.js:5:6)',
        ],
        route: `/sign-in/acme-restoration`,
        browser: 'safari',
      }),
    ]);
    const text = lines.join('');
    expect(text).not.toMatch(/example\.com|jane|sekritvalue|34\.05|118\.24|123e4567|acme-restoration|evil/);
    const [event] = events();
    expect(event).toMatchObject({
      context: { httpRequest: { url: 'unknown' } },
      message: expect.stringMatching(/^Error: failed for \[redacted\]/) as string,
    });
    expect((event as { message: string }).message).toContain('    at fn (/_next/static/chunks/ok.js:5:6)');
  });

  it('cuts a long message to 300 characters', async () => {
    await send([report({ message: 'word '.repeat(100) })]);
    const header = ((events()[0] as { message: string }).message.split('\n')[0] ?? '').replace(/^TypeError: /, '');
    expect(header.length).toBeLessThanOrEqual(300);
  });

  it('uses the server’s own version, or unknown without one', async () => {
    vi.stubEnv('APP_COMMIT', undefined);
    await send([report()]);
    expect(events()[0]).toMatchObject({ serviceContext: { service: 'dryscope-web-client', version: 'unknown' } });
  });
});

describe('POST /api/client-errors: what it refuses', () => {
  it.each([
    ['not JSON', { raw: 'not json' }],
    ['no reports', { raw: JSON.stringify({ reports: [] }) }],
    ['no reports key', { raw: JSON.stringify({}) }],
    ['a body that is not an object', { raw: JSON.stringify([report()]) }],
    ['21 reports', { raw: JSON.stringify({ reports: Array.from({ length: 21 }, (_, i) => report({ message: `m${i}` })) }) }],
    ['an unknown kind', { raw: JSON.stringify({ reports: [report({ kind: 'telemetry' })] }) }],
    ['an unknown browser', { raw: JSON.stringify({ reports: [report({ browser: 'Mozilla/5.0 (iPhone)' })] }) }],
    ['a message that is not text', { raw: JSON.stringify({ reports: [report({ message: { a: 1 } })] }) }],
    ['a message over its bound', { raw: JSON.stringify({ reports: [report({ message: 'x'.repeat(601) })] }) }],
    ['a name over its bound', { raw: JSON.stringify({ reports: [report({ name: 'N'.repeat(65) })] }) }],
    ['more than 12 stack lines', { raw: JSON.stringify({ reports: [report({ stack: Array(13).fill('    at /_next/static/a.js:1:1') })] }) }],
    ['a stack line over its bound', { raw: JSON.stringify({ reports: [report({ stack: ['a'.repeat(301)] })] }) }],
    ['a route over its bound', { raw: JSON.stringify({ reports: [report({ route: '/'.repeat(121) })] }) }],
  ])('answers 400 and writes nothing for %s', async (_name, init) => {
    const res = await send(undefined, init);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
    expect(lines).toEqual([]);
  });

  it('answers 415 when the body is not declared as JSON, so a cross-site form cannot post to it', async () => {
    const res = await send([report()], { headers: { 'content-type': 'text/plain' } });
    expect(res.status).toBe(415);
    expect(lines).toEqual([]);
  });

  it('answers 413 to a body over 8 KB, by its declared length', async () => {
    const res = await send([report()], { headers: { 'content-length': '9000' } });
    expect(res.status).toBe(413);
    expect(lines).toEqual([]);
  });

  it('answers 413 to a body over 8 KB however little it declares, without parsing it', async () => {
    const big = JSON.stringify({ reports: [report({ message: 'x'.repeat(100) })], pad: 'p'.repeat(9000) });
    const res = await send(undefined, { raw: big });
    expect(res.status).toBe(413);
    expect(lines).toEqual([]);
  });

  it('counts 8 KB in bytes, not characters', async () => {
    const wide = JSON.stringify({ reports: [report()], pad: 'é'.repeat(4100) });
    expect(wide.length).toBeLessThan(8192);
    expect((await send(undefined, { raw: wide })).status).toBe(413);
  });

  it('accepts a body of exactly 8 KB', async () => {
    const base = JSON.stringify({ reports: [report()], pad: '' });
    const exact = JSON.stringify({ reports: [report()], pad: 'p'.repeat(8192 - base.length) });
    expect(new TextEncoder().encode(exact).length).toBe(8192);
    expect((await send(undefined, { raw: exact })).status).toBe(202);
  });
});

describe('POST /api/client-errors: the cap', () => {
  it('writes at most 60 reports a minute per instance and answers the rest 202, counted and not logged', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-13T12:00:00Z'));
    const twenty = Array.from({ length: 20 }, (_, i) => report({ message: `m${i}` }));
    for (let i = 0; i < 3; i++) expect(await (await send(twenty)).json()).toEqual({ accepted: 20 });
    expect(lines).toHaveLength(60);

    lines.length = 0;
    const over = await send(twenty);
    expect(over.status).toBe(202);
    expect(await over.json()).toEqual({ accepted: 0 });
    expect(lines).toEqual([]);
    expect(limitedReports()).toBe(20);

    vi.setSystemTime(new Date('2026-11-13T12:01:01Z'));
    expect(await (await send([report()])).json()).toEqual({ accepted: 1 });
    expect(lines).toHaveLength(1);
  });

  it('takes the part of a batch that fits and counts the rest', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-13T12:00:00Z'));
    const twenty = Array.from({ length: 20 }, (_, i) => report({ message: `m${i}` }));
    await send(twenty);
    await send(twenty);
    await send(twenty.slice(0, 15));
    lines.length = 0;
    const res = await send(twenty.slice(0, 10));
    expect(await res.json()).toEqual({ accepted: 5 });
    expect(lines).toHaveLength(5);
    expect(limitedReports()).toBe(5);
  });
});

describe('POST /api/client-errors: what it reads', () => {
  const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
  const importsOf = (source: string) =>
    [...source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1]!);

  it('imports no database, Firestore, identity or storage code', () => {
    expect(importsOf(read('../../src/lib/client-error-intake.ts')).sort()).toEqual(
      ['./client-error-report', './log', 'zod'].sort(),
    );
    expect(importsOf(read('../../src/app/api/client-errors/route.ts')).sort()).toEqual(
      ['@/lib/auth', '@/lib/client-error-intake'].sort(),
    );
  });

  it('answers without a database, Firestore or sign-in configured', async () => {
    for (const name of ['DATABASE_URL', 'SQL_CONNECTION_NAME', 'FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST']) {
      vi.stubEnv(name, undefined);
    }
    expect((await send([report()])).status).toBe(202);
  });
});
