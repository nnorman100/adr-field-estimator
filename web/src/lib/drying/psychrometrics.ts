// The air values of a drying-log air reading (S5b-10), worked out on the server only: a port of the old
// app's backend/psychrometrics.py, which tests/unit/drying-psychrometrics.test.ts checks against values
// that helper printed. Dry-bulb temperature (°F) and relative humidity (%) give grains of moisture per
// pound of dry air (GPP), dew point (°F), dew-point depression (°F), vapor pressure (inHg) and specific
// enthalpy (BTU/lb), the quantities the IICRC S500 drying record uses.
//
// - Saturation vapor pressure over water: the Magnus form 6.1121 · exp(17.67·T / (T + 243.5)) hPa,
//   T in °C.
// - Humidity ratio W = 0.62198 · e / (P − e) at the standard sea-level pressure P = 1013.25 hPa, 7000
//   grains per pound. Altitude is not corrected.
// - Dew point by inverting the Magnus form.
// - Enthalpy h = 0.240·t + W·(1061 + 0.444·t), t in °F.
//
// Rounding is Python's: round() to the nearest, a tie to the even neighbour, decided on the exact value
// of the binary number (so 0.0005 stored a hair under its decimal rounds down, as in Python).

const STANDARD_PRESSURE_HPA = 1013.25;
const GRAINS_PER_POUND = 7000;
const HPA_TO_INHG = 0.02953;

export type AirValues = {
  gpp: number;
  dewPointF: number;
  dewPointDepressionF: number;
  vaporPressureInhg: number;
  enthalpyBtuLb: number;
};

// A finite double as an exact fraction: |x| = mantissa · 2^exponent.
function exactParts(x: number): { mantissa: bigint; exponent: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(x));
  const bits = view.getBigUint64(0);
  const biased = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & 0xfffffffffffffn;
  if (biased === 0) return { mantissa: fraction, exponent: -1074 };
  return { mantissa: fraction | (1n << 52n), exponent: biased - 1075 };
}

/** Python's round(x, digits) for a finite x and 0 or more digits: half to even on the exact value. */
export function roundHalfEven(x: number, digits = 0): number {
  if (!Number.isFinite(x)) throw new RangeError('round needs a finite number');
  if (x === 0) return 0;
  const { mantissa, exponent } = exactParts(x);
  const scale = 10n ** BigInt(digits);
  let rounded: bigint;
  if (exponent >= 0) {
    rounded = mantissa * scale * (1n << BigInt(exponent));
  } else {
    const numerator = mantissa * scale;
    const denominator = 1n << BigInt(-exponent);
    const quotient = numerator / denominator;
    const twice = (numerator % denominator) * 2n;
    rounded = twice > denominator || (twice === denominator && quotient % 2n === 1n) ? quotient + 1n : quotient;
  }
  const sign = x < 0 ? '-' : '';
  if (digits === 0) return Number(`${sign}${rounded}`) + 0;
  const text = rounded.toString().padStart(digits + 1, '0');
  // The decimal read back is the double nearest it, as Python's round returns.
  return Number(`${sign}${text.slice(0, -digits)}.${text.slice(-digits)}`) + 0;
}

// exp and log, correctly rounded. Math.exp and Math.log may differ from the C library Python calls by
// one unit in the last place (V8's exp does at 24.5 °F, 100% RH, which moves a dew point across a
// rounding tie), so these work in exact fixed point (PRECISION fraction bits, far past a double's 53)
// and round once to the nearest double. The arithmetic is then the same on every engine, and it gave
// the Python helper's five values for every quarter degree from -40 to 150 °F at every quarter percent
// from 1 to 100% RH (302,117 pairs, checked when this was written).
const PRECISION = 256n;
const ONE = 1n << PRECISION;

// atanh(1/n) in fixed point: the sum of 1 / ((2k + 1) · n^(2k + 1)).
function atanhInverse(n: bigint): bigint {
  let sum = 0n;
  let power = ONE / n;
  const square = n * n;
  for (let k = 1n; power !== 0n; k += 2n) {
    sum += power / k;
    power /= square;
  }
  return sum;
}

const LN2 = 2n * atanhInverse(3n);

