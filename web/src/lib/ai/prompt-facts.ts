// The one builder every AI request's job facts go through before any call leaves the server, Model
// Armor's screen included (docs/plans/S7.md section 3: no customer name, address or coordinates in
// any prompt). The server never reads the job's saved customer or address into the facts, but a
// technician can type them into free text (a note, a room name, a finding, a walkthrough turn), so
// every string of the facts is cleaned here:
// - the job's saved customer name, whole and word by word;
// - each part of the saved property address (split at commas), whole;
// - anything shaped like coordinates: a latitude and longitude pair, a decimal degree with four or
//   more decimals, or degrees with minutes.
// Matching ignores case and runs of spaces, and only whole words match, so a part of another word
// is left alone. What is removed reads as [removed].

export const REDACTED = '[removed]';

// What the job holds that must never reach a model: the saved customer name and property address.
export type JobIdentity = { customerName: string; propertyAddress: string };

export const NO_IDENTITY: JobIdentity = { customerName: '', propertyAddress: '' };

const COORDINATE_PAIR = /[-+]?\d{1,3}\.\d{2,}\s*°?\s*[NS]?\s*,\s*[-+]?\d{1,3}\.\d{2,}\s*°?\s*[EW]?/gi;
const DECIMAL_DEGREE = /(?<![\d.])[-+]?\d{1,3}\.\d{4,}(?![\d.])/g;
const DEGREES_MINUTES = /\d{1,3}\s*°\s*\d{1,2}\s*['′](?:\s*\d{1,2}(?:\.\d+)?\s*["″])?\s*[NSEW]?/gi;

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A whole-word, case-blind pattern for a phrase, any run of spaces matching any other.
function phrase(text: string): RegExp | null {
  const words = text.trim().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}])${words.map(escape).join('\\s+')}(?![\\p{L}\\p{N}])`, 'giu');
}

// The patterns for one job, longest first, so a whole name or address part goes before its words.
function patternsFor(identity: JobIdentity): RegExp[] {
  const phrases = new Set<string>();
  const name = identity.customerName.trim();
  if (name.length > 0) {
    phrases.add(name);
    for (const word of name.split(/\s+/)) if (word.replace(/\W/g, '').length >= 3) phrases.add(word);
  }
  for (const part of identity.propertyAddress.split(',')) {
    if (part.trim().replace(/\W/g, '').length >= 2) phrases.add(part.trim());
  }
  return [...phrases]
    .sort((a, b) => b.length - a.length)
    .map(phrase)
    .filter((pattern): pattern is RegExp => pattern !== null);
}

export function redactText(text: string, identity: JobIdentity): string {
  let out = text;
  for (const pattern of patternsFor(identity)) out = out.replace(pattern, REDACTED);
  return out.replace(COORDINATE_PAIR, REDACTED).replace(DEGREES_MINUTES, REDACTED).replace(DECIMAL_DEGREE, REDACTED);
}

// The facts with every string cleaned; numbers, booleans and shape are kept.
export function promptFacts<T>(value: T, identity: JobIdentity): T {
  if (typeof value === 'string') return redactText(value, identity) as T;
  if (Array.isArray(value)) return value.map((item) => promptFacts(item, identity)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    // defineProperty, so a "__proto__" key stays a plain key.
    for (const [key, item] of Object.entries(value)) {
      Object.defineProperty(out, key, { value: promptFacts(item, identity), enumerable: true, writable: true, configurable: true });
    }
    return out as T;
  }
  return value;
}
