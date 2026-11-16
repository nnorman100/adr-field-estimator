// The Web app workflow (.github/workflows/web.yml) splits its jobs in two (docs/runbook/ci.md,
// "Fast pull requests, full suite after merge"). On every pull request, with no path filter:
// `company-isolation` and `check`, the required checks; `check` requires company-isolation to
// succeed. After merge (pushes to master): those two plus the full suite (database, emulators, e2e,
// image), and the release workflow ships a commit only when every job passed. Run by vitest in the
// node CI job.
import { describe, expect, it } from 'vitest';
import { commands, load, shlex, WEB, type Data } from './workflow_support.ts';

const WEB_PATHS = ['web/**', 'live-relay-placeholder/**', '.github/workflows/web.yml'];
// The full suite: skipped on pull requests, run on every push to master before any release.
const POST_MERGE = ['database', 'e2e', 'emulators', 'image'];
const POST_MERGE_IF = "github.event_name != 'pull_request'";

const web = (): Data => load(WEB);

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
    ).toEqual([...POST_MERGE].sort());
  });

  it('gives every job a time limit, the budget an agent brings it back under', () => {
    for (const [name, job] of Object.entries(web().jobs as Record<string, Data>)) {
      expect(job['timeout-minutes'], name).toBeGreaterThan(0);
    }
  });
});

// On a pull request: only the unit tests related to the change (vitest reruns everything when its
// config or package files change). After merge: every unit test.
const UNIT_RUN = [
  'if [ "$GITHUB_EVENT_NAME" = pull_request ]; then',
  '  npx vitest run --changed HEAD^1 --passWithNoTests',
  'else',
  '  npm test',
  'fi',
].join('\n');

describe('the check job', () => {
  const job = (): Data => web().jobs.check;
  const runs = (): string[] => (job().steps as Data[]).map((s) => String(s.run ?? '').trim());

  it('starts on every pull request beside company-isolation, not after it', () => {
    expect(job()).not.toHaveProperty('needs');
    expect(job()).not.toHaveProperty('if');
    for (const step of job().steps as Data[]) expect(step).not.toHaveProperty('if');
  });

  it('runs the full type check, lint and build', () => {
    for (const command of ['npm ci', 'npm run typecheck', 'npm run lint', 'npm run build']) {
      expect(runs()).toContain(command);
    }
  });

  it('runs the unit tests related to the change on a pull request, and all of them after merge', () => {
    const unit = (job().steps as Data[]).filter((s) => s.name === 'Unit tests');
    expect(unit).toHaveLength(1);
    expect(String(unit[0].run).trim()).toBe(UNIT_RUN);
    // The pull request merge commit's first parent is the base branch, so HEAD^1 must be fetched.
    const checkout = (job().steps as Data[])[0];
    expect(String(checkout.uses).startsWith('actions/checkout@')).toBe(true);
    expect(checkout.with['fetch-depth']).toBe(2);
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
