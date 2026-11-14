// The Web app workflow (.github/workflows/web.yml) runs every job on every pull request, with no
// path filter, so `company-isolation` and `check` report on each one and can be required checks.
// `check` still requires database, emulators and company-isolation to succeed. The browser tests run
// as two Playwright shards (`e2e-shard`) that feed the one required check `e2e`, which passes only
// when both passed and every listed test ran exactly once. Run by vitest in the node CI job.
import { spawnSync } from 'node:child_process';
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

type Context = Record<string, string>;

/** `${{ <expression> }}`, as Actions fills it in from the context; any other expression is an error. */
function expand(text: string, context: Context): string {
  return text.replace(/\$\{\{\s*([^}]*?)\s*\}\}/g, (_, expr: string) => {
    if (!Object.hasOwn(context, expr)) throw new Error(`unexpected expression ${expr}`);
    return context[expr];
  });
}

const newShell = (): Shell => {
  const sh = new Shell();
  shells.push(sh);
  return sh;
};

/** Uploaded artifacts by name: the files and directories each one holds. */
type Artifacts = Record<string, string[]>;

const GUARD = path.join(ROOT, 'web', 'scripts', 'check-e2e-shards.ts');
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Runs a job's steps as Actions would on a fresh runner, filling in `${{ }}` from the context: the
 * workspace starts empty and holds the repository (here web/ with the shard guard) only after
 * actions/checkout; a run step runs under bash in its working directory with the commands `sh`
 * fakes, and fails when that directory is missing; upload-artifact collects the paths it finds and
 * download-artifact copies the matching artifacts into its path. A failed step fails the job unless
 * it continues on error, and each later step runs only as its `if` allows.
 */
function runJob(
  jobName: string,
  sh: Shell,
  context: Context,
  artifacts: Artifacts = {},
): { passed: boolean; ran: string[]; output: string } {
  const job = web().jobs[jobName];
  const workspace = path.join(sh.tmp, 'workspace');
  const temp = path.join(sh.tmp, 'runner-temp');
  mkdirSync(workspace);
  mkdirSync(temp);
  const ctx = { ...context, 'runner.temp': temp };
  let failed = false;
  let output = '';
  const ran: string[] = [];
  const act = (s: Data): boolean => {
    const uses = String(s.uses ?? '');
    const w = s.with ?? {};
    if (uses.startsWith('actions/checkout@')) {
      mkdirSync(path.join(workspace, 'web', 'scripts'), { recursive: true });
      cpSync(GUARD, path.join(workspace, 'web', 'scripts', path.basename(GUARD)));
      return true;
    }
    if (uses.startsWith('actions/upload-artifact@')) {
      const found = expand(w.path, ctx)
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && existsSync(path.join(workspace, line)));
      if (found.length === 0 && w['if-no-files-found'] === 'error') return false;
      artifacts[expand(w.name, ctx)] = found.map((line) => path.join(workspace, line));
      return true;
    }
    if (uses.startsWith('actions/download-artifact@')) {
      const pattern = new RegExp(`^${String(w.pattern).split('*').map(escape).join('.*')}$`);
      for (const [name, files] of Object.entries(artifacts)) {
        if (!pattern.test(name)) continue;
        const into = path.join(workspace, w.path, w['merge-multiple'] ? '' : name);
        mkdirSync(into, { recursive: true });
        for (const file of files)
          cpSync(file, path.join(into, path.basename(file)), { recursive: true });
      }
      return true;
    }
    if (s.run === undefined) return true;
    const cwd = path.join(workspace, workDir(job, s));
    if (!existsSync(cwd)) return false;
    const env: Context = { RUNNER_TEMP: temp };
    for (const [key, value] of Object.entries({ ...job.env, ...s.env })) {
      env[key] = expand(String(value), ctx);
    }
    const result = sh.run(expand(s.run, ctx), env, cwd);
    output += result.stdout + result.stderr;
    return result.status === 0;
  };
  for (const s of job.steps as Data[]) {
    const runs = s.if === undefined ? !failed : evaluateStep(s.if, {}, failed);
    if (!runs) continue;
    ran.push(s.name ?? s.run ?? s.uses);
    if (!act(s) && !s['continue-on-error']) failed = true;
  }
  return { passed: !failed, ran, output };
}

