import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SCREENS } from '../e2e/screens';

// Every page must have an axe accessibility check. This finds every page.tsx under src/app, so a
// new screen with no entry in tests/e2e/screens.ts fails here (and so in CI) without anyone
// remembering a list; the same way route-rules.test.ts catches a route with no access rule.

const APP_DIR = fileURLToPath(new URL('../../src/app', import.meta.url));
const E2E_DIR = fileURLToPath(new URL('../e2e', import.meta.url));
const PAGE_FILE = /^page\.(tsx|ts|jsx|js|mjs)$/;
const AXE_CHECK = /expectAccessible\(|expectNoAxeViolations\(|new AxeBuilder\(/;

async function pageFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await pageFiles(path)));
    else if (PAGE_FILE.test(entry.name)) found.push(path);
  }
  return found;
}

// The address a page answers: its folder path without route groups, "/" for the start page.
function patternOf(file: string): string {
  const folders = relative(APP_DIR, file)
    .split(sep)
    .slice(0, -1)
    .filter((part) => !/^\(.*\)$/.test(part));
  return `/${folders.join('/')}`;
}

describe('every page has an axe check', () => {
  it('finds the pages', async () => {
    expect((await pageFiles(APP_DIR)).length).toBeGreaterThan(0);
  });

  it('lists every page.tsx in tests/e2e/screens.ts', async () => {
    const patterns = (await pageFiles(APP_DIR)).map(patternOf).sort();
    expect(Object.keys(SCREENS).sort()).toEqual(patterns);
  });

  it.each(Object.entries(SCREENS))(
    '%s is checked by %s, which runs axe',
    async (_pattern, spec) => {
      const source = await readFile(join(E2E_DIR, spec), 'utf8');
      expect(source).toMatch(AXE_CHECK);
    },
  );
});
