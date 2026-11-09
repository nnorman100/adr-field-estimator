#!/usr/bin/env node
'use strict';
// Closed-set check of a Terraform plan for the DryScope roots.
//
// `terraform test` can only look at resources it is told about, so a new IAM grant, a wider
// condition or a replaced database slips past it. This check reads the WHOLE plan instead and
// requires every resource (its project and name), every IAM grant (role, member, exact condition)
// and every protection setting to match a fixed table, and refuses any delete or replacement.
//
// It runs on two inputs:
//   - the mocked plans that `terraform test -json -verbose` prints (scripts/check.sh), and
//   - the owner's saved plan before an apply: `terraform show -json test.tfplan > test.json`.
//
//   node check-plan.js <data|app> <test|live> <plan.json | stream | ->
//   node check-plan.js export <stream | -> > fixture.json   (first mocked plan, trimmed)
//
// The table is deliberately written out here: adding a resource or a grant means changing it
// in the same review. `prevent_destroy` is not in plan JSON, so it cannot be checked here; the
// refusal of every delete action is what stands behind it.
const fs = require('node:fs');
const readline = require('node:readline');

const PROJECT = 'dryscope';
const REGION = 'us-central1';
const SERVICES = ['api', 'live'];
const RUNTIME = ['api', 'live', 'migrate'];

const APIS = [
  'aiplatform.googleapis.com',
  'artifactregistry.googleapis.com',
  'cloudresourcemanager.googleapis.com',
  'firestore.googleapis.com',
  'iam.googleapis.com',
  'secretmanager.googleapis.com',
  'sqladmin.googleapis.com',
  'storage.googleapis.com',
];

// Which Cloud Run service may read which secret (the naming module's table).
const SECRET_ACCESS = {
  'resend-api-key': ['api'],
  'stripe-secret-key': ['api'],
  'maps-api-key': ['api'],
  'link-signing-key': ['api', 'live'],
};

const DEPLOY_PERMISSIONS = [
  'run.configurations.get',
  'run.configurations.list',
  'run.operations.get',
  'run.operations.list',
  'run.revisions.get',
  'run.revisions.list',
  'run.routes.get',
  'run.routes.list',
  'run.services.get',
  'run.services.list',
  'run.services.update',
];

// Resource types with no project attribute; every other resource must name PROJECT.
const PROJECTLESS = new Set([
  'google_service_account_iam_member',
  'google_storage_bucket_iam_member',
  'google_billing_budget',
]);

const title = (s) => s[0].toUpperCase() + s.slice(1);

