import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { CompositePropagator, W3CTraceContextPropagator } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  AlwaysOnSampler,
  BatchSpanProcessor,
  ParentBasedSampler,
  SimpleSpanProcessor,
  TracerProvider,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace';
import type { TracingConfig } from '@/lib/config';
import { log } from '@/lib/log';
import { SERVICE } from '@/lib/error-report';
import { googleTraceExporter } from './google-exporter';
import { subscribePostgresSpans } from './postgres';
import { sanitizingExporter } from './sanitize';

// Request tracing into Cloud Trace (docs/plans/TC.md, TC-3), started once from register() in
// src/instrumentation.ts, Node runtime only. What it sets up:
//   - a tracer provider that Next.js's built-in spans (route handlers, rendering) and the
//     hand-written spans of this folder both use; sampler ParentBased(AlwaysOn), so Cloud Run's
//     own decision on the request it forwards (traceparent) bounds the volume;
//   - W3C trace context propagation, so a span is a child of Cloud Run's request span, and an
//     async context manager, so a query's span is a child of its transaction's;
//   - resource attributes: service.name, service.version (the commit), gcp.project_id;
//   - query spans from postgres.js's diagnostics channel (postgres.ts);
//   - export, only on a Cloud Run service with a project (config.mode === 'export'): batches through
//     the sanitizer to Cloud Trace. A local run or CI records spans in the process and exports nothing.
// OTEL_SDK_DISABLED=true starts none of it. Nothing here may stop a request or the server: failures
// are counted and one fixed line is logged at most once a minute.

export type TracingHandle = { provider: TracerProvider; shutdown(): Promise<void> };

type Options = {
  // Replaces the Cloud Trace exporter, for tests. Always reached through the sanitizer.
  exporter?: SpanExporter;
  // Tests read spans at once instead of in batches.
  simple?: boolean;
};

const GLOBAL = Symbol.for('dryscope.tracing');
const FAILURE_LOG_EVERY_MS = 60_000;

export function startTracing(config: TracingConfig, options: Options = {}): TracingHandle | null {
  if (config.mode === 'off') return null;
  const registry = globalThis as { [GLOBAL]?: TracingHandle };
  if (registry[GLOBAL]) return registry[GLOBAL];

  let lastFailureLog = 0;
  const onFailure = () => {
    const now = Date.now();
    if (now - lastFailureLog < FAILURE_LOG_EVERY_MS) return;
    lastFailureLog = now;
    log('WARNING', 'trace export failed', { component: 'tracing', event: 'export_failed' });
  };

  const exporter =
    options.exporter ?? (config.mode === 'export' ? googleTraceExporter() : undefined);
  const processors: SpanProcessor[] = [];
  if (exporter) {
    const safe = sanitizingExporter(exporter, onFailure);
    processors.push(options.simple ? new SimpleSpanProcessor({ exporter: safe }) : new BatchSpanProcessor({ exporter: safe }));
  }

  context.setGlobalContextManager(new AsyncLocalStorageContextManager());
  propagation.setGlobalPropagator(new CompositePropagator({ propagators: [new W3CTraceContextPropagator()] }));
  const provider = new TracerProvider({
    resource: resourceFromAttributes({
      'service.name': SERVICE,
      'service.version': config.commit ?? 'unknown',
      'deployment.environment.name': config.appEnv,
      ...(config.projectId === undefined ? {} : { 'gcp.project_id': config.projectId }),
    }),
    sampler: new ParentBasedSampler({ root: new AlwaysOnSampler() }),
    spanProcessors: processors,
  });
  trace.setGlobalTracerProvider(provider);
  const stopQuerySpans = subscribePostgresSpans();

  // Cloud Run sends SIGTERM and stops the container a few seconds later: flush what is waiting.
  const flushOnTerm = () => void provider.forceFlush({ timeoutMillis: 3000 }).catch(() => {});
  if (processors.length > 0) process.once('SIGTERM', flushOnTerm);

  const handle: TracingHandle = {
    provider,
    async shutdown() {
      process.off('SIGTERM', flushOnTerm);
      stopQuerySpans();
      delete registry[GLOBAL];
      trace.disable();
      context.disable();
      propagation.disable();
      await provider.shutdown().catch(() => {});
    },
  };
  registry[GLOBAL] = handle;
  log('INFO', 'tracing started', { component: 'tracing', event: 'started', code: config.mode });
  return handle;
}
