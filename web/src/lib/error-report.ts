import { emit, type HeaderSource } from './log';

// One Error Reporting event for an uncaught server error, written as a JSON log line
// (docs.cloud.google.com/error-reporting/docs/formatting-error-messages): `serviceContext` marks it
// as a ReportedErrorEvent (`@type` makes Error Reporting take it even when a thrown non-Error has no
// frames), `stack_trace` is what Error Reporting groups on, and `context.httpRequest`
// names the request. No client library; Cloud Run sends stdout to Logging and Logging feeds Error
// Reporting.
//
// What goes in is built from parts that cannot hold data (hard rule 6), never copied:
//   - the error CLASS NAME, if it looks like an identifier;
//   - the app's own refusal code, if the error has one in the app's lowercase snake form
//     (IdentityRefusal, JobError, ... all use it; library codes such as ECONNRESET, 23505 or
//     auth/invalid-token do not match and are left out);
//   - the stack FRAMES only, never the error's message text (a library message can quote a
//     token, a connection string, an email or a coordinate);
//   - the HTTP method and the route PATTERN (/api/jobs/[jobId]), never the request path, query,
//     headers or body.
export const SERVICE = 'dryscope-api';

const CLASS_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const REFUSAL_CODE = /^[a-z][a-z0-9_]{1,63}$/;
const METHOD = /^[A-Z]{3,10}$/;
const ROUTE_PATTERN = /^\/[\w\-./[\]()@]{0,200}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const MAX_FRAMES = 40;
const MAX_FRAME_LENGTH = 300;

type RequestInfo = { method?: unknown; headers?: HeaderSource };
type ContextInfo = { routePath?: unknown };

export function errorHeadline(error: unknown): string {
  const name = error instanceof Error && CLASS_NAME.test(error.name) ? error.name : 'Error';
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && REFUSAL_CODE.test(code) && error instanceof Error ? `${name}: ${code}` : name;
}

function frames(error: unknown): string[] {
  if (!(error instanceof Error) || typeof error.stack !== 'string') return [];
  // Cut the message out first: one that holds a line shaped like a frame must not pass as one.
  const stack = error.message ? error.stack.replace(error.message, '') : error.stack;
  return stack
    .split('\n')
    .filter((line) => /^\s+at /.test(line))
    .slice(0, MAX_FRAMES)
    .map((line) => line.slice(0, MAX_FRAME_LENGTH));
}

export function reportServerError(error: unknown, request: RequestInfo | undefined, context: ContextInfo | undefined): void {
  const method = typeof request?.method === 'string' && METHOD.test(request.method) ? request.method : 'UNKNOWN';
  const route = typeof context?.routePath === 'string' && ROUTE_PATTERN.test(context.routePath) ? context.routePath : 'unknown';
  const commit = process.env.APP_COMMIT;
  const stack = [errorHeadline(error), ...frames(error)].join('\n');
  emit({
    '@type': 'type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent',
    severity: 'ERROR',
    serviceContext: { service: SERVICE, version: commit && COMMIT.test(commit) ? commit : 'unknown' },
    message: stack,
    stack_trace: stack,
    context: { httpRequest: { method, url: route } },
  }, request?.headers);
}
