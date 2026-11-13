// The Web app workflow (.github/workflows/web.yml) reports `company-isolation` and `check` on every
// pull request, so both can be required checks: the `changes` job decides whether web/,
// live-relay-placeholder/ or the workflow itself changed, the web jobs are skipped when nothing
// did, and `check` passes then only after seeing them skipped. Run by vitest in the node CI job.
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateStep, load, Shell, WEB, type Data } from './workflow_support.ts';

const WEB_PATHS = ['web/**', 'live-relay-placeholder/**', '.github/workflows/web.yml'];
const GATED = ['database', 'emulators', 'company-isolation', 'e2e', 'image'];
const REQUIRED = ['database', 'emulators', 'company-isolation'];
const GATE = "${{ !cancelled() && needs.changes.outputs.web != 'false' }}";

const web = (): Data => load(WEB);
const diffStep = (): Data => web().jobs.changes.steps.find((s: Data) => s.id === 'diff');

type Needs = Record<string, { result: string; outputs?: Record<string, string> }>;

const shells: Shell[] = [];
afterEach(() => {
  for (const sh of shells.splice(0)) rmSync(sh.tmp, { recursive: true, force: true });
});
function shell(): Shell {
  const sh = new Shell();
  shells.push(sh);
  return sh;
}

/** `${{ needs.<job>.result }}` and `${{ needs.<job>.outputs.<name> }}`, as Actions fills them in. */
function expand(run: string, needs: Needs): string {
  return run.replace(/\$\{\{\s*([^}]*?)\s*\}\}/g, (_, expr: string) => {
    const match = /^needs\.([\w-]+)\.(result|outputs\.(\w+))$/.exec(expr);
    if (!match) throw new Error(`unexpected expression ${expr}`);
    const job = needs[match[1]];
    const value = match[3] === undefined ? job?.result : job?.outputs?.[match[3]];
    return value ?? '';
  });
}

/** Runs the check job's steps as Actions would; the gate steps really run, the rest are listed. */
function runCheck(needs: Needs): { passed: boolean; ran: string[] } {
  const job = web().jobs.check;
  expect(evaluateStep(job.if, {}, false, { needs })).toBe(true);
  const sh = shell();
  let failed = false;
  const ran: string[] = [];
  for (const s of job.steps as Data[]) {
    const runs = s.if === undefined ? !failed : evaluateStep(s.if, {}, failed, { needs });
    if (!runs) continue;
    const label = s.name ?? s.run ?? s.uses;
    ran.push(label);
    if (/^(Require|Confirm) /.test(s.name ?? '')) {
      const result = sh.run(expand(s.run, needs));
      if (result.status !== 0) failed = true;
    }
  }
  return { passed: !failed, ran };
}

function needsOf(
  changes: string,
  webOutput: string | undefined,
  results: Record<string, string>,
): Needs {
  const needs: Needs = {
    changes: { result: changes, outputs: webOutput === undefined ? {} : { web: webOutput } },
  };
  for (const name of REQUIRED) needs[name] = { result: results[name] };
  return needs;
}

const all = (result: string) => Object.fromEntries(REQUIRED.map((name) => [name, result]));

describe('web.yml triggers', () => {
  it('runs on every pull request, and on master pushes only when web files change', () => {
    const on = web().on;
    expect(on).toHaveProperty('pull_request', null);
    expect(on.push).toEqual({ branches: ['master'], paths: WEB_PATHS });
  });

  it('keeps its job names, which are the check names', () => {
    expect(Object.keys(web().jobs).sort()).toEqual([
      'changes',
      'check',
      'company-isolation',
      'database',
      'e2e',
      'emulators',
      'image',
    ]);
  });
});

describe('the web jobs', () => {
  it.each(GATED)('%s waits for the changes job and is gated on it', (name) => {
    const job = web().jobs[name];
    expect(job.needs).toBe('changes');
    expect(job.if).toBe(GATE);
  });

  it.each([
    ['success', 'true', true],
    ['success', 'false', false],
    // A failed changes job leaves no answer: the jobs still run, and check fails on it.
    ['failure', undefined, true],
  ])('with the changes job %s and web=%s, they run: %s', (result, output, expected) => {
    const needs = { changes: { result, outputs: output === undefined ? {} : { web: output } } };
    for (const name of GATED) {
      expect(evaluateStep(web().jobs[name].if, {}, result !== 'success', { needs }), name).toBe(
        expected,
      );
    }
  });
});

describe('the check job', () => {
  it('needs the changes job and the three required jobs, and reports unless cancelled', () => {
    const job = web().jobs.check;
    expect(job.needs).toEqual(['changes', ...REQUIRED]);
    expect(job.if).toBe('always() && !cancelled()');
  });

  it('with web changes requires each job and runs every one of its own steps', () => {
    const { passed, ran } = runCheck(needsOf('success', 'true', all('success')));
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
    expect(ran).not.toContain('Confirm the web jobs were skipped');
  });

  it.each(REQUIRED.flatMap((name) => ['failure', 'cancelled', 'skipped'].map((r) => [name, r])))(
    'with web changes fails when %s is %s',
    (name, result) => {
      const results = all('success');
      results[name] = result;
      expect(runCheck(needsOf('success', 'true', results)).passed).toBe(false);
    },
  );

  it('without web changes passes on the skipped jobs and runs none of its build steps', () => {
    const { passed, ran } = runCheck(needsOf('success', 'false', all('skipped')));
    expect(passed).toBe(true);
    expect(ran).toEqual(['Require the changes job', 'Confirm the web jobs were skipped']);
  });

  it.each(REQUIRED.flatMap((name) => ['failure', 'cancelled', 'success'].map((r) => [name, r])))(
    'without web changes fails when %s is %s instead of skipped',
    (name, result) => {
      const results = all('skipped');
      results[name] = result;
      expect(runCheck(needsOf('success', 'false', results)).passed).toBe(false);
    },
  );

  it.each(['failure', 'cancelled', 'skipped'])('fails when the changes job is %s', (result) => {
    expect(runCheck(needsOf(result, undefined, all('success'))).passed).toBe(false);
    expect(runCheck(needsOf(result, undefined, all('skipped'))).passed).toBe(false);
  });
});

