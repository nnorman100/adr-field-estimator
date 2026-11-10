import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/echo/route';
import { GET } from '@/app/api/health/route';

const post = (body: string) =>
  POST(new Request('http://localhost/api/echo', { method: 'POST', body }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('echo route', () => {
  it('returns the validated message', async () => {
    const res = await post(JSON.stringify({ message: '  hello ' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: 'hello' });
  });

  it.each([['not json'], [JSON.stringify({})], [JSON.stringify({ message: '' })]])(
    'rejects %s with 400',
    async (body) => {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('invalid_request');
    },
  );
});

describe('health route', () => {
  it('reports ok with the environment name', async () => {
    vi.stubEnv('APP_ENV', 'local');
    const res = await GET();
    expect(await res.json()).toEqual({ status: 'ok', env: 'local' });
  });

  it('reports the build commit when the image carries one', async () => {
    const commit = '0123456789abcdef0123456789abcdef01234567';
    vi.stubEnv('APP_ENV', 'test');
    vi.stubEnv('APP_COMMIT', commit);
    const res = await GET();
    expect(await res.json()).toEqual({ status: 'ok', env: 'test', commit });
  });

  it('answers 503 without echoing settings when the Cloud SQL login cannot be made', async () => {
    vi.stubEnv('APP_ENV', 'test');
    vi.stubEnv('SQL_CONNECTION_NAME', 'dryscope:us-central1:dryscope-test-pg');
    vi.stubEnv('SQL_DATABASE_NAME', 'dryscope');
    vi.stubEnv('SQL_IAM_USER', 'dryscope-api-test@dryscope.iam');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'unavailable', env: 'test' });
    expect(logged).toHaveBeenCalledOnce();
    expect(String(logged.mock.calls[0])).not.toMatch(/dryscope/);
  });
});
