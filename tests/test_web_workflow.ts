// The Web app workflow (.github/workflows/web.yml) splits its jobs in two (docs/runbook/ci.md,
// "Fast pull requests, full suite after merge"). On every pull request, with no path filter:
// `company-isolation` and `check`, the required checks; `check` requires company-isolation to
// succeed. After merge (pushes to master): those two plus the full suite (database, emulators, e2e,
// image), and the release workflow ships a commit only when every job passed. Run by vitest in the
// node CI job.
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commands, evaluateStep, load, Shell, shlex, WEB, type Data } from './workflow_support.ts';

const WEB_PATHS = ['web/**', 'live-relay-placeholder/**', '.github/workflows/web.yml'];
const REQUIRED = ['company-isolation'];
// The full suite: skipped on pull requests, run on every push to master before any release.
const POST_MERGE = ['database', 'e2e', 'emulators', 'image'];
const POST_MERGE_IF = "github.event_name != 'pull_request'";

const web = (): Data => load(WEB);

type Needs = Record<string, { result: string }>;

const shells: Shell[] = [];
afterEach(() => {
  for (const sh of shells.splice(0)) rmSync(sh.tmp, { recursive: true, force: true });
});

/** A run step's working directory: its own, else the job's default, else the workflow's. */
function workDir(job: Data, step: Data): string {
  return (
    step['working-directory'] ??
    job.defaults?.run?.['working-directory'] ??
    web().defaults?.run?.['working-directory'] ??
    '.'
  );
}

/** `${{ needs.<job>.result }}`, as Actions fills it in. */
function expand(run: string, needs: Needs): string {
  return run.replace(/\$\{\{\s*([^}]*?)\s*\}\}/g, (_, expr: string) => {
    const match = /^needs\.([\w-]+)\.result$/.exec(expr);
    if (!match) throw new Error(`unexpected expression ${expr}`);
    return needs[match[1]]?.result ?? '';
  });
}

/**
 * Runs the check job's steps as Actions would on a fresh runner: the workspace starts empty and
 * holds the repository only after actions/checkout, and a run step fails when its working
 * directory is missing. The `Require` steps really run; the rest are listed.
 */
function runCheck(needs: Needs): { passed: boolean; ran: string[] } {
  const job = web().jobs.check;
  expect(evaluateStep(job.if, {}, true)).toBe(true);
  const sh = new Shell();
  shells.push(sh);
  const workspace = path.join(sh.tmp, 'workspace');
  mkdirSync(workspace);
  let failed = false;
  const ran: string[] = [];
  for (const s of job.steps as Data[]) {
    const runs = s.if === undefined ? !failed : evaluateStep(s.if, {}, failed);
    if (!runs) continue;
    ran.push(s.name ?? s.run ?? s.uses);
    if (s.uses?.startsWith('actions/checkout@')) mkdirSync(path.join(workspace, 'web'));
    if (s.run === undefined) continue;
    const cwd = path.join(workspace, workDir(job, s));
    if (!existsSync(cwd)) failed = true;
    else if (/^Require /.test(s.name ?? '')) {
      const result = sh.run(expand(s.run, needs), {}, cwd);
      if (result.status !== 0) failed = true;
    }
  }
  return { passed: !failed, ran };
}

const all = (result: string): Needs =>
  Object.fromEntries(REQUIRED.map((name) => [name, { result }]));

describe('web.yml triggers', () => {
  it('runs on every pull request, and on master pushes only when web files change', () => {
    const on = web().on;
    expect(on).toHaveProperty('pull_request', null);
    expect(on.push).toEqual({ branches: ['master'], paths: WEB_PATHS });
  });

  it('keeps its job names, which are the check names', () => {
    expect(Object.keys(web().jobs).sort()).toEqual([
      'check',
      'company-isolation',
      'database',
      'e2e',
      'emulators',
      'image',
    ]);
  });

  it('starts company-isolation on every pull request', () => {
    const job = web().jobs['company-isolation'];
    expect(job).not.toHaveProperty('if');
    expect(job).not.toHaveProperty('needs');
  });

  it('runs the full suite only after merge, never skipped on a push to master', () => {
    const jobs = web().jobs as Record<string, Data>;
    for (const name of POST_MERGE) {
      expect(jobs[name].if, name).toBe(POST_MERGE_IF);
      expect(jobs[name], name).not.toHaveProperty('needs');
    }
    // Every job is either a pull-request job or a post-merge job; nothing else is skipped.
    expect(
      Object.keys(jobs)
        .filter((name) => jobs[name].if !== undefined)
        .sort(),
    ).toEqual([...POST_MERGE, 'check'].sort());
  });

  it('gives every job a time limit, the budget an agent brings it back under', () => {
    for (const [name, job] of Object.entries(web().jobs as Record<string, Data>)) {
      expect(job['timeout-minutes'], name).toBeGreaterThan(0);
    }
  });
});