function expectedPlan(root, env) {
  const sa = (k) => `serviceAccount:dryscope-${k}-${env}@${PROJECT}.iam.gserviceaccount.com`;
  const sqlName = `projects/${PROJECT}/instances/dryscope-${env}-pg`;
  const sqlCondition = `resource.type == 'sqladmin.googleapis.com/Instance' && resource.name == '${sqlName}'`;
  const fsCondition = `resource.name == 'projects/${PROJECT}/databases/dryscope-field-${env}'`;
  const grants = {}; // address -> {role, member, condition, ...fields}
  const others = []; // [address, optional?]
  const attrs = {}; // address -> {path: expected}
  const lists = {}; // address -> {path: expected set}
  const absent = {}; // address -> [paths that must be empty or missing]
  const optional = new Set();

  if (root === 'data') {
    for (const a of APIS) others.push(`google_project_service.apis["${a}"]`);
    for (const k of RUNTIME) others.push(`google_service_account.runtime["${k}"]`);
    others.push('google_service_account.deploy');
    others.push('google_sql_database_instance.main', 'google_sql_database.app');
    for (const k of RUNTIME) others.push(`google_sql_user.iam["${k}"]`);
    others.push('google_firestore_database.field', 'google_storage_bucket.evidence');
    others.push('google_artifact_registry_repository.images');
    others.push('google_project_iam_custom_role.gemini_caller');
    for (const s of Object.keys(SECRET_ACCESS)) {
      others.push(`google_secret_manager_secret.app["${s}"]`);
    }

    for (const k of RUNTIME) {
      grants[`google_project_iam_member.sql_client["${k}"]`] = {
        role: 'roles/cloudsql.client',
        member: sa(k),
        condition: sqlCondition,
      };
      grants[`google_project_iam_member.sql_login["${k}"]`] = {
        role: 'roles/cloudsql.instanceUser',
        member: sa(k),
        condition: sqlCondition,
      };
    }
    for (const k of SERVICES) {
      grants[`google_project_iam_member.firestore_user["${k}"]`] = {
        role: 'roles/datastore.user',
        member: sa(k),
        condition: fsCondition,
      };
      grants[`google_project_iam_member.gemini_caller["${k}"]`] = {
        role: `projects/${PROJECT}/roles/dryscopeGemini${title(env)}`,
        member: sa(k),
        condition: null,
      };
      grants[`google_service_account_iam_member.deploy_acts_as["${k}"]`] = {
        role: 'roles/iam.serviceAccountUser',
        member: sa('deploy'),
        condition: null,
        service_account_id: `projects/${PROJECT}/serviceAccounts/dryscope-${k}-${env}@${PROJECT}.iam.gserviceaccount.com`,
      };
    }
    const bucket = `${PROJECT}-evidence-${env}`;
    grants['google_storage_bucket_iam_member.api_create'] = {
      role: 'roles/storage.objectCreator',
      member: sa('api'),
      condition: null,
      bucket,
    };
    grants['google_storage_bucket_iam_member.api_view'] = {
      role: 'roles/storage.objectViewer',
      member: sa('api'),
      condition: null,
      bucket,
    };
    for (const [secret, who] of Object.entries(SECRET_ACCESS)) {
      for (const k of who) {
        grants[`google_secret_manager_secret_iam_member.accessor["${secret}/${k}"]`] = {
          role: 'roles/secretmanager.secretAccessor',
          member: sa(k),
          condition: null,
          secret_id: `dryscope-${env}-${secret}`,
        };
      }
    }
    grants['google_artifact_registry_repository_iam_member.deploy_write'] = {
      role: 'roles/artifactregistry.writer',
      member: sa('deploy'),
      condition: null,
      repository: `dryscope-${env}`,
      location: REGION,
    };
    // Present only after the owner supplies a repository-scoped principal set from this
    // environment's own pool.
    const wif = 'google_service_account_iam_member.deploy_workload_identity[0]';
    optional.add(wif);
    grants[wif] = {
      role: 'roles/iam.workloadIdentityUser',
      member: new RegExp(
        `^principalSet://iam\\.googleapis\\.com/projects/[0-9]+/locations/global/workloadIdentityPools/dryscope-${env}/attribute\\.(repository_id|repository)/[^*]+$`,
      ),
      condition: null,
      service_account_id: `projects/${PROJECT}/serviceAccounts/dryscope-deploy-${env}@${PROJECT}.iam.gserviceaccount.com`,
    };

    attrs['google_sql_database_instance.main'] = {
      name: `dryscope-${env}-pg`,
      region: REGION,
      deletion_protection: true,
      'settings.0.deletion_protection_enabled': true,
      'settings.0.edition': 'ENTERPRISE',
      'settings.0.availability_type': 'ZONAL',
      'settings.0.backup_configuration.0.enabled': true,
      'settings.0.backup_configuration.0.point_in_time_recovery_enabled': true,
      'settings.0.ip_configuration.0.ssl_mode': 'ENCRYPTED_ONLY',
      'settings.0.tier': env === 'test' ? 'db-f1-micro' : /^db-custom-/,
    };
    absent['google_sql_database_instance.main'] = [
      'settings.0.ip_configuration.0.authorized_networks',
    ];
    attrs['google_firestore_database.field'] = {
      name: `dryscope-field-${env}`,
      location_id: REGION,
      delete_protection_state: 'DELETE_PROTECTION_ENABLED',
      point_in_time_recovery_enablement: 'POINT_IN_TIME_RECOVERY_ENABLED',
      deletion_policy: 'ABANDON',
    };
    attrs['google_storage_bucket.evidence'] = {
      name: bucket,
      location: 'US-CENTRAL1',
      uniform_bucket_level_access: true,
      public_access_prevention: 'enforced',
      force_destroy: false,
      'versioning.0.enabled': true,
    };
    absent['google_storage_bucket.evidence'] = ['retention_policy', 'lifecycle_rule'];
    attrs['google_sql_database.app'] = {
      name: 'dryscope',
      instance: `dryscope-${env}-pg`,
      deletion_policy: 'ABANDON',
    };
    for (const k of RUNTIME) {
      attrs[`google_sql_user.iam["${k}"]`] = {
        name: `dryscope-${k}-${env}@${PROJECT}.iam`,
        instance: `dryscope-${env}-pg`,
        deletion_policy: 'ABANDON',
        type: 'CLOUD_IAM_SERVICE_ACCOUNT',
      };
      attrs[`google_service_account.runtime["${k}"]`] = { account_id: `dryscope-${k}-${env}` };
    }
    attrs['google_service_account.deploy'] = { account_id: `dryscope-deploy-${env}` };
    for (const a of APIS) attrs[`google_project_service.apis["${a}"]`] = { service: a };
    for (const s of Object.keys(SECRET_ACCESS)) {
      const address = `google_secret_manager_secret.app["${s}"]`;
      attrs[address] = {
        secret_id: `dryscope-${env}-${s}`,
        'replication.0.user_managed.0.replicas.0.location': REGION,
      };
      absent[address] = ['replication.0.auto', 'replication.0.user_managed.0.replicas.1'];
    }
    attrs['google_artifact_registry_repository.images'] = {
      repository_id: `dryscope-${env}`,
      location: REGION,
      'docker_config.0.immutable_tags': true,
    };
    lists['google_project_iam_custom_role.gemini_caller'] = {
      permissions: ['aiplatform.endpoints.predict'],
    };
    attrs['google_project_iam_custom_role.gemini_caller'] = {
      role_id: `dryscopeGemini${title(env)}`,
    };
  } else {
    for (const k of SERVICES) {
      others.push(`google_cloud_run_v2_service.svc["${k}"]`);
      grants[`google_cloud_run_v2_service_iam_member.public["${k}"]`] = {
        role: 'roles/run.invoker',
        member: 'allUsers',
        condition: null,
        name: `dryscope-${k}-${env}`,
        location: REGION,
      };
      grants[`google_cloud_run_v2_service_iam_member.deploy["${k}"]`] = {
        role: `projects/${PROJECT}/roles/dryscopeDeploy${title(env)}`,
        member: sa('deploy'),
        condition: null,
        name: `dryscope-${k}-${env}`,
        location: REGION,
      };
      others.push(`google_monitoring_alert_policy.server_errors["${k}"]`);
      attrs[`google_cloud_run_v2_service.svc["${k}"]`] = {
        name: `dryscope-${k}-${env}`,
        location: REGION,
        deletion_protection: true,
        'template.0.service_account': `dryscope-${k}-${env}@${PROJECT}.iam.gserviceaccount.com`,
      };
    }
    others.push(
      'google_project_iam_custom_role.deploy',
      'google_monitoring_notification_channel.email',
    );
    others.push('google_monitoring_alert_policy.api_latency');
    others.push(
      'google_monitoring_alert_policy.sql["cpu"]',
      'google_monitoring_alert_policy.sql["disk"]',
    );
    lists['google_project_iam_custom_role.deploy'] = { permissions: DEPLOY_PERMISSIONS };
    attrs['google_project_iam_custom_role.deploy'] = { role_id: `dryscopeDeploy${title(env)}` };
    // Health probe: live only. Budget: only when a billing account is given.
    if (env === 'live') {
      others.push(
        'google_monitoring_uptime_check_config.api_health[0]',
        'google_monitoring_alert_policy.api_down[0]',
      );
    }
    optional.add('google_billing_budget.monthly[0]');
    others.push('google_billing_budget.monthly[0]');
  }
  return { grants, others, attrs, lists, absent, optional };
}