const needsContext = (needs: Needs): Context =>
  Object.fromEntries(
    Object.entries(needs).map(([name, { result }]) => [`needs.${name}.result`, result]),
  );

/** The check job on a fresh runner, its `Require` steps run for real and npm faked. */
function runCheck(needs: Needs): { passed: boolean; ran: string[] } {
  const job = web().jobs.check;
  expect(evaluateStep(job.if, {}, true)).toBe(true);
  const sh = newShell();
  sh.fake('npm');
  return runJob('check', sh, needsContext(needs));
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
const shardCount = (): number => shardJob().strategy.matrix.shard.length;
const PG = 'Install PostgreSQL 16 when there is no Docker daemon';
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

// Playwright's JSON reports for a suite of four tests: two specs in each browser project.
const LISTED = ['chromium', 'webkit'].flatMap((project) =>
  [1, 2].map((line) => ({ project, line })),
);
const report = (tests: typeof LISTED, results: unknown[]) => ({
  errors: [],
  suites: [
    {
      title: 'a.spec.ts',
      specs: tests.map(({ project, line }) => ({
        title: `t${line}`,
        file: 'a.spec.ts',
        line,
        column: 1,
        tests: [{ projectName: project, results }],
      })),
    },
  ],
});
const listReport = () => report(LISTED, []);
/** What `--shard=i/n` runs: every listed test whose index is i - 1 modulo n, once. */
const shardReport = (i: number, n: number) =>
  report(
    LISTED.filter((_, k) => k % n === i - 1),
    [{}],
  );

/**
 * One matrix run of e2e-shard with Docker answering (so no PostgreSQL install) and Playwright
 * faked: `npm run test:e2e` writes the JSON report of its `--shard=i/n` slice to
 * PLAYWRIGHT_JSON_OUTPUT_NAME only when the json reporter is named, leaves the failure output in
 * test-results and playwright-report, and refuses to run with the HTML report served.
 */
function runShard(shard: number, testsFail: boolean, artifacts: Artifacts) {
  const sh = newShell();
  const n = shardCount();
  const reports = path.join(sh.tmp, 'reports');
  mkdirSync(reports);
  for (let i = 1; i <= n; i += 1) {
    writeFileSync(path.join(reports, `${i}-of-${n}.json`), JSON.stringify(shardReport(i, n)));
  }
  sh.fake('docker');
  sh.fake('npx');
  sh.fake(
    'npm',
    [
      'set -e',
      `[ "$1 $2" = 'run test:e2e' ] || exit 0`,
      `[ "$PLAYWRIGHT_HTML_OPEN" = never ] || exit 3`,
      'for arg; do case $arg in --shard=*) shard=${arg#--shard=};; --reporter=*) reporters=,${arg#--reporter=},;; esac; done',
      'mkdir -p test-results playwright-report',
      'case $reporters in *,json,*)',
      '  mkdir -p "$(dirname "$PLAYWRIGHT_JSON_OUTPUT_NAME")"',
      `  cp '${reports}/'"\${shard/\\//-of-}.json" "$PLAYWRIGHT_JSON_OUTPUT_NAME";;`,
      'esac',
      `exit ${testsFail ? 1 : 0}`,
    ].join('\n'),
  );
  return { ...runJob('e2e-shard', sh, { 'matrix.shard': String(shard) }, artifacts), sh };
}

/** Every shard of the matrix, sharing one artifact store as a workflow run does. */
function runShards(testsFail = false) {
  const artifacts: Artifacts = {};
  const runs = (shardJob().strategy.matrix.shard as number[]).map((shard) =>
    runShard(shard, testsFail, artifacts),
  );
  return { artifacts, runs };
}

/** The e2e job after the shards, with `playwright test --list` faked to write the given list. */
function runE2e(artifacts: Artifacts, result = 'success') {
  const sh = newShell();
  const list = path.join(sh.tmp, 'list.json');
  writeFileSync(list, JSON.stringify(listReport()));
  sh.fake('npm');
  sh.fake(
    'npx',
    [
      `case " $* " in *' --list '*) ;; *) exit 0;; esac`,
      `case " $* " in *' --reporter=json '*) cp '${list}' "$PLAYWRIGHT_JSON_OUTPUT_NAME";; esac`,
    ].join('\n'),
  );
  return { ...runJob('e2e', sh, { 'needs.e2e-shard.result': result }, artifacts), sh };
}

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

  it('each run their own slice of one total, which is the matrix length, with a JSON report', () => {
    const n = shardCount();
    const { runs } = runShards();
    runs.forEach(({ passed, sh }, k) => {
      expect(passed).toBe(true);
      expect(sh.calls('npm')).toEqual([
        ['ci'],
        ['run', 'test:e2e', '--', `--shard=${k + 1}/${n}`, '--reporter=list,html,json'],
      ]);
    });
  });

  it('keep every setup step the one job had', () => {
    const job = shardJob();
    usesAction(job, 'actions/checkout');
    expect(usesAction(job, 'actions/setup-java').with['java-version']).toBe('21');
    expect(usesAction(job, 'actions/setup-node').with.cache).toBe('npm');
    const { sh } = runShards().runs[0];
    expect(sh.calls('docker')).toHaveLength(1);
    expect(sh.calls('npx')).toEqual([
      ['playwright', 'install', '--with-deps', 'chromium', 'webkit'],
    ]);
  });

  /**
   * The PostgreSQL step on a runner where Docker answers or not and initdb is present or not: bash
   * reads BASH_ENV, which turns off its own `[` so the faked one decides the initdb check, and
   * sudo records what it is asked to run and what tee is given.
   */
  const installPostgres = (docker: boolean, initdb: boolean) => {
    const sh = newShell();
    const env = path.join(sh.tmp, 'bash-env');
    const teed = path.join(sh.tmp, 'teed');
    writeFileSync(env, 'enable -n [\n');
    sh.fake('docker', `exit ${docker ? 0 : 1}`);
    sh.fake(
      '[',
      [
        `case "$*" in '! -x /usr/lib/postgresql/16/bin/initdb ]') exit ${initdb ? 1 : 0};; esac`,
        'exec /usr/bin/[ "$@"',
      ].join('\n'),
    );
    sh.fake('sudo', `case $1 in tee) cat >> '${teed}';; esac`);
    const result = sh.run(named(shardJob(), PG).run, { BASH_ENV: env });
    expect(result.status).toBe(0);
    return { sudo: sh.calls('sudo'), teed: existsSync(teed) ? readFileSync(teed, 'utf8') : '' };
  };

  it('install PostgreSQL 16 only when no Docker daemon answers and initdb is missing', () => {
    expect(installPostgres(false, false)).toEqual({
      sudo: [
        ['mkdir', '-p', '/etc/postgresql-common'],
        ['tee', '/etc/postgresql-common/createcluster.conf'],
        ['apt-get', 'update', '-q'],
        [
          'DEBIAN_FRONTEND=noninteractive',
          'apt-get',
          'install',
          '-y',
          '-q',
          '--no-install-recommends',
          '-o',
          'Dpkg::Options::=--force-confold',
          'postgresql-16',
        ],
      ],
      teed: 'create_main_cluster = false\n',
    });
    for (const [docker, initdb] of [
      [true, false],
      [false, true],
      [true, true],
    ]) {
      expect(installPostgres(docker, initdb)).toEqual({ sudo: [], teed: '' });
    }
  });

  it('upload each JSON report, whatever the outcome', () => {
    const n = shardCount();
    for (const testsFail of [false, true]) {
      const { artifacts, runs } = runShards(testsFail);
      for (let i = 1; i <= n; i += 1) {
        expect(runs[i - 1].passed).toBe(!testsFail);
        const files = artifacts[`e2e-report-${i}`];
        expect(files).toHaveLength(1);
        expect(JSON.parse(readFileSync(files[0], 'utf8'))).toEqual(shardReport(i, n));
      }
    }
    const upload = (shardJob().steps as Data[]).filter(
      (s) => String(s.uses ?? '').startsWith('actions/upload-artifact@') && s.if === 'always()',
    );
    expect(upload).toHaveLength(1);
    expect(upload[0].with['if-no-files-found']).toBe('error');
  });

  it('keep the failure artifacts, one per shard so the names do not collide', () => {
    const n = shardCount();
    const passing = runShards(false).artifacts;
    const failing = runShards(true).artifacts;
    for (let i = 1; i <= n; i += 1) {
      expect(passing).not.toHaveProperty(`web-e2e-results-${i}`);
      expect(failing[`web-e2e-results-${i}`].map((f) => path.basename(f))).toEqual([
        'test-results',
        'playwright-report',
      ]);
    }
  });
});

