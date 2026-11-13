import type { AiTelemetry } from './log';

// The span around one model call. TC-3 (tracing) is not on master yet, so withAiSpan runs the work
// with a span that records nothing; when TC-3 lands it opens a real span named "ai.call" here and
// nothing else changes. Attributes are the checked telemetry fields of log.ts, never text
// (hard rule 6).

export type AiSpanAttributes = Partial<AiTelemetry>;
export type AiSpan = { setAttributes(attributes: AiSpanAttributes): void };
export type AiSpanRunner = <T>(attributes: AiSpanAttributes, work: (span: AiSpan) => Promise<T>) => Promise<T>;

const NO_SPAN: AiSpan = Object.freeze({ setAttributes: () => undefined });

export const withAiSpan: AiSpanRunner = (_attributes, work) => work(NO_SPAN);
