// Pydantic lax-mode input coercion, the rules the reference models apply to a JSON-loaded value.
// Every reader converts scalars here; callers only add the field's bounds and shape.

import { Dec } from './decimal';
import { JFloat, JInt, type JVal, pyFloat } from './json';
import { PY_SPACE, asciiDigits, chars } from './pystr';

export class Invalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Invalid';
  }
}

function no(label: string): never {
  throw new Invalid(label);
}

const RUST_SPACE =
  '\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const RUST_TRIM = new RegExp(`^[${RUST_SPACE}]+|[${RUST_SPACE}]+$`, 'g');
const PY_SPACE_CHAR = new RegExp(`[${PY_SPACE}]`, 'gu');
const DECIMAL_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const INT_TEXT = /^([+-]?\d+(?:_\d+)*)(?:\.0+)?$/;
const I64 = 2 ** 63;

export function toStr(value: JVal | undefined, label: string, min = 0, max = Infinity): string {
  if (typeof value !== 'string') no(label);
  const count = chars(value);
  if (count < min || count > max) no(label);
  return value;
}

export function toPattern(value: JVal | undefined, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) no(label);
  return value;
}

export function toChoice<T extends string>(
  value: JVal | undefined,
  choices: readonly T[],
  label: string,
): T {
  if (typeof value !== 'string' || !(choices as readonly string[]).includes(value)) no(label);
  return value as T;
}

export function toIntChoice(
  value: JVal | undefined,
  choices: readonly number[],
  label: string,
): number {
  let n: number;
  if (typeof value === 'boolean') n = value ? 1 : 0;
  else if (value instanceof JInt) n = value.value;
  else if (value instanceof JFloat && Number.isInteger(value.value)) n = value.value;
  else no(label);
  if (!choices.includes(n)) no(label);
  return Object.is(n, -0) ? 0 : n;
}

export function toInt(value: JVal | undefined, label: string): bigint {
  if (typeof value === 'boolean') return value ? 1n : 0n;
  if (value instanceof JInt) return value.big;
  if (value instanceof JFloat) {
    const n = value.value;
    if (!Number.isInteger(n) || n < -I64 || n >= I64) no(label);
    return BigInt(n);
  }
  if (typeof value === 'string') {
    const match = INT_TEXT.exec(value.replace(RUST_TRIM, ''));
    if (!match) no(label);
    return BigInt((match[1] ?? '').replaceAll('_', ''));
  }
  no(label);
}

export function toFloat(value: JVal | undefined, label: string): number {
  let n: number;
  if (typeof value === 'boolean') n = value ? 1 : 0;
  else if (value instanceof JInt) n = Number(value.big);
  else if (value instanceof JFloat) n = value.value;
  else if (typeof value === 'string') {
    const text = value.replace(RUST_TRIM, '');
    if (text.startsWith('_') || text.endsWith('_') || text.includes('__')) no(label);
    const plain = text.replaceAll('_', '');
    if (!DECIMAL_TEXT.test(plain)) no(label);
    n = Number(plain);
  } else no(label);
  if (!Number.isFinite(n)) no(label);
  return n;
}

/** Decimal places after trailing zeros are dropped, as pydantic's decimal_places counts them. */
export function places(amount: Dec): number {
  const normal = amount.normalize();
  return normal.exp < 0 ? -normal.exp : 0;
}

export function toDecimal(value: JVal | undefined, label: string): Dec {
  let text: string;
  if (value instanceof JInt) text = value.big.toString();
  else if (value instanceof JFloat) {
    if (!Number.isFinite(value.value)) no(label);
    text = pyFloat(value.value);
  } else if (typeof value === 'string') {
    text = asciiDigits(value.replaceAll('_', '').replace(PY_SPACE_CHAR, ' ')).replace(
      /^ +| +$/g,
      '',
    );
    if (!DECIMAL_TEXT.test(text)) no(label);
  } else no(label);
  return Dec.parse(text);
}

