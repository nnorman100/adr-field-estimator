import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { type AppConfig, ConfigError, parseConfig } from '../lib/config';
import { createTokenSource } from './iam-token';
import { applyMigrations, migrationsDirectory, type MigrationTarget } from './migrate';
import { schema } from './schema';

function requiredDatabaseUrl(config: AppConfig): string {
  if (!config.databaseUrl) {
    throw new ConfigError(['DATABASE_URL: DATABASE_URL is required to open the database']);
  }
  return config.databaseUrl;
}

// The Unix socket Cloud Run's built-in Cloud SQL connection mounts for an instance.
const cloudSqlSocket = (connectionName: string) => `/cloudsql/${connectionName}/.s.PGSQL.5432`;

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
        path: cloudSqlSocket(connectionName),
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

function connect(config: AppConfig, max = common.max) {
  const { url, options } = connectionOptions(config);
  const sized = { ...options, max };
  return url === null ? postgres(sized) : postgres(url, sized);
}

export function openDatabase(env: Record<string, string | undefined>, { max }: { max?: number } = {}) {
  const sql = connect(parseConfig(env), max);
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

// DATABASE_URL, or on Cloud Run (the migration job, infra/dryscope/app/migrate_job.tf) the SQL_*
// settings: the instance socket, logging in as the job's own IAM database user with a fresh access
// token as the password, exactly as the services do. No password is stored anywhere.
export async function migrateFromConfig(
  env: Record<string, string | undefined>,
  directory = migrationsDirectory,
  accessToken = createTokenSource(),
): Promise<{ applied: string[] }> {
  const config = parseConfig(env);
  let target: MigrationTarget;
  if (config.cloudSql) {
    const { connectionName, database, user } = config.cloudSql;
    target = { path: cloudSqlSocket(connectionName), database, username: user, password: accessToken };
  } else {
    target = requiredDatabaseUrl(config);
  }
  return applyMigrations(target, directory);
}
