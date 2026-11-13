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
import { emit } from './log';

// POST /api/client-errors (TC-2, docs/plans/TC.md): the way a browser or phone error reaches Error
// Reporting. Public, because the sign-in pages fail before anyone is signed in; so it is write-only
// and reads nothing: no database, no Firestore, no identity (tests/unit/client-errors-route.test.ts
// calls it with both trapped). What it accepts is bounded three ways, and what it writes is built
// from fixed fields only:
//   - the body: JSON, at most 8 KB (counted in bytes while it is read, never trusted from the
//     header), at most 20 reports, every field bounded by the schema below;
//   - the rate: each instance writes at most 60 reports a minute; the rest are answered 202 (the
//     sender can do nothing about them) and only counted, never logged, so a flood cannot also be
//     a log flood;
//   - the content: every report is scrubbed again with the browser's own rules before it is
//     written, and a frame that is not the app's own script is dropped. Nothing else in the body is
//     read, so a field a caller invents is not written.
// The event is Error Reporting's ReportedErrorEvent shape in a JSON log line
// (docs.cloud.google.com/error-reporting/docs/formatting-error-messages), service
// "dryscope-web-client", so browser errors group apart from the server's "dryscope-api".

export const CLIENT_SERVICE = 'dryscope-web-client';
export const MAX_BODY_BYTES = 8192;
export const MAX_REPORTS = 20;
export const REPORTS_PER_MINUTE = 60;

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
  if (!/^application\/json\b/i.test(request.headers.get('content-type') ?? '')) return refuse('unsupported_media_type', 415);
  const text = await readLimited(request);
  if (text === null) return refuse('payload_too_large', 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return refuse('invalid_request', 400);
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return refuse('invalid_request', 400);

  const reports = parsed.data.reports.slice(0, take(parsed.data.reports.length, Date.now()));
  const commit = process.env.APP_COMMIT;
  const version = commit && COMMIT.test(commit) ? commit : 'unknown';
  for (const report of reports) emit(eventFor(report, version), request.headers);
  return Response.json({ accepted: reports.length }, { status: 202, headers: NO_STORE });
}
