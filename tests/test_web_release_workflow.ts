// Guards for the rebuilt app's test release path (.github/workflows/web-release.yml), run by vitest
// in the required node CI job. Ported from the release half of tests/test_web_release_workflow.py
// (the image half is tests/test_web_images.ts). Each test names a property the release relies on:
// keyless sign-in as the right test account, pinned actions, no live or legacy target, migrations
// in the Cloud Run job inside Google (never a database connection from the runner), staging at 0%
// before any traffic moves, and rollback only after a move.
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  actionSteps,
  allSteps,
  commands,
  evaluate,
  isOperator,
  isPinnedUses,
  load,
  RELEASE,
  Shell,
  shlex,
  step,
  steps,
  truthy,
  WEB,
  type Data,
} from './workflow_support.ts';

const release: Data = load(RELEASE);
const jobs = release.jobs;
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

function workflowRun(changes: Record<string, unknown> = {}): Data {
  const run = {
    conclusion: 'success',
    event: 'push',
    head_branch: 'master',
    head_repository: { full_name: 'owner/repo' },
  };
  return {
    github: {
      event_name: 'workflow_run',
      ref: 'refs/heads/master',
      repository: 'owner/repo',
      event: { workflow_run: { ...run, ...changes } },
    },
  };
}

const dispatch = (ref: string): Data => ({
  github: { event_name: 'workflow_dispatch', ref, repository: 'owner/repo' },
});

/** Every value as Python's str() would print it, for the forbidden-target scan. */
const text = (value: unknown) =>
  value === null ? 'None' : typeof value === 'boolean' ? (value ? 'True' : 'False') : String(value);

describe('triggers and gate', () => {
  it('runs only after Web app passes on master', () => {
    expect(Object.keys(release.on).sort()).toEqual(['workflow_dispatch', 'workflow_run']);
    expect(release.on.workflow_run).toEqual({
      workflows: ['Web app'],
      types: ['completed'],
      branches: ['master'],
    });
    expect(release.env.COMMIT).toBe('${{ github.event.workflow_run.head_sha || github.sha }}');
  });

  it.each([
    ['a passing master push', workflowRun(), true],
    ['a manual master run', dispatch('refs/heads/master'), true],
    ['a failed run', workflowRun({ conclusion: 'failure' }), false],
    ['a cancelled run', workflowRun({ conclusion: 'cancelled' }), false],
    ['a pull request run', workflowRun({ event: 'pull_request' }), false],
    ['a manual Web app run', workflowRun({ event: 'workflow_dispatch' }), false],
    ['a scheduled run', workflowRun({ event: 'schedule' }), false],
    ['a run with no event', workflowRun({ event: null }), false],
    ['another branch', workflowRun({ head_branch: 'feature' }), false],
    ['a fork', workflowRun({ head_repository: { full_name: 'fork/repo' } }), false],
    ['a manual run elsewhere', dispatch('refs/heads/feature'), false],
    ['a push', { github: { event_name: 'push', ref: 'refs/heads/master' } }, false],
    ['a push carrying a run', { github: { ...workflowRun().github, event_name: 'push' } }, false],
  ])('the gate admits %s: %s', (_label, context, runs) => {
    expect(truthy(evaluate(jobs.gate.if, context))).toBe(runs);
  });

  it('runs one release at a time and never cancels one midway', () => {
    expect(release.concurrency).toEqual({ group: 'web-release-test', 'cancel-in-progress': false });
  });

  it.each([RELEASE, WEB])('%s pins every action to a full commit', (file) => {
    const uses = Object.values(load(file).jobs as Record<string, Data>)
      .flatMap((job) => actionSteps(job))
      .filter((s) => 'uses' in s)
      .map((s) => s.uses);
    expect(uses.length).toBeGreaterThan(0);
    for (const ref of uses) expect(isPinnedUses(ref), ref).toBe(true);
  });

  it.each([RELEASE, WEB])('%s gives every job a time limit', (file) => {
    for (const [name, job] of Object.entries(load(file).jobs as Record<string, Data>)) {
      expect(Number.isInteger(job['timeout-minutes']), name).toBe(true);
    }
  });

  it('holds least privilege, and only the test environment gets an identity token', () => {
    expect(release.permissions).toEqual({});
    for (const [name, job] of Object.entries(jobs as Record<string, Data>)) {
      const perms: Record<string, string> = job.permissions ?? {};
      // The record job alone may write contents (its tag and GitHub Release); TC-8.
      const allowed =
        name === 'record'
          ? ['contents=write', 'id-token=write']
          : ['contents=read', 'id-token=write'];
      for (const pair of Object.entries(perms)) {
        expect(allowed, name).toContain(pair.join('='));
      }
      if (perms['id-token'] === 'write') expect(job.environment, name).toBe('test');
    }
  });

  it('signs each job in keylessly as its own test account', () => {
    const accounts: Record<string, string> = {};
    for (const [name, job] of Object.entries(jobs as Record<string, Data>)) {
      for (const s of steps(job)) {
        if (String(s.uses ?? '').startsWith('google-github-actions/auth@')) {
          const given = s.with;
          expect(Object.keys(given).sort()).toEqual([
            'project_id',
            'service_account',
            'workload_identity_provider',
          ]);
          expect(given.workload_identity_provider).toBe('${{ vars.DRYSCOPE_TEST_WIF_PROVIDER }}');
          expect(given.project_id).toBe('dryscope');
          accounts[name] = given.service_account;
        }
      }
    }
    // The migrate job signs in as the deploy account too: it only sets the migration job's image
    // and runs it. The job itself runs as the migrator, inside Google.
    expect(accounts).toEqual({
      build: '${{ vars.DRYSCOPE_TEST_DEPLOY_SA }}',
      migrate: '${{ vars.DRYSCOPE_TEST_DEPLOY_SA }}',
      deploy: '${{ vars.DRYSCOPE_TEST_DEPLOY_SA }}',
      record: '${{ vars.DRYSCOPE_TEST_DEPLOY_SA }}',
    });
    for (const s of allSteps(release)) expect(s.with ?? {}).not.toHaveProperty('credentials_json');
  });

  it('reads the test variables in the gate, and later jobs wait for it', () => {
    expect(step(jobs.gate, 'vars').env).toEqual({
      PROVIDER: '${{ vars.DRYSCOPE_TEST_WIF_PROVIDER }}',
      DEPLOY_SA: '${{ vars.DRYSCOPE_TEST_DEPLOY_SA }}',
      MIGRATE_SA: '${{ vars.DRYSCOPE_TEST_MIGRATE_SA }}',
    });
    expect(jobs.build.if).toBe("needs.gate.outputs.ready == 'true'");
    // The web image is pushed on every ready run (the first app-root apply needs its digest); the
    // placeholder only until the deploy account can see the service.
    expect(step(jobs.build, 'image')).not.toHaveProperty('if');
    expect(step(jobs.build, 'placeholder').if).toBe("steps.service.outputs.ready != 'true'");
    for (const name of ['migrate', 'deploy']) {
      expect(jobs[name].if).toBe("needs.build.outputs.service_ready == 'true'");
    }
  });
});