const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const same = (want, got) =>
  want instanceof RegExp
    ? typeof got === 'string' && want.test(got)
    : JSON.stringify(want) === JSON.stringify(got);
const empty = (v) => v == null || (Array.isArray(v) && v.length === 0);

/** Returns a list of problems; an empty list means the plan matches the table. */
function checkPlan(resourceChanges, { root, environment, complete = true }) {
  const problems = [];
  const want = expectedPlan(root, environment);
  const byAddress = new Map(resourceChanges.map((rc) => [rc.address, rc]));

  for (const rc of resourceChanges) {
    const actions = rc.change?.actions ?? [];
    if (actions.includes('delete')) {
      problems.push(`${rc.address}: plan would delete or replace it (${actions.join(', ')})`);
    } else if (actions.includes('update')) {
      problems.push(`${rc.address}: plan would change it in place; a first apply only creates`);
    } else if (!actions.every((a) => ['create', 'no-op', 'read', 'update'].includes(a))) {
      problems.push(`${rc.address}: unexpected plan action ${actions.join(', ')}`);
    }
  }

  const allowed = new Set([...want.others, ...Object.keys(want.grants)]);
  for (const rc of resourceChanges) {
    const after = rc.change?.after;
    if (!allowed.has(rc.address)) {
      problems.push(`${rc.address}: not in the expected ${root} inventory`);
    } else if (after && !PROJECTLESS.has(rc.address.split('.')[0]) && after.project !== PROJECT) {
      problems.push(
        `${rc.address}: project is ${JSON.stringify(after.project)}, expected ${PROJECT}`,
      );
    }
  }
  for (const address of complete ? allowed : []) {
    if (!byAddress.has(address) && !want.optional.has(address)) {
      problems.push(`${address}: expected in the plan but missing`);
    }
  }

  for (const [address, grant] of Object.entries(want.grants)) {
    const after = byAddress.get(address)?.change?.after;
    if (!after) continue;
    for (const [field, expected] of Object.entries(grant)) {
      if (field === 'condition') {
        const conditions = after.condition ?? [];
        const got = conditions.length ? conditions[0].expression : null;
        if (!same(expected, got) || conditions.length > 1) {
          problems.push(
            `${address}: condition is ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`,
          );
        }
      } else if (!same(expected, after[field])) {
        problems.push(
          `${address}: ${field} is ${JSON.stringify(after[field])}, expected ${expected}`,
        );
      }
    }
  }

  for (const [address, expected] of Object.entries(want.attrs)) {
    const after = byAddress.get(address)?.change?.after;
    if (!after) continue;
    for (const [path, value] of Object.entries(expected)) {
      if (!same(value, get(after, path))) {
        problems.push(
          `${address}: ${path} is ${JSON.stringify(get(after, path))}, expected ${value}`,
        );
      }
    }
  }
  for (const [address, paths] of Object.entries(want.absent)) {
    const after = byAddress.get(address)?.change?.after;
    if (!after) continue;
    for (const path of paths) {
      if (!empty(get(after, path))) problems.push(`${address}: ${path} must be empty`);
    }
  }
  for (const [address, expected] of Object.entries(want.lists)) {
    const after = byAddress.get(address)?.change?.after;
    if (!after) continue;
    for (const [path, values] of Object.entries(expected)) {
      const got = [...(get(after, path) ?? [])].sort();
      if (!same([...values].sort(), got)) {
        problems.push(
          `${address}: ${path} is [${got.join(', ')}], expected [${[...values].sort().join(', ')}]`,
        );
      }
    }
  }
  return problems;
}

