// Server rules every model output passes (docs/plans/S7.md section 3, "AI never prices"). A sentence
// that states a price is dropped from every string in the output. Ported from backend/claims.py
// (MONEY, MONEY_WORD, NUMBER, sentences, states_price, ai_note), with `estimate` added as a price
// word where it names an amount ("the estimate is 900", "estimate: 900"; not "estimate which of the
// 3 air movers"). Feature rules (pre-1978 testing advice, exact quotes) run after this, in the feature's own
// step.

const MONEY = /[$€£]|\b(?:usd|dollars?|bucks?|cents?)\b/i;
const MONEY_WORD =
  /\b(?:pric(?:e|es|ed|ing)|cost(?:s|ed|ing)?|fees?|charg(?:e|es|ed|ing)|budget(?:s|ed|ing)?|(?:sub)?total(?:s|ed|ing|led|ling)?|quot(?:e|es|ed|ing)|estimates?(?=\s*[:=]|\s+(?:is|was|are|were|of|at|comes?|came|runs?|ran|totals?)\b))\b/i;
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

const NUMBER_WORDS = new RegExp(NUMBER.source, 'gi');

// A piece with no words but an amount ("900." after "approx."): it ends the sentence before it.
function bareAmount(piece: string): boolean {
  return NUMBER.test(piece) && piece.replace(NUMBER_WORDS, '').replace(/[^a-z]/gi, '') === '';
}

// The lines of one sentence `drop` matches with the shortest run of them `run` matches emptied, then
// the same in what is left before and after it: a clause wrapped over lines goes whole, a line beside
// it stays.
function blank(lines: string[], drop: (sentence: string) => boolean, run: (lines: string) => boolean): string[] {
  if (lines.length === 0 || !drop(lines.join('\n'))) return lines;
  for (let size = 1; size < lines.length; size += 1) {
    for (let start = 0; start + size <= lines.length; start += 1) {
      if (run(lines.slice(start, start + size).join('\n'))) {
        return [
          ...blank(lines.slice(0, start), drop, run),
          ...lines.slice(start, start + size).map(() => ''),
          ...blank(lines.slice(start + size), drop, run),
        ];
      }
    }
  }
  return lines.map(() => '');
}

// The text without any sentence `drop` matches; lines are kept apart and emptied lines dropped. A
// sentence ends at an end mark and space before anything but a small letter or a digit, so a clause
// wrapped onto the next line ("Total:" then "1,200") or going on after an abbreviation ("approx. 900
// for labor") is one sentence, and a bare amount after an end mark ("approx." then "Nine hundred.")
// belongs to the sentence before it. Of a sentence over several lines only the shortest run of lines
// `run` matches is dropped (by default the same rule). Feature rules (the summary's pre-1978 rule)
// drop their own sentences the same way.
export function stripSentences(
  text: string,
  drop: (sentence: string) => boolean,
  run: (lines: string) => boolean = drop,
): string {
  const parts = text.trim().split(/((?<=[.?!])\s+(?=[^\p{Ll}\d]))/u);
  const units: { text: string; after: string }[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const piece = parts[i]!;
    const after = parts[i + 1] ?? '';
    const last = units.at(-1);
    if (last && bareAmount(piece)) {
      last.text += last.after + piece;
      last.after = after;
    } else {
      units.push({ text: piece, after });
    }
  }
  let out = '';
  let breaks = false;
  for (const unit of units) {
    const kept = blank(unit.text.split('\n'), drop, run).join('\n');
    if (kept.trim().length > 0) {
      if (out.length > 0) out += breaks ? '\n' : ' ';
      out += kept;
      breaks = false;
    }
    if (unit.after.includes('\n')) breaks = true;
  }
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

// The text without any sentence that states a price; of one over several lines, the lines that state
// the price with its amount ("Drying cost: $" goes with the "900." below it).
export function stripPriceSentences(text: string): string {
  return stripSentences(text, statesPrice, (lines) => statesPrice(lines) && NUMBER.test(lines));
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