const GOOD_VARS = {
  PROVIDER: GOOD_PROVIDER,
  DEPLOY_SA: 'dryscope-deploy-test@dryscope.iam.gserviceaccount.com',
  MIGRATE_SA: 'dryscope-migrate-test@dryscope.iam.gserviceaccount.com',
};

describe('the gate step', () => {
  it.each([[['PROVIDER', 'DEPLOY_SA', 'MIGRATE_SA']], [['PROVIDER']], [['MIGRATE_SA']]])(
    'skips while %j is unset',
    (unset) => {
      const sh = shell();
      const given = { ...GOOD_VARS, ...Object.fromEntries(unset.map((name) => [name, ''])) };
      const result = sh.run(step(jobs.gate, 'vars').run, given);
      expect(result.status, result.stderr).toBe(0);
      expect(sh.outputs()).toEqual({ ready: 'false' });
    },
  );

  it('is ready with the test variables', () => {
    const sh = shell();
    const result = sh.run(step(jobs.gate, 'vars').run, GOOD_VARS);
    expect(result.status, result.stderr).toBe(0);
    expect(sh.outputs()).toEqual({ ready: 'true' });
  });

  it.each([
    { PROVIDER: GOOD_PROVIDER.replace('dryscope-test', 'dryscope-live') },
    { PROVIDER: GOOD_PROVIDER.replace('570228742694', '123456789012') },
    { PROVIDER: GOOD_PROVIDER + '/../other' },
    { DEPLOY_SA: 'dryscope-deploy-live@dryscope.iam.gserviceaccount.com' },
    { DEPLOY_SA: 'dryscope-migrate-test@dryscope.iam.gserviceaccount.com' },
    { MIGRATE_SA: 'dryscope-migrate-live@dryscope.iam.gserviceaccount.com' },
    { MIGRATE_SA: 'adr-runtime@alert-disaster-field-2026.iam.gserviceaccount.com' },
  ])('fails on variables pointing anywhere but test: %j', (wrong) => {
    const sh = shell();
    const result = sh.run(step(jobs.gate, 'vars').run, { ...GOOD_VARS, ...wrong });
    expect(result.status).not.toBe(0);
    expect(sh.outputs().ready).not.toBe('true');
  });

  it.each([true, false])(
    'build skips until the deploy account sees the test service (visible: %s)',
    (visible) => {
      const sh = shell();
      sh.fake('gcloud', visible ? 'exit 0' : 'exit 1');
      const result = sh.run(step(jobs.build, 'service').run, release.env);
      expect(result.status, result.stderr).toBe(0);
      expect(sh.outputs()).toEqual({ ready: visible ? 'true' : 'false' });
      const calls = sh.calls('gcloud');
      expect(calls).toHaveLength(1);
      const [describeCall] = calls;
      expect(describeCall.slice(0, 4)).toEqual([
        'run',
        'services',
        'describe',
        'dryscope-api-test',
      ]);
      expect(describeCall).toEqual(
        expect.arrayContaining(['--region=us-central1', '--project=dryscope']),
      );
    },
  );
});

