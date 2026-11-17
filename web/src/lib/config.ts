import { z } from 'zod';
import { APP_ENV_ALIAS, type WebSettingName } from './settings-contract';

// Typed server configuration. Every variable the app reads is declared here. src/instrumentation.ts
// checks it when the server starts, so an invalid value stops the app with a message that names the
// variable and never repeats the value. Every name is listed in src/lib/settings-contract.ts,
// which tests/unit/settings-contract.test.ts holds to the Terraform in infra/dryscope/app. APP_ENV
// is required; Terraform sets it as APP_ENV and the older APP_ENVIRONMENT is read the same way. DATABASE_URL is
// optional until a database command runs, GOOGLE_CLOUD_PROJECT until a route checks a sign-in, and
// FIRESTORE_DATABASE_ID until an access record is written; none has a default. No secrets belong in
// this file.
function isPostgresUrl(value: string): boolean {
  if (value.length === 0 || value.length > 2000 || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    const protocolOk = url.protocol === 'postgres:' || url.protocol === 'postgresql:';
    return protocolOk && url.hostname.length > 0 && url.pathname.length > 1;
  } catch {
    return false;
  }
}

// A Google Cloud project id: 6-30 lowercase letters, digits and hyphens, starting with a letter.
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

// A Firestore database id: (default), or 4-63 lowercase letters, digits and hyphens that start
// with a letter and end with a letter or digit.
const FIRESTORE_DATABASE = /^(\(default\)|[a-z][a-z0-9-]{2,61}[a-z0-9])$/;

// A Cloud Storage bucket name: 3-63 lowercase letters, digits, hyphens, underscores and dots,
// starting and ending with a letter or digit.
const BUCKET_NAME = /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/;

// A Model Armor template's full resource name (web/src/lib/ai/armor.ts reads its location from it).
const ARMOR_TEMPLATE =
  /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/locations\/[a-z]+(?:-[a-z]+\d*)?\/templates\/[A-Za-z0-9_-]{1,63}$/;

// host:port of a loopback emulator, as the Firebase CLI writes it.
function isLoopbackHost(value: string): boolean {
  if (!/^[\w.:[\]-]{1,100}:\d{1,5}$/.test(value)) return false;
  try {
    const { hostname } = new URL(`http://${value}`);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
  } catch {
    return false;
  }
}

// An empty value (a Terraform variable left blank) reads as unset.
const emptyIsUnset = (value: unknown) => (value === '' ? undefined : value);

const SQL_KEYS = ['SQL_CONNECTION_NAME', 'SQL_DATABASE_NAME', 'SQL_IAM_USER'] as const;

