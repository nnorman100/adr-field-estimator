// Tests for the Test guard (scripts/test-guard.mjs). Each case builds a throwaway git repository
// with the real .github/test-guard.json on a base commit, makes one change on top, and runs the
// guard exactly as the workflow does (`node test-guard.mjs <base>`). Weakening changes must fail
// without the owner's label; added-only and ordinary changes must pass without it.
//
// Marker words such as `.skip` are assembled from pieces so that editing this file never looks
// like a newly skipped test to the guard itself.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
// @ts-expect-error -- plain JavaScript module without type declarations
import { checkWorkflow, parseYaml } from '../scripts/test-guard.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const GUARD = path.join(ROOT, 'scripts', 'test-guard.mjs');
const CONFIG = readFileSync(path.join(ROOT, '.github', 'test-guard.json'), 'utf8');
const WORKFLOWS = path.join(ROOT, '.github', 'workflows');
const TIMEOUT = 30_000;

const SKIP = ['.', 'skip'].join('');
const PY_SKIP = ['@pytest', 'mark', 'skip'].join('.');
const PY_XFAIL = ['@pytest', 'mark', 'xfail'].join('.');
const LABEL = ['test', 'change', 'approved'].join('-');

const CI = `name: CI

on:
  push:
    branches: [master]
  pull_request:
    branches: [master]

permissions:
  contents: read

jobs:
  node:
    runs-on: \${{ vars.CI_RUNNER || 'dryscope-linux' }}
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@aaaaaaaa # v7.0.1
      - run: npm ci
      - name: Lint
        run: npm run lint
      - name: Unit tests
        run: |
          npx vitest run
          node --test tests/test_x.js
  audit:
    runs-on: \${{ vars.CI_RUNNER || 'dryscope-linux' }}
    steps:
      - run: python -m pip install pip-audit==2.10.1
      - run: npm audit --audit-level=high
  matrix:
    runs-on: \${{ vars.CI_RUNNER || 'dryscope-linux' }}
    strategy:
      matrix:
        browser: [chromium, webkit]
    steps:
      - run: npx playwright test --project \${{ matrix.browser }}
  check:
    name: Web app checks
    needs: [node, audit]
    if: always() && !cancelled()
    runs-on: \${{ vars.CI_RUNNER || 'dryscope-linux' }}
    steps:
      - run: echo done
`;

const PY_TEST = `def test_adds():
    assert 1 + 1 == 2


def test_subtracts():
    assert 2 - 1 == 1
    assert 3 - 1 == 2
`;

const JS_TEST = `import { expect, it } from 'vitest';

it('adds', () => {
  expect(1 + 1).toBe(2);
});

it('subtracts', () => {
  expect(2 - 1).toBe(1);
});
`;

const TF_TEST = `run "plans_one_bucket" {
  command = plan

  assert {
    condition     = length(google_storage_bucket.b) == 1
    error_message = "one bucket"
  }
}

run "keeps_versions" {
  command = plan

  assert {
    condition     = google_storage_bucket.b[0].versioning[0].enabled
    error_message = "versioning on"
  }
}
`;

const WEB_PACKAGE = `${JSON.stringify(
  {
    name: 'web',
    scripts: {
      build: 'next build',
      test: 'vitest run',
      'test:db': 'vitest run --config vitest.db.config.ts',
      'test:e2e': 'playwright test',
    },
    devDependencies: { vitest: '4.0.0' },
  },
  null,
  2,
)}\n`;

const ROOT_PACKAGE = `${JSON.stringify(
  { scripts: { test: 'node --test tests/test_a.js && vitest run' } },
  null,
  2,
)}\n`;

