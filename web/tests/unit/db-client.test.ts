import { describe, expect, it } from 'vitest';
import { migrateFromConfig, openDatabase } from '@/db/client';
import { ConfigError } from '@/lib/config';

describe('database config', () => {
  it('names DATABASE_URL when the database is opened without one', () => {
    expect(() => openDatabase({ APP_ENV: 'test' })).toThrow(ConfigError);
    expect(() => openDatabase({ APP_ENV: 'test' })).toThrow(/DATABASE_URL/);
  });

  it('refuses a bad URL before connecting and does not echo it', async () => {
    const env = { APP_ENV: 'test', DATABASE_URL: 'mysql://super-secret-db-password@db.example/app' };
    await expect(migrateFromConfig(env)).rejects.toThrow(ConfigError);
    await expect(migrateFromConfig(env)).rejects.not.toThrow(/super-secret-db-password/);
  });
});
