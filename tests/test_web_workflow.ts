// The Web app workflow (.github/workflows/web.yml) starts every job on every pull request, with no
// path filter, so `company-isolation` and `check` report on each one and can be required checks.
// `check` still requires database, emulators, company-isolation, e2e and image to succeed. On a pull request
// that changes nothing under the web paths, the other jobs skip their work and report success.
// Run by vitest in the node CI job.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commands, evaluateStep, load, Shell, shlex, WEB, type Data } from './workflow_support.ts';

const WEB_PATHS = ['web/**', 'live-relay-placeholder/**', '.github/workflows/web.yml'];
const REQUIRED = ['database', 'emulators', 'company-isolation', 'e2e', 'image'];

const web = (): Data => load(WEB);

type Needs = Record<string, { result: string; outputs?: Record<string, string> }>;

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

/** `${{ needs.<job>.result }}` and `${{ needs.<job>.outputs.<name> }}`, as Actions fills them in. */
function expand(run: string, needs: Needs): string {
  return run.replace(/\$\{\{\s*([^}]*?)\s*\}\}/g, (_, expr: string) => {
    const match = /^needs\.([\w-]+)\.(?:(result)|outputs\.(\w+))$/.exec(expr);
    if (!match) throw new Error(`unexpected expression ${expr}`);
    const need = needs[match[1]];
    return (match[2] ? need?.result : need?.outputs?.[match[3]]) ?? '';
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

const SHARDS = [1, 2, 3, 4];
const shardOutputs = (value: string): Record<string, string> =>
  Object.fromEntries(SHARDS.map((n) => [`shard${n}`, value]));

/** Every needed job succeeded, and every e2e shard reported. */
const allSuccess = (): Needs =>
  Object.fromEntries(
    REQUIRED.map((name) => [
      name,
      { result: 'success', outputs: name === 'e2e' ? shardOutputs('done') : {} },
    ]),
  );

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

  it('starts every job other than check on every pull request', () => {
    for (const [name, job] of Object.entries(web().jobs as Record<string, Data>)) {
      if (name === 'check') continue;
      expect(job, name).not.toHaveProperty('if');
      expect(job, name).not.toHaveProperty('needs');
    }
  });
});

