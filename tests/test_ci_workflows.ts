// Repo-wide workflow rules, run by vitest in the required node CI job. Ported from
// tests/test_ci_config.py (workflows exist, every job on the switchable self-hosted runner with no
// Docker services or containers) and the workflow-wiring tests in
// tests/test_ci_legacy_scope.py (no legacy CI jobs, the node job keeps the rebuild's checks on every
// pull request). Also checks that these ported guards stay in
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

const workflow = (name: string): Data => load(path.join(WORKFLOWS, name));
const ci = () => workflow('ci.yml');
const lintScript = (): string =>
  JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts.lint;

describe('every workflow', () => {
  it('includes the expected workflows', () => {
    for (const name of [
      'ai-evals.yml',
      'ci.yml',
      'deploy.yml',
      'test-guard.yml',
      'web.yml',
      'web-release.yml',
    ]) {
      expect(WORKFLOW_FILES).toContain(name);
    }
  });

  it('has no CodeQL workflow, because code scanning default setup replaces it', () => {
    expect(WORKFLOW_FILES).not.toContain('codeql.yml');
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

// GitHub's default job limit is 360 minutes; on a pool of three runner places one hung job would
// hold a third of CI for six hours.
describe('job time limits', () => {
  it.each([
    ['ci.yml', 'node'],
    ['ci.yml', 'audit'],
    ['test-guard.yml', 'test-guard'],
  ])('%s job %s has a time limit', (name, job) => {
    // A whole number of minutes below GitHub's 360-minute default.
    const limit = workflow(name).jobs[job]['timeout-minutes'];
    expect(Number.isInteger(limit)).toBe(true);
    expect(limit).toBeGreaterThan(0);
    expect(limit).toBeLessThan(360);
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
    expect(audit.steps.map((s: Data) => s.run).filter(Boolean)).toEqual([
      'node scripts/audit-check.mjs',
    ]);
    expect(
      audit.steps.some((s: Data) => String(s.uses ?? '').startsWith('actions/setup-python@')),
    ).toBe(false);
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
      'tests/test_web_workflow.ts',
      'tests/test_ai_evals_workflow.ts',
      'tests/test_file_length_limit.ts',
      'tests/test_required_docs.js',
    ]) {
      expect(include).toContain(file);
    }
  });
});

describe('the step-condition evaluator', () => {
  // Guards for the step-condition evaluator, so a broken port cannot pass vacuously.
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

describe('deploy.yml', () => {
  it('can only be triggered manually', () => {
    expect(Object.keys(workflow('deploy.yml').on)).toEqual(['workflow_dispatch']);
  });
});
