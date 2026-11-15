import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import {
  BROWSER_FAMILIES,
  MAX_FRAMES,
  MAX_MESSAGE,
  cleanFrames,
  errorName,
  isKnownRoute,
  scrubMessage,
} from './client-error-report';
import { emit, log } from './log';
import { cspReports } from './csp-report';

// POST /api/client-errors (TC-2, docs/plans/TC.md): the way a browser or phone error reaches Error
// Reporting. Public, because the sign-in pages fail before anyone is signed in; so it is write-only
// and reads nothing: no database, no Firestore, no identity (tests/unit/client-errors-route.test.ts
// calls it with both trapped). What it accepts is bounded three ways, and what it writes is built
// from fixed fields only:
//   - the body: JSON, at most 8 KB (counted in bytes while it is read, never trusted from the
//     header), at most 20 reports, every field bounded by the schema below;
//   - the rate: each caller (its connecting address) may have at most 20 reports a minute written, so one caller cannot use up the instance's allowance; and each
//     instance writes at most 60 reports a minute in all. The rest are answered 202 (the sender
//     can do nothing about them) and only counted. The instance cap logs nothing; a caller hitting
//     its own cap writes one fixed line a minute with no address in it (S3 security review, F6),
//     so a flood is never also a log flood;
//   - the content: every report is scrubbed again with the browser's own rules before it is
//     written, and a frame that is not the app's own script is dropped. Nothing else in the body is
//     read, so a field a caller invents is not written.
// Native CSP reports use this same intake and all its caps (csp-report.ts). Only fixed categories
// and a page route pattern survive; no URL, script sample or original policy is written.
// The event is Error Reporting's ReportedErrorEvent shape in a JSON log line
// (docs.cloud.google.com/error-reporting/docs/formatting-error-messages), service
// "dryscope-web-client", so browser errors group apart from the server's "dryscope-api".

export const CLIENT_SERVICE = 'dryscope-web-client';
export const MAX_BODY_BYTES = 8192;
export const MAX_REPORTS = 20;
export const REPORTS_PER_MINUTE = 60;
export const REPORTS_PER_CALLER_PER_MINUTE = 20;
export const MAX_CALLERS = 5000;

const reportSchema = z.object({
  name: z.string().max(64),
  message: z.string().max(2 * MAX_MESSAGE),
  stack: z.array(z.string().max(MAX_MESSAGE)).max(MAX_FRAMES),
  route: z.string().max(120),
  browser: z.enum(BROWSER_FAMILIES),
});

const bodySchema = z.object({ reports: z.array(reportSchema).min(1).max(MAX_REPORTS) });
type Report = z.infer<typeof reportSchema>;

const NO_STORE = { 'cache-control': 'no-store' };
const COMMIT = /^[0-9a-f]{40}$/;

function refuse(error: string, status: number): Response {
  return Response.json({ error }, { status, headers: NO_STORE });
}

// Reports in the current minute, per instance. A fixed window: simple, and exact enough for a cap
// whose job is to bound a flood, not to meter a fair share.
let windowStart = 0;
let used = 0;
let limited = 0;

function take(count: number, now: number): number {
  if (now - windowStart >= 60_000) {
    windowStart = now;
    used = 0;
  }
  const allowed = Math.min(count, REPORTS_PER_MINUTE - used);
  used += allowed;
  limited += count - allowed;
  return allowed;
}

// Reports left unwritten by the cap since the instance started. Counted, never logged.
export function limitedReports(): number {
  return limited;
}

export function resetClientErrorLimit(): void {
  windowStart = 0;
  used = 0;
  limited = 0;
  callers.clear();
  callerLimited = 0;
  capLoggedAt = -Infinity;
}

