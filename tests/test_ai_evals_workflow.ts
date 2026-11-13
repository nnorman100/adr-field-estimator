// Guards for the manual AI evaluation workflow (.github/workflows/ai-evals.yml; docs/plans/S7.md
// step S7-5, owner decision V9 B), run by vitest in the required node CI job. Each test names a
// property the owner approved: manual only on master, keyless as the test evaluation account and
// no other, pinned actions, no secret, inputs never pasted into shell, one run at a time, and no
// other workflow signing in as the evaluation account. That no other workflow can run an evaluation
// is the command's own refusal (web/tests/unit/ai-evals-runner.test.ts, ai-evals-files.test.ts).
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SUITES } from '../web/tests/ai-evals/suites.ts';
import { allSteps, load, Shell, step, steps, WORKFLOWS, type Data } from './workflow_support.ts';

const FILE = path.join(WORKFLOWS, 'ai-evals.yml');
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

// Every string value in a parsed workflow, with the key it sits under.
function values(data: Data, key = ''): { key: string; value: string }[] {
  if (typeof data === 'string') return [{ key, value: data }];
  if (Array.isArray(data)) return data.flatMap((item) => values(item, key));
  if (data !== null && typeof data === 'object') {
    return Object.entries(data).flatMap(([k, v]) => values(v, k));
  }
  return [];
}

// Every GitHub expression (${{ ... }}) in a parsed workflow, with the key it sits under.
function expressions(data: Data): { key: string; expression: string }[] {
  return values(data).flatMap(({ key, value }) =>
    [...value.matchAll(/\$\{\{\s*(.*?)\s*\}\}/g)].map((m) => ({ key, expression: m[1]! })),
  );
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
    expect([...workflow.on.workflow_dispatch.inputs.feature.options].sort()).toEqual(
      [...SUITES].sort(),
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
    const accounts = values(workflow).filter(({ value }) => value.includes('gserviceaccount.com'));
    expect(accounts).toEqual([{ key: 'service_account', value: EVAL_SA }]);
  });

  it('reads no secret and no setting but the runner, the test provider and its own inputs', () => {
    expect(new Set(expressions(workflow).map((e) => e.expression))).toEqual(
      new Set([
        "vars.CI_RUNNER || 'dryscope-linux'",
        'vars.DRYSCOPE_TEST_WIF_PROVIDER',
        'inputs.feature',
        'inputs.max_usd',
      ]),
    );
  });

  it('pins every action by commit and installs before signing in', () => {
    for (const s of allSteps(workflow)) {
      if (s.uses) expect(s.uses, s.uses).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    }
    const all = steps(job);
    const npm = all.map((s: Data) => {
      if (!s.run) return [];
      const sh = shell();
      sh.fake('npm');
      sh.run(s.run, {
        PROVIDER: GOOD_PROVIDER,
        FEATURE: 'injection',
        MAX_USD: '2',
        RUNNER_TEMP: sh.tmp,
      });
      return sh.calls('npm');
    });
    const install = npm.findIndex((calls) => calls.some((args) => args[0] === 'ci'));
    const evaluate = npm.findIndex((calls) => calls.some((args) => args[1] === 'eval:ai'));
    const auth = all.findIndex((s: Data) =>
      String(s.uses ?? '').startsWith('google-github-actions/auth@'),
    );
    expect(install).toBeGreaterThan(-1);
    expect(all[install]['working-directory']).toBe('web');
    expect(install).toBeLessThan(auth);
    expect(auth).toBeLessThan(evaluate);
    expect(
      all.find((s: Data) => String(s.uses ?? '').startsWith('actions/checkout@')).with[
        'persist-credentials'
      ],
    ).toBe(false);
  });

  it('passes inputs through the environment, never into the shell text', () => {
    expect(expressions(workflow).filter((e) => e.key === 'run')).toEqual([]);
    const run = step(job, 'run');
    expect(run.env).toEqual({ FEATURE: '${{ inputs.feature }}', MAX_USD: '${{ inputs.max_usd }}' });
    expect(run['working-directory']).toBe('web');
    const sh = shell();
    sh.fake('npm');
    const FEATURE = 'injection"; touch pwned; echo "';
    const ran = sh.run(run.run, { FEATURE, MAX_USD: '0.50', RUNNER_TEMP: sh.tmp });
    expect(ran.status).toBe(0);
    expect(sh.calls('npm')).toEqual([
      [
        'run',
        'eval:ai',
        '--',
        '--feature',
        FEATURE,
        '--max-usd',
        '0.50',
        '--out',
        path.join(sh.tmp, 'ai-eval-result.json'),
      ],
    ]);
    expect(existsSync(path.join(sh.tmp, 'pwned'))).toBe(false);
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

  it('is the only workflow that signs in as the evaluation account', () => {
    for (const name of readdirSync(WORKFLOWS).filter(
      (f) => /\.ya?ml$/.test(f) && f !== 'ai-evals.yml',
    )) {
      const other: Data = load(path.join(WORKFLOWS, name));
      const accounts = values(other).filter(({ value }) => value.includes('dryscope-eval-'));
      expect(accounts, name).toEqual([]);
    }
  });
});