/** Plans in a file: one plan JSON, or the line stream `terraform test -json -verbose` prints. */
function plansFromLines(lines) {
  const plans = [];
  for (const line of lines) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      continue;
    }
    const plan = doc.test_plan ?? doc;
    if (Array.isArray(plan.resource_changes)) plans.push(plan.resource_changes);
  }
  return plans;
}

function plansFromText(text) {
  const whole = (() => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  })();
  if (whole && Array.isArray(whole.resource_changes)) return [whole.resource_changes];
  return plansFromLines(text.split('\n'));
}

async function readPlans(file) {
  if (file !== '-' && fs.statSync(file).size < 50 * 1024 * 1024) {
    return plansFromText(fs.readFileSync(file, 'utf8'));
  }
  const input = file === '-' ? process.stdin : fs.createReadStream(file);
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const plans = [];
  for await (const line of lines) plans.push(...plansFromLines([line]));
  return plans;
}

// Fixtures keep no address, even a fake one: the notification channel's label is blanked.
const scrub = (rc) =>
  rc.type === 'google_monitoring_notification_channel'
    ? { ...rc.change.after, labels: { email_address: 'redacted' } }
    : rc.change.after;
const trim = (rcs) =>
  rcs.map((rc) => ({
    address: rc.address,
    type: rc.type,
    change: { actions: rc.change.actions, after: scrub(rc) },
  }));

async function main(args) {
  if (args[0] === 'export') {
    const plans = await readPlans(args[1]);
    process.stdout.write(`${JSON.stringify({ resource_changes: trim(plans[0]) }, null, 1)}\n`);
    return 0;
  }
  const [root, environment, file] = args;
  if (!['data', 'app'].includes(root) || !['test', 'live'].includes(environment) || !file) {
    console.error('usage: check-plan.js <data|app> <test|live> <plan.json|stream|->');
    return 2;
  }
  const plans = await readPlans(file);
  if (plans.length === 0) {
    console.error('no plan found in the input');
    return 2;
  }
  let failed = 0;
  plans.forEach((plan, i) => {
    // A mocked run that expects a validation failure plans only part of the root, so
    // only the first plan (or a single saved plan) must contain everything.
    for (const problem of checkPlan(plan, { root, environment, complete: i === 0 })) {
      failed += 1;
      console.error(`plan ${i + 1}: ${problem}`);
    }
  });
  console.log(`${root}/${environment}: ${plans.length} plan(s) checked, ${failed} problem(s)`);
  return failed ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}

module.exports = { checkPlan, expectedPlan, plansFromText };