const BASE_FILES: Record<string, string> = {
  '.github/test-guard.json': CONFIG,
  '.github/workflows/ci.yml': CI,
  '.github/workflows/test-guard.yml': 'name: Test guard\non: pull_request\njobs: {}\n',
  '.github/CODEOWNERS': '/tests/ @owner\n',
  '.github/dependabot.yml': 'version: 2\n',
  '.github/workflows/deploy.yml':
    'on:\n  workflow_run:\n    workflows: [CI]\n  workflow_dispatch:\npermissions:\n  contents: read\njobs:\n  deploy:\n    runs-on: x\n    steps:\n      - run: ./deploy.sh\n      - run: ./smoke.sh\n',
  'scripts/test-guard.mjs': '// guard\n',
  'scripts/verify_live.py': 'THRESHOLD = 0.9\n',
  'playwright.config.js': 'module.exports = { retries: 0 };\n',
  'firestore.rules': 'allow read: if false;\n',
  'tests/test_math.py': PY_TEST,
  'tests/test_math.test.ts': JS_TEST,
  'tests/test_slow.py': `def test_fast():\n    assert True\n\n\n${PY_SKIP}\ndef test_slow():\n    assert False\n`,
  'tests/fixtures/answer.json': '{"total": "100.00"}\n',
  'tests/golden/proposal.txt': 'Total: 100.00\n',
  'package.json': ROOT_PACKAGE,
  'web/package.json': WEB_PACKAGE,
  'web/vitest.config.ts': "export default { test: { include: ['tests/unit/**'] } };\n",
  'web/vitest.db.config.ts': "export default { test: { include: ['tests/db/**'] } };\n",
  'web/playwright.config.ts': 'export default { retries: 0 };\n',
  'web/tests/unit/x.test.ts': JS_TEST,
  'web/tests/e2e/jobs.spec.ts': JS_TEST,
  'web/tests/ai-evals/stored/summary.jsonl': '{"id":"job-1","summary":"Kitchen dried."}\n',
  'web/tests/ai-evals/data/summary-jobs.jsonl': '{"id":"job-1","rooms":["Kitchen"]}\n',
  'infra/dryscope/app/tests/app.tftest.hcl': TF_TEST,
  'infra/dryscope/app/guards/guards.tftest.hcl': TF_TEST,
  'docs/README.md': '# Docs\n',
  'src/app.js': 'export const x = 1;\n',
};

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function write(dir: string, file: string, text: string) {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
}

type Change = (repo: Repo) => void;
interface Repo {
  read(file: string): string;
  write(file: string, text: string): void;
  edit(file: string, from: string, to: string): void;
  remove(file: string): void;
  move(from: string, to: string): void;
}

function runGuard(change: Change, opts: { labels?: string[]; noConfig?: boolean } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'test-guard-'));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'master');
  git(dir, 'config', 'user.email', 'guard@example.invalid');
  git(dir, 'config', 'user.name', 'Guard test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  for (const [file, text] of Object.entries(BASE_FILES)) {
    if (opts.noConfig && file === '.github/test-guard.json') continue;
    write(dir, file, text);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  const base = git(dir, 'rev-parse', 'HEAD').trim();

  change({
    read: (file) => readFileSync(path.join(dir, file), 'utf8'),
    write: (file, text) => write(dir, file, text),
    edit: (file, from, to) => {
      const text = readFileSync(path.join(dir, file), 'utf8');
      if (!text.includes(from)) throw new Error(`${file} has no ${JSON.stringify(from)}`);
      writeFileSync(path.join(dir, file), text.replace(from, to));
    },
    remove: (file) => rmSync(path.join(dir, file)),
    move: (from, to) => {
      mkdirSync(path.dirname(path.join(dir, to)), { recursive: true });
      git(dir, 'mv', from, to);
    },
  });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'head');

  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GITHUB_EVENT_PATH;
  if (opts.labels) {
    const event = path.join(dir, '..', `${path.basename(dir)}-event.json`);
    writeFileSync(
      event,
      JSON.stringify({ pull_request: { labels: opts.labels.map((name) => ({ name })) } }),
    );
    dirs.push(event);
    env.GITHUB_EVENT_PATH = event;
  }
  const r = spawnSync('node', [GUARD, base], { cwd: dir, env, encoding: 'utf8' });
  // Remove the repository now rather than all of them in afterAll, whose one hook timeout a slow
  // host can exceed once there are many cases (afterAll still cleans up after a failed run).
  rmSync(dir, { recursive: true, force: true });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const ci =
  (from: string, to: string): Change =>
  (r) =>
    r.edit('.github/workflows/ci.yml', from, to);

