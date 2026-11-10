import { z } from 'zod';

// Typed server configuration. Every variable the app reads is declared here. src/instrumentation.ts
// checks it when the server starts, so an invalid value stops the app with a message that names the
// variable and never repeats the value. APP_ENV is required; the Cloud Run services set it as
// APP_ENVIRONMENT (infra/dryscope/app/cloud_run.tf), which is read the same way. DATABASE_URL is
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

const schema = z
  .object({
  APP_ENV: z.enum(['local', 'test', 'live'], {
    error: 'APP_ENV (or APP_ENVIRONMENT) must be one of local, test or live',
  }),
  // Optional so the shell can boot before a database is wired. When present it must already be a
  // postgres URL; the message stays fixed so a secret in the value is never echoed.
  DATABASE_URL: z
    .string()
    .refine(isPostgresUrl, { message: 'DATABASE_URL must be a postgres URL' })
    .optional(),
  // The commit the image was built from. web/Dockerfile bakes it in; local runs leave it unset.
  APP_COMMIT: z
    .string()
    .regex(/^[0-9a-f]{40}$/, { error: 'APP_COMMIT must be a 40-character commit hash' })
    .optional(),
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
  // firebase-admin reads this one itself too and then writes to the emulator with no credentials;
  // the same limits as the Auth emulator apply.
  FIRESTORE_EMULATOR_HOST: z
    .string()
    .refine(isLoopbackHost, { message: 'FIRESTORE_EMULATOR_HOST must be a loopback host:port' })
    .optional(),
  })
  .superRefine((env, ctx) => {
    for (const name of ['FIREBASE_AUTH_EMULATOR_HOST', 'FIRESTORE_EMULATOR_HOST'] as const) {
      if (env[name] === undefined) continue;
      if (env.APP_ENV !== 'local') {
        ctx.addIssue({ code: 'custom', path: [name], message: `${name} is allowed only when APP_ENV is local` });
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

const SQL_KEYS = ['SQL_CONNECTION_NAME', 'SQL_DATABASE_NAME', 'SQL_IAM_USER'] as const;

export type CloudSqlConfig = { connectionName: string; database: string; user: string };

export type AppConfig = {
  appEnv: z.infer<typeof schema>['APP_ENV'];
  databaseUrl: string | null;
  commit?: string;
  cloudSql?: CloudSqlConfig;
};

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration: ${problems.join('; ')}`);
    this.name = 'ConfigError';
  }
}

// The environment name under either variable. Both set to different values is refused, so a
// service cannot run as one environment while its settings say another.
function withAppEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const { APP_ENV, APP_ENVIRONMENT } = env;
  if (APP_ENV !== undefined && APP_ENVIRONMENT !== undefined && APP_ENV !== APP_ENVIRONMENT) {
    throw new ConfigError(['APP_ENV: APP_ENV and APP_ENVIRONMENT must match when both are set']);
  }
  return { ...env, APP_ENV: APP_ENV ?? APP_ENVIRONMENT };
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
    throw new ConfigError(['GOOGLE_CLOUD_PROJECT: GOOGLE_CLOUD_PROJECT is required to check a sign-in']);
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
    problems.push('FIRESTORE_DATABASE_ID: FIRESTORE_DATABASE_ID is required to write access records');
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
