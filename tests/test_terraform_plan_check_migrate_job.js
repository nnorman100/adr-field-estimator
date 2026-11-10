// Plan-check cases for the Cloud Run migration job (infra/dryscope/app/migrate_job.tf): the job
// itself, its dryscopeMigrateJob<Env> role, the deploy account's one grant on it, and the data
// root's grant letting the deploy account act as the migrator (Cloud Run requires it to set the
// job's image). Fixtures and the checker are the ones tests/test_terraform_plan_check.js uses.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'infra', 'dryscope', 'scripts', 'check-plan.js');
const { checkPlan, expectedPlan } = require(SCRIPT);

function load(root, environment) {
  const file = path.join(ROOT, 'infra', 'dryscope', 'fixtures', `${root}-${environment}.plan.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8')).resource_changes;
}

const find = (plan, address) => plan.find((rc) => rc.address === address);
const check = (plan, root, environment, options = {}) =>
  checkPlan(plan, { root, environment, ...options });

describe.each(['test', 'live'])('app root, %s: the migration job', (environment) => {
  const JOB = 'google_cloud_run_v2_job.migrate';
  const ROLE = 'google_project_iam_custom_role.migrate_job';
  const GRANT = 'google_cloud_run_v2_job_iam_member.deploy';
  const other = environment === 'test' ? 'live' : 'test';
  const plan = () => load('app', environment);
  const edit = (address, fn) => {
    const changed = plan();
    fn(find(changed, address).change.after);
    return check(changed, 'app', environment);
  };
  const task = (after) => after.template[0].template[0];
  const container = (after) => task(after).containers[0];

  test('the job, its role and its one grant are in the table', () => {
    const want = expectedPlan('app', environment);
    expect(want.others).toEqual(expect.arrayContaining([JOB, ROLE]));
    expect(want.grants[GRANT]).toMatchObject({
      member: `serviceAccount:dryscope-deploy-${environment}@dryscope.iam.gserviceaccount.com`,
      name: `dryscope-migrate-${environment}`,
    });
  });

  test.each([
    'run.jobs.delete',
    'run.jobs.create',
    'run.jobs.runWithOverrides',
    'run.executions.cancel',
    'run.executions.delete',
    'run.jobs.setIamPolicy',
  ])('the job role may not gain %s', (permission) => {
    const problems = edit(ROLE, (after) => {
      after.permissions = [...after.permissions, permission];
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(permission);
  });

  test('the job role is granted to the deploy account on this job only', () => {
    expect(
      edit(GRANT, (after) => {
        after.member = `serviceAccount:dryscope-api-${environment}@dryscope.iam.gserviceaccount.com`;
      }),
    ).toHaveLength(1);
    expect(
      edit(GRANT, (after) => {
        after.role = 'roles/run.developer';
      }),
    ).toHaveLength(1);
    expect(
      edit(GRANT, (after) => {
        after.name = `dryscope-api-${environment}`;
      }),
    ).toHaveLength(1);
  });

  test('a second grant on the job or a project-wide Cloud Run role is refused', () => {
    const changed = plan();
    changed.push({
      address: 'google_project_iam_member.deploy_run',
      type: 'google_project_iam_member',
      change: {
        actions: ['create'],
        after: {
          project: 'dryscope',
          role: 'roles/run.developer',
          member: `serviceAccount:dryscope-deploy-${environment}@dryscope.iam.gserviceaccount.com`,
        },
      },
    });
    const problems = check(changed, 'app', environment);
    expect(problems.some((p) => p.includes('not in the expected app inventory'))).toBe(true);
  });

  test('the job may run only as this environment’s migrator', () => {
    for (const account of [
      `dryscope-api-${environment}`,
      `dryscope-deploy-${environment}`,
      `dryscope-migrate-${other}`,
    ]) {
      const problems = edit(JOB, (after) => {
        task(after).service_account = `${account}@dryscope.iam.gserviceaccount.com`;
      });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('service_account');
    }
  });

  test('the job connects only to this environment’s instance', () => {
    const problems = edit(JOB, (after) => {
      task(after).volumes[0].cloud_sql_instance[0].instances = [
        `dryscope:us-central1:dryscope-${other}-pg`,
      ];
    });
    expect(problems).toHaveLength(1);
  });

  test('the job image must be a digest from this environment’s repository', () => {
    for (const image of [
      `us-central1-docker.pkg.dev/dryscope/dryscope-${other}/web@sha256:${'0'.repeat(64)}`,
      `us-central1-docker.pkg.dev/dryscope/dryscope-${environment}/web:latest`,
      `us-central1-docker.pkg.dev/alert-disaster-field-2026/dryscope-${environment}/web@sha256:${'0'.repeat(64)}`,
    ]) {
      expect(
        edit(JOB, (after) => {
          container(after).image = image;
        }),
      ).toHaveLength(1);
    }
  });

  test('the job starts only the bundled migrator, once, without retries', () => {
    expect(
      edit(JOB, (after) => {
        container(after).args = ['server.js'];
      }),
    ).toHaveLength(1);
    expect(
      edit(JOB, (after) => {
        task(after).max_retries = 3;
      }),
    ).toHaveLength(1);
    expect(
      edit(JOB, (after) => {
        after.template[0].task_count = 2;
      }),
    ).toHaveLength(1);
  });

  test('the job gets exactly the migrator’s settings and never a secret', () => {
    const secret = edit(JOB, (after) => {
      container(after).env.push({
        name: 'STRIPE_SECRET_KEY',
        value: null,
        value_source: [
          {
            secret_key_ref: [
              { secret: `dryscope-${environment}-stripe-secret-key`, version: 'latest' },
            ],
          },
        ],
      });
    });
    expect(secret).toHaveLength(1);
    expect(secret[0]).toContain('secret STRIPE_SECRET_KEY');
    const user = edit(JOB, (after) => {
      container(after).env = container(after).env.map((e) =>
        e.name === 'SQL_IAM_USER' ? { ...e, value: `dryscope-api-${environment}@dryscope.iam` } : e,
      );
    });
    expect(user).toHaveLength(1);
    const extra = edit(JOB, (after) => {
      container(after).env.push({
        name: 'DATABASE_URL',
        value: 'postgres://x@127.0.0.1/d',
        value_source: [],
      });
    });
    expect(extra).toHaveLength(1);
    const duplicate = edit(JOB, (after) => {
      container(after).env.push({ ...container(after).env[0] });
    });
    expect(duplicate).toHaveLength(1);
  });

  test('a job without deletion protection, or a second container, is refused', () => {
    expect(
      edit(JOB, (after) => {
        after.deletion_protection = false;
      }),
    ).toHaveLength(1);
    expect(
      edit(JOB, (after) => {
        task(after).containers.push({ ...container(after) });
      }),
    ).toHaveLength(1);
  });

  test('deleting or replacing the job is refused', () => {
    for (const actions of [['delete'], ['delete', 'create']]) {
      const changed = plan();
      find(changed, JOB).change.actions = actions;
      expect(check(changed, 'app', environment)).toEqual([
        `${JOB}: plan would delete or replace it (${actions.join(', ')})`,
      ]);
    }
  });
});

describe.each(['test', 'live'])('data root, %s: the deploy account acts as', (environment) => {
  const ACTS_AS = 'google_service_account_iam_member.deploy_acts_as';

  test('the two services’ accounts and the migrator, and no others', () => {
    const want = expectedPlan('data', environment);
    const keys = Object.keys(want.grants).filter((a) => a.startsWith(`${ACTS_AS}[`));
    expect(keys.sort()).toEqual([
      `${ACTS_AS}["api"]`,
      `${ACTS_AS}["live"]`,
      `${ACTS_AS}["migrate"]`,
    ]);
  });

  test('acting as the migrator of the other environment, or as the deploy account itself, is refused', () => {
    const other = environment === 'test' ? 'live' : 'test';
    for (const target of [`dryscope-migrate-${other}`, `dryscope-deploy-${environment}`]) {
      const changed = load('data', environment);
      find(changed, `${ACTS_AS}["migrate"]`).change.after.service_account_id =
        `projects/dryscope/serviceAccounts/${target}@dryscope.iam.gserviceaccount.com`;
      const problems = check(changed, 'data', environment);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('service_account_id');
    }
  });
});
