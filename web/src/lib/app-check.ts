import { getAppCheck } from 'firebase-admin/app-check';
import { firebaseApp } from '@/lib/auth/firebase';
import { parseAppCheckMode, parseIdentityConfig, type AppCheckMode } from '@/lib/config';
import { GENERATED_API_ROUTES } from '@/lib/api-routes.generated';
import { log } from '@/lib/log';

// App Check in monitor mode (docs/plans/TC.md, TC-5). The route wrappers (src/lib/auth/route.ts)
// check the App Check token each browser call carries and write one line about it; they never
// refuse a call for it, and the handler's answer goes out unchanged.
//
// APP_CHECK_MODE is monitor (the default) or off. enforce is refused when the server starts
// (config.ts, through instrumentation.ts) until TC-13 adds the refusal and its alert.
//
// The token is checked with the Admin SDK (getAppCheck().verifyToken()), which verifies it locally
// against App Check's signing keys and caches them. No replay protection: that is beta and costs a
// round trip per call. A check that does not finish in 2 seconds, or cannot run at all, is
// `unverified`; the call has already been answered by then, so a slow check only delays the line
// and, at most, the answer by that limit.
//
// The line holds the outcome, the method, the route pattern and the status, never the token, the
// address with its ids, a user or a body.

export const APP_CHECK_HEADER = 'X-Firebase-AppCheck';
export const VERIFY_LIMIT_MS = 2_000;

export type AppCheckOutcome = 'valid' | 'missing' | 'invalid' | 'unverified';

// Checks one token; resolves when App Check signed it for this project, rejects otherwise.
export type AppCheckVerifier = (token: string) => Promise<unknown>;

export type AppCheckServices = {
  mode: () => AppCheckMode;
  // Called only when a token is present; a throw counts as unverified.
  verifier: () => AppCheckVerifier;
  limitMs?: number;
};

// The project's App Check, through the same Admin SDK app the sign-in checks use.
function adminVerifier(): AppCheckVerifier {
  const appCheck = getAppCheck(firebaseApp(parseIdentityConfig(process.env)));
  return (token) => appCheck.verifyToken(token);
}

export const appCheckServices: AppCheckServices = {
  mode: () => parseAppCheckMode(process.env),
  verifier: adminVerifier,
};

// Errors that mean "this token is not good": bad shape, bad signature, wrong project, expired.
// Anything else (the signing keys could not be fetched, no project, an unknown error) means the
// check could not finish, which is not the token's fault.
function isRefusal(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code !== 'app-check/invalid-argument' && code !== 'app-check/app-check-token-expired') return false;
  const cause = (error as { cause?: { code?: unknown } }).cause;
  return cause?.code !== 'key-fetch-error';
}

export async function appCheckOutcome(
  request: Request,
  services: Pick<AppCheckServices, 'verifier' | 'limitMs'>,
): Promise<AppCheckOutcome> {
  const token = request.headers.get(APP_CHECK_HEADER)?.trim();
  if (!token) return 'missing';
  let check: Promise<AppCheckOutcome>;
  try {
    check = services.verifier()(token).then(
      () => 'valid' as const,
      (error: unknown) => (isRefusal(error) ? 'invalid' : 'unverified'),
    );
  } catch {
    return 'unverified';
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<AppCheckOutcome>((done) => {
    timer = setTimeout(() => done('unverified'), services.limitMs ?? VERIFY_LIMIT_MS);
  });
  try {
    return await Promise.race([check, limit]);
  } finally {
    clearTimeout(timer);
  }
}

// The API routes of the app, as route patterns: one for each route file under src/app/api, made by
// scripts/gen-api-routes.ts (not committed, so a new route never edits a shared list).
// tests/unit/app-check.test.ts checks this matches the route files.
export const API_ROUTES: readonly string[] = GENERATED_API_ROUTES;

// The route pattern a call's address matches, or 'unknown'; the query is never included. A `[name]`
// segment stands for any one non-empty segment and a fixed segment must match exactly, so a
// parameter spelt like a fixed part of the address stays a parameter (/api/jobs/3f2…/claim becomes
// /api/jobs/[jobId]/claim, and /api/sign-in/api becomes /api/sign-in/[address]). No two patterns
// in API_ROUTES match the same address, so the first match is the route.
export function routePattern(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return 'unknown';
  }
  const parts = path.replace(/\/+$/, '').split('/');
  const found = API_ROUTES.find((pattern) => {
    const want = pattern.split('/');
    return want.length === parts.length && want.every((part, i) => (part.startsWith('[') ? parts[i]!.length > 0 : part === parts[i]));
  });
  return found ?? 'unknown';
}

// Runs a route's handler and, in monitor mode, writes the App Check line for the call. The check
// starts before the handler and runs beside it. Whatever it finds, the handler's own answer (or
// its error) is what the caller gets.
export async function monitorAppCheck(
  request: Request,
  run: () => Response | Promise<Response>,
  services: AppCheckServices = appCheckServices,
): Promise<Response> {
  let mode: AppCheckMode;
  try {
    mode = services.mode();
  } catch {
    // The setting is checked at start-up; a server that got this far treats a fault as off.
    mode = 'off';
  }
  if (mode === 'off' || !(request instanceof Request)) return run();
  const outcome = appCheckOutcome(request, services);
  let status = 500;
  try {
    const response = await run();
    status = response.status;
    return response;
  } finally {
    try {
      log('INFO', 'App Check', {
        outcome: await outcome,
        method: request.method,
        route: routePattern(request.url),
        status,
      });
    } catch {
      // The line is a measurement: losing it never changes the answer.
    }
  }
}
