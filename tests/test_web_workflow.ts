// The Web app workflow (.github/workflows/web.yml) runs every job on every pull request, with no
// path filter, so `company-isolation` and `check` report on each one and can be required checks.
// `check` still requires database, emulators and company-isolation to succeed. The browser tests run
// as two Playwright shards (`e2e-shard`) that feed the one required check `e2e`, which passes only
// when both passed and every listed test ran exactly once. Run by vitest in the node CI job.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateStep, load, ROOT, Shell, WEB, type Data } from './workflow_support.ts';

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
 * Runs the check job's (or the named job's) steps as Actions would on a fresh runner: the workspace starts empty and
 * holds the repository only after actions/checkout, and a run step fails when its working
 * directory is missing. The `Require` steps that test a needed job's result really run; the rest are listed.
 */
function runCheck(needs: Needs, jobName = 'check'): { passed: boolean; ran: string[] } {
  const job = web().jobs[jobName];
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
    else if (/^Require /.test(s.name ?? '') && /^test "/.test(s.run)) {
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
      'e2e-shard',
      'emulators',
      'image',
    ]);
  });

  it('starts every job other than check and e2e on every pull request', () => {
    // `e2e` joins the shards and `check` the required jobs; both report even when a job they need
    // fails (see the tests below), and the shards themselves have neither `if` nor `needs`.
    for (const [name, job] of Object.entries(web().jobs as Record<string, Data>)) {
      if (name === 'check' || name === 'e2e') continue;
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

const SHARDS = ['e2e-shard'];
const shardJob = (): Data => web().jobs['e2e-shard'];
const e2eJob = (): Data => web().jobs.e2e;
const stepRuns = (job: Data): string[] => job.steps.map((s: Data) => s.run ?? s.uses ?? '');
const named = (job: Data, name: string): Data => {
  const found = (job.steps as Data[]).filter((s) => s.name === name);
  expect(found, name).toHaveLength(1);
  return found[0];
};
const usesAction = (job: Data, action: string): Data => {
  const found = (job.steps as Data[]).filter((s) => String(s.uses ?? '').startsWith(`${action}@`));
  expect(found, action).toHaveLength(1);
  return found[0];
};

describe('the e2e shards', () => {
  it('run as a matrix of two, with the runner and 20-minute limit the one job had', () => {
    const job = shardJob();
    expect(job['runs-on']).toBe("${{ vars.CI_RUNNER || 'dryscope-linux' }}");
    expect(job['timeout-minutes']).toBe(20);
    expect(job.strategy.matrix.shard).toEqual([1, 2]);
    // Both shards report, so one failing does not hide the other.
    expect(job.strategy['fail-fast']).toBe(false);
    expect(job).not.toHaveProperty('if');
    expect(job).not.toHaveProperty('needs');
  });

  it('give each shard its own slice of one total, which is the matrix length', () => {
    const job = shardJob();
    const total = job.strategy.matrix.shard.length;
    const test = (job.steps as Data[]).filter((s) => String(s.run ?? '').includes('test:e2e'));
    expect(test).toHaveLength(1);
    expect(test[0].run).toContain(`--shard=\${{ matrix.shard }}/${total}`);
    // The workflow's only other mention of the total is the guard's, and it agrees.
    expect(stepRuns(e2eJob()).join('\n')).toContain(`--shards ${total}`);
  });

  it('keep every setup step the one job had', () => {
    const job = shardJob();
    const runs = stepRuns(job);
    expect(runs.some((r) => r.startsWith('actions/checkout@'))).toBe(true);
    expect(named(job, 'Install PostgreSQL 16 when there is no Docker daemon').run).toContain(
      'postgresql-16',
    );
    expect(usesAction(job, 'actions/setup-java').with['java-version']).toBe('21');
    expect(usesAction(job, 'actions/setup-node').with.cache).toBe('npm');
    for (const command of ['npm ci', 'npx playwright install --with-deps chromium webkit']) {
      expect(runs).toContain(command);
    }
  });

  it('write a JSON report per shard and upload it whatever the outcome', () => {
    const job = shardJob();
    const test = (job.steps as Data[]).find((s) => String(s.run ?? '').includes('test:e2e'))!;
    expect(test.run).toContain('--reporter=list,html,json');
    const report = 'e2e-reports/shard-${{ matrix.shard }}.json';
    expect(test.env.PLAYWRIGHT_JSON_OUTPUT_NAME).toBe(report);
    const upload = (job.steps as Data[]).filter(
      (s) => String(s.uses ?? '').startsWith('actions/upload-artifact@') && s.if === 'always()',
    );
    expect(upload).toHaveLength(1);
    expect(upload[0].with.name).toBe('e2e-report-${{ matrix.shard }}');
    expect(upload[0].with.path).toBe(`web/${report}`);
    expect(upload[0].with['if-no-files-found']).toBe('error');
  });

  it('keep the failure artifacts, one per shard so the names do not collide', () => {
    const failure = (shardJob().steps as Data[]).filter((s) => s.if === 'failure()');
    expect(failure).toHaveLength(1);
    expect(failure[0].with.name).toBe('web-e2e-results-${{ matrix.shard }}');
    expect(failure[0].with.path).toContain('web/test-results');
    expect(failure[0].with.path).toContain('web/playwright-report');
  });
});

describe('the e2e job', () => {
  const shards = (result: string): Needs =>
    Object.fromEntries(SHARDS.map((name) => [name, { result }]));

  it('is the one job named e2e, needs only the shards and reports even when they fail', () => {
    const job = e2eJob();
    expect(job.needs).toEqual(SHARDS);
    expect(evaluateStep(job.if, {}, true)).toBe(true);
    expect(job['runs-on']).toBe("${{ vars.CI_RUNNER || 'dryscope-linux' }}");
    expect(job['timeout-minutes']).toBeLessThanOrEqual(20);
    expect(Object.keys(web().jobs).filter((name) => name === 'e2e')).toHaveLength(1);
  });

  it('is not needed by check, which still needs the same three jobs', () => {
    expect(web().jobs.check.needs).toEqual(REQUIRED);
  });

  it('passes when both shards succeed and runs every one of its steps', () => {
    const { passed, ran } = runCheck(shards('success'), 'e2e');
    expect(passed).toBe(true);
    for (const command of [
      'Require both e2e shards',
      'npm ci',
      'List every browser test',
      'Require every test to have run exactly once',
    ]) {
      expect(ran).toContain(command);
    }
  });

  it.each(['failure', 'cancelled', 'skipped'])(
    'fails without the guard when a shard is %s',
    (r) => {
      const { passed, ran } = runCheck(shards(r), 'e2e');
      expect(passed).toBe(false);
      expect(ran).not.toContain('List every browser test');
      expect(ran).not.toContain('Require every test to have run exactly once');
    },
  );

  it('gets the shard reports, lists the tests and runs the guard, in that order', () => {
    const job = e2eJob();
    const download = usesAction(job, 'actions/download-artifact');
    expect(download.with.pattern).toBe('e2e-report-*');
    expect(download.with['merge-multiple']).toBe(true);
    expect(download.with.path).toBe('web/e2e-reports');
    const list = named(job, 'List every browser test');
    expect(list.run).toBe('npx playwright test --list --reporter=json > /dev/null');
    const guard = named(job, 'Require every test to have run exactly once');
    expect(guard.run).toContain('node scripts/check-e2e-shards.ts');
    expect(guard.run).toContain('e2e-reports/shard-*.json');
    for (const s of [download, list, guard]) {
      expect(s).not.toHaveProperty('if');
      expect(s).not.toHaveProperty('continue-on-error');
    }
    const order = (job.steps as Data[]).map((s) => s.name ?? s.uses ?? s.run);
    const at = (name: string) => order.findIndex((o) => String(o).startsWith(name));
    expect(at('Require both e2e shards')).toBeLessThan(at('actions/download-artifact'));
    expect(at('actions/download-artifact')).toBeLessThan(at('List every browser test'));
    expect(at('List every browser test')).toBeLessThan(at('Require every test'));
  });

  it('reads the list where the list step writes it, and the reports where the shards upload them', () => {
    const job = e2eJob();
    const list = named(job, 'List every browser test');
    const guard = named(job, 'Require every test to have run exactly once');
    expect(list.env.PLAYWRIGHT_JSON_OUTPUT_NAME).toBe('${{ runner.temp }}/e2e-list.json');
    expect(guard.run).toContain('--list "$RUNNER_TEMP/e2e-list.json"');
  });

  describe('the guard step, run for real', () => {
    // The step's own command line, in a copy of web/ holding only the script, with the shard
    // reports a run would download.
    const place = (reports: Record<string, unknown>) => {
      const sh = new Shell();
      shells.push(sh);
      const web = path.join(sh.tmp, 'web');
      mkdirSync(path.join(web, 'scripts'), { recursive: true });
      cpSync(
        path.join(ROOT, 'web', 'scripts', 'check-e2e-shards.ts'),
        path.join(web, 'scripts', 'check-e2e-shards.ts'),
      );
      mkdirSync(path.join(web, 'e2e-reports'));
      const temp = path.join(sh.tmp, 'runner-temp');
      mkdirSync(temp);
      for (const [file, report] of Object.entries(reports)) {
        const target = file === 'list' ? path.join(temp, 'e2e-list.json') : path.join(web, file);
        writeFileSync(target, JSON.stringify(report));
      }
      const guard = named(e2eJob(), 'Require every test to have run exactly once');
      return sh.run(guard.run, { RUNNER_TEMP: temp }, web);
    };
    const one = (project: string, results: unknown[]) => ({
      errors: [],
      suites: [
        {
          title: 'a.spec.ts',
          specs: [
            {
              title: 't',
              file: 'a.spec.ts',
              line: 1,
              column: 1,
              tests: [{ projectName: project, results }],
            },
          ],
        },
      ],
    });
    const both = {
      errors: [],
      suites: [
        {
          ...one('chromium', []).suites[0],
          specs: [...one('chromium', []).suites[0].specs, ...one('webkit', []).suites[0].specs],
        },
      ],
    };

    it('passes when each listed test is in exactly one shard', () => {
      const result = place({
        list: both,
        'e2e-reports/shard-1.json': one('chromium', [{}]),
        'e2e-reports/shard-2.json': one('webkit', [{}]),
      });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    });

    it('fails when a listed test ran in no shard', () => {
      const result = place({
        list: both,
        'e2e-reports/shard-1.json': one('chromium', [{}]),
        'e2e-reports/shard-2.json': { errors: [], suites: [] },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('ran in no shard: webkit | a.spec.ts:1:1');
    });

    it('fails when a test ran in both shards', () => {
      const result = place({
        list: both,
        'e2e-reports/shard-1.json': one('chromium', [{}]),
        'e2e-reports/shard-2.json': one('chromium', [{}]),
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('ran in shard 1 and shard 2: chromium | a.spec.ts:1:1');
    });

    it('fails when a shard report is missing', () => {
      const result = place({ list: both, 'e2e-reports/shard-1.json': one('chromium', [{}]) });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('expected 2 shard reports, found 1');
    });
  });
});

describe('the e2e reports directory', () => {
  it('is ignored by git, so a local run leaves the tree clean', () => {
    const ignore = readFileSync(path.join(ROOT, 'web', '.gitignore'), 'utf8').split('\n');
    expect(ignore).toContain('e2e-reports/');
  });
});