// Each weakening change, and a phrase the guard's message must contain.
const NEEDS_LABEL: [string, Change, string][] = [
  ['deleting a test file', (r) => r.remove('tests/test_math.py'), 'Test file deleted'],
  [
    'moving a test file out of the test folders',
    (r) => r.move('tests/test_math.py', 'old/test_math.py'),
    'moved out of the test folders',
  ],
  [
    'removing a Python test',
    (r) => r.edit('tests/test_math.py', 'def test_adds():\n    assert 1 + 1 == 2\n', ''),
    'Fewer tests than before: 1 test definitions removed, 0 added (def test_adds)',
  ],
  [
    'removing a JavaScript test',
    (r) =>
      r.edit('tests/test_math.test.ts', "it('adds', () => {\n  expect(1 + 1).toBe(2);\n});\n", ''),
    'Fewer tests than before: 1 test definitions removed, 0 added (test adds)',
  ],
  [
    'commenting out a test',
    (r) => r.edit('tests/test_math.py', 'def test_adds():', '# def test_adds():'),
    'def test_adds',
  ],
  [
    'skipping a JavaScript test',
    (r) => r.edit('tests/test_math.test.ts', "it('adds'", `it${SKIP}('adds'`),
    'marker added',
  ],
  [
    'skipping a Python test',
    (r) => r.edit('tests/test_math.py', 'def test_adds', `${PY_SKIP}\ndef test_adds`),
    'marker added',
  ],
  [
    'marking a Python test as an expected failure',
    (r) => r.edit('tests/test_math.py', 'def test_subtracts', `${PY_XFAIL}\ndef test_subtracts`),
    'marker added',
  ],
  [
    'adding a skipped test in a new file',
    (r) => r.write('tests/test_new.test.ts', `it${SKIP}('later', () => {});\n`),
    'marker added',
  ],
  [
    'removing an assertion',
    (r) => r.edit('tests/test_math.py', '    assert 3 - 1 == 2\n', ''),
    'Fewer assertions than before',
  ],
  [
    'changing a stored answer',
    (r) => r.edit('tests/fixtures/answer.json', '100.00', '90.00'),
    'Stored answer changed (M): tests/fixtures/answer.json',
  ],
  [
    'deleting a stored answer',
    (r) => r.remove('tests/fixtures/answer.json'),
    'Stored answer changed (D)',
  ],
  [
    'adding a workflow-level defaults shell',
    ci(
      'permissions:\n  contents: read\n',
      'permissions:\n  contents: read\n\ndefaults:\n  run:\n    shell: bash -c "exit 0" {0}\n',
    ),
    'workflow has a new or changed `defaults.run.shell`',
  ],
  [
    'adding a workflow-level defaults working directory',
    ci(
      'permissions:\n  contents: read\n',
      'permissions:\n  contents: read\n\ndefaults:\n  run:\n    working-directory: docs\n',
    ),
    'workflow has a new or changed `defaults.run.working-directory`',
  ],
  [
    'adding a job-level defaults shell',
    ci(
      '    timeout-minutes: 20\n',
      '    timeout-minutes: 20\n    defaults:\n      run:\n        shell: bash -c "exit 0" {0}\n',
    ),
    'job node has a new or changed `defaults.run.shell`',
  ],
  [
    'adding a ref to a checkout step',
    ci(
      'actions/checkout@aaaaaaaa # v7.0.1\n',
      'actions/checkout@aaaaaaaa # v7.0.1\n        with:\n          ref: ${{ github.event.pull_request.base.sha }}\n',
    ),
    'job node checkout step has a new or changed `with.ref`',
  ],
  [
    'adding a second checkout step to a job',
    ci(
      '      - run: npm ci\n',
      '      - uses: actions/checkout@aaaaaaaa # v7.0.1\n      - run: npm ci\n',
    ),
    'job node has a new checkout step',
  ],
  [
    'hiding a test removal behind a -diff attribute',
    (r) => {
      r.write('.gitattributes', 'tests/** -diff\n');
      r.write('tests/test_math.py', 'x = 1\n');
    },
    'Fewer tests than before',
  ],
  [
    'hiding a test skip behind a binary attribute in the tests folder',
    (r) => {
      r.write('tests/.gitattributes', '*.ts binary\n');
      r.edit('tests/test_math.test.ts', "it('adds'", `it${SKIP}('adds'`);
    },
    'Skip or only marker added',
  ],
  [
    'adding a skip on a line that starts with ++',
    (r) => r.edit('tests/test_math.test.ts', "it('adds', () => {", `++it${SKIP}('adds', () => {`),
    'Skip or only marker added',
  ],
  [
    'hiding a new secret in a workflow behind a -diff attribute',
    (r) => {
      r.write('.gitattributes', '.github/** -diff\n');
      r.edit('.github/workflows/ci.yml', 'run: npm run lint', 'run: echo ${{ secrets.TOKEN }}');
    },
    'uses a new secret',
  ],
  [
    'adding a .gitattributes file',
    (r) => r.write('.gitattributes', '*.png binary\n'),
    'Protected file changed (A): .gitattributes',
  ],
  [
    'changing a golden file',
    (r) => r.edit('tests/golden/proposal.txt', '100.00', '90.00'),
    'Stored answer changed (M): tests/golden/proposal.txt',
  ],
  [
    'changing a scoring threshold',
    (r) => r.edit('scripts/verify_live.py', '0.9', '0.5'),
    'Protected file changed',
  ],
  [
    'changing the Playwright config',
    (r) => r.edit('playwright.config.js', '0', '3'),
    'Protected file changed',
  ],
  ['changing firestore.rules', (r) => r.edit('firestore.rules', 'false', 'true'), 'Protected'],
  ['changing CODEOWNERS', (r) => r.edit('.github/CODEOWNERS', '@owner', '@someone'), 'Protected'],
  [
    'changing the guard script',
    (r) => r.edit('scripts/test-guard.mjs', 'guard', 'off'),
    'Test guard file changed',
  ],
  [
    'changing the guard config',
    (r) => r.edit('.github/test-guard.json', '"tests/**"', '"nothing/**"'),
    'Test guard file changed',
  ],
  [
    'changing the guard workflow',
    (r) => r.edit('.github/workflows/test-guard.yml', 'pull_request', 'push'),
    'Test guard file changed',
  ],
  ['deleting a workflow', (r) => r.remove('.github/workflows/ci.yml'), 'Workflow deleted'],
  [
    'removing a job',
    ci(
      "  audit:\n    runs-on: ${{ vars.CI_RUNNER || 'dryscope-linux' }}\n    steps:\n      - run: python -m pip install pip-audit==2.10.1\n      - run: npm audit --audit-level=high\n",
      '',
    ),
    'job removed: audit',
  ],
  [
    'removing a step',
    ci('      - name: Lint\n        run: npm run lint\n', ''),
    'job node step removed: Lint',
  ],
  ['renaming a job', ci('name: Web app checks', 'name: Web checks'), 'job check renamed'],
  [
    'turning a job off with if',
    ci('    timeout-minutes: 20\n', '    timeout-minutes: 20\n    if: false\n'),
    'job node has a new or changed `if:`',
  ],
  [
    'changing an existing condition',
    ci('if: always() && !cancelled()', "if: github.event_name == 'never'"),
    'job check has a new or changed `if:`',
  ],
  [
    'letting a step fail quietly',
    ci(
      '        run: npm run lint\n',
      '        run: npm run lint\n        continue-on-error: true\n',
    ),
    '`continue-on-error`',
  ],
  [
    'swallowing a failing command',
    ci('npx vitest run', 'npx vitest run || true'),
    'ignores failures',
  ],
  [
    'echoing over a failure',
    ci('npx vitest run', 'npx vitest run || echo failed'),
    'ignores failures',
  ],
  [
    'changing a step shell',
    ci('        run: npm run lint\n', '        run: npm run lint\n        shell: bash {0}\n'),
    '`shell:`',
  ],
  ['removing a trigger', ci('  pull_request:\n    branches: [master]\n', ''), 'trigger removed'],
  [
    'narrowing a trigger with paths-ignore',
    ci(
      '  pull_request:\n    branches: [master]\n',
      "  pull_request:\n    branches: [master]\n    paths-ignore: ['tests/**']\n",
    ),
    'trigger pull_request changed',
  ],
  [
    'narrowing a trigger by dropping a branch',
    ci('  push:\n    branches: [master]', '  push:\n    branches: [release]'),
    'trigger push changed',
  ],
  ['dropping a needed job', ci('needs: [node, audit]', 'needs: [node]'), 'no longer needs audit'],
  [
    'removing a matrix entry',
    ci('browser: [chromium, webkit]', 'browser: [chromium]'),
    'matrix entry removed',
  ],
  [
    'excluding matrix entries',
    ci(
      'browser: [chromium, webkit]',
      'browser: [chromium, webkit]\n        exclude:\n          - browser: webkit',
    ),
    'matrix excludes more',
  ],
  [
    'granting a workflow write access to pull requests',
    ci('permissions:\n  contents: read', 'permissions:\n  contents: read\n  pull-requests: write'),
    'could approve its own pull request',
  ],
  [
    'granting a job write access to commit statuses',
    ci(
      '    timeout-minutes: 20\n',
      '    timeout-minutes: 20\n    permissions:\n      statuses: write\n',
    ),
    'could approve its own pull request',
  ],
  [
    'dropping the permissions key',
    ci('permissions:\n  contents: read\n', ''),
    'no `permissions:` key',
  ],
  [
    'adding a workflow without permissions',
    (r) =>
      r.write(
        '.github/workflows/extra.yml',
        'on: pull_request\njobs:\n  extra:\n    runs-on: x\n    steps:\n      - run: echo hi\n',
      ),
    'no `permissions:` key',
  ],
  [
    'adding a job that reuses a required check name',
    (r) =>
      r.write(
        '.github/workflows/extra.yml',
        'on: pull_request\npermissions:\n  contents: read\njobs:\n  node:\n    runs-on: x\n    steps:\n      - run: echo ok\n',
      ),
    'reuses the existing check name "node"',
  ],
  [
    'using a new secret',
    ci(
      '      - run: npm ci\n',
      '      - run: npm ci\n        env:\n          TOKEN: ${{ secrets.OWNER_PAT }}\n',
    ),
    'uses a new secret',
  ],
  [
    'naming the approval label in a workflow',
    ci(
      '      - run: npm ci\n',
      `      - run: npm ci\n      - run: gh pr edit --add-label ${LABEL}\n`,
    ),
    'names the approval label',
  ],
  [
    'writing a workflow the guard cannot read',
    ci('permissions:\n  contents: read', 'permissions: &p\n  contents: read'),
    "could not read the workflow's structure",
  ],
  // The rebuilt app's tests (web/), runner configs and test scripts, and Terraform tests.
  [
    'deleting a web unit test file',
    (r) => r.remove('web/tests/unit/x.test.ts'),
    'Test file deleted',
  ],
  [
    'moving a web test file out of the test folders',
    (r) => r.move('web/tests/e2e/jobs.spec.ts', 'web/old/jobs.spec.ts'),
    'moved out of the test folders',
  ],
  [
    'removing a test from a web browser spec',
    (r) =>
      r.edit(
        'web/tests/e2e/jobs.spec.ts',
        "it('adds', () => {\n  expect(1 + 1).toBe(2);\n});\n",
        '',
      ),
    'Fewer tests than before: 1 test definitions removed, 0 added (test adds)',
  ],
  [
    'skipping a web test',
    (r) => r.edit('web/tests/unit/x.test.ts', "it('adds'", `it${SKIP}('adds'`),
    'Skip or only marker added',
  ],
  [
    'removing an assertion from a web test',
    (r) => r.edit('web/tests/unit/x.test.ts', '  expect(1 + 1).toBe(2);\n', ''),
    'Fewer assertions than before',
  ],
  [
    'changing the web Vitest config',
    (r) => r.edit('web/vitest.config.ts', 'tests/unit/**', 'tests/unit/a*'),
    'Protected file changed (M): web/vitest.config.ts',
  ],
  [
    'changing the web database Vitest config',
    (r) => r.edit('web/vitest.db.config.ts', 'tests/db/**', 'tests/db/a*'),
    'Protected file changed (M): web/vitest.db.config.ts',
  ],
  [
    'changing the web Playwright config',
    (r) => r.edit('web/playwright.config.ts', 'retries: 0', 'retries: 3'),
    'Protected file changed (M): web/playwright.config.ts',
  ],
  [
    'changing a stored AI eval answer',
    (r) => r.edit('web/tests/ai-evals/stored/summary.jsonl', 'Kitchen dried.', 'Done.'),
    'Stored answer changed (M): web/tests/ai-evals/stored/summary.jsonl',
  ],
  [
    'changing an AI eval dataset',
    (r) => r.edit('web/tests/ai-evals/data/summary-jobs.jsonl', '"Kitchen"', '"Hall"'),
    'Stored answer changed (M): web/tests/ai-evals/data/summary-jobs.jsonl',
  ],
  [
    'removing a Terraform test run',
    (r) => r.edit('infra/dryscope/app/tests/app.tftest.hcl', TF_TEST, TF_TEST.split('\n\nrun ')[0]),
    'Fewer tests than before: 1 test definitions removed, 0 added (run keeps_versions)',
  ],
  [
    'removing a Terraform assertion',
    (r) =>
      r.edit(
        'infra/dryscope/app/tests/app.tftest.hcl',
        '  assert {\n    condition     = length(google_storage_bucket.b) == 1\n    error_message = "one bucket"\n  }\n',
        '',
      ),
    'Fewer assertions than before',
  ],
  [
    'deleting a Terraform guard test file',
    (r) => r.remove('infra/dryscope/app/guards/guards.tftest.hcl'),
    'Test file deleted: infra/dryscope/app/guards/guards.tftest.hcl',
  ],
  [
    'removing a web test script',
    (r) => r.edit('web/package.json', ',\n    "test:e2e": "playwright test"', ''),
    'web/package.json: test script removed: test:e2e',
  ],
  [
    'pointing a web test script at another config',
    (r) => r.edit('web/package.json', 'vitest.db.config.ts', 'vitest.config.ts'),
    'test script test:db no longer has: vitest.db.config.ts',
  ],
  [
    'dropping a file from the root test script',
    (r) => r.edit('package.json', 'node --test tests/test_a.js && ', ''),
    'package.json: test script test no longer has: node --test tests/test_a.js &&',
  ],
  [
    'letting a web test script pass with no tests',
    (r) =>
      r.edit('web/package.json', '"test": "vitest run"', '"test": "vitest run --passWithNoTests"'),
    'test script test now ignores failures',
  ],
  [
    'deleting web/package.json',
    (r) => r.remove('web/package.json'),
    'File with test scripts removed or moved (D): web/package.json',
  ],
];

