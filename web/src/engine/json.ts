// Python json.dumps(sort_keys=True, separators=(',', ':'), allow_nan=False).
// Floats use CPython's shortest round-trip text. Integers stay integers, including the 1 vs 1.0 split.

import { createHash } from 'node:crypto';
import { Dec } from './decimal';

export class JInt {
  readonly kind = 'int' as const;
  readonly value: number;
  readonly big: bigint;

  constructor(value: number | bigint) {
    this.big = typeof value === 'bigint' ? value : BigInt(value);
    this.value = Number(this.big);
  }
}

export class JFloat {
  readonly kind = 'float' as const;
  readonly value: number;

  constructor(value: number) {
    this.value = value;
  }
}

export type JNum = JInt | JFloat;
export type JObj = { [key: string]: JVal };
export type JVal = null | boolean | string | JNum | JVal[] | JObj;

/** A key-value record without a prototype, so every key reads as Python dict.get reads it. */
export function dict<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

export function jint(value: number): JInt {
  return new JInt(value);
}

export function jfloat(value: number): JFloat {
  return new JFloat(value);
}

export function asString(value: JVal): string {
  if (typeof value === 'string') return value;
  throw new Error('Expected a string');
}

/** Decimal(str(float)), the conversion the pricing code uses when it rereads a JSON number. */
export function decFromFloat(value: number): Dec {
  return Dec.parse(pyFloat(value));
}

export function pyFloat(value: number): string {
  if (Object.is(value, -0)) return '-0.0';
  if (value === 0) return '0.0';
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const digits = abs.toString();
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(digits);
  if (!match) return sign + digits;
  const intPart = match[1] ?? '0';
  const frac = match[2] ?? '';
  const expGiven = match[3] !== undefined ? Number(match[3]) : 0;
  const raw = intPart + frac;
  let first = 0;
  while (first < raw.length - 1 && raw[first] === '0') first += 1;
  const sig = raw.slice(first).replace(/0+$/, '');
  const lastExp = expGiven - frac.length;
  const firstExp = lastExp + (raw.length - 1 - first);
  const useExp = firstExp < -4 || firstExp >= 16;
  let out: string;
  if (!useExp) {
    if (firstExp >= 0) {
      const wholeLen = firstExp + 1;
      out =
        wholeLen >= sig.length
          ? sig + '0'.repeat(wholeLen - sig.length) + '.0'
          : `${sig.slice(0, wholeLen)}.${sig.slice(wholeLen)}`;
    } else {
      out = `0.${'0'.repeat(-firstExp - 1)}${sig}`;
    }
  } else {
    const rest = sig.slice(1);
    const expStr = (firstExp >= 0 ? '+' : '-') + String(Math.abs(firstExp)).padStart(2, '0');
    out = `${rest ? `${sig[0]}.${rest}` : sig[0]}e${expStr}`;
  }
  return sign + out;
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

function escapeString(value: string): string {
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === '"') out += '\\"';
    else if (char === '\\') out += '\\\\';
    else if (char === '\b') out += '\\b';
    else if (char === '\f') out += '\\f';
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else if (code < 0x7f) out += char;
    else if (code < 0x10000) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else {
      const shifted = code - 0x10000;
      const high = 0xd800 + (shifted >> 10);
      const low = 0xdc00 + (shifted & 0x3ff);
      out += `\\u${high.toString(16).padStart(4, '0')}\\u${low.toString(16).padStart(4, '0')}`;
    }
  }
  return `${out}"`;
}

