import { describe, expect, it, vi } from 'vitest';
import { connectionOptions } from '@/db/client';
import { createTokenSource } from '@/db/iam-token';
import { ConfigError, parseConfig } from '@/lib/config';

const sql = {
  SQL_CONNECTION_NAME: 'dryscope:us-central1:dryscope-test-pg',
  SQL_DATABASE_NAME: 'dryscope',
  SQL_IAM_USER: 'dryscope-api-test@dryscope.iam',
};

describe('Cloud SQL settings', () => {
  it('needs all three SQL_* settings and names the missing ones', () => {
    expect(() => parseConfig({ APP_ENV: 'test', SQL_CONNECTION_NAME: sql.SQL_CONNECTION_NAME })).toThrow(
      /SQL_DATABASE_NAME: required.*SQL_IAM_USER: required/,
    );
  });

  it('refuses SQL_* together with DATABASE_URL', () => {
    const env = { APP_ENV: 'test', ...sql, DATABASE_URL: 'postgres://u@127.0.0.1:5432/d' };
    expect(() => parseConfig(env)).toThrow(/not both/);
  });

  it.each([
    ['SQL_CONNECTION_NAME', 'secret-value'],
    ['SQL_DATABASE_NAME', 'secret value'],
    ['SQL_IAM_USER', 'secret-value@dryscope.iam.gserviceaccount.com'],
  ])('refuses a malformed %s without echoing it', (key, value) => {
    const env = { APP_ENV: 'test', ...sql, [key]: value };
    expect(() => parseConfig(env)).toThrow(ConfigError);
    expect(() => parseConfig(env)).toThrow(new RegExp(key));
    expect(() => parseConfig(env)).not.toThrow(/secret/);
  });

  it('leaves Cloud SQL unset when none of the settings are given', () => {
    expect(parseConfig({ APP_ENV: 'local' }).cloudSql).toBeUndefined();
  });

  it('still opens DATABASE_URL locally and refuses when neither is set', () => {
    const url = 'postgres://dryscope@127.0.0.1:5432/dryscope';
    expect(connectionOptions(parseConfig({ APP_ENV: 'local', DATABASE_URL: url })).url).toBe(url);
    expect(() => connectionOptions(parseConfig({ APP_ENV: 'local' }))).toThrow(/DATABASE_URL or the SQL_\*/);
  });
});

describe('IAM database access token', () => {
  const answer = (body: unknown, status = 200) => Response.json(body, { status });

  it('asks the metadata server as the service account and caches until near expiry', async () => {
    let clock = 0;
    const fetchImpl = vi.fn(async () => answer({ access_token: `t${fetchImpl.mock.calls.length}`, expires_in: 3600 }));
    const token = createTokenSource(fetchImpl as unknown as typeof fetch, () => clock);
    expect(await token()).toBe('t1');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    );
    expect(init.headers).toEqual({ 'Metadata-Flavor': 'Google' });
    clock = 54 * 60 * 1000; // still more than five minutes left
    expect(await token()).toBe('t1');
    clock = 56 * 60 * 1000; // inside the refresh margin
    expect(await token()).toBe('t2');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('fails without echoing what the metadata server sent', async () => {
    const refused = createTokenSource((async () => answer({}, 403)) as unknown as typeof fetch);
    await expect(refused()).rejects.toThrow(/403/);
    const odd = createTokenSource((async () => answer({ access_token: '', secret: 'x' })) as unknown as typeof fetch);
    await expect(odd()).rejects.toThrow('metadata server returned an unexpected token response');
  });
});
