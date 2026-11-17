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

// Connections each pool may open, per Cloud Run instance. Raising one is a reviewed code change, not a
// setting. Sizing rule (docs/plans/S8/S8-2.md): an instance opens the main pool and the probe below
// plus the access-renewal pool (PROJECTION_CONNECTIONS in lib/projection/services.ts): 3 + 1 + 2 = 6.
// During a rollout two revisions run at once (the serving one and the candidate; a new revision is
// staged only once the previous one has drained), so 2 x the web app's maximum instances x 6, plus
// the migrator (1) and a reserve of 10, must stay within the database's max_connections: test
// 2 x 1 x 6 + 11 = 23 of 25, live 2 x 7 x 6 + 11 = 95 of 100. tests/unit/connection-budget.test.ts
// checks this against both environments' tfvars.
//
// The main pool: requests share it, and each transaction holds one connection until it ends.
export const MAIN_POOL_CONNECTIONS = 3;
// The health probe keeps one connection of its own, whatever the main pool's size.
export const PROBE_CONNECTIONS = 1;
// An unused connection closes after this many seconds, so an idle instance (Cloud Run can keep one
// for about 15 minutes) gives its connections back to the database.
const IDLE_TIMEOUT_SECONDS = 60;

const common = {
  max: MAIN_POOL_CONNECTIONS,
  idle_timeout: IDLE_TIMEOUT_SECONDS,
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
// the app uses. One connection per process (PROBE_CONNECTIONS), opened on first use, so health
// checks never pile up logins or metadata token requests.
let probe: ReturnType<typeof postgres> | null = null;

export async function checkDatabase(config: AppConfig): Promise<void> {
  probe ??= connect(config, PROBE_CONNECTIONS);
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
