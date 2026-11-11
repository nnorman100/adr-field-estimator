// Repo-wide workflow rules, run by vitest in the required node CI job. Ported from
// tests/test_ci_config.py (workflows exist, every job on the switchable self-hosted runner with no
// Docker services or containers, CodeQL sets up node before init) and the workflow-wiring tests in
// tests/test_ci_legacy_scope.py (no legacy CI jobs, the node job keeps the rebuild's checks on every
// pull request, only CodeQL's Python leg is scoped). Also checks that these ported guards stay in
// the vitest run the node job executes.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateStep, load, ROOT, WORKFLOWS, type Data } from './workflow_support.ts';

// The Actions budget stop blocks GitHub-hosted jobs, so every job defaults to the self-hosted pool
// and the repository variable CI_RUNNER (for example ubuntu-latest) switches it back. See
// docs/runbook/ci.md, "CI runners".
const RUNNER = "${{ vars.CI_RUNNER || 'dryscope-linux' }}";
const WORKFLOW_FILES = readdirSync(WORKFLOWS)
  .filter((name) => /\.y[^/]*ml$/.test(name))
  .sort();
const SCOPE_RUN = 'bash scripts/ci_legacy_scope.sh';

const workflow = (name: string): Data => load(path.join(WORKFLOWS, name));
const ci = () => workflow('ci.yml');
const lintScript = (): string =>
  JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts.lint;

describe('every workflow', () => {
  it('includes the expected workflows', () => {
    for (const name of [
      'ci.yml',
      'codeql.yml',
      'deploy.yml',
      'test-guard.yml',
      'web.yml',
      'web-release.yml',
    ]) {
      expect(WORKFLOW_FILES).toContain(name);
    }
  });

  it.each(WORKFLOW_FILES)('%s runs every job on the switchable runner, without Docker', (name) => {
    const jobs = Object.entries(workflow(name).jobs as Record<string, Data>);
    expect(jobs.length).toBeGreaterThan(0);
    for (const [job, config] of jobs) {
      expect(config['runs-on'], `${name} job ${job}`).toBe(RUNNER);
      // The self-hosted job container has no Docker daemon for service or job containers.
      expect(config, `${name} job ${job}`).not.toHaveProperty('services');
      expect(config, `${name} job ${job}`).not.toHaveProperty('container');
    }
  });
});

describe('ci.yml', () => {
  it.each(['python', 'browser', 'firestore-emulator'])('has no legacy %s job', (job) => {
    // The legacy suites are removed, not faked: the owner drops these names from the ruleset.
    expect(Object.keys(ci().jobs)).not.toContain(job);
  });

  it('keeps node and audit, and nothing in CI, Test guard or Web app is scoped', () => {
    expect(Object.keys(ci().jobs).sort()).toEqual(['audit', 'node']);
    for (const name of ['ci.yml', 'test-guard.yml', 'web.yml']) {
      expect(scopeGatedParts(workflow(name)), `${name} must not use the scope step`).toEqual([]);
    }
    const audit = ci().jobs.audit;
    expect(audit).not.toHaveProperty('if');
    for (const s of audit.steps) expect(s).not.toHaveProperty('if');
  });

  it("keeps the node job's rebuild checks on every pull request", () => {
    const job = ci().jobs.node;
    expect(job).not.toHaveProperty('if');
    for (const s of job.steps) expect(s).not.toHaveProperty('if');
    const runs = job.steps.map((s: Data) => s.run ?? '');
    for (const command of ['npm ci', 'npm run format:check', 'npm run lint', 'npx vitest run']) {
      expect(runs).toContain(command);
    }
    expect(runs, 'the legacy unit tests in npm test are retired from CI').not.toContain('npm test');
    // `pull_request:` with no branch or path filter: CI runs on every pull request.
    expect(ci().on).toHaveProperty('pull_request', null);
  });

  it('lints with the file-length and required-docs checks', () => {
    const lint = lintScript().split(' && ');
    expect(lint).toContain('node scripts/check-file-length.mts');
    expect(lint).toContain('node scripts/check_required_docs.js');
  });

  it("runs these TypeScript guards in the node job's vitest run", async () => {
    const config = (await import('../vitest.config.mjs')).default;
    const include: string[] = config.test.include;
    for (const file of [
      'tests/test_ci_workflows.ts',
      'tests/test_web_release_workflow.ts',
      'tests/test_web_images.ts',
      'tests/test_file_length_limit.ts',
      'tests/test_required_docs.js',
    ]) {
      expect(include).toContain(file);
    }
  });
});

