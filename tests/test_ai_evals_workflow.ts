// Guards for the manual AI evaluation workflow (.github/workflows/ai-evals.yml; docs/plans/S7.md
// step S7-5, owner decision V9 B), run by vitest in the required node CI job. Each test names a
// property the owner approved: manual only on master, keyless as the test evaluation account and
// no other, pinned actions, no secret, inputs never pasted into shell, one run at a time, and real
// models reachable from no other workflow.
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  allSteps,
  load,
  ROOT,
  Shell,
  step,
  steps,
  WORKFLOWS,
  type Data,
} from './workflow_support.ts';

const FILE = path.join(WORKFLOWS, 'ai-evals.yml');
const text = readFileSync(FILE, 'utf8');
const workflow: Data = load(FILE);
const job: Data = workflow.jobs.evaluate;
const EVAL_SA = 'dryscope-eval-test@dryscope.iam.gserviceaccount.com';
const GOOD_PROVIDER =
  'projects/570228742694/locations/global/workloadIdentityPools/dryscope-test/providers/github';

const shells: Shell[] = [];
afterEach(() => {
  for (const s of shells.splice(0)) rmSync(s.tmp, { recursive: true, force: true });
});
function shell(): Shell {
  const s = new Shell();
  shells.push(s);
  return s;
}

describe('ai-evals.yml', () => {
  it('runs only when dispatched by hand, on master, in the test environment', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(Object.keys(workflow.jobs)).toEqual(['evaluate']);
    expect(job.if).toBe("github.ref == 'refs/heads/master'");
    expect(job.environment).toBe('test');
    expect(job['runs-on']).toBe("${{ vars.CI_RUNNER || 'dryscope-linux' }}");
    expect(workflow.concurrency).toEqual({ group: 'ai-evals-test', 'cancel-in-progress': false });
  });

  it('offers exactly the runner suites, with a cap input', () => {
    const runner = readFileSync(path.join(ROOT, 'web/tests/ai-evals/runner.ts'), 'utf8');
    const suites = /export const SUITES = \[([^\]]+)\]/
      .exec(runner)![1]!
      .match(/'([a-z_]+)'/g)!
      .map((s) => s.slice(1, -1));
    expect([...workflow.on.workflow_dispatch.inputs.feature.options].sort()).toEqual(
      [...suites].sort(),
    );
    expect(workflow.on.workflow_dispatch.inputs.max_usd).toMatchObject({
      default: '2',
      type: 'string',
    });
  });

  it('asks only for an ID token and read access', () => {
    expect(workflow.permissions).toEqual({});
    expect(job.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
  });

  it('signs in keyless as the test evaluation account and no other account', () => {
    const auth = steps(job).filter((s: Data) =>
      String(s.uses ?? '').startsWith('google-github-actions/auth@'),
    );
    expect(auth).toHaveLength(1);
    expect(auth[0].with).toEqual({
      workload_identity_provider: '${{ vars.DRYSCOPE_TEST_WIF_PROVIDER }}',
      service_account: EVAL_SA,
      project_id: 'dryscope',
    });
    expect(text.match(/[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com/g)).toEqual([EVAL_SA]);
    expect(text).not.toMatch(/DEPLOY_SA|MIGRATE_SA|secrets\.|credentials_json|-live\b/);
  });

  it('pins every action by commit and installs before signing in', () => {
    for (const s of allSteps(workflow)) {
      if (s.uses) expect(s.uses, s.uses).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    }
    const all = steps(job);
    const install = all.findIndex((s: Data) => s.run === 'npm ci');
    const auth = all.findIndex((s: Data) =>
      String(s.uses ?? '').startsWith('google-github-actions/auth@'),
    );
    expect(install).toBeGreaterThan(-1);
    expect(install).toBeLessThan(auth);
    expect(
      all.find((s: Data) => String(s.uses ?? '').startsWith('actions/checkout@')).with[
        'persist-credentials'
      ],
    ).toBe(false);
  });

  it('passes inputs through the environment, never into the shell text', () => {
    for (const s of allSteps(workflow)) expect(String(s.run ?? '')).not.toMatch(/\$\{\{/);
    const run = step(job, 'run');
    expect(run.run).toBe(
      'npm run eval:ai -- --feature "$FEATURE" --max-usd "$MAX_USD" --out "$RUNNER_TEMP/ai-eval-result.json"',
    );
    expect(run.env).toEqual({ FEATURE: '${{ inputs.feature }}', MAX_USD: '${{ inputs.max_usd }}' });
    expect(run['working-directory']).toBe('web');
  });

  it('checks the provider and the cap before anything runs', () => {
    const check = step(job, 'check');
    expect(steps(job).indexOf(check)).toBe(0);
    const sh = shell();
    expect(sh.run(check.run, { PROVIDER: GOOD_PROVIDER, MAX_USD: '2' }).status).toBe(0);
    expect(sh.run(check.run, { PROVIDER: GOOD_PROVIDER, MAX_USD: '0.50' }).status).toBe(0);
    for (const MAX_USD of ['2.01', '3', '-1', '1e3', '', '2; echo hi']) {
      expect(sh.run(check.run, { PROVIDER: GOOD_PROVIDER, MAX_USD }).status, MAX_USD).not.toBe(0);
    }
    for (const PROVIDER of [
      '',
      GOOD_PROVIDER.replace('dryscope-test', 'dryscope-live'),
      GOOD_PROVIDER.replace('570228742694', '1'),
    ]) {
      expect(sh.run(check.run, { PROVIDER, MAX_USD: '2' }).status, PROVIDER).not.toBe(0);
    }
  });

  it('writes the result file to the run summary, and says so when there is none', () => {
    const summary = step(job, 'summary');
    expect(summary.if).toBe('always()');
    const sh = shell();
    writeFileSync(path.join(sh.tmp, 'ai-eval-result.json'), '{"suite":"injection","pass":true}\n');
    expect(sh.run(summary.run, { RUNNER_TEMP: sh.tmp }).status).toBe(0);
    expect(readFileSync(sh.summary, 'utf8')).toContain('{"suite":"injection","pass":true}');
    const empty = shell();
    expect(empty.run(summary.run, { RUNNER_TEMP: path.join(empty.tmp, 'none') }).status).toBe(0);
    expect(readFileSync(empty.summary, 'utf8')).toContain('No result');
  });

  it('is the only workflow that runs real-model evaluations or the audio script', () => {
    for (const name of readdirSync(WORKFLOWS).filter(
      (f) => /\.ya?ml$/.test(f) && f !== 'ai-evals.yml',
    )) {
      const other = readFileSync(path.join(WORKFLOWS, name), 'utf8');
      expect(other, name).not.toMatch(/eval:ai|eval-ai|eval:audio|make-eval-audio|dryscope-eval-/);
    }
  });
});
