// Server rules every model output passes (docs/plans/S7.md section 3, "AI never prices"). A sentence
// that states a price is dropped from every string in the output. Ported unchanged from
// backend/claims.py (MONEY, MONEY_WORD, NUMBER, sentences, states_price, ai_note). Feature rules
// (pre-1978 testing advice, exact quotes) run after this, in the feature's own step.

const MONEY = /[$€£]|\b(?:usd|dollars?|bucks?|cents?)\b/i;
const MONEY_WORD =
  /\b(?:pric(?:e|es|ed|ing)|cost(?:s|ed|ing)?|fees?|charg(?:e|es|ed|ing)|budget(?:s|ed|ing)?|(?:sub)?total(?:s|ed|ing|led|ling)?|quot(?:e|es|ed|ing))\b/i;
const NUMBER =
  /\d|\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|(?:thir|four|fif|six|seven|eigh|nine)teen|(?:twen|thir|for|fif|six|seven|eigh|nine)ty|hundred|thousand|million|billion)\b/i;

export function sentences(text: string): string[] {
  return text
    .trim()
    .split(/(?<=[.?!])\s+/)
    .filter((part) => part.length > 0);
}

export function statesPrice(text: string): boolean {
  return MONEY.test(text) || (MONEY_WORD.test(text) && NUMBER.test(text));
}

// The text without any sentence that states a price; lines are kept apart and emptied lines dropped.
export function stripPriceSentences(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      sentences(line)
        .filter((sentence) => !statesPrice(sentence))
        .join(' '),
    )
    .filter((line) => line.length > 0)
    .join('\n');
}

// The same rule over every string of a structured output; numbers, booleans and shape are kept.
export function stripPricesDeep<T>(value: T): T {
  if (typeof value === 'string') return stripPriceSentences(value) as T;
  if (Array.isArray(value)) return value.map((item) => stripPricesDeep(item)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    // defineProperty, so a "__proto__" key from JSON.parse stays a plain key.
    for (const [key, item] of Object.entries(value)) {
      Object.defineProperty(out, key, {
        value: stripPricesDeep(item),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out as T;
  }
  return value;
}
