// Browser and phone error reports (TC-2, docs/plans/TC.md). Errors the page throws, promise
// rejections nobody handled, and what React's error boundaries catch are built into a report
// (src/lib/client-error-report.ts: nothing about the person, company or address) and sent to
// POST /api/client-errors, which writes them to the server log for Error Reporting. Google has no
// browser-safe way to call Error Reporting directly, so the app's own route is the way in.
//
// Limits, so a broken page cannot flood the route or the phone:
//   - at most 10 reports per page load;
//   - at most 20 wait in memory while the phone has no signal, and none is ever stored: there is no
//     new phone store, and what is still waiting is gone when the page closes;
//   - a request is under the server's 8 KB limit; more reports than fit go in the next request.
//
// Sending: reports gather for a moment and go as one batch. Each goes with `keepalive`, so a request
// started as the page hides or closes (`visibilitychange`, `pagehide`) is not cut off. fetchLater()
// is not used: Chrome only, and its send cannot tell the page a request failed, which the wait-offline
// rule needs. Offline (or a request that could not reach the server), the reports stay and go on the
// `online` event or when the page is visible again. An answer from the server, of any status, ends
// that report's story: nothing is retried into a refusal.

import { buildReport, type ClientErrorReport } from './client-error-report';

export const CLIENT_ERRORS_PATH = '/api/client-errors';
export const MAX_REPORTS_PER_LOAD = 10;
export const MAX_REPORTS_WAITING = 20;
// The server refuses a body over 8,192 bytes; stay under it with room for the envelope.
const MAX_BODY_BYTES = 8000;
// The server accepts at most 20 reports in one request.
const MAX_REPORTS_PER_REQUEST = 20;
const SETTLE_MS = 1500;

type ReporterOptions = {
  // Resolves true when the server answered (any status), false when the request could not get there.
  send: (body: string) => Promise<boolean>;
  isOnline: () => boolean;
  isVisible: () => boolean;
  where: () => { pathname: string; userAgent: string };
  maxPerLoad?: number;
  maxWaiting?: number;
};

export type Reporter = {
  report: (thrown: unknown, fallbackName?: string) => void;
  flush: () => Promise<void>;
  // Start every waiting request now, without waiting for answers: the page is hiding or closing.
  flushNow: () => void;
  waiting: () => number;
};

const bytes = (reports: ClientErrorReport[]) => new TextEncoder().encode(JSON.stringify({ reports })).length;

export function createReporter(options: ReporterOptions): Reporter {
  const maxPerLoad = options.maxPerLoad ?? MAX_REPORTS_PER_LOAD;
  const maxWaiting = options.maxWaiting ?? MAX_REPORTS_WAITING;
  const waiting: ClientErrorReport[] = [];
  let counted = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Sends not yet answered; whether a flush loop is running; whether a flush was asked for (online,
  // visible, a new report) while a send was out, to run once the sends have settled.
  let pending = 0;
  let flushing = false;
  let requested = false;

  function disarm() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  function arm(ms: number) {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, ms);
  }

  // As many waiting reports as fit one request, oldest first; always at least one.
  function nextBatch(): ClientErrorReport[] {
    const batch: ClientErrorReport[] = [];
    while (waiting.length > 0 && batch.length < MAX_REPORTS_PER_REQUEST) {
      if (batch.length > 0 && bytes([...batch, waiting[0]!]) > MAX_BODY_BYTES) break;
      batch.push(waiting.shift()!);
    }
    return batch;
  }

  // Sends one batch; one that could not reach the server goes back to wait, oldest first.
  async function sendBatch(batch: ClientErrorReport[]): Promise<boolean> {
    pending += 1;
    const reached = await options.send(JSON.stringify({ reports: batch })).catch(() => false);
    pending -= 1;
    if (!reached) {
      waiting.unshift(...batch);
      waiting.splice(maxWaiting);
    }
    if (pending === 0 && requested && !flushing) void flush();
    return reached;
  }

  async function flush(): Promise<void> {
    disarm();
    if (flushing || pending > 0) {
      requested = true;
      return;
    }
    flushing = true;
    requested = false;
    try {
      while (waiting.length > 0 && options.isOnline()) {
        if (!(await sendBatch(nextBatch()))) break;
      }
    } finally {
      flushing = false;
    }
    if (requested) void flush();
  }

  function flushNow(): void {
    disarm();
    if (!options.isOnline()) return;
    while (waiting.length > 0) void sendBatch(nextBatch());
  }

  function report(thrown: unknown, fallbackName?: string): void {
    if (counted >= maxPerLoad) return;
    counted += 1;
    if (waiting.length >= maxWaiting) return;
    waiting.push(buildReport(thrown, options.where(), fallbackName));
    arm(options.isVisible() ? SETTLE_MS : 0);
  }

  return { report, flush, flushNow, waiting: () => waiting.length };
}

