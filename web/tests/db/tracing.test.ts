import { SpanKind, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeClaims, Harness } from './team-harness';

// TC-3, request tracing, through a real route file as the runtime role against a real Postgres
// (see photos-api.test.ts for the setup). Next.js makes the route span in the running server, so
// the test opens a span of its own where Next would; everything below it is the app's: the
// withCompany transaction and one span per query, from postgres.js's diagnostics channel.
const live = vi.hoisted(() => ({ harness: null as Harness | null }));
vi.mock('@/lib/auth/services', () => ({
  identityServices: () => live.harness!.identity,
  serverDatabase: () => live.harness!.handle.db,
}));
vi.mock('@/lib/jobs/services', () => ({ jobsServices: () => live.harness!.jobs }));

const jobsRoute = await import('@/app/api/jobs/route');
const { startTracing } = await import('@/lib/telemetry/start');
const { withCompany } = await import('@/db');
const { sql } = await import('drizzle-orm');
const { params, request, resetTeamDatabase, startTeamServer } = await import('./team-harness');

const ESTIMATOR_A: FakeClaims = { tenant: 'tenant-a', uid: 'estimator-a' };

let base: Awaited<ReturnType<typeof startTeamServer>>;
let h: Harness;
const exporter = new InMemorySpanExporter();
let handle: ReturnType<typeof startTracing>;

beforeAll(async () => {
  base = await startTeamServer();
  vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'dryscope-test');
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  handle = startTracing({ mode: 'spans', appEnv: 'test' }, { exporter, simple: true });
});

beforeEach(async () => {
  h = await resetTeamDatabase(base, live.harness);
  live.harness = h;
  exporter.reset();
});

afterEach(() => exporter.reset());

afterAll(async () => {
  await handle?.shutdown();
  vi.unstubAllEnvs();
  await live.harness?.handle.close();
  await base?.admin.end({ timeout: 5 });
  await base?.server.stop();
});

const byName = (spans: ReadableSpan[], name: string | RegExp) =>
  spans.filter((s) => (typeof name === 'string' ? s.name === name : name.test(s.name)));

async function memberRequest(path: string): Promise<ReadableSpan[]> {
  await trace.getTracer('test').startActiveSpan('GET /api/jobs', { kind: SpanKind.SERVER }, async (route) => {
    try {
      const answer = await jobsRoute.GET(request(ESTIMATOR_A, path), params({}));
      expect(answer.status).toBe(200);
    } finally {
      route.end();
    }
  });
  return exporter.getFinishedSpans() as ReadableSpan[];
}

describe('a member request', () => {
  it('has a route span with a company transaction child and a query child under it', async () => {
    const spans = await memberRequest('/api/jobs');
    const [route] = byName(spans, 'GET /api/jobs');
    // The list itself is a query named by statement type and table...
    const [select] = byName(spans, 'SELECT jobs');
    expect(select?.attributes).toMatchObject({
      'db.system.name': 'postgresql',
      'db.operation.name': 'SELECT',
      'db.collection.name': 'jobs',
    });
    expect(select?.kind).toBe(SpanKind.CLIENT);
    // ...the child of its company transaction, which is the child of the route's span.
    const transaction = spans.find((s) => s.spanContext().spanId === select!.parentSpanContext?.spanId);
    expect(transaction?.name).toBe('withCompany transaction');
    expect(transaction?.attributes).toMatchObject({ 'db.system.name': 'postgresql', 'dryscope.db.scope': 'company' });
    expect(route).toBeDefined();
    expect(transaction?.parentSpanContext?.spanId).toBe(route!.spanContext().spanId);
    // Transaction control (BEGIN, COMMIT) is not a span of its own.
    expect(byName(spans, /^(BEGIN|COMMIT)/)).toEqual([]);
    // One trace.
    expect(new Set(spans.map((s) => s.spanContext().traceId)).size).toBe(1);
  });

  it('puts no parameter value, query text, email or token on any span', async () => {
    const tokenLike = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl';
    const email = 'tess.tester@example.com';
    await withCompany(h.handle.db, h.seed.a, async (tx) => {
      await tx.execute(sql`SELECT ${email}::text AS e, ${tokenLike}::text AS t, ${'47.6062, -122.3321'}::text AS c`);
    });
    const spans = exporter.getFinishedSpans() as ReadableSpan[];
    expect(byName(spans, 'SELECT')).toHaveLength(2); // the company setting and the crafted one
    const everything = JSON.stringify(
      spans.map((s) => ({ name: s.name, attributes: s.attributes, events: s.events, status: s.status, links: s.links })),
    );
    // The company id is a bound parameter of the set_config query.
    for (const secret of [h.seed.a, 'tess.tester', '@example.com', tokenLike, '47.6062', 'set_config', 'app.company_id']) {
      expect(everything, secret).not.toContain(secret);
    }
    expect(JSON.stringify(spans.flatMap((s) => Object.keys(s.attributes)))).not.toMatch(/parameters?|query\.text|statement/);
  });

  it('records a failed query as an error span with its code and no message', async () => {
    await trace.getTracer('test').startActiveSpan('failing', async (root) => {
      await expect(
        withCompany(h.handle.db, h.seed.a, (tx) => tx.execute(sql`SELECT 1 FROM no_such_table`)),
      ).rejects.toBeDefined();
      root.end();
    });
    const failed = (exporter.getFinishedSpans() as ReadableSpan[]).find((s) => s.status.code === 2);
    expect(failed?.attributes).toMatchObject({ 'error.type': '42P01', 'db.collection.name': 'no_such_table' });
    expect(JSON.stringify(failed)).not.toContain('does not exist');
  });
});