describe('the changes job', () => {
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.invalid',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.invalid',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      },
    });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout;
  };
  const write = (root: string, file: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };

  /**
   * A base branch, a pull request branch made by `change`, and a two-commit clone of the merge
   * commit, as actions/checkout leaves a pull request with fetch-depth 2.
   */
  function pullRequest(sh: Shell, change: (root: string) => void, onBase?: (r: string) => void) {
    const root = path.join(sh.tmp, 'origin');
    mkdirSync(root);
    git(root, 'init', '-q', '-b', 'master');
    for (const file of [
      'web/src/a.ts',
      'live-relay-placeholder/server.js',
      '.github/workflows/web.yml',
      '.github/workflows/ci.yml',
      'docs/a.md',
    ]) {
      write(root, file, `${file}\n`);
    }
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'base');
    git(root, 'checkout', '-qb', 'pr');
    change(root);
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'change');
    git(root, 'checkout', '-q', 'master');
    if (onBase) {
      onBase(root);
      git(root, 'add', '-A');
      git(root, 'commit', '-qm', 'base moves on');
    }
    git(root, 'merge', '-q', '--no-ff', '-m', 'merge', 'pr');
    const clone = path.join(sh.tmp, 'checkout');
    git(sh.tmp, 'clone', '-q', '--depth', '2', `file://${root}`, clone);
    return clone;
  }

  function decide(sh: Shell, cwd: string, event = 'pull_request'): string | undefined {
    const step = diffStep();
    expect(step['working-directory']).toBe('.');
    expect(step.env).toEqual({ EVENT_NAME: '${{ github.event_name }}' });
    const result = sh.run(step.run, { EVENT_NAME: event }, cwd);
    expect(result.status, result.stderr).toBe(0);
    return sh.outputs().web;
  }

  it('checks out the merge commit and its parents without credentials', () => {
    const job = web().jobs.changes;
    expect(job.outputs).toEqual({ web: '${{ steps.diff.outputs.web }}' });
    expect(job.steps[0].uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
    expect(job.steps[0].with).toEqual({ 'fetch-depth': 2, 'persist-credentials': false });
    expect(job).not.toHaveProperty('if');
    expect(job.steps[1]).not.toHaveProperty('if');
  });

  it.each([
    ['web/src/a.ts', 'edit'],
    ['web/src/new.ts', 'add'],
    ['web/src/a.ts', 'delete'],
    ['live-relay-placeholder/server.js', 'edit'],
    ['.github/workflows/web.yml', 'edit'],
  ])('answers web=true when %s gets a %s', (file, how) => {
    const sh = shell();
    const clone = pullRequest(sh, (root) => {
      if (how === 'delete') git(root, 'rm', '-q', file);
      else write(root, file, 'changed\n');
    });
    expect(decide(sh, clone)).toBe('true');
  });

  it('answers web=true when a web file moves out of web/', () => {
    const sh = shell();
    const clone = pullRequest(sh, (root) => git(root, 'mv', 'web/src/a.ts', 'docs/a.ts'));
    expect(decide(sh, clone)).toBe('true');
  });

  it.each(['docs/a.md', '.github/workflows/ci.yml', 'infra/dryscope/main.tf', 'webapp/x.ts'])(
    'answers web=false when only %s changes',
    (file) => {
      const sh = shell();
      const clone = pullRequest(sh, (root) => write(root, file, 'changed\n'));
      expect(decide(sh, clone)).toBe('false');
    },
  );

  it('answers web=false for a docs change after the base branch changed web/', () => {
    const sh = shell();
    const clone = pullRequest(
      sh,
      (root) => write(root, 'docs/a.md', 'changed\n'),
      (root) => write(root, 'web/src/a.ts', 'base change\n'),
    );
    expect(decide(sh, clone)).toBe('false');
  });

  it('answers web=true for a push, even when only docs changed', () => {
    const sh = shell();
    const clone = pullRequest(sh, (root) => write(root, 'docs/a.md', 'changed\n'));
    expect(decide(sh, clone, 'push')).toBe('true');
  });

  it.each([
    ['a commit that is not a merge', true],
    ['a directory that is not a repository', false],
  ])('answers web=true for %s', (_, isRepo) => {
    const sh = shell();
    const dir = path.join(sh.tmp, 'plain');
    mkdirSync(dir);
    if (isRepo) {
      git(dir, 'init', '-q', '-b', 'master');
      write(dir, 'docs/a.md', 'a\n');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-qm', 'one');
    }
    expect(decide(sh, dir)).toBe('true');
  });
});
