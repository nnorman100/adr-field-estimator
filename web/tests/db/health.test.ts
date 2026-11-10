import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/health/route';
import { startDisposablePostgres, type DisposablePostgres } from './postgres-harness';

let disposable: DisposablePostgres;

beforeAll(async () => {
  disposable = await startDisposablePostgres();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await disposable?.stop();
});

describe('health route with a database', () => {
  it('answers ok once the configured database accepts the login', async () => {
    vi.stubEnv('APP_ENV', 'test');
    vi.stubEnv('DATABASE_URL', disposable.databaseUrl);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', env: 'test', database: 'ok' });
  });
});
