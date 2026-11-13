import type { Attributes } from '@opentelemetry/api';
import type { ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';
import { scrub } from '@/lib/log';

// The last check on everything that leaves the process for Cloud Trace (hard rule 6), applied to
// every span, the hand-written ones and Next.js's own (route handlers and rendering, whose
// attributes include the request target with its query string). It is an allowlist:
//   - an attribute stays only if its name is on the list below, and only as a string, number or
//     boolean; strings are scrubbed for emails, tokens and coordinates, and any path in them has its
//     query cut and its id-shaped segments replaced;
//   - span names get the same path treatment ("GET /api/jobs/<id>?x=1" -> "GET /api/jobs/[id]");
//   - events (an exception event holds the error's message and stack), links and the status message
//     are dropped.

const ALLOWED_NAME = new RegExp(
  '^(?:' +
    [
      String.raw`db\.[a-z_.]+`,
      String.raw`dryscope\.[a-z_.]+`,
      String.raw`gen_ai\.[a-z_.]+`,
      String.raw`next\.(?:span_name|span_type|route|page|rsc|bundler)`,
      String.raw`http\.(?:method|request\.method|route|status_code|response\.status_code)`,
      String.raw`error\.type`,
    ].join('|') +
    ')$',
);

const ID_SEGMENT = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|\d{4,})$/i;

// Cuts a query or fragment off and replaces id-shaped segments of a path inside the text.
export function scrubPaths(text: string): string {
  return text.replace(/(^|\s)(\/[^\s]*)/g, (_whole, lead: string, path: string) => {
    const bare = path.split(/[?#]/)[0]!;
    const segments = bare.split('/').map((segment) =>
      ID_SEGMENT.test(segment) || /[@]|%40/i.test(segment) ? '[id]' : segment,
    );
    return `${lead}${segments.join('/')}`;
  });
}

const clean = (text: string) => scrub(scrubPaths(text));

export function sanitizeAttributes(attributes: Attributes): Attributes {
  const out: Attributes = {};
  for (const [name, value] of Object.entries(attributes)) {
    if (!ALLOWED_NAME.test(name) || value === undefined) continue;
    if (typeof value === 'string') out[name] = clean(value);
    else if (typeof value === 'number' && Number.isFinite(value)) out[name] = value;
    else if (typeof value === 'boolean') out[name] = value;
  }
  return out;
}

function sanitizedSpan(span: ReadableSpan): ReadableSpan {
  const attributes = sanitizeAttributes(span.attributes);
  const dropped = Object.keys(span.attributes).length - Object.keys(attributes).length;
  return {
    name: clean(span.name),
    kind: span.kind,
    spanContext: () => span.spanContext(),
    parentSpanContext: span.parentSpanContext,
    startTime: span.startTime,
    endTime: span.endTime,
    status: { code: span.status.code },
    attributes,
    links: [],
    events: [],
    duration: span.duration,
    ended: span.ended,
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: span.droppedAttributesCount + dropped,
    droppedEventsCount: span.droppedEventsCount + span.events.length,
    droppedLinksCount: span.droppedLinksCount + span.links.length,
  };
}

const FAILED = 1;

// Wraps an exporter so only sanitized spans reach it and nothing it does can throw into the SDK.
export function sanitizingExporter(inner: SpanExporter, onFailure: () => void = () => {}): SpanExporter {
  return {
    export(spans: ReadableSpan[], done: (result: ExportResult) => void) {
      try {
        inner.export(spans.map(sanitizedSpan), (result) => {
          if (result.code === FAILED) onFailure();
          done(result);
        });
      } catch {
        onFailure();
        done({ code: FAILED });
      }
    },
    shutdown: () => inner.shutdown().catch(() => {}),
    forceFlush: () => (inner.forceFlush ? inner.forceFlush().catch(() => {}) : Promise.resolve()),
  };
}

