import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  API_ROUTES,
  APP_CHECK_HEADER,
  appCheckOutcome,
  monitorAppCheck,
  routePattern,
  type AppCheckServices,
  type AppCheckVerifier,
} from '@/lib/app-check';
import { publicRoute } from '@/lib/auth/route';
import { ConfigError, parseAppCheckMode, parseBrowserSignInConfig, parseConfig } from '@/lib/config';
import { register } from '@/instrumentation';

// App Check in monitor mode (docs/plans/TC.md, TC-5): the server checks the token each call carries
// and writes one line about it, and never refuses a call or changes its answer for it.

// A token-shaped value; the line must never repeat it.
const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxOjI6d2ViOjMifQ.c2lnbmF0dXJlLXBhcnQ';

function call(token?: string, url = 'https://app.example/api/jobs/8d0a6a1e-0000-4000-8000-000000000001/claim?x=1') {
  return new Request(url, { method: 'PUT', headers: token === undefined ? {} : { [APP_CHECK_HEADER]: token } });
}

const context = (params: Record<string, string> = {}) => ({ params: Promise.resolve(params) });

function services(verify: AppCheckVerifier, mode: 'monitor' | 'off' = 'monitor', limitMs?: number): AppCheckServices {
  return { mode: () => mode, verifier: () => verify, ...(limitMs === undefined ? {} : { limitMs }) };
}

const appCheckError = (code: string, causeCode?: string) =>
  Object.assign(new Error('refused'), { code, ...(causeCode ? { cause: { code: causeCode } } : {}) });

let lines: Record<string, unknown>[];
beforeEach(() => {
  lines = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    for (const line of String(chunk).split('\n').filter(Boolean)) lines.push(JSON.parse(line) as Record<string, unknown>);
    return true;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the outcome of one call', () => {
  it('is valid when App Check signed the token', async () => {
    const verify = vi.fn(async () => ({ app_id: '1:2:web:3' }));
    expect(await appCheckOutcome(call(TOKEN), services(verify))).toBe('valid');
    expect(verify).toHaveBeenCalledWith(TOKEN);
  });

  it('is missing when no token is sent, without asking the SDK', async () => {
    const verify = vi.fn(async () => ({}));
    expect(await appCheckOutcome(call(), services(verify))).toBe('missing');
    expect(await appCheckOutcome(call('  '), services(verify))).toBe('missing');
    expect(verify).not.toHaveBeenCalled();
  });

  it('is invalid for a bad, forged or expired token', async () => {
    for (const error of [
      appCheckError('app-check/invalid-argument'),
      appCheckError('app-check/invalid-argument', 'invalid-token'),
      appCheckError('app-check/app-check-token-expired', 'token-expired'),
    ]) {
      expect(await appCheckOutcome(call(TOKEN), services(async () => Promise.reject(error)))).toBe('invalid');
    }
  });

  it('is unverified when the check cannot finish, which is not the token’s fault', async () => {
    for (const error of [
      appCheckError('app-check/invalid-argument', 'key-fetch-error'),
      appCheckError('app-check/invalid-credential'),
      new Error('socket hang up'),
    ]) {
      expect(await appCheckOutcome(call(TOKEN), services(async () => Promise.reject(error)))).toBe('unverified');
    }
    const broken: AppCheckServices = {
      mode: () => 'monitor',
      verifier: () => {
        throw new Error('no project');
      },
    };
    expect(await appCheckOutcome(call(TOKEN), broken)).toBe('unverified');
  });

  it('is unverified when the check takes longer than 2 seconds', async () => {
    vi.useFakeTimers();
    const outcome = appCheckOutcome(call(TOKEN), services(() => new Promise(() => {})));
    await vi.advanceTimersByTimeAsync(1_999);
    let settled = false;
    void outcome.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBe('unverified');
  });
});

