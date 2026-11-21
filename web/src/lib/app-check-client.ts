import { getApps, type FirebaseApp } from 'firebase/app';
import { getToken, initializeAppCheck, ReCaptchaEnterpriseProvider, type AppCheck } from 'firebase/app-check';
import type { BrowserSignInConfig } from '@/lib/config';

// The browser side of App Check (docs/plans/TC.md, TC-5), in monitor mode: nothing here may stop a
// sign-in or an /api call.
//
// firebase-client.ts starts App Check on each company's Firebase app instance before its Auth is
// used, with the reCAPTCHA Enterprise provider and automatic refresh, when the server has given the
// browser both the web app id and the site key. With either missing (no key yet, TC-9) App Check
// never starts and the app works as it did before it.
//
// Three waits are bounded here, because the SDK bounds none of them:
//   - Firebase Auth and Firestore wait for an App Check token before every request they make
//     (sign-in, ID token refresh, every Firestore stream). The SDK first reads its token cache in
//     IndexedDB, and writes a new token back, with no time limit, so a stalled IndexedDB (the
//     Safari reports of S6 section 2) would hold them. boundTokenWaits makes the token source they
//     share answer within TOKEN_WAIT_MS, without a token when none came in time.
//   - The reCAPTCHA provider waits for Google's script with no error path or time limit.
//     BoundedRecaptchaProvider gives up on an attestation after ATTESTATION_LIMIT_MS; the SDK then
//     clears its running exchange and retries later with its usual back-off.
//   - Our own /api calls (appCheckHeaders) wait at most TOKEN_WAIT_MS for a token, then go without
//     one (the old app's rule).
// In each, while a request that outlasted its wait is still running, later ones go at once
// without waiting again.
//
// The debug provider (self.FIREBASE_APPCHECK_DEBUG_TOKEN, docs: app-check/web/debug-provider) is
// honoured only on localhost and 127.0.0.1: on any other address it is removed before App Check
// starts, so a live page can never run in debug mode.

export const APP_CHECK_HEADER = 'X-Firebase-AppCheck';
export const TOKEN_WAIT_MS = 3_000;
export const ATTESTATION_LIMIT_MS = 3_000;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

type ProviderToken = { token: string; expireTimeMillis: number; issuedAtTimeMillis: number };
type InnerProvider = { getToken(isLimitedUse?: boolean): Promise<ProviderToken> };

// The SDK's own attestation and token exchange. getToken is left out of the SDK's public types,
// so it is reached through the prototype; tests/unit/app-check-client.test.ts fails if a Firebase
// upgrade removes it.
const recaptchaEnterprise = ReCaptchaEnterpriseProvider.prototype as unknown as InnerProvider;

// The token outlived the attempt it came from: kept for the next request while it has a minute
// left, so a slow attestation is not paid for twice.
const KEEP_LATE_TOKEN_MS = 60_000;

// ReCaptchaEnterpriseProvider with a time limit on each attestation. It stays a
// ReCaptchaEnterpriseProvider (the SDK's isEqual and initialize, which loads the reCAPTCHA
// widget, are inherited), so the token exchange and the console registration are the reCAPTCHA
// Enterprise ones. Rejections from the SDK (throttling among them) pass through unchanged.
export class BoundedRecaptchaProvider extends ReCaptchaEnterpriseProvider {
  private pending: Promise<ProviderToken> | null = null;
  private late: ProviderToken | null = null;

  constructor(
    siteKey: string,
    private readonly limitMs: number = ATTESTATION_LIMIT_MS,
  ) {
    super(siteKey);
  }

  getToken(isLimitedUse = false): Promise<ProviderToken> {
    const late = this.late;
    this.late = null;
    if (late && late.expireTimeMillis > Date.now() + KEEP_LATE_TOKEN_MS) return Promise.resolve(late);
    if (this.pending) return Promise.reject(new Error('App Check attestation still running'));
    let timedOut = false;
    const attempt = recaptchaEnterprise.getToken.call(this, isLimitedUse);
    this.pending = attempt;
    attempt.then(
      (token) => {
        if (timedOut) this.late = token;
      },
      () => undefined,
    );
    void attempt
      .finally(() => {
        this.pending = null;
      })
      .catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error('App Check attestation took too long'));
      }, this.limitMs);
    });
    return Promise.race([attempt, limit]).finally(() => clearTimeout(timer));
  }
}

type DebugScope = { FIREBASE_APPCHECK_DEBUG_TOKEN?: unknown; location?: { hostname?: string } };

// Removes a debug token anywhere but a developer machine. True when debug mode may run here.
export function keepDebugTokenOnlyLocally(scope: DebugScope = globalThis as DebugScope): boolean {
  const local = LOCAL_HOSTS.has(scope.location?.hostname ?? '');
  if (!local) delete scope.FIREBASE_APPCHECK_DEBUG_TOKEN;
  return local;
}

