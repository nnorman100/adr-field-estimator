import { describe, expect, it } from 'vitest';
import { FLAG_NAMES } from '@/lib/flags';
import { buildManifest, releasedBefore, type ManifestInput } from '../../scripts/release-manifest';

// A release recorded before a switch existed (S5b-11 added `readiness`) must still give a rerun its
// rollback target: the record job reads that previous manifest with today's switch list. A new
// manifest still lists every switch, and a previous one naming a switch on or no switch at all is
// still refused.

const input = (changes: Partial<ManifestInput> = {}): ManifestInput => ({
  version: '2026.11.21-1',
  commit: '0123456789abcdef0123456789abcdef01234567',
  image: `us-central1-docker.pkg.dev/dryscope/dryscope-test/web@sha256:${'b'.repeat(64)}`,
  revision: 'dryscope-api-test-00021-abc',
  replaced: 'dryscope-api-test-00020-xyz=100',
  run: 'https://github.com/owner/repo/actions/runs/123',
  migrations: ['0001_foundation.sql'],
  tags: [],
  ...changes,
});

// The previous release as an older app version wrote it, with the switches of its time.
function earlierWithout(...missing: string[]) {
  const earlier = buildManifest(input({ version: '2026.11.20-3', revision: 'dryscope-api-test-00019-pqr', replaced: 'dryscope-api-test-00018-def=100' }));
  const switchDefaults = Object.fromEntries(Object.entries(earlier.switchDefaults).filter(([name]) => !missing.includes(name)));
  return JSON.parse(JSON.stringify({ ...earlier, switchDefaults })) as unknown;
}

describe('a previous release manifest from before a switch existed', () => {
  it('still gives a rerun the previous release as its rollback target', () => {
    const earlier = earlierWithout('readiness');
    expect(Object.keys((earlier as { switchDefaults: object }).switchDefaults)).not.toContain('readiness');
    const rerun = buildManifest(input({ revision: 'dryscope-api-test-00022-new', replaced: 'dryscope-api-test-00021-abc=100', previousRelease: earlier }));
    expect(rerun.replaced).toEqual([{ revision: 'dryscope-api-test-00019-pqr', percent: 100 }]);
    expect(releasedBefore(earlier, { version: '2026.11.21-1', revision: 'dryscope-api-test-00022-new' })).toEqual(rerun.replaced);
    // The new manifest itself lists every switch, each off.
    expect(rerun.switchDefaults).toEqual(Object.fromEntries(FLAG_NAMES.map((name) => [name, false])));
  });

  it('is still refused when it names a switch on, or a name that is no switch', () => {
    const on = { ...(earlierWithout('readiness') as object), switchDefaults: { price_books: true } };
    expect(() => releasedBefore(on, { version: '2026.11.21-1', revision: 'dryscope-api-test-00022-new' })).toThrow(/not valid/);
    const unknown = { ...(earlierWithout() as object), switchDefaults: { not_a_switch: false } };
    expect(() => releasedBefore(unknown, { version: '2026.11.21-1', revision: 'dryscope-api-test-00022-new' })).toThrow(/not valid/);
  });
});
