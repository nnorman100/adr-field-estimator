// The DryScope Terraform plan check: the full mocked plan of each root and environment must match
// the closed table of resources, IAM grants (role, member, exact condition) and protection
// settings, and any delete, replacement or extra grant must be refused.
//
// Fixtures in tests/fixtures/terraform/ are the first mocked plan that `terraform test -json
// -verbose` prints for each root and environment (infra/dryscope/scripts/check-plan.js export).
// infra/dryscope/scripts/check.sh runs the same check against freshly generated plans, so a
// fixture that drifts from the configuration is caught there.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'infra', 'dryscope', 'scripts', 'check-plan.js');
const { checkPlan } = require(SCRIPT);

const CASES = [
  ['data', 'test'],
  ['data', 'live'],
  ['app', 'test'],
  ['app', 'live'],
];

function load(root, environment) {
  const file = path.join(
    ROOT,
    'tests',
    'fixtures',
    'terraform',
    `${root}-${environment}.plan.json`,
  );
  return JSON.parse(fs.readFileSync(file, 'utf8')).resource_changes;
}

const find = (plan, address) => plan.find((rc) => rc.address === address);
const check = (plan, root, environment, options = {}) =>
  checkPlan(plan, { root, environment, ...options });

describe.each(CASES)('%s root, %s environment', (root, environment) => {
  const plan = () => load(root, environment);

  test('the mocked plan matches the table exactly', () => {
    expect(check(plan(), root, environment)).toEqual([]);
  });

  test('a second grant nobody listed is refused', () => {
    const changed = plan();
    changed.push({
      address: 'google_project_iam_member.review_extra',
      type: 'google_project_iam_member',
      change: {
        actions: ['create'],
        after: {
          role: 'roles/storage.admin',
          member: `serviceAccount:dryscope-api-${environment}@alert-disaster-field-2026.iam.gserviceaccount.com`,
        },
      },
    });
    expect(check(changed, root, environment)).toEqual([
      'google_project_iam_member.review_extra: not in the expected ' + root + ' inventory',
    ]);
  });

  test('a delete, a replacement and an in-place change are each refused', () => {
    for (const [actions, wording] of [
      [['delete'], 'delete or replace'],
      [['delete', 'create'], 'delete or replace'],
      [['create', 'delete'], 'delete or replace'],
      [['update'], 'in place'],
    ]) {
      const changed = plan();
      changed[0].change.actions = actions;
      const problems = check(changed, root, environment);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(changed[0].address);
      expect(problems[0]).toContain(wording);
    }
  });

  test('an in-place change is allowed only when the owner asks for it, a delete never', () => {
    const changed = plan();
    changed[0].change.actions = ['update'];
    expect(check(changed, root, environment, { allowUpdates: true })).toEqual([]);
    changed[0].change.actions = ['delete'];
    expect(check(changed, root, environment, { allowUpdates: true })).toHaveLength(1);
  });

  test('a resource missing from the full plan is refused', () => {
    const changed = plan().slice(1);
    const problems = check(changed, root, environment);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('expected in the plan but missing');
    expect(check(changed, root, environment, { complete: false })).toEqual([]);
  });

  test('the table for the other environment does not match', () => {
    const other = environment === 'test' ? 'live' : 'test';
    expect(check(plan(), root, other).length).toBeGreaterThan(0);
  });
});

