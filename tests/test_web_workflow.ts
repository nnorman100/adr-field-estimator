// The Web app workflow (.github/workflows/web.yml) runs every job on every pull request, with no
// path filter, so `company-isolation` and `check` report on each one and can be required checks.
// `check` still requires database, emulators and company-isolation to succeed. Run by vitest in
// the node CI job.
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateStep, load, Shell, WEB, type Data } from './workflow_support.ts';

const WEB_PATHS = ['web/**', 'live-relay-placeholder/**', '.github/workflows/web.yml'];
const REQUIRED = ['database', 'emulators', 'company-isolation'];

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

  it('starts every job other than check on every pull request', () => {
    for (const [name, job] of Object.entries(web().jobs as Record<string, Data>)) {
      if (name === 'check') continue;
      expect(job, name).not.toHaveProperty('if');
      expect(job, name).not.toHaveProperty('needs');
    }
  });
});

describe('the check job', () => {
  it('needs the three required jobs and reports even when they fail', () => {
    const job = web().jobs.check;
    expect(job.needs).toEqual(REQUIRED);
    expect(evaluateStep(job.if, {}, true)).toBe(true);
  });

  it('passes when the three jobs succeed and runs every one of its own steps', () => {
    const { passed, ran } = runCheck(all('success'));
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
      const needs = all('success');
      needs[name] = { result };
      const { passed, ran } = runCheck(needs);
      expect(passed).toBe(false);
      expect(ran).not.toContain('npm run build');
    },
  );
});
