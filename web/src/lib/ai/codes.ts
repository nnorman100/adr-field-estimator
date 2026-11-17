// Closed lists shared by the boundary, the log line and the span, so every value written out is one
// of these fixed words.

export const ARMOR_CATEGORIES = Object.freeze([
  'passed',
  'blocked_rai',
  'blocked_sdp',
  'blocked_pi_jailbreak',
  'blocked_malicious_uri',
  'blocked_csam',
  'blocked_other',
  'unavailable_timeout',
  'unavailable_error',
  'unavailable_partial',
  'unsupported',
] as const);

// Why the boundary refused a call. Each maps to one fixed message in call.ts.
export const AI_REFUSAL_CODES = Object.freeze([
  'invalid_context',
  'not_allowed',
  'feature_off',
  'not_ready',
  'quota',
  'budget',
  'call_reused',
  'unsupported_input',
  'input_blocked',
  'screen_unavailable',
  'model_timeout',
  'model_busy',
  'model_failed',
  'invalid_output',
  'output_blocked',
] as const);
export type AiRefusalCode = (typeof AI_REFUSAL_CODES)[number];

export const AI_OUTCOMES = Object.freeze(['ok', ...AI_REFUSAL_CODES] as const);
export type AiOutcomeCode = (typeof AI_OUTCOMES)[number];
