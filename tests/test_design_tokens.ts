// docs/DESIGN.md colours must match the :root custom properties in web/src/app/globals.css
// (scripts/check-design-tokens.mts). The stylesheet is the source of truth.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CSS,
  DESIGN,
  ROOT,
  TOKENS,
  check,
  designColors,
  rootProperties,
} from '../scripts/check-design-tokens.mts';

const design = readFileSync(path.join(ROOT, DESIGN), 'utf8');
const css = readFileSync(path.join(ROOT, CSS), 'utf8');

describe('design tokens', () => {
  it('passes on the current files and reads every mapped token from both', () => {
    expect(check(design, css)).toEqual([]);
    for (const [name, property] of Object.entries(TOKENS)) {
      expect(designColors(design)[name], name).toBeDefined();
      expect(rootProperties(css)[property], property).toBeDefined();
    }
  });

  it('names the token, both values and the file to update on a value mismatch', () => {
    const drifted = css.replace('--ring: oklch(0.708 0 0)', '--ring: oklch(0.6 0 0)');
    expect(drifted).not.toBe(css);
    const [problem, ...rest] = check(design, drifted);
    expect(rest).toEqual([]);
    expect(problem).toContain('colors.ring');
    expect(problem).toContain('oklch(0.708 0 0)');
    expect(problem).toContain('oklch(0.6 0 0)');
    expect(problem).toContain(`update ${DESIGN}`);
  });

  it('fails on a stylesheet token that DESIGN.md lacks', () => {
    const added = css.replace('--ring:', '--surface: oklch(0.9 0 0);\n  --ring:');
    expect(check(design, added)).toEqual([expect.stringContaining('--surface: oklch(0.9 0 0)')]);
  });

  it('fails on a DESIGN.md colour that the stylesheet lacks', () => {
    const removed = css.replace(/\s*--ring: [^;]+;/, '');
    expect(removed).not.toBe(css);
    expect(check(design, removed)).toEqual([expect.stringContaining('no longer sets --ring')]);
    const undocumented = design.replace(/\n {2}ring: "[^"]+"/, '');
    expect(undocumented).not.toBe(design);
    expect(check(undocumented, css)).toEqual([expect.stringContaining('colors.ring is missing')]);
  });

  it('ignores whitespace and commented-out stylesheet values', () => {
    const spaced = css.replace('oklch(0.708 0 0)', 'oklch(0.708   0  0)');
    expect(check(design, spaced)).toEqual([]);
    expect(check(design, `${css}\n/* :root { --old: red; } */`)).toEqual([]);
  });
});
