import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AI_FEATURES } from '@/lib/ai/registry';
import { FLAG_NAMES } from '@/lib/flags';
import {
  buildManifest,
  DATABASE_RULE,
  migrationLevel,
  newestTerraformTag,
  parseTraffic,
  ReleaseManifest,
  releaseNotes,
  releasedBefore,
  rollbackCommand,
  type ManifestInput,
} from '../../scripts/release-manifest';

const WEB = path.resolve(__dirname, '../..');
const commit = '0123456789abcdef0123456789abcdef01234567';
const digest = `sha256:${'b'.repeat(64)}`;
const image = `us-central1-docker.pkg.dev/dryscope/dryscope-test/web@${digest}`;
const run = 'https://github.com/owner/repo/actions/runs/123';

const input = (changes: Partial<ManifestInput> = {}): ManifestInput => ({
  version: '2026.11.13-2',
  commit,
  image,
  revision: 'dryscope-api-test-00012-abc',
  replaced: 'dryscope-api-test-00011-xyz=100',
  run,
  migrations: ['0001_foundation.sql', '0012_ai_live_tables.sql', '0002_identity.sql'],
  tags: [],
  ...changes,
});

describe('release manifest', () => {
  it('records the release, its replaced traffic and the exact rollback command', () => {
    const manifest = buildManifest(input());
    expect(manifest).toMatchObject({
      schema: 1,
      version: '2026.11.13-2',
      environment: 'test',
      commit,
      image,
      imageDigest: digest,
      revision: 'dryscope-api-test-00012-abc',
      replaced: [{ revision: 'dryscope-api-test-00011-xyz', percent: 100 }],
      migrationLevel: '0012_ai_live_tables.sql',
      terraformTags: { data: null, app: null },
      minClientEpoch: null,
      run,
    });
    expect(manifest.rollback).toEqual({
      command:
        'gcloud run services update-traffic dryscope-api-test --to-revisions=dryscope-api-test-00011-xyz=100 --region=us-central1 --project=dryscope',
      database: DATABASE_RULE,
    });
  });

  it('rolls back to the remembered split exactly when traffic was split', () => {
    const replaced = 'dryscope-api-test-00011-xyz=90,dryscope-api-test-00009-def=10';
    expect(buildManifest(input({ replaced })).rollback!.command).toContain(
      `--to-revisions=${replaced} `,
    );
    expect(rollbackCommand(parseTraffic(replaced))).toBe(
      `gcloud run services update-traffic dryscope-api-test --to-revisions=${replaced} --region=us-central1 --project=dryscope`,
    );
  });

  it("rolls back to the previous release's revision on a rerun that found its own image serving", () => {
    const earlier = buildManifest(
      input({ version: '2026.11.12-4', revision: 'dryscope-api-test-00010-pqr', replaced: 'dryscope-api-test-00009-def=100' }),
    );
    // A full rerun: deploy remembered the traffic of this release's own first revision.
    const rerun = buildManifest(
      input({ revision: 'dryscope-api-test-00013-new', replaced: 'dryscope-api-test-00012-abc=100', previousRelease: earlier }),
    );
    expect(rerun.replaced).toEqual([{ revision: 'dryscope-api-test-00010-pqr', percent: 100 }]);
    expect(rerun.rollback!.command).toBe(
      'gcloud run services update-traffic dryscope-api-test --to-revisions=dryscope-api-test-00010-pqr=100 --region=us-central1 --project=dryscope',
    );
    expect(releasedBefore(earlier, { version: '2026.11.13-2', revision: 'dryscope-api-test-00013-new' })).toEqual(
      rerun.replaced,
    );
  });

  it('reads a previous release manifest made before a switch existed, and still refuses an unknown or switched-on one', () => {
    const earlier = buildManifest(
      input({ version: '2026.11.12-4', revision: 'dryscope-api-test-00010-pqr', replaced: 'dryscope-api-test-00009-def=100' }),
    );
    const at = { version: '2026.11.13-2', revision: 'dryscope-api-test-00013-new' };
    // An earlier release knew fewer switches: each known switch may be missing from its manifest.
    for (const missing of FLAG_NAMES) {
      const older = { ...earlier, switchDefaults: Object.fromEntries(Object.entries(earlier.switchDefaults).filter(([name]) => name !== missing)) };
      expect({ missing, replaced: releasedBefore(older, at) }).toEqual({ missing, replaced: [{ revision: 'dryscope-api-test-00010-pqr', percent: 100 }] });
    }
    expect(releasedBefore({ ...earlier, switchDefaults: {} }, at)).toEqual([{ revision: 'dryscope-api-test-00010-pqr', percent: 100 }]);
    // A name no release knows, or a switch recorded on, is still not a valid manifest.
    expect(() => releasedBefore({ ...earlier, switchDefaults: { ...earlier.switchDefaults, not_a_switch: false } }, at)).toThrow(/not valid/);
    expect(() => releasedBefore({ ...earlier, switchDefaults: { ...earlier.switchDefaults, price_books: true } }, at)).toThrow(/not valid/);
    // This release's own manifest still lists every switch it knows.
    expect(ReleaseManifest.safeParse({ ...earlier, switchDefaults: {} }).success).toBe(false);
  });

  it.each<[string, unknown]>([
    ['this release itself', { version: '2026.11.13-2' }],
    ['the same revision', { revision: 'dryscope-api-test-00012-abc' }],
  ])('refuses a previous release manifest that is %s', (_label, changes) => {
    const previous = { ...buildManifest(input({ version: '2026.11.12-4', revision: 'dryscope-api-test-00010-pqr' })), ...(changes as object) };
    expect(() => buildManifest(input({ previousRelease: previous }))).toThrow(/this release, not an earlier one/);
  });

  it.each([[null], [{}], [{ revision: 'dryscope-api-test-00010-pqr' }]])(
    'refuses a previous release manifest that is not valid: %j',
    (previous) => {
      expect(() => buildManifest(input({ previousRelease: previous }))).toThrow(/previous release manifest is not valid/);
    },
  );

  it('lists every switch off and every AI feature with its model and prompt version', () => {
    const manifest = buildManifest(input());
    expect(manifest.switchDefaults).toEqual(Object.fromEntries(FLAG_NAMES.map((n) => [n, false])));
    expect(manifest.ai.map((a) => a.feature)).toEqual([...AI_FEATURES]);
    for (const entry of manifest.ai) {
      expect(entry.model).toMatch(/^gemini-/);
      expect(entry.promptVersion === null || /^[0-9a-f]{64}$/.test(entry.promptVersion)).toBe(true);
    }
  });

  it('takes the migration level from the highest numbered file only', () => {
    expect(migrationLevel(['0002_b.sql', '0010_c.sql', '0009_a.sql'])).toBe('0010_c.sql');
    expect(migrationLevel(['0003_a.sql', 'README.md', '9999_x.sql.bak', '.keep'])).toBe('0003_a.sql');
    expect(migrationLevel([])).toBeNull();
    // The real ledger, as the migrate job applies it.
    const files = readdirSync(path.join(WEB, 'migrations'));
    expect(buildManifest(input({ migrations: files })).migrationLevel).toBe(
      files.filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort().at(-1),
    );
  });

  it('names the newest infra-test tag per Terraform root', () => {
    const tags = [
      'infra-test-data-2026.11.09-3',
      'infra-test-data-2026.11.10-1',
      'infra-test-app-2026.11.10-2',
      'infra-test-app-2026.11.10-10',
      'infra-live-app-2026.11.12-1',
      'infra-test-app-2026.11.13-0',
      '2026.11.13-1',
    ];
    expect(newestTerraformTag('data', tags)).toBe('infra-test-data-2026.11.10-1');
    expect(newestTerraformTag('app', tags)).toBe('infra-test-app-2026.11.10-10');
    expect(buildManifest(input({ tags })).terraformTags).toEqual({
      data: 'infra-test-data-2026.11.10-1',
      app: 'infra-test-app-2026.11.10-10',
    });
  });

  it.each<[string, Partial<ManifestInput>, RegExp]>([
    ['a bad version', { version: '2026.11.13' }, /version/],
    ['another commit form', { commit: 'abc' }, /commit/],
    ['an image outside the test repository', { image: image.replace('dryscope-test', 'dryscope-live') }, /image/],
    ['an image by tag', { image: `${image.split('@')[0]}:latest` }, /image/],
    ['another service revision', { revision: 'dryscope-api-live-00001-abc' }, /revision/],
    ['a revision that could break the command', { revision: 'dryscope-api-test-1;rm' }, /revision/],
    ['a split not adding to 100', { replaced: 'dryscope-api-test-00011-xyz=90' }, /100/],
    ['an empty split', { replaced: '' }, /replaced/],
    ['a split without a percent', { replaced: 'dryscope-api-test-00011-xyz' }, /replaced/],
    ['a run URL that is not https', { run: 'http://github.com/x' }, /run/],
  ])('refuses %s', (_label, changes, problem) => {
    expect(() => buildManifest(input(changes))).toThrow(problem);
  });

  it('has a strict schema: no unknown field, no switch default on', () => {
    const manifest = buildManifest(input());
    expect(ReleaseManifest.safeParse({ ...manifest, extra: 1 }).success).toBe(false);
    const on = { ...manifest, switchDefaults: { ...manifest.switchDefaults, price_books: true } };
    expect(ReleaseManifest.safeParse(on).success).toBe(false);
    expect(ReleaseManifest.safeParse({ ...manifest, switchDefaults: {} }).success).toBe(false);
  });

  it('records the first release with no rollback target, and says so in its notes', () => {
    const manifest = buildManifest(input({ firstRelease: true }));
    expect(manifest.firstRelease).toBe(true);
    expect(manifest.rollback).toBeNull();
    const notes = releaseNotes(manifest);
    expect(notes).toContain('\nFirst recorded release: there is no earlier DryScope release to return to.\n');
    expect(notes).not.toContain('update-traffic');
    expect(buildManifest(input()).firstRelease).toBe(false);
  });

  it('allows no rollback only for the first recorded release', () => {
    const manifest = buildManifest(input());
    expect(ReleaseManifest.safeParse({ ...manifest, rollback: null }).success).toBe(false);
    const first = buildManifest(input({ firstRelease: true }));
    expect(ReleaseManifest.safeParse({ ...first, rollback: manifest.rollback }).success).toBe(false);
    expect(ReleaseManifest.safeParse({ ...first, firstRelease: false }).success).toBe(false);
    expect(ReleaseManifest.safeParse(first).success).toBe(true);
  });

  it('refuses a first release that also names a previous release', () => {
    const earlier = buildManifest(input({ version: '2026.11.12-4', revision: 'dryscope-api-test-00010-pqr' }));
    expect(() => buildManifest(input({ firstRelease: true, previousRelease: earlier }))).toThrow(
      /first release has no previous release/,
    );
  });

  it('puts the rollback command and the database rule in the Release notes', () => {
    const manifest = buildManifest(input());
    const notes = releaseNotes(manifest);
    expect(notes).toContain('```sh\n' + manifest.rollback!.command + '\n```');
    expect(notes).toContain(DATABASE_RULE);
    expect(notes).toContain('0012_ai_live_tables.sql');
  });
});