describe('monitor mode', () => {
  it('writes one line with the outcome, method, route pattern and status, and nothing else', async () => {
    await monitorAppCheck(call(TOKEN), () => Response.json({ ok: true }), services(async () => ({})));
    expect(lines).toEqual([
      { severity: 'INFO', message: 'App Check', outcome: 'valid', method: 'PUT', route: '/api/jobs/[jobId]/claim', status: 200 },
    ]);
    expect(JSON.stringify(lines)).not.toContain(TOKEN);
  });

  it('never changes the answer, whatever the outcome', async () => {
    const outcomes: [string | undefined, AppCheckVerifier][] = [
      [TOKEN, async () => ({})],
      [undefined, async () => ({})],
      [TOKEN, async () => Promise.reject(appCheckError('app-check/invalid-argument'))],
      [TOKEN, async () => Promise.reject(new Error('down'))],
    ];
    for (const status of [200, 201, 401, 403, 404, 503]) {
      for (const [token, verify] of outcomes) {
        const answer = new Response('body', { status, headers: { 'X-Kept': 'yes' } });
        const response = await monitorAppCheck(call(token), () => answer, services(verify));
        expect(response).toBe(answer);
        expect(response.status).toBe(status);
      }
    }
    expect(lines.map((line) => line.outcome)).toEqual(
      Array.from({ length: 6 }, () => ['valid', 'missing', 'invalid', 'unverified']).flat(),
    );
  });

  it('lets a handler’s error through unchanged and records it as 500', async () => {
    const fault = new Error('handler fault');
    await expect(
      monitorAppCheck(call(), () => Promise.reject(fault), services(async () => ({}))),
    ).rejects.toBe(fault);
    expect(lines).toMatchObject([{ outcome: 'missing', status: 500 }]);
  });

  it('writes nothing and checks nothing when off', async () => {
    const verify = vi.fn(async () => ({}));
    const answer = new Response(null, { status: 204 });
    expect(await monitorAppCheck(call(TOKEN), () => answer, services(verify, 'off'))).toBe(answer);
    expect(verify).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  it('is what a route wrapper does on every call', async () => {
    vi.stubEnv('APP_CHECK_MODE', undefined);
    vi.stubEnv('APP_ENV', 'local');
    // As Next.js calls it: with the request and the route's context, whatever the handler declares.
    const route = publicRoute(async () => new Response('ok', { status: 202 })) as unknown as (
      request: Request,
      routeContext: ReturnType<typeof context>,
    ) => Promise<Response>;
    const response = await route(call(undefined, 'https://app.example/api/health'), context());
    expect(response.status).toBe(202);
    expect(lines).toEqual([
      { severity: 'INFO', message: 'App Check', outcome: 'missing', method: 'PUT', route: '/api/health', status: 202 },
    ]);
  });
});

describe('the route pattern', () => {
  it('names each parameter instead of its value and drops the query', () => {
    expect(routePattern('https://a.example/api/companies/c1/invitations/i%202/cancel?token=x')).toBe(
      '/api/companies/[companyId]/invitations/[invitationId]/cancel',
    );
    expect(routePattern('https://a.example/api/jobs/j1/')).toBe('/api/jobs/[jobId]');
    expect(routePattern('https://a.example/api/not-a-route')).toBe('unknown');
    expect(routePattern('not a url')).toBe('unknown');
  });

  it('keeps the fixed segments when a value is spelt like one', () => {
    expect(routePattern('https://a.example/api/sign-in/api')).toBe('/api/sign-in/[address]');
    expect(routePattern('https://a.example/api/sign-in/sign-in')).toBe('/api/sign-in/[address]');
    expect(routePattern('https://a.example/api/jobs/claim/claim')).toBe('/api/jobs/[jobId]/claim');
    expect(routePattern('https://a.example/api/prices/versions/restore/restore')).toBe('/api/prices/versions/[versionId]/restore');
  });

  it('gives each route its own pattern: no two patterns match one address', () => {
    for (const pattern of API_ROUTES) {
      expect(routePattern(`https://a.example${pattern.replace(/\[[^\]]+\]/g, 'x')}`), pattern).toBe(pattern);
    }
  });

  it('covers every API route file', () => {
    const files = readdirSync(fileURLToPath(new URL('../../src/app/api', import.meta.url)), { recursive: true, encoding: 'utf8' })
      .filter((file) => path.basename(file) === 'route.ts')
      .map((file) => `/api/${path.dirname(file).split(path.sep).join('/')}`)
      .sort();
    expect([...API_ROUTES].sort()).toEqual(files);
  });
});

describe('the APP_CHECK_MODE setting', () => {
  const base = { APP_ENV: 'test' };

  it('is monitor when unset or empty, and off when set to off', () => {
    expect(parseAppCheckMode(base)).toBe('monitor');
    expect(parseAppCheckMode({ ...base, APP_CHECK_MODE: '' })).toBe('monitor');
    expect(parseAppCheckMode({ ...base, APP_CHECK_MODE: 'off' })).toBe('off');
  });

  it('refuses enforce, so nothing can make App Check refuse a call before TC-13', () => {
    expect(() => parseConfig({ ...base, APP_CHECK_MODE: 'enforce' })).toThrow(ConfigError);
    expect(() => parseConfig({ ...base, APP_CHECK_MODE: 'enforce' })).toThrow(/APP_CHECK_MODE/);
  });

  it('stops the server at start-up on enforce', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('APP_ENV', 'test');
    vi.stubEnv('APP_CHECK_MODE', 'enforce');
    void register();
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(logged.mock.calls[0]?.[0])).toMatch(/APP_CHECK_MODE/);
  });
});

describe('the browser settings', () => {
  const emulator = { APP_ENV: 'local', GOOGLE_CLOUD_PROJECT: 'demo-dryscope', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' };
  const APP_ID = '1:123456789012:web:0123456789abcdef';
  const SITE_KEY = '6Lc_test-site-key_0123456789abcdefghij';

  it('give the browser the app id and site key only when both are set', () => {
    expect(parseBrowserSignInConfig({ ...emulator, FIREBASE_APP_ID: APP_ID, APP_CHECK_SITE_KEY: SITE_KEY })).toMatchObject({
      appId: APP_ID,
      appCheckSiteKey: SITE_KEY,
    });
    for (const env of [
      emulator,
      { ...emulator, FIREBASE_APP_ID: APP_ID },
      { ...emulator, APP_CHECK_SITE_KEY: SITE_KEY },
      // An empty key (TC-5 merges before TC-9 makes one) turns App Check off and starts the server.
      { ...emulator, FIREBASE_APP_ID: APP_ID, APP_CHECK_SITE_KEY: '' },
    ]) {
      const config = parseBrowserSignInConfig(env);
      expect(config).not.toBeNull();
      expect(config).not.toHaveProperty('appId');
      expect(config).not.toHaveProperty('appCheckSiteKey');
    }
  });

  it('refuses a malformed app id or key without echoing it', () => {
    expect(() => parseConfig({ APP_ENV: 'test', FIREBASE_APP_ID: 'not an id' })).toThrow(/FIREBASE_APP_ID/);
    expect(() => parseConfig({ APP_ENV: 'test', APP_CHECK_SITE_KEY: 'secret value!' })).toThrow(/APP_CHECK_SITE_KEY/);
    expect(() => parseConfig({ APP_ENV: 'test', APP_CHECK_SITE_KEY: 'secret value!' })).not.toThrow(/secret value/);
  });
});
