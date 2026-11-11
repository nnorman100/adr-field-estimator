// Plain JSON values and the canonical text the content hash is taken over.
// Money and other fractions are Decimal strings; a JSON number in the engine is always an integer.

import { createHash } from 'node:crypto';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JObj = { [key: string]: Json };

export function isObj(value: Json | undefined): value is JObj {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function compareKeys(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  const count = Math.min(a.length, b.length);
  for (let index = 0; index < count; index += 1) {
    const diff = (a[index] ?? '').codePointAt(0)! - (b[index] ?? '').codePointAt(0)!;
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}

/** Keys sorted by code point, no spaces, integers only: the same value always gives the same text. */
export function canonical(value: Json): string {
  if (value === undefined) throw new Error('A missing value is not canonical JSON.');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('Only whole numbers are canonical JSON.');
    return String(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`;
  const keys = Object.keys(value).sort(compareKeys);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key] as Json)}`).join(',')}}`;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
