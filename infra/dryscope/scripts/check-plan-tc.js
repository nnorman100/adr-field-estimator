'use strict';
// The stage TC part of the closed-set plan table (check-plan.js): the data-root bundle of
// docs/plans/TC.md, step TC-9. Kept apart so check-plan.js stays under the file-length limit;
// check-plan.js calls addTcData for the data root and fieldUpdate for its named exceptions.
//   - the stage's APIs;
//   - roles/telemetry.tracesWriter for the web app, project-wide with no condition (the Telemetry API
//     takes no IAM resource condition, and one would silently drop every span);
//   - roles/logging.logWriter for test's deploy account (the failed-release line, TC-8), no condition;
//   - the synthetic monitor's account and its one secret, read only by it (test only);
//   - container scanning set explicitly on the image repository;
//   - the reCAPTCHA Enterprise key (score only, this environment's app host only) and, once the owner
//     passes the web app id, its App Check registration;
//   - the 35-day backup window (D-023): the evidence bucket's noncurrent-version rule and 7-day soft
//     delete, at most 30 Cloud SQL backups, and a daily Firestore backup kept 14 days.
const PROJECT_NUMBER = '570228742694';
const REGION = 'us-central1';

const TC_APIS = [
  'billingbudgets.googleapis.com',
  'cloudbuild.googleapis.com',
  'clouderrorreporting.googleapis.com',
  'cloudfunctions.googleapis.com',
  'cloudtrace.googleapis.com',
  'containerscanning.googleapis.com',
  'firebaseappcheck.googleapis.com',
  'monitoring.googleapis.com',
  'recaptchaenterprise.googleapis.com',
  'run.googleapis.com',
  'telemetry.googleapis.com',
];

// D-023: 28 days as a noncurrent version, then 7 of soft delete.
const NONCURRENT_DAYS = 28;
const SOFT_DELETE_SECONDS = 7 * 86400;
// The bucket's one lifecycle rule: delete a version NONCURRENT_DAYS after it stopped being live, only
// noncurrent versions (ARCHIVED). Every other condition must be unset: conditions combine with AND,
// so one more (a prefix, a size, a version count) would keep some versions past the window. The
// provider's send_*_if_zero flags only send a paired value that is 0, and those values must be unset.
// Judged as one value, so a wrong rule is one problem.
const isWindowRule = (rule) => {
  const [action, ...moreActions] = rule?.action ?? [];
  const [condition, ...moreConditions] = rule?.condition ?? [];
  if (moreActions.length || moreConditions.length || !condition) return false;
  if (action?.type !== 'Delete' || action.storage_class) return false;
  if (condition.with_state !== 'ARCHIVED') return false;
  if (condition.days_since_noncurrent_time !== NONCURRENT_DAYS) return false;
  return Object.entries(condition).every(([field, value]) => {
    if (field === 'with_state') return value === 'ARCHIVED';
    if (field === 'days_since_noncurrent_time') return value === NONCURRENT_DAYS;
    if (field.startsWith('send_') && field.endsWith('_if_zero'))
      return value == null || typeof value === 'boolean';
    return value == null || value === '' || (Array.isArray(value) && value.length === 0);
  });
};
const windowRules = Object.assign(
  (rules) => Array.isArray(rules) && rules.length === 1 && isWindowRule(rules[0]),
  {
    toString: () =>
      `one rule deleting noncurrent (ARCHIVED) versions ${NONCURRENT_DAYS} days after they stop being live`,
  },
);
// A named check reads better in a problem line than the function's source.
const between = (min, max) =>
  Object.assign((n) => Number.isInteger(n) && n >= min && n <= max, {
    toString: () => `${min} to ${max}`,
  });

/**
 * Adds the TC-9 resources, grants and settings for `env` to the table being built by
 * check-plan.js's expectedPlan.
 */
