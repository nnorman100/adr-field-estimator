import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '@/lib/config';

describe('parseConfig', () => {
  it('accepts a valid environment', () => {
    expect(parseConfig({ APP_ENV: 'test' })).toEqual({ appEnv: 'test' });
  });

  it('refuses a missing variable and names it', () => {
    expect(() => parseConfig({})).toThrow(ConfigError);
    expect(() => parseConfig({})).toThrow(/APP_ENV/);
  });

  it('refuses an invalid value without echoing it', () => {
    expect(() => parseConfig({ APP_ENV: 'secret-value' })).toThrow(ConfigError);
    expect(() => parseConfig({ APP_ENV: 'secret-value' })).not.toThrow(/secret-value/);
  });
});
