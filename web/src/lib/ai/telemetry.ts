import { AI_OUTCOMES, ARMOR_CATEGORIES, type AiOutcomeCode } from './codes';
import { AI_MODELS, type AiModel } from './pricing';
import { AI_FEATURES, type AiFeature } from './registry';
import type { ArmorCategory } from './armor';
import { log } from '@/lib/log';

// The one AI log line per model call (docs/plans/S7.md section 3, hard rule 6). It carries the
// feature, model, prompt version, token counts, latency, outcome code and verdict category only:
// never a prompt, transcript, image, model text, error message, company, person or job. Every
// field is checked against a closed list or a number rule here, so a caller cannot slip text in.
//
// The line goes out through the shared logger (src/lib/log.ts), whose field allowlist holds these
// names and whose scrubbers are a second line behind the checks here. Server runtime only.

export type AiVerdict = ArmorCategory | 'not_screened';

export type AiLogLine = {
  feature: AiFeature;
  model: AiModel;
  promptVersion: string | null;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  outcome: AiOutcomeCode;
  verdict: AiVerdict;
};

// The same fields, checked, as written to the log and to the span.
export type AiTelemetry = Record<keyof AiLogLine, string | number>;

const VERDICTS: readonly string[] = [...ARMOR_CATEGORIES, 'not_screened'];
const HEX64 = /^[0-9a-f]{64}$/;

const oneOf = (value: unknown, list: readonly string[]) =>
  typeof value === 'string' && list.includes(value) ? value : 'invalid';
const whole = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;

export function aiTelemetry(line: Partial<AiLogLine>): AiTelemetry {
  const version = line.promptVersion;
  return {
    feature: oneOf(line.feature, AI_FEATURES),
    model: oneOf(line.model, AI_MODELS),
    promptVersion:
      version === null || version === undefined
        ? 'none'
        : typeof version === 'string' && HEX64.test(version)
          ? version
          : 'invalid',
    inputTokens: whole(line.inputTokens),
    outputTokens: whole(line.outputTokens),
    latencyMs: whole(line.latencyMs),
    outcome: oneOf(line.outcome, AI_OUTCOMES),
    verdict: oneOf(line.verdict, VERDICTS),
  };
}

export function aiLog(line: AiLogLine): void {
  const fields = aiTelemetry(line);
  log(fields.outcome === 'ok' ? 'INFO' : 'WARNING', 'ai_call', { component: 'ai', ...fields });
}
