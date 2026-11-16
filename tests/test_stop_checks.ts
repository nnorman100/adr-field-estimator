// The Claude Code Stop hook (scripts/stop-checks.mjs) runs only the checks the changed files need.
import { expect, test } from 'vitest';
import { MAX_BLOCKS, planChecks } from '../scripts/stop-checks.mjs';

const names = (files: string[]) => planChecks(files, 'BASE').map((c) => c.name);

test('nothing to check when only docs or settings changed', () => {
  expect(names(['docs/runbook/ci.md', '.claude/settings.json', 'README.md'])).toEqual([]);
});

test('web code gets the type check, ESLint on the changed files and related unit tests', () => {
  const checks = planChecks(['web/src/lib/access/can.ts', 'web/README.md'], 'BASE');
  expect(checks.map((c) => c.name)).toEqual([
    'Type check (web)',
    'ESLint (web)',
    'Vitest (web unit)',
  ]);
  expect(checks.every((c) => c.cwd === 'web')).toBe(true);
  expect(checks[1].args).toEqual(['eslint', '--no-warn-ignored', 'src/lib/access/can.ts']);
  expect(checks[2].args).toEqual(['vitest', 'run', '--changed', 'BASE', '--passWithNoTests']);
});

test('root files get Prettier, root ESLint (JavaScript only) and related root tests', () => {
  const checks = planChecks(['scripts/check_required_docs.js', 'tests/test_x.ts'], 'BASE');
  expect(checks.map((c) => c.name)).toEqual(['Prettier', 'ESLint (root)', 'Vitest (root)']);
  expect(checks[0].args).toEqual([
    'prettier',
    '--check',
    'scripts/check_required_docs.js',
    'tests/test_x.ts',
  ]);
  expect(checks[1].args).toEqual(['eslint', '--no-warn-ignored', 'scripts/check_required_docs.js']);
});

test('web files never go through the root Prettier or ESLint', () => {
  const checks = planChecks(['web/src/app/page.tsx'], 'BASE');
  expect(checks.some((c) => c.cwd === '.')).toBe(false);
});

test('a stuck agent is released after a bounded number of attempts', () => {
  expect(MAX_BLOCKS).toBeGreaterThan(0);
  expect(MAX_BLOCKS).toBeLessThanOrEqual(5);
});
