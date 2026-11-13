import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { register } from '@/instrumentation';

let exit: ReturnType<typeof vi.spyOn>;
let logged: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  logged = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('server start', () => {
  it('stops the process without APP_ENV and names it', () => {
    vi.stubEnv('APP_ENV', undefined);
    register();
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(logged.mock.calls[0]?.[0])).toMatch(/APP_ENV/);
  });

  it('stops the process on an invalid APP_ENV without echoing it', () => {
    vi.stubEnv('APP_ENV', 'secret-value');
    register();
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(logged.mock.calls[0]?.[0])).not.toMatch(/secret-value/);
  });

  it('starts with a valid APP_ENV and no database URL', () => {
    vi.stubEnv('APP_ENV', 'test');
    vi.stubEnv('DATABASE_URL', undefined);
    register();
    expect(exit).not.toHaveBeenCalled();
  });

  it('stops on an invalid DATABASE_URL without echoing it', () => {
    vi.stubEnv('APP_ENV', 'test');
    vi.stubEnv('DATABASE_URL', 'mysql://super-secret-db-password@db.example/app');
    register();
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(logged.mock.calls[0]?.[0])).toMatch(/DATABASE_URL/);
    expect(String(logged.mock.calls[0]?.[0])).not.toMatch(/super-secret-db-password/);
  });
});

describe('request tracing at server start', () => {
  const GLOBAL = Symbol.for('dryscope.tracing');
  const started = () => (globalThis as { [GLOBAL]?: { shutdown(): Promise<void> } })[GLOBAL];

  beforeEach(() => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('APP_ENV', 'test');
    vi.stubEnv('K_SERVICE', undefined);
    vi.stubEnv('OTEL_SDK_DISABLED', undefined);
  });

  afterEach(async () => {
    await started()?.shutdown();
    vi.doUnmock('@/lib/telemetry/start');
    vi.resetModules();
  });

  it('records spans in the process, and exports nothing, in a run that is not on Cloud Run', async () => {
    await register();
    expect(started()).toBeDefined();
    expect(exit).not.toHaveBeenCalled();
  });

  it('starts nothing with OTEL_SDK_DISABLED=true', async () => {
    vi.stubEnv('OTEL_SDK_DISABLED', 'true');
    await register();
    expect(started()).toBeUndefined();
  });

  it('starts nothing outside the Node runtime', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    await register();
    expect(started()).toBeUndefined();
  });

  it('never stops the server when tracing cannot start, and repeats nothing about why', async () => {
    vi.resetModules();
    vi.doMock('@/lib/telemetry/start', () => ({
      startTracing: () => {
        throw new Error('exporter broke, token abc.def.ghi');
      },
    }));
    const { register: again } = await import('@/instrumentation');
    await again();
    expect(exit).not.toHaveBeenCalled();
    expect(logged.mock.calls.map((c: unknown[]) => String(c[0]))).toEqual(['tracing unavailable']);
  });
});

describe('server error reports', () => {
  const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
  let lines: string[];
  const request = (headers: Record<string, string> = {}) => ({ path: '/api/jobs/abc-123?x=1', method: 'POST', headers });
  const context = { routerKind: 'App Router', routePath: '/api/jobs/[jobId]', routeType: 'route' } as never;

  beforeEach(() => {
    lines = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'dryscope-test');
    vi.stubEnv('APP_COMMIT', 'a'.repeat(40));
  });

  it('writes exactly one Error Reporting line for an uncaught error', async () => {
    const { onRequestError } = await import('@/instrumentation');
    const { IdentityRefusal } = await import('@/lib/auth/identity');
    await onRequestError(new IdentityRefusal('no_tenant'), request(), context);
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]!);
    expect(line.severity).toBe('ERROR');
    expect(line['@type']).toBe('type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent');
    expect(line.serviceContext).toEqual({ service: 'dryscope-api', version: 'a'.repeat(40) });
    expect(line.context.httpRequest).toEqual({ method: 'POST', url: '/api/jobs/[jobId]' });
    expect(line.message).toMatch(/^IdentityRefusal: no_tenant\n\s+at /);
    expect(line.stack_trace).toBe(line.message);
  });

  it('adds the trace field from the request headers', async () => {
    const { onRequestError } = await import('@/instrumentation');
    await onRequestError(new Error('x'), request({ traceparent: `00-${TRACE}-00f067aa0ba902b7-01` }), context);
    expect(JSON.parse(lines[0]!)['logging.googleapis.com/trace']).toBe(`projects/dryscope-test/traces/${TRACE}`);
  });

  it('never repeats the error message, the request path or a header value', async () => {
    const { onRequestError } = await import('@/instrumentation');
    const error = new Error('jo@example.com Bearer abc.def.ghi 34.0522, -118.2437');
    error.name = 'PgError';
    await onRequestError(error, request({ authorization: 'Bearer abc.def.ghi' }), context);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/jo@example\.com|abc\.def\.ghi|34\.0522|118\.2437|abc-123/);
    expect(JSON.parse(lines[0]!).message).toMatch(/^PgError\n/);
  });

  it('does not let a message line shaped like a stack frame through', async () => {
    const { onRequestError } = await import('@/instrumentation');
    await onRequestError(new Error('x\n    at leak@example.com (file.js:1:1)'), request(), context);
    expect(lines[0]).not.toMatch(/leak@example/);
  });

  it('reports a thrown non-error as a plain Error with no value in it', async () => {
    const { onRequestError } = await import('@/instrumentation');
    await onRequestError('secret@example.com', request(), context);
    expect(lines[0]).not.toMatch(/secret@example/);
    expect(JSON.parse(lines[0]!).message).toBe('Error');
  });

  it('writes nothing outside the Node runtime', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    const { onRequestError } = await import('@/instrumentation');
    await onRequestError(new Error('x'), request(), context);
    expect(lines).toHaveLength(0);
  });

  it('does not throw when it cannot report', async () => {
    const { onRequestError } = await import('@/instrumentation');
    await expect(onRequestError(new Error('x'), undefined as never, undefined as never)).resolves.toBeUndefined();
  });
});
