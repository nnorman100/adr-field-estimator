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
//
// Two named exceptions cover an environment that an earlier version of this table was already
// applied to (test): RETIRED grants may appear only as a plain delete of exactly that grant, and
// RECONDITIONED grants only as a replacement that keeps role and member and moves from the
// previous reviewed condition to the current one (the provider cannot change an IAM member's
// condition in place). A third covers an app root that is already applied: a Cloud Run service
// may change in place only by adding or setting a NEW_SETTINGS variable, to the value in the
// table, and (where the table holds it) moving its request concurrency to the table's value, with
// every other attribute unchanged; the update must clear the revision name a release set, because
// Cloud Run refuses to change an existing revision and makes a fresh one only for an unnamed
// template. A fourth covers a Cloud SQL instance already applied
// with a regional backup location: it may change in place, and only to the US multi-region (`us`),
// with every other attribute unchanged. Nothing else may be deleted, replaced or updated.
//
// A RE-APPLY plan (the root is already applied, so at least one resource in the plan is a no-op)
// adds one more allowance: a resource of a type in REAPPLY_UPDATABLE may change in place, because
// the planned state of every resource is held to the table in any case (name, location, service
// account, schedule target, exact environment). Grants, custom roles, data stores, secrets,
// accounts and the Cloud Run services and Cloud SQL instance stay as above: no-op, or the named
// exception. A plan with no no-op resource is a first apply and every update in it is refused, as
// is every delete or replacement in either kind.
const fs = require('node:fs');
const readline = require('node:readline');
const { addAiData, aiSettings, LIVE_CONCURRENCY } = require('./check-plan-ai.js');

const PROJECT = 'dryscope';
const PROJECT_NUMBER = '570228742694';
const REGION = 'us-central1';
const SERVICES = ['api', 'live'];
const RUNTIME = ['api', 'live', 'migrate'];
// Cloud SQL connect and login: the web app and the migrator. The Live relay holds no SQL
// access until a named table needs a narrower role.
const SQL_USERS = ['api', 'migrate'];
// roles/datastore.user includes delete, so only the web app holds it; the Live relay gets no
// Firestore access until a named need.
const FIRESTORE_USERS = ['api'];