// Changes that add tests or make ordinary edits: these pass without the label.
const PASSES: [string, Change][] = [
  [
    'adding a Python test file',
    (r) => r.write('tests/test_new.py', 'def test_new():\n    assert True\n'),
  ],
  [
    'adding a JavaScript test file',
    (r) => r.write('tests/test_new.test.ts', "it('works', () => {\n  expect(1).toBe(1);\n});\n"),
  ],
  [
    'adding a test to an existing file',
    (r) =>
      r.write(
        'tests/test_math.py',
        `${PY_TEST}\n\ndef test_multiplies():\n    assert 2 * 2 == 4\n`,
      ),
  ],
  ['adding a stored answer', (r) => r.write('tests/fixtures/new-case.json', '{"total": "5.00"}\n')],
  ['adding a golden file', (r) => r.write('tests/golden/new.txt', 'Total: 5.00\n')],
  [
    'renaming or replacing a test',
    (r) => r.edit('tests/test_math.py', 'def test_adds():', 'def test_adds_two_numbers():'),
  ],
  ['changing Dependabot settings', (r) => r.edit('.github/dependabot.yml', '2', '2\nupdates: []')],
  ['editing a fixture folder README', (r) => r.write('tests/fixtures/README.md', '# Notes\n')],
  [
    'making a job run even when others fail',
    ci('    timeout-minutes: 20\n', '    timeout-minutes: 20\n    if: ${{ always() }}\n'),
  ],
  [
    'removing a step from a deploy workflow that never runs on pull requests',
    (r) => r.edit('.github/workflows/deploy.yml', '      - run: ./smoke.sh\n', ''),
  ],
  [
    'adding a deploy job whose name another workflow uses',
    (r) =>
      r.edit(
        '.github/workflows/deploy.yml',
        'jobs:\n',
        'jobs:\n  node:\n    runs-on: x\n    steps:\n      - run: echo hi\n',
      ),
  ],
  ['changing docs only', (r) => r.edit('docs/README.md', '# Docs', '# Docs\n\nMore words.')],
  ['changing app code only', (r) => r.edit('src/app.js', '1', '2')],
  [
    'moving a test, with its skip marker, into another test file',
    (r) => {
      r.edit('tests/test_slow.py', `\n\n${PY_SKIP}\ndef test_slow():\n    assert False\n`, '');
      r.write('tests/test_split.py', `${PY_SKIP}\ndef test_slow():\n    assert False\n`);
    },
  ],
  [
    'splitting tests between files',
    (r) => {
      r.edit('tests/test_math.py', 'def test_adds():\n    assert 1 + 1 == 2\n', '');
      r.write('tests/test_adds.py', 'def test_adds():\n    assert 1 + 1 == 2\n');
    },
  ],
  [
    'renaming a test file inside the test folders',
    (r) => r.move('tests/test_math.py', 'tests/math/test_math.py'),
  ],
  [
    'changing a test parameter list',
    (r) => r.edit('tests/test_math.py', 'def test_adds():', 'def test_adds(tmp_path):'),
  ],
  ['raising a job timeout', ci('timeout-minutes: 20', 'timeout-minutes: 45')],
  [
    'adding a fetch-depth to a checkout step',
    ci(
      'actions/checkout@aaaaaaaa # v7.0.1\n',
      'actions/checkout@aaaaaaaa # v7.0.1\n        with:\n          fetch-depth: 2\n',
    ),
  ],
  [
    'changing a runner',
    ci(
      "runs-on: ${{ vars.CI_RUNNER || 'dryscope-linux' }}\n    timeout",
      'runs-on: ubuntu-latest\n    timeout',
    ),
  ],
  [
    'bumping an action pin',
    ci('actions/checkout@aaaaaaaa # v7.0.1', 'actions/checkout@bbbbbbbb # v7.1.0'),
  ],
  ['bumping a pinned tool version', ci('pip-audit==2.10.1', 'pip-audit==2.11.0')],
  [
    'adding a step',
    ci('      - run: npm ci\n', '      - run: npm ci\n      - run: npm run format:check\n'),
  ],
  [
    'adding a step that only runs on failure',
    ci(
      '          node --test tests/test_x.js\n',
      '          node --test tests/test_x.js\n      - if: failure()\n        run: cat log.txt\n',
    ),
  ],
  ['editing the commands of a step', ci('npx vitest run', 'npx vitest run --reporter=verbose')],
  [
    'adding a test command to a step',
    ci(
      'node --test tests/test_x.js',
      'node --test tests/test_x.js\n          node --test tests/test_y.js',
    ),
  ],
  [
    'adding a job',
    ci(
      '  check:\n',
      '  lint-docs:\n    runs-on: x\n    steps:\n      - run: npm run docs\n  check:\n',
    ),
  ],
  [
    'adding a matrix entry',
    ci('browser: [chromium, webkit]', 'browser: [chromium, webkit, firefox]'),
  ],
  ['adding a needed job', ci('needs: [node, audit]', 'needs: [node, audit, matrix]')],
  ['adding a trigger', ci('  pull_request:\n', '  workflow_dispatch:\n  pull_request:\n')],
  [
    'widening a trigger to another branch',
    ci('  push:\n    branches: [master]', '  push:\n    branches: [master, release]'),
  ],
  ['removing a condition', ci('    if: always() && !cancelled()\n', '')],
  ['editing comments and env', ci('jobs:\n', '# The checks.\nenv:\n  CI: true\njobs:\n')],
  [
    'adding a workflow with read-only permissions',
    (r) =>
      r.write(
        '.github/workflows/extra.yml',
        'on: pull_request\npermissions:\n  contents: read\njobs:\n  extra:\n    runs-on: x\n    steps:\n      - run: echo hi\n',
      ),
  ],
  [
    'renaming a workflow file',
    (r) => r.move('.github/workflows/ci.yml', '.github/workflows/checks.yml'),
  ],
  [
    'adding a web test file',
    (r) =>
      r.write('web/tests/unit/new.test.ts', "it('works', () => {\n  expect(1).toBe(1);\n});\n"),
  ],
  [
    'adding a test to a web browser spec',
    (r) =>
      r.write(
        'web/tests/e2e/jobs.spec.ts',
        `${JS_TEST}\nit('multiplies', () => {\n  expect(2 * 2).toBe(4);\n});\n`,
      ),
  ],
  [
    'changing a web test helper',
    (r) => r.write('web/tests/e2e/server.ts', 'export const port = 1;\n'),
  ],
  [
    'adding a stored AI eval answer file',
    (r) => r.write('web/tests/ai-evals/stored/new.jsonl', '{"id":"job-2"}\n'),
  ],
  [
    'adding a Terraform test run',
    (r) =>
      r.write(
        'infra/dryscope/app/tests/app.tftest.hcl',
        `${TF_TEST}\nrun "names_the_bucket" {\n  command = plan\n\n  assert {\n    condition     = true\n    error_message = "named"\n  }\n}\n`,
      ),
  ],
  [
    'adding a web test script',
    (r) =>
      r.edit(
        'web/package.json',
        '"test:e2e": "playwright test"',
        '"test:e2e": "playwright test",\n    "test:emu": "tsx tests/emu/run.ts"',
      ),
  ],
  [
    'adding a file to the root test script',
    (r) =>
      r.edit(
        'package.json',
        'tests/test_a.js &&',
        'tests/test_a.js && node --test tests/test_b.js &&',
      ),
  ],
  [
    'adding a flag to a web test script',
    (r) =>
      r.edit('web/package.json', '"test": "vitest run"', '"test": "vitest run --reporter=verbose"'),
  ],
  ['bumping a web dependency', (r) => r.edit('web/package.json', '4.0.0', '4.1.0')],
  [
    'changing a web script that is not a test script',
    (r) => r.edit('web/package.json', 'next build', 'next build --debug'),
  ],
];

