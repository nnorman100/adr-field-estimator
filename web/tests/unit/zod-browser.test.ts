import { expect, it } from 'vitest';
import { z } from 'zod';
import '@/lib/zod-browser';

// Under the content policy (no 'unsafe-eval'), Zod's own test for run-time code compilation would
// be refused and reported on every page. The browser entry turns the fast path off instead.
it('turns Zod’s compiled fast path off for the browser', () => {
  expect(z.config().jitless).toBe(true);
  expect(z.object({ a: z.string() }).parse({ a: 'x' })).toEqual({ a: 'x' });
});
