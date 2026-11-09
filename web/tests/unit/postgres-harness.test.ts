import { describe, expect, it } from 'vitest';
import { assertHarnessAllowed, quoteDiscardName } from '../db/postgres-harness';

describe('disposable database guard', () => {
  it('refuses a live environment', () => {
    expect(() => assertHarnessAllowed({ APP_ENV: 'live' })).toThrow(/live/);
  });

  it('refuses a non-loopback URL without echoing the password', () => {
    const env = {
      APP_ENV: 'test',
      DATABASE_URL: 'postgres://user:super-secret-db-password@db.example:5432/dryscope',
      DRYSCOPE_DISPOSABLE_DATABASE: '1',
    };
    expect(() => assertHarnessAllowed(env)).toThrow(/non-loopback/);
    expect(() => assertHarnessAllowed(env)).not.toThrow(/super-secret-db-password/);
  });

  it('refuses query parameters that move the connection to another host or database', () => {
    for (const DATABASE_URL of [
      'postgres://user:password@127.0.0.1/postgres?host=remote-db.example',
      'postgres://user:password@127.0.0.1/postgres?database=dryscope',
      'postgres://user:password@127.0.0.1#@remote-db.example/postgres',
    ]) {
      expect(() =>
        assertHarnessAllowed({ APP_ENV: 'test', DATABASE_URL, DRYSCOPE_DISPOSABLE_DATABASE: '1' }),
      ).toThrow(/query parameters or a fragment/);
    }
  });

  it('requires an explicit opt-in before using DATABASE_URL', () => {
    expect(() =>
      assertHarnessAllowed({
        APP_ENV: 'test',
        DATABASE_URL: 'postgres://user:super-secret-db-password@127.0.0.1:5432/dryscope',
      }),
    ).toThrow(/DRYSCOPE_DISPOSABLE_DATABASE/);
  });

  it('accepts a loopback URL that is marked disposable', () => {
    expect(() =>
      assertHarnessAllowed({
        APP_ENV: 'test',
        DATABASE_URL: 'postgres://dryscope:dryscope@127.0.0.1:5432/dryscope',
        DRYSCOPE_DISPOSABLE_DATABASE: '1',
      }),
    ).not.toThrow();
  });

  it('quotes only a generated throwaway name', () => {
    expect(quoteDiscardName('dryscope_discard_0123456789abcdef')).toBe('"dryscope_discard_0123456789abcdef"');
    expect(() => quoteDiscardName('dryscope')).toThrow(/throwaway/);
    expect(() => quoteDiscardName('dryscope_discard_0123456789abcdef"; DROP DATABASE postgres')).toThrow(
      /throwaway/,
    );
  });
});