// The parts of `window` the reporter uses, so a test can stand a fake page in for it.
export type ClientEnv = {
  addEventListener: (type: string, listener: (event: never) => void) => void;
  removeEventListener: (type: string, listener: (event: never) => void) => void;
  location: { pathname: string };
  navigator: { userAgent: string; onLine: boolean };
  document: {
    visibilityState: string;
    addEventListener: (type: string, listener: () => void) => void;
    removeEventListener: (type: string, listener: () => void) => void;
  };
  fetch: (url: string, init: RequestInit) => Promise<unknown>;
};

const browserEnv = () => window as unknown as ClientEnv;

async function post(env: ClientEnv, body: string): Promise<boolean> {
  try {
    await env.fetch(CLIENT_ERRORS_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
      credentials: 'omit',
      cache: 'no-store',
    });
    return true;
  } catch {
    return false;
  }
}

// One reporter (and so one count of 10) per page, however many times the hooks are installed.
const reporters = new WeakMap<object, Reporter>();
const installed = new WeakSet<object>();

function reporterFor(env: ClientEnv): Reporter {
  let reporter = reporters.get(env);
  if (!reporter) {
    reporter = createReporter({
      send: (body) => post(env, body),
      isOnline: () => env.navigator.onLine !== false,
      isVisible: () => env.document.visibilityState !== 'hidden',
      where: () => ({ pathname: env.location.pathname, userAgent: env.navigator.userAgent }),
    });
    reporters.set(env, reporter);
  }
  return reporter;
}

// Hooks the page's error, rejection and lifecycle events. Returns the cleanup. Safe to call more
// than once: a second call while the hooks are in place does nothing.
export function installClientErrors(env: ClientEnv = browserEnv()): () => void {
  if (installed.has(env)) return () => {};
  installed.add(env);
  const reporter = reporterFor(env);
  // A hook must never raise a second error from inside an error.
  const guard = (run: () => void) => () => {
    try {
      run();
    } catch {
      // Nothing about the fault is safe to repeat.
    }
  };
  const onError = (event: { error?: unknown; message?: unknown }) =>
    guard(() => reporter.report(event.error ?? event.message))();
  const onRejection = (event: { reason?: unknown }) => guard(() => reporter.report(event.reason, 'UnhandledRejection'))();
  const onPageHide = guard(() => reporter.flushNow());
  const onOnline = guard(() => void reporter.flush());
  const onVisibility = guard(() => {
    if (env.document.visibilityState === 'hidden') reporter.flushNow();
    else void reporter.flush();
  });
  env.addEventListener('error', onError as (event: never) => void);
  env.addEventListener('unhandledrejection', onRejection as (event: never) => void);
  env.addEventListener('pagehide', onPageHide);
  env.addEventListener('online', onOnline);
  env.document.addEventListener('visibilitychange', onVisibility);
  return () => {
    installed.delete(env);
    env.removeEventListener('error', onError as (event: never) => void);
    env.removeEventListener('unhandledrejection', onRejection as (event: never) => void);
    env.removeEventListener('pagehide', onPageHide);
    env.removeEventListener('online', onOnline);
    env.document.removeEventListener('visibilitychange', onVisibility);
  };
}

// For app/error.tsx and app/global-error.tsx: what an error boundary caught. The global boundary
// replaces the root layout, so this installs the hooks itself.
export function reportBoundaryError(error: unknown, env: ClientEnv = browserEnv()): void {
  try {
    installClientErrors(env);
    reporterFor(env).report(error);
  } catch {
    // Nothing about the fault is safe to repeat.
  }
}