// Typed against src/lib/settings-contract.ts: a setting missing here, or declared here and not
// listed there as read by the web app, fails the type check. APP_ENV_ALIAS is read by withAppEnv.
const shape = {
  APP_ENV: z.enum(['local', 'test', 'live'], {
    error: 'APP_ENV (or APP_ENVIRONMENT) must be one of local, test or live',
  }),
  // Optional so the shell can boot before a database is wired. When present it must already be a
  // postgres URL; the message stays fixed so a secret in the value is never echoed.
  DATABASE_URL: z
    .string()
    .refine(isPostgresUrl, { message: 'DATABASE_URL must be a postgres URL' })
    .optional(),
  // The commit the running app was built from. The image build sets it and Cloud Run runs with that
  // value; local runs leave it unset.
  APP_COMMIT: z
    .string()
    .regex(/^[0-9a-f]{40}$/, { error: 'APP_COMMIT must be a 40-character commit hash' })
    .optional(),
  // The release version (YYYY.MM.DD-N, docs/plans/TC.md TC-8) the release build bakes in beside the
  // commit; local runs and the Web app check leave it unset or give their own.
  APP_VERSION: z
    .string()
    .regex(/^\d{4}\.\d{2}\.\d{2}-[1-9]\d{0,5}$/, { error: 'APP_VERSION must be YYYY.MM.DD-N' })
    .optional(),
  // Tracing: the standard off switch, and the name Cloud Run gives a running service. Both are read
  // only by parseTracingConfig; neither is required.
  // Like the OpenTelemetry SDK, any value but true (in any case) leaves tracing on, so a typo in the
  // off switch never stops the server from starting.
  OTEL_SDK_DISABLED: z.string().max(40).optional(),
  K_SERVICE: z.string().max(100).optional(),
  // Cloud SQL on Cloud Run, set by infra/dryscope/app/cloud_run.tf: the instance mounted under
  // /cloudsql, the database, and this service's IAM database user (its account email without
  // .gserviceaccount.com). All three or none, and never together with DATABASE_URL.
  SQL_CONNECTION_NAME: z
    .string()
    .regex(/^[a-z][a-z0-9-]*:[a-z0-9-]+:[a-z][a-z0-9-]*$/, {
      error: 'SQL_CONNECTION_NAME must be project:region:instance',
    })
    .optional(),
  SQL_DATABASE_NAME: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/, { error: 'SQL_DATABASE_NAME must be a database name' })
    .optional(),
  SQL_IAM_USER: z
    .string()
    .regex(/^[a-z][a-z0-9-]*@[a-z][a-z0-9-]*\.iam$/, {
      error: 'SQL_IAM_USER must be a service account IAM database user (name@project.iam)',
    })
    .optional(),
  // The project whose sign-in tokens the server accepts (their audience). Cloud Run gets it from
  // Terraform; the Firebase CLI sets it for the emulators.
  GOOGLE_CLOUD_PROJECT: z
    .string()
    .regex(PROJECT_ID, { message: 'GOOGLE_CLOUD_PROJECT must be a Google Cloud project id' })
    .optional(),
  // firebase-admin reads this variable itself and then accepts unsigned tokens, so it is allowed
  // only on a developer machine, only for a demo- project, and only on a loopback address.
  FIREBASE_AUTH_EMULATOR_HOST: z
    .string()
    .refine(isLoopbackHost, { message: 'FIREBASE_AUTH_EMULATOR_HOST must be a loopback host:port' })
    .optional(),
  // The field database the server writes access records to. Cloud Run gets it from Terraform
  // (infra/dryscope/app); the emulators use (default).
  FIRESTORE_DATABASE_ID: z
    .string()
    .regex(FIRESTORE_DATABASE, { message: 'FIRESTORE_DATABASE_ID must be a Firestore database id' })
    .optional(),
  // The private evidence bucket for photos and their originals (infra/dryscope/data/storage.tf):
  // `<project>-evidence-<env>`. Cloud Run gets it from Terraform; there is no storage emulator, so
  // local work and CI replace the bucket with a fake at its boundary (src/lib/photos/).
  EVIDENCE_BUCKET: z
    .string()
    .regex(BUCKET_NAME, { message: 'EVIDENCE_BUCKET must be a Cloud Storage bucket name' })
    .optional(),
  // The Model Armor templates the AI boundary screens text and images with (infra/dryscope/modules/
  // naming: dryscope-text-<env> in us-central1, dryscope-image-<env> in us, V3). Cloud Run gets them
  // from Terraform; only an AI request reads them (parseAiConfig).
  MODEL_ARMOR_TEXT_TEMPLATE: z
    .string()
    .regex(ARMOR_TEMPLATE, { message: 'MODEL_ARMOR_TEXT_TEMPLATE must be a Model Armor template name' })
    .optional(),
  MODEL_ARMOR_IMAGE_TEMPLATE: z
    .string()
    .regex(ARMOR_TEMPLATE, { message: 'MODEL_ARMOR_IMAGE_TEMPLATE must be a Model Armor template name' })
    .optional(),
  // firebase-admin reads this one itself too and then writes to the emulator with no credentials;
  // the same limits as the Auth emulator apply.
  FIRESTORE_EMULATOR_HOST: z
    .string()
    .refine(isLoopbackHost, { message: 'FIRESTORE_EMULATOR_HOST must be a loopback host:port' })
    .optional(),
  // The browser sign-in settings of the project's Firebase web app (S3 plan, section 6, step 8).
  // Both are public values that every visitor's browser receives; the sign-in screens say sign-in
  // is not set up while either is missing outside the emulator.
  FIREBASE_WEB_API_KEY: z
    .string()
    .regex(/^[A-Za-z0-9_-]{20,100}$/, {
      message: 'FIREBASE_WEB_API_KEY must be a Firebase web API key',
    })
    .optional(),
  FIREBASE_AUTH_DOMAIN: z
    .string()
    .regex(/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, {
      message: 'FIREBASE_AUTH_DOMAIN must be a host name',
    })
    .optional(),
  // App Check (docs/plans/TC.md, TC-5). The web app's Firebase app id and the score-based
  // reCAPTCHA Enterprise site key App Check is registered with (TC-9): public values every visitor's
  // browser receives. App Check runs in the browser only while both are set; with either missing or
  // empty (an empty value counts as unset) the app behaves as it did before App Check.
  FIREBASE_APP_ID: z.preprocess(
    emptyIsUnset,
    z
      .string()
      .regex(/^\d{1,3}:\d{1,20}:web:[0-9a-f]{1,64}$/, { message: 'FIREBASE_APP_ID must be a Firebase web app id' })
      .optional(),
  ),
  APP_CHECK_SITE_KEY: z.preprocess(
    emptyIsUnset,
    z
      .string()
      .regex(/^[A-Za-z0-9_-]{20,100}$/, { message: 'APP_CHECK_SITE_KEY must be a reCAPTCHA site key' })
      .optional(),
  ),
  // What the server does with the App Check token on each /api call: monitor (the default) checks
  // it and logs the outcome, never refusing; off does nothing. enforce is refused at start-up until
  // TC-13, so no setting can make App Check refuse a request yet.
  APP_CHECK_MODE: z.preprocess(
    emptyIsUnset,
    z
      .enum(['monitor', 'off'], {
        error: 'APP_CHECK_MODE must be monitor or off (enforce is not available yet)',
      })
      .optional(),
  ),
  // Local only: a JSON file that stands in for the companies, actors and memberships in Postgres,
  // so the sign-in screens run against the Auth emulator with no database (tests/e2e). Allowed only
  // beside the Auth emulator, for a demo- project, with no database configured.
  LOCAL_SIGN_IN_FIXTURE: z
    .string()
    .regex(/^\/[^\0]{1,500}\.json$/, {
      message: 'LOCAL_SIGN_IN_FIXTURE must be an absolute path to a .json file',
    })
    .optional(),
} satisfies Record<Exclude<WebSettingName, typeof APP_ENV_ALIAS>, z.ZodType>;

