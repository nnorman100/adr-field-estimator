// Plan-check cases for the AI infrastructure bundle (docs/plans/S7.md, step S7-2):
//   - data root (infra/dryscope/data/ai.tf): the Model Armor text template and floor setting with
//     their logging off, inspect-and-block and the pinned filter version; roles/modelarmor.user for
//     the web app and the relay, one account per grant; the test-only evaluation account (V9 B) and
//     its keyless binding;
//   - app root (cloud_run.tf): the AI settings of both services, the relay's concurrency of 20 in
//     test, and the in-place update that adds them to services already applied.
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
const { checkConfig, PROTECTED } = require(path.join(SCRIPTS, 'check-guards.js'));

function load(root, environment) {
  const file = path.join(ROOT, 'infra', 'dryscope', 'fixtures', `${root}-${environment}.plan.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8')).resource_changes;
}

const find = (plan, address) => plan.find((rc) => rc.address === address);
const check = (plan, root, environment) => checkPlan(plan, { root, environment });
const account = (name) => `serviceAccount:${name}@dryscope.iam.gserviceaccount.com`;
const created = (address, after) => ({
  address,
  type: address.split('.')[0],
  change: { actions: ['create'], after },
});

const TEMPLATE = 'google_model_armor_template.text';
const FLOOR = 'google_model_armor_floorsetting.project[0]';
const EVAL = 'google_service_account.eval[0]';
const EVAL_GRANTS = [
  'google_project_iam_member.eval["predict"]',
  'google_project_iam_member.eval["modelarmor"]',
];
const EVAL_WIF = 'google_service_account_iam_member.eval_workload_identity[0]';
const ARMOR_USER = (k) => `google_project_iam_member.modelarmor_user["${k}"]`;
const PRINCIPAL_SET =
  'principalSet://iam.googleapis.com/projects/570228742694/locations/global/workloadIdentityPools/dryscope-test/attribute.repository_id/1413863528';

describe.each(['test', 'live'])('data root, %s: Model Armor', (environment) => {
  const plan = () => load('data', environment);
  const edit = (address, fn) => {
    const changed = plan();
    fn(find(changed, address).change.after);
    return check(changed, 'data', environment);
  };

  test('the committed plan passes, with the Model Armor API in the list', () => {
    expect(check(plan(), 'data', environment)).toEqual([]);
    expect(find(plan(), 'google_project_service.apis["modelarmor.googleapis.com"]')).toBeDefined();
  });

  test('the text template is this environment’s, pinned, blocking and not logging', () => {
    const after = find(plan(), TEMPLATE).change.after;
    expect(after).toMatchObject({
      project: 'dryscope',
      location: 'us-central1',
      template_id: `dryscope-text-${environment}`,
      deletion_policy: 'PREVENT',
    });
    expect(after.template_metadata[0]).toMatchObject({
      enforcement_type: 'INSPECT_AND_BLOCK',
      log_sanitize_operations: false,
      log_template_operations: false,
      filter_version_selector: [{ version: 'v3', alias: null }],
    });
  });

  test.each([
    ['sanitize logging is on', (a) => (a.template_metadata[0].log_sanitize_operations = true)],
    ['template logging is on', (a) => (a.template_metadata[0].log_template_operations = true)],
    ['sanitize logging is unset', (a) => (a.template_metadata[0].log_sanitize_operations = null)],
    ['it only inspects', (a) => (a.template_metadata[0].enforcement_type = 'INSPECT_ONLY')],
    [
      'it follows the Latest alias',
      (a) =>
        (a.template_metadata[0].filter_version_selector = [
          { version: null, alias: 'FILTER_VERSION_ALIAS_LATEST' },
        ]),
    ],
    [
      'it adds an alias beside the version',
      (a) =>
        (a.template_metadata[0].filter_version_selector[0].alias = 'FILTER_VERSION_ALIAS_STABLE'),
    ],
    [
      'the version is another',
      (a) => (a.template_metadata[0].filter_version_selector[0].version = 'v4'),
    ],
    [
      'it ignores failed detectors',
      (a) => (a.template_metadata[0].ignore_partial_invocation_failures = true),
    ],
    [
      'a Responsible AI filter is dropped',
      (a) => a.filter_config[0].rai_settings[0].rai_filters.pop(),
    ],
    [
      'a Responsible AI filter is high only',
      (a) => (a.filter_config[0].rai_settings[0].rai_filters[0].confidence_level = 'HIGH'),
    ],
    [
      'prompt injection detection is off',
      (a) =>
        (a.filter_config[0].pi_and_jailbreak_filter_settings[0].filter_enforcement = 'DISABLED'),
    ],
    [
      'malicious URL detection is off',
      (a) => (a.filter_config[0].malicious_uri_filter_settings[0].filter_enforcement = 'DISABLED'),
    ],
    [
      'Sensitive Data Protection is off',
      (a) => (a.filter_config[0].sdp_settings[0].basic_config[0].filter_enforcement = 'DISABLED'),
    ],
    ['it is named for the other environment', (a) => (a.template_id = 'dryscope-text-other')],
    ['it is in another region', (a) => (a.location = 'us')],
    ['the provider may delete it', (a) => (a.deletion_policy = 'DELETE')],
    ['it is in another project', (a) => (a.project = 'alert-disaster-field-2026')],
  ])('a text template where %s is refused', (_, fn) => {
    expect(edit(TEMPLATE, fn)).not.toEqual([]);
  });

  test('sanitize access is roles/modelarmor.user for the web app and the relay, one account each, no condition', () => {
    for (const k of ['api', 'live']) {
      expect(find(plan(), ARMOR_USER(k)).change.after).toMatchObject({
        role: 'roles/modelarmor.user',
        member: account(`dryscope-${k}-${environment}`),
      });
    }
    expect(find(plan(), ARMOR_USER('migrate'))).toBeUndefined();
  });

  test.each([
    ['names another account', (a) => (a.member = account(`dryscope-migrate-${environment}`))],
    ['names a group', (a) => (a.member = 'group:everyone@example.com')],
    ['is a wider role', (a) => (a.role = 'roles/modelarmor.admin')],
    [
      'carries a condition',
      (a) => (a.condition = [{ expression: 'true', title: 't', description: '' }]),
    ],
  ])('a sanitize grant that %s is refused', (_, fn) => {
    expect(edit(ARMOR_USER('live'), fn)).not.toEqual([]);
  });

  test('a sanitize grant for the migrator is refused', () => {
    const changed = plan();
    changed.push(
      created(ARMOR_USER('migrate'), {
        project: 'dryscope',
        role: 'roles/modelarmor.user',
        member: account(`dryscope-migrate-${environment}`),
        condition: [],
      }),
    );
    expect(check(changed, 'data', environment)).toEqual([
      `${ARMOR_USER('migrate')}: not in the expected data inventory`,
    ]);
  });

  test('the template and the floor setting are destroy-guarded', () => {
    expect(PROTECTED.data).toEqual(expect.arrayContaining([TEMPLATE, FLOOR]));
    const dir = path.join(ROOT, 'infra', 'dryscope', 'data');
    expect(checkConfig(dir, 'data')).toEqual([]);
  });
});

describe('data root, test: the floor setting and the evaluation account', () => {
  const environment = 'test';
  const plan = () => load('data', environment);
  const edit = (address, fn) => {
    const changed = plan();
    fn(find(changed, address).change.after);
    return check(changed, 'data', environment);
  };

  test('the floor setting blocks Agent Platform calls with no logging and the template’s filters', () => {
    const after = find(plan(), FLOOR).change.after;
    expect(after).toMatchObject({
      parent: 'projects/dryscope',
      location: 'global',
      enable_floor_setting_enforcement: true,
      integrated_services: ['AI_PLATFORM'],
      ai_platform_floor_setting: [{ inspect_and_block: true, enable_cloud_logging: false }],
    });
    expect(after.filter_config).toEqual(find(plan(), TEMPLATE).change.after.filter_config);
  });

  test.each([
    ['Cloud Logging is on', (a) => (a.ai_platform_floor_setting[0].enable_cloud_logging = true)],
    ['Cloud Logging is unset', (a) => (a.ai_platform_floor_setting[0].enable_cloud_logging = null)],
    ['it does not block', (a) => (a.ai_platform_floor_setting[0].inspect_and_block = false)],
    ['it inspects only', (a) => (a.ai_platform_floor_setting[0].inspect_only = true)],
    ['enforcement is off', (a) => (a.enable_floor_setting_enforcement = false)],
    ['Agent Platform is not integrated', (a) => (a.integrated_services = [])],
    [
      'MCP servers are added',
      (a) =>
        (a.google_mcp_server_floor_setting = [
          { inspect_and_block: true, enable_cloud_logging: true },
        ]),
    ],
    ['it is a folder’s', (a) => (a.parent = 'folders/123')],
    [
      'a filter is weaker than the template’s',
      (a) => (a.filter_config[0].pi_and_jailbreak_filter_settings[0].confidence_level = 'HIGH'),
    ],
  ])('a floor setting where %s is refused', (_, fn) => {
    expect(edit(FLOOR, fn)).not.toEqual([]);
  });

  test('the evaluation account can predict and screen and nothing else', () => {
    expect(find(plan(), EVAL).change.after.account_id).toBe('dryscope-eval-test');
    expect(find(plan(), EVAL_GRANTS[0]).change.after).toMatchObject({
      role: 'projects/dryscope/roles/dryscopeGeminiTest',
      member: account('dryscope-eval-test'),
    });
    expect(find(plan(), EVAL_GRANTS[1]).change.after).toMatchObject({
      role: 'roles/modelarmor.user',
      member: account('dryscope-eval-test'),
    });
  });

  test.each([
    ['holds a database role', 'roles/cloudsql.client'],
    ['holds a Vertex AI user role', 'roles/aiplatform.user'],
  ])('an evaluation grant that %s is refused', (_, role) => {
    expect(edit(EVAL_GRANTS[0], (a) => (a.role = role))).not.toEqual([]);
  });

  test('the keyless binding is accepted only on the evaluation account, for test’s scoped principal set', () => {
    const binding = (after) => {
      const changed = plan();
      changed.push(
        created(EVAL_WIF, {
          role: 'roles/iam.workloadIdentityUser',
          member: PRINCIPAL_SET,
          service_account_id:
            'projects/dryscope/serviceAccounts/dryscope-eval-test@dryscope.iam.gserviceaccount.com',
          condition: [],
          ...after,
        }),
      );
      return check(changed, 'data', environment);
    };
    expect(binding({})).toEqual([]);
    expect(
      binding({
        service_account_id:
          'projects/dryscope/serviceAccounts/dryscope-deploy-test@dryscope.iam.gserviceaccount.com',
      }),
    ).not.toEqual([]);
    expect(
      binding({ member: PRINCIPAL_SET.replace('dryscope-test', 'dryscope-live') }),
    ).not.toEqual([]);
    expect(binding({ member: PRINCIPAL_SET.replace(/attribute.*$/, '*') })).not.toEqual([]);
  });
});

describe('data root, live: no floor setting and no evaluation account', () => {
  const testPlan = load('data', 'test');
  test.each([FLOOR, EVAL, ...EVAL_GRANTS])('a live plan holding %s is refused', (address) => {
    expect(find(load('data', 'live'), address)).toBeUndefined();
    const changed = load('data', 'live');
    changed.push(structuredClone(find(testPlan, address)));
    expect(check(changed, 'data', 'live')).toContain(
      `${address}: not in the expected data inventory`,
    );
  });
});

describe.each(['test', 'live'])('app root, %s: AI settings', (environment) => {
  const SVC = (k) => `google_cloud_run_v2_service.svc["${k}"]`;
  const envOf = (state) => state.template[0].containers[0].env;
  const plain = (state) =>
    Object.fromEntries(
      envOf(state)
        .filter((e) => !e.value_source?.length)
        .map((e) => [e.name, e.value]),
    );
  const text = `projects/dryscope/locations/us-central1/templates/dryscope-text-${environment}`;
  const AI_NAMES = [
    'AI_TEXT_LOCATION',
    'AI_TEXT_MODEL',
    'AI_TRANSCRIBE_MODEL',
    'MODEL_ARMOR_TEXT_TEMPLATE',
    'MODEL_ARMOR_IMAGE_TEMPLATE',
    'LIVE_MODEL',
    'LIVE_LOCATION',
    'API_INTERNAL_URL',
    'RELAY_AUDIENCE',
  ];
  const concurrency = environment === 'test' ? 20 : 10;

  test('the committed plan passes and gives each service its own AI settings', () => {
    const plan = load('app', environment);
    expect(check(plan, 'app', environment)).toEqual([]);
    expect(plain(find(plan, SVC('api')).change.after)).toMatchObject({
      AI_TEXT_LOCATION: 'us',
      AI_TEXT_MODEL: 'gemini-3.8-flash',
      AI_TRANSCRIBE_MODEL: 'gemini-3.5-transcribe',
      MODEL_ARMOR_TEXT_TEMPLATE: text,
      MODEL_ARMOR_IMAGE_TEMPLATE: `projects/dryscope/locations/us/templates/dryscope-image-${environment}`,
    });
    const live = find(plan, SVC('live')).change.after;
    expect(plain(live)).toMatchObject({
      LIVE_MODEL: 'gemini-3.8-live',
      LIVE_LOCATION: 'us-central1',
      MODEL_ARMOR_TEXT_TEMPLATE: text,
      API_INTERNAL_URL: `https://dryscope-api-${environment}-570228742694.us-central1.run.app`,
      RELAY_AUDIENCE: `dryscope-${environment}-live`,
    });
    expect(live.template[0].max_instance_request_concurrency).toBe(concurrency);
  });

  test.each([
    ['api', 'AI_TEXT_LOCATION', 'us-central1'],
    ['api', 'AI_TEXT_LOCATION', 'global'],
    [
      'api',
      'MODEL_ARMOR_TEXT_TEMPLATE',
      'projects/dryscope/locations/us-central1/templates/dryscope-live-spike',
    ],
    [
      'api',
      'MODEL_ARMOR_IMAGE_TEMPLATE',
      `projects/dryscope/locations/global/templates/dryscope-image-${environment}`,
    ],
    ['live', 'LIVE_LOCATION', 'us'],
    ['live', 'API_INTERNAL_URL', 'https://example.com'],
    ['live', 'RELAY_AUDIENCE', `dryscope-${environment}-access-projection`],
  ])('the %s service with %s set to %s is refused', (k, name, value) => {
    const plan = load('app', environment);
    envOf(find(plan, SVC(k)).change.after).find((e) => e.name === name).value = value;
    expect(check(plan, 'app', environment)).not.toEqual([]);
  });

  test('a relay concurrency other than the table’s is refused', () => {
    const plan = load('app', environment);
    find(plan, SVC('live')).change.after.template[0].max_instance_request_concurrency = 80;
    expect(check(plan, 'app', environment)).toEqual([
      `${SVC('live')}: template.0.max_instance_request_concurrency is 80, expected ${concurrency}`,
    ]);
  });

  // Both services as applied before S7-2 (no AI settings, the relay at concurrency 10), planned as
  // an in-place update to the current configuration; the provider recomputes the etag.
  const reapply = () =>
    load('app', environment).map((rc) => {
      if (!rc.address.startsWith('google_cloud_run_v2_service.svc[')) {
        return { ...rc, change: { ...rc.change, actions: ['no-op'] } };
      }
      const before = structuredClone(rc.change.after);
      before.template[0].containers[0].env = envOf(before).filter(
        (e) => !AI_NAMES.includes(e.name),
      );
      if (rc.address === SVC('live')) before.template[0].max_instance_request_concurrency = 10;
      before.etag = 'applied-etag';
      const after = { ...structuredClone(rc.change.after), etag: null };
      return {
        ...rc,
        change: { actions: ['update'], before, after, after_unknown: { etag: true } },
      };
    });

  test('adding the AI settings and moving the relay’s concurrency in place passes', () => {
    expect(check(reapply(), 'app', environment)).toEqual([]);
  });

  test('the web app’s concurrency may not move in the same update', () => {
    const plan = reapply();
    find(plan, SVC('api')).change.after.template[0].max_instance_request_concurrency += 1;
    expect(check(plan, 'app', environment)).toEqual([
      `${SVC('api')}: plan would change it in place; a first apply only creates`,
    ]);
  });

  test('a relay setting added to the web app in the same update is refused', () => {
    const plan = reapply();
    envOf(find(plan, SVC('api')).change.after).push({
      name: 'RELAY_AUDIENCE',
      value: `dryscope-${environment}-live`,
      value_source: [],
    });
    expect(check(plan, 'app', environment)).toEqual([
      `${SVC('api')}: plan would change it in place; a first apply only creates`,
    ]);
  });

  test('another change beside the AI settings is still refused', () => {
    const plan = reapply();
    find(plan, SVC('live')).change.after.template[0].timeout = '60s';
    expect(check(plan, 'app', environment)).toEqual([
      `${SVC('live')}: plan would change it in place; a first apply only creates`,
    ]);
  });
});
