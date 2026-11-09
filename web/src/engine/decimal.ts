// CPython decimal (prec 28, ROUND_HALF_EVEN) with the coefficient and exponent that str() keeps.
// decimal.js drops those trailing zeros, and the pinned oracle compares the Python text.

const PREC = 28;

export type Rounding = 'HALF_EVEN' | 'HALF_UP' | 'CEILING' | 'DOWN';

type Work = { int: bigint; exp: number; sign: 0 | 1 };

function digitLength(value: bigint): number {
  return value.toString().length;
}

export class Dec {
  readonly sign: 0 | 1;
  readonly digits: string;
  readonly exp: number;

  constructor(sign: 0 | 1, digits: string, exp: number) {
    this.sign = sign;
    this.digits = digits;
    this.exp = exp;
  }

  static parse(raw: string): Dec {
    let text = raw.trim();
    let sign: 0 | 1 = 0;
    if (text.startsWith('+') || text.startsWith('-')) {
      sign = text.startsWith('-') ? 1 : 0;
      text = text.slice(1);
    }
    let exp = 0;
    const marker = text.search(/[eE]/);
    if (marker >= 0) {
      exp = Number(text.slice(marker + 1));
      text = text.slice(0, marker);
    }
    const dot = text.indexOf('.');
    if (dot >= 0) {
      exp -= text.length - dot - 1;
      text = text.slice(0, dot) + text.slice(dot + 1);
    }
    if (!/^\d+$/.test(text)) {
      throw new Error(`Invalid decimal ${raw}`);
    }
    if (/^0+$/.test(text)) return new Dec(sign, '0', exp);
    return new Dec(sign, text.replace(/^0+/, ''), exp);
  }

  static fromInt(value: number): Dec {
    if (!Number.isInteger(value)) throw new Error(`Not an integer: ${value}`);
    if (value === 0) return new Dec(0, '0', 0);
    if (value < 0) return new Dec(1, String(-value), 0);
    return new Dec(0, String(value), 0);
  }

  isZero(): boolean {
    return this.digits === '0';
  }

  copyNegate(): Dec {
    return new Dec(this.sign === 0 ? 1 : 0, this.digits, this.exp);
  }

  neg(): Dec {
    if (this.isZero()) return new Dec(0, '0', this.exp);
    return this.copyNegate();
  }

  abs(): Dec {
    return new Dec(0, this.digits, this.exp);
  }

  cmp(other: Dec): number {
    if (this.isZero() && other.isZero()) return 0;
    if (this.sign !== other.sign) return this.sign === 0 ? 1 : -1;
    const mag = compareAbs(this, other);
    return this.sign === 0 ? mag : -mag;
  }

  eq(other: Dec): boolean {
    return this.cmp(other) === 0;
  }

  lt(other: Dec): boolean {
    return this.cmp(other) < 0;
  }

  gt(other: Dec): boolean {
    return this.cmp(other) > 0;
  }

  add(other: Dec): Dec {
    return addDec(this, other);
  }

  sub(other: Dec): Dec {
    // Python's minus on a zero keeps that zero positive, which still rescales the other operand.
    return addDec(this, other.neg());
  }

  mul(other: Dec): Dec {
    const sign = (this.sign ^ other.sign) as 0 | 1;
    const exp = this.exp + other.exp;
    if (this.isZero() || other.isZero()) return fix(new Dec(sign, '0', exp));
    if (this.digits === '1') return fix(new Dec(sign, other.digits, exp));
    if (other.digits === '1') return fix(new Dec(sign, this.digits, exp));
    const coeff = (BigInt(this.digits) * BigInt(other.digits)).toString();
    return fix(new Dec(sign, coeff, exp));
  }

  div(other: Dec): Dec {
    if (other.isZero()) throw new Error('Division by zero');
    const sign = (this.sign ^ other.sign) as 0 | 1;
    if (this.isZero()) return fix(new Dec(sign, '0', this.exp - other.exp));
    const shift = other.digits.length - this.digits.length + PREC + 1;
    let exp = this.exp - other.exp - shift;
    const left = BigInt(this.digits);
    const right = BigInt(other.digits);
    let coeff: bigint;
    let remainder: bigint;
    if (shift >= 0) {
      const scaled = left * 10n ** BigInt(shift);
      coeff = scaled / right;
      remainder = scaled % right;
    } else {
      const scaled = right * 10n ** BigInt(-shift);
      coeff = left / scaled;
      remainder = left % scaled;
    }
    if (remainder !== 0n) {
      if (coeff % 5n === 0n) coeff += 1n;
    } else {
      const ideal = this.exp - other.exp;
      while (exp < ideal && coeff % 10n === 0n) {
        coeff /= 10n;
        exp += 1;
      }
    }
    return fix(new Dec(sign, coeff.toString(), exp));
  }

