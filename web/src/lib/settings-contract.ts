// The one list of runtime settings the app and the Cloud Run Terraform (infra/dryscope/app) agree
// on. src/lib/config.ts builds its schema from this list's types, and tests/unit/settings-contract
// .test.ts reads the Terraform and fails when the two disagree, so a setting cannot be renamed on
// one side only (the way FIREBASE_PROJECT_ID and GOOGLE_CLOUD_PROJECT once were).
//
// To add or rename a setting: change this list, config.ts and the Terraform in the same PR. Names
// only; no values and no secrets belong here. Settings that come from Secret Manager are not
// listed: the app reads none yet, and the test refuses any other way Terraform could add one.

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
  EVIDENCE_BUCKET: { source: 'terraform', services: SERVING, reader: 'planned' },
  ALLOWED_ORIGINS: { source: 'terraform', services: SERVING, reader: 'planned' },
  // The commit a running app was built from; the CI smoke run sets it. Cloud Run leaves it unset.
  APP_COMMIT: { source: 'tooling', services: NOT_SET, reader: 'web' },
  // Developer machine only. The emulator hosts make firebase-admin trust unsigned tokens and
  // credential-free writes, so Terraform must never set them (config.ts also refuses them unless
  // APP_ENV is local).
  DATABASE_URL: { source: 'local', services: NOT_SET, reader: 'web' },
  FIREBASE_AUTH_EMULATOR_HOST: { source: 'local', services: NOT_SET, reader: 'web' },
  FIRESTORE_EMULATOR_HOST: { source: 'local', services: NOT_SET, reader: 'web' },
} as const satisfies Record<string, Setting>;

export type SettingName = keyof typeof SETTINGS;

// The settings config.ts must declare, and nothing else: its schema is typed against this.
export type WebSettingName = {
  [K in SettingName]: (typeof SETTINGS)[K]['reader'] extends 'web' ? K : never;
}[SettingName];

// An older name for APP_ENV that the app still accepts. Terraform sets APP_ENV, not this.
export const APP_ENV_ALIAS = 'APP_ENVIRONMENT';

export function settingNames(): SettingName[] {
  return Object.keys(SETTINGS) as SettingName[];
}
