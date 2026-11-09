import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '@/lib/config';

describe('parseConfig', () => {
  it('accepts a valid environment', () => {
    expect(parseConfig({ APP_ENV: 'test' })).toEqual({ appEnv: 'test', databaseUrl: null });
  });

  it('refuses a missing variable and names it', () => {
    expect(() => parseConfig({})).toThrow(ConfigError);
    expect(() => parseConfig({})).toThrow(/APP_ENV/);
  });

  it('refuses an invalid value without echoing it', () => {
    expect(() => parseConfig({ APP_ENV: 'secret-value' })).toThrow(ConfigError);
    expect(() => parseConfig({ APP_ENV: 'secret-value' })).not.toThrow(/secret-value/);
  });

  it('returns a postgres URL and refuses an invalid one without echoing it', () => {
    const databaseUrl = 'postgres://user:super-secret-db-password@127.0.0.1:5432/dryscope';
    expect(parseConfig({ APP_ENV: 'local', DATABASE_URL: databaseUrl })).toEqual({
      appEnv: 'local',
      databaseUrl,
    });
    const bad = { APP_ENV: 'test', DATABASE_URL: 'mysql://super-secret-db-password@db.example/app' };
    expect(() => parseConfig(bad)).toThrow(ConfigError);
    expect(() => parseConfig(bad)).not.toThrow(/super-secret-db-password/);
    expect(() => parseConfig({ APP_ENV: 'test', DATABASE_URL: '' })).toThrow(/DATABASE_URL/);
  });
});