function addTcData(env, { sa, others, grants, attrs, absent, optional }) {
  for (const api of TC_APIS) {
    const address = `google_project_service.apis["${api}"]`;
    others.push(address);
    attrs[address] = { service: api };
  }

  // One grant each: one role, one account, the exact (absent) condition.
  grants['google_project_iam_member.traces_writer["api"]'] = {
    role: 'roles/telemetry.tracesWriter',
    member: sa('api'),
    condition: null,
  };

  // The image repository follows the project's Container Scanning API (C5 A).
  attrs['google_artifact_registry_repository.images'] = {
    ...attrs['google_artifact_registry_repository.images'],
    'vulnerability_scanning_config.0.enablement_config': 'INHERITED',
  };

  // The website key App Check uses: score only, this environment's app host only.
  const key = 'google_recaptcha_enterprise_key.web';
  others.push(key);
  attrs[key] = {
    deletion_policy: 'PREVENT',
    'web_settings.0.integration_type': 'SCORE',
    'web_settings.0.allow_all_domains': false,
    'web_settings.0.allow_amp_traffic': false,
    'web_settings.0.allowed_domains': [`dryscope-api-${env}-${PROJECT_NUMBER}.${REGION}.run.app`],
  };
  absent[key] = [
    'testing_options',
    'android_settings',
    'ios_settings',
    'waf_settings',
    'web_settings.0.challenge_settings',
    'web_settings.1',
  ];
  // Registered only once the owner passes this project's web app id.
  const appCheck = 'google_firebase_app_check_recaptcha_enterprise_config.web[0]';
  others.push(appCheck);
  optional.add(appCheck);
  attrs[appCheck] = {
    app_id: new RegExp(`^1:${PROJECT_NUMBER}:web:[0-9a-f]+$`),
    token_ttl: '3600s',
  };

  // D-023: the 35-day backup window.
  const bucket = 'google_storage_bucket.evidence';
  attrs[bucket] = {
    ...attrs[bucket],
    'soft_delete_policy.0.retention_duration_seconds': SOFT_DELETE_SECONDS,
    lifecycle_rule: windowRules,
  };
  const sql = 'google_sql_database_instance.main';
  attrs[sql] = {
    ...attrs[sql],
    'settings.0.backup_configuration.0.backup_retention_settings.0.retention_unit': 'COUNT',
    'settings.0.backup_configuration.0.backup_retention_settings.0.retained_backups': between(
      7,
      30,
    ),
  };
  const schedule = 'google_firestore_backup_schedule.field_daily';
  others.push(schedule);
  attrs[schedule] = {
    database: `dryscope-field-${env}`,
    retention: '1209600s',
    daily_recurrence: [{}],
  };
  absent[schedule] = ['weekly_recurrence'];

  // Test only: the deploy account's log line (the release workflow releases to test only) and the
  // synthetic monitor's account, secret and read grant. A live plan holding any is refused.
  if (env === 'test') {
    grants['google_project_iam_member.deploy_log_writer[0]'] = {
      role: 'roles/logging.logWriter',
      member: sa('deploy'),
      condition: null,
    };
    others.push('google_service_account.synthetic[0]');
    attrs['google_service_account.synthetic[0]'] = { account_id: `dryscope-synthetic-${env}` };
    const secret = 'google_secret_manager_secret.synthetic_password[0]';
    others.push(secret);
    attrs[secret] = {
      secret_id: `dryscope-${env}-synthetic-password`,
      'replication.0.user_managed.0.replicas.0.location': REGION,
    };
    absent[secret] = ['replication.0.auto', 'replication.0.user_managed.0.replicas.1'];
    grants['google_secret_manager_secret_iam_member.synthetic_password[0]'] = {
      role: 'roles/secretmanager.secretAccessor',
      member: sa('synthetic'),
      condition: null,
      secret_id: `dryscope-${env}-synthetic-password`,
    };
  }
}

// Already-applied data resources that TC-9 changes in place, and the only top-level fields each such
// update may change. Their new values are held to the table above on every plan.
const FIELD_UPDATES = {
  'google_storage_bucket.evidence': ['lifecycle_rule', 'soft_delete_policy'],
  'google_artifact_registry_repository.images': ['vulnerability_scanning_config'],
};

/**
 * True when `rc` is an in-place update of a FIELD_UPDATES resource that changes nothing but its
 * listed fields. Values the provider recomputes (marked unknown) are dropped from both sides; every
 * other attribute must be equal.
 */
function fieldUpdate(rc, actions) {
  const fields = FIELD_UPDATES[rc.address];
  const { before, after, after_unknown: unknown = {} } = rc.change ?? {};
  if (!fields || actions.length !== 1 || actions[0] !== 'update' || !before || !after) {
    return false;
  }
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
  const rest = (state) => {
    const copy = { ...state };
    for (const field of fields) delete copy[field];
    return JSON.stringify(scrub(copy, unknown));
  };
  return rest(before) === rest(after);
}

module.exports = { addTcData, fieldUpdate, FIELD_UPDATES, TC_APIS };
