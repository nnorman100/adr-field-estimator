// Text helpers the S7-5 scorers share: word normalisation (number words become digits), word error
// rate, phrase and number lookups. Deterministic and provider-free, so CI tests them on stored
// responses (docs/plans/S7.md, S7-5).

const SMALL: Readonly<Record<string, number>> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};
const TENS: Readonly<Record<string, number>> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

const isNumberWord = (word: string) => word in SMALL || word in TENS || word === 'hundred' || word === 'thousand';
const isDigits = (word: string) => /^\d+(?:\.\d+)?$/.test(word);

// "two hundred ninety" -> "290", "eighteen point five" -> "18.5", "fifteen hundred" -> "1500".
function foldNumbers(words: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < words.length) {
    if (!isNumberWord(words[i]!) || words[i] === 'hundred' || words[i] === 'thousand') {
      out.push(words[i]!);
      i += 1;
      continue;
    }
    let total = 0;
    let current = 0;
    let j = i;
    for (; j < words.length; j += 1) {
      const word = words[j]!;
      const group = current % 100;
      if (word in SMALL) {
        // After a tens word only a single digit joins it ("twenty eight"); otherwise a new number.
        const joins = group === 0 || (group >= 20 && group % 10 === 0 && SMALL[word]! < 10);
        if (!joins) break;
        current += SMALL[word]!;
      } else if (word in TENS) {
        if (group !== 0) break;
        current += TENS[word]!;
      } else if (word === 'hundred') {
        if (current === 0 || current >= 100) break;
        current *= 100;
      } else if (word === 'thousand') {
        if (current === 0) break;
        total += current * 1000;
        current = 0;
      } else if (word === 'and' && current >= 100 && j + 1 < words.length && isNumberWord(words[j + 1]!)) {
        continue;
      } else break;
    }
    let value = String(total + current);
    // "point five" after a number: one digit per word.
    if (words[j] === 'point' && j + 1 < words.length && words[j + 1]! in SMALL && SMALL[words[j + 1]!]! < 10) {
      let decimals = '';
      j += 1;
      while (j < words.length && words[j]! in SMALL && SMALL[words[j]!]! < 10) {
        decimals += String(SMALL[words[j]!]);
        j += 1;
      }
      value += `.${decimals}`;
    }
    out.push(value);
    i = j;
  }
  // "18 point 5" spoken with digits.
  const merged: string[] = [];
  for (let k = 0; k < out.length; k += 1) {
    if (out[k] === 'point' && merged.length > 0 && isDigits(merged[merged.length - 1]!) && isDigits(out[k + 1] ?? '')) {
      merged[merged.length - 1] = `${merged[merged.length - 1]}.${out[k + 1]}`;
      k += 1;
    } else merged.push(out[k]!);
  }
  return merged;
}

// Lower case, symbols spelled out, punctuation dropped, number words folded into digits.
export function normalizeWords(text: string): string[] {
  const spaced = text
    .toLowerCase()
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/%/g, ' percent ')
    .replace(/°/g, ' degrees ')
    .replace(/&/g, ' and ')
    .replace(/(\d)\.(?=\d)/g, '$1DOT')
    .replace(/[^a-z0-9DOT\s']/gi, ' ')
    .replace(/DOT/g, '.')
    .replace(/'/g, '');
  const words = spaced.split(/\s+/).filter((word) => word.length > 0);
  return foldNumbers(words);
}

// Word-level edit distance (substitutions, insertions, deletions).
export function editDistance(reference: readonly string[], hypothesis: readonly string[]): number {
  let previous = Array.from({ length: hypothesis.length + 1 }, (_, i) => i);
  for (let i = 1; i <= reference.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= hypothesis.length; j += 1) {
      const cost = reference[i - 1] === hypothesis[j - 1] ? 0 : 1;
      row.push(Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + cost));
    }
    previous = row;
  }
  return previous[hypothesis.length]!;
}

// Word error rate over a whole set: total edits over total reference words.
export function wordErrorRate(pairs: readonly { reference: string; hypothesis: string }[]): number {
  let edits = 0;
  let words = 0;
  for (const { reference, hypothesis } of pairs) {
    const ref = normalizeWords(reference);
    edits += editDistance(ref, normalizeWords(hypothesis));
    words += ref.length;
  }
  return words === 0 ? 0 : edits / words;
}

// Whether the phrase's words appear in order, side by side, in the text.
export function hasPhrase(text: string, phrase: string): boolean {
  const words = normalizeWords(text);
  const needle = normalizeWords(phrase);
  if (needle.length === 0) return false;
  for (let i = 0; i + needle.length <= words.length; i += 1) {
    if (needle.every((word, k) => words[i + k] === word)) return true;
  }
  return false;
}

// Every number in the text, as digits ("twenty eight" and "28" both give "28").
export function numbersIn(text: string): Set<string> {
  return new Set(normalizeWords(text).filter(isDigits).map((n) => String(Number(n))));
}

// A number-like value as a number: 18.5, "18.5", "18.5%" and "18.50" are all 18.5. A string is one
// whole number, with thousands commas and at most one unit the datasets use (%, %MC, %RH, percent,
// REL, F, C, degrees, square feet); anything else, such as a range ("39-49") or other words, is null.
const UNIT = /^(?:%|%\s*(?:mc|rh)|percent|rel|°?\s*[fc]|degrees?(?:\s+[fc])?|sf|sq\.?\s*ft\.?|square\s+f(?:ee|oo)t)$/i;
export function numberOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const match = /^\s*(-?\d{1,3}(?:,\d{3})+|-?\d+)(\.\d+)?\s*(.*?)\s*$/.exec(value);
  if (!match || (match[3] !== '' && !UNIT.test(match[3]!))) return null;
  return Number(`${match[1]!.replace(/,/g, '')}${match[2] ?? ''}`);
}

// For the exact-quote rule: case, spacing, quotes and edge punctuation do not matter.
export function looseText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”"]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s.,;:!?'-]+|[\s.,;:!?'-]+$/g, '');
}

// Every string inside a structured value, for the price and number scans.
export function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(stringsIn);
  return [];
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