// The App Check site key and app id, when the server gave both.
export function appCheckSettings(config: BrowserSignInConfig): { appId: string; siteKey: string } | null {
  return config.appId && config.appCheckSiteKey ? { appId: config.appId, siteKey: config.appCheckSiteKey } : null;
}

// Started instances, by app: an app deleted and made again (field-db.ts's Discard) gets a new one.
const started = new WeakMap<FirebaseApp, AppCheck>();
// Most recently started last; the /api header uses the newest whose app still exists. Any
// instance's token is good for this web app, whichever company or person app it came from.
const recent: AppCheck[] = [];

function newest(appCheck: AppCheck): AppCheck {
  const at = recent.indexOf(appCheck);
  if (at >= 0) recent.splice(at, 1);
  recent.push(appCheck);
  return appCheck;
}

// Starts App Check on this Firebase app, once; null when App Check is not set up or cannot start
// here (no window, or the SDK refused), and sign-in then goes on without it.
export function startAppCheck(app: FirebaseApp, config: BrowserSignInConfig): AppCheck | null {
  const settings = appCheckSettings(config);
  if (!settings || typeof window === 'undefined') return null;
  const found = started.get(app);
  if (found) return newest(found);
  keepDebugTokenOnlyLocally();
  try {
    const appCheck = initializeAppCheck(app, {
      provider: new BoundedRecaptchaProvider(settings.siteKey),
      isTokenAutoRefreshEnabled: true,
    });
    boundTokenWaits(app);
    started.set(app, appCheck);
    return newest(appCheck);
  } catch {
    return null;
  }
}

function activeAppCheck(): AppCheck | null {
  const apps = new Set(getApps());
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    if (apps.has(recent[i]!.app)) return recent[i]!;
    recent.splice(i, 1);
  }
  return null;
}

// Wraps an async call so that it answers within waitMs: with its result when that comes in time,
// with fallback() when it is late or fails. While a call that was late is still running, later
// calls answer fallback() at once.
export function boundedWait<A extends unknown[], T>(
  call: (...args: A) => Promise<T>,
  fallback: () => T,
  waitMs: number,
): (...args: A) => Promise<T> {
  let stalled: Promise<unknown> | null = null;
  return async (...args: A): Promise<T> => {
    if (stalled) return fallback();
    const attempt = call(...args).then(
      (value) => ({ value }),
      () => null,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'late'>((done) => {
      timer = setTimeout(() => done('late'), waitMs);
    });
    const result = await Promise.race([attempt, late]);
    clearTimeout(timer);
    if (result === 'late') {
      stalled = attempt;
      void attempt.finally(() => {
        if (stalled === attempt) stalled = null;
      });
      return fallback();
    }
    return result ? result.value : fallback();
  };
}

// A header source with its own "a token request is still running" state.
export function tokenHeaders(fetchToken: () => Promise<string>, waitMs: number = TOKEN_WAIT_MS) {
  return boundedWait(
    async (): Promise<Record<string, string>> => {
      const token = await fetchToken();
      return token ? { [APP_CHECK_HEADER]: token } : {};
    },
    () => ({}),
    waitMs,
  );
}

type InternalTokenResult = { readonly token: string; readonly error?: Error };
type InternalAppCheck = { getToken(forceRefresh?: boolean): Promise<InternalTokenResult> };
type ComponentContainer = {
  getProvider(name: 'app-check-internal'): { getImmediate(options: { optional: true }): InternalAppCheck | null };
};

// Bounds the token wait of the App Check instance Auth and Firestore read their tokens from (the
// SDK's internal 'app-check-internal' component of this app, reached through the app's component
// container, as the SDK's own _getProvider does). A late token gives them an empty one, which
// both send as no App Check header. tests/unit/app-check-client.test.ts fails if a Firebase
// upgrade moves it.
export function boundTokenWaits(app: FirebaseApp, waitMs: number = TOKEN_WAIT_MS): void {
  const { container } = app as FirebaseApp & { container: ComponentContainer };
  const internal = container.getProvider('app-check-internal').getImmediate({ optional: true });
  if (!internal) return;
  internal.getToken = boundedWait(
    internal.getToken.bind(internal),
    () => ({ token: '', error: new Error('App Check token took too long') }),
    waitMs,
  );
}

const headerSources = new WeakMap<AppCheck, () => Promise<Record<string, string>>>();
const freshHeaderSources = new WeakMap<AppCheck, () => Promise<Record<string, string>>>();

// The App Check header for one of this app's /api calls: the token when one comes within
// TOKEN_WAIT_MS, otherwise nothing. Never throws.
export async function appCheckHeaders(forceRefresh = false): Promise<Record<string, string>> {
  const appCheck = activeAppCheck();
  if (!appCheck) return {};
  const sources = forceRefresh ? freshHeaderSources : headerSources;
  let source = sources.get(appCheck);
  if (!source) {
    source = tokenHeaders(async () => (await getToken(appCheck, forceRefresh)).token);
    sources.set(appCheck, source);
  }
  return source();
}
