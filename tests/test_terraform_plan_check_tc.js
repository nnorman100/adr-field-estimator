// Plan-check cases for the TC-9 data-root bundle (docs/plans/TC.md; infra/dryscope/scripts/
// check-plan-tc.js):
//   - the stage's APIs, and no plan that drops one;
//   - every new grant names one role, one account and its one exact condition (none: the Telemetry
//     API, log writing and a secret's own IAM take no resource condition), and nothing wider;
//   - the synthetic monitor's account, secret and read grant, and the deploy account's log writing,
//     in test only;
//   - container scanning set on the image repository;
//   - the reCAPTCHA key (score only, this environment's app host, no wildcard or localhost) and the
//     App Check registration once a web app id of this project is given;
//   - the 35-day backup window (D-023) and keyless sign-in by numeric repository id only (D-024);
//   - re-applying test: the bucket and repository change in place only in their named fields, and
//     nothing is deleted.
// Fixtures and the checker are the ones tests/test_terraform_plan_check.js uses.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(ROOT, 'infra', 'dryscope', 'scripts');
const { checkPlan } = require(path.join(SCRIPTS, 'check-plan.js'));
const { TC_APIS } = require(path.join(SCRIPTS, 'check-plan-tc.js'));

function load(environment) {
  const file = path.join(ROOT, 'infra', 'dryscope', 'fixtures', `data-${environment}.plan.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8')).resource_changes;
}

const find = (plan, address) => plan.find((rc) => rc.address === address);
const check = (plan, environment, options = {}) =>
  checkPlan(plan, { root: 'data', environment, ...options });
const account = (name) => `serviceAccount:${name}@dryscope.iam.gserviceaccount.com`;
const created = (address, after) => ({
  address,
  type: address.split('.')[0],
  change: { actions: ['create'], after },
});

const TRACES = 'google_project_iam_member.traces_writer["api"]';
const LOG_WRITER = 'google_project_iam_member.deploy_log_writer[0]';
const SYNTHETIC = 'google_service_account.synthetic[0]';
const SYNTHETIC_SECRET = 'google_secret_manager_secret.synthetic_password[0]';
const SYNTHETIC_READ = 'google_secret_manager_secret_iam_member.synthetic_password[0]';
const KEY = 'google_recaptcha_enterprise_key.web';
const APP_CHECK = 'google_firebase_app_check_recaptcha_enterprise_config.web[0]';
const BUCKET = 'google_storage_bucket.evidence';
const SQL = 'google_sql_database_instance.main';
const SCHEDULE = 'google_firestore_backup_schedule.field_daily';
const REPO = 'google_artifact_registry_repository.images';
const WIF = 'google_service_account_iam_member.deploy_workload_identity[0]';
const HOST = (environment) => `dryscope-api-${environment}-570228742694.us-central1.run.app`;
const APP_ID = '1:570228742694:web:0123456789abcdef';

describe.each(['test', 'live'])('data root, %s: the TC-9 bundle', (environment) => {
  const plan = () => load(environment);
  const edit = (address, fn) => {
    const changed = plan();
    fn(find(changed, address).change.after);
    return check(changed, environment);
  };
  const withAppCheck = (after = {}) => {
    const changed = plan();
    changed.push(
      created(APP_CHECK, {
        project: 'dryscope',
        app_id: APP_ID,
        site_key: null,
        token_ttl: '3600s',
        ...after,
      }),
    );
    return check(changed, environment);
  };

  test('the committed plan passes and enables every API the stage needs', () => {
    expect(check(plan(), environment)).toEqual([]);
    for (const api of TC_APIS) {
      expect(find(plan(), `google_project_service.apis["${api}"]`).change.after).toMatchObject({
        service: api,
        disable_on_destroy: false,
      });
    }
  });

  test.each(TC_APIS)('a plan without %s is refused', (api) => {
    const address = `google_project_service.apis["${api}"]`;
    const changed = plan().filter((rc) => rc.address !== address);
    expect(check(changed, environment)).toEqual([`${address}: expected in the plan but missing`]);
  });

  test('the web app writes traces: one role, one account, no condition', () => {
    expect(find(plan(), TRACES).change.after).toMatchObject({
      project: 'dryscope',
      role: 'roles/telemetry.tracesWriter',
      member: account(`dryscope-api-${environment}`),
      condition: [],
    });
  });

  test.each([
    ['names the relay', (a) => (a.member = account(`dryscope-live-${environment}`))],
    ['names the other environment’s web app', (a) => (a.member = account('dryscope-api-other'))],
    ['names a group', (a) => (a.member = 'group:everyone@example.com')],
    ['is Cloud Trace admin', (a) => (a.role = 'roles/cloudtrace.admin')],
    ['is Telemetry writer for every signal', (a) => (a.role = 'roles/telemetry.writer')],
    [
      'carries a condition',
      (a) => (a.condition = [{ expression: "resource.name == 'projects/dryscope'", title: 't' }]),
    ],
  ])('a trace grant that %s is refused', (_, fn) => {
    expect(edit(TRACES, fn)).not.toEqual([]);
  });

  test('a trace grant for the migrator is refused', () => {
    const changed = plan();
    changed.push(
      created('google_project_iam_member.traces_writer["migrate"]', {
        project: 'dryscope',
        role: 'roles/telemetry.tracesWriter',
        member: account(`dryscope-migrate-${environment}`),
        condition: [],
      }),
    );
    expect(check(changed, environment)).toEqual([
      'google_project_iam_member.traces_writer["migrate"]: not in the expected data inventory',
    ]);
  });

  test('the image repository is scanned as the project says', () => {
    expect(find(plan(), REPO).change.after.vulnerability_scanning_config).toMatchObject([
      { enablement_config: 'INHERITED' },
    ]);
    expect(edit(REPO, (a) => (a.vulnerability_scanning_config = []))).toHaveLength(1);
    expect(
      edit(REPO, (a) => (a.vulnerability_scanning_config[0].enablement_config = 'DISABLED')),
    ).toHaveLength(1);
  });

  test('the reCAPTCHA key scores this environment’s app host only', () => {
    const after = find(plan(), KEY).change.after;
    expect(after).toMatchObject({ project: 'dryscope', deletion_policy: 'PREVENT' });
    expect(after.web_settings[0]).toMatchObject({
      integration_type: 'SCORE',
      allow_all_domains: false,
      allow_amp_traffic: false,
      allowed_domains: [HOST(environment)],
    });
  });

  test.each([
    ['adds localhost', (w) => w.allowed_domains.push('localhost')],
    ['adds 127.0.0.1', (w) => w.allowed_domains.push('127.0.0.1')],
    ['admits every run.app host', (w) => (w.allowed_domains = ['run.app'])],
    ['lists a wildcard', (w) => (w.allowed_domains = [`*.${HOST(environment)}`])],
    [
      'names the other environment’s host',
      (w) => (w.allowed_domains = [HOST(environment === 'test' ? 'live' : 'test')]),
    ],
    ['admits every domain', (w) => (w.allow_all_domains = true)],
    ['admits AMP pages', (w) => (w.allow_amp_traffic = true)],
    ['shows a checkbox', (w) => (w.integration_type = 'CHECKBOX')],
    ['challenges invisibly', (w) => (w.integration_type = 'INVISIBLE')],
    [
      'adds challenge settings',
      (w) => (w.challenge_settings = [{ default_settings: [{ score_threshold: 0.5 }] }]),
    ],
  ])('a key that %s is refused', (_, fn) => {
    expect(edit(KEY, (a) => fn(a.web_settings[0]))).not.toEqual([]);
  });

  test.each([
    ['gives a fixed testing score', (a) => (a.testing_options = [{ testing_score: 1 }])],
    ['is also an Android key', (a) => (a.android_settings = [{ allow_all_package_names: true }])],
    ['may be deleted by the provider', (a) => (a.deletion_policy = 'DELETE')],
    ['is in another project', (a) => (a.project = 'alert-disaster-field-2026')],
  ])('a key that %s is refused', (_, fn) => {
    expect(edit(KEY, fn)).not.toEqual([]);
  });

  test('App Check is registered only once a web app id of this project is given', () => {
    expect(find(plan(), APP_CHECK)).toBeUndefined();
    expect(withAppCheck()).toEqual([]);
    expect(withAppCheck({ app_id: '1:123456789012:web:0123456789abcdef' })).toHaveLength(1);
    expect(withAppCheck({ app_id: '1:570228742694:android:0123456789abcdef' })).toHaveLength(1);
    expect(withAppCheck({ token_ttl: '604800s' })).toHaveLength(1);
    expect(withAppCheck({ project: 'alert-disaster-field-2026' })).toHaveLength(1);
  });

  test('evidence: one rule deleting noncurrent versions after 28 days, then 7 days of soft delete', () => {
    const after = find(plan(), BUCKET).change.after;
    expect(after.soft_delete_policy[0].retention_duration_seconds).toBe(7 * 86400);
    expect(after.lifecycle_rule).toHaveLength(1);
    expect(after.lifecycle_rule[0].action).toMatchObject([{ type: 'Delete' }]);
    expect(after.lifecycle_rule[0].condition).toMatchObject([
      { with_state: 'ARCHIVED', days_since_noncurrent_time: 28 },
    ]);
  });

  test.each([
    [
      'a soft delete of 30 days',
      (a) => (a.soft_delete_policy[0].retention_duration_seconds = 30 * 86400),
    ],
    [
      'a soft delete of 8 days',
      (a) => (a.soft_delete_policy[0].retention_duration_seconds = 8 * 86400),
    ],
    ['no lifecycle rule', (a) => (a.lifecycle_rule = [])],
    [
      'noncurrent versions kept 29 days',
      (a) => (a.lifecycle_rule[0].condition[0].days_since_noncurrent_time = 29),
    ],
    [
      'the rule reaching live objects',
      (a) => (a.lifecycle_rule[0].condition[0].with_state = 'ANY'),
    ],
    [
      'the rule moving versions instead of deleting them',
      (a) => (a.lifecycle_rule[0].action[0].type = 'SetStorageClass'),
    ],
    [
      'the rule narrowed to one prefix',
      (a) => (a.lifecycle_rule[0].condition[0].matches_prefix = ['photos/']),
    ],
    [
      'the rule narrowed to versions with three newer ones',
      (a) => (a.lifecycle_rule[0].condition[0].num_newer_versions = 3),
    ],
    ['the rule with no state', (a) => delete a.lifecycle_rule[0].condition[0].with_state],
    ['a second rule', (a) => a.lifecycle_rule.push(structuredClone(a.lifecycle_rule[0]))],
    ['a retention lock', (a) => (a.retention_policy = [{ retention_period: 86400 }])],
  ])('a bucket with %s is refused', (_, fn) => {
    expect(edit(BUCKET, fn)).not.toEqual([]);
  });

  test('Cloud SQL keeps at most 30 backups, counted', () => {
    const retention = (a) => a.settings[0].backup_configuration[0].backup_retention_settings[0];
    expect(retention(find(plan(), SQL).change.after).retained_backups).toBeLessThanOrEqual(30);
    expect(edit(SQL, (a) => (retention(a).retained_backups = 30))).toEqual([]);
    expect(edit(SQL, (a) => (retention(a).retained_backups = 31))).toHaveLength(1);
    expect(edit(SQL, (a) => (retention(a).retained_backups = 365))).toHaveLength(1);
    expect(edit(SQL, (a) => (retention(a).retention_unit = 'DAYS'))).toHaveLength(1);
  });

  test('Cloud SQL keeps its backups after deletion and takes a final one kept at most 35 days', () => {
    const settings = (a) => a.settings[0];
    expect(settings(find(plan(), SQL).change.after)).toMatchObject({
      retain_backups_on_delete: true,
      final_backup_config: [{ enabled: true, retention_days: expect.any(Number) }],
    });
    const final = (a) => settings(a).final_backup_config[0];
    expect(edit(SQL, (a) => (final(a).retention_days = 35))).toEqual([]);
    expect(edit(SQL, (a) => (final(a).retention_days = 36))).toHaveLength(1);
    expect(edit(SQL, (a) => (final(a).retention_days = 365))).toHaveLength(1);
    expect(edit(SQL, (a) => (final(a).enabled = false))).toHaveLength(1);
    expect(edit(SQL, (a) => (settings(a).retain_backups_on_delete = false))).toHaveLength(1);
    expect(edit(SQL, (a) => (settings(a).final_backup_config = []))).not.toEqual([]);
  });

  test('an applied instance may be updated in place to add exactly those two settings', () => {
    const moved = (mutate = () => {}) => {
      const changed = structuredClone(plan());
      const rc = find(changed, SQL);
      rc.change.actions = ['update'];
      rc.change.before = structuredClone(rc.change.after);
      delete rc.change.before.settings[0].final_backup_config;
      rc.change.before.settings[0].retain_backups_on_delete = false;
      mutate(rc.change);
      return check(changed, environment);
    };
    expect(moved()).toEqual([]);
    expect(moved((c) => (c.before.settings[0].tier = 'db-g1-small'))).not.toEqual([]);
  });

  test('the Service Health API is enabled for the incident alert', () => {
    expect(TC_APIS).toContain('servicehealth.googleapis.com');
    expect(
      find(plan(), 'google_project_service.apis["servicehealth.googleapis.com"]'),
    ).toBeTruthy();
  });

  test('the field database is backed up daily and kept 14 days', () => {
    expect(find(plan(), SCHEDULE).change.after).toMatchObject({
      project: 'dryscope',
      database: `dryscope-field-${environment}`,
      retention: '1209600s',
      daily_recurrence: [{}],
    });
  });

  test.each([
    ['keeps backups 14 weeks', (a) => (a.retention = '8467200s')],
    ['is weekly', (a) => ((a.daily_recurrence = []), (a.weekly_recurrence = [{ day: 'SUNDAY' }]))],
    [
      'backs up the other environment’s database',
      (a) => (a.database = `dryscope-field-${environment === 'test' ? 'live' : 'test'}`),
    ],
    ['backs up the default database', (a) => (a.database = '(default)')],
  ])('a backup schedule that %s is refused', (_, fn) => {
    expect(edit(SCHEDULE, fn)).not.toEqual([]);
  });

  test('a plan without the backup schedule is refused', () => {
    const changed = plan().filter((rc) => rc.address !== SCHEDULE);
    expect(check(changed, environment)).toEqual([`${SCHEDULE}: expected in the plan but missing`]);
  });

  test('keyless sign-in takes the numeric repository id and refuses the repository name', () => {
    const withBinding = (member) => {
      const changed = plan();
      changed.push(
        created(WIF, {
          role: 'roles/iam.workloadIdentityUser',
          member,
          service_account_id: `projects/dryscope/serviceAccounts/dryscope-deploy-${environment}@dryscope.iam.gserviceaccount.com`,
          condition: [],
        }),
      );
      return check(changed, environment);
    };
    const pool = `principalSet://iam.googleapis.com/projects/570228742694/locations/global/workloadIdentityPools/dryscope-${environment}`;
    expect(withBinding(`${pool}/attribute.repository_id/1413863528`)).toEqual([]);
    expect(withBinding(`${pool}/attribute.repository/nnorman100/adr-field-estimator`)).toHaveLength(
      1,
    );
    expect(withBinding(`${pool}/attribute.repository_id/nnorman100`)).toHaveLength(1);
    expect(withBinding(`${pool}/attribute.repository_id/1413863528/x`)).toHaveLength(1);
  });

  test.each([TRACES, KEY, SCHEDULE, BUCKET, REPO])(
    'deleting or replacing %s is refused',
    (address) => {
      for (const actions of [['delete'], ['delete', 'create'], ['create', 'delete']]) {
        const changed = plan();
        find(changed, address).change.actions = actions;
        expect(check(changed, environment)).toContain(
          `${address}: plan would delete or replace it (${actions.join(', ')})`,
        );
      }
    },
  );
});

