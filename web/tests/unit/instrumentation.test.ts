import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { register } from '@/instrumentation';

let exit: ReturnType<typeof vi.spyOn>;
let logged: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  logged = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('server start', () => {
  it('stops the process without APP_ENV and names it', () => {
    vi.stubEnv('APP_ENV', undefined);
    register();
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(logged.mock.calls[0]?.[0])).toMatch(/APP_ENV/);
  });

  it('stops the process on an invalid APP_ENV without echoing it', () => {
    vi.stubEnv('APP_ENV', 'secret-value');
    register();
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(logged.mock.calls[0]?.[0])).not.toMatch(/secret-value/);
  });

  it('starts with a valid APP_ENV and no database URL', () => {
    vi.stubEnv('APP_ENV', 'test');
    vi.stubEnv('DATABASE_URL', undefined);
    register();
    expect(exit).not.toHaveBeenCalled();
  });

  it('stops on an invalid DATABASE_URL without echoing it', () => {
    vi.stubEnv('APP_ENV', 'test');
    vi.stubEnv('DATABASE_URL', 'mysql://super-secret-db-password@db.example/app');
    register();
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(logged.mock.calls[0]?.[0])).toMatch(/DATABASE_URL/);
    expect(String(logged.mock.calls[0]?.[0])).not.toMatch(/super-secret-db-password/);
  });
});