/**
 * Every gcloud invocation the workflow runs, as argument lists ending at the first shell operator
 * (pipe, ;, &&, ||, redirect or closing parenthesis).
 */
function gcloudCalls(workflow: Data): string[][] {
  const calls: string[][] = [];
  for (const s of allSteps(workflow)) {
    for (const line of commands(s).split('\n')) {
      const at = line.indexOf('gcloud ');
      if (at < 0) continue;
      const args: string[] = [];
      for (const token of shlex(line.slice(at + 'gcloud '.length), {
        punctuation: true,
        comments: true,
      })) {
        if (isOperator(token)) break;
        args.push(token);
      }
      calls.push(args);
    }
  }
  return calls;
}

const flag = (arg: string) => arg.split('=')[0];

describe('targets', () => {
  it('reaches only the test environment and never the legacy project', () => {
    // Every value the workflow passes on: step inputs and environments.
    const given: string[] = [];
    for (const s of allSteps(release)) {
      given.push(...Object.values(s.with ?? {}).map(text));
      given.push(...Object.values(s.env ?? {}).map(text));
    }
    for (const job of Object.values(jobs as Record<string, Data>)) {
      given.push(...Object.values(job.env ?? {}).map(text));
    }
    given.push(...Object.values(release.env).map(text));
    for (const value of given) {
      for (const forbidden of [
        'dryscope-live',
        '-live@',
        'alert-disaster',
        'us-west2',
        'firebase',
      ]) {
        expect(value.includes(forbidden), `${forbidden} in ${value.slice(0, 80)}`).toBe(false);
      }
    }
    // Every gcloud call reaches the test service or the test migration job through the workflow's
    // own settings.
    const calls = gcloudCalls(release);
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) {
      for (const [name, value] of [
        ['--project', '$PROJECT'],
        ['--region', '$REGION'],
      ]) {
        const values = args
          .filter((arg) => flag(arg) === name)
          .map((arg) => arg.slice(name.length + 1));
        expect([[], [value]], args.join(' ')).toContainEqual(values);
        if (args[0] === 'run') expect(values, args.join(' ')).toEqual([value]);
      }
      if (args[0] === 'run') {
        const target = args[1] === 'jobs' ? '$JOB' : '$SERVICE';
        expect(args.filter((arg) => !arg.startsWith('-')).at(-1), args.join(' ')).toBe(target);
      }
    }
    expect(release.env.PROJECT).toBe('dryscope');
    expect(release.env.REGION).toBe('us-central1');
    expect(release.env.SERVICE).toBe('dryscope-api-test');
    expect(release.env.JOB).toBe('dryscope-migrate-test');
    expect(release.env.IMAGE.startsWith('us-central1-docker.pkg.dev/dryscope/dryscope-test/')).toBe(
      true,
    );
  });

  it('deletes nothing and changes only the image', () => {
    const calls = gcloudCalls(release);
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) {
      for (const word of ['delete', 'remove-tags', 'clear-tags']) expect(args).not.toContain(word);
    }
    const one = (prefix: string[]) => {
      const found = calls.filter((args) => prefix.every((word, i) => args[i] === word));
      expect(found, prefix.join(' ')).toHaveLength(1);
      return found[0];
    };
    const deploy = one(['run', 'deploy']);
    expect(new Set(deploy.slice(3).map(flag))).toEqual(
      new Set(['--image', '--region', '--project', '--no-traffic', '--tag', '--quiet']),
    );
    expect(deploy).toContain('--tag=candidate');
    expect(deploy).toContain('--image=$IMAGE_REF');
    // The migration job: only its image changes, and an execution never overrides its command,
    // arguments, settings, task count or timeout.
    const update = one(['run', 'jobs', 'update']);
    expect(new Set(update.slice(4).map(flag))).toEqual(
      new Set(['--image', '--region', '--project', '--quiet']),
    );
    expect(update).toContain('--image=$IMAGE_REF');
    const execute = one(['run', 'jobs', 'execute']);
    expect(new Set(execute.slice(4).map(flag))).toEqual(
      new Set(['--region', '--project', '--wait', '--format']),
    );
    const jobCalls = new Set(
      calls.filter((args) => args[0] === 'run' && args[1] === 'jobs').map((args) => args[2]),
    );
    expect(jobCalls).toEqual(new Set(['update', 'describe', 'execute']));
  });
});

const SHELL_WORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'do',
  'done',
  'while',
  'until',
  '!',
  '{',
  '}',
]);
const DATABASE_SETTINGS = [
  'DATABASE_URL',
  'PGHOST',
  'PGPORT',
  'PGUSER',
  'PGPASSWORD',
  'PGDATABASE',
  'SQL_CONNECTION_NAME',
  'SQL_INSTANCE',
  'INSTANCE_CONNECTION_NAME',
];

/**
 * Each simple command a step runs, as its argument list: split at shell operators, with leading
 * shell keywords and variable assignments dropped, so args[0] is the program run.
 */
