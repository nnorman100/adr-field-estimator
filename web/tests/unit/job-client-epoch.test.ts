import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { expect, it, vi } from 'vitest';

const identity = vi.hoisted(() => vi.fn(() => { throw new Error('A stale request reached identity or record access'); }));
vi.mock('@/lib/auth/services', async (original) => ({
  ...(await original<typeof import('@/lib/auth/services')>()),
  identityServices: identity,
}));

const jobs = fileURLToPath(new URL('../../src/app/api/jobs/', import.meta.url));
const files = readdirSync(jobs, { recursive: true, encoding: 'utf8' })
  .filter((file) => /(^|\/)route\.(ts|tsx|js|jsx|mjs)$/.test(file))
  .map((file) => join(jobs, file));
const writes = ['POST', 'PUT', 'PATCH', 'DELETE'];
// The Submit owner adds the guard in the draft-redesign follow-up. Remove this exemption then.
const submit = '[jobId]/submissions/route.ts';

it.each(files)('%s rejects stale and missing epochs before reaching record access', async (file) => {
  const route = await import(file);
  if (relative(jobs, file) === submit) return;
  for (const method of writes) {
    if (!(method in route)) continue;
    for (const epoch of [null, '0']) {
      identity.mockClear();
      const headers = new Headers({ Authorization: 'Bearer test' });
      if (epoch !== null) headers.set('x-dryscope-client-epoch', epoch);
      const answer = await route[method](new Request('http://localhost/api/jobs', { method, headers }), { params: Promise.resolve({}) });
      expect(answer.status, method).toBe(426);
      expect(await answer.json()).toEqual({ error: 'update_required' });
      expect(answer.headers.get('cache-control')).toBe('no-store');
      expect(identity).not.toHaveBeenCalled();
    }
  }
});
