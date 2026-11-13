// Token prices for every model the AI boundary calls, in exact decimal arithmetic. These are AI
// spending prices only (micro-USD of Google's bill), never the price of a company's work.
//
// Prices are list prices per 1,000,000 tokens in USD, as decimal strings, with the date (UTC) each
// price starts. Source: documents/aistudio.google.com/docs/pricing, read 2026-11-13 through the
// Developer Knowledge tools; docs/plans/S7.md section 2 repeats the same numbers. Context-cache
// discounts are not applied: a cached token is billed at the full input rate, which over-counts and
// never under-counts. A price change is a reviewed pull request that adds a dated period.

export const AI_MODELS = Object.freeze(['gemini-3.8-flash', 'gemini-3.5-transcribe', 'gemini-3.8-live'] as const);
export type AiModel = (typeof AI_MODELS)[number];

export type InputModality = 'text' | 'image' | 'audio' | 'video';
export type OutputModality = 'text' | 'audio';

// One dated price. null means the model takes no such tokens; usage in it is refused.
export type PricePeriod = {
  readonly from: string; // YYYY-MM-DD, UTC midnight
  readonly input: Readonly<Record<InputModality, string | null>>;
  readonly output: Readonly<Record<OutputModality, string | null>>;
};

// Token counts by modality. `unknown` holds tokens Google reported without a modality; they are
// billed at the model's dearest rate on that side.
export type AiUsage = {
  input: Partial<Record<InputModality | 'unknown', number>>;
  output: Partial<Record<OutputModality | 'unknown', number>>;
};

const flat = (price: string): Record<InputModality, string> => ({
  text: price,
  image: price,
  audio: price,
  video: price,
});

export const AI_PRICES: Readonly<Record<AiModel, readonly PricePeriod[]>> = Object.freeze({
  // GA 2026-09-02. One input price for every modality; doubles on 2027-01-01.
  'gemini-3.8-flash': [
    { from: '2026-09-02', input: flat('0.75'), output: { text: '3.75', audio: null } },
    { from: '2027-01-01', input: flat('1.50'), output: { text: '7.50', audio: null } },
  ],
  // GA October 2026. Audio in, text out. Text input (the trade vocabulary) is priced at the audio
  // rate because the page lists no text input price; that over-counts if anything.
  'gemini-3.5-transcribe': [
    {
      from: '2026-10-01',
      input: { text: '2.00', image: null, audio: '2.00', video: null },
      output: { text: '12.00', audio: null },
    },
  ],
  // GA 2026-09-24. Transcription is billed at the text output rate.
  'gemini-3.8-live': [
    {
      from: '2026-09-24',
      input: { text: '0.75', image: '1.00', audio: '3.00', video: '1.00' },
      output: { text: '4.50', audio: '12.00' },
    },
  ],
});

export class AiPriceError extends Error {
  constructor(readonly code: 'unknown_model' | 'no_price' | 'bad_rate' | 'bad_usage') {
    super(`AI price refused: ${code}`);
    this.name = 'AiPriceError';
  }
}

const MILLION = 1_000_000n;

// "0.75" (USD per million tokens) -> 750000n (micro-USD per million tokens). At most six decimals,
// so every listed price converts exactly.
export function rateMicroUsdPerMillion(price: string): bigint {
  const match = /^(\d{1,6})(?:\.(\d{1,6}))?$/.exec(price);
  if (!match) throw new AiPriceError('bad_rate');
  const fraction = (match[2] ?? '').padEnd(6, '0');
  return BigInt(match[1]!) * MILLION + BigInt(fraction);
}

function dayOf(at: Date): string {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) throw new AiPriceError('no_price');
  return at.toISOString().slice(0, 10);
}

export function ratesOn(model: AiModel, at: Date): PricePeriod {
  if (!Object.hasOwn(AI_PRICES, model)) throw new AiPriceError('unknown_model');
  const day = dayOf(at);
  let current: PricePeriod | undefined;
  for (const period of AI_PRICES[model]) if (period.from <= day) current = period;
  if (!current) throw new AiPriceError('no_price');
  return current;
}

function dearest(rates: Readonly<Record<string, string | null>>): bigint {
  let best = -1n;
  for (const price of Object.values(rates))
    if (price !== null) best = best > rateMicroUsdPerMillion(price) ? best : rateMicroUsdPerMillion(price);
  if (best < 0n) throw new AiPriceError('no_price');
  return best;
}

