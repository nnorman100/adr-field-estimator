// The one list of runtime settings the app and the Cloud Run Terraform (infra/dryscope/app) agree
// on. src/lib/config.ts builds its schema from this list's types, and tests/unit/settings-contract
// .test.ts reads the Terraform and fails when the two disagree, so a setting cannot be renamed on
// one side only (the way FIREBASE_PROJECT_ID and GOOGLE_CLOUD_PROJECT once were).
//
// To add or rename a setting: change this list, config.ts and the Terraform in the same PR. Names
// only; no values and no secrets belong here. Settings Terraform fills from Secret Manager are
// listed by name like any other, so a secret added in infra/dryscope/modules/naming fails the test
// until it is listed here too.

// The deployed services that receive settings from Terraform: the web app (dryscope-api-<env>),
// the Live relay (dryscope-live-<env>, a placeholder until stage S7) and the migration job
// (dryscope-migrate-<env>).
export const SERVICES = ['api', 'live', 'migrate'] as const;
export type Service = (typeof SERVICES)[number];

export type Setting = {
  // terraform: Terraform sets it on `services`. local: a developer machine only, so Terraform
  // must never set it. tooling: set by CI or release tooling when it starts the app, never by Terraform.
  source: 'terraform' | 'local' | 'tooling';
  // The Cloud Run services Terraform sets it on (empty unless source is terraform).
  services: readonly Service[];
  // web: src/lib/config.ts reads it today. planned: Terraform already sets it for a reader that
  // does not exist yet; config.ts must not read it until this says web.
  reader: 'web' | 'planned';
};

const ALL: readonly Service[] = SERVICES;
const SERVING: readonly Service[] = ['api', 'live'];
const NOT_SET: readonly Service[] = [];