const APIS = [
  'aiplatform.googleapis.com',
  'artifactregistry.googleapis.com',
  'cloudresourcemanager.googleapis.com',
  'cloudscheduler.googleapis.com',
  'firebaserules.googleapis.com',
  'firestore.googleapis.com',
  'iam.googleapis.com',
  'identitytoolkit.googleapis.com',
  'modelarmor.googleapis.com',
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

// Sign-in user management, bound by the owner on this environment's own tenants only (never on
// the project, so no grant of it may appear here). No users.delete, configs.* or tenants.*.
const IDENTITY_PERMISSIONS = [
  'firebaseauth.users.create',
  'firebaseauth.users.get',
  'firebaseauth.users.sendEmail',
  'firebaseauth.users.update',
];

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

// The migration job (app root): set its image, execute it, read its executions. No create,
// delete, run with overrides, cancel or IAM change.
const MIGRATE_JOB_PERMISSIONS = [
  'run.executions.get',
  'run.executions.list',
  'run.jobs.get',
  'run.jobs.run',
  'run.jobs.update',
  'run.operations.get',
  'run.tasks.get',
  'run.tasks.list',
];

// Releasing web/firestore.rules to this environment's field database (the test release workflow):
// read the current release and its ruleset, create a ruleset, create or point the release at it.
// No delete, list, test or getExecutable. Firebase Rules takes no IAM condition, so the grant is
// project-wide and must carry none.
const RULES_RELEASE_PERMISSIONS = [
  'firebaserules.releases.create',
  'firebaserules.releases.get',
  'firebaserules.releases.update',
  'firebaserules.rulesets.create',
  'firebaserules.rulesets.get',
];

// Internal job routes Cloud Scheduler calls (app root, scheduler.tf), each as the scheduler account
// with the audience serviceRoute checks (web/src/lib/auth/service-caller.ts): dryscope-<env>-<job>.
const SCHEDULED_JOBS = {
  'access-projection': { path: '/api/internal/access-projection', schedule: '*/5 * * * *' },
};

// Resource types whose in-place update a re-apply plan may hold. Never an IAM grant (the provider
// replaces those, and a replacement is refused), a custom role (its permission list is IAM), a data
// store, a secret or a service account.
const REAPPLY_UPDATABLE = new Set([
  'google_cloud_run_v2_job',
  'google_cloud_scheduler_job',
  'google_monitoring_alert_policy',
  'google_monitoring_notification_channel',
]);

// Resource types with no project attribute; every other resource must name PROJECT.
const PROJECTLESS = new Set([
  'google_service_account_iam_member',
  'google_storage_bucket_iam_member',
  'google_billing_budget',
  'google_model_armor_floorsetting', // its parent (projects/dryscope) is checked instead
]);

const title = (s) => s[0].toUpperCase() + s.slice(1);

function expectedPlan(root, env) {
  const sa = (k) => `serviceAccount:dryscope-${k}-${env}@${PROJECT}.iam.gserviceaccount.com`;
  const sqlName = `projects/${PROJECT}/instances/dryscope-${env}-pg`;
  const sqlCondition = `resource.type == 'sqladmin.googleapis.com/Instance' && resource.name == '${sqlName}'`;
  const fsDatabase = `projects/${PROJECT}/databases/dryscope-field-${env}`;
  // The database or any name under it (its documents); the slash keeps sibling databases out.
  const fsCondition = `resource.name == '${fsDatabase}' || resource.name.startsWith('${fsDatabase}/')`;
  const grants = {}; // address -> {role, member, condition, ...fields}
  const retired = {}; // address -> {role, member}: may only be deleted
  const reconditioned = {}; // address -> previous condition it may be replaced from
  const others = []; // [address, optional?]
  const attrs = {}; // address -> {path: expected}
  const lists = {}; // address -> {path: expected set}
  const absent = {}; // address -> [paths that must be empty or missing]
  const optional = new Set();
  const settings = {}; // address -> {NAME: value}: plain env settings checked on every plan
  const exactEnv = {}; // address -> {container: path, env: {NAME: value}}: the whole env, no secrets

  if (root === 'data') {
    for (const a of APIS) others.push(`google_project_service.apis["${a}"]`);
    for (const k of RUNTIME) others.push(`google_service_account.runtime["${k}"]`);
    others.push('google_service_account.deploy');
    others.push('google_sql_database_instance.main', 'google_sql_database.app');
    for (const k of RUNTIME) others.push(`google_sql_user.iam["${k}"]`);
    others.push('google_firestore_database.field', 'google_storage_bucket.evidence');
    others.push('google_artifact_registry_repository.images');
    others.push('google_project_iam_custom_role.gemini_caller');
    others.push('google_project_iam_custom_role.identity_users');
    for (const s of Object.keys(SECRET_ACCESS)) {
      others.push(`google_secret_manager_secret.app["${s}"]`);
    }

    for (const k of SQL_USERS) {
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
    for (const k of FIRESTORE_USERS) {
      const address = `google_project_iam_member.firestore_user["${k}"]`;
      grants[address] = { role: 'roles/datastore.user', member: sa(k), condition: fsCondition };
      // The first table matched the database name exactly.
      reconditioned[address] = `resource.name == '${fsDatabase}'`;
    }
    // The first table also gave the Live relay SQL and Firestore access.
    retired['google_project_iam_member.sql_client["live"]'] = {
      role: 'roles/cloudsql.client',
      member: sa('live'),
    };
    retired['google_project_iam_member.sql_login["live"]'] = {
      role: 'roles/cloudsql.instanceUser',
      member: sa('live'),
    };
    retired['google_project_iam_member.firestore_user["live"]'] = {
      role: 'roles/datastore.user',
      member: sa('live'),
    };
    for (const k of SERVICES) {
      grants[`google_project_iam_member.gemini_caller["${k}"]`] = {
        role: `projects/${PROJECT}/roles/dryscopeGemini${title(env)}`,
        member: sa(k),
        condition: null,
      };
    }
    // The two services' accounts, and the migrator because the release sets the image on the
    // migration job (app root), which runs as it.
    for (const k of RUNTIME) {
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
    // The same principal set signs in as the migrator, so migrations run before traffic moves.
    const wifMigrate = 'google_service_account_iam_member.migrate_workload_identity[0]';
    optional.add(wifMigrate);
    grants[wifMigrate] = {
      ...grants[wif],
      service_account_id: `projects/${PROJECT}/serviceAccounts/dryscope-migrate-${env}@${PROJECT}.iam.gserviceaccount.com`,
    };

    attrs['google_sql_database_instance.main'] = {
      name: `dryscope-${env}-pg`,
      region: REGION,
      deletion_protection: true,
      'settings.0.deletion_protection_enabled': true,
      'settings.0.edition': 'ENTERPRISE',
      'settings.0.availability_type': 'ZONAL',
      'settings.0.backup_configuration.0.enabled': true,
      // Backups are kept in the US multi-region so a regional outage cannot take them too.
      'settings.0.backup_configuration.0.location': 'us',
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
    // Test only for now; live gets neither until the live wiring, so a live plan holding either is
    // refused as not in the inventory. The scheduler account holds no grant: none in the table names
    // it as a member. The deploy account releases the field-database rules. Project-wide: Firebase
    // Rules takes no IAM condition, so one here would look narrower than it is, and is refused like
    // any other.
    if (env === 'test') {
      others.push('google_service_account.scheduler[0]');
      attrs['google_service_account.scheduler[0]'] = { account_id: `dryscope-scheduler-${env}` };
      others.push('google_project_iam_custom_role.rules_release[0]');
      lists['google_project_iam_custom_role.rules_release[0]'] = {
        permissions: RULES_RELEASE_PERMISSIONS,
      };
      attrs['google_project_iam_custom_role.rules_release[0]'] = {
        role_id: `dryscopeRulesRelease${title(env)}`,
      };
      grants['google_project_iam_member.deploy_rules_release[0]'] = {
        role: `projects/${PROJECT}/roles/dryscopeRulesRelease${title(env)}`,
        member: sa('deploy'),
        condition: null,
      };
    }
    addAiData(env, { sa, others, grants, attrs, absent, optional, wif });
    lists['google_project_iam_custom_role.identity_users'] = { permissions: IDENTITY_PERMISSIONS };
    attrs['google_project_iam_custom_role.identity_users'] = {
      role_id: `dryscopeIdentity${title(env)}`,
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
      settings[`google_cloud_run_v2_service.svc["${k}"]`] = {
        // The environment's own web app address (app/envs/<env>.tfvars).
        ALLOWED_ORIGINS: `https://dryscope-api-${env}-${PROJECT_NUMBER}.${REGION}.run.app`,
        ...aiSettings(env)[k],
      };
      attrs[`google_cloud_run_v2_service.svc["${k}"]`] = {
        name: `dryscope-${k}-${env}`,
        location: REGION,
        deletion_protection: true,
        'template.0.service_account': `dryscope-${k}-${env}@${PROJECT}.iam.gserviceaccount.com`,
        ...(k === 'live'
          ? { 'template.0.max_instance_request_concurrency': LIVE_CONCURRENCY[env] }
          : {}),
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

    // The migration job: the web image by digest from this environment's repository, run as the
    // migrator over its own instance's socket, with nothing but the migrator's settings.
    const job = 'google_cloud_run_v2_job.migrate';
    others.push(job, 'google_project_iam_custom_role.migrate_job');
    attrs[job] = {
      name: `dryscope-migrate-${env}`,
      location: REGION,
      deletion_protection: true,
      'template.0.task_count': 1,
      'template.0.template.0.service_account': `dryscope-migrate-${env}@${PROJECT}.iam.gserviceaccount.com`,
      'template.0.template.0.max_retries': 0,
      'template.0.template.0.volumes.0.cloud_sql_instance.0.instances': [
        `${PROJECT}:${REGION}:dryscope-${env}-pg`,
      ],
      'template.0.template.0.containers.0.image': new RegExp(
        `^${REGION}-docker\\.pkg\\.dev/${PROJECT}/dryscope-${env}/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$`,
      ),
      'template.0.template.0.containers.0.command': ['node'],
      'template.0.template.0.containers.0.args': ['migrate.mjs'],
    };
    absent[job] = ['template.0.template.0.containers.1', 'template.0.template.0.volumes.1'];
    exactEnv[job] = {
      container: 'template.0.template.0.containers.0',
      env: {
        APP_ENV: env,
        SQL_CONNECTION_NAME: `${PROJECT}:${REGION}:dryscope-${env}-pg`,
        SQL_DATABASE_NAME: 'dryscope',
        SQL_IAM_USER: `dryscope-migrate-${env}@${PROJECT}.iam`,
      },
    };
    lists['google_project_iam_custom_role.migrate_job'] = { permissions: MIGRATE_JOB_PERMISSIONS };
    attrs['google_project_iam_custom_role.migrate_job'] = {
      role_id: `dryscopeMigrateJob${title(env)}`,
    };
    // Only the deploy account, only on this job.
    grants['google_cloud_run_v2_job_iam_member.deploy'] = {
      role: `projects/${PROJECT}/roles/dryscopeMigrateJob${title(env)}`,
      member: sa('deploy'),
      condition: null,
      name: `dryscope-migrate-${env}`,
      location: REGION,
    };
    // Scheduled job calls: POST to this environment's own web app address, with an ID token for this
    // environment's scheduler account and the job's own audience. No OAuth token, headers or body,
    // and no Pub/Sub or App Engine target. Test only for now; a live plan holding one is refused.
    for (const [job, { path, schedule }] of Object.entries(env === 'test' ? SCHEDULED_JOBS : {})) {
      const address = `google_cloud_scheduler_job.jobs["${job}"]`;
      others.push(address);
      attrs[address] = {
        name: `dryscope-${job}-${env}`,
        region: REGION,
        schedule,
        time_zone: 'Etc/UTC',
        paused: false,
        'http_target.0.http_method': 'POST',
        'http_target.0.uri': `https://dryscope-api-${env}-${PROJECT_NUMBER}.${REGION}.run.app${path}`,
        'http_target.0.oidc_token.0.service_account_email': `dryscope-scheduler-${env}@${PROJECT}.iam.gserviceaccount.com`,
        'http_target.0.oidc_token.0.audience': `dryscope-${env}-${job}`,
      };
      absent[address] = [
        'http_target.0.oauth_token',
        'http_target.0.oidc_token.1',
        'http_target.0.headers',
        'http_target.0.body',
        'http_target.1',
        'pubsub_target',
        'app_engine_http_target',
      ];
    }
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
  return {
    grants,
    others,
    attrs,
    lists,
    absent,
    optional,
    retired,
    reconditioned,
    settings,
    exactEnv,
  };
}

const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const same = (want, got) =>
  want instanceof RegExp
    ? typeof got === 'string' && want.test(got)
    : JSON.stringify(want) === JSON.stringify(got);
const empty = (v) => v == null || (Array.isArray(v) && v.length === 0);
// Plain (not secret) env settings of a Cloud Run service's first container, by name.
const envOf = (state) => state?.template?.[0]?.containers?.[0]?.env ?? [];
const plainEnv = (state) =>
  Object.fromEntries(
    envOf(state)
      .filter((e) => empty(e.value_source))
      .map((e) => [e.name, e.value]),
  );
// Settings that an in-place update of an applied Cloud Run service may add or set: ALLOWED_ORIGINS,
// then the AI settings (S7-2). Their values are held to the table on every plan.
const NEW_SETTINGS = [
  'ALLOWED_ORIGINS',
  ...new Set(Object.values(aiSettings('test')).flatMap((names) => Object.keys(names))),
];
// A request concurrency the table holds may move to the table's value in the same update.
const CONCURRENCY = 'template.0.max_instance_request_concurrency';

// Against existing state the provider returns some IAM member fields as full resource paths
// instead of the short names a fresh plan holds. Each is accepted only when it resolves to
// exactly the expected name in PROJECT (and REGION for a repository); any other project,
// location or name still fails the comparison.
// `name` is a Cloud Run service's or job's, so the path depends on the resource type.
const FULL_PATHS = {
  bucket: () => (name) => `b/${name}`,
  secret_id: () => (name) => `projects/${PROJECT}/secrets/${name}`,
  repository: () => (name) => `projects/${PROJECT}/locations/${REGION}/repositories/${name}`,
  name: (type) =>
    ({
      google_cloud_run_v2_service_iam_member: (name) =>
        `projects/${PROJECT}/locations/${REGION}/services/${name}`,
      google_cloud_run_v2_job_iam_member: (name) =>
        `projects/${PROJECT}/locations/${REGION}/jobs/${name}`,
    })[type],
};
const sameField = (type, field, want, got) => {
  if (same(want, got)) return true;
  const path = typeof want === 'string' ? FULL_PATHS[field]?.(type) : undefined;
  return path !== undefined && got === path(want);
};

/** Returns a list of problems; an empty list means the plan matches the table. */
function checkPlan(resourceChanges, { root, environment, complete = true, reapply }) {
  const problems = [];
  // Existing infrastructure shows as no-op; a first apply has none. Pass `reapply` to force either.
  const isReapply =
    reapply ?? resourceChanges.some((rc) => (rc.change?.actions ?? []).join() === 'no-op');
  const want = expectedPlan(root, environment);
  const byAddress = new Map(resourceChanges.map((rc) => [rc.address, rc]));

  const conditionOf = (state) => (state?.condition ?? []).map((c) => c.expression);
  const isReplace = (actions) =>
    actions.length === 2 && actions.includes('delete') && actions.includes('create');
  // A retired grant may only be removed, and only if it is exactly the grant the table retired.
  const retiredDelete = (rc, actions) => {
    const was = want.retired[rc.address];
    const before = rc.change?.before;
    return (
      was !== undefined &&
      actions.length === 1 &&
      actions[0] === 'delete' &&
      before?.role === was.role &&
      before?.member === was.member
    );
  };
  // A reconditioned grant may be replaced only from its previous reviewed condition, keeping
  // role and member; the new condition is checked against the table below like any grant.
  const reconditionedReplace = (rc, actions) => {
    const previous = want.reconditioned[rc.address];
    const { before, after } = rc.change ?? {};
    return (
      previous !== undefined &&
      isReplace(actions) &&
      before != null &&
      after != null &&
      before.role === after.role &&
      before.member === after.member &&
      same([previous], conditionOf(before))
    );
  };

  // An applied Cloud Run service may be updated in place only to add or set NEW_SETTINGS and, where
  // the table holds it, to move its request concurrency (both checked against the table below). Apart
  // from those, the planned state must equal the current one; output-only top-level
  // fields the provider will recompute (marked unknown) are skipped. Anything unknown inside the
  // template is not skipped, so such a plan is refused rather than guessed at. The planned revision
  // name must be empty, so the update makes a fresh revision; clearing a name a release set is
  // the only change to it allowed.
  const settingsUpdate = (rc, actions) => {
    const { before, after, after_unknown: unknown = {} } = rc.change ?? {};
    if (!want.settings[rc.address] || actions.length !== 1 || actions[0] !== 'update') return false;
    if (before == null || after == null || !empty(after.template?.[0]?.revision)) return false;
    const strip = (state) => {
      const copy = structuredClone(state);
      for (const key of Object.keys(unknown))
        if (unknown[key] === true && key !== 'template') {
          delete copy[key];
        }
      const container = copy.template?.[0]?.containers?.[0];
      // Only the NEW_SETTINGS the table gives this service: another service's setting still differs.
      const own = Object.keys(want.settings[rc.address]);
      if (container) {
        container.env = envOf(copy).filter(
          (e) => !(NEW_SETTINGS.includes(e.name) && own.includes(e.name)),
        );
      }
      if (want.attrs[rc.address]?.[CONCURRENCY] !== undefined && copy.template?.[0]) {
        delete copy.template[0].max_instance_request_concurrency;
      }
      if (copy.template?.[0]) delete copy.template[0].revision;
      return copy;
    };
    const canon = (v) =>
      Array.isArray(v)
        ? v.map(canon)
        : v && typeof v === 'object'
          ? Object.fromEntries(
              Object.keys(v)
                .sort()
                .map((k) => [k, canon(v[k])]),
            )
          : v;
    return same(canon(strip(before)), canon(strip(after)));
  };

  // An applied Cloud SQL instance may be updated in place only to move its backups to the US
  // multi-region. Values the provider recomputes (marked unknown) are dropped from both sides;
  // every other attribute must be equal, so the update can change nothing else.
  const backupLocationUpdate = (rc, actions) => {
    const { before, after, after_unknown: unknown = {} } = rc.change ?? {};
    if (rc.address !== 'google_sql_database_instance.main') return false;
    if (actions.length !== 1 || actions[0] !== 'update' || before == null || after == null) {
      return false;
    }
    const LOCATION = ['settings', 0, 'backup_configuration', 0, 'location'];
    const at = (v, path) => path.reduce((o, k) => o?.[k], v);
    if (at(after, LOCATION) !== 'us') return false;
    const scrub = (state, mask) => {
      if (mask === true) return undefined;
      if (Array.isArray(state)) {
        return state.map((v, i) => scrub(v, Array.isArray(mask) ? mask[i] : undefined));
      }
      if (state && typeof state === 'object') {
        return Object.fromEntries(
          Object.keys(state)
            .sort()
            .map((k) => [k, scrub(state[k], mask?.[k])])
            .filter(([, v]) => v !== undefined),
        );
      }
      return state;
    };
    const dropLocation = (state) => {
      const copy = structuredClone(state);
      const parent = at(copy, LOCATION.slice(0, -1));
      if (parent) delete parent.location;
      return copy;
    };
    return same(scrub(dropLocation(before), unknown), scrub(dropLocation(after), unknown));
  };

  for (const rc of resourceChanges) {
    const actions = rc.change?.actions ?? [];
    if (
      retiredDelete(rc, actions) ||
      reconditionedReplace(rc, actions) ||
      settingsUpdate(rc, actions) ||
      backupLocationUpdate(rc, actions)
    ) {
      // Named, reviewed exception (see the table).
    } else if (actions.includes('delete')) {
      problems.push(`${rc.address}: plan would delete or replace it (${actions.join(', ')})`);
    } else if (
      isReapply &&
      actions.length === 1 &&
      actions[0] === 'update' &&
      REAPPLY_UPDATABLE.has(rc.type ?? rc.address.split('.')[0])
    ) {
      // Re-apply: the planned state is held to the table below like any other.
    } else if (actions.includes('update')) {
      problems.push(`${rc.address}: plan would change it in place; a first apply only creates`);
    } else if (!actions.every((a) => ['create', 'no-op', 'read', 'update'].includes(a))) {
      problems.push(`${rc.address}: unexpected plan action ${actions.join(', ')}`);
    }
  }

  const allowed = new Set([...want.others, ...Object.keys(want.grants)]);
  for (const rc of resourceChanges) {
    const after = rc.change?.after;
    if (retiredDelete(rc, rc.change?.actions ?? [])) continue;
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
      } else if (!sameField(address.split('.')[0], field, expected, after[field])) {
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
  for (const [address, expected] of Object.entries(want.settings)) {
    const after = byAddress.get(address)?.change?.after;
    if (!after) continue;
    const got = plainEnv(after);
    for (const [name, value] of Object.entries(expected)) {
      if (got[name] !== value) {
        problems.push(`${address}: env ${name} is ${JSON.stringify(got[name])}, expected ${value}`);
      }
    }
  }
  for (const [address, { container, env }] of Object.entries(want.exactEnv)) {
    const after = byAddress.get(address)?.change?.after;
    if (!after) continue;
    const entries = get(after, `${container}.env`) ?? [];
    const got = Object.fromEntries(entries.map((e) => [e.name, e.value]));
    const secret = entries.filter((e) => !empty(e.value_source)).map((e) => e.name);
    const sorted = (o) =>
      Object.keys(o)
        .sort()
        .map((k) => [k, o[k]]);
    if (
      secret.length ||
      entries.length !== Object.keys(got).length ||
      !same(sorted(env), sorted(got))
    ) {
      problems.push(
        `${address}: env is ${JSON.stringify(got)}${secret.length ? ` with secret ${secret.join(', ')}` : ''}, expected exactly ${JSON.stringify(env)}`,
      );
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
    const reapply = plan.some((rc) => (rc.change?.actions ?? []).join() === 'no-op');
    if (i === 0 && reapply)
      console.log(
        `re-apply plan: existing resources are no-op, or an allowed in-place change (${[...REAPPLY_UPDATABLE].join(', ')}, and the named exceptions)`,
      );
    for (const problem of checkPlan(plan, { root, environment, complete: i === 0, reapply })) {
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
