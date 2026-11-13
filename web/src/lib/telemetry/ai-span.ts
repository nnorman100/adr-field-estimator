import { SpanKind, type Span } from '@opentelemetry/api';
import { inSpan } from './spans';

// The span around one model call (S7). Its attributes are the checked telemetry fields of the AI
// boundary: closed words and counts, never a prompt, a transcript, an image or model text
// (hard rule 6). The helper checks them again: a string must be a short lowercase word or hash, a
// number a whole count, and anything else is dropped, so a caller cannot put text on a span.
//
// The shape matches `withAiSpan` of the AI boundary (web/src/lib/ai/span.ts, S7-1), so that file can
// re-export this one.

export type AiSpanAttributes = Partial<
  Record<
    'feature' | 'model' | 'promptVersion' | 'inputTokens' | 'outputTokens' | 'latencyMs' | 'outcome' | 'verdict',
    string | number
  >
>;
export type AiSpan = { setAttributes(attributes: AiSpanAttributes): void };
export type AiSpanRunner = <T>(attributes: AiSpanAttributes, work: (span: AiSpan) => Promise<T>) => Promise<T>;

const KEYS: Record<keyof AiSpanAttributes, string> = {
  feature: 'dryscope.ai.feature',
  model: 'gen_ai.request.model',
  promptVersion: 'dryscope.ai.prompt_version',
  inputTokens: 'gen_ai.usage.input_tokens',
  outputTokens: 'gen_ai.usage.output_tokens',
  latencyMs: 'dryscope.ai.latency_ms',
  outcome: 'dryscope.ai.outcome',
  verdict: 'dryscope.ai.verdict',
};
const WORD = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function checked(attributes: AiSpanAttributes): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const name of Object.keys(KEYS) as (keyof AiSpanAttributes)[]) {
    const value = attributes[name];
    if (typeof value === 'string' && WORD.test(value)) out[KEYS[name]] = value;
    else if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) out[KEYS[name]] = value;
  }
  return out;
}

export const withAiSpan: AiSpanRunner = (attributes, work) =>
  inSpan('ai.call', SpanKind.CLIENT, checked(attributes), (span: Span) =>
    work({ setAttributes: (more) => span.setAttributes(checked(more)) }),
  );