function invocations(s: Data): string[][] {
  const found: string[][] = [];
  for (const line of commands(s).split('\n')) {
    let args: string[] = [];
    for (const token of [...shlex(line, { punctuation: true, comments: true }), ';']) {
      if (isOperator(token)) {
        while (args.length && (SHELL_WORDS.has(args[0]) || /^\w+=\S*$/.test(args[0]))) {
          args.shift();
        }
        if (args.length) found.push(args);
        args = [];
      } else {
        args.push(token);
      }
    }
  }
  return found;
}

const IMAGE_REF = `us-central1-docker.pkg.dev/dryscope/dryscope-test/web@sha256:${'c'.repeat(64)}`;
const MIGRATOR = 'dryscope-migrate-test@dryscope.iam.gserviceaccount.com';

/** gcloud for the migrate job: `run jobs update`, `describe` and `execute` each run a body. */
function jobGcloud({
  update = 'exit 0',
  describe = `printf "%s\\t%s\\n" ${MIGRATOR} "$IMAGE_REF"`,
  execute = 'exit 0',
} = {}): string {
  return (
    'case "$3" in\n' +
    `  update) ${update} ;;\n` +
    `  describe) ${describe} ;;\n` +
    `  execute) ${execute} ;;\n` +
    '  *) exit 9 ;;\n' +
    'esac'
  );
}

const migrateEnv = () => ({ ...release.env, IMAGE_REF, MIGRATE_SA: MIGRATOR });

describe('migrations', () => {
  it('run in the job before the revision is staged', () => {
    expect(new Set(jobs.deploy.needs)).toEqual(new Set(['build', 'migrate']));
    const migrate = jobs.migrate;
    expect(migrate.needs).toBe('build');
    expect(migrate.env).toEqual({
      IMAGE_REF: '${{ needs.build.outputs.image }}',
      MIGRATE_SA: '${{ vars.DRYSCOPE_TEST_MIGRATE_SA }}',
    });
    const order = steps(migrate).map((s) => s.id || String(s.uses ?? '').split('@')[0]);
    expect(order.indexOf('ledger')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('ledger')).toBeLessThan(order.indexOf('job'));
    expect(order.indexOf('job')).toBeLessThan(order.indexOf('migrations'));
    for (const key of ['job', 'migrations']) {
      expect(step(migrate, key).if).toBe("steps.ledger.outputs.present == 'true'");
    }
    // The ledger check needs the migration files only.
    expect(steps(migrate)[0].with['sparse-checkout']).toBe('web/migrations');
  });

  it('never connect to the database from the runner', () => {
    // The release does not depend on this runner's network path to Cloud SQL: no step holds a
    // database connection setting, starts a proxy or database client, runs the migrator itself
    // or opens a TCP socket; the only database work is executing the Cloud Run job.
    const settings = new Set(Object.keys(release.env ?? {}));
    for (const job of Object.values(jobs as Record<string, Data>)) {
      for (const key of Object.keys(job.env ?? {})) settings.add(key);
      for (const s of steps(job)) for (const key of Object.keys(s.env ?? {})) settings.add(key);
    }
    for (const name of DATABASE_SETTINGS) expect(settings.has(name), name).toBe(false);
    const runs = Object.values(jobs as Record<string, Data>).flatMap((job) =>
      steps(job).flatMap((s) => invocations(s)),
    );
    expect(runs.length).toBeGreaterThan(0);
    for (const args of runs) {
      const label = args.join(' ');
      const program = path.posix.basename(args[0]);
      expect(['cloud-sql-proxy', 'psql', 'pg_isready'], label).not.toContain(program);
      const names = args.map((arg) => path.posix.basename(arg));
      expect(names, label).not.toContain('db:migrate');
      expect(names, label).not.toContain('migrate.mjs');
      expect(program === 'gcloud' && args.slice(1, 3).includes('sql'), label).toBe(false);
      expect(
        args.some((arg) => arg.startsWith('/dev/tcp/')),
        label,
      ).toBe(false);
    }
  });

  it('give the job the release image and check it before it runs', () => {
    const sh = shell();
    sh.fake('gcloud', jobGcloud());
    const result = sh.run(step(jobs.migrate, 'job').run, migrateEnv());
    expect(result.status, result.stderr).toBe(0);
    const calls = sh.calls('gcloud');
    expect(calls).toHaveLength(2);
    const [update, describeCall] = calls;
    expect(update.slice(0, 4)).toEqual(['run', 'jobs', 'update', 'dryscope-migrate-test']);
    expect(new Set(update.slice(4))).toEqual(
      new Set([`--image=${IMAGE_REF}`, '--region=us-central1', '--project=dryscope', '--quiet']),
    );
    expect(describeCall.slice(0, 4)).toEqual(['run', 'jobs', 'describe', 'dryscope-migrate-test']);
  });

  it('stop the release when the job cannot take the image', () => {
    const sh = shell();
    sh.fake('gcloud', jobGcloud({ update: 'exit 1' }));
    const result = sh.run(step(jobs.migrate, 'job').run, migrateEnv());
    expect(result.status).not.toBe(0);
    expect(sh.calls('gcloud').map((args) => args[2])).toEqual(['update']);
    expect(result.stdout).toContain('part D');
  });

  it.each([
    'printf "%s\\t%s\\n" dryscope-api-test@dryscope.iam.gserviceaccount.com "$IMAGE_REF"',
    'printf "%s\\t%s\\n" dryscope-migrate-live@dryscope.iam.gserviceaccount.com "$IMAGE_REF"',
    `printf "%s\\t%s\\n" ${MIGRATOR} other@sha256:${'d'.repeat(64)}`,
    'exit 0',
    'exit 1',
  ])('never run a job with another account or image: %s', (describe) => {
    const sh = shell();
    sh.fake('gcloud', jobGcloud({ describe }));
    const result = sh.run(step(jobs.migrate, 'job').run, migrateEnv());
    expect(result.status).not.toBe(0);
    expect(sh.calls('gcloud').map((args) => args[2])).not.toContain('execute');
  });

  it.each([true, false])('wait for the execution and fail with it (passes: %s)', (passes) => {
    const sh = shell();
    const body = passes ? 'echo dryscope-migrate-test-abc12' : 'echo failed >&2; exit 1';
    sh.fake('gcloud', jobGcloud({ execute: body }));
    const result = sh.run(step(jobs.migrate, 'migrations').run, migrateEnv());
    expect(result.status === 0).toBe(passes);
    const calls = sh.calls('gcloud');
    expect(calls).toHaveLength(1);
    const [execute] = calls;
    expect(execute.slice(0, 4)).toEqual(['run', 'jobs', 'execute', 'dryscope-migrate-test']);
    expect(new Set(execute.slice(4))).toEqual(
      new Set([
        '--region=us-central1',
        '--project=dryscope',
        '--wait',
        '--format=value(metadata.name)',
      ]),
    );
    if (passes) expect(readFileSync(sh.summary, 'utf8')).toContain('dryscope-migrate-test-abc12');
    else expect(result.stdout).toContain('before any traffic moved');
  });
});