describe('the check job', () => {
  it('needs every other job and reports even when they fail', () => {
    const job = web().jobs.check;
    expect(job.needs).toEqual(REQUIRED);
    expect(evaluateStep(job.if, {}, true)).toBe(true);
  });

  it('passes when the jobs it needs succeed and runs every one of its own steps', () => {
    const { passed, ran } = runCheck(allSuccess());
    expect(passed).toBe(true);
    for (const command of [
      'Require the database job',
      'Require the emulator job',
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
      const needs = allSuccess();
      needs[name] = { result, outputs: needs[name].outputs };
      const { passed, ran } = runCheck(needs);
      expect(passed).toBe(false);
      expect(ran).not.toContain('npm run build');
    },
  );

  it.each(SHARDS)('fails when e2e succeeds but shard %i never reported', (shard) => {
    const needs = allSuccess();
    needs.e2e.outputs = { ...shardOutputs('done'), [`shard${shard}`]: '' };
    const { passed, ran } = runCheck(needs);
    expect(passed).toBe(false);
    expect(ran).not.toContain('npm run build');
  });
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

  it('runs as a matrix of four shards, with the runner and its 35-minute limit', () => {
    const e2e = job();
    expect(e2e.strategy.matrix.shard).toEqual([1, 2, 3, 4]);
    expect(e2e.strategy['fail-fast']).toBe(false);
    expect(e2e['timeout-minutes']).toBe(35);
    expect(e2e['runs-on']).toBe("${{ vars.CI_RUNNER || 'dryscope-linux' }}");
  });

  it('gives each shard its own slice of a total that is the matrix length', () => {
    const step = testStep();
    expect(argv(step)).toEqual(['npm', 'run', 'test:e2e', '--', '--workers=2']);
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

  it('reports one output per shard, and every shard reports its own even when it skipped its work', () => {
    const e2e = job();
    expect(Object.keys(e2e.outputs).sort()).toEqual(
      e2e.strategy.matrix.shard.map((n: number) => `shard${n}`).sort(),
    );
    const done = (e2e.steps as Data[]).find((s) => s.id === 'done');
    expect(done).not.toHaveProperty('if');
    // Each leg fills in the job's output mappings from its own step outputs; as GitHub does, the
    // legs' non-empty values combine (workflow syntax, "Using Job Outputs in a Matrix Job").
    const combined: Record<string, string> = {};
    for (const n of e2e.strategy.matrix.shard) {
      const sh = new Shell();
      shells.push(sh);
      const run = sh.run(done.run.replace('${{ matrix.shard }}', String(n)));
      expect(run.status).toBe(0);
      const stepOutputs = sh.outputs();
      expect(stepOutputs).toEqual({ [`shard${n}`]: 'done' });
      const published: Record<string, string> = {};
      for (const [name, mapping] of Object.entries(e2e.outputs as Record<string, string>)) {
        const match = /^\$\{\{\s*steps\.done\.outputs\.(\w+)\s*\}\}$/.exec(mapping);
        expect(match, name).not.toBeNull();
        const value = stepOutputs[match![1]] ?? '';
        if (value !== '') published[name] = value;
      }
      // A leg that filled another shard's output would hide that shard going missing.
      expect(published).toEqual({ [`shard${n}`]: 'done' });
      Object.assign(combined, published);
    }
    // The outputs the four legs really publish are what check needs to pass.
    const needs = allSuccess();
    needs.e2e.outputs = combined;
    expect(runCheck(needs).passed).toBe(true);
  });

  it('keeps the setup steps it had, in order, before the browser tests', () => {
    const steps = job().steps as Data[];
    const kinds = steps.map((s) => {
      if (s.uses) return String(s.uses).split('@')[0];
      return s.name ?? argv(s).join(' ');
    });
    expect(kinds.slice(0, steps.findIndex(isTest))).toEqual([
      'actions/checkout',
      'Skip pull requests that change nothing under web',
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

// Each case builds and clones a small git repository, which can take seconds on a loaded runner.
describe('pull requests that change nothing under the web paths', { timeout: 30_000 }, () => {
  const GATED = ['database', 'emulators', 'company-isolation', 'e2e', 'image'];
  const WHEN_WEB = "steps.changes.outputs.web == 'true'";
  const changesStep = (job: Data): Data => (job.steps as Data[])[1];

  it.each(GATED)('%s checks out two commits, then compares them before anything else', (name) => {
    const steps = web().jobs[name].steps as Data[];
    expect(String(steps[0].uses)).toMatch(/^actions\/checkout@/);
    expect(steps[0].with['fetch-depth']).toBe(2);
    expect(steps[0]).not.toHaveProperty('if');
    const changes = changesStep(web().jobs[name]);
    expect(changes.id).toBe('changes');
    expect(changes).not.toHaveProperty('if');
    expect(changes['working-directory']).toBe('.');
    expect(changes.run).toBe(changesStep(web().jobs.database).run);
  });

  it.each(GATED)('%s gates every later step on the comparison, not removing any', (name) => {
    for (const s of (web().jobs[name].steps as Data[]).slice(2)) {
      const label = `${name}: ${s.name ?? s.uses ?? s.run}`;
      // The failure-only upload never runs when the work was skipped.
      if (s.if === 'failure()') continue;
      // The shard's own report runs even when the work was skipped (the e2e describe covers it).
      if (name === 'e2e' && s.id === 'done') continue;
      expect(s.if, label).toBe(WHEN_WEB);
    }
  });

  it('leaves check running in full', () => {
    for (const s of web().jobs.check.steps as Data[]) {
      expect(s, s.name ?? s.uses ?? s.run).not.toHaveProperty('if');
      expect(s.id).toBeUndefined();
    }
  });

  /**
   * A repository whose HEAD is a pull request's merge commit, as actions/checkout leaves it:
   * first parent master, second the pull request. Returns a fetch-depth 2 clone of it.
   */
  function mergeCommit(changed: string, depth = 2): string {
    const sh = new Shell();
    shells.push(sh);
    const env = {
      ...process.env,
      HOME: sh.tmp,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
      GIT_CONFIG_NOSYSTEM: '1',
    };
    const origin = path.join(sh.tmp, 'origin');
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, env, stdio: 'pipe' });
    mkdirSync(origin);
    git(origin, 'init', '-q', '-b', 'master');
    for (const file of [
      'web/package.json',
      'live-relay-placeholder/server.js',
      '.github/workflows/web.yml',
      '.github/workflows/ci.yml',
      'docs/notes.md',
      'docs/other.md',
    ]) {
      mkdirSync(path.dirname(path.join(origin, file)), { recursive: true });
      writeFileSync(path.join(origin, file), 'base\n');
    }
    git(origin, 'add', '-A');
    git(origin, 'commit', '-q', '-m', 'base');
    git(origin, 'checkout', '-q', '-b', 'pr');
    writeFileSync(path.join(origin, changed), 'changed\n');
    git(origin, 'commit', '-q', '-am', 'pr');
    git(origin, 'checkout', '-q', 'master');
    // A later master commit, so the merge commit's parents differ from the pull request's base.
    writeFileSync(path.join(origin, 'docs/other.md'), 'master moved\n');
    git(origin, 'commit', '-q', '-am', 'master');
    git(origin, 'checkout', '-q', '--detach');
    git(origin, 'merge', '-q', '--no-ff', '-m', 'merge', 'pr');
    git(origin, 'update-ref', 'refs/pull/1/merge', 'HEAD');
    const clone = path.join(sh.tmp, 'clone');
    git(sh.tmp, 'clone', '-q', `--depth=${depth}`, '--no-checkout', `file://${origin}`, clone);
    git(clone, 'fetch', '-q', `--depth=${depth}`, 'origin', 'refs/pull/1/merge');
    git(clone, 'checkout', '-q', 'FETCH_HEAD');
    return clone;
  }

  function webOutput(clone: string, event: string): string {
    const sh = new Shell();
    shells.push(sh);
    const result = sh.run(
      changesStep(web().jobs.database).run,
      { GITHUB_EVENT_NAME: event },
      clone,
    );
    expect(result.status, result.stderr).toBe(0);
    return sh.outputs().web;
  }

  it.each(['docs/notes.md', '.github/workflows/ci.yml'])(
    'skips the work when a pull request changes only %s',
    (changed) => {
      expect(webOutput(mergeCommit(changed), 'pull_request')).toBe('false');
    },
  );

  it.each(['web/package.json', 'live-relay-placeholder/server.js', '.github/workflows/web.yml'])(
    'runs the work when a pull request changes %s',
    (changed) => {
      expect(webOutput(mergeCommit(changed), 'pull_request')).toBe('true');
    },
  );

  it('runs the work on any other event, such as a push to master', () => {
    expect(webOutput(mergeCommit('docs/notes.md'), 'push')).toBe('true');
  });

  it('runs the work when the comparison cannot run (only one commit fetched)', () => {
    expect(webOutput(mergeCommit('docs/notes.md', 1), 'pull_request')).toBe('true');
  });
});