  quantize(exp: number, rounding: Rounding): Dec {
    return fix(rescale(this, exp, rounding));
  }

  toIntegral(rounding: Rounding): Dec {
    if (this.exp >= 0) return new Dec(this.sign, this.digits, this.exp);
    if (this.isZero()) return new Dec(this.sign, '0', 0);
    return rescale(this, 0, rounding);
  }

  normalize(): Dec {
    const fixed = fix(this);
    if (fixed.isZero()) return new Dec(fixed.sign, '0', 0);
    let end = fixed.digits.length;
    let exp = fixed.exp;
    while (fixed.digits[end - 1] === '0') {
      exp += 1;
      end -= 1;
    }
    return new Dec(fixed.sign, fixed.digits.slice(0, end), exp);
  }

  toString(): string {
    const sign = this.sign ? '-' : '';
    const leftDigits = this.exp + this.digits.length;
    const dotplace = this.exp <= 0 && leftDigits > -6 ? leftDigits : 1;
    let intPart: string;
    let fracPart: string;
    if (dotplace <= 0) {
      intPart = '0';
      fracPart = `.${'0'.repeat(-dotplace)}${this.digits}`;
    } else if (dotplace >= this.digits.length) {
      intPart = this.digits + '0'.repeat(dotplace - this.digits.length);
      fracPart = '';
    } else {
      intPart = this.digits.slice(0, dotplace);
      fracPart = `.${this.digits.slice(dotplace)}`;
    }
    let exponent = '';
    if (leftDigits !== dotplace) {
      const value = leftDigits - dotplace;
      exponent = `E${value >= 0 ? '+' : ''}${value}`;
    }
    return sign + intPart + fracPart + exponent;
  }

  /** Python format specs used by the documents: f, ,f, .2f, ,.2f. */
  format(spec: 'f' | ',f' | '.2f' | ',.2f'): string {
    const places = spec.includes('.2') ? 2 : null;
    const withCommas = spec.startsWith(',') || spec.includes(',.');
    const shown = places === null ? this : this.quantize(-places, 'HALF_EVEN');
    return renderFixed(shown, withCommas);
  }

  toNumber(): number {
    return Number(this.toString());
  }
}

