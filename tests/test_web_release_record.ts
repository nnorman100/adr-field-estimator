// The release record's shell (docs/plans/TC.md, TC-8): the failed-release line, the version tag,
// the GitHub Release, the manifest step and the pinned gh install of the record job in
// .github/workflows/web-release.yml, run with fake commands. The job's structure (what it needs, who
// can write, when the tag and the failure line happen) is checked in tests/test_web_release_workflow.ts.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { load, type Ran, RELEASE, Shell, steps, type Data } from './workflow_support.ts';

const release: Data = load(RELEASE);
const record = release.jobs.record;
const SUCCESS = "needs.deploy.result == 'success'";
const RUN_URL = 'https://github.com/owner/repo/actions/runs/123';
const IMAGE_REF = `us-central1-docker.pkg.dev/dryscope/dryscope-test/web@sha256:${'c'.repeat(64)}`;

const shells: Shell[] = [];
afterEach(() => {
  for (const s of shells.splice(0)) rmSync(s.tmp, { recursive: true, force: true });
});
function shell(): Shell {
  const s = new Shell();
  shells.push(s);
  return s;
}

const recordStep = (key: string) =>
  steps(record).find((s: Data) => (s.id ?? s.name ?? String(s.uses ?? '').split('@')[0]) === key);