const TRUE_TEXT = new Set(['1', 'on', 't', 'true', 'y', 'yes']);
const FALSE_TEXT = new Set(['0', 'off', 'f', 'false', 'n', 'no']);

export function toBool(value: JVal | undefined, label: string): boolean {
  if (typeof value === 'boolean') return value;
  if (value instanceof JInt || value instanceof JFloat) {
    if (value.value === 0) return false;
    if (value.value === 1) return true;
    no(label);
  }
  if (typeof value === 'string') {
    const text = value.replace(/[A-Z]/g, (char) => char.toLowerCase());
    if (TRUE_TEXT.has(text)) return true;
    if (FALSE_TEXT.has(text)) return false;
  }
  no(label);
}

function daysIn(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function validDate(year: number, month: number, day: number): boolean {
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysIn(year, month);
}

const ISO_TEXT =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt _](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?([Zz]|[+-]\d{2}:?\d{2})?)?$/;
const MS_WATERSHED = 2e10;
const FIRST_MICROS = -62135596800000000n;
const LAST_MICROS = 253402300799999999n;

function halfAway(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

function fromMicros(total: bigint, label: string): string {
  if (total < FIRST_MICROS || total > LAST_MICROS) no(label);
  let seconds = total / 1000000n;
  let micro = total % 1000000n;
  if (micro < 0n) {
    micro += 1000000n;
    seconds -= 1n;
  }
  const iso = new Date(Number(seconds) * 1000).toISOString();
  const fraction = micro ? `.${micro.toString().padStart(6, '0')}` : '';
  return `${iso.slice(0, 19)}${fraction}Z`;
}

function fromTimestamp(value: number | bigint, label: string): string {
  if (typeof value === 'bigint') {
    const magnitude = value < 0n ? -value : value;
    if (magnitude >= 2n ** 63n) no(label);
    return fromMicros(magnitude > BigInt(MS_WATERSHED) ? value * 1000n : value * 1000000n, label);
  }
  if (!Number.isFinite(value)) no(label);
  const whole = Math.floor(value);
  if (Math.abs(value) > MS_WATERSHED) {
    if (Math.abs(whole) >= 2 ** 63) no(label);
    return fromMicros(BigInt(whole) * 1000n + BigInt(halfAway((value - whole) * 1000)), label);
  }
  return fromMicros(BigInt(whole) * 1000000n + BigInt(halfAway((value - whole) * 1e6)), label);
}

/** A datetime as pydantic dumps it: ISO text with microseconds when set and Z for UTC. */
export function toDateTime(value: JVal | undefined, label: string): string {
  if (value instanceof JInt) return fromTimestamp(value.big, label);
  if (value instanceof JFloat) return fromTimestamp(value.value, label);
  if (typeof value !== 'string') no(label);
  if (/^[+-]?\d+$/.test(value)) return fromTimestamp(BigInt(value), label);
  if (/^[+-]?(\d+\.\d*|\.\d+)([eE][+-]?\d+)?$/.test(value))
    return fromTimestamp(Number(value), label);
  const match = ISO_TEXT.exec(value);
  if (!match) no(label);
  const [, year, month, day, hour = '00', minute = '00', second = '00', fraction = '', zone] =
    match;
  if (!validDate(Number(year), Number(month), Number(day))) no(label);
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) no(label);
  const micro = fraction.slice(0, 6).padEnd(6, '0');
  let offset = '';
  if (zone !== undefined) {
    const hours = zone.length > 1 ? zone.slice(1, 3) : '00';
    const minutes = zone.length > 1 ? zone.slice(-2) : '00';
    if (Number(hours) > 23 || Number(minutes) > 59) no(label);
    offset = Number(hours) === 0 && Number(minutes) === 0 ? 'Z' : `${zone[0]}${hours}:${minutes}`;
  }
  const time = `${hour}:${minute}:${second}${Number(micro) ? `.${micro}` : ''}`;
  return `${year}-${month}-${day}T${time}${offset}`;
}
