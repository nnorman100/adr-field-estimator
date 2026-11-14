import { ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APP_CHECK_HEADER,
  appCheckSettings,
  BoundedRecaptchaProvider,
  keepDebugTokenOnlyLocally,
  tokenHeaders,
} from '@/lib/app-check-client';
import type { BrowserSignInConfig } from '@/lib/config';

// The browser side of App Check (TC-5): attestation and the /api header wait are both bounded, so
// App Check never holds a sign-in or a call, and the debug provider runs only on a developer machine.

type Token = { token: string; expireTimeMillis: number; issuedAtTimeMillis: number };
type Inner = { getToken(isLimitedUse?: boolean): Promise<Token> };
const prototype = ReCaptchaEnterpriseProvider.prototype as unknown as Inner;

const token = (value: string, ttlMs = 3_600_000): Token => ({
  token: value,
  expireTimeMillis: Date.now() + ttlMs,
  issuedAtTimeMillis: Date.now(),
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the bounded reCAPTCHA Enterprise provider', () => {
  it('builds on the SDK provider’s own attestation (fails if a Firebase upgrade removes it)', () => {
    expect(typeof prototype.getToken).toBe('function');
    expect(new BoundedRecaptchaProvider('site-key')).toBeInstanceOf(ReCaptchaEnterpriseProvider);
  });

  it('passes a token through when attestation answers in time', async () => {
    vi.spyOn(prototype, 'getToken').mockResolvedValue(token('fresh'));
    await expect(new BoundedRecaptchaProvider('site-key').getToken()).resolves.toMatchObject({ token: 'fresh' });
  });

  it('passes the SDK’s own refusal (throttling) through unchanged', async () => {
    const throttled = Object.assign(new Error('throttled'), { code: 'appCheck/throttled' });
    vi.spyOn(prototype, 'getToken').mockRejectedValue(throttled);
    await expect(new BoundedRecaptchaProvider('site-key').getToken()).rejects.toBe(throttled);
  });

  it('gives up on an attestation that never answers (a blocked reCAPTCHA script)', async () => {
    vi.useFakeTimers();
    vi.spyOn(prototype, 'getToken').mockReturnValue(new Promise(() => {}));
    const provider = new BoundedRecaptchaProvider('site-key', 3_000);
    const first = provider.getToken();
    const outcome = first.then(
      () => 'token',
      () => 'gave up',
    );
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await outcome).toBe('gave up');
    // Still running: the next request is refused at once rather than waiting again.
    let settled = false;
    void provider.getToken().catch(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
  });

  it('keeps a token that arrived after it gave up, for the next request', async () => {
    vi.useFakeTimers();
    let answer: (value: Token) => void = () => {};
    const inner = vi.spyOn(prototype, 'getToken').mockReturnValue(new Promise<Token>((done) => (answer = done)));
    const provider = new BoundedRecaptchaProvider('site-key', 3_000);
    const first = provider.getToken().catch(() => null);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await first).toBeNull();
    answer(token('late'));
    await vi.advanceTimersByTimeAsync(0);
    await expect(provider.getToken()).resolves.toMatchObject({ token: 'late' });
    expect(inner).toHaveBeenCalledTimes(1);
  });
});

describe('the /api header', () => {
  it('carries the token when one comes in time', async () => {
    const headers = tokenHeaders(async () => 'app-check-token', 3_000);
    expect(await headers()).toEqual({ [APP_CHECK_HEADER]: 'app-check-token' });
  });

  it('is left out when no token can be had', async () => {
    const headers = tokenHeaders(async () => Promise.reject(new Error('no token')), 3_000);
    expect(await headers()).toEqual({});
  });

  it('waits at most 3 seconds, then the call goes without it', async () => {
    vi.useFakeTimers();
    let answer: (value: string) => void = () => {};
    const fetchToken = vi.fn(() => new Promise<string>((done) => (answer = done)));
    const headers = tokenHeaders(fetchToken, 3_000);
    const first = headers();
    await vi.advanceTimersByTimeAsync(2_999);
    let settled = false;
    void first.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await first).toEqual({});
    // While that request is still running, later calls do not wait at all.
    expect(await headers()).toEqual({});
    expect(fetchToken).toHaveBeenCalledTimes(1);
    // Once it answers, calls carry tokens again.
    answer('late-token');
    await vi.advanceTimersByTimeAsync(0);
    fetchToken.mockResolvedValue('next-token');
    expect(await headers()).toEqual({ [APP_CHECK_HEADER]: 'next-token' });
  });
});

describe('the debug provider', () => {
  it('is honoured on localhost and 127.0.0.1 only', () => {
    for (const hostname of ['localhost', '127.0.0.1']) {
      const scope = { FIREBASE_APPCHECK_DEBUG_TOKEN: true as unknown, location: { hostname } };
      expect(keepDebugTokenOnlyLocally(scope)).toBe(true);
      expect(scope.FIREBASE_APPCHECK_DEBUG_TOKEN).toBe(true);
    }
    for (const hostname of ['dryscope-api-test-abc.a.run.app', 'localhost.example.com', '127.0.0.2', '']) {
      const scope: { FIREBASE_APPCHECK_DEBUG_TOKEN?: unknown; location: { hostname: string } } = {
        FIREBASE_APPCHECK_DEBUG_TOKEN: 'a-registered-token',
        location: { hostname },
      };
      expect(keepDebugTokenOnlyLocally(scope)).toBe(false);
      expect(scope).not.toHaveProperty('FIREBASE_APPCHECK_DEBUG_TOKEN');
    }
  });
});

describe('when App Check starts', () => {
  const config: BrowserSignInConfig = { apiKey: 'k', authDomain: 'a.example', projectId: 'p', authEmulatorUrl: null };

  it('only with both the app id and the site key', () => {
    expect(appCheckSettings(config)).toBeNull();
    expect(appCheckSettings({ ...config, appId: '1:2:web:3' })).toBeNull();
    expect(appCheckSettings({ ...config, appCheckSiteKey: 'key' })).toBeNull();
    expect(appCheckSettings({ ...config, appId: '1:2:web:3', appCheckSiteKey: 'key' })).toEqual({
      appId: '1:2:web:3',
      siteKey: 'key',
    });
  });
});
