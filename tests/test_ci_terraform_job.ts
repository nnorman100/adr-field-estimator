// The `terraform` job in .github/workflows/ci.yml (owner decision 3a, 2026-11-19) runs the offline
// infra/dryscope/scripts/check.sh: no cloud credentials, Terraform downloaded against a pinned
// SHA-256. On a pull request that changes nothing under infra/ or ci.yml it skips its work and
// reports success. These tests run the job's real step scripts. Run by vitest in the node CI job.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { load, Shell, WORKFLOWS, type Data } from './workflow_support.ts';

const job = (): Data => load(path.join(WORKFLOWS, 'ci.yml')).jobs.terraform;
const step = (name: string): Data => {
  const found = (job().steps as Data[]).find((s) => s.name === name);
  if (!found) throw new Error(`no step ${name}`);
  return found;
};
const WHEN_INFRA = "steps.changes.outputs.infra == 'true'";

const shells: Shell[] = [];
afterEach(() => {
  for (const sh of shells.splice(0)) rmSync(sh.tmp, { recursive: true, force: true });
});
const shell = (): Shell => {
  const sh = new Shell();
  shells.push(sh);
  return sh;
};

describe('the terraform job', () => {
  it('has a time limit, no credentials and gates every later step on the comparison', () => {
    const j = job();
    expect(j['timeout-minutes']).toBeGreaterThan(0);
    expect(JSON.stringify(j)).not.toMatch(/secrets\.|id-token|google-github-actions\/auth/);
    expect(j.steps[0].with['fetch-depth']).toBe(2);
    expect(j.steps[1].id).toBe('changes');
    for (const s of (j.steps as Data[]).slice(2)) {
      expect(s.if, s.name ?? s.uses).toBe(WHEN_INFRA);
    }
    expect(j.steps.at(-1).run).toBe('infra/dryscope/scripts/check.sh');
  });

  /** A fetch-depth 2 clone of a pull request's merge commit that changed `changed`. */
  function mergeCommit(changed: string, depth = 2): string {
    const sh = shell();
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
      'infra/dryscope/app/main.tf',
      'infra/dryscope/fixtures/app-test.plan.json',
      '.github/workflows/ci.yml',
      '.github/workflows/web.yml',
      'web/package.json',
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

  function infraOutput(clone: string, event: string): string {
    const sh = shell();
    const result = sh.run(job().steps[1].run, { GITHUB_EVENT_NAME: event }, clone);
    expect(result.status, result.stderr).toBe(0);
    return sh.outputs().infra;
  }

  it.each(['docs/notes.md', 'web/package.json', '.github/workflows/web.yml'])(
    'skips the work when a pull request changes only %s',
    (changed) => {
      expect(infraOutput(mergeCommit(changed), 'pull_request')).toBe('false');
    },
  );

  it.each([
    'infra/dryscope/app/main.tf',
    'infra/dryscope/fixtures/app-test.plan.json',
    '.github/workflows/ci.yml',
  ])('runs the work when a pull request changes %s', (changed) => {
    expect(infraOutput(mergeCommit(changed), 'pull_request')).toBe('true');
  });

  it('runs the work on a push to master', () => {
    expect(infraOutput(mergeCommit('docs/notes.md'), 'push')).toBe('true');
  });

  it('runs the work when the comparison cannot run (only one commit fetched)', () => {
    expect(infraOutput(mergeCommit('docs/notes.md', 1), 'pull_request')).toBe('true');
  });

  it('refuses a Terraform download whose checksum differs, before unpacking it', () => {
    const sh = shell();
    // A stand-in curl that writes a different file to the -o path.
    sh.fake(
      'curl',
      'while [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then echo tampered > "$2"; fi; shift; done',
    );
    sh.fake('unzip');
    const temp = path.join(sh.tmp, 'runner-temp');
    mkdirSync(temp);
    const env = { ...job().env, RUNNER_TEMP: temp, GITHUB_ENV: path.join(sh.tmp, 'env') };
    const result = sh.run(step('Install Terraform with a pinned checksum').run, env);
    expect(result.status).not.toBe(0);
    expect(sh.calls('curl')).toHaveLength(1);
    expect(sh.calls('unzip')).toEqual([]);
    expect(existsSync(env.GITHUB_ENV)).toBe(false);
  });

  it('pins one Terraform version inside the supported range', () => {
    expect(job().env.TF_VERSION).toMatch(/^1\.(9|[1-9]\d)\.\d+$/);
    expect(job().env.TF_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });
});