describe('Test guard', () => {
  it.each(NEEDS_LABEL)(
    'asks for the label when %s',
    (_name, change, message) => {
      const { code, out } = runGuard(change);
      expect(out).toContain(message);
      expect(out).toContain(`add the "${LABEL}" label`);
      expect(code).toBe(1);
    },
    TIMEOUT,
  );

  it.each(PASSES)(
    'passes without the label when %s',
    (_name, change) => {
      const { code, out } = runGuard(change);
      expect(out).toContain('no test, evaluation or check weakening found');
      expect(code).toBe(0);
    },
    TIMEOUT,
  );

  it(
    'passes a weakening change once the owner adds the label',
    () => {
      const { code, out } = runGuard((r) => r.remove('tests/test_math.py'), { labels: [LABEL] });
      expect(out).toContain('Test file deleted');
      expect(out).toContain('Approved by the');
      expect(code).toBe(0);
    },
    TIMEOUT,
  );

  it(
    'ignores other labels',
    () => {
      const { code } = runGuard((r) => r.remove('tests/test_math.py'), { labels: ['ready'] });
      expect(code).toBe(1);
    },
    TIMEOUT,
  );

  it(
    'passes the pull request that installs the guard',
    () => {
      const { code, out } = runGuard((r) => r.remove('tests/test_math.py'), { noConfig: true });
      expect(out).toContain('installing it');
      expect(code).toBe(0);
    },
    TIMEOUT,
  );

  it('fails with usage help when no base commit is given', () => {
    const r = spawnSync('node', [GUARD], { cwd: ROOT, encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('pass the base commit');
  });
});

// The guard runs with plain node and no packages, so it reads YAML itself. It must agree with a
// real YAML parser on every workflow in the repository, and refuse what it does not understand.
const repoWorkflows = readdirSync(WORKFLOWS).filter((n) => /\.ya?ml$/.test(n));
const asStrings = (v: unknown): unknown =>
  JSON.parse(
    JSON.stringify(v, (_k, x) => (typeof x === 'number' || typeof x === 'boolean' ? String(x) : x)),
  );

describe('Test guard YAML reader', () => {
  it.each(repoWorkflows)('reads %s the same as the yaml package', (name) => {
    const text = readFileSync(path.join(WORKFLOWS, name), 'utf8');
    expect(asStrings(parseYaml(text))).toEqual(asStrings(YAML.parse(text)));
  });

  it.each(repoWorkflows)('finds nothing to flag when %s is unchanged', (name) => {
    const text = readFileSync(path.join(WORKFLOWS, name), 'utf8');
    expect(checkWorkflow(name, text, text, [])).toEqual([]);
  });

  it('reads the test workflow the same as the yaml package', () => {
    expect(asStrings(parseYaml(CI))).toEqual(asStrings(YAML.parse(CI)));
  });

  it.each([
    ['an anchor', 'a: &x 1\nb: *x\n'],
    ['a merge key', 'a:\n  <<: *x\n'],
    ['a flow mapping', 'a: {b: 1}\n'],
    ['a nested flow list', 'a: [[1]]\n'],
    ['tabs', 'a:\n\tb: 1\n'],
    ['two documents', 'a: 1\n---\nb: 2\n'],
    ['a duplicate key', 'a: 1\na: 2\n'],
    ['stray indentation', 'a: 1\n    b: 2\n'],
  ])('refuses %s', (_name, text) => {
    expect(() => parseYaml(text)).toThrow();
  });
});