export function canonical(value: JVal): string {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'string') return escapeString(value);
  if (value instanceof JInt) return value.big.toString();
  if (value instanceof JFloat) {
    if (!Number.isFinite(value.value))
      throw new Error('Out of range float values are not JSON compliant');
    return pyFloat(value.value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`;
  const keys = Object.keys(value).sort(compareKeys);
  return `{${keys.map((key) => `${escapeString(key)}:${canonical(value[key] as JVal)}`).join(',')}}`;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function parseJson(text: string): JVal {
  const parser = new Parser(text);
  const value = parser.parseValue();
  parser.skip();
  if (!parser.done()) throw new Error('Extra data');
  return value;
}

const SPACE = new Set([' ', '\t', '\n', '\r']);
const ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};
const NUMBER = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?/y;
const CONSTANTS: Array<[string, JVal]> = [
  ['true', true],
  ['false', false],
  ['null', null],
  ['NaN', new JFloat(Number.NaN)],
  ['Infinity', new JFloat(Number.POSITIVE_INFINITY)],
  ['-Infinity', new JFloat(Number.NEGATIVE_INFINITY)],
];
const MAX_INT_DIGITS = 4300;

class Parser {
  private index = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  done(): boolean {
    return this.index >= this.text.length;
  }

  skip(): void {
    while (SPACE.has(this.text[this.index] ?? '')) this.index += 1;
  }

  parseValue(): JVal {
    this.skip();
    const char = this.text[this.index];
    if (char === '{') return this.parseObject();
    if (char === '[') return this.parseArray();
    if (char === '"') return this.parseString();
    for (const [word, value] of CONSTANTS) {
      if (this.text.startsWith(word, this.index)) {
        this.index += word.length;
        return value;
      }
    }
    return this.parseNumber();
  }

  private parseObject(): JObj {
    this.index += 1;
    const out = dict<JVal>();
    this.skip();
    if (this.text[this.index] === '}') {
      this.index += 1;
      return out;
    }
    for (;;) {
      this.skip();
      if (this.text[this.index] !== '"') throw new Error('Expecting property name');
      const key = this.parseString();
      this.skip();
      if (this.text[this.index] !== ':') throw new Error('Expected colon');
      this.index += 1;
      out[key] = this.parseValue();
      this.skip();
      const mark = this.text[this.index];
      this.index += 1;
      if (mark === '}') return out;
      if (mark !== ',') throw new Error('Expected comma');
    }
  }

  private parseArray(): JVal[] {
    this.index += 1;
    const out: JVal[] = [];
    this.skip();
    if (this.text[this.index] === ']') {
      this.index += 1;
      return out;
    }
    for (;;) {
      out.push(this.parseValue());
      this.skip();
      const mark = this.text[this.index];
      this.index += 1;
      if (mark === ']') return out;
      if (mark !== ',') throw new Error('Expected comma');
    }
  }

  private hex(): number {
    const digits = this.text.slice(this.index, this.index + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(digits)) throw new Error('Invalid \\uXXXX escape');
    this.index += 4;
    return Number.parseInt(digits, 16);
  }

  private parseString(): string {
    this.index += 1;
    let out = '';
    while (this.index < this.text.length) {
      const char = this.text[this.index] ?? '';
      this.index += 1;
      if (char === '"') return out;
      if (char < ' ') throw new Error('Invalid control character');
      if (char !== '\\') {
        out += char;
        continue;
      }
      const escaped = this.text[this.index] ?? '';
      this.index += 1;
      if (escaped !== 'u') {
        const decoded = ESCAPES[escaped];
        if (decoded === undefined) throw new Error('Invalid \\escape');
        out += decoded;
        continue;
      }
      let code = this.hex();
      if (code >= 0xd800 && code <= 0xdbff && this.text.startsWith('\\u', this.index)) {
        const mark = this.index;
        this.index += 2;
        const low = this.hex();
        if (low >= 0xdc00 && low <= 0xdfff)
          code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        else this.index = mark;
      }
      out += String.fromCodePoint(code);
    }
    throw new Error('Unterminated string');
  }

  private parseNumber(): JNum {
    NUMBER.lastIndex = this.index;
    const match = NUMBER.exec(this.text);
    if (!match) throw new Error('Expecting value');
    const token = match[0];
    this.index += token.length;
    if (match[1] === undefined && match[2] === undefined) {
      if (token.replace('-', '').length > MAX_INT_DIGITS)
        throw new Error('Exceeds the limit for integer string conversion');
      return new JInt(BigInt(token));
    }
    return new JFloat(Number(token));
  }
}
