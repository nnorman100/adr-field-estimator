// docs/DESIGN.md colours must match the :root custom properties in web/src/app/globals.css
// (scripts/check-design-tokens.mts). The stylesheet is the source of truth.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CSS, DESIGN, ROOT, TOKENS, check } from '../scripts/check-design-tokens.mts';

// Controlled fixtures: every mapped token with its own value, so no case depends on the live values.
const value = (name: string) => `oklch(0.${name.length} 0 0)`;
const names = Object.keys(TOKENS);
const designOf = (skip?: string, override: Record<string, string> = {}) =>
  `---\ncolors:\n${names
    .filter((name) => name !== skip)
    .map((name) => `  ${name}: "${override[name] ?? value(name)}"`)
    .join('\n')}\n  brand-navy: "#0B2545"\n---\n# Guide\n`;
const cssOf = (skip?: string, override: Record<string, string> = {}, extra = '') =>
  `:root {\n${names
    .filter((name) => name !== skip)
    .map((name) => `  ${TOKENS[name]}: ${override[name] ?? value(name)};`)
    .join('\n')}\n${extra}}\n`;

describe('design tokens', () => {
  it('passes on the current files', () => {
    const design = readFileSync(path.join(ROOT, DESIGN), 'utf8');
    const css = readFileSync(path.join(ROOT, CSS), 'utf8');
    expect(check(design, css)).toEqual([]);
  });

  it('passes on matching fixtures, ignoring spacing, comments, extra colours and unrelated properties', () => {
    expect(check(designOf(), cssOf())).toEqual([]);
    expect(check(designOf(), cssOf(undefined, { ring: 'oklch(0.4   0  0)' }))).toEqual([]);
    expect(
      check(
        designOf(),
        `/* :root { --old: red; } */\n${cssOf(undefined, {}, '  --header-height: 48px;\n')}`,
      ),
    ).toEqual([]);
  });

  it('names the token, both values and the file to update on a value mismatch', () => {
    const [problem, ...rest] = check(designOf(), cssOf(undefined, { ring: 'oklch(0.9 0 0)' }));
    expect(rest).toEqual([]);
    expect(problem).toContain('colors.ring');
    expect(problem).toContain(value('ring'));
    expect(problem).toContain('oklch(0.9 0 0)');
    expect(problem).toContain(`update ${DESIGN}`);
  });

  it('fails on a mapped token present in only one file', () => {
    expect(check(designOf(), cssOf('ring'))).toEqual([
      expect.stringContaining('no longer sets --ring'),
    ]);
    expect(check(designOf('ring'), cssOf())).toEqual([
      expect.stringContaining('colors.ring is missing'),
    ]);
  });
});
