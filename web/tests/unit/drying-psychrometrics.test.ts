import { describe, expect, it } from 'vitest';
import { exactExp, exactLog, psychrometrics, roundHalfEven } from '@/lib/drying/psychrometrics';

// S5b-10 slice 10B: the server's air values for a drying-log air reading, the port of the old app's
// backend/psychrometrics.py. Each row is [°F, % RH, GPP, dew point °F, depression °F, vapor pressure
// inHg, enthalpy BTU/lb] as that helper printed it (python3, backend.psychrometrics.psychrometrics):
// the plan's checks (70 °F / 50% and 74 °F / 72%), the public limits, ties (a dew point of exactly
// 72.5 and 24.5 rounds to the even neighbour, as Python's round does) and spread-out pairs.
const PYTHON: [number, number, number, number, number, number, number][] = [
  [70, 50, 54, 51, 19, 0.37, 25.3],
  [74, 72, 91, 64, 10, 0.609, 31.9],
  [-40, 1, 0, -91, 51, 0.0, -9.6],
  [150, 100, 1498, 150, 0, 7.66, 277.3],
  [-40, 100, 1, -40, 0, 0.006, -9.5],
  [150, 1, 11, 12, 138, 0.077, 37.8],
  [72.5, 100, 120, 72, 0, 0.805, 36.2],
  [24.5, 100, 19, 24, 0, 0.133, 8.8],
  [32, 50, 13, 15, 17, 0.09, 9.7],
  [0, 1, 0, -79, 79, 0.0, 0.0],
  [85, 35, 63, 54, 31, 0.425, 30.2],
  [95, 20, 49, 48, 47, 0.333, 30.5],
  [60, 90, 69, 57, 3, 0.469, 25.2],
  [68.4, 44.6, 46, 46, 22, 0.312, 23.6],
  [101.3, 63.7, 195, 87, 14, 1.283, 55.1],
  [-12.25, 57.5, 2, -23, 11, 0.014, -2.6],
  [45.75, 99.75, 45, 46, 0, 0.308, 18.0],
  [55, 100, 64, 55, 0, 0.436, 23.2],
  [90, 100, 217, 90, 0, 1.423, 55.8],
  [120, 45, 239, 93, 27, 1.559, 66.9],
  [68.57, 43.46, 45, 45, 24, 0.306, 23.5],
  [69.84, 21.4, 23, 29, 41, 0.157, 20.4],
  [114.53, 82.54, 388, 108, 7, 2.45, 89.2],
  [84.16, 16.86, 29, 34, 50, 0.199, 24.8],
  [58.93, 33.45, 25, 30, 29, 0.168, 18.0],
  [7.5, 95.33, 9, 6, 2, 0.06, 3.1],
  [149.35, 5.41, 60, 53, 96, 0.408, 45.5],
  [123.43, 60.72, 365, 106, 17, 2.314, 87.8],
  [32.51, 29.08, 8, 4, 29, 0.054, 9.0],
  [88.24, 46.23, 92, 65, 23, 0.622, 35.7],
  [90.31, 66.52, 144, 78, 12, 0.956, 44.3],
  [-14.73, 77.02, 2, -20, 5, 0.017, -3.2],
  [146.66, 96.97, 1288, 145, 2, 6.829, 242.3],
  [76.53, 5.38, 7, 2, 75, 0.05, 19.5],
  [-39.23, 14.26, 0, -70, 31, 0.001, -9.4],
  [138.79, 30.98, 276, 97, 42, 1.782, 77.5],
  [29.57, 89.92, 22, 27, 3, 0.147, 10.4],
  [19.73, 55.35, 9, 6, 14, 0.06, 6.1],
  [42.85, 7.43, 3, -16, 59, 0.021, 10.7],
  [71.06, 84.56, 96, 66, 5, 0.648, 32.1],
];

describe('air values', () => {
  it.each(PYTHON)('%s °F at %s%% RH gives what the Python helper gave', (tempF, rh, gpp, dewPointF, dewPointDepressionF, vaporPressureInhg, enthalpyBtuLb) => {
    expect(psychrometrics(tempF, rh)).toEqual({ gpp, dewPointF, dewPointDepressionF, vaporPressureInhg, enthalpyBtuLb });
  });

  it('clamps the humidity it works with to 1 to 100%, as the source did', () => {
    expect(psychrometrics(70, 0)).toEqual(psychrometrics(70, 1));
    expect(psychrometrics(70, 140)).toEqual(psychrometrics(70, 100));
  });

  it('never gives a negative dew-point depression', () => {
    for (const temp of [-40, 0, 24.5, 72.5, 150]) expect(psychrometrics(temp, 100).dewPointDepressionF).toBe(0);
  });
});

describe('rounding as Python rounds', () => {
  it('sends a tie to the even neighbour', () => {
    expect([0.5, 1.5, 2.5, -0.5, -1.5, -2.5].map((x) => roundHalfEven(x))).toEqual([0, 2, 2, 0, -2, -2]);
    expect(roundHalfEven(25.25, 1)).toBe(25.2);
  });

  it('decides on the exact binary value, not the decimal it prints as', () => {
    // 2.675 is stored a hair under 2.675, 0.0015 a hair over 0.0015, and 25.35 a hair over 25.35.
    expect(roundHalfEven(2.675, 2)).toBe(2.67);
    expect(roundHalfEven(0.0015, 3)).toBe(0.002);
    expect(roundHalfEven(0.0005, 3)).toBe(0.001);
    expect(roundHalfEven(25.35, 1)).toBe(25.4);
    expect(roundHalfEven(1e-320, 3)).toBe(0);
  });
});

describe('exp and log', () => {
  it('round to the nearest double where the engine may be one unit off', () => {
    // exp(x) here is 0.73519070694784843..., nearer 0.7351907069478484 than the next double up,
    // which V8's Math.exp gives; this is what moved the 24.5 °F dew point across its tie.
    const x = (17.67 * ((((24.5 - 32) * 5) / 9) as number)) / (((24.5 - 32) * 5) / 9 + 243.5);
    expect(exactExp(x)).toBe(0.7351907069478484);
    expect(exactExp(0)).toBe(1);
    expect(exactExp(1)).toBe(Math.E);
    expect(exactLog(1)).toBe(0);
    expect(exactLog(Math.E)).toBe(1);
    expect(exactLog(2)).toBe(Math.LN2);
    expect(exactLog(0.5)).toBe(-Math.LN2);
    expect(() => exactLog(0)).toThrow(RangeError);
  });
});
