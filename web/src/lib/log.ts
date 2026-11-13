// The one structured logger: a single JSON line on stdout, which Cloud Run sends to Cloud Logging.
// Cloud Run's logging agent moves `severity`, `message` and the `logging.googleapis.com/*` keys into
// the log entry itself (docs.cloud.google.com/logging/docs/structured-logging). Nothing else in the
// app writes structured lines, so what may reach Logging is decided here:
//   - only the fields in FIELDS, each a short string, number or boolean (hard rule 6: never a body,
//     a header, a prompt, a transcript, an email, an address, a coordinate or a token);
//   - strings are scrubbed again for emails, bearer tokens, token-shaped values and coordinate pairs,
//     as a second line behind callers that already pass fixed text.
// Server runtime only (it writes to process.stdout); import it from Node code, not the browser.

import { isSpanContextValid, trace } from '@opentelemetry/api';

export type Severity = 'DEBUG' | 'INFO' | 'NOTICE' | 'WARNING' | 'ERROR' | 'CRITICAL';

// The fixed field allowlist. Add a name here only when it can never hold personal data.
const FIELDS = ['component', 'event', 'code', 'status', 'method', 'route', 'errorClass', 'durationMs'] as const;
export type LogFields = Partial<Record<(typeof FIELDS)[number], string | number | boolean>>;

const TRACE_KEY = 'logging.googleapis.com/trace';
const SPAN_KEY = 'logging.googleapis.com/spanId';
const SAMPLED_KEY = 'logging.googleapis.com/trace_sampled';
export type TraceFields = {
  [TRACE_KEY]?: string;
  [SPAN_KEY]?: string;
  [SAMPLED_KEY]?: boolean;
};

const MAX_TEXT = 300;
const REDACTED = '[redacted]';
const SCRUBBERS: RegExp[] = [
  /[^\s@]+@[^\s@]+\.[^\s@]+/g, // email address
  /\bBearer\s+\S+/gi, // authorization value
  /\b[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}\b/g, // JWT-shaped token
  /-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}/g, // latitude, longitude pair
];

export function scrub(text: string): string {
  let out = text;
  for (const pattern of SCRUBBERS) out = out.replace(pattern, REDACTED);
  return out.length > MAX_TEXT ? `${out.slice(0, MAX_TEXT)}...` : out;
}

export type HeaderSource = Headers | Record<string, string | string[] | undefined>;

function header(headers: HeaderSource, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  const value = key === undefined ? undefined : headers[key];
  return Array.isArray(value) ? value[0] : value;
}

const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;

// Links a line to its request. W3C `traceparent` first (version-trace-span-flags), then Cloud Run's
// legacy `X-Cloud-Trace-Context` (TRACE/SPAN;o=1, the span in decimal). Needs GOOGLE_CLOUD_PROJECT
// because Logging wants projects/PROJECT/traces/TRACE on stdout; without it, or with a malformed
// or all-zero trace, no field is added.
export function traceFields(headers: HeaderSource): TraceFields {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) return {};
  let trace: string | undefined;
  let span: string | undefined;
  let sampled: boolean | undefined;

  const parent = header(headers, 'traceparent')?.trim().toLowerCase().split('-');
  if (parent && parent.length >= 4 && parent[0] !== 'ff') {
    trace = parent[1];
    span = parent[2];
    sampled = /^[0-9a-f]{2}$/.test(parent[3]!) ? (parseInt(parent[3]!, 16) & 1) === 1 : undefined;
  } else {
    const legacy = /^([0-9a-fA-F]{32})(?:\/(\d{1,20}))?(?:;o=([01]))?$/.exec(header(headers, 'x-cloud-trace-context')?.trim() ?? '');
    if (legacy) {
      trace = legacy[1]!.toLowerCase();
      if (legacy[2] !== undefined && BigInt(legacy[2]) < 2n ** 64n) span = BigInt(legacy[2]).toString(16).padStart(16, '0');
      if (legacy[3] !== undefined) sampled = legacy[3] === '1';
    }
  }
  if (!trace || !TRACE_ID.test(trace) || /^0+$/.test(trace)) return {};
  const out: TraceFields = { [TRACE_KEY]: `projects/${project}/traces/${trace}` };
  if (span && SPAN_ID.test(span) && !/^0+$/.test(span)) out[SPAN_KEY] = span;
  if (sampled !== undefined) out[SAMPLED_KEY] = sampled;
  return out;
}

// Links a line to the span that is active where it is written (src/lib/telemetry), so a log line
// opens the exact span in Cloud Trace. Nothing while no span is active, which is always the case
// until tracing starts or with OTEL_SDK_DISABLED=true. Needs GOOGLE_CLOUD_PROJECT, as traceFields does.
export function activeSpanFields(): TraceFields {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  const context = project ? trace.getActiveSpan()?.spanContext() : undefined;
  if (!project || !context || !isSpanContextValid(context)) return {};
  return {
    [TRACE_KEY]: `projects/${project}/traces/${context.traceId}`,
    [SPAN_KEY]: context.spanId,
    [SAMPLED_KEY]: (context.traceFlags & 1) === 1,
  };
}

// Writes one record as one line. Only this file and error-report.ts call it directly; the
// Error Reporting event carries a stack trace, which log() would scrub and cut to MAX_TEXT.
export function emit(record: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

export function log(severity: Severity, message: string, fields: LogFields = {}, headers?: HeaderSource): void {
  const line: Record<string, unknown> = { severity, message: scrub(message) };
  for (const name of FIELDS) {
    const value = fields[name];
    if (typeof value === 'string') line[name] = scrub(value);
    else if (typeof value === 'number' && Number.isFinite(value)) line[name] = value;
    else if (typeof value === 'boolean') line[name] = value;
  }
  // The active span first (it is the closest, and the request's own trace); the request's headers
  // when there is none (tracing off, or a line written outside a span).
  const linked = activeSpanFields();
  if (Object.keys(linked).length > 0) Object.assign(line, linked);
  else if (headers) Object.assign(line, traceFields(headers));
  emit(line);
}
