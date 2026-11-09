import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { ConfigError, parseConfig } from '../lib/config';
import { applyMigrations, migrationsDirectory } from './migrate';
import { schema } from './schema';

function requiredDatabaseUrl(env: Record<string, string | undefined>): string {
  const config = parseConfig(env);
  if (!config.databaseUrl) {
    throw new ConfigError(['DATABASE_URL: DATABASE_URL is required to open the database']);
  }
  return config.databaseUrl;
}

// The connection string comes only from the validated config.
export function openDatabase(env: Record<string, string | undefined>) {
  const databaseUrl = requiredDatabaseUrl(env);
  // One connection is enough until a route uses the database. Migrations open their own.
  const sql = postgres(databaseUrl, {
    max: 1,
    connect_timeout: 10,
    onnotice: () => {},
    connection: { application_name: 'dryscope-web' },
  });
  return {
    db: drizzle(sql, { schema }),
    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}

export async function migrateFromConfig(
  env: Record<string, string | undefined>,
  directory = migrationsDirectory,
): Promise<{ applied: string[] }> {
  return applyMigrations(requiredDatabaseUrl(env), directory);
}