describe('data root, test: the release log line and the synthetic monitor', () => {
  const environment = 'test';
  const plan = () => load(environment);
  const edit = (address, fn) => {
    const changed = plan();
    fn(find(changed, address).change.after);
    return check(changed, environment);
  };

  test('the deploy account writes logs: one role, one account, no condition', () => {
    expect(find(plan(), LOG_WRITER).change.after).toMatchObject({
      project: 'dryscope',
      role: 'roles/logging.logWriter',
      member: account('dryscope-deploy-test'),
      condition: [],
    });
  });

  test.each([
    ['names the web app', (a) => (a.member = account('dryscope-api-test'))],
    ['is logging admin', (a) => (a.role = 'roles/logging.admin')],
    ['can read logs', (a) => (a.role = 'roles/logging.viewer')],
    [
      'carries a condition',
      (a) => (a.condition = [{ expression: 'true', title: 't', description: '' }]),
    ],
  ])('a log grant that %s is refused', (_, fn) => {
    expect(edit(LOG_WRITER, fn)).not.toEqual([]);
  });

  test('the synthetic account reads its own password secret and nothing else', () => {
    expect(find(plan(), SYNTHETIC).change.after.account_id).toBe('dryscope-synthetic-test');
    expect(find(plan(), SYNTHETIC_SECRET).change.after).toMatchObject({
      secret_id: 'dryscope-test-synthetic-password',
    });
    expect(find(plan(), SYNTHETIC_READ).change.after).toMatchObject({
      role: 'roles/secretmanager.secretAccessor',
      member: account('dryscope-synthetic-test'),
      secret_id: 'dryscope-test-synthetic-password',
      condition: [],
    });
    const memberships = plan().filter((rc) =>
      [rc.change.after?.member].includes(account('dryscope-synthetic-test')),
    );
    expect(memberships.map((rc) => rc.address)).toEqual([SYNTHETIC_READ]);
  });

  test.each([
    ['names the web app', (a) => (a.member = account('dryscope-api-test'))],
    ['is on another secret', (a) => (a.secret_id = 'dryscope-test-stripe-secret-key')],
    ['administers the secret', (a) => (a.role = 'roles/secretmanager.admin')],
    ['manages versions', (a) => (a.role = 'roles/secretmanager.secretVersionManager')],
  ])('a synthetic password grant that %s is refused', (_, fn) => {
    expect(edit(SYNTHETIC_READ, fn)).not.toEqual([]);
  });

  test('a synthetic password replicated outside the region is refused', () => {
    expect(
      edit(SYNTHETIC_SECRET, (a) => {
        a.replication[0].user_managed[0].replicas[0].location = 'us-west2';
      }),
    ).toHaveLength(1);
  });

  test('the web app reading the synthetic password is refused', () => {
    const changed = plan();
    changed.push(
      created('google_secret_manager_secret_iam_member.accessor["synthetic-password/api"]', {
        project: 'dryscope',
        secret_id: 'dryscope-test-synthetic-password',
        role: 'roles/secretmanager.secretAccessor',
        member: account('dryscope-api-test'),
        condition: [],
      }),
    );
    expect(check(changed, environment)).toEqual([
      'google_secret_manager_secret_iam_member.accessor["synthetic-password/api"]: not in the expected data inventory',
    ]);
  });
});

