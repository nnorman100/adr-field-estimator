import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig, parseEvidenceConfig } from '@/lib/config';

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

  it('carries the build commit when one is set', () => {
    const commit = 'a'.repeat(40);
    expect(parseConfig({ APP_ENV: 'test', APP_COMMIT: commit })).toEqual({
      appEnv: 'test',
      databaseUrl: null,
      commit,
    });
  });

  it.each([['abc123'], ['A'.repeat(40)], [''], ['secret-value'.padEnd(40, 'x')]])(
    'refuses a malformed commit %s without echoing it',
    (value) => {
      expect(() => parseConfig({ APP_ENV: 'test', APP_COMMIT: value })).toThrow(/APP_COMMIT/);
      if (value) expect(() => parseConfig({ APP_ENV: 'test', APP_COMMIT: value })).not.toThrow(value);
    },
  );
});

describe('parseEvidenceConfig', () => {
  const env = { APP_ENV: 'test', GOOGLE_CLOUD_PROJECT: 'dryscope', EVIDENCE_BUCKET: 'dryscope-evidence-test' };

  it('returns the project and the evidence bucket', () => {
    expect(parseEvidenceConfig(env)).toEqual({ projectId: 'dryscope', bucket: 'dryscope-evidence-test' });
  });

  it('names what is missing, and fails closed', () => {
    expect(() => parseEvidenceConfig({ APP_ENV: 'test', GOOGLE_CLOUD_PROJECT: 'dryscope' })).toThrow(/EVIDENCE_BUCKET/);
    expect(() => parseEvidenceConfig({ APP_ENV: 'test', EVIDENCE_BUCKET: 'dryscope-evidence-test' })).toThrow(/GOOGLE_CLOUD_PROJECT/);
  });

  it.each([['Not A Bucket'], ['x'], ['-leading-hyphen'], ['gs://dryscope-evidence-test'], ['secret-value/../x']])(
    'refuses %j without echoing it',
    (bucket) => {
      expect(() => parseEvidenceConfig({ ...env, EVIDENCE_BUCKET: bucket })).toThrow(ConfigError);
      expect(() => parseEvidenceConfig({ ...env, EVIDENCE_BUCKET: bucket })).not.toThrow(new RegExp(bucket.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
    },
  );
});