describe('field-database rules', () => {
  const rules = () => step(jobs.deploy, 'rules');

  it('are released as the deploy account before the revision or traffic changes', () => {
    const order = steps(jobs.deploy).map((s) => s.id || s.uses || s.name);
    const at = (key: string) => order.findIndex((k: string) => k.startsWith(key));
    expect(at('rules')).toBeGreaterThan(at('google-github-actions/auth@'));
    expect(at('rules')).toBeGreaterThan(at('google-github-actions/setup-gcloud@'));
    expect(at('rules')).toBeLessThan(at('before'));
    expect(at('rules')).toBeLessThan(at('stage'));
    expect(rules().if ?? null).toBeNull();
    expect(rules().env ?? {}).toEqual({});
  });

  it('go to the test field database only, with the token on stdin', () => {
    const runs = invocations(rules());
    expect(runs).toContainEqual(['gcloud', 'auth', 'print-access-token']);
    expect(runs).toContainEqual([
      'node',
      'web/scripts/release-rules.ts',
      '--env',
      'test',
      '--file',
      'web/firestore.rules',
    ]);
    expect(runs.filter((args) => args[0] === 'node')).toHaveLength(1);
  });

  it.each([true, false])(
    'pass the token to the script and stop the release when it fails (passes: %s)',
    (passes) => {
      const sh = shell();
      sh.fake('gcloud', 'echo ya29.fake-token');
      sh.fake('node', `cat > "$HOME/stdin"; ${passes ? 'exit 0' : 'exit 1'}`);
      const result = sh.run(rules().run, release.env);
      expect(result.status === 0).toBe(passes);
      expect(readFileSync(path.join(sh.tmp, 'stdin'), 'utf8').trim()).toBe('ya29.fake-token');
      expect(sh.calls('gcloud')).toEqual([['auth', 'print-access-token']]);
      if (!passes) expect(result.stdout).toContain('traffic did not move');
    },
  );
});

