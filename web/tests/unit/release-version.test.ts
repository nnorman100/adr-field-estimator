import { describe, expect, it } from 'vitest';
import {
  isVersion,
  nextVersion,
  previousRelease,
  releaseComplete,
  versionFromImageConfig,
} from '../../scripts/release-version';

// The old app's deploy.yml tags in this repository (git ls-remote, 2026-11-13), which the new
// release numbering must count (docs/plans/TC.md, "Found while planning").
const OLD_APP_TAGS = [
  '2026.11.04-1',
  '2026.11.04-2',
  '2026.11.04-9',
  '2026.11.04-10',
  '2026.11.09-11',
  '2026.11.10-2',
];

describe('release version numbering', () => {
  it('starts a day at 1', () => {
    expect(nextVersion('2026.11.13', [])).toBe('2026.11.13-1');
    expect(nextVersion('2026.11.13', OLD_APP_TAGS)).toBe('2026.11.13-1');
  });

  it("counts the old app's tags for the same day, numerically", () => {
    expect(nextVersion('2026.11.04', OLD_APP_TAGS)).toBe('2026.11.04-11');
    expect(nextVersion('2026.11.09', OLD_APP_TAGS)).toBe('2026.11.09-12');
  });

  it('gives a second release on the same day the next number', () => {
    const first = nextVersion('2026.11.13', OLD_APP_TAGS);
    expect(nextVersion('2026.11.13', [...OLD_APP_TAGS, first])).toBe('2026.11.13-2');
  });

  it('ignores tags that are not release versions', () => {
    const tags = [
      'infra-test-app-2026.11.13-7',
      '2026.11.13-0',
      '2026.11.13-05',
      'v2026.11.13-9',
      '2026.11.13-3-rc',
      '',
      '  2026.11.13-2  ',
    ];
    expect(nextVersion('2026.11.13', tags)).toBe('2026.11.13-3');
  });

  it.each(['2026-11-13', '2026.13.01', '2026.11.32', '26.11.13', ''])('refuses the date %j', (date) => {
    expect(() => nextVersion(date, [])).toThrow(/YYYY\.MM\.DD/);
  });

  it.each([
    ['2026.11.13-1', true],
    ['2026.11.13-123456', true],
    ['2026.11.13-0', false],
    ['2026.11.13', false],
    ['2026.11.13-1\n', false],
    [42, false],
  ])('recognises %j as a version: %s', (value, valid) => {
    expect(isVersion(value)).toBe(valid);
  });
});

describe('the version a reused image carries', () => {
  it('reads APP_VERSION from the image config', () => {
    const config = { config: { Env: ['PATH=/bin', 'APP_COMMIT=' + 'a'.repeat(40), 'APP_VERSION=2026.11.13-4'] } };
    expect(versionFromImageConfig(config)).toBe('2026.11.13-4');
  });

  it.each([
    [{ config: { Env: ['PATH=/bin'] } }],
    [{ config: { Env: ['APP_VERSION=latest'] } }],
    [{ config: { Env: ['APP_VERSION=2026.11.13-1', 'APP_VERSION=2026.11.13-2'] } }],
    [{ config: {} }],
    [null],
  ])('refuses an image without exactly one valid version: %j', (config) => {
    expect(() => versionFromImageConfig(config)).toThrow(/no valid APP_VERSION/);
  });
});

describe('the previous published release, for a rerun that found its own image serving', () => {
  const release = (tag: string, changes: Record<string, unknown> = {}) => ({
    tag_name: tag,
    draft: false,
    prerelease: true,
    assets: [{ name: 'manifest.json' }],
    ...changes,
  });

  it('picks the newest published test release before this one, by version', () => {
    const releases = [
      release('2026.11.13-3'),
      release('2026.11.13-2'),
      release('2026.11.09-11'),
      release('2026.11.13-1'),
      release('2026.11.10-2'),
    ];
    expect(previousRelease('2026.11.13-2', releases)).toBe('2026.11.13-1');
    expect(previousRelease('2026.11.13-1', releases)).toBe('2026.11.10-2');
    expect(previousRelease('2026.11.14-1', releases)).toBe('2026.11.13-3');
  });

  it.each([
    ['a draft', { draft: true }],
    ['a full release', { prerelease: false }],
    ['one without manifest.json', { assets: [{ name: 'notes.md' }] }],
    ['one without assets', { assets: undefined }],
  ])('passes over %s', (_label, changes) => {
    const releases = [release('2026.11.13-1', changes), release('2026.11.12-4')];
    expect(previousRelease('2026.11.13-2', releases)).toBe('2026.11.12-4');
  });

  it('passes over tags that are not release versions', () => {
    const releases = [release('infra-test-app-2026.11.13-1'), release('v2026.11.13-1'), release('2026.11.12-4')];
    expect(previousRelease('2026.11.13-2', releases)).toBe('2026.11.12-4');
  });

  it.each([[[]], [[release('2026.11.13-2'), release('2026.11.14-1')]], [null]])(
    'refuses when there is no earlier one: %j',
    (releases) => {
      expect(() => previousRelease('2026.11.13-2', releases)).toThrow(/no earlier published test release/);
    },
  );

  it('refuses a version that is not one', () => {
    expect(() => previousRelease('latest', [release('2026.11.12-4')])).toThrow(/--before/);
  });
});

describe('whether an existing GitHub Release is complete', () => {
  const command =
    'gcloud run services update-traffic dryscope-api-test --to-revisions=dryscope-api-test-00011-xyz=100 --region=us-central1 --project=dryscope';
  const complete = {
    isDraft: false,
    isPrerelease: true,
    assets: [{ name: 'manifest.json' }],
    body: `Roll back:\n\n\`\`\`sh\n${command}\n\`\`\`\n`,
  };

  it('keeps a published pre-release with the manifest and this rollback command', () => {
    expect(releaseComplete(complete, command)).toBe(true);
  });

  it.each<[string, object]>([
    ['a draft', { isDraft: true }],
    ['a full release', { isPrerelease: false }],
    ['no manifest.json', { assets: [{ name: 'notes.md' }] }],
    ['no assets', { assets: undefined }],
    ['no notes', { body: '' }],
    ['another rollback command', { body: command.replace('00011-xyz', '00010-pqr') }],
  ])('finishes one with %s', (_label, changes) => {
    expect(releaseComplete({ ...complete, ...changes }, command)).toBe(false);
  });

  it('never calls a Release complete without a rollback command to look for', () => {
    expect(releaseComplete(complete, '')).toBe(false);
    expect(releaseComplete(null, command)).toBe(false);
  });
});