describe('data root, live: no release log line and no synthetic monitor', () => {
  const testPlan = load('test');
  test.each([LOG_WRITER, SYNTHETIC, SYNTHETIC_SECRET, SYNTHETIC_READ])(
    'a live plan holding %s is refused',
    (address) => {
      expect(find(load('live'), address)).toBeUndefined();
      const changed = load('live');
      changed.push(structuredClone(find(testPlan, address)));
      expect(check(changed, 'live')).toContain(`${address}: not in the expected data inventory`);
    },
  );
});

// Test's data root is already applied: its re-apply plan creates the new resources, changes the
// evidence bucket (the lifecycle rule) and the image repository (the scanning setting) in place, and
// leaves everything else alone. The bucket also stands for live's, whose soft delete moves from 30
// days to 7 if it was applied first.
describe.each(['test', 'live'])('data root, %s: re-applying with TC-9', (environment) => {
  const NEW = new Set([
    ...TC_APIS.map((api) => `google_project_service.apis["${api}"]`),
    TRACES,
    LOG_WRITER,
    SYNTHETIC,
    SYNTHETIC_SECRET,
    SYNTHETIC_READ,
    KEY,
    SCHEDULE,
  ]);
  const reapply = () =>
    load(environment).map((rc) => {
      if (NEW.has(rc.address)) return rc;
      if (rc.address !== BUCKET && rc.address !== REPO) {
        return { ...rc, change: { ...rc.change, actions: ['no-op'] } };
      }
      const before = structuredClone(rc.change.after);
      if (rc.address === BUCKET) {
        before.lifecycle_rule = [];
        before.soft_delete_policy[0].retention_duration_seconds =
          (environment === 'live' ? 30 : 7) * 86400;
        before.soft_delete_policy[0].effective_time = '2026-11-09T04:30:00.000Z';
      } else {
        before.vulnerability_scanning_config = [];
      }
      before.updated = '2026-11-09T04:30:00.000Z';
      const after = { ...structuredClone(rc.change.after), updated: null };
      if (rc.address === BUCKET) after.soft_delete_policy[0].effective_time = null;
      return {
        ...rc,
        change: {
          actions: ['update'],
          before,
          after,
          after_unknown: {
            updated: true,
            ...(rc.address === BUCKET ? { soft_delete_policy: [{ effective_time: true }] } : {}),
          },
        },
      };
    });

  test('creating the new resources and the two named in-place changes passes', () => {
    const plan = reapply();
    const updates = plan.filter((rc) => rc.change.actions.join() === 'update');
    expect(updates.map((rc) => rc.address).sort()).toEqual([REPO, BUCKET].sort());
    expect(check(plan, environment)).toEqual([]);
  });

  test.each([
    [BUCKET, 'turns versioning off', (a) => (a.versioning[0].enabled = false)],
    [BUCKET, 'changes the storage class', (a) => (a.storage_class = 'NEARLINE')],
    [BUCKET, 'opens public access', (a) => (a.public_access_prevention = 'inherited')],
    [REPO, 'lets tags move', (a) => (a.docker_config[0].immutable_tags = false)],
    [REPO, 'changes the description', (a) => (a.description = 'other')],
  ])('an update of %s that also %s is refused', (address, _, fn) => {
    const plan = reapply();
    fn(find(plan, address).change.after);
    expect(check(plan, environment)).toContain(
      `${address}: plan would change it in place; a first apply only creates`,
    );
  });

  test('an in-place update to the wrong rule is still held to the table', () => {
    const plan = reapply();
    find(plan, BUCKET).change.after.lifecycle_rule[0].condition[0].days_since_noncurrent_time = 90;
    const problems = check(plan, environment);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      /^google_storage_bucket\.evidence: lifecycle_rule is .*"days_since_noncurrent_time":90.*, expected one rule deleting noncurrent \(ARCHIVED\) versions 28 days after they stop being live$/,
    );
  });

  test.each([
    'google_firestore_database.field',
    'google_sql_database_instance.main',
    'google_secret_manager_secret.app["link-signing-key"]',
  ])('an in-place update of %s is still refused', (address) => {
    const plan = reapply();
    const rc = find(plan, address);
    rc.change = {
      actions: ['update'],
      before: structuredClone(rc.change.after),
      after: rc.change.after,
    };
    rc.change.after = { ...rc.change.after, labels: { app: 'other' } };
    expect(check(plan, environment)).toContain(
      `${address}: plan would change it in place; a first apply only creates`,
    );
  });
});
