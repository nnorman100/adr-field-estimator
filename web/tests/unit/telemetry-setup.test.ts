import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { SpanKind } from '@opentelemetry/api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseTracingConfig } from '@/lib/config';
import { googleTraceExporter, TELEMETRY_TRACES_URL } from '@/lib/telemetry/google-exporter';
import { statementKind } from '@/lib/telemetry/statement';

// TC-3: when tracing exports and where, what a span says about a statement, the request the
// exporter makes, and that every Firestore Admin call goes through firestoreSpan.
afterEach(() => vi.restoreAllMocks());

describe('tracing mode', () => {
  const base = { APP_ENV: 'test', GOOGLE_CLOUD_PROJECT: 'dryscope-test' };

  it('exports only on a Cloud Run service with a project, outside a local run', () => {
    expect(parseTracingConfig({ ...base, K_SERVICE: 'dryscope-api-test' }).mode).toBe('export');
    expect(parseTracingConfig({ ...base, K_SERVICE: 'dryscope-api-live', APP_ENV: 'live' }).mode).toBe('export');
  });

  it('records spans in the process and exports nothing in a local run or CI', () => {
    expect(parseTracingConfig({ APP_ENV: 'local' }).mode).toBe('spans');
    expect(parseTracingConfig({ APP_ENV: 'local', GOOGLE_CLOUD_PROJECT: 'demo-dryscope', K_SERVICE: 'x' }).mode).toBe('spans');
    // CI: the test environment's name, no Cloud Run, no project.
    expect(parseTracingConfig({ APP_ENV: 'test' }).mode).toBe('spans');
    expect(parseTracingConfig({ ...base }).mode).toBe('spans');
    expect(parseTracingConfig({ APP_ENV: 'test', K_SERVICE: 'dryscope-api-test' }).mode).toBe('spans');
  });

  it('is off with OTEL_SDK_DISABLED=true in any case, and a typo leaves it on', () => {
    for (const value of ['true', 'TRUE', 'True']) {
      expect(parseTracingConfig({ ...base, K_SERVICE: 'x', OTEL_SDK_DISABLED: value }).mode).toBe('off');
    }
    for (const value of ['false', 'yes', '1', '']) {
      expect(parseTracingConfig({ ...base, K_SERVICE: 'x', OTEL_SDK_DISABLED: value }).mode).toBe('export');
    }
  });

  it('carries the project and commit for the resource', () => {
    expect(parseTracingConfig({ ...base, APP_COMMIT: 'b'.repeat(40) })).toMatchObject({
      projectId: 'dryscope-test',
      commit: 'b'.repeat(40),
      appEnv: 'test',
    });
  });
});

describe('statement kind', () => {
  it.each([
    ['select "id", "name" from "jobs" where "id" = $1', { operation: 'SELECT', table: 'jobs' }],
    ['select "a"."id" from "public"."price_tables" as "a" where x = $1', { operation: 'SELECT', table: 'price_tables' }],
    ['insert into "audit_events" ("id") values ($1)', { operation: 'INSERT', table: 'audit_events' }],
    ['update "memberships" set "role" = $1 where "id" = $2', { operation: 'UPDATE', table: 'memberships' }],
    ['delete from "invitations" where "id" = $1', { operation: 'DELETE', table: 'invitations' }],
    ['SELECT set_config(\'app.company_id\', $1, true)', { operation: 'SELECT' }],
    ['  -- note\n  SELECT 1', { operation: 'SELECT' }],
    ['with x as (select 1) select * from "jobs"', { operation: 'WITH', table: 'jobs' }],
    ['begin', { operation: 'BEGIN' }],
    ['vacuum', { operation: 'OTHER' }],
    ['select * from "bad name with spaces" where a = $1', { operation: 'SELECT' }],
  ])('%s', (text, expected) => {
    expect(statementKind(text)).toEqual(expected);
  });

  it('says nothing from a missing text, and never repeats a literal', () => {
    expect(statementKind(null)).toEqual({ operation: 'other' });
    const kind = statementKind("select * from jobs where owner = 'jo@example.com'");
    expect(JSON.stringify(kind)).not.toContain('example.com');
  });
});

describe('the Cloud Trace exporter', () => {
  it('sends protobuf to the Telemetry API address with a fresh token on every export', async () => {
    expect(TELEMETRY_TRACES_URL).toBe('https://telemetry.googleapis.com/v1/traces');
    const seen: { path?: string; headers: IncomingHttpHeaders; bytes: number }[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push({ path: req.url, headers: req.headers, bytes: Buffer.concat(chunks).length });
        res.writeHead(200, { 'content-type': 'application/x-protobuf' }).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/traces`;
    let n = 0;
    const auth = { getRequestHeaders: async () => new Headers({ authorization: `Bearer token-${++n}` }) };
    const exporter = googleTraceExporter(auth, url);
    const { startTracing } = await import('@/lib/telemetry/start');
    const handle = startTracing({ mode: 'spans', appEnv: 'test' }, { exporter, simple: true })!;
    try {
      const { inSpan } = await import('@/lib/telemetry/spans');
      await inSpan('one', SpanKind.INTERNAL, { 'dryscope.k': 'v' }, async () => 1);
      await inSpan('two', SpanKind.INTERNAL, {}, async () => 1);
      await handle.provider.forceFlush();
    } finally {
      await handle.shutdown();
      await new Promise((resolve) => server.close(resolve));
    }
    expect(seen.map((r) => r.path)).toEqual(['/v1/traces', '/v1/traces']);
    expect(seen.map((r) => r.headers.authorization)).toEqual(['Bearer token-1', 'Bearer token-2']);
    expect(seen[0]!.headers['content-type']).toBe('application/x-protobuf');
    expect(seen[0]!.bytes).toBeGreaterThan(20);
  });

  it('still sends, is refused and reports once, without throwing, when credentials are missing', async () => {
    const lines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    // Google answers a request with no token 401, which the exporter does not retry.
    const server = createServer((_req, res) => res.writeHead(401).end());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const exporter = googleTraceExporter(
      { getRequestHeaders: () => Promise.reject(new Error('no credentials, token abc')) },
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/traces`,
    );
    const { startTracing } = await import('@/lib/telemetry/start');
    const { inSpan } = await import('@/lib/telemetry/spans');
    const handle = startTracing({ mode: 'spans', appEnv: 'test' }, { exporter, simple: true })!;
    try {
      await expect(inSpan('work', SpanKind.INTERNAL, {}, async () => 'done')).resolves.toBe('done');
      await handle.provider.forceFlush().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 300));
    } finally {
      await handle.shutdown();
      await new Promise((resolve) => server.close(resolve));
    }
    const failures = lines.filter((l) => l.includes('export_failed'));
    expect(failures).toHaveLength(1);
    expect(lines.join('')).not.toMatch(/token abc|no credentials/);
  });
});

// A new Firestore Admin call that skips firestoreSpan would be invisible in a trace.
describe('Firestore Admin calls', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : [];
    });

  it('every source file that calls Firestore opens a span for it', () => {
    const src = new URL('../../src/', import.meta.url).pathname;
    const calls = /\.collection\(|\.runTransaction\(|\.collectionGroup\(|\.batch\(\)/;
    const offenders = walk(src)
      .filter((file) => !file.includes('/telemetry/'))
      .filter((file) => calls.test(readFileSync(file, 'utf8')) && !readFileSync(file, 'utf8').includes('firestoreSpan('))
      .map((file) => file.slice(src.length));
    expect(offenders).toEqual([]);
  });
});
