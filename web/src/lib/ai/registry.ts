import { createHash } from 'node:crypto';
import type { Capability } from '@/lib/access';
import type { AiModel } from './pricing';

// The AI registry: one entry per AI feature, read by call.ts on every model call and by the TC-8
// release manifest (prompt and model versions). docs/plans/S7.md section 3 and step S7-1.
//
// - Models: gemini-3.8-flash for text, gemini-3.5-transcribe for voice notes (transcription only,
//   V1), gemini-3.8-live for the walkthrough.
// - Endpoint: "text" is the `us` multi-region endpoint (V4); "live" is `us-central1`. client.ts holds
//   the location strings.
// - Prompts are files under ./prompts/; a prompt's version is the SHA-256 of its text. Each feature's
//   own step (S7-6 to S7-12) adds its prompt, ported from the old app's text; until then the entry's
//   prompt is null and call.ts refuses the feature as not ready.
// - Daily quotas per person are the old DAILY_LIMITS (backend/inspection_store.py), except Live at
//   20 sessions a day (V5). Output caps are the old REST_OUTPUT_LIMITS (backend/ai_spending.py).
// - Flags are the six company switches of section 3; S7-4 adds them to FLAG_NAMES. Every one is off
//   until then, so no feature can run before its own step.

export const AI_FEATURES = Object.freeze([
  'summary_draft',
  'scope_fill',
  'meter_reading',
  'voice_note',
  'job_summary',
  'live',
] as const);
export type AiFeature = (typeof AI_FEATURES)[number];

export const AI_FLAG_NAMES = Object.freeze([
  'ai_summary',
  'ai_scope_fill',
  'ai_meter_reading',
  'ai_voice_notes',
  'ai_job_summary',
  'live_voice',
] as const);
export type AiFlagName = (typeof AI_FLAG_NAMES)[number];

export type Prompt = { readonly text: string; readonly version: string };

export function promptVersion(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// A prompt file's export goes through here, so its version is always the hash of its text.
export function definePrompt(text: string): Prompt {
  if (typeof text !== 'string' || text.trim().length === 0) throw new Error('A prompt needs text.');
  return Object.freeze({ text, version: promptVersion(text) });
}

// What Model Armor screens before the call: the job facts as text, one image with the image
// template, or nothing for transcription audio (Model Armor takes no audio; the transcript is
// screened as output, the R2 exception, and the model gets no instructions or tools).
export type InputScreen = 'text' | 'image' | 'audio_unscreened';

export type AiFeatureEntry = {
  readonly feature: AiFeature;
  // rest: one request through call.ts. live: the relay's session (S7-11 to S7-13), never call.ts.
  readonly kind: 'rest' | 'live';
  readonly model: AiModel;
  readonly endpoint: 'text' | 'live';
  // Whether the feature sends a system instruction. Transcription sends none.
  readonly usesPrompt: boolean;
  readonly prompt: Prompt | null;
  readonly inputScreen: InputScreen;
  readonly output: 'json' | 'text';
  // Output token cap for a REST call; Live is capped by session time and cost instead.
  readonly outputTokenCap: number | null;
  // The model call's deadline; for Live, the hard session cap (45 minutes, section 4.12).
  readonly deadlineMs: number;
  readonly dailyQuotaPerUser: number;
  readonly flag: AiFlagName;
  readonly capability: Capability;
  // The S7-5 suite under web/tests/ai-evals/ that must pass on `test` before the flag goes on.
  readonly evalSuite: string;
};

export type AiRegistry = Readonly<Record<AiFeature, AiFeatureEntry>>;

// The old REST deadline was 55 seconds for the whole request (backend/main.py REST_DEADLINE_SECONDS);
// the model gets 50 of them. Transcription of a note up to 10 minutes long gets two minutes.
const REST_DEADLINE_MS = 50_000;

export const AI_REGISTRY: AiRegistry = Object.freeze({
  summary_draft: {
    feature: 'summary_draft',
    kind: 'rest',
    model: 'gemini-3.8-flash',
    endpoint: 'text',
    usesPrompt: true,
    prompt: null, // S7-6
    inputScreen: 'text',
    output: 'json',
    outputTokenCap: 16_384,
    deadlineMs: REST_DEADLINE_MS,
    dailyQuotaPerUser: 60,
    flag: 'ai_summary',
    capability: 'audit',
    evalSuite: 'summary',
  },
  scope_fill: {
    feature: 'scope_fill',
    kind: 'rest',
    model: 'gemini-3.8-flash',
    endpoint: 'text',
    usesPrompt: true,
    prompt: null, // S7-7
    inputScreen: 'text',
    output: 'json',
    outputTokenCap: 16_384,
    deadlineMs: REST_DEADLINE_MS,
    dailyQuotaPerUser: 120,
    flag: 'ai_scope_fill',
    capability: 'scope',
    evalSuite: 'scope_fill',
  },
  meter_reading: {
    feature: 'meter_reading',
    kind: 'rest',
    model: 'gemini-3.8-flash',
    endpoint: 'text',
    usesPrompt: true,
    prompt: null, // S7-8
    inputScreen: 'image',
    output: 'json',
    outputTokenCap: 8192,
    deadlineMs: REST_DEADLINE_MS,
    dailyQuotaPerUser: 400,
    flag: 'ai_meter_reading',
    capability: 'ocr',
    evalSuite: 'meter_reading',
  },
  voice_note: {
    feature: 'voice_note',
    kind: 'rest',
    model: 'gemini-3.5-transcribe',
    endpoint: 'text',
    usesPrompt: false,
    prompt: null,
    inputScreen: 'audio_unscreened',
    output: 'text',
    outputTokenCap: 8192,
    deadlineMs: 120_000,
    dailyQuotaPerUser: 200,
    flag: 'ai_voice_notes',
    capability: 'scope',
    evalSuite: 'voice_notes',
  },
  job_summary: {
    feature: 'job_summary',
    kind: 'rest',
    model: 'gemini-3.8-flash',
    endpoint: 'text',
    usesPrompt: true,
    prompt: null, // S7-10
    inputScreen: 'text',
    output: 'json',
    outputTokenCap: 2048,
    deadlineMs: REST_DEADLINE_MS,
    dailyQuotaPerUser: 60,
    flag: 'ai_job_summary',
    capability: 'jobs_read',
    evalSuite: 'job_summary',
  },
  live: {
    feature: 'live',
    kind: 'live',
    model: 'gemini-3.8-live',
    endpoint: 'live',
    usesPrompt: true,
    prompt: null, // S7-12
    inputScreen: 'text',
    output: 'text',
    outputTokenCap: null,
    deadlineMs: 45 * 60_000,
    dailyQuotaPerUser: 20,
    flag: 'live_voice',
    capability: 'live',
    evalSuite: 'live',
  },
} satisfies Record<AiFeature, AiFeatureEntry>);

export function isAiFeature(value: unknown): value is AiFeature {
  return typeof value === 'string' && (AI_FEATURES as readonly string[]).includes(value);
}
