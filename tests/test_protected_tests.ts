// The lint chain (`node scripts/check_required_docs.js`) fails when a test file sits outside
// the protected_paths in .no-mistakes.yaml. Each case copies the real lint scripts and config
// into a throwaway git repository and runs the lint step exactly as `npm run lint` does.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const { REQUIRED_DOCS } = require('../scripts/check_required_docs.js');

const ROOT = path.resolve(import.meta.dirname, '..');
const TIMEOUT = 30_000;
const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function makeRepo(files: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), 'protected-tests-'));
  roots.push(root);
  mkdirSync(path.join(root, 'scripts'));
  for (const name of ['check_required_docs.js', 'check-protected-tests.mjs']) {
    copyFileSync(path.join(ROOT, 'scripts', name), path.join(root, 'scripts', name));
  }
  copyFileSync(path.join(ROOT, '.no-mistakes.yaml'), path.join(root, '.no-mistakes.yaml'));
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'));
  for (const name of REQUIRED_DOCS) files[name] ??= '# Present\n';
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), text);
  }
  execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}

function lint(root: string) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'check_required_docs.js')], {
    cwd: root,
    encoding: 'utf8',
  });
}

test(
  'lint passes when every test file is under a protected path',
  () => {
    const result = lint(
      makeRepo({
        'web/tests/unit/a.test.ts': '',
        'infra/dryscope/app/guards/guards.tftest.hcl': '',
        'infra/dryscope/data/tests/data.tftest.hcl': '',
      }),
    );
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  },
  TIMEOUT,
);

test.each(['web/src/lib/new.test.ts', 'web/e2e/flow.spec.ts', 'infra/dryscope/new/x.tftest.hcl'])(
  'lint fails for %s outside the protected paths',
  (file) => {
    const result = lint(makeRepo({ [file]: '' }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`test file outside protected_paths: ${file}`);
  },
  TIMEOUT,
);

test(
  'the real repository has no test file outside the protected paths',
  () => {
    const result = spawnSync(
      process.execPath,
      [path.join(ROOT, 'scripts', 'check-protected-tests.mjs')],
      {
        encoding: 'utf8',
      },
    );
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  },
  TIMEOUT,
);
