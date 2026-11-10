const finished = (name, status) =>
  JSON.stringify({
    '@type': 'test_run',
    test_run: { path: 'guards/guards.tftest.hcl', run: name, progress: 'complete', status },
  });
// The DryScope Terraform plan check: the full mocked plan of each root and environment must match
// the closed table of resources, IAM grants (role, member, exact condition) and protection
// settings, and any delete, replacement or extra grant must be refused.
//
// Fixtures in infra/dryscope/fixtures/ are the first mocked plan that `terraform test -json
// -verbose` prints for each root and environment (infra/dryscope/scripts/check-plan.js export).
// The legacy alert-disaster-field-2026 plans in tests/fixtures/terraform/ are kept to prove the
// checker refuses plans targeting the legacy project.
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
const { checkPlan, expectedPlan } = require(SCRIPT);
const GUARDS = path.join(ROOT, 'infra', 'dryscope', 'scripts', 'check-guards.js');
const { checkGuards, PROTECTED, REQUIRED_RUNS } = require(GUARDS);

const CASES = [
  ['data', 'test'],
  ['data', 'live'],
  ['app', 'test'],
  ['app', 'live'],
];

function load(root, environment) {
  const file = path.join(ROOT, 'infra', 'dryscope', 'fixtures', `${root}-${environment}.plan.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8')).resource_changes;
}

function loadLegacy(root, environment) {
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

  test('a plan targeting the legacy alert-disaster-field-2026 project is refused', () => {
    const problems = check(loadLegacy(root, environment), root, environment);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((p) => p.includes('expected dryscope'))).toBe(true);
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
          member: `serviceAccount:dryscope-api-${environment}@dryscope.iam.gserviceaccount.com`,
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

  test('a resource missing from the full plan is refused', () => {
    const changed = plan().slice(1);
    const problems = check(changed, root, environment);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('expected in the plan but missing');
    expect(check(changed, root, environment, { complete: false })).toEqual([]);
  });

  test('a listed resource in another project is refused', () => {
    const changed = plan();
    const target = changed.find((rc) => rc.change.after.project);
    target.change.after.project = 'mitigation-project';
    const problems = check(changed, root, environment);
    expect(problems).toEqual([
      `${target.address}: project is "mitigation-project", expected dryscope`,
    ]);
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
      'google_project_iam_member.firestore_user["api"]',
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
      after.condition[0].expression = after.condition[0].expression.replaceAll(
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

  test('full resource paths for bucket, secret and repository pass only for the expected name', () => {
    const fullPaths = {
      'google_storage_bucket_iam_member.api_create': [
        'bucket',
        `b/dryscope-evidence-${environment}`,
      ],
      'google_secret_manager_secret_iam_member.accessor["link-signing-key/api"]': [
        'secret_id',
        `projects/dryscope/secrets/dryscope-${environment}-link-signing-key`,
      ],
      'google_artifact_registry_repository_iam_member.deploy_write': [
        'repository',
        `projects/dryscope/locations/us-central1/repositories/dryscope-${environment}`,
      ],
    };
    for (const [address, [field, full]] of Object.entries(fullPaths)) {
      expect(
        edit(address, (after) => {
          after[field] = full;
        }),
      ).toEqual([]);
      const refused = [
        full.replace('dryscope', 'other-project'),
        full.replace(`-${environment}`, `-${environment === 'test' ? 'live' : 'test'}`),
        full.replace('us-central1', 'us-west2'),
        `${full}-extra`,
        `x/${full}`,
      ].filter((wrong) => wrong !== full);
      for (const wrong of refused) {
        const problems = edit(address, (after) => {
          after[field] = wrong;
        });
        expect(problems, `${address} ${wrong}`).toHaveLength(1);
        expect(problems[0]).toContain(`${field} is`);
      }
    }
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

  test('a deleting lifecycle rule or the wrong Cloud SQL tier for the environment is refused', () => {
    expect(
      edit('google_storage_bucket.evidence', (after) => {
        after.lifecycle_rule = [{ action: [{ type: 'Delete' }], condition: [{ age: 30 }] }];
      }),
    ).toHaveLength(1);
    expect(
      edit('google_sql_database_instance.main', (after) => {
        after.settings[0].tier = environment === 'test' ? 'db-custom-1-3840' : 'db-f1-micro';
      }),
    ).toHaveLength(1);
    expect(
      edit('google_sql_database_instance.main', (after) => {
        after.settings[0].tier = 'db-g1-small';
      }),
    ).toHaveLength(1);
  });

  test.each([
    ['google_sql_user.iam["api"]', 'instance'],
    ['google_sql_user.iam["migrate"]', 'name'],
    ['google_sql_database.app', 'instance'],
    ['google_service_account.runtime["live"]', 'account_id'],
    ['google_service_account.deploy', 'account_id'],
    ['google_secret_manager_secret.app["stripe-secret-key"]', 'secret_id'],
  ])('%s pointed at the other environment by %s is refused', (address, field) => {
    const other = environment === 'test' ? 'live' : 'test';
    const problems = edit(address, (after) => {
      after[field] = after[field].replace(`-${environment}`, `-${other}`);
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`${address}: ${field} is`);
  });

  test('an API entry enabling another service is refused', () => {
    const address = 'google_project_service.apis["iam.googleapis.com"]';
    const problems = edit(address, (after) => {
      after.service = 'compute.googleapis.com';
    });
    expect(problems).toEqual([
      `${address}: service is "compute.googleapis.com", expected iam.googleapis.com`,
    ]);
  });

  test('a secret replicated outside the region or to a second location is refused', () => {
    const address = 'google_secret_manager_secret.app["link-signing-key"]';
    const replicas = (after) => after.replication[0].user_managed[0].replicas;
    expect(
      edit(address, (after) => {
        replicas(after)[0].location = 'us-west2';
      }),
    ).toHaveLength(1);
    expect(
      edit(address, (after) => {
        replicas(after).push({ customer_managed_encryption: [], location: 'us-east1' });
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
            service_account_id: `projects/dryscope/serviceAccounts/dryscope-deploy-${environment}@dryscope.iam.gserviceaccount.com`,
          },
        },
      });
      return check(changed, 'data', environment);
    };
    const pools =
      'principalSet://iam.googleapis.com/projects/1/locations/global/workloadIdentityPools';
    const pool = `${pools}/dryscope-${environment}`;
    expect(withBinding(`${pool}/attribute.repository_id/42`)).toEqual([]);
    expect(withBinding(`${pool}/attribute.repository/nnorman100/adr-field-estimator`)).toEqual([]);
    expect(withBinding(`${pool}/*`)).toHaveLength(1);
    expect(withBinding(`${pool}/attribute.repository_owner/nnorman100`)).toHaveLength(1);
  });

  test('the migrator may take the same scoped principal set, on its own account only', () => {
    const address = 'google_service_account_iam_member.migrate_workload_identity[0]';
    const pool = `principalSet://iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/dryscope-${environment}`;
    const withBinding = (account, member = `${pool}/attribute.repository_id/42`) => {
      const changed = plan();
      changed.push({
        address,
        type: 'google_service_account_iam_member',
        change: {
          actions: ['create'],
          after: {
            role: 'roles/iam.workloadIdentityUser',
            member,
            service_account_id: `projects/dryscope/serviceAccounts/dryscope-${account}-${environment}@dryscope.iam.gserviceaccount.com`,
          },
        },
      });
      return check(changed, 'data', environment);
    };
    expect(withBinding('migrate')).toEqual([]);
    expect(withBinding('api')).toHaveLength(1);
    expect(withBinding('migrate', `${pool}/*`)).toHaveLength(1);
  });

  test('a pool shared between environments or the other environment’s pool is refused', () => {
    const address = 'google_service_account_iam_member.deploy_workload_identity[0]';
    const other = environment === 'test' ? 'live' : 'test';
    const pools =
      'principalSet://iam.googleapis.com/projects/1/locations/global/workloadIdentityPools';
    for (const pool of ['github', `dryscope-${other}`]) {
      const changed = plan();
      changed.push({
        address,
        type: 'google_service_account_iam_member',
        change: {
          actions: ['create'],
          after: {
            role: 'roles/iam.workloadIdentityUser',
            member: `${pools}/${pool}/attribute.repository_id/42`,
            service_account_id: `projects/dryscope/serviceAccounts/dryscope-deploy-${environment}@dryscope.iam.gserviceaccount.com`,
          },
        },
      });
      const problems = check(changed, 'data', environment);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(`${address}: member is`);
    }
  });
});

// The Firestore grant's IAM condition, evaluated the way IAM would for the one expression shape
// the table allows. Any other shape throws, so a rewritten condition must update this too.
function firestoreConditionAllows(expression, resourceName) {
  const shape = /^resource\.name == '([^']+)' \|\| resource\.name\.startsWith\('([^']+)'\)$/;
  const match = shape.exec(expression);
  if (!match) throw new Error(`unexpected Firestore condition shape: ${expression}`);
  const [, exact, prefix] = match;
  return resourceName === exact || resourceName.startsWith(prefix);
}

describe.each(['test', 'live'])(
  'data root, %s: Live relay access and Firestore condition',
  (environment) => {
    const other = environment === 'test' ? 'live' : 'test';
    const database = (env) => `projects/dryscope/databases/dryscope-field-${env}`;
    const planned = () =>
      find(load('data', environment), 'google_project_iam_member.firestore_user["api"]').change
        .after.condition[0].expression;

    test('the planned condition allows the database and document operations in it', () => {
      const expression = planned();
      for (const name of [
        database(environment),
        `${database(environment)}/documents/companies/c1`,
        `${database(environment)}/documents/companies/c1/jobs/j1/rooms/r1`,
      ]) {
        expect(firestoreConditionAllows(expression, name), name).toBe(true);
      }
    });

    test('the planned condition refuses the other environment and sibling databases', () => {
      const expression = planned();
      for (const name of [
        database(other),
        `${database(other)}/documents/companies/c1`,
        `${database(environment)}2`,
        `${database(environment)}-restore/documents/companies/c1`,
        'projects/dryscope/databases/(default)',
        `projects/alert-disaster-field-2026/databases/dryscope-field-${environment}`,
      ]) {
        expect(firestoreConditionAllows(expression, name), name).toBe(false);
      }
    });

    test('the earlier exact-match condition would have refused a document operation', () => {
      const exact = `resource.name == '${database(environment)}'`;
      const name = `${database(environment)}/documents/companies/c1`;
      expect(name === database(environment)).toBe(false);
      expect(planned()).not.toBe(exact);
      expect(firestoreConditionAllows(planned(), name)).toBe(true);
    });

    test('the table gives the Live relay no SQL or Firestore grant', () => {
      const live = `serviceAccount:dryscope-live-${environment}@dryscope.iam.gserviceaccount.com`;
      const roles = Object.values(expectedPlan('data', environment).grants)
        .filter((g) => g.member === live)
        .map((g) => g.role);
      expect(roles).not.toContain('roles/cloudsql.client');
      expect(roles).not.toContain('roles/cloudsql.instanceUser');
      expect(roles).not.toContain('roles/datastore.user');
      const plan = load('data', environment);
      for (const address of [
        'google_project_iam_member.sql_client["live"]',
        'google_project_iam_member.sql_login["live"]',
        'google_project_iam_member.firestore_user["live"]',
      ]) {
        expect(find(plan, address)).toBeUndefined();
      }
    });

    test('re-creating a Live relay data grant is refused', () => {
      const changed = load('data', environment);
      const api = find(changed, 'google_project_iam_member.firestore_user["api"]');
      changed.push({
        address: 'google_project_iam_member.firestore_user["live"]',
        type: 'google_project_iam_member',
        change: {
          actions: ['create'],
          after: {
            ...api.change.after,
            member: `serviceAccount:dryscope-live-${environment}@dryscope.iam.gserviceaccount.com`,
          },
        },
      });
      expect(check(changed, 'data', environment)).toEqual([
        'google_project_iam_member.firestore_user["live"]: not in the expected data inventory',
      ]);
    });
  },
);

// Re-applying the data root to an environment the earlier table was applied to (test): the plan
// may only remove the Live relay's three data grants and replace the web app's Firestore grant
// to move it to the new condition. Everything else stays a no-op.
describe.each(['test', 'live'])(
  'data root, %s: re-apply over the earlier grants',
  (environment) => {
    const sa = (k) =>
      `serviceAccount:dryscope-${k}-${environment}@dryscope.iam.gserviceaccount.com`;
    const database = `projects/dryscope/databases/dryscope-field-${environment}`;
    const sqlCondition = `resource.type == 'sqladmin.googleapis.com/Instance' && resource.name == 'projects/dryscope/instances/dryscope-${environment}-pg'`;
    const oldFs = `resource.name == '${database}'`;
    const FS_API = 'google_project_iam_member.firestore_user["api"]';
    const removal = (address, role, member, expression) => ({
      address,
      type: 'google_project_iam_member',
      change: {
        actions: ['delete'],
        before: { project: 'dryscope', role, member, condition: [{ expression }] },
        after: null,
      },
    });
    const reapply = () => {
      const plan = load('data', environment).map((rc) => ({
        ...rc,
        change: { ...rc.change, actions: ['no-op'], before: rc.change.after },
      }));
      const fs = find(plan, FS_API);
      fs.change.actions = ['delete', 'create'];
      fs.change.before = { ...fs.change.after, condition: [{ expression: oldFs }] };
      plan.push(
        removal(
          'google_project_iam_member.sql_client["live"]',
          'roles/cloudsql.client',
          sa('live'),
          sqlCondition,
        ),
        removal(
          'google_project_iam_member.sql_login["live"]',
          'roles/cloudsql.instanceUser',
          sa('live'),
          sqlCondition,
        ),
        removal(
          'google_project_iam_member.firestore_user["live"]',
          'roles/datastore.user',
          sa('live'),
          oldFs,
        ),
      );
      return plan;
    };

    test('removing the Live relay grants and re-conditioning the web app grant passes', () => {
      expect(check(reapply(), 'data', environment)).toEqual([]);
    });

    test('the replacement order create-then-delete passes too', () => {
      const plan = reapply();
      find(plan, FS_API).change.actions = ['create', 'delete'];
      expect(check(plan, 'data', environment)).toEqual([]);
    });

    test('removing a retired address that holds a different grant is refused', () => {
      const plan = reapply();
      find(plan, 'google_project_iam_member.sql_client["live"]').change.before.member = sa('api');
      const problems = check(plan, 'data', environment);
      expect(problems.some((p) => p.includes('sql_client["live"]: plan would delete'))).toBe(true);
    });

    test('replacing a retired grant instead of removing it is refused', () => {
      const plan = reapply();
      const rc = find(plan, 'google_project_iam_member.firestore_user["live"]');
      rc.change.actions = ['delete', 'create'];
      rc.change.after = { ...rc.change.before, condition: [{ expression: oldFs }] };
      expect(check(plan, 'data', environment).length).toBeGreaterThan(0);
    });

    test('removing a current grant is refused', () => {
      const plan = reapply();
      const sql = find(plan, 'google_project_iam_member.sql_client["api"]');
      sql.change.actions = ['delete'];
      sql.change.after = null;
      const fs = find(plan, FS_API);
      fs.change.actions = ['delete'];
      fs.change.after = null;
      const problems = check(plan, 'data', environment);
      expect(problems).toContain(
        'google_project_iam_member.sql_client["api"]: plan would delete or replace it (delete)',
      );
      expect(problems).toContain(`${FS_API}: plan would delete or replace it (delete)`);
    });

    test('replacing the Firestore grant from any condition but the earlier one is refused', () => {
      const plan = reapply();
      find(plan, FS_API).change.before.condition = [{ expression: 'true' }];
      expect(check(plan, 'data', environment)).toEqual([
        `${FS_API}: plan would delete or replace it (delete, create)`,
      ]);
    });

    test('a replacement that changes the member or widens the new condition is refused', () => {
      const member = reapply();
      find(member, FS_API).change.before.member = sa('live');
      expect(check(member, 'data', environment)).toEqual([
        `${FS_API}: plan would delete or replace it (delete, create)`,
      ]);
      const wider = reapply();
      find(wider, FS_API).change.after.condition[0].expression += ' || true';
      const problems = check(wider, 'data', environment);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(`${FS_API}: condition is`);
    });

    test('replacing any other grant or resource is still refused', () => {
      for (const address of [
        'google_project_iam_member.sql_client["api"]',
        'google_storage_bucket.evidence',
        'google_firestore_database.field',
      ]) {
        const plan = reapply();
        find(plan, address).change.actions = ['delete', 'create'];
        expect(check(plan, 'data', environment)).toEqual([
          `${address}: plan would delete or replace it (delete, create)`,
        ]);
      }
    });

    test('the app root has no retired or re-conditioned grants', () => {
      const want = expectedPlan('app', environment);
      expect(want.retired).toEqual({});
      expect(want.reconditioned).toEqual({});
    });
  },
);

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
      change: { actions: ['create'], after: { project: 'dryscope' } },
    };
    const problems = check([...changed, probe], 'app', environment);
    expect(problems.length).toBe(environment === 'live' ? 0 : 1);
  });
});

describe('the command line', () => {
  const run = (...args) => spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });

  test('passes a good plan and prints the count', () => {
    const file = path.join(ROOT, 'infra', 'dryscope', 'fixtures', 'data-live.plan.json');
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

// The destroy-guard report: guards/guards.tftest.hcl applies a root against the mock provider and
// Terraform's teardown refuses every resource with lifecycle.prevent_destroy. The stream below is
// what `terraform test -json` prints for it.
describe.each(['data', 'app'])('destroy guards, %s root', (root) => {
  const refusal = (address) =>
    JSON.stringify({
      '@type': 'diagnostic',
      diagnostic: {
        severity: 'error',
        summary: 'Instance cannot be destroyed',
        detail: `Resource ${address} has lifecycle.prevent_destroy set, but the plan calls for this resource to be destroyed.`,
      },
    });
  const stream = (addresses, status = 'pass', runs = REQUIRED_RUNS[root]) => [
    ...runs.map((name) => finished(name, status)),
    ...addresses.map(refusal),
  ];

  test('a report with a refusal for every protected resource passes', () => {
    expect(checkGuards(stream(PROTECTED[root]), root)).toEqual([]);
  });

  test.each(PROTECTED[root])('a missing guard on %s is named and refused', (address) => {
    const rest = PROTECTED[root].filter((a) => a !== address);
    const problems = checkGuards(stream(rest), root);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(address);
    expect(problems[0]).toContain('did not refuse to destroy');
  });

  test('no guards at all is refused', () => {
    expect(checkGuards(stream([]), root)).toHaveLength(PROTECTED[root].length);
  });

  test('a mocked apply that failed proves nothing and is refused', () => {
    const problems = checkGuards(stream(PROTECTED[root], 'error'), root);
    expect(problems).toHaveLength(REQUIRED_RUNS[root].length);
    expect(problems[0]).toContain('did not pass');
  });

  test.each(REQUIRED_RUNS[root])('a report without a passing %s run is refused', (name) => {
    const runs = REQUIRED_RUNS[root].filter((r) => r !== name);
    const problems = checkGuards(stream(PROTECTED[root], 'pass', runs), root);
    expect(problems).toEqual([`run ${name} did not pass, so what it covers was not tested`]);
  });

  test('an unrelated error is reported, not mistaken for a guard', () => {
    const other = JSON.stringify({
      '@type': 'diagnostic',
      diagnostic: { severity: 'error', summary: 'No value for required variable', detail: 'x' },
    });
    const problems = checkGuards([...stream(PROTECTED[root]), other], root);
    expect(problems).toEqual(['unexpected error: No value for required variable']);
  });

  test('the command line exits 1 on a missing guard and 0 on a full report', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-guards-'));
    const write = (name, lines) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, lines.join('\n'));
      return file;
    };
    const full = spawnSync('node', [GUARDS, root, write('full.json', stream(PROTECTED[root]))], {
      encoding: 'utf8',
    });
    const short = spawnSync(
      'node',
      [GUARDS, root, write('short.json', stream(PROTECTED[root].slice(1)))],
      { encoding: 'utf8' },
    );
    fs.rmSync(dir, { recursive: true, force: true });
    expect(full.status).toBe(0);
    expect(full.stdout).toContain(
      `${root}: ${PROTECTED[root].length} destroy guard(s) checked, 0 problem(s)`,
    );
    expect(short.status).toBe(1);
    expect(short.stderr).toContain(PROTECTED[root][0]);
  });
});

// Terraform 1.17 prints no teardown refusal, so the check also reads the configuration itself.
describe.each(['data', 'app'])('destroy guards read from the configuration, %s root', (root) => {
  const { checkConfig, readGuards } = require(GUARDS);
  const real = path.join(ROOT, 'infra', 'dryscope', root);
  const copyWith = (edit) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-config-'));
    for (const f of fs.readdirSync(real).filter((n) => n.endsWith('.tf')))
      fs.writeFileSync(path.join(dir, f), edit(f, fs.readFileSync(path.join(real, f), 'utf8')));
    return dir;
  };

  test('the real configuration has every guard', () => {
    expect(checkConfig(real, root)).toEqual([]);
  });

  test.each([
    ['removed', (t) => t.replace(/^\s*prevent_destroy = true\n/gm, '')],
    ['false', (t) => t.replace(/prevent_destroy = true/g, 'prevent_destroy = false')],
    ['commented out', (t) => t.replace(/prevent_destroy = true/g, '# prevent_destroy = true')],
    ['in a string', (t) => t.replace(/prevent_destroy = true/g, 'x = "prevent_destroy = true"')],
  ])('a guard that is %s is named', (_name, edit) => {
    const dir = copyWith((_f, text) => edit(text));
    const problems = checkConfig(dir, root);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(problems).toHaveLength(PROTECTED[root].length);
    expect(problems[0]).toContain('missing or false');
  });

  test('removing the guard from one resource names only that resource', () => {
    const files = fs
      .readdirSync(real)
      .filter(
        (n) =>
          n.endsWith('.tf') &&
          fs.readFileSync(path.join(real, n), 'utf8').includes('prevent_destroy'),
      );
    const dir = copyWith((f, text) =>
      f === files[0] ? text.replace(/^\s*prevent_destroy = true\n/m, '') : text,
    );
    const problems = checkConfig(dir, root);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.length).toBeLessThan(PROTECTED[root].length + 1);
    expect(readGuards(real).size).toBeGreaterThan(0);
  });

  test('a guard in a nested block does not count', () => {
    const dir = copyWith((_f, text) =>
      text.replace(
        /lifecycle \{\n(\s*)prevent_destroy = true/g,
        'lifecycle {\n$1other { prevent_destroy = true }',
      ),
    );
    const problems = checkConfig(dir, root);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(problems).toHaveLength(PROTECTED[root].length);
  });

  test('a stream with no refusals passes with the configuration (Terraform 1.17) but not alone', () => {
    const { checkGuards } = require(GUARDS);
    const lines = REQUIRED_RUNS[root].map((name) => finished(name, 'pass'));
    expect(checkGuards(lines, root, { refusalsOptional: true })).toEqual([]);
    expect(checkGuards(lines, root)).toHaveLength(PROTECTED[root].length);
  });

  test('a partial set of refusals is still refused even when refusals are optional', () => {
    const { checkGuards } = require(GUARDS);
    const lines = [
      ...REQUIRED_RUNS[root].map((name) => finished(name, 'pass')),
      JSON.stringify({
        diagnostic: {
          summary: 'Instance cannot be destroyed',
          detail: `Resource ${PROTECTED[root][0]} has lifecycle.prevent_destroy set, but`,
        },
      }),
    ];
    const expected = PROTECTED[root].length - 1;
    expect(checkGuards(lines, root, { refusalsOptional: true })).toHaveLength(expected);
  });
});

describe('check.sh', () => {
  test('a long terraform version output does not stop the check with a broken pipe (141)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-sh-'));
    try {
      // `version` writes far more than a pipe holds, so a `| head -1` would close it early and
      // kill the writer; every other command fails with 7 so the run stops right after.
      const fake = path.join(dir, 'terraform');
      fs.writeFileSync(
        fake,
        [
          '#!/usr/bin/env bash',
          'if [ "$1" = version ]; then',
          '  for i in $(seq 1 50000); do echo "Terraform v1.12.2 line $i"; done',
          '  exit 0',
          'fi',
          'exit 7',
          '',
        ].join('\n'),
        { mode: 0o755 },
      );
      const result = spawnSync(
        'bash',
        [path.join(ROOT, 'infra', 'dryscope', 'scripts', 'check.sh')],
        {
          env: { ...process.env, TERRAFORM: fake },
          encoding: 'utf8',
        },
      );
      expect(result.status).toBe(7);
      expect(result.stdout.split('\n')[0]).toBe('Terraform v1.12.2 line 1');
      expect(result.stdout).not.toContain('line 2\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
