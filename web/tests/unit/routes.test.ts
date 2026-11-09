import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/echo/route';
import { GET } from '@/app/api/health/route';

const post = (body: string) =>
  POST(new Request('http://localhost/api/echo', { method: 'POST', body }));

afterEach(() => vi.unstubAllEnvs());

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
    const res = GET();
    expect(await res.json()).toEqual({ status: 'ok', env: 'local' });
  });

  it('reports the build commit when the image carries one', async () => {
    const commit = '0123456789abcdef0123456789abcdef01234567';
    vi.stubEnv('APP_ENV', 'test');
    vi.stubEnv('APP_COMMIT', commit);
    const res = GET();
    expect(await res.json()).toEqual({ status: 'ok', env: 'test', commit });
  });
});
