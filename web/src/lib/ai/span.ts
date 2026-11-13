// The span around one model call: the real tracing helper (TC-3, src/lib/telemetry/ai-span.ts). It
// opens a span named "ai.call" and records only the checked telemetry fields of log.ts, as closed
// words and counts, never text (hard rule 6). Before tracing started, or with OTEL_SDK_DISABLED=true,
// it runs the work and records nothing.
export { withAiSpan, type AiSpan, type AiSpanAttributes, type AiSpanRunner } from '@/lib/telemetry/ai-span';