export const SETTINGS = {
  // The environment name. Cloud Run gets it from Terraform as APP_ENV on every service and job.
  APP_ENV: { source: 'terraform', services: ALL, reader: 'web' },
  // Cloud SQL over /cloudsql: all three or none, never with DATABASE_URL (config.ts).
  SQL_CONNECTION_NAME: { source: 'terraform', services: ALL, reader: 'web' },
  SQL_DATABASE_NAME: { source: 'terraform', services: ALL, reader: 'web' },
  SQL_IAM_USER: { source: 'terraform', services: ALL, reader: 'web' },
  // The project whose sign-in tokens are accepted, and whose Firestore holds the access records.
  GOOGLE_CLOUD_PROJECT: { source: 'terraform', services: SERVING, reader: 'web' },
  FIRESTORE_DATABASE_ID: { source: 'terraform', services: SERVING, reader: 'web' },
  // Set now for the web app's origin check and the Live relay (S7), which do not read them yet.
  // infra/dryscope/scripts/check-plan.js requires ALLOWED_ORIGINS, so removing one is a
  // Terraform change as well as a change here.
  GOOGLE_CLOUD_LOCATION: { source: 'terraform', services: SERVING, reader: 'planned' },
  // The private evidence bucket the photo routes (S5a-5) store and read bytes in.
  EVIDENCE_BUCKET: { source: 'terraform', services: SERVING, reader: 'web' },
  ALLOWED_ORIGINS: { source: 'terraform', services: SERVING, reader: 'planned' },
  // Secret Manager references (the naming module's secret_access table), named by Terraform from
  // the secret's name. Nothing reads them yet.
  RESEND_API_KEY: { source: 'terraform', services: ['api'], reader: 'planned' },
  STRIPE_SECRET_KEY: { source: 'terraform', services: ['api'], reader: 'planned' },
  MAPS_API_KEY: { source: 'terraform', services: ['api'], reader: 'planned' },
  LINK_SIGNING_KEY: { source: 'terraform', services: SERVING, reader: 'planned' },
  // AI (docs/plans/S7.md, S7-2): where and with which models the web app's text AI runs (the `us`
  // multi-region, V4), and the full resource names of the Model Armor templates it screens with.
  // The web app reads the two templates for its AI requests (config.ts parseAiConfig, S7-6); the
  // location and models stay fixed in web/src/lib/ai/ (client.ts, registry.ts), so nothing reads
  // the other three yet.
  AI_TEXT_LOCATION: { source: 'terraform', services: ['api'], reader: 'planned' },
  AI_TEXT_MODEL: { source: 'terraform', services: ['api'], reader: 'planned' },
  AI_TRANSCRIBE_MODEL: { source: 'terraform', services: ['api'], reader: 'planned' },
  MODEL_ARMOR_TEXT_TEMPLATE: { source: 'terraform', services: SERVING, reader: 'web' },
  MODEL_ARMOR_IMAGE_TEMPLATE: { source: 'terraform', services: ['api'], reader: 'web' },
  // The Live relay's model and location (us-central1), the web app address it calls for admission,
  // turns and settlement, and the audience of its Google ID token there (relayRoute). The relay is
  // still the placeholder, which reads none of them.
  LIVE_MODEL: { source: 'terraform', services: ['live'], reader: 'planned' },
  LIVE_LOCATION: { source: 'terraform', services: ['live'], reader: 'planned' },
  API_INTERNAL_URL: { source: 'terraform', services: ['live'], reader: 'planned' },
  RELAY_AUDIENCE: { source: 'terraform', services: ['live'], reader: 'planned' },
  // The commit a running app was built from. The image build sets it, and Cloud Run runs with that
  // value, so Terraform must not set it.
  APP_COMMIT: { source: 'tooling', services: NOT_SET, reader: 'web' },
  // The release version (YYYY.MM.DD-N) the release build bakes in beside the commit; the same
  // rule: the image sets it, Terraform must not.
  APP_VERSION: { source: 'tooling', services: NOT_SET, reader: 'web' },
  // An older name for APP_ENV that config.ts still accepts. Terraform sets APP_ENV, never this.
  APP_ENVIRONMENT: { source: 'local', services: NOT_SET, reader: 'web' },
  // Request tracing (src/lib/telemetry). OTEL_SDK_DISABLED=true is the off switch (the standard
  // OpenTelemetry name). K_SERVICE is set by Cloud Run itself on a service revision: the exporter to
  // Cloud Trace starts only where it is present, so no local run or CI job exports. Terraform sets
  // neither today; a later infra change may set the switch on a service.
  OTEL_SDK_DISABLED: { source: 'tooling', services: NOT_SET, reader: 'web' },
  K_SERVICE: { source: 'tooling', services: NOT_SET, reader: 'web' },
  // Developer machine only. The emulator hosts make firebase-admin trust unsigned tokens and
  // credential-free writes, so Terraform must never set them (config.ts also refuses them unless
  // APP_ENV is local).
  DATABASE_URL: { source: 'local', services: NOT_SET, reader: 'web' },
  FIREBASE_AUTH_EMULATOR_HOST: { source: 'local', services: NOT_SET, reader: 'web' },
  FIRESTORE_EMULATOR_HOST: { source: 'local', services: NOT_SET, reader: 'web' },
  // The sign-in screens' browser settings (public values) and the local sign-in records file.
  // Terraform does not set the first two yet (docs/plans/S3.md, S3-13a); a later infra change moves
  // them to source terraform. LOCAL_SIGN_IN_FIXTURE is never set outside a developer machine.
  FIREBASE_WEB_API_KEY: { source: 'local', services: NOT_SET, reader: 'web' },
  FIREBASE_AUTH_DOMAIN: { source: 'local', services: NOT_SET, reader: 'web' },
  LOCAL_SIGN_IN_FIXTURE: { source: 'local', services: NOT_SET, reader: 'web' },
  // App Check in monitor mode (docs/plans/TC.md, TC-5), in the app root's common_env: what the route
  // wrappers do with the token (monitor), and the web app's Firebase app id and the reCAPTCHA
  // Enterprise site key (public values from owner step 8 and TC-9). Terraform sets the last two only
  // once both are passed (TC-11's apply); until then they are left out and App Check stays off in
  // the browser. The committed plan carries stand-in values (app/tests/images-<env>.tfvars).
  APP_CHECK_MODE: { source: 'terraform', services: SERVING, reader: 'web' },
  FIREBASE_APP_ID: { source: 'terraform', services: SERVING, reader: 'web' },
  APP_CHECK_SITE_KEY: { source: 'terraform', services: SERVING, reader: 'web' },
} as const satisfies Record<string, Setting>;

export type SettingName = keyof typeof SETTINGS;

// The settings config.ts must declare, and nothing else: its schema is typed against this.
export type WebSettingName = {
  [K in SettingName]: (typeof SETTINGS)[K]['reader'] extends 'web' ? K : never;
}[SettingName];

export const APP_ENV_ALIAS = 'APP_ENVIRONMENT' satisfies SettingName;

export function settingNames(): SettingName[] {
  return Object.keys(SETTINGS) as SettingName[];
}
