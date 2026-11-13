'use strict';
// The AI part of the closed-set plan table (check-plan.js): Model Armor, the evaluation account and
// the AI settings of the Cloud Run services (docs/plans/S7.md, step S7-2). Kept apart so check-plan.js
// stays under the file-length limit; check-plan.js calls addAiData for the data root and reads
// aiSettings and LIVE_CONCURRENCY for the app root.
const PROJECT = 'dryscope';
const PROJECT_NUMBER = '570228742694';
const REGION = 'us-central1';
const SERVICES = ['api', 'live'];
const title = (s) => s[0].toUpperCase() + s.slice(1);

// Model Armor (data root, ai.tf): the filters of the text template and the floor setting, the
// pinned filter version, and the AI settings Terraform gives each service (app root). Model Armor's
// own logging is off on both (hard rule 6): a template or floor setting that logs is refused.
const MODEL_ARMOR_CONFIDENCE = 'MEDIUM_AND_ABOVE';
const MODEL_ARMOR_FILTER_VERSION = 'v3';
const MODEL_ARMOR_FILTERS = {
  'filter_config.0.rai_settings.0.rai_filters': [
    'DANGEROUS',
    'HARASSMENT',
    'HATE_SPEECH',
    'SEXUALLY_EXPLICIT',
  ].map((filter_type) => ({ confidence_level: MODEL_ARMOR_CONFIDENCE, filter_type })),
  'filter_config.0.pi_and_jailbreak_filter_settings.0.filter_enforcement': 'ENABLED',
  'filter_config.0.pi_and_jailbreak_filter_settings.0.confidence_level': MODEL_ARMOR_CONFIDENCE,
  'filter_config.0.malicious_uri_filter_settings.0.filter_enforcement': 'ENABLED',
  'filter_config.0.sdp_settings.0.basic_config.0.filter_enforcement': 'ENABLED',
};
const aiSettings = (env) => {
  const text = `projects/${PROJECT}/locations/${REGION}/templates/dryscope-text-${env}`;
  return {
    api: {
      AI_TEXT_LOCATION: 'us',
      AI_TEXT_MODEL: 'gemini-3.8-flash',
      AI_TRANSCRIBE_MODEL: 'gemini-3.5-transcribe',
      MODEL_ARMOR_TEXT_TEMPLATE: text,
      MODEL_ARMOR_IMAGE_TEMPLATE: `projects/${PROJECT}/locations/us/templates/dryscope-image-${env}`,
    },
    live: {
      LIVE_MODEL: 'gemini-3.8-live',
      LIVE_LOCATION: REGION,
      MODEL_ARMOR_TEXT_TEMPLATE: text,
      API_INTERNAL_URL: `https://dryscope-api-${env}-${PROJECT_NUMBER}.${REGION}.run.app`,
      RELAY_AUDIENCE: `dryscope-${env}-live`,
    },
  };
};
// The Live relay's request concurrency: 20 walkthroughs an instance in test (S7-2), 10 in live
// until S7-16 measures it.
const LIVE_CONCURRENCY = { test: 20, live: 10 };

/**
 * Adds the data root's AI resources and grants for `env` to the table being built by
 * check-plan.js's expectedPlan. `wif` is the address of the deploy account's keyless binding, whose
 * member rule the evaluation account's binding shares.
 */
function addAiData(env, { sa, others, grants, attrs, absent, optional, wif }) {
  // Model Armor: this environment's text template, and sanitize access for the two services.
  // Project-wide with no condition: IAM Conditions cannot scope Model Armor by resource name.
  const template = 'google_model_armor_template.text';
  others.push(template);
  attrs[template] = {
    template_id: `dryscope-text-${env}`,
    location: REGION,
    deletion_policy: 'PREVENT',
    'template_metadata.0.enforcement_type': 'INSPECT_AND_BLOCK',
    'template_metadata.0.log_sanitize_operations': false,
    'template_metadata.0.log_template_operations': false,
    'template_metadata.0.filter_version_selector.0.version': MODEL_ARMOR_FILTER_VERSION,
    'template_metadata.0.multi_language_detection.0.enable_multi_language_detection': true,
    ...MODEL_ARMOR_FILTERS,
  };
  absent[template] = [
    // A version alias would let the filters change under a running feature.
    'template_metadata.0.filter_version_selector.0.alias',
    // Ignoring a failed detector would turn a failed screen into an allow.
    'template_metadata.0.ignore_partial_invocation_failures',
    'filter_config.0.sdp_settings.0.advanced_config',
  ];
  for (const k of SERVICES) {
    grants[`google_project_iam_member.modelarmor_user["${k}"]`] = {
      role: 'roles/modelarmor.user',
      member: sa(k),
      condition: null,
    };
  }
  // Test only: the project's floor setting (one per project, so one root owns it) and the
  // evaluation account (V9 B) with predict and sanitize, and its keyless binding once the owner
  // supplies test's principal set. A live plan holding any of them is refused.
  if (env === 'test') {
    const floor = 'google_model_armor_floorsetting.project[0]';
    others.push(floor);
    attrs[floor] = {
      parent: `projects/${PROJECT}`,
      location: 'global',
      enable_floor_setting_enforcement: true,
      integrated_services: ['AI_PLATFORM'],
      'ai_platform_floor_setting.0.inspect_and_block': true,
      'ai_platform_floor_setting.0.enable_cloud_logging': false,
      'floor_setting_metadata.0.multi_language_detection.0.enable_multi_language_detection': true,
      ...MODEL_ARMOR_FILTERS,
    };
    absent[floor] = [
      'ai_platform_floor_setting.0.inspect_only',
      'google_mcp_server_floor_setting',
      'filter_config.0.sdp_settings.0.advanced_config',
    ];
    others.push('google_service_account.eval[0]');
    attrs['google_service_account.eval[0]'] = { account_id: `dryscope-eval-${env}` };
    grants['google_project_iam_member.eval["predict"]'] = {
      role: `projects/${PROJECT}/roles/dryscopeGemini${title(env)}`,
      member: sa('eval'),
      condition: null,
    };
    grants['google_project_iam_member.eval["modelarmor"]'] = {
      role: 'roles/modelarmor.user',
      member: sa('eval'),
      condition: null,
    };
    const wifEval = 'google_service_account_iam_member.eval_workload_identity[0]';
    optional.add(wifEval);
    grants[wifEval] = {
      ...grants[wif],
      service_account_id: `projects/${PROJECT}/serviceAccounts/dryscope-eval-${env}@${PROJECT}.iam.gserviceaccount.com`,
    };
  }
}

module.exports = { addAiData, aiSettings, LIVE_CONCURRENCY, MODEL_ARMOR_FILTER_VERSION };
