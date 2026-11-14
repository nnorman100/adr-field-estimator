// The 1,000-line single-file limit (scripts/check-file-length.mts). Ports tests/test_file_length.py
// and tests/test_file_length_ratchet.py, which no longer run in CI, and is stricter in three places:
// JavaScript is counted here too (not only by ESLint), a listed file back under the limit or gone is
// an error rather than a notice, and the exception list can only shrink from the one recorded below.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ALLOWLIST,
  BASELINES,
  check,
  countLines,
  ROOT,
  type Allowlist,
  type Baselines,
} from '../scripts/check-file-length.mts';

// The exceptions as recorded on 2026-11-10, when the check moved to TypeScript. The list may only
// lose files and lower counts from here: S8 removes the legacy files, and nothing is ever added.
const RECORDED: Baselines = {
  'backend/main.py': 2834,
  'backend/price_book_store.py': 1973,
  'backend/workspaces.py': 2101,
  'public/app.css': 3302,
  'public/app.js': 6597,
  'public/prices.js': 2159,
  'public/scope-items.js': 1055,
  'public/workspaces.js': 2268,
};

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tree(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'file-length-'));
  roots.push(root);
  return root;
}

function write(root: string, name: string, lines: number, line = 'x = 1\n'): void {
  const file = path.join(root, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, line.repeat(lines));
}

const run = (root: string, baselines: Baselines = {}) =>
  check({ root, limit: 1000, baselines, allowlist: null });

describe('new files', () => {
  it('fails a new Python file over the limit', () => {
    const root = tree();
    write(root, 'backend/new_module.py', 1001);
    const { errors, warnings } = run(root);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('backend/new_module.py');
    expect(warnings).toEqual([]);
  });

  it('passes a file at exactly the limit', () => {
    const root = tree();
    write(root, 'backend/at_limit.py', 1000);
    expect(run(root)).toEqual({ errors: [], warnings: [] });
  });

  it.each([
    'public/new.css',
    'docs/new.md',
    'public/new.js',
    'scripts/new.mjs',
    'scripts/new.cjs',
    'infra/dryscope/scripts/new.js',
    'tests/test_new.py',
    'tests/test_new.ts',
    'scripts/new.mts',
    'infra/dryscope/app/main.tf',
    'infra/dryscope/app/tests/app.tftest.hcl',
    'infra/dryscope/test.tfvars',
    'web/migrations/0009_new.sql',
    'web/scripts/new.sh',
    '.github/workflows/new.yml',
    '.github/dependabot.yaml',
    'public/new.html',
    'web/firestore.rules',
    'pyproject.toml',
    'web/Dockerfile',
  ])('applies the limit to %s', (name) => {
    const root = tree();
    write(root, name, 1000);
    expect(run(root).errors).toEqual([]);
    write(root, name, 1001);
    expect(run(root).errors).toHaveLength(1);
  });

  it('fails over-limit TypeScript files under web/', () => {
    const root = tree();
    const names = ['web/src/big.ts', 'web/src/big.tsx', 'web/next.config.mts', 'web/src/big.cts'];
    for (const name of names) write(root, name, 1001);
    const { errors } = run(root);
    expect(errors).toHaveLength(names.length);
    for (const name of names) expect(errors.some((m) => m.includes(name))).toBe(true);
  });

  it("fails web/'s over-limit JavaScript and config files", () => {
    const root = tree();
    for (const name of ['web/eslint.config.mjs', 'web/tsconfig.json', 'web/env.example']) {
      write(root, name, 1001);
    }
    expect(run(root).errors).toHaveLength(3);
  });

  it('passes web/ files at the limit', () => {
    const root = tree();
    write(root, 'web/src/at_limit.ts', 1000);
    expect(run(root)).toEqual({ errors: [], warnings: [] });
  });

  it('does not count lockfiles, vendored, generated or data files', () => {
    const root = tree();
    for (const name of [
      'web/package-lock.json',
      'web/synthetic/package-lock.json',
      'web/node_modules/pkg/index.ts',
      'web/.next/server/app.js',
      'package-lock.json',
      'node_modules/pkg/file.css',
      'public/vendor/lib/big.py',
      'public/vendor/library.md',
      'infra/dryscope/app/.terraform.lock.hcl',
      'docs/data.json',
      'tests/fixtures/terraform/app-test.plan.json',
      'backend/requirements.txt',
    ]) {
      write(root, name, 5000);
    }
    expect(run(root)).toEqual({ errors: [], warnings: [] });
  });
});

