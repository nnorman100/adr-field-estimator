import dc from 'node:diagnostics_channel';
import { SpanKind, SpanStatusCode, trace, type Span } from '@opentelemetry/api';
import { statementKind } from './statement';

// One span per Postgres query, from postgres.js's own diagnostics channel (postgres:query, in the
// library's README under "Tracing"), because postgres.js has no OpenTelemetry instrumentation and
// needs no wrapper this way. `start` runs in the async context of the code that made the query, so
// the span is a child of the active one (the withCompany transaction, inside a route's span).
//
// A span is named by statement type and table ("SELECT jobs") and carries the system, the
// operation, the table, the row count and, on failure, the error code. It never carries the query
// text or the parameters (the channel gives parameters only with postgres.js's `debug` option, which
// the app never sets, and this file would not read them anyway).

type QueryMessage = {
  query?: string | null;
  command?: string | null;
  count?: number | null;
  error?: unknown;
};

const SCOPE = 'dryscope-web';
const ERROR_CODE = /^[A-Za-z0-9_]{2,40}$/;

// Transaction control is the withCompany transaction span's business, not a query of its own.
const CONTROL = new Set(['BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE']);

let unsubscribe: (() => void) | undefined;

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && ERROR_CODE.test(code)) return code;
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === 'string' && ERROR_CODE.test(name) ? name : 'Error';
}

// Idempotent. Returns a function that stops it (for tests).
export function subscribePostgresSpans(): () => void {
  if (unsubscribe) return unsubscribe;
  const channel = dc.tracingChannel('postgres:query');
  const spans = new WeakMap<object, Span>();
  const guard = (fn: (message: QueryMessage) => void) => (message: unknown) => {
    try {
      fn(message as QueryMessage);
    } catch {
      // A tracing fault never reaches the query.
    }
  };
  const handlers = {
    start: guard((message) => {
      const { operation, table } = statementKind(message.query);
      if (CONTROL.has(operation)) return;
      const attributes: Record<string, string> = { 'db.system.name': 'postgresql', 'db.operation.name': operation };
      if (table !== undefined) attributes['db.collection.name'] = table;
      const span = trace.getTracer(SCOPE).startSpan(table === undefined ? operation : `${operation} ${table}`, {
        kind: SpanKind.CLIENT,
        attributes,
      });
      spans.set(message, span);
    }),
    end: () => {},
    asyncStart: () => {},
    error: guard((message) => {
      const span = spans.get(message);
      if (!span) return;
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.setAttribute('error.type', errorCode(message.error));
    }),
    asyncEnd: guard((message) => {
      const span = spans.get(message);
      if (!span) return;
      spans.delete(message);
      if (typeof message.count === 'number' && Number.isSafeInteger(message.count) && message.count >= 0) {
        span.setAttribute('db.response.returned_rows', message.count);
      }
      span.end();
    }),
  };
  channel.subscribe(handlers);
  unsubscribe = () => {
    channel.unsubscribe(handlers);
    unsubscribe = undefined;
  };
  return unsubscribe;
}
