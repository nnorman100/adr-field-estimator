// Keeps docs/DESIGN.md from drifting from the app's stylesheet. The stylesheet
// (web/src/app/globals.css) is the source of truth: DESIGN.md's front-matter colours are a copy of
// its `:root` custom properties. Run by `npm run lint`; tests/test_design_tokens.ts covers it.
//
// Only the colours have a stylesheet counterpart today. Typography, rounded and spacing tokens come
// from Tailwind's own classes and defaults, not from custom properties in globals.css, so there is
// nothing to compare them with; they and the brand colours (navy, the logo tints, error, lines) are
// DESIGN.md-only on purpose. A `:root` property not listed in TOKENS is not checked.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DESIGN = 'docs/DESIGN.md';
export const CSS = 'web/src/app/globals.css';

// DESIGN.md colour name -> CSS custom property in `:root`.
export const TOKENS: Record<string, string> = {
  background: '--background',
  foreground: '--foreground',
  primary: '--primary',
  'on-primary': '--primary-foreground',
  accent: '--accent',
  'on-accent': '--accent-foreground',
  input: '--input',
  ring: '--ring',
};

const normalise = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();

export function designColors(design: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(design);
  if (!match) throw new Error(`${DESIGN} has no YAML front matter.`);
  const colors = (parse(match[1]) as { colors?: Record<string, unknown> })?.colors ?? {};
  return Object.fromEntries(Object.entries(colors).map(([name, value]) => [name, String(value)]));
}

export function rootProperties(css: string): Record<string, string> {
  const properties: Record<string, string> = {};
  const uncommented = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const block of uncommented.matchAll(/:root\s*\{([^}]*)\}/g)) {
    for (const [, name, value] of block[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      properties[name] = value;
    }
  }
  return properties;
}

export function check(design: string, css: string): string[] {
  const colors = designColors(design);
  const properties = rootProperties(css);
  const problems: string[] = [];
  for (const [name, property] of Object.entries(TOKENS)) {
    const docValue = colors[name];
    const cssValue = properties[property];
    if (docValue === undefined && cssValue === undefined) {
      problems.push(
        `${name} (${property}) is in neither file; remove it from TOKENS in scripts/check-design-tokens.mts.`,
      );
    } else if (docValue === undefined) {
      problems.push(
        `colors.${name} is missing from ${DESIGN}, but ${CSS} sets ${property}: ${cssValue}. Update ${DESIGN}.`,
      );
    } else if (cssValue === undefined) {
      problems.push(
        `colors.${name} is ${docValue} in ${DESIGN}, but ${CSS} no longer sets ${property}. Update ${DESIGN}.`,
      );
    } else if (normalise(docValue) !== normalise(cssValue)) {
      problems.push(
        `colors.${name} is ${docValue} in ${DESIGN} but ${property} is ${cssValue} in ${CSS}. The stylesheet is the source of truth: update ${DESIGN}.`,
      );
    }
  }
  return problems;
}

function main(): number {
  const problems = check(
    readFileSync(path.join(ROOT, DESIGN), 'utf8'),
    readFileSync(path.join(ROOT, CSS), 'utf8'),
  );
  for (const message of problems) console.error(`::error title=Design tokens::${message}`);
  console.log(
    `design tokens: ${problems.length} problem(s) in ${Object.keys(TOKENS).length} tokens`,
  );
  return problems.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exit(main());