describe('listed files', () => {
  it.each(['public/old.css', 'docs/old.md', 'public/old.js', 'old.py'])(
    'warns for %s at its count and fails it one line over',
    (name) => {
      const root = tree();
      write(root, name, 1100);
      const { errors, warnings } = run(root, { [name]: 1100 });
      expect(errors).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('1100 lines');
      write(root, name, 1101);
      const grown = run(root, { [name]: 1100 }).errors;
      expect(grown).toHaveLength(1);
      expect(grown[0]).toContain('1100-line baseline');
    },
  );

  it.each(['public/old.css', 'docs/old.md', 'public/old.js', 'old.py'])(
    'requires a lower count once %s shrinks, then holds it there',
    (name) => {
      const root = tree();
      write(root, name, 1050);
      const shrunk = run(root, { [name]: 1100 }).errors;
      expect(shrunk).toHaveLength(1);
      expect(shrunk[0]).toContain('from 1100 to 1050');
      expect(run(root, { [name]: 1050 }).errors).toEqual([]);
      write(root, name, 1100);
      const regrown = run(root, { [name]: 1050 }).errors;
      expect(regrown).toHaveLength(1);
      expect(regrown[0]).toContain('1050-line baseline');
    },
  );

  it('fails a listed file that is back under the limit or gone', () => {
    const root = tree();
    write(root, 'backend/old_module.py', 900);
    write(root, 'public/old.js', 1000);
    const { errors, warnings } = run(root, {
      'backend/old_module.py': 1500,
      'public/old.js': 1500,
      'backend/gone.py': 1500,
    });
    expect(warnings).toEqual([]);
    expect(errors.some((m) => m.includes('backend/old_module.py') && m.includes('900'))).toBe(true);
    expect(errors.some((m) => m.startsWith('public/old.js is down to 1000'))).toBe(true);
    expect(errors.some((m) => m.includes('backend/gone.py') && m.includes('not a counted'))).toBe(
      true,
    );
  });

  it('refuses a count at or under the limit, or not a whole number', () => {
    const root = tree();
    write(root, 'old.py', 1001);
    expect(run(root, { 'old.py': 1000 }).errors.some((m) => m.includes('whole number'))).toBe(true);
    expect(run(root, { 'old.py': 1001.5 }).errors.some((m) => m.includes('whole number'))).toBe(
      true,
    );
  });

  it('requires the legacy allowlist to name exactly the listed files', () => {
    const root = tree();
    write(root, 'old.py', 1100);
    const baselines = { 'old.py': 1100 };
    const ok = { limit: 1000, files: ['old.py'] };
    expect(check({ root, limit: 1000, baselines, allowlist: ok }).errors).toEqual([]);
    for (const allowlist of [
      { limit: 1000, files: [] },
      { limit: 1000, files: ['old.py', 'other.py'] },
      { limit: 1200, files: ['old.py'] },
    ]) {
      expect(check({ root, limit: 1000, baselines, allowlist }).errors).toHaveLength(1);
    }
  });
});

describe('line counting', () => {
  it('counts like ESLint max-lines', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a\n')).toBe(1);
    expect(countLines('a')).toBe(1);
    expect(countLines('a\n\nb\n')).toBe(3);
    expect(countLines('a\r\nb\r\n')).toBe(2);
    expect(countLines('a\rb')).toBe(2);
    expect(countLines('a\u2028b\u2029c')).toBe(3);
  });

  it('counts blank lines and comments', () => {
    const root = tree();
    write(root, 'src/blank.ts', 1001, '\n');
    write(root, 'src/comments.js', 1001, '// note\n');
    expect(run(root).errors).toHaveLength(2);
  });
});

describe('the repository', () => {
  const baselines = JSON.parse(readFileSync(path.join(ROOT, BASELINES), 'utf8')) as Baselines;
  const allowlist = JSON.parse(readFileSync(path.join(ROOT, ALLOWLIST), 'utf8')) as Allowlist;

  it('is clean today', () => {
    expect(check().errors).toEqual([]);
  });

  it('only ever loses exceptions or lowers their counts', () => {
    for (const [name, ceiling] of Object.entries(baselines)) {
      expect(Object.keys(RECORDED), `${name} was not over the limit on 2026-11-10`).toContain(name);
      expect(ceiling, name).toBeLessThanOrEqual(RECORDED[name]);
    }
  });

  it('keeps the legacy allowlist sorted, unique and at 1,000 lines', () => {
    expect(allowlist.limit).toBe(1000);
    expect(allowlist.files).toEqual([...new Set(allowlist.files)].sort());
  });

  it('runs the TypeScript check in npm run lint, which the node CI job runs', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts.lint.split(' && ')).toContain('node scripts/check-file-length.mts');
  });
});