// Every name this file reads, for the contract test.
export const CONFIG_SETTINGS = [...Object.keys(shape), APP_ENV_ALIAS];

const schema = z.object(shape).superRefine((env, ctx) => {
  if (env.LOCAL_SIGN_IN_FIXTURE !== undefined) {
    const database =
      env.DATABASE_URL !== undefined || SQL_KEYS.some((key) => env[key] !== undefined);
    if (env.APP_ENV !== 'local' || env.FIREBASE_AUTH_EMULATOR_HOST === undefined || database) {
      ctx.addIssue({
        code: 'custom',
        path: ['LOCAL_SIGN_IN_FIXTURE'],
        message:
          'LOCAL_SIGN_IN_FIXTURE is allowed only when APP_ENV is local, beside the Auth emulator, with no database',
      });
    }
  }
  for (const name of ['FIREBASE_AUTH_EMULATOR_HOST', 'FIRESTORE_EMULATOR_HOST'] as const) {
    if (env[name] === undefined) continue;
    if (env.APP_ENV !== 'local') {
      ctx.addIssue({
        code: 'custom',
        path: [name],
        message: `${name} is allowed only when APP_ENV is local`,
      });
    }
    if (!env.GOOGLE_CLOUD_PROJECT?.startsWith('demo-')) {
      ctx.addIssue({
        code: 'custom',
        path: [name],
        message: `${name} needs a GOOGLE_CLOUD_PROJECT starting with demo-`,
      });
    }
  }
});

