import { describe, expect, it } from 'vitest';
import { isVersion, nextVersion, versionFromImageConfig } from '../../scripts/release-version';

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