describe('the e2e job', () => {
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

  it('passes when both shards succeed, listing every test and finding each ran once', () => {
    const { passed, ran, output, sh } = runE2e(runShards().artifacts);
    expect(output).toContain(
      `${LISTED.length} tests ran exactly once across ${shardCount()} shards.`,
    );
    expect(passed).toBe(true);
    for (const command of [
      'Require both e2e shards',
      'npm ci',
      'List every browser test',
      'Require every test to have run exactly once',
    ]) {
      expect(ran).toContain(command);
    }
    expect(sh.calls('npx')).toEqual([['playwright', 'test', '--list', '--reporter=json']]);
  });

  it.each(['failure', 'cancelled', 'skipped'])(
    'fails without the guard when a shard is %s',
    (r) => {
      const { passed, ran, sh } = runE2e(runShards().artifacts, r);
      expect(passed).toBe(false);
      expect(ran).not.toContain('List every browser test');
      expect(ran).not.toContain('Require every test to have run exactly once');
      expect(sh.calls('npx')).toEqual([]);
    },
  );

  describe('the guard step, run for real on the shard reports', () => {
    const overwrite = (artifacts: Artifacts, shard: number, content: unknown) =>
      writeFileSync(artifacts[`e2e-report-${shard}`][0], JSON.stringify(content));

    it('fails when a listed test ran in no shard', () => {
      const { artifacts } = runShards();
      overwrite(artifacts, 2, { errors: [], suites: [] });
      const { passed, output } = runE2e(artifacts);
      expect(passed).toBe(false);
      expect(output).toContain('ran in no shard: chromium | a.spec.ts:2:1');
    });

    it('fails when a test ran in both shards', () => {
      const { artifacts } = runShards();
      overwrite(artifacts, 2, shardReport(1, shardCount()));
      const { passed, output } = runE2e(artifacts);
      expect(passed).toBe(false);
      expect(output).toContain('ran in shard 1 and shard 2: chromium | a.spec.ts:1:1');
    });

    it('fails when a shard report is missing', () => {
      const { artifacts } = runShards();
      delete artifacts[`e2e-report-${shardCount()}`];
      const { passed, output } = runE2e(artifacts);
      expect(passed).toBe(false);
      expect(output).toContain(`expected ${shardCount()} shard reports, found ${shardCount() - 1}`);
    });
  });
});

describe('the e2e reports directory', () => {
  it('is ignored by git, so a local run leaves the tree clean', () => {
    const ignored = spawnSync('git', ['check-ignore', '-q', 'web/e2e-reports/shard-1.json'], {
      cwd: ROOT,
    });
    expect(ignored.status).toBe(0);
  });
});