export type CloudSqlConfig = { connectionName: string; database: string; user: string };

export type AppConfig = {
  appEnv: z.infer<typeof schema>['APP_ENV'];
  databaseUrl: string | null;
  commit?: string;
  version?: string;
  cloudSql?: CloudSqlConfig;
};

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration: ${problems.join('; ')}`);
    this.name = 'ConfigError';
  }
}

// The environment name under either variable. Terraform sets APP_ENV (src/lib/settings-contract.ts);
// the older APP_ENVIRONMENT is still accepted. Both set to different values is refused, so a
// service cannot run as one environment while its settings say another.
function withAppEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const { APP_ENV } = env;
  const alias = env[APP_ENV_ALIAS];
  if (APP_ENV !== undefined && alias !== undefined && APP_ENV !== alias) {
    throw new ConfigError([`APP_ENV: APP_ENV and ${APP_ENV_ALIAS} must match when both are set`]);
  }
  return { ...env, APP_ENV: APP_ENV ?? alias };
}

function checked(env: Record<string, string | undefined>) {
  const result = schema.safeParse(withAppEnv(env));
  if (!result.success) {
    // Only variable names and messages are reported, never the values.
    throw new ConfigError(result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  return result.data;
}

export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  const data = checked(env);
  const config: AppConfig = { appEnv: data.APP_ENV, databaseUrl: data.DATABASE_URL ?? null };
  if (data.APP_COMMIT !== undefined) config.commit = data.APP_COMMIT;
  if (data.APP_VERSION !== undefined) config.version = data.APP_VERSION;

  const missing = SQL_KEYS.filter((key) => data[key] === undefined);
  if (missing.length < SQL_KEYS.length) {
    if (missing.length > 0) {
      throw new ConfigError(missing.map((key) => `${key}: required with the other SQL_* settings`));
    }
    if (config.databaseUrl !== null) {
      throw new ConfigError(['DATABASE_URL: set DATABASE_URL or the SQL_* settings, not both']);
    }
    config.cloudSql = {
      connectionName: data.SQL_CONNECTION_NAME!,
      database: data.SQL_DATABASE_NAME!,
      user: data.SQL_IAM_USER!,
    };
  }
  return config;
}

export type TracingConfig = {
  // off: nothing is recorded. spans: spans are recorded in the process and nowhere else (a local
  // run, CI). export: spans also go to Cloud Trace (a Cloud Run service with a project).
  mode: 'off' | 'spans' | 'export';
  appEnv: AppConfig['appEnv'];
  projectId?: string;
  commit?: string;
};

// What request tracing needs (src/lib/telemetry). It never throws for a missing optional setting:
// without K_SERVICE or the project there is no exporter, and OTEL_SDK_DISABLED=true turns it all off.
export function parseTracingConfig(env: Record<string, string | undefined>): TracingConfig {
  const data = checked(env);
  const config: TracingConfig = { mode: 'spans', appEnv: data.APP_ENV };
  if (data.GOOGLE_CLOUD_PROJECT !== undefined) config.projectId = data.GOOGLE_CLOUD_PROJECT;
  if (data.APP_COMMIT !== undefined) config.commit = data.APP_COMMIT;
  if (data.OTEL_SDK_DISABLED?.toLowerCase() === 'true') config.mode = 'off';
  else if (data.K_SERVICE !== undefined && data.APP_ENV !== 'local' && data.GOOGLE_CLOUD_PROJECT !== undefined) {
    config.mode = 'export';
  }
  return config;
}

export type AppCheckMode = 'monitor' | 'off';

// What the route wrappers do with App Check tokens (src/lib/app-check.ts). Unset means monitor.
export function parseAppCheckMode(env: Record<string, string | undefined>): AppCheckMode {
  return checked(env).APP_CHECK_MODE ?? 'monitor';
}

export type IdentityConfig = {
  appEnv: AppConfig['appEnv'];
  projectId: string;
  authEmulatorHost: string | null;
};

// What sign-in checks need. Called when a route first checks a sign-in, so the shell still boots
// without GOOGLE_CLOUD_PROJECT; a route that needs it then fails closed.
export function parseIdentityConfig(env: Record<string, string | undefined>): IdentityConfig {
  const data = checked(env);
  if (!data.GOOGLE_CLOUD_PROJECT) {
    throw new ConfigError([
      'GOOGLE_CLOUD_PROJECT: GOOGLE_CLOUD_PROJECT is required to check a sign-in',
    ]);
  }
  return {
    appEnv: data.APP_ENV,
    projectId: data.GOOGLE_CLOUD_PROJECT,
    authEmulatorHost: data.FIREBASE_AUTH_EMULATOR_HOST ?? null,
  };
}

export type ProjectionConfig = {
  projectId: string;
  databaseId: string;
  firestoreEmulatorHost: string | null;
};

// What writing Firestore access records needs. Called when the first access record is written, so
// the shell still boots without these; the write then fails closed and its outbox row waits.
export function parseProjectionConfig(env: Record<string, string | undefined>): ProjectionConfig {
  const data = checked(env);
  const problems: string[] = [];
  if (!data.GOOGLE_CLOUD_PROJECT) {
    problems.push('GOOGLE_CLOUD_PROJECT: GOOGLE_CLOUD_PROJECT is required to write access records');
  }
  if (!data.FIRESTORE_DATABASE_ID) {
    problems.push(
      'FIRESTORE_DATABASE_ID: FIRESTORE_DATABASE_ID is required to write access records',
    );
  }
  if (problems.length > 0 || !data.GOOGLE_CLOUD_PROJECT || !data.FIRESTORE_DATABASE_ID) {
    throw new ConfigError(problems);
  }
  return {
    projectId: data.GOOGLE_CLOUD_PROJECT,
    databaseId: data.FIRESTORE_DATABASE_ID,
    firestoreEmulatorHost: data.FIRESTORE_EMULATOR_HOST ?? null,
  };
}

export type EvidenceConfig = { projectId: string; bucket: string };

// What storing and reading photo bytes needs. Called when the first photo request arrives, so the
// shell still boots without these; that request then fails closed.
export function parseEvidenceConfig(env: Record<string, string | undefined>): EvidenceConfig {
  const data = checked(env);
  const problems: string[] = [];
  if (!data.GOOGLE_CLOUD_PROJECT) {
    problems.push('GOOGLE_CLOUD_PROJECT: GOOGLE_CLOUD_PROJECT is required to store photos');
  }
  if (!data.EVIDENCE_BUCKET) {
    problems.push('EVIDENCE_BUCKET: EVIDENCE_BUCKET is required to store photos');
  }
  if (problems.length > 0 || !data.GOOGLE_CLOUD_PROJECT || !data.EVIDENCE_BUCKET) {
    throw new ConfigError(problems);
  }
  return { projectId: data.GOOGLE_CLOUD_PROJECT, bucket: data.EVIDENCE_BUCKET };
}

// What a sign-in screen's browser needs to reach Identity Platform. Every value is public: the API
// key names the project and is restricted to the app's address (S3 plan, section 6, step 8).
export type BrowserSignInConfig = {
  apiKey: string;
  authDomain: string;
  projectId: string;
  // The Auth emulator's address for the browser, on a developer machine only; null elsewhere.
  authEmulatorUrl: string | null;
  // What the browser's Firestore client needs for the field database (S6-1). Each is left out
  // (not null) while the server does not know it, so sign-in works without them.
  // The field database's id.
  firestoreDatabaseId?: string;
  // The Firestore emulator's address, on a developer machine only; never set elsewhere.
  firestoreEmulatorUrl?: string;
  // App Check (TC-5): the web app's id and the reCAPTCHA Enterprise site key. Both are left out
  // while the server does not know them, and the browser starts App Check only when both are here.
  appId?: string;
  appCheckSiteKey?: string;
};

// The emulator accepts any API key; this one is never valid on a real project.
const EMULATOR_API_KEY = 'demo-emulator-api-key';

// null when sign-in is not set up: no project, or (outside the emulator) no web API key or auth
// domain. The sign-in screens then say so instead of trying a sign-in that cannot work.
export function parseBrowserSignInConfig(
  env: Record<string, string | undefined>,
): BrowserSignInConfig | null {
  const data = checked(env);
  const projectId = data.GOOGLE_CLOUD_PROJECT;
  if (!projectId) return null;
  const known = {
    ...(data.FIRESTORE_DATABASE_ID !== undefined ? { firestoreDatabaseId: data.FIRESTORE_DATABASE_ID } : {}),
    ...(data.FIREBASE_APP_ID !== undefined && data.APP_CHECK_SITE_KEY !== undefined
      ? { appId: data.FIREBASE_APP_ID, appCheckSiteKey: data.APP_CHECK_SITE_KEY }
      : {}),
  };
  const emulator = data.FIREBASE_AUTH_EMULATOR_HOST;
  if (emulator !== undefined) {
    return {
      apiKey: data.FIREBASE_WEB_API_KEY ?? EMULATOR_API_KEY,
      authDomain: data.FIREBASE_AUTH_DOMAIN ?? `${projectId}.firebaseapp.com`,
      projectId,
      authEmulatorUrl: `http://${emulator}`,
      ...known,
      ...(data.FIRESTORE_EMULATOR_HOST !== undefined
        ? { firestoreEmulatorUrl: `http://${data.FIRESTORE_EMULATOR_HOST}` }
        : {}),
    };
  }
  if (!data.FIREBASE_WEB_API_KEY || !data.FIREBASE_AUTH_DOMAIN) return null;
  return {
    apiKey: data.FIREBASE_WEB_API_KEY,
    authDomain: data.FIREBASE_AUTH_DOMAIN,
    projectId,
    authEmulatorUrl: null,
    ...known,
  };
}