describe('the release record job', () => {
  it.each([
    ['2026.11.13-2', '"2026.11.13-2"'],
    ['', 'null'],
    ['not a version', 'null'],
  ])('writes one ERROR line to dryscope-release (version %j)', (version, expected) => {
    const sh = shell();
    sh.fake('gcloud');
    const result = sh.run(recordStep('failed').run, { ...release.env, VERSION: version, RUN_URL });
    expect(result.status, result.stderr).toBe(0);
    const calls = sh.calls('gcloud');
    expect(calls).toHaveLength(1);
    const [write] = calls;
    expect(write.slice(0, 3)).toEqual(['logging', 'write', 'dryscope-release']);
    expect(write.slice(4)).toEqual([
      '--payload-type=json',
      '--severity=ERROR',
      '--project=dryscope',
    ]);
    expect(JSON.parse(write[3])).toEqual({
      env: 'test',
      version: JSON.parse(expected),
      result: 'failed',
      run: RUN_URL,
    });
  });

  it('fails loudly, naming the missing grant, when the line cannot be written', () => {
    const sh = shell();
    sh.fake('gcloud', 'exit 1');
    const result = sh.run(recordStep('failed').run, {
      ...release.env,
      VERSION: '2026.11.13-2',
      RUN_URL,
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('roles/logging.logWriter');
  });

  it('refuses a run URL that could break the line', () => {
    const sh = shell();
    sh.fake('gcloud');
    const result = sh.run(recordStep('failed').run, {
      ...release.env,
      VERSION: '',
      RUN_URL: 'https://x/"}',
    });
    expect(result.status).not.toBe(0);
    expect(sh.calls('gcloud')).toEqual([]);
  });

  const COMMIT = 'c'.repeat(40);
  const tagEnv = { ...release.env, COMMIT, VERSION: '2026.11.13-2', GH_REPO: 'owner/repo' };

  it.each([
    ['no tag yet', 'exit 1', true, 0],
    ['the tag on this commit (a rerun)', `echo ${'c'.repeat(40)}`, false, 0],
    ['the tag on another commit', `echo ${'d'.repeat(40)}`, false, 1],
  ])('tags the released commit, never moving a tag: %s', (_label, lookup, creates, status) => {
    const sh = shell();
    sh.fake('gh', `[ "$2" = repos/owner/repo/git/refs ] && exit 0; ${lookup}`);
    const result = sh.run(recordStep('tag').run, tagEnv);
    expect(result.status === 0 ? 0 : 1, result.stdout + result.stderr).toBe(status);
    const calls = sh.calls('gh');
    expect(calls[0]).toEqual([
      'api',
      'repos/owner/repo/git/ref/tags/2026.11.13-2',
      '--jq',
      '.object.sha',
    ]);
    const created = calls.filter((args) => args[1] === 'repos/owner/repo/git/refs');
    expect(created).toEqual(
      creates
        ? [
            [
              'api',
              'repos/owner/repo/git/refs',
              '-f',
              'ref=refs/tags/2026.11.13-2',
              '-f',
              `sha=${COMMIT}`,
              '--silent',
            ],
          ]
        : [],
    );
  });

  it.each([true, false])(
    'publishes a pre-release with the manifest once (exists: %s)',
    (exists) => {
      const sh = shell();
      sh.fake('gh', `[ "$2" = view ] && exit ${exists ? 0 : 1}; exit 0`);
      const result = sh.run(recordStep('release').run, { ...tagEnv, RUNNER_TEMP: sh.tmp });
      expect(result.status, result.stderr).toBe(0);
      const created = sh.calls('gh').filter((args) => args[1] === 'create');
      expect(created).toEqual(
        exists
          ? []
          : [
              [
                'release',
                'create',
                '2026.11.13-2',
                `${sh.tmp}/manifest.json`,
                '--verify-tag',
                '--prerelease',
                '--title',
                '2026.11.13-2 (test)',
                '--notes-file',
                `${sh.tmp}/notes.md`,
              ],
            ],
      );
    },
  );

  it('builds the manifest from the released commit and its infra-test tags', () => {
    const sh = shell();
    sh.fake('git', "printf 'infra-test-data-2026.11.10-1\\n'");
    sh.fake('npx', 'cat > "$HOME/stdin"; echo notes > "$RUNNER_TEMP/notes.md"');
    const env = {
      ...release.env,
      COMMIT,
      VERSION: '2026.11.13-2',
      RUN_URL,
      RUNNER_TEMP: sh.tmp,
      IMAGE_REF,
      REVISION: 'dryscope-api-test-00012-abc',
      PREVIOUS: 'dryscope-api-test-00011-xyz=100',
    };
    const result = sh.run(recordStep('manifest').run, env);
    expect(result.status, result.stderr).toBe(0);
    expect(sh.calls('git')).toEqual([['tag', '--list', 'infra-test-*']]);
    expect(readFileSync(path.join(sh.tmp, 'stdin'), 'utf8')).toBe('infra-test-data-2026.11.10-1\n');
    expect(sh.calls('npx')).toEqual([
      [
        'tsx',
        'scripts/release-manifest.ts',
        '--version',
        '2026.11.13-2',
        '--commit',
        COMMIT,
        '--image',
        IMAGE_REF,
        '--revision',
        'dryscope-api-test-00012-abc',
        '--replaced',
        'dryscope-api-test-00011-xyz=100',
        '--run',
        RUN_URL,
        '--out',
        `${sh.tmp}/manifest.json`,
        '--notes',
        `${sh.tmp}/notes.md`,
      ],
    ]);
    expect(recordStep('manifest')['working-directory']).toBe('web');
    expect(readFileSync(sh.summary, 'utf8')).toBe('notes\n');
  });

  it('installs the same pinned gh as deploy.yml, only after a release', () => {
    const old = steps(load(path.join(path.dirname(RELEASE), 'deploy.yml')).jobs.deploy).find(
      (s: Data) => s.name === 'Install GitHub CLI',
    );
    const install = recordStep('Install GitHub CLI');
    expect(install.env).toEqual(old.env);
    expect(install.env.GH_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(install.if).toBe(SUCCESS);
  });

  // The install step with fake curl and tar and the real sha256sum, on a PATH without gh.
  const ARCHIVE = 'fake gh archive\n';
  function install(sh: Shell, sha256: string, withGh = false): Ran {
    for (const tool of ['bash', 'sha256sum']) {
      const found = spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' });
      symlinkSync(found.stdout.trim(), path.join(sh.bin, tool));
    }
    sh.fake(
      'curl',
      `prev=; for a in "$@"; do [ "$prev" = -o ] && printf '${ARCHIVE}' > "$a"; prev=$a; done`,
    );
    sh.fake('tar');
    if (withGh) sh.fake('gh');
    const step = recordStep('Install GitHub CLI');
    return sh.run(step.run, {
      ...step.env,
      GH_SHA256: sha256,
      PATH: sh.bin,
      RUNNER_TEMP: sh.tmp,
      GITHUB_PATH: path.join(sh.tmp, 'path'),
    });
  }
  const gotPath = (sh: Shell) => {
    const file = path.join(sh.tmp, 'path');
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  };

  it('installs the pinned release when its checksum matches', () => {
    const sh = shell();
    const result = install(sh, createHash('sha256').update(ARCHIVE).digest('hex'));
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const version = recordStep('Install GitHub CLI').env.GH_VERSION;
    expect(sh.calls('curl')).toEqual([
      [
        '-fsSL',
        '--retry',
        '3',
        '-o',
        `${sh.tmp}/gh.tar.gz`,
        `https://github.com/cli/cli/releases/download/v${version}/gh_${version}_linux_amd64.tar.gz`,
      ],
    ]);
    expect(sh.calls('tar')).toEqual([['-xzf', `${sh.tmp}/gh.tar.gz`, '-C', sh.tmp]]);
    expect(gotPath(sh)).toBe(`${sh.tmp}/gh_${version}_linux_amd64/bin\n`);
  });

  it('installs nothing when the download does not match the pinned checksum', () => {
    const sh = shell();
    const result = install(sh, recordStep('Install GitHub CLI').env.GH_SHA256);
    expect(result.status).not.toBe(0);
    expect(sh.calls('curl')).toHaveLength(1);
    expect(sh.calls('tar')).toEqual([]);
    expect(gotPath(sh)).toBe('');
  });

  it('keeps a gh the runner already has', () => {
    const sh = shell();
    const result = install(sh, 'unused', true);
    expect(result.status, result.stderr).toBe(0);
    expect(sh.calls('curl')).toEqual([]);
    expect(sh.calls('tar')).toEqual([]);
    expect(gotPath(sh)).toBe('');
  });
});