function compareAbs(left: Dec, right: Dec): number {
  const exp = Math.min(left.exp, right.exp);
  const a = BigInt(left.digits) * 10n ** BigInt(left.exp - exp);
  const b = BigInt(right.digits) * 10n ** BigInt(right.exp - exp);
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function rescale(value: Dec, exp: number, rounding: Rounding): Dec {
  if (value.isZero()) return new Dec(value.sign, '0', exp);
  if (value.exp >= exp) {
    return new Dec(value.sign, value.digits + '0'.repeat(value.exp - exp), exp);
  }
  let digits = value.digits.length + value.exp - exp;
  let current = value;
  if (digits < 0) {
    current = new Dec(value.sign, '1', exp - 1);
    digits = 0;
  }
  const changed = roundAt(current, digits, rounding);
  let coeff = current.digits.slice(0, digits) || '0';
  if (changed === 1) coeff = (BigInt(coeff) + 1n).toString();
  coeff = coeff.replace(/^0+/, '') || '0';
  return new Dec(current.sign, coeff, exp);
}

function roundAt(value: Dec, keep: number, rounding: Rounding): -1 | 0 | 1 {
  const towardZero = (): -1 | 0 => {
    const rest = value.digits.slice(keep);
    if (rest.length === 0 || /^0+$/.test(rest)) return 0;
    return -1;
  };
  const halfUp = (): -1 | 0 | 1 => {
    const digit = value.digits[keep] ?? '0';
    if ('56789'.includes(digit)) return 1;
    return towardZero();
  };
  if (rounding === 'HALF_UP') return halfUp();
  if (rounding === 'DOWN') return towardZero();
  if (rounding === 'HALF_EVEN') {
    const rest = value.digits.slice(keep);
    const exactHalf = rest[0] === '5' && /^0*$/.test(rest.slice(1));
    const even = keep === 0 || '02468'.includes(value.digits[keep - 1] ?? '0');
    if (exactHalf && even) return -1;
    return halfUp();
  }
  const down = towardZero();
  if (value.sign === 1) return down;
  return down === 0 ? 0 : 1;
}

function fix(value: Dec): Dec {
  if (value.isZero()) return value;
  const expMin = value.digits.length + value.exp - PREC;
  if (value.exp >= expMin) return value;
  const keep = value.digits.length + value.exp - expMin;
  const changed = roundAt(value, keep, 'HALF_EVEN');
  let coeff = value.digits.slice(0, keep) || '0';
  let exp = expMin;
  if (changed > 0) {
    coeff = (BigInt(coeff) + 1n).toString();
    if (coeff.length > PREC) {
      coeff = coeff.slice(0, -1);
      exp += 1;
    }
  }
  coeff = coeff.replace(/^0+/, '') || '0';
  return new Dec(value.sign, coeff, exp);
}

function align(left: Work, right: Work): void {
  let tmp = left;
  let other = right;
  let tmpLen = digitLength(left.int);
  let otherLen = digitLength(right.int);
  if (left.exp < right.exp) {
    tmp = right;
    other = left;
    tmpLen = digitLength(right.int);
    otherLen = digitLength(left.int);
  }
  const limit = tmp.exp + Math.min(-1, tmpLen - PREC - 2);
  if (otherLen + other.exp - 1 < limit) {
    other.int = 1n;
    other.exp = limit;
  }
  const diff = tmp.exp - other.exp;
  tmp.int *= 10n ** BigInt(diff);
  tmp.exp = other.exp;
}

function addDec(left: Dec, right: Dec): Dec {
  const alignedExp = Math.min(left.exp, right.exp);
  if (left.isZero() && right.isZero()) {
    return fix(new Dec(Math.min(left.sign, right.sign) as 0 | 1, '0', alignedExp));
  }
  if (left.isZero()) {
    const exp = Math.max(alignedExp, right.exp - PREC - 1);
    return fix(rescale(right, exp, 'HALF_EVEN'));
  }
  if (right.isZero()) {
    const exp = Math.max(alignedExp, left.exp - PREC - 1);
    return fix(rescale(left, exp, 'HALF_EVEN'));
  }
  const op1: Work = { int: BigInt(left.digits), exp: left.exp, sign: left.sign };
  const op2: Work = { int: BigInt(right.digits), exp: right.exp, sign: right.sign };
  align(op1, op2);
  let resultSign: 0 | 1 = 0;
  if (op1.sign !== op2.sign) {
    if (op1.int === op2.int) return fix(new Dec(0, '0', alignedExp));
    if (op1.int < op2.int) {
      const saved = { ...op1 };
      op1.int = op2.int;
      op1.exp = op2.exp;
      op1.sign = op2.sign;
      op2.int = saved.int;
      op2.exp = saved.exp;
      op2.sign = saved.sign;
    }
    if (op1.sign === 1) {
      resultSign = 1;
      const saved = op1.sign;
      op1.sign = op2.sign;
      op2.sign = saved;
    }
  } else if (op1.sign === 1) {
    resultSign = 1;
    op1.sign = 0;
    op2.sign = 0;
  }
  const result = op2.sign === 0 ? op1.int + op2.int : op1.int - op2.int;
  return fix(new Dec(resultSign, result.toString(), op1.exp));
}

function renderFixed(value: Dec, withCommas: boolean): string {
  const negative = value.sign === 1;
  let body: string;
  if (value.exp >= 0) {
    body = value.digits + '0'.repeat(value.exp);
  } else if (value.digits.length <= -value.exp) {
    body = `0.${value.digits.padStart(-value.exp, '0')}`;
  } else {
    const cut = value.digits.length + value.exp;
    body = `${value.digits.slice(0, cut)}.${value.digits.slice(cut)}`;
  }
  if (!withCommas) return (negative ? '-' : '') + body;
  const [whole, frac] = body.split('.');
  const grouped = (whole ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (negative ? '-' : '') + grouped + (frac !== undefined ? `.${frac}` : '');
}

export const ZERO = Dec.fromInt(0);
export const ONE = Dec.fromInt(1);
export const HUNDRED = Dec.fromInt(100);
export const CENT = Dec.parse('0.01');

export function D(value: string | number | Dec): Dec {
  if (value instanceof Dec) return value;
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return Dec.fromInt(value);
    throw new Error('Use Dec.parse for non-integer numbers');
  }
  return Dec.parse(value);
}

export function money(value: Dec): Dec {
  return value.quantize(-2, 'HALF_UP');
}

export function sumDec(values: Dec[], start: Dec = ZERO): Dec {
  return values.reduce((total, value) => total.add(value), start);
}

/** max() and min() keep the first operand when the values compare equal. */
export function maxDec(left: Dec, right: Dec): Dec {
  return left.cmp(right) >= 0 ? left : right;
}

export function minDec(left: Dec, right: Dec): Dec {
  return left.cmp(right) <= 0 ? left : right;
}

export function maxOf(values: Dec[], fallback: Dec = ZERO): Dec {
  return values.reduce((best, value) => maxDec(best, value), values[0] ?? fallback);
}

export function percentText(value: Dec | string): string {
  const parsed = typeof value === 'string' ? Dec.parse(value) : value;
  return parsed.normalize().format('f');
}
