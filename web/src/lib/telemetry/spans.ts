import { SpanKind, SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api';

// The hand-written spans (docs/plans/TC.md, TC-3). Only @opentelemetry/api is imported here, so
// these helpers cost nothing and record nothing until src/lib/telemetry/start.ts registers a tracer
// provider, and they are safe in any Node module. Hard rule 6: what goes on a span is decided in
// this folder, from fixed words and identifiers, never from a value a request supplied:
//   - names and attributes are built from statement TYPES, table names and collection names that
//     the code itself names, never query text, parameters, document ids, company ids or errors'
//     messages;
//   - a failure records the error CLASS only (no message, no stack, no exception event).
// sanitize.ts checks the same thing again on everything that leaves the process, Next.js's own
// spans included.

const SCOPE = 'dryscope-web';
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export function errorType(error: unknown): string {
  return error instanceof Error && IDENTIFIER.test(error.name) ? error.name : 'Error';
}

export function fail(span: Span, error: unknown): void {
  span.setStatus({ code: SpanStatusCode.ERROR });
  span.setAttribute('error.type', errorType(error));
}

// Runs `work` inside an active span, so spans made meanwhile (a query) are its children and the
// logger can link to it. The span ends however the work ends; the work's own result or error is
// returned or thrown unchanged.
export function inSpan<T>(
  name: string,
  kind: SpanKind,
  attributes: Attributes,
  work: (span: Span) => Promise<T>,
): Promise<T> {
  return trace.getTracer(SCOPE).startActiveSpan(name, { kind, attributes }, async (span) => {
    try {
      return await work(span);
    } catch (error) {
      fail(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}

// One withCompany database transaction.
export function transactionSpan<T>(work: () => Promise<T>): Promise<T> {
  return inSpan('withCompany transaction', SpanKind.INTERNAL, { 'db.system.name': 'postgresql', 'dryscope.db.scope': 'company' }, work);
}

export type FirestoreOperation = 'get' | 'count' | 'create' | 'set' | 'update' | 'delete' | 'runTransaction';

// One Firestore Admin SDK call. `collection` is the collection's name as the code spells it
// ('drafts', 'access'), never a document path or id.
export function firestoreSpan<T>(operation: FirestoreOperation, collection: string, work: () => Promise<T>): Promise<T> {
  const name = IDENTIFIER.test(collection) ? collection : 'invalid';
  return inSpan(
    `firestore.${operation} ${name}`,
    SpanKind.CLIENT,
    { 'db.system.name': 'gcp.firestore', 'db.operation.name': operation, 'db.collection.name': name },
    work,
  );
}
