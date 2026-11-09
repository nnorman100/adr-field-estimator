// Python json.dumps(sort_keys=True, separators=(',', ':'), allow_nan=False).
// Floats use CPython's shortest round-trip text. Integers stay integers, including the 1 vs 1.0 split.

import { createHash } from 'node:crypto';
import { Dec } from './decimal';

export class JInt {
  readonly kind = 'int' as const;
  readonly value: number;

  constructor(value: number) {
    this.value = value;
  }
}

export class JFloat {
  readonly kind = 'float' as const;
  readonly value: number;
  readonly token: string | undefined;

  constructor(value: number, token?: string) {
    this.value = value;
    this.token = token;
  }
}

export type JNum = JInt | JFloat;
export type JObj = { [key: string]: JVal };
export type JVal = null | boolean | string | JNum | JVal[] | JObj;

export function jint(value: number): JInt {
  return new JInt(value);
}

export function jfloat(value: number): JFloat {
  return new JFloat(value);
}

export function isNum(value: JVal): value is JNum {
  return value instanceof JInt || value instanceof JFloat;
}

export function asNumber(value: JVal): number {
  if (value instanceof JInt || value instanceof JFloat) return value.value;
  throw new Error('Expected a number');
}

export function asString(value: JVal): string {
  if (typeof value === 'string') return value;
  throw new Error('Expected a string');
}

export function asObject(value: JVal): JObj {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && !isNum(value)) {
    return value;
  }
  throw new Error('Expected an object');
}

export function asArray(value: JVal): JVal[] {
  if (Array.isArray(value)) return value;
  throw new Error('Expected an array');
}

/** Drop undefined entries so optional document keys stay absent. */
export function jobj(entries: Record<string, JVal | undefined>): JObj {
  const out: JObj = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
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
  let digits: string | null = null;
  for (let precision = 1; precision <= 17; precision += 1) {
    const candidate = abs.toPrecision(precision);
    if (Number(candidate) === abs) {
      digits = candidate;
      break;
    }
  }
  if (digits === null) digits = abs.toPrecision(17);
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(digits);
  if (!match) return sign + digits;
  const intPart = match[1] ?? '0';
  const frac = match[2] ?? '';
  const expGiven = match[3] !== undefined ? Number(match[3]) : 0;
  const raw = intPart + frac;
  let first = 0;
  while (first < raw.length - 1 && raw[first] === '0') first += 1;
  const sig = raw.slice(first);
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
    else if (code < 0x80) out += char;
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
  if (value instanceof JInt) return String(value.value);
  if (value instanceof JFloat) return value.token ?? pyFloat(value.value);
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
  if (!parser.done()) throw new Error('Trailing JSON');
  return value;
}

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
    while (this.index < this.text.length && /\s/.test(this.text[this.index] ?? '')) this.index += 1;
  }

  parseValue(): JVal {
    this.skip();
    const char = this.text[this.index];
    if (char === '{') return this.parseObject();
    if (char === '[') return this.parseArray();
    if (char === '"') return this.parseString();
    if (char === 't' || char === 'f') return this.parseBoolean();
    if (char === 'n') return this.parseNull();
    return this.parseNumber();
  }

  private parseObject(): JObj {
    this.index += 1;
    const out: JObj = {};
    this.skip();
    if (this.text[this.index] === '}') {
      this.index += 1;
      return out;
    }
    for (;;) {
      this.skip();
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

  private parseString(): string {
    this.index += 1;
    let out = '';
    while (this.index < this.text.length) {
      const char = this.text[this.index] ?? '';
      if (char === '"') {
        this.index += 1;
        return out;
      }
      if (char === '\\') {
        const escaped = this.text[this.index + 1] ?? '';
        this.index += 2;
        if (escaped === 'u') {
          const hex = this.text.slice(this.index, this.index + 4);
          this.index += 4;
          let code = Number.parseInt(hex, 16);
          if (code >= 0xd800 && code <= 0xdbff) {
            const next = this.text.slice(this.index, this.index + 6);
            if (next.startsWith('\\u')) {
              const low = Number.parseInt(next.slice(2), 16);
              if (low >= 0xdc00 && low <= 0xdfff) {
                this.index += 6;
                code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
              }
            }
          }
          out += String.fromCodePoint(code);
        } else if (escaped === 'b') out += '\b';
        else if (escaped === 'f') out += '\f';
        else if (escaped === 'n') out += '\n';
        else if (escaped === 'r') out += '\r';
        else if (escaped === 't') out += '\t';
        else out += escaped;
      } else {
        out += char;
        this.index += 1;
      }
    }
    throw new Error('Unterminated string');
  }

  private parseBoolean(): boolean {
    if (this.text.startsWith('true', this.index)) {
      this.index += 4;
      return true;
    }
    if (this.text.startsWith('false', this.index)) {
      this.index += 5;
      return false;
    }
    throw new Error('Expected boolean');
  }

  private parseNull(): null {
    if (!this.text.startsWith('null', this.index)) throw new Error('Expected null');
    this.index += 4;
    return null;
  }

  private parseNumber(): JNum {
    const start = this.index;
    if (this.text[this.index] === '-') this.index += 1;
    while (/\d/.test(this.text[this.index] ?? '')) this.index += 1;
    let isFloat = false;
    if (this.text[this.index] === '.') {
      isFloat = true;
      this.index += 1;
      while (/\d/.test(this.text[this.index] ?? '')) this.index += 1;
    }
    if (this.text[this.index] === 'e' || this.text[this.index] === 'E') {
      isFloat = true;
      this.index += 1;
      if (this.text[this.index] === '+' || this.text[this.index] === '-') this.index += 1;
      while (/\d/.test(this.text[this.index] ?? '')) this.index += 1;
    }
    const token = this.text.slice(start, this.index);
    if (token === '-' || token === '') throw new Error('Expected number');
    const value = Number(token);
    if (!isFloat) return new JInt(Object.is(value, -0) ? 0 : value);
    return new JFloat(value, token);
  }
}