describe('traffic', () => {
  it('smoke-checks before traffic moves and rolls back only after a move', () => {
    const deploy = steps(jobs.deploy);
    const order = deploy.map((s) => s.id || s.name);
    const at = (key: string) => {
      const index = order.indexOf(key);
      expect(index, key).toBeGreaterThanOrEqual(0);
      return index;
    };
    const stage = at('stage');
    const smoke = at('Smoke-check the staged revision');
    const promote = at('promote');
    const after = at('Smoke-check the service URL');
    const rollback = at('Roll back traffic');
    expect(at('before')).toBeLessThan(stage);
    expect(stage).toBeLessThan(smoke);
    expect(smoke).toBeLessThan(promote);
    expect(promote).toBeLessThan(after);
    expect(after).toBeLessThan(rollback);
    expect(deploy[smoke].env).toEqual({ CANDIDATE_URL: '${{ steps.stage.outputs.url }}' });
    expect(jobs.deploy.env.VERSION).toBe('${{ needs.build.outputs.version }}');
    expect(deploy[smoke].if ?? null).toBeNull();
    expect(deploy[promote].if ?? null).toBeNull();
    expect(deploy[rollback].env).toEqual({ PREVIOUS: '${{ steps.before.outputs.previous }}' });
    // The smoke script needs web/package.json ("type": "module") beside it.
    const checkout = deploy[0];
    expect(checkout.uses.startsWith('actions/checkout@')).toBe(true);
    expect(checkout.with['sparse-checkout']).toBe('web');
  });

  it.each([
    ['Smoke-check the staged revision', 'https://candidate---dryscope-api-test.run.app'],
    ['Smoke-check the service URL', 'https://dryscope-api-test.run.app'],
  ])('%s checks the commit and the release version at %s', (key, url) => {
    const sh = shell();
    sh.fake('gcloud', `echo ${url}`);
    sh.fake('node');
    const commit = 'a'.repeat(40);
    const result = sh.run(commands(step(jobs.deploy, key)), {
      ...release.env,
      CANDIDATE_URL: url,
      COMMIT: commit,
      VERSION: '2026.11.13-2',
      REVISION: 'dryscope-api-test-00012-abc',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(sh.calls('node')).toEqual([
      [
        'web/scripts/smoke-release.ts',
        '--url',
        url,
        '--commit',
        commit,
        '--version',
        '2026.11.13-2',
        '--env',
        'test',
      ],
    ]);
  });

  it.each([
    ['success', true, false, true],
    ['failure', true, false, true],
    ['cancelled', false, true, true],
    ['success', false, true, true],
    ['skipped', true, false, false],
    ['skipped', false, true, false],
    [null, true, false, false],
    ['success', false, false, false],
  ])(
    'rolls back only when a traffic move ran and the job did not pass (promote %s, failed %s, cancelled %s)',
    (promote, failed, cancelled, runs) => {
      const context = {
        steps: promote ? { promote: { outcome: promote } } : {},
        failure: () => failed,
        cancelled: () => cancelled,
      };
      const condition = step(jobs.deploy, 'Roll back traffic').if;
      expect(truthy(evaluate(condition, context))).toBe(runs);
    },
  );

  it('restores the remembered traffic split on rollback', () => {
    const sh = shell();
    const rollback = step(jobs.deploy, 'Roll back traffic');
    sh.fake('gcloud');
    const previous = 'dryscope-api-test-00007-abc=90,dryscope-api-test-00006-xyz=10';
    const result = sh.run(rollback.run, { ...release.env, PREVIOUS: previous });
    expect(result.status, result.stderr).toBe(0);
    const calls = sh.calls('gcloud');
    expect(calls).toHaveLength(1);
    const [move] = calls;
    expect(move.slice(0, 4)).toEqual(['run', 'services', 'update-traffic', 'dryscope-api-test']);
    expect(new Set(move.slice(4))).toEqual(
      new Set([
        `--to-revisions=${previous}`,
        '--region=us-central1',
        '--project=dryscope',
        '--quiet',
      ]),
    );
  });
});

// The release record (docs/plans/TC.md, TC-8): a tag, a GitHub Release with the manifest, and one
// Cloud Logging line for every failure past the gate.
const record = () => jobs.record;
const FAILURE_STEPS = [
  'google-github-actions/auth',
  'google-github-actions/setup-gcloud',
  'failed',
];
const SUCCESS = "needs.deploy.result == 'success'";

/** The record job's context: each earlier job's result, the gate's answer and the job's status. */
function recordContext(
  results: Record<string, string>,
  { ready = 'true', failed = false, cancelled = false } = {},
) {
  const needs: Data = { gate: { result: 'success', outputs: { ready } } };
  for (const name of ['build', 'migrate', 'deploy'])
    needs[name] = { result: results[name] ?? 'skipped' };
  return { needs, always: () => true, failure: () => failed, cancelled: () => cancelled };
}
const CREDENTIAL = '\u0000credential\u0000';
/** Whether any expression a step interpolates (its run, env or with) yields the token or a secret. */
function bindsCredential(s: Data): boolean {
  const secrets = new Proxy(
    {},
    {
      getOwnPropertyDescriptor: () => ({ value: CREDENTIAL, configurable: true, enumerable: true }),
      get: () => CREDENTIAL,
    },
  );
  const context = { github: { token: CREDENTIAL }, secrets };
  const values = [s.run, ...Object.values(s.env ?? {}), ...Object.values(s.with ?? {})];
  return values.some((value) =>
    [...String(value ?? '').matchAll(/\$\{\{(.*?)\}\}/gs)].some(
      ([, expression]) => evaluate(expression, context) === CREDENTIAL,
    ),
  );
}
const recordStep = (key: string) =>
  steps(record()).find((s: Data) => (s.id ?? s.name ?? String(s.uses ?? '').split('@')[0]) === key);

const FAILURE_PATHS: Record<string, string>[] = [
  { build: 'failure' },
  { build: 'cancelled' },
  { build: 'success', migrate: 'failure' },
  { build: 'success', migrate: 'cancelled' },
  { build: 'success', migrate: 'success', deploy: 'failure' },
  { build: 'success', migrate: 'skipped', deploy: 'failure' },
  { build: 'success', migrate: 'success', deploy: 'cancelled' },
];
const RELEASED = { build: 'success', migrate: 'success', deploy: 'success' };

describe('release record', () => {
  it('runs after deploy, with the version, image, revision and replaced traffic handed on', () => {
    expect(new Set(record().needs)).toEqual(new Set(['gate', 'build', 'migrate', 'deploy']));
    expect(release.jobs.build.outputs.version).toBe('${{ steps.version.outputs.version }}');
    expect(jobs.deploy.outputs).toEqual({
      revision: '${{ steps.stage.outputs.revision }}',
      previous: '${{ steps.before.outputs.previous }}',
      serving: '${{ steps.before.outputs.serving }}',
    });
    expect(record().env.VERSION).toBe('${{ needs.build.outputs.version }}');
    expect(recordStep('manifest').env).toEqual({
      IMAGE_REF: '${{ needs.build.outputs.image }}',
      REVISION: '${{ needs.deploy.outputs.revision }}',
      PREVIOUS: '${{ needs.deploy.outputs.previous }}',
      EARLIER: '${{ steps.earlier.outputs.manifest }}',
      FIRST: '${{ steps.earlier.outputs.first }}',
      EXISTING: '${{ steps.existing.outputs.state }}',
    });
  });

  it('is the only job that can write, and only its Release lookups, tag and Release steps hold the token', () => {
    const writers = Object.entries(jobs as Record<string, Data>)
      .filter(([, job]) =>
        Object.entries(job.permissions ?? {}).some(([k, v]) => k !== 'id-token' && v !== 'read'),
      )
      .map(([name]) => name);
    expect(writers).toEqual(['record']);
    expect(record().permissions).toEqual({ contents: 'write', 'id-token': 'write' });
    const holders = Object.values(jobs as Record<string, Data>)
      .flatMap((job) => steps(job))
      .filter((s) => bindsCredential(s))
      .map((s) => s.id);
    expect(holders).toEqual(['existing', 'earlier', 'tag', 'release']);
    for (const s of steps(record())) {
      if (String(s.uses ?? '').startsWith('actions/checkout@')) {
        expect(s.with['persist-credentials']).toBe(false);
      }
    }
  });

  it.each([
    [RELEASED, 'true', true],
    ...FAILURE_PATHS.map((r) => [r, 'true', true] as const),
    [{ build: 'success' }, 'true', false], // first images only: nothing released, nothing failed
    [{ build: 'failure' }, 'false', false], // the gate stopped it: before the gate
    [{}, '', false],
  ])('runs for %j with the gate ready %j: %s', (results, ready, runs) => {
    expect(truthy(evaluate(record().if, recordContext(results, { ready })))).toBe(runs);
  });

  it('pushes the tag only after the traffic move and the smoke checks passed', () => {
    const order = steps(record()).map((s: Data) => s.id ?? s.name ?? s.uses);
    expect(order.indexOf('manifest')).toBeLessThan(order.indexOf('tag'));
    expect(order.indexOf('tag')).toBeLessThan(order.indexOf('release'));
    for (const key of ['manifest', 'tag', 'release']) {
      // No status function, so a failed step above stops it as well.
      expect(recordStep(key).if, key).toBe(SUCCESS);
      for (const results of FAILURE_PATHS) {
        expect(truthy(evaluate(recordStep(key).if, recordContext(results))), key).toBe(false);
      }
    }
    // deploy succeeds only when the move and both smoke checks did: none of them can be skipped.
    for (const key of [
      'stage',
      'Smoke-check the staged revision',
      'promote',
      'Smoke-check the service URL',
    ]) {
      expect(step(jobs.deploy, key).if ?? null, key).toBeNull();
      expect(step(jobs.deploy, key)['continue-on-error'] ?? false, key).toBe(false);
    }
  });

  it.each([
    ...FAILURE_PATHS.map((r) => [r, false, false] as const),
    [RELEASED, true, false], // a record step itself failed
    [RELEASED, false, true], // the record job itself was cancelled
  ])(
    'writes the failure line on the failure path %j (record step failed: %s, record cancelled: %s)',
    (results, failed, cancelled) => {
      expect(truthy(evaluate(record().if, recordContext(results)))).toBe(true);
      for (const key of FAILURE_STEPS) {
        expect(
          truthy(evaluate(recordStep(key).if, recordContext(results, { failed, cancelled }))),
          key,
        ).toBe(true);
      }
    },
  );

  // The deploy job's before step, with fake gcloud and jq: is this release's image already serving?
  // The service template always names a newer revision on another image, so only the image of the
  // revision that holds the traffic can decide.
  const SERVING = 'dryscope-api-test-00012-abc';
  const OLDER = 'dryscope-api-test-00011-xyz';
  const OTHER_IMAGE = IMAGE_REF.replace('c'.repeat(64), 'd'.repeat(64));
  function beforeStep(traffic: string, images: Record<string, string>) {
    const sh = shell();
    const revisions = Object.entries(images)
      .map(([name, image]) => `${name}) echo '${image}' ;;`)
      .join(' ');
    sh.fake('jq', `cat > /dev/null; echo '${traffic}'`);
    sh.fake(
      'gcloud',
      `if [ "$2" = revisions ]; then case \${4#--filter=metadata.name=} in ${revisions} *) ;; esac; exit 0; fi
[ "$7" = --format=json ] && exit 0
printf '%s\\t%s\\n' '${OTHER_IMAGE}' dryscope-api-test-00013-new`,
    );
    const result = sh.run(step(jobs.deploy, 'before').run, { ...release.env, IMAGE_REF });
    return { sh, result };
  }
  const describeRevision = (name: string) => [
    'run',
    'revisions',
    'list',
    `--filter=metadata.name=${name}`,
    '--format=value(spec.containers[0].image)',
    `--region=${release.env.REGION}`,
    `--project=${release.env.PROJECT}`,
    '--service',
    release.env.SERVICE,
  ];

  it.each([
    ['a first run', `${SERVING}=100`, { [SERVING]: OTHER_IMAGE }, 'false'],
    [
      'a rerun after the move, a later release staged since',
      `${SERVING}=100`,
      { [SERVING]: IMAGE_REF },
      'true',
    ],
    [
      'a rerun after this release was staged but never took the traffic',
      `${OLDER}=100`,
      { [OLDER]: OTHER_IMAGE, [SERVING]: IMAGE_REF },
      'false',
    ],
  ])(
    'tells the record whether the release was already serving: %s',
    (_label, traffic, images, serving) => {
      const { sh, result } = beforeStep(traffic, images);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(sh.outputs()).toEqual({ previous: traffic, serving });
      const holder = traffic.split('=')[0]!;
      expect(sh.calls('gcloud').filter((args) => args[1] === 'revisions')).toEqual([
        describeRevision(holder),
      ]);
    },
  );

  it('never calls split traffic this release, without asking for any image', () => {
    const traffic = `${SERVING}=90,${OLDER}=10`;
    const { sh, result } = beforeStep(traffic, { [SERVING]: IMAGE_REF, [OLDER]: IMAGE_REF });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(sh.outputs()).toEqual({ previous: traffic, serving: 'false' });
    expect(sh.calls('gcloud').filter((args) => args[1] === 'revisions')).toEqual([]);
  });

  it('stops when the image of the serving revision cannot be read', () => {
    const { result, sh } = beforeStep(`${SERVING}=100`, {});
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(`Could not read the image of ${SERVING}`);
    expect(sh.outputs()).toEqual({});
  });

  it('writes no failure line after a clean release', () => {
    for (const key of FAILURE_STEPS) {
      expect(truthy(evaluate(recordStep(key).if, recordContext(RELEASED))), key).toBe(false);
    }
  });
});

describe('the ported helpers', () => {
  // Fixed answers from CPython's shlex and from the Python evaluators, so the port cannot drift.
  it.each([
    [
      'gcloud run deploy "$SERVICE" --image="$IMAGE_REF" --region="$REGION" | tee out',
      [
        'gcloud',
        'run',
        'deploy',
        '$SERVICE',
        '--image=$IMAGE_REF',
        '--region=$REGION',
        '|',
        'tee',
        'out',
      ],
    ],
    ['a \'b c\'d "e\\"f" g\\ h', ['a', 'b cd', 'e"f', 'g h']],
    [
      'x=1 cmd >>log 2>&1 && next # note',
      ['x=1', 'cmd', '>>', 'log', '2', '>&', '1', '&&', 'next'],
    ],
    ["echo '' ; ( sub )", ['echo', '', ';', '(', 'sub', ')']],
    ['"a\\nb" \'c\\d\'', ['a\\nb', 'c\\d']],
    [
      'if ! gcloud x;then echo "${a}"; fi',
      ['if', '!', 'gcloud', 'x', ';', 'then', 'echo', '${a}', ';', 'fi'],
    ],
  ])('tokenizes %s like shlex', (line, expected) => {
    expect(shlex(line, { punctuation: true, comments: true })).toEqual(expected);
  });

  it('splits like shlex.split, keeping # as text', () => {
    expect(shlex('node a.ts --url $X # not a comment')).toEqual([
      'node',
      'a.ts',
      '--url',
      '$X',
      '#',
      'not',
      'a',
      'comment',
    ]);
    expect(() => shlex("echo 'open")).toThrow('No closing quotation');
  });

  it('finds each simple command', () => {
    const s = {
      run: 'A=1 B=2 node x.js && if psql -c q; then echo ok | tee y; fi\n# psql comment',
    };
    expect(invocations(s)).toEqual([
      ['node', 'x.js'],
      ['psql', '-c', 'q'],
      ['echo', 'ok'],
      ['tee', 'y'],
    ]);
  });

  it('evaluates like Python, returning operands from && and ||', () => {
    expect(evaluate("a.b || 'x'", { a: { b: '' } })).toBe('x');
    expect(evaluate("a.b && 'x'", { a: {} })).toBeNull();
    expect(evaluate("!(a == 'Q')", { a: 'q' })).toBe(true);
    expect(evaluate("a == 'it''s'", { a: "it's" })).toBe(true);
    expect(() => evaluate('a ==', {})).toThrow();
  });
});
