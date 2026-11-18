import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serviceRoute } from '@/lib/auth/route';
import {
  googleIdTokenVerifier,
  schedulerCaller,
  type ServiceCallerServices,
  type ServiceTokenVerifier,
} from '@/lib/auth/service-caller';
import { proxy } from '@/proxy';

// The internal job route rule (serviceRoute): only the environment's scheduler service account,
// with a token minted for that job, reaches the handler.

const SCHEDULER = 'dryscope-scheduler-test@dryscope.iam.gserviceaccount.com';
const TOKEN = 'e30.e30.sig';

// Settings as infra/dryscope/app/cloud_run.tf common_env sets them.
const cloudRun = { APP_ENVIRONMENT: 'test', GOOGLE_CLOUD_PROJECT: 'dryscope' };

function services(claims: { email: string | null; emailVerified: boolean } | Error, audiences: string[] = []) {
  const verifier: ServiceTokenVerifier = {
    async verify(_token, audience) {
      audiences.push(audience);
      if (claims instanceof Error) throw claims;
      return claims;
    },
  };
  return (): ServiceCallerServices => ({ caller: schedulerCaller(cloudRun), verifier });
}

const call = (headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` }) =>
  new Request('http://localhost/api/internal/access-projection', { method: 'POST', headers });
const context = { params: Promise.resolve({}) };

describe('the scheduler service account', () => {
  it('is named from the environment and project the Cloud Run Terraform sets', () => {
    const caller = schedulerCaller(cloudRun);
    expect(caller.email).toBe(SCHEDULER);
    expect(caller.audienceFor('access-projection')).toBe('dryscope-test-access-projection');
    expect(schedulerCaller({ APP_ENV: 'live', GOOGLE_CLOUD_PROJECT: 'dryscope' }).email).toBe(
      'dryscope-scheduler-live@dryscope.iam.gserviceaccount.com',
    );
  });

  it('does not exist locally or without a project', () => {
    expect(() => schedulerCaller({ APP_ENV: 'local', GOOGLE_CLOUD_PROJECT: 'demo-dryscope' })).toThrow(/not callable locally/);
    expect(() => schedulerCaller({ APP_ENV: 'test' })).toThrow(/GOOGLE_CLOUD_PROJECT/);
  });

  it('reads the account from a Google ID token checked for the job audience', async () => {
    const seen: unknown[] = [];
    const client = {
      async verifyIdToken(options: unknown) {
        seen.push(options);
        return { getPayload: () => ({ email: SCHEDULER, email_verified: true }) };
      },
    };
    const verifier = googleIdTokenVerifier(client as never);
    expect(await verifier.verify(TOKEN, 'dryscope-test-access-projection')).toEqual({ email: SCHEDULER, emailVerified: true });
    expect(seen).toEqual([{ idToken: TOKEN, audience: 'dryscope-test-access-projection' }]);
  });
});

describe('serviceRoute', () => {
  it('runs the handler for the scheduler account, with the token checked for this job', async () => {
    const handler = vi.fn(async () => Response.json({ ok: true }));
    const audiences: string[] = [];
    const route = serviceRoute('access-projection', handler, services({ email: SCHEDULER, emailVerified: true }, audiences));
    const res = await route(call(), context);
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(audiences).toEqual(['dryscope-test-access-projection']);
  });

  it('refuses everyone else before the handler runs', async () => {
    const handler = vi.fn(async () => Response.json({ ok: true }));
    const cases: [string, ReturnType<typeof services>, Request, number, string][] = [
      ['no token', services({ email: SCHEDULER, emailVerified: true }), call({}), 401, 'missing_token'],
      ['a token that fails the check', services(new Error('bad signature')), call(), 401, 'invalid_token'],
      ['another account', services({ email: 'dryscope-api-test@dryscope.iam.gserviceaccount.com', emailVerified: true }), call(), 403, 'not_allowed'],
      ['an unverified email', services({ email: SCHEDULER, emailVerified: false }), call(), 403, 'not_allowed'],
      ['no email', services({ email: null, emailVerified: true }), call(), 403, 'not_allowed'],
    ];
    for (const [name, found, request, status, error] of cases) {
      const res = await serviceRoute('access-projection', handler, found)(request, context);
      expect({ name, status: res.status, body: await res.json() }).toEqual({ name, status, body: { error } });
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('fails closed when the account cannot be named, logging fixed text only', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = vi.fn(async () => Response.json({ ok: true }));
    const route = serviceRoute('access-projection', handler, () => ({
      caller: schedulerCaller({ APP_ENV: 'local', GOOGLE_CLOUD_PROJECT: 'demo-dryscope' }),
      verifier: { verify: async () => ({ email: SCHEDULER, emailVerified: true }) },
    }));
    const res = await route(call(), context);
    expect(res.status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledWith('service caller check unavailable', 'ConfigError');
    expect(JSON.stringify(errors.mock.calls)).not.toContain(TOKEN);
    errors.mockRestore();
  });
});

describe('POST /api/internal/access-projection', () => {
  afterEach(() => {
    vi.doUnmock('@/lib/auth/service-caller');
    vi.doUnmock('@/lib/projection/services');
    vi.doUnmock('@/lib/submissions/services');
    vi.resetModules();
  });

  it('passes the proxy to its own check, and nothing that looks like it does', () => {
    const at = (path: string) => proxy(new NextRequest(new URL(path, 'http://localhost'), { method: 'POST' }));
    expect(at('/api/internal/access-projection').headers.get('x-middleware-next')).toBe('1');
    for (const path of ['/api/internal', '/api/internal/access-projection/', '/api/internal/access-projection/x']) {
      expect({ path, status: at(path).status }).toEqual({ path, status: 401 });
    }
  });

  it('runs one outbox pass and one Submit repair pass for the scheduler and answers their counts', async () => {
    vi.resetModules();
    const summary = { granted: 2, removed: 1, busy: 0, nothing_due: 0, failed: 0 };
    const repaired = { aborted: 1, marked: 3, failed: 0 };
    const run = vi.fn(async () => summary);
    const repair = vi.fn(async () => repaired);
    vi.doMock('@/lib/projection/services', () => ({ runQueuedProjection: run }));
    vi.doMock('@/lib/submissions/services', () => ({ runQueuedSubmissionRepair: repair }));
    vi.doMock('@/lib/auth/service-caller', () => ({
      serviceCallerServices: () => ({
        caller: { email: SCHEDULER, audienceFor: (job: string) => `dryscope-test-${job}` },
        verifier: { verify: async () => ({ email: SCHEDULER, emailVerified: true }) },
      }),
    }));
    const { POST } = await import('@/app/api/internal/access-projection/route');
    const res = await POST(call(), context);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ ...summary, submissions: repaired });
    expect(run).toHaveBeenCalledTimes(1);
    expect(repair).toHaveBeenCalledTimes(1);

    expect((await POST(call({}), context)).status).toBe(401);
    expect(run).toHaveBeenCalledTimes(1);
    expect(repair).toHaveBeenCalledTimes(1);
  });

  // Security audit F5: a pass the full pool could not serve within its queue limit.
  it('answers 503, quoting nothing, when no database connection came free in time', async () => {
    vi.resetModules();
    const refused = Object.assign(new Error('QUEUE_TIMEOUT: Waited more than 10 seconds for a connection'), { code: 'QUEUE_TIMEOUT' });
    const repair = vi.fn(async () => ({ aborted: 0, marked: 0, failed: 0 }));
    vi.doMock('@/lib/projection/services', () => ({
      runQueuedProjection: async () => {
        throw refused;
      },
    }));
    vi.doMock('@/lib/submissions/services', () => ({ runQueuedSubmissionRepair: repair }));
    vi.doMock('@/lib/auth/service-caller', () => ({
      serviceCallerServices: () => ({
        caller: { email: SCHEDULER, audienceFor: (job: string) => `dryscope-test-${job}` },
        verifier: { verify: async () => ({ email: SCHEDULER, emailVerified: true }) },
      }),
    }));
    const { POST } = await import('@/app/api/internal/access-projection/route');
    const res = await POST(call(), context);
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'service_unavailable' });
    expect(repair).not.toHaveBeenCalled();
  });
});
