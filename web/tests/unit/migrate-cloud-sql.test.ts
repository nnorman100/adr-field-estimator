import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Cloud Run migration job (infra/dryscope/app/migrate_job.tf) has no DATABASE_URL: it gets the
// same SQL_* settings as the services and logs in over the /cloudsql socket as its own IAM database
// user, with a fresh access token as the password. Only the connection is checked here; the
// ledger itself is covered against a real PostgreSQL in tests/db.
const applyMigrations = vi.fn<(target: unknown, directory: string) => Promise<{ applied: string[] }>>(
  async () => ({ applied: [] }),
);
vi.mock('@/db/migrate', async (original) => ({
  ...(await original<typeof import('@/db/migrate')>()),
  applyMigrations,
}));

const { migrateFromConfig } = await import('@/db/client');
const { migrationsDirectory } = await import('@/db/migrate');

const migrator = {
  APP_ENV: 'test',
  SQL_CONNECTION_NAME: 'dryscope:us-central1:dryscope-test-pg',
  SQL_DATABASE_NAME: 'dryscope',
  SQL_IAM_USER: 'dryscope-migrate-test@dryscope.iam',
};

beforeEach(() => applyMigrations.mockClear());

describe('migrations on Cloud SQL', () => {
  it('log in over the instance socket as the IAM database user, with the token as password', async () => {
    const token = vi.fn(async () => 'short-lived-token');
    await migrateFromConfig(migrator, '/app/migrations', token);
    expect(applyMigrations).toHaveBeenCalledTimes(1);
    const [target, directory] = applyMigrations.mock.calls[0]!;
    expect(directory).toBe('/app/migrations');
    expect(target).toEqual({
      path: '/cloudsql/dryscope:us-central1:dryscope-test-pg/.s.PGSQL.5432',
      database: 'dryscope',
      username: 'dryscope-migrate-test@dryscope.iam',
      password: token,
    });
  });

  it('use the shipped ledger when no directory is given', async () => {
    await migrateFromConfig(migrator, undefined, async () => 'token');
    expect(applyMigrations.mock.calls[0]![1]).toBe(migrationsDirectory);
  });

  it('still take DATABASE_URL elsewhere, and refuse to run with neither', async () => {
    const url = 'postgres://dryscope@127.0.0.1:5432/dryscope';
    await migrateFromConfig({ APP_ENV: 'local', DATABASE_URL: url });
    expect(applyMigrations.mock.calls[0]![0]).toBe(url);
    await expect(migrateFromConfig({ APP_ENV: 'local' })).rejects.toThrow(/DATABASE_URL/);
    expect(applyMigrations).toHaveBeenCalledTimes(1);
  });

  it('refuse half the SQL_* settings before connecting', async () => {
    const partial: Record<string, string> = { ...migrator };
    delete partial.SQL_IAM_USER;
    await expect(migrateFromConfig(partial)).rejects.toThrow(/SQL_IAM_USER: required/);
    expect(applyMigrations).not.toHaveBeenCalled();
  });
});