describe('the manifest command, as the record job runs it', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('writes a valid manifest.json and notes from the checkout and the tags on stdin', () => {
    const out = mkdtempSync(path.join(tmpdir(), 'release-manifest-'));
    dirs.push(out);
    const args = [
      'tsx',
      'scripts/release-manifest.ts',
      ...['--version', '2026.11.13-2', '--commit', commit, '--image', image],
      ...['--revision', 'dryscope-api-test-00012-abc', '--replaced', 'dryscope-api-test-00011-xyz=100'],
      ...['--run', run, '--out', `${out}/manifest.json`, '--notes', `${out}/notes.md`],
    ];
    const result = spawnSync('npx', args, {
      cwd: WEB,
      input: 'infra-test-app-2026.11.12-1\ninfra-test-data-2026.11.10-2\n',
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(result.status, result.stderr).toBe(0);
    const manifest = ReleaseManifest.parse(JSON.parse(readFileSync(`${out}/manifest.json`, 'utf8')));
    expect(manifest.terraformTags).toEqual({
      data: 'infra-test-data-2026.11.10-2',
      app: 'infra-test-app-2026.11.12-1',
    });
    expect(manifest.migrationLevel).toMatch(/^\d{4}_\w+\.sql$/);
    expect(readFileSync(`${out}/notes.md`, 'utf8')).toContain(manifest.rollback!.command);
  }, 60_000);

  it('takes the rollback target from the previous release manifest it is given', () => {
    const out = mkdtempSync(path.join(tmpdir(), 'release-manifest-'));
    dirs.push(out);
    const earlier = buildManifest(input({ version: '2026.11.12-4', revision: 'dryscope-api-test-00010-pqr' }));
    writeFileSync(`${out}/earlier.json`, JSON.stringify(earlier));
    const args = [
      'tsx',
      'scripts/release-manifest.ts',
      ...['--version', '2026.11.13-2', '--commit', commit, '--image', image],
      ...['--revision', 'dryscope-api-test-00013-new', '--replaced', 'dryscope-api-test-00012-abc=100'],
      ...['--run', run, '--out', `${out}/manifest.json`, '--notes', `${out}/notes.md`],
      ...['--previous-release', `${out}/earlier.json`],
    ];
    const result = spawnSync('npx', args, { cwd: WEB, input: '', encoding: 'utf8', timeout: 60_000 });
    expect(result.status, result.stderr).toBe(0);
    const manifest = ReleaseManifest.parse(JSON.parse(readFileSync(`${out}/manifest.json`, 'utf8')));
    expect(manifest.replaced).toEqual([{ revision: 'dryscope-api-test-00010-pqr', percent: 100 }]);
    expect(readFileSync(`${out}/notes.md`, 'utf8')).toContain('--to-revisions=dryscope-api-test-00010-pqr=100 ');
  }, 60_000);

  it('writes a first release with --first-release', () => {
    const out = mkdtempSync(path.join(tmpdir(), 'release-manifest-'));
    dirs.push(out);
    const args = [
      'tsx',
      'scripts/release-manifest.ts',
      ...['--version', '2026.11.13-2', '--commit', commit, '--image', image],
      ...['--revision', 'dryscope-api-test-00013-new', '--replaced', 'dryscope-api-test-00012-abc=100'],
      ...['--run', run, '--out', `${out}/manifest.json`, '--notes', `${out}/notes.md`, '--first-release'],
    ];
    const result = spawnSync('npx', args, { cwd: WEB, input: '', encoding: 'utf8', timeout: 60_000 });
    expect(result.status, result.stderr).toBe(0);
    const manifest = ReleaseManifest.parse(JSON.parse(readFileSync(`${out}/manifest.json`, 'utf8')));
    expect(manifest).toMatchObject({ firstRelease: true, rollback: null });
    expect(readFileSync(`${out}/notes.md`, 'utf8')).toContain(
      'First recorded release: there is no earlier DryScope release to return to.',
    );
  }, 60_000);

  it('fails without writing when an argument is missing', () => {
    const out = mkdtempSync(path.join(tmpdir(), 'release-manifest-'));
    dirs.push(out);
    const result = spawnSync('npx', ['tsx', 'scripts/release-manifest.ts', '--version', '2026.11.13-2'], {
      cwd: WEB,
      input: '',
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--commit is required');
    expect(readdirSync(out)).toEqual([]);
  }, 60_000);
});
