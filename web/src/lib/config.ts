import { z } from 'zod';

// Typed server configuration. Every variable the app reads is declared here. src/instrumentation.ts
// checks it when the server starts, so an invalid value stops the app with a message that names the
// variable and never repeats the value. APP_ENV is required. DATABASE_URL is optional until a
// database command runs, and has no default. No secrets belong in this file.
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

const schema = z.object({
  APP_ENV: z.enum(['local', 'test', 'live'], {
    error: 'APP_ENV must be one of local, test or live',
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

export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  const result = schema.safeParse(env);
  if (!result.success) {
    // Only variable names and messages are reported, never the values.
    throw new ConfigError(result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const data = result.data;
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
