import { describe, expect, it } from 'vitest';
import { publicPage } from '@/app/app-update';

// The homeowner's signing page and the adjuster's documents page get no update banner and no
// field worker; the technician's and the office's pages do.
describe('the pages that watch for an update', () => {
  it.each(['/sign', '/sign/', '/sign/anything', '/documents', '/documents/anything'])('leaves %s alone', (path) => {
    expect(publicPage(path)).toBe(true);
  });

  it.each(['/', '/field', '/field/jobs', '/sign-in/acme', '/sign-in/acme/jobs/1/finish', '/operator/t1', '/signs', null])('watches %s', (path) => {
    expect(publicPage(path)).toBe(false);
  });
});