// Per-caller shares, per instance. The key is a SHA-256 of the connecting address: only the hash is
// held, in memory, and it is never logged. Nothing the caller chooses (user agent, other headers)
// is part of the key, so a caller cannot buy a new share by changing it. Cloud Run appends the address
// it saw as the LAST X-Forwarded-For entry; anything before it is the caller's own claim, so only
// the last is read. A request with no usable address (never on Cloud Run) has no share of its own
// and is held by the instance cap alone.
const callers = new Map<string, { start: number; used: number }>();
let callerLimited = 0;
let capLoggedAt = -Infinity;

// Reports left unwritten by a caller's own cap since the instance started. Counted, never logged.
export function callerLimitedReports(): number {
  return callerLimited;
}

// Callers held right now, for the test that proves the table stays bounded.
export function callerTableSize(): number {
  return callers.size;
}

function callerKey(headers: Headers): string | null {
  const last = headers.get('x-forwarded-for')?.split(',').pop()?.trim() ?? '';
  if (isIP(last) === 0) return null;
  return createHash('sha256').update(last).digest('hex');
}

function takeCaller(key: string, count: number, now: number): number {
  let entry = callers.get(key);
  if (!entry || now - entry.start >= 60_000) {
    if (!entry && callers.size >= MAX_CALLERS) {
      for (const [k, e] of callers) if (now - e.start >= 60_000) callers.delete(k);
      // Still full of live callers: drop the oldest, so the table stays bounded.
      if (callers.size >= MAX_CALLERS) callers.delete(callers.keys().next().value as string);
    }
    entry = { start: now, used: 0 };
    callers.set(key, entry);
  }
  const allowed = Math.min(count, REPORTS_PER_CALLER_PER_MINUTE - entry.used);
  entry.used += allowed;
  callerLimited += count - allowed;
  return allowed;
}

// The body as text, or null when it is over the limit. The limit is enforced on the bytes as they
// arrive, so a sender cannot make the server buffer more by understating its length.
async function readLimited(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

function eventFor(report: Report, version: string): Record<string, unknown> {
  const name = errorName(report.name);
  const message = scrubMessage(report.message);
  const text = [message ? `${name}: ${message}` : name, ...cleanFrames(report.stack)].join('\n');
  return {
    '@type': 'type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent',
    severity: 'ERROR',
    serviceContext: { service: CLIENT_SERVICE, version },
    message: text,
    stack_trace: text,
    context: { httpRequest: { url: isKnownRoute(report.route) ? report.route : 'unknown' } },
    browser: report.browser,
  };
}

export async function handleClientErrors(request: Request): Promise<Response> {
  const type = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!['application/json', 'application/csp-report', 'application/reports+json'].includes(type))
    return refuse('unsupported_media_type', 415);
  const text = await readLimited(request);
  if (text === null) return refuse('payload_too_large', 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return refuse('invalid_request', 400);
  }
  const native = type !== 'application/json';
  const csp = native ? cspReports(body, type, request.headers.get('user-agent') ?? '') : null;
  if (native && csp === null) return refuse('invalid_request', 400);
  const parsed = bodySchema.safeParse(native ? { reports: csp } : body);
  if (!parsed.success) return refuse('invalid_request', 400);

  const now = Date.now();
  const key = callerKey(request.headers);
  const mine =
    key === null ? parsed.data.reports.length : takeCaller(key, parsed.data.reports.length, now);
  if (mine < parsed.data.reports.length && now - capLoggedAt >= 60_000) {
    capLoggedAt = now;
    log(
      'WARNING',
      'client error reports capped for one caller',
      { component: 'client-errors', event: 'caller_cap' },
      request.headers,
    );
  }
  // Only what the caller's share allows counts against the instance's allowance.
  const reports = parsed.data.reports.slice(0, take(mine, now));
  const commit = process.env.APP_COMMIT;
  const version = commit && COMMIT.test(commit) ? commit : 'unknown';
  for (const report of reports) emit(eventFor(report, version), request.headers);
  return Response.json({ accepted: reports.length }, { status: 202, headers: NO_STORE });
}
