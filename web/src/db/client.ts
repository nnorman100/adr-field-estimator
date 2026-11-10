import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { type AppConfig, ConfigError, parseConfig } from '../lib/config';
import { createTokenSource } from './iam-token';
import { applyMigrations, migrationsDirectory } from './migrate';
import { schema } from './schema';

function requiredDatabaseUrl(env: Record<string, string | undefined>): string {
  const config = parseConfig(env);
  if (!config.databaseUrl) {
    throw new ConfigError(['DATABASE_URL: DATABASE_URL is required to open the database']);
  }
  return config.databaseUrl;
}

const common = {
  // One connection is enough until a route uses the database. Migrations open their own.
  max: 1,
  connect_timeout: 10,
  onnotice: () => {},
  connection: { application_name: 'dryscope-web' },
};

// How the app reaches Postgres, from the validated config only. On Cloud Run that is the Cloud SQL
// instance mounted under /cloudsql, logging in as the service's IAM database user with a fresh
// access token as the password (no password is stored anywhere); elsewhere it is DATABASE_URL.
export function connectionOptions(config: AppConfig, accessToken = createTokenSource()) {
  if (config.cloudSql) {
    const { connectionName, database, user } = config.cloudSql;
    return {
      url: null,
      options: {
        ...common,
        path: `/cloudsql/${connectionName}/.s.PGSQL.5432`,
        database,
        username: user,
        password: accessToken,
      },
    };
  }
  if (!config.databaseUrl) {
    throw new ConfigError([
      'DATABASE_URL: DATABASE_URL or the SQL_* settings are required to open the database',
    ]);
  }
  return { url: config.databaseUrl, options: common };
}

function connect(config: AppConfig) {
  const { url, options } = connectionOptions(config);
  return url === null ? postgres(options) : postgres(url, options);
}

export function openDatabase(env: Record<string, string | undefined>) {
  const sql = connect(parseConfig(env));
  return {
    db: drizzle(sql, { schema }),
    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}

// Proves the configured database accepts this service's login, over the same connection settings
// the app uses. One connection per process, opened on first use, so health checks never pile up
// logins or metadata token requests.
let probe: ReturnType<typeof postgres> | null = null;

export async function checkDatabase(config: AppConfig): Promise<void> {
  probe ??= connect(config);
  await probe`select 1`;
}

export async function migrateFromConfig(
  env: Record<string, string | undefined>,
  directory = migrationsDirectory,
): Promise<{ applied: string[] }> {
  return applyMigrations(requiredDatabaseUrl(env), directory);
}