// The double nearest value / 2^PRECISION, a tie to even.
function nearestDouble(value: bigint): number {
  if (value === 0n) return 0;
  const negative = value < 0n;
  let magnitude = negative ? -value : value;
  let shift = BigInt(magnitude.toString(2).length) - 53n;
  if (shift > 0n) {
    const rest = magnitude & ((1n << shift) - 1n);
    const half = 1n << (shift - 1n);
    magnitude >>= shift;
    if (rest > half || (rest === half && (magnitude & 1n) === 1n)) magnitude += 1n;
  } else {
    shift = 0n;
  }
  const exponent = Number(shift - PRECISION);
  // Two steps, so neither power of two leaves the range a double holds exactly.
  const result = Number(magnitude) * 2 ** Math.trunc(exponent / 2) * 2 ** (exponent - Math.trunc(exponent / 2));
  return negative ? -result : result;
}

// A double in fixed point, exactly (every double the formulas meet is far above PRECISION's floor).
function fixed(x: number): bigint {
  const { mantissa, exponent } = exactParts(x);
  const shift = BigInt(exponent) + PRECISION;
  const value = shift >= 0n ? mantissa << shift : mantissa >> -shift;
  return x < 0 ? -value : value;
}

export function exactExp(x: number): number {
  if (x === 0) return 1;
  const value = fixed(x);
  // x = k · ln 2 + r with |r| at most ln 2 / 2, then exp(r) by its series.
  let k = value / LN2;
  let r = value - k * LN2;
  if (r > LN2 / 2n) {
    k += 1n;
    r -= LN2;
  } else if (r < -LN2 / 2n) {
    k -= 1n;
    r += LN2;
  }
  let sum = ONE;
  let term = ONE;
  for (let n = 1n; term !== 0n; n += 1n) {
    term = (term * r) / (ONE * n);
    sum += term;
  }
  return nearestDouble(k >= 0n ? sum << k : sum >> -k);
}

export function exactLog(x: number): number {
  if (!(x > 0) || !Number.isFinite(x)) throw new RangeError('log needs a positive finite number');
  if (x === 1) return 0;
  const { mantissa, exponent } = exactParts(x);
  // x = f · 2^k with f from about 0.71 to 1.41 (from 1 to 2, halved past the square root of 2), then
  // log f = 2 · atanh((f - 1) / (f + 1)).
  const bits = BigInt(mantissa.toString(2).length);
  let k = BigInt(exponent) + bits - 1n;
  let f = (mantissa << PRECISION) >> (bits - 1n);
  if (f * f > 2n * ONE * ONE) {
    f >>= 1n;
    k += 1n;
  }
  const s = ((f - ONE) * ONE) / (f + ONE);
  const square = (s * s) / ONE;
  let sum = 0n;
  let power = s;
  for (let n = 1n; power !== 0n; n += 2n) {
    sum += power / n;
    power = (power * square) / ONE;
  }
  return nearestDouble(k * LN2 + 2n * sum);
}

function saturationVaporPressureHpa(tempC: number): number {
  return 6.1121 * exactExp((17.67 * tempC) / (tempC + 243.5));
}

/** GPP, dew point, its depression, vapor pressure and enthalpy for one dry-bulb/RH pair. */
export function psychrometrics(tempF: number, relativeHumidity: number): AirValues {
  // Clamped as the source did; the request schema already refuses anything outside 1 to 100.
  const rh = Math.min(100, Math.max(1, relativeHumidity));
  const tempC = ((tempF - 32) * 5) / 9;
  const vaporHpa = (saturationVaporPressureHpa(tempC) * rh) / 100;
  const humidityRatio = (0.62198 * vaporHpa) / Math.max(1, STANDARD_PRESSURE_HPA - vaporHpa);
  const alpha = exactLog(Math.max(0.001, vaporHpa / 6.1121));
  const dewPointC = (243.5 * alpha) / (17.67 - alpha);
  const dewPointF = roundHalfEven((dewPointC * 9) / 5 + 32);
  return {
    gpp: roundHalfEven(humidityRatio * GRAINS_PER_POUND),
    dewPointF,
    dewPointDepressionF: Math.max(0, roundHalfEven(tempF - dewPointF)),
    vaporPressureInhg: roundHalfEven(vaporHpa * HPA_TO_INHG, 3),
    enthalpyBtuLb: roundHalfEven(0.24 * tempF + humidityRatio * (1061 + 0.444 * tempF), 1),
  };
}