function tokens(count: number | undefined): bigint {
  if (count === undefined) return 0n;
  if (!Number.isSafeInteger(count) || count < 0) throw new AiPriceError('bad_usage');
  return BigInt(count);
}

function side(counts: Partial<Record<string, number>>, rates: Readonly<Record<string, string | null>>): bigint {
  let total = 0n;
  for (const [modality, count] of Object.entries(counts)) {
    const n = tokens(count);
    if (n === 0n) continue;
    if (modality === 'unknown') {
      total += n * dearest(rates);
      continue;
    }
    if (!Object.hasOwn(rates, modality)) throw new AiPriceError('bad_usage');
    const price = rates[modality];
    if (price === null || price === undefined) throw new AiPriceError('no_price');
    total += n * rateMicroUsdPerMillion(price);
  }
  return total;
}

function ceilMicro(scaled: bigint): number {
  const micro = (scaled + MILLION - 1n) / MILLION;
  if (micro > BigInt(Number.MAX_SAFE_INTEGER)) throw new AiPriceError('bad_usage');
  return Number(micro);
}

// What a call cost, in whole micro-USD, rounded up.
export function costMicroUsd(model: AiModel, usage: AiUsage, at: Date): number {
  const rates = ratesOn(model, at);
  return ceilMicro(side(usage.input, rates.input) + side(usage.output, rates.output));
}

// The conservative hold taken before a REST call (section 3): input bytes / 3 tokens plus the output
// cap, each at the model's dearest rate on that side.
export function reserveMicroUsd(
  model: AiModel,
  bound: { inputBytes: number; outputTokenCap: number },
  at: Date,
): number {
  const rates = ratesOn(model, at);
  const inputTokens = (tokens(bound.inputBytes) + 2n) / 3n;
  const outputTokens = tokens(bound.outputTokenCap);
  const outputRate = outputTokens === 0n ? 0n : dearest(rates.output);
  return ceilMicro(inputTokens * dearest(rates.input) + outputTokens * outputRate);
}

type ModalityCount = { modality?: unknown; tokenCount?: unknown };
export type UsageMetadata = {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  toolUsePromptTokenCount?: number;
  promptTokensDetails?: readonly ModalityCount[];
  candidatesTokensDetails?: readonly ModalityCount[];
};

const MODALITY: Readonly<Record<string, InputModality>> = {
  TEXT: 'text',
  IMAGE: 'image',
  AUDIO: 'audio',
  VIDEO: 'video',
};

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function split<M extends string>(total: number, details: readonly ModalityCount[] | undefined, allowed: readonly M[]) {
  const out: Partial<Record<M | 'unknown', number>> = {};
  let explained = 0;
  for (const detail of details ?? []) {
    const modality = MODALITY[String(detail?.modality)] as M | undefined;
    const n = count(detail?.tokenCount);
    if (!modality || !allowed.includes(modality) || n === 0 || explained + n > total) continue;
    out[modality] = (out[modality] ?? 0) + n;
    explained += n;
  }
  if (total > explained) out.unknown = total - explained;
  return out;
}

// Token usage from a response's usage_metadata (documents/docs.cloud.google.com/
// gemini-enterprise-agent-platform/reference/rest/v1/GenerateContentResponse). Thinking tokens are
// text output; tool-use prompt tokens are input. Anything the details do not explain is `unknown`.
export function usageFromMetadata(meta: UsageMetadata | undefined): AiUsage {
  const inputTotal = count(meta?.promptTokenCount) + count(meta?.toolUsePromptTokenCount);
  const outputTotal = count(meta?.candidatesTokenCount);
  const input = split(inputTotal, meta?.promptTokensDetails, ['text', 'image', 'audio', 'video'] as const);
  const output: AiUsage['output'] = split(outputTotal, meta?.candidatesTokensDetails, ['text', 'audio'] as const);
  const thoughts = count(meta?.thoughtsTokenCount);
  if (thoughts > 0) output.text = (output.text ?? 0) + thoughts;
  return { input, output };
}

// Total input and output tokens, for the log line.
export function tokenTotals(usage: AiUsage): { inputTokens: number; outputTokens: number } {
  const sum = (side: Partial<Record<string, number>>) => Object.values(side).reduce<number>((a, b) => a + (b ?? 0), 0);
  return { inputTokens: sum(usage.input), outputTokens: sum(usage.output) };
}