describe.each(['test', 'live'])('data root, %s: grants and protection', (environment) => {
  const plan = () => load('data', environment);
  const edit = (address, fn) => {
    const changed = plan();
    fn(find(changed, address).change.after);
    return check(changed, 'data', environment);
  };

  test('a wider database condition is refused', () => {
    for (const address of [
      'google_project_iam_member.sql_client["api"]',
      'google_project_iam_member.firestore_user["live"]',
    ]) {
      const problems = edit(address, (after) => {
        after.condition[0].expression += ' || true';
      });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(address);
      expect(problems[0]).toContain('condition is');
    }
  });

  test('a dropped condition is refused', () => {
    const problems = edit('google_project_iam_member.sql_login["migrate"]', (after) => {
      after.condition = [];
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('condition is null');
  });

  test('another environment’s database in the condition is refused', () => {
    const other = environment === 'test' ? 'live' : 'test';
    const problems = edit('google_project_iam_member.firestore_user["api"]', (after) => {
      after.condition[0].expression = after.condition[0].expression.replace(
        `dryscope-field-${environment}`,
        `dryscope-field-${other}`,
      );
    });
    expect(problems).toHaveLength(1);
  });

  test('a grant to the wrong member or with a broader role is refused', () => {
    const wrongMember = edit('google_storage_bucket_iam_member.api_view', (after) => {
      after.member = 'allUsers';
    });
    expect(wrongMember).toHaveLength(1);
    const broader = edit('google_storage_bucket_iam_member.api_create', (after) => {
      after.role = 'roles/storage.admin';
    });
    expect(broader).toHaveLength(1);
    expect(broader[0]).toContain('roles/storage.admin');
  });

  test('the Gemini caller role may only predict', () => {
    const problems = edit('google_project_iam_custom_role.gemini_caller', (after) => {
      after.permissions = [...after.permissions, 'aiplatform.customJobs.create'];
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('permissions is');
    expect(problems[0]).toContain('aiplatform.customJobs.create');
  });

  test('a project-wide Vertex AI role in place of the custom role is refused', () => {
    const problems = edit('google_project_iam_member.gemini_caller["api"]', (after) => {
      after.role = 'roles/aiplatform.user';
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('roles/aiplatform.user');
  });

  test.each([
    ['google_sql_database_instance.main', 'deletion_protection', false],
    ['google_sql_database_instance.main', 'settings.0.deletion_protection_enabled', false],
    [
      'google_sql_database_instance.main',
      'settings.0.backup_configuration.0.point_in_time_recovery_enabled',
      false,
    ],
    ['google_firestore_database.field', 'delete_protection_state', 'DELETE_PROTECTION_DISABLED'],
    ['google_firestore_database.field', 'deletion_policy', 'DELETE'],
    ['google_storage_bucket.evidence', 'force_destroy', true],
    ['google_storage_bucket.evidence', 'public_access_prevention', 'inherited'],
    ['google_sql_database.app', 'deletion_policy', 'DELETE'],
  ])('%s with %s changed is refused', (address, field, value) => {
    const problems = edit(address, (after) => {
      const keys = field.split('.');
      const last = keys.pop();
      const target = keys.reduce((o, k) => o[k], after);
      target[last] = value;
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(address);
  });

  test('a deleting lifecycle rule or a shared-core tier is refused', () => {
    expect(
      edit('google_storage_bucket.evidence', (after) => {
        after.lifecycle_rule = [{ action: [{ type: 'Delete' }], condition: [{ age: 30 }] }];
      }),
    ).toHaveLength(1);
    expect(
      edit('google_sql_database_instance.main', (after) => {
        after.settings[0].tier = 'db-f1-micro';
      }),
    ).toHaveLength(1);
  });

  test('a pool-wide workload identity member is refused, a repository-scoped one passes', () => {
    const address = 'google_service_account_iam_member.deploy_workload_identity[0]';
    const withBinding = (member) => {
      const changed = plan();
      changed.push({
        address,
        type: 'google_service_account_iam_member',
        change: {
          actions: ['create'],
          after: {
            role: 'roles/iam.workloadIdentityUser',
            member,
            service_account_id: `projects/alert-disaster-field-2026/serviceAccounts/dryscope-deploy-${environment}@alert-disaster-field-2026.iam.gserviceaccount.com`,
          },
        },
      });
      return check(changed, 'data', environment);
    };
    const pool =
      'principalSet://iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/github';
    expect(withBinding(`${pool}/attribute.repository_id/42`)).toEqual([]);
    expect(withBinding(`${pool}/*`)).toHaveLength(1);
  });
});

describe.each(['test', 'live'])('app root, %s: services and deploy role', (environment) => {
  const plan = () => load('app', environment);
  const edit = (address, fn) => {
    const changed = plan();
    fn(find(changed, address).change.after);
    return check(changed, 'app', environment);
  };

  test('the deploy role may not delete', () => {
    const problems = edit('google_project_iam_custom_role.deploy', (after) => {
      after.permissions = [...after.permissions, 'run.services.delete'];
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('run.services.delete');
  });

  test('a Cloud Run service without deletion protection is refused', () => {
    const problems = edit('google_cloud_run_v2_service.svc["api"]', (after) => {
      after.deletion_protection = false;
    });
    expect(problems).toHaveLength(1);
  });

  test('public access other than invocation is refused', () => {
    expect(
      edit('google_cloud_run_v2_service_iam_member.public["api"]', (after) => {
        after.role = 'roles/run.admin';
      }),
    ).toHaveLength(1);
    expect(
      edit('google_cloud_run_v2_service_iam_member.public["live"]', (after) => {
        after.member = 'allAuthenticatedUsers';
      }),
    ).toHaveLength(1);
  });

  test('the health probe exists in live only', () => {
    const changed = plan();
    const probe = {
      address: 'google_monitoring_uptime_check_config.api_health[0]',
      type: 'google_monitoring_uptime_check_config',
      change: { actions: ['create'], after: {} },
    };
    const problems = check([...changed, probe], 'app', environment);
    expect(problems.length).toBe(environment === 'live' ? 0 : 1);
  });
});

describe('the command line', () => {
  const run = (...args) => spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });

  test('passes a good plan and prints the count', () => {
    const file = path.join(ROOT, 'tests', 'fixtures', 'terraform', 'data-live.plan.json');
    const result = run('data', 'live', file);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('data/live: 1 plan(s) checked, 0 problem(s)');
  });

  test('fails a plan with a delete and names the resource', () => {
    const plan = load('data', 'live');
    find(plan, 'google_storage_bucket.evidence').change.actions = ['delete', 'create'];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-plan-'));
    const file = path.join(dir, 'plan.json');
    fs.writeFileSync(file, JSON.stringify({ resource_changes: plan }));
    const result = run('data', 'live', file);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('google_storage_bucket.evidence');
    expect(result.stderr).toContain('delete or replace');
  });

  test('reads the line stream terraform test prints and checks every plan in it', () => {
    const good = load('app', 'test');
    const bad = load('app', 'test');
    find(bad, 'google_cloud_run_v2_service.svc["live"]').change.after.deletion_protection = false;
    const stream = [good, bad]
      .map((resource_changes) =>
        JSON.stringify({ '@type': 'test_plan', test_plan: { resource_changes } }),
      )
      .join('\n');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-stream-'));
    const file = path.join(dir, 'stream.ndjson');
    fs.writeFileSync(file, stream);
    const result = run('app', 'test', file);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('plan 2:');
    expect(result.stderr).not.toContain('plan 1:');
  });

  test('refuses unknown arguments with a usage message', () => {
    const result = run('web', 'live', 'x.json');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage:');
  });

  test('export keeps resources and blanks the alert address', () => {
    const plan = load('app', 'live');
    const channel = find(plan, 'google_monitoring_notification_channel.email');
    channel.change.after.labels = { email_address: 'someone@example.invalid' };
    const stream = JSON.stringify({
      '@type': 'test_plan',
      test_plan: {
        resource_changes: plan.map((rc) => ({ ...rc, change: { ...rc.change, before: null } })),
      },
    });
    const output = execFileSync('node', [SCRIPT, 'export', '-'], {
      input: stream,
      encoding: 'utf8',
    });
    expect(output).not.toContain('someone@example.invalid');
    expect(JSON.parse(output).resource_changes).toHaveLength(plan.length);
  });
});
