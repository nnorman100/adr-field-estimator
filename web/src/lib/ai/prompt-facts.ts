// The one builder every AI request's job facts go through before any call leaves the server, Model
// Armor's screen included (docs/plans/S7.md section 3: no customer name, address or coordinates in
// any prompt; owner decisions of 2026-11-17). The server never reads the job's saved customer or
// address into the facts, but a technician can type them, or other contact details, into free text (a
// note, a room name, a finding, a walkthrough turn), so every string of the facts is cleaned here:
// - the job's saved customer name: the full name (also "Last, First"), the surname after a title (Mr,
//   Mrs, Ms, Miss, Mx, Dr), and each of those with a possessive ('s). A name word standing alone is
//   left, so a customer named Mary Hall leaves "the hall" alone;
// - the saved property address: each comma-separated part, in its common spellings (Street or St,
//   Avenue or Ave, Unit or Apt or #, any case, punctuation or spacing), the street without its number,
//   and the ZIP code alone;
// - any email address and any phone number;
// - anything shaped like coordinates: a signed or many-decimal pair, latitude or longitude words with
//   a number, a number with a degree sign (not a temperature), degrees with minutes, or a decimal
//   degree with four or more decimals.
// What is removed reads as [removed]. What this cannot catch is in docs/ai/prompt-redaction.md.

export const REDACTED = '[removed]';

// What the job holds that must never reach a model: the saved customer name and property address.
export type JobIdentity = { customerName: string; propertyAddress: string };

export const NO_IDENTITY: JobIdentity = { customerName: '', propertyAddress: '' };

// A word or number standing on its own: no letter or digit right before or after it.
const START = '(?<![\\p{L}\\p{N}])';
const END = '(?![\\p{L}\\p{N}])';
// Between two words of a phrase: any run of spaces, commas, full stops or hyphens, or none ("#4").
const GAP = '[\\s,.\\-]*';
const POSSESSIVE = "(?:['’]s)?";

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
// North American numbers with an optional +1, area code in brackets or not, and seven-digit local
// numbers written with a separator; international numbers starting with +.
const PHONE = new RegExp(
  `${START}(?:\\+?1[\\s.-]?)?(?:\\(\\d{3}\\)\\s*|\\d{3}[\\s.-])\\d{3}[\\s.-]\\d{4}${END}` +
    `|${START}\\d{3}[.-]\\d{4}${END}` +
    `|\\+\\d{1,3}(?:[\\s.-]?\\d{2,4}){2,5}${END}`,
  'gu',
);