describe('codeql.yml', () => {
  const analyze = () => workflow('codeql.yml').jobs.analyze;

  it('sets up node before init', () => {
    // CodeQL's JavaScript/TypeScript extractor needs node; the self-hosted container has none.
    const uses: string[] = analyze().steps.map((s: Data) => s.uses ?? '');
    const node = uses.findIndex((use) => use.startsWith('actions/setup-node@'));
    const init = uses.findIndex((use) => use.startsWith('github/codeql-action/init@'));
    expect(node).toBeGreaterThanOrEqual(0);
    expect(init).toBeGreaterThanOrEqual(0);
    expect(node).toBeLessThan(init);
  });

  it('still runs weekly and on pushes to master', () => {
    const triggers = workflow('codeql.yml').on;
    expect(triggers.schedule).toEqual([{ cron: '23 9 * * 1' }]);
    expect(triggers.push.branches).toEqual(['master']);
  });

  describe.each(['python', 'javascript-typescript'])('the %s leg', (language) => {
    it.each([{ run: 'true' }, { run: 'false' }, {}])(
      'reports on every pull request, scoped only for Python (scope %j)',
      (scopeOutputs: Record<string, string>) => {
        const job = analyze();
        expect(
          job,
          'both Analyze checks are required and must report on every PR',
        ).not.toHaveProperty('if');
        expect(job.strategy.matrix.language).toEqual(['javascript-typescript', 'python']);
        const all: Data[] = job.steps;
        expect(all[0].uses.startsWith('actions/checkout@')).toBe(true);
        // A plain 0 (full history) for both legs: an expression such as `&& 0 || 1` would evaluate
        // to 1 because 0 is falsy, giving a shallow clone that lacks the base commit.
        expect(all[0].with['fetch-depth']).toBe(0);
        checkScopeStep(all[1], 'CodeQL Python analysis');
        expect(all[1].if).toBe("matrix.language == 'python'");
        for (const s of all.slice(2)) {
          const label = s.name ?? s.uses;
          expect(s, label).toHaveProperty('if');
          const condition = String(s.if).replaceAll('matrix.language', `'${language}'`);
          const runs = evaluateStep(condition, scopeOutputs, false);
          if (language === 'javascript-typescript') {
            expect(runs, `${label} must always run for JavaScript/TypeScript`).toBe(true);
          } else {
            expect(runs, label).toBe(scopeOutputs.run === 'true');
          }
        }
        const uses: string[] = all.map((s) => s.uses ?? '');
        expect(uses.some((u) => u.startsWith('github/codeql-action/init@'))).toBe(true);
        expect(uses.some((u) => u.startsWith('github/codeql-action/analyze@'))).toBe(true);
      },
    );
  });
});

describe('the step-condition evaluator', () => {
  // Guards for the evaluator the CodeQL check relies on, so a broken port cannot pass vacuously.
  it.each([
    ["matrix.language != 'python' || steps.scope.outputs.run == 'true'", { run: 'true' }, true],
    ["'python' != 'python' || steps.scope.outputs.run == 'true'", { run: 'false' }, false],
    ["'python' != 'python' || steps.scope.outputs.run == 'true'", {}, false],
    ["steps.scope.outputs.run == 'TRUE'", { run: 'true' }, true],
    ["always() && ('a' == 'b' || steps.scope.outputs.run == 'true')", { run: 'true' }, true],
    ['${{ !(steps.scope.outputs.run) }}', {}, true],
  ])('%s with %j is %s', (condition, outputs: Record<string, string>, expected) => {
    expect(evaluateStep(condition, outputs, false)).toBe(expected);
  });

  it('implies success() and honours status functions', () => {
    expect(evaluateStep("'a' == 'a'", {}, true)).toBe(false);
    expect(evaluateStep("always() && 'a' == 'a'", {}, true)).toBe(true);
    expect(evaluateStep('failure()', {}, true)).toBe(true);
    expect(() => evaluateStep('hashFiles()', {}, false)).toThrow();
  });
});

function checkScopeStep(s: Data, suite?: string): void {
  expect(s.id).toBe('scope');
  expect(s.run).toBe(SCOPE_RUN);
  expect(s.env.EVENT_NAME).toBe('${{ github.event_name }}');
  const base: string = s.env.BASE_SHA;
  expect(base).toContain('github.event.pull_request.base.sha');
  expect(base).toContain('github.event.before');
  if (suite) expect(s.env.SUITE).toBe(suite);
}

/** Jobs and steps that run the scope script or gate on its output. */
function scopeGatedParts(config: Data): string[] {
  const gated: string[] = [];
  for (const [name, job] of Object.entries(config.jobs as Record<string, Data>)) {
    if (String(job.if ?? '').includes('steps.scope.')) gated.push(name);
    for (const s of job.steps ?? []) {
      const label = `${name}: ${s.name ?? s.uses ?? s.run}`;
      const runsScript = String(s.run ?? '')
        .split(/\s+/)
        .includes('scripts/ci_legacy_scope.sh');
      if (s.id === 'scope' || runsScript || String(s.if ?? '').includes('steps.scope.')) {
        gated.push(label);
      }
    }
  }
  return gated;
}