// The local stand-in for the sign-in records (LOCAL_SIGN_IN_FIXTURE), or null. The schema above
// allows it only on a developer machine beside the Auth emulator with no database.
export function parseLocalSignInFixture(env: Record<string, string | undefined>): string | null {
  return checked(env).LOCAL_SIGN_IN_FIXTURE ?? null;
}

export type AiConfig = { projectId: string; armorTemplates: { text: string; image: string } };

// What a REST AI call needs: the project the text model runs in and the Model Armor templates.
// Called on the first AI request whose company switch is on, so the shell boots without these; that
// request then fails closed.
export function parseAiConfig(env: Record<string, string | undefined>): AiConfig {
  const data = checked(env);
  const problems: string[] = [];
  for (const name of ['GOOGLE_CLOUD_PROJECT', 'MODEL_ARMOR_TEXT_TEMPLATE', 'MODEL_ARMOR_IMAGE_TEMPLATE'] as const) {
    if (!data[name]) problems.push(`${name}: ${name} is required for AI requests`);
  }
  if (problems.length > 0 || !data.GOOGLE_CLOUD_PROJECT || !data.MODEL_ARMOR_TEXT_TEMPLATE || !data.MODEL_ARMOR_IMAGE_TEMPLATE) {
    throw new ConfigError(problems);
  }
  return {
    projectId: data.GOOGLE_CLOUD_PROJECT,
    armorTemplates: { text: data.MODEL_ARMOR_TEXT_TEMPLATE, image: data.MODEL_ARMOR_IMAGE_TEMPLATE },
  };
}