const NUMBER_DEG = '[-+]?\\d{1,3}(?:\\.\\d+)?';
const COORDINATES: readonly RegExp[] = [
  // A pair where one value is signed, or both have two or more decimals, by comma or space.
  new RegExp(`[-+]\\d{1,3}\\.\\d+\\s*°?\\s*[NS]?\\s*[,\\s]\\s*[-+]?\\d{1,3}\\.\\d+(?:\\s*°)?(?:\\s*[EW])?`, 'gi'),
  new RegExp(`[-+]?\\d{1,3}\\.\\d+\\s*°?\\s*[NS]?\\s*[,\\s]\\s*[-+]\\d{1,3}\\.\\d+(?:\\s*°)?(?:\\s*[EW])?`, 'gi'),
  new RegExp(`[-+]?\\d{1,3}\\.\\d{2,}\\s*°?\\s*[NS]?\\s*,\\s*[-+]?\\d{1,3}\\.\\d{2,}(?:\\s*°)?(?:\\s*[EW])?`, 'gi'),
  // Latitude or longitude named with its number ("lat 37.77", "longitude: -122.42", "lng=-122").
  new RegExp(`\\b(?:lat(?:itude)?|lon(?:gitude)?|lng|long)\\b\\s*[:=]?\\s*${NUMBER_DEG}(?:\\s*°)?(?:\\s*[NSEW])?${END}`, 'gi'),
  // Degrees with minutes (and seconds).
  /\d{1,3}\s*°\s*\d{1,2}(?:\.\d+)?\s*['′](?:\s*\d{1,2}(?:\.\d+)?\s*["″])?(?:\s*[NSEW])?/gi,
  // A number with a degree sign that is not a temperature (°F, °C), or with a compass letter.
  new RegExp(`${NUMBER_DEG}\\s*°(?!\\s*[FC]${END})(?:\\s*[NSEW])?`, 'gi'),
  new RegExp(`${START}\\d{1,3}\\.\\d+\\s*°?\\s*[NS]\\s*,?\\s*\\d{1,3}\\.\\d+\\s*°?\\s*[EW]${END}`, 'gi'),
  // A decimal degree with four or more decimals.
  /(?<![\d.])[-+]?\d{1,3}\.\d{4,}(?![\d.])/g,
];

// Street words and their common short forms; a unit word may be any of the unit words.
const SPELLINGS: readonly (readonly string[])[] = [
  ['street', 'st', 'str'],
  ['avenue', 'ave', 'av'],
  ['road', 'rd'],
  ['boulevard', 'blvd'],
  ['drive', 'dr'],
  ['lane', 'ln'],
  ['court', 'ct'],
  ['place', 'pl'],
  ['terrace', 'ter', 'terr'],
  ['circle', 'cir'],
  ['highway', 'hwy'],
  ['parkway', 'pkwy'],
  ['square', 'sq'],
  ['trail', 'trl'],
  ['north', 'n'],
  ['south', 's'],
  ['east', 'e'],
  ['west', 'w'],
  ['northeast', 'ne'],
  ['northwest', 'nw'],
  ['southeast', 'se'],
  ['southwest', 'sw'],
  ['apartment', 'apt', 'unit', 'suite', 'ste', 'no', 'number', '#'],
];
const UNIT_WORDS = SPELLINGS[SPELLINGS.length - 1]!;

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The pattern for one word of an address: its spellings, or a number with an optional "#" or
// leading zeros, or the word itself.
function wordPattern(word: string): string {
  const lower = word.toLowerCase();
  if (/^#?\d+[a-z]?$/i.test(word)) {
    const digits = word.replace(/^#/, '').replace(/^0+(?=\d)/, '');
    return `(?:#\\s*)?0*${escape(digits)}`;
  }
  const spellings = SPELLINGS.find((group) => group.includes(lower));
  if (spellings) return `(?:${spellings.map(escape).join('|')})\\.?`;
  return escape(word);
}

// A whole-word, case-blind pattern for a run of address words, with any gap between them.
function addressPattern(words: readonly string[]): string {
  return words.map(wordPattern).join(GAP);
}

function addressPatterns(address: string): string[] {
  const patterns: string[] = [];
  for (const part of address.split(',')) {
    // "#4" or "Apt. 4" read as two words, so every unit spelling matches.
    const words = part
      .replace(/#/g, ' # ')
      .split(/[\s.]+/)
      .filter((word) => word.length > 0);
    if (words.join('').replace(/\W/g, '').length < 2) continue;
    patterns.push(addressPattern(words));
    // The street without its house number ("Oak St" for "12 Oak Street").
    if (/^\d/.test(words[0]!) && words.length >= 3) patterns.push(addressPattern(words.slice(1)));
    // A unit written without its unit word ("Apt 4" also as "#4" is covered; "4" alone is not).
    const unit = words.findIndex((word) => UNIT_WORDS.includes(word.toLowerCase()));
    if (unit > 0 && unit < words.length - 1) patterns.push(addressPattern(words.slice(0, unit)));
    // A ZIP code alone.
    for (const word of words) if (/^\d{5}(?:-\d{4})?$/.test(word)) patterns.push(escape(word));
  }
  return patterns;
}

function namePatterns(name: string): string[] {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) return [];
  const patterns = [words.map(escape).join(GAP)];
  if (words.length >= 2) {
    const surname = words[words.length - 1]!;
    const given = words.slice(0, -1);
    patterns.push(`${escape(surname)}\\s*,\\s*${given.map(escape).join(GAP)}`);
    patterns.push(`(?:mr|mrs|ms|miss|mx|dr)\\.?\\s+${escape(surname)}`);
  }
  return patterns;
}

// The job's patterns, longest first, so a whole name or address part goes before a shorter form.
function patternsFor(identity: JobIdentity): RegExp[] {
  const sources = [...namePatterns(identity.customerName), ...addressPatterns(identity.propertyAddress)];
  return [...new Set(sources)]
    .sort((a, b) => b.length - a.length)
    .map((source) => new RegExp(`${START}(?:${source})${POSSESSIVE}${END}`, 'giu'));
}

export function redactText(text: string, identity: JobIdentity): string {
  let out = text.replace(EMAIL, REDACTED);
  for (const pattern of patternsFor(identity)) out = out.replace(pattern, REDACTED);
  for (const pattern of COORDINATES) out = out.replace(pattern, REDACTED);
  return out.replace(PHONE, REDACTED);
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