describe('the check job', () => {
  it('needs company-isolation and reports even when it fails', () => {
    const job = web().jobs.check;
    expect(job.needs).toEqual(REQUIRED);
    expect(evaluateStep(job.if, {}, true)).toBe(true);
  });

  it('passes when company-isolation succeeds and runs every one of its own steps', () => {
    const { passed, ran } = runCheck(all('success'));
    expect(passed).toBe(true);
    for (const command of [
      'Require the company-isolation job',
      'npm ci',
      'npm run typecheck',
      'npm run lint',
      'npm test',
      'npm run build',
    ]) {
      expect(ran).toContain(command);
    }
  });

  it.each(REQUIRED.flatMap((name) => ['failure', 'cancelled', 'skipped'].map((r) => [name, r])))(
    'fails when %s is %s',
    (name, result) => {
      const needs = all('success');
      needs[name] = { result };
      const { passed, ran } = runCheck(needs);
      expect(passed).toBe(false);
      expect(ran).not.toContain('npm run build');
    },
  );
});

describe('the e2e job', () => {
  const job = (): Data => web().jobs.e2e;
  /** A step's command line as argv, comments dropped. */
  const argv = (step: Data): string[] => shlex(commands(step));
  const isTest = (step: Data): boolean => argv(step).slice(0, 3).join(' ') === 'npm run test:e2e';
  const testStep = (): Data => {
    const found = (job().steps as Data[]).filter(isTest);
    expect(found).toHaveLength(1);
    return found[0];
  };

  it('runs as a matrix of two shards, with the runner and 20-minute limit it had', () => {
    const e2e = job();
    expect(e2e.strategy.matrix.shard).toEqual([1, 2]);
    expect(e2e.strategy['fail-fast']).toBe(false);
    expect(e2e['timeout-minutes']).toBe(20);
    expect(e2e['runs-on']).toBe("${{ vars.CI_RUNNER || 'dryscope-linux' }}");
  });

  it('gives each shard its own slice of a total that is the matrix length', () => {
    const step = testStep();
    expect(argv(step)).toEqual(['npm', 'run', 'test:e2e']);
    const total = job().strategy.matrix.shard.length;
    expect(step.env.E2E_SHARD).toBe(`\${{ matrix.shard }}/${total}`);
  });

  it('names the failure artifact per shard, so the shards do not collide', () => {
    const uploads = (job().steps as Data[]).filter(
      (s) => String(s.uses ?? '').startsWith('actions/upload-artifact@') && s.if === 'failure()',
    );
    expect(uploads).toHaveLength(1);
    expect(uploads[0].with.name).toBe('web-e2e-results-${{ matrix.shard }}');
    expect(
      String(uploads[0].with.path)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    ).toEqual(['web/test-results', 'web/playwright-report']);
  });

  it('keeps the setup steps it had, in order, before the browser tests', () => {
    const steps = job().steps as Data[];
    const kinds = steps.map((s) => {
      if (s.uses) return String(s.uses).split('@')[0];
      return s.name ?? argv(s).join(' ');
    });
    expect(kinds.slice(0, steps.findIndex(isTest))).toEqual([
      'actions/checkout',
      'Install PostgreSQL 16 when there is no Docker daemon',
      'actions/setup-java',
      'actions/setup-node',
      'npm ci',
      'npx playwright install --with-deps chromium webkit',
    ]);
    const java = steps.find((s) => String(s.uses ?? '').startsWith('actions/setup-java@'));
    expect(java.with['java-version']).toBe('21');
  });
});

describe('emulator ports', () => {
  // web/tests/emu/ports.ts: with EMU_PORTS=auto, test:emu, test:isolation and test:e2e each claim
  // free ports. `check` runs the unit tests, one of which pins the default config, so it must not set it.
  it('are picked per run in the jobs that start emulators, so runners sharing a machine never collide', () => {
    const jobs = web().jobs as Record<string, Data>;
    for (const name of ['emulators', 'company-isolation', 'e2e']) {
      expect(jobs[name].env?.EMU_PORTS, `job ${name}`).toBe('auto');
    }
    for (const name of Object.keys(jobs).filter(
      (name) => !['emulators', 'company-isolation', 'e2e'].includes(name),
    )) {
      expect(jobs[name].env?.EMU_PORTS, `job ${name}`).toBeUndefined();
    }
    expect(web().env?.EMU_PORTS).toBeUndefined();
  });
});
