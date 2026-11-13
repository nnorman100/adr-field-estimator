// The release record's shell (docs/plans/TC.md, TC-8): the failed-release line, the version tag,
// the GitHub Release, the manifest step and the pinned gh install of the record job in
// .github/workflows/web-release.yml, run with fake commands. The job's structure (what it needs, who
// can write, when the tag and the failure line happen) is checked in tests/test_web_release_workflow.ts.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FIRST_RELEASE } from '../web/scripts/release-version.ts';
import { load, type Ran, RELEASE, ROOT, Shell, steps, type Data } from './workflow_support.ts';

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

  const ROLLBACK =
    'gcloud run services update-traffic dryscope-api-test --to-revisions=dryscope-api-test-00011-xyz=100 --region=us-central1 --project=dryscope';
  const COMPLETE = {
    isDraft: false,
    isPrerelease: true,
    assets: [{ name: 'manifest.json' }],
    body: `Roll back:\n\n\`\`\`sh\n${ROLLBACK}\n\`\`\`\n`,
  };
  const CREATE = (tmp: string) => [
    'release',
    'create',
    '2026.11.13-2',
    `${tmp}/manifest.json`,
    '--verify-tag',
    '--prerelease',
    '--title',
    '2026.11.13-2 (test)',
    '--notes-file',
    `${tmp}/notes.md`,
  ];
  const FINISH = (tmp: string) => [
    ['release', 'upload', '2026.11.13-2', `${tmp}/manifest.json`, '--clobber'],
    [
      'release',
      'edit',
      '2026.11.13-2',
      '--draft=false',
      '--prerelease',
      '--verify-tag',
      '--title',
      '2026.11.13-2 (test)',
      '--notes-file',
      `${tmp}/notes.md`,
    ],
  ];

  // Whether this version's Release is already complete, with fake gh and the real
  // release-version.ts: its notes must carry the rollback note of the manifest attached to it.
  const FIRST_COMPLETE = { ...COMPLETE, body: `Test release.\n\n${FIRST_RELEASE}\n` };
  const ATTACHED = JSON.stringify({ rollback: { command: ROLLBACK } });
  const ATTACHED_FIRST = JSON.stringify({ rollback: null });
  it.each<[string, object | null, string, 'missing' | 'complete' | 'incomplete']>([
    ['no Release yet', null, '', 'missing'],
    ['a complete Release (a rerun)', COMPLETE, ATTACHED, 'complete'],
    ['a complete first release (a rerun)', FIRST_COMPLETE, ATTACHED_FIRST, 'complete'],
    [
      'a draft left by an interrupted create',
      { ...COMPLETE, isDraft: true },
      ATTACHED,
      'incomplete',
    ],
    [
      'a full release, not a pre-release',
      { ...COMPLETE, isPrerelease: false },
      ATTACHED,
      'incomplete',
    ],
    ['a Release without manifest.json', { ...COMPLETE, assets: [] }, '', 'incomplete'],
    ['a Release without the rollback notes', { ...COMPLETE, body: '' }, ATTACHED, 'incomplete'],
    [
      'a Release with another rollback command',
      { ...COMPLETE, body: ROLLBACK.replace('00011-xyz', '00010-pqr') },
      ATTACHED,
      'incomplete',
    ],
    ['a first release without its note', COMPLETE, ATTACHED_FIRST, 'incomplete'],
  ])('tells whether the Release is complete: %s', (_label, existing, attached, state) => {
    const sh = shell();
    sh.fake(
      'gh',
      `case "$1 $2" in
  'release view') [ -n "$VIEW" ] || exit 1; printf '%s' "$VIEW" ;;
  'release download') [ -n "$ATTACHED" ] || exit 1; printf '%s' "$ATTACHED" > "$7/manifest.json" ;;
  *) exit 9 ;;
esac`,
    );
    const view = existing ? JSON.stringify(existing) : '';
    const result = sh.run(
      recordStep('existing').run,
      { ...tagEnv, RUNNER_TEMP: sh.tmp, VIEW: view, ATTACHED: attached },
      ROOT,
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(sh.outputs()).toEqual({ state });
    const calls = sh.calls('gh');
    expect(calls[0]).toEqual([
      'release',
      'view',
      '2026.11.13-2',
      '--json',
      'isDraft,isPrerelease,assets,body',
    ]);
    expect(calls.slice(1)).toEqual(
      existing
        ? [
            [
              'release',
              'download',
              '2026.11.13-2',
              '--pattern',
              'manifest.json',
              '--dir',
              `${sh.tmp}/existing`,
              '--clobber',
            ],
          ]
        : [],
    );
  });

  it.each<['missing' | 'complete' | 'incomplete', 'create' | 'keep' | 'finish']>([
    ['missing', 'create'],
    ['complete', 'keep'],
    ['incomplete', 'finish'],
  ])('publishes one complete pre-release with the manifest: %s Release', (state, action) => {
    const sh = shell();
    sh.fake('gh');
    const result = sh.run(
      recordStep('release').run,
      { ...tagEnv, RUNNER_TEMP: sh.tmp, EXISTING: state },
      ROOT,
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(sh.calls('gh')).toEqual(
      { create: [CREATE(sh.tmp)], keep: [], finish: FINISH(sh.tmp) }[action],
    );
    expect(recordStep('release').env.EXISTING).toBe('${{ steps.existing.outputs.state }}');
  });

  // The rollback target on a rerun that found this release's image already serving, with fake gh
  // and the real release-version.ts.
  const earlierEnv = (sh: Shell) => ({ ...tagEnv, RUNNER_TEMP: sh.tmp });
  const published = (tag: string) => ({
    tag_name: tag,
    draft: false,
    prerelease: true,
    assets: [{ name: 'manifest.json' }],
  });
  // The old app's releases are full releases, not pre-releases: never a DryScope test release.
  const OLD_APP_RELEASE = {
    tag_name: '2026.11.04-10',
    draft: false,
    prerelease: false,
    assets: [],
  };
  function earlier(sh: Shell, releases: object[], download = 'echo \'{}\' > "$7/manifest.json"') {
    sh.fake(
      'gh',
      `case "$1 $2" in
  'api repos/owner/repo/releases?per_page=100') echo '${JSON.stringify(releases)}' ;;
  'release download') ${download} ;;
  *) exit 9 ;;
esac`,
    );
    return sh.run(recordStep('earlier').run, earlierEnv(sh), ROOT);
  }
  const downloadEarlier = (sh: Shell, tag: string) => [
    'release',
    'download',
    tag,
    '--pattern',
    'manifest.json',
    '--dir',
    `${sh.tmp}/earlier`,
    '--clobber',
  ];

  it('downloads the previous published release manifest for the rollback target', () => {
    const sh = shell();
    const releases = [
      published('2026.11.13-2'),
      published('2026.11.12-4'),
      published('2026.11.10-1'),
      OLD_APP_RELEASE,
    ];
    const result = earlier(sh, releases);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(sh.calls('gh')).toEqual([
      ['api', 'repos/owner/repo/releases?per_page=100'],
      downloadEarlier(sh, '2026.11.12-4'),
    ]);
    expect(sh.outputs()).toEqual({ manifest: `${sh.tmp}/earlier/manifest.json` });
    expect(existsSync(`${sh.tmp}/earlier/manifest.json`)).toBe(true);
  });

  it.each([
    ['no release at all', []],
    ['only this release and the old app', [published('2026.11.13-2'), OLD_APP_RELEASE]],
  ])(
    'records the first release, with no rollback target, when there is no earlier one: %s',
    (_label, releases) => {
      const sh = shell();
      const result = earlier(sh, releases);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(sh.outputs()).toEqual({ first: 'true' });
      expect(sh.calls('gh').filter((args) => args[0] === 'release')).toEqual([]);
      expect(readFileSync(sh.summary, 'utf8')).toContain('first recorded release');
    },
  );

  it('stops the record when the earlier published release has no manifest.json', () => {
    const sh = shell();
    const result = earlier(sh, [published('2026.11.12-4')], 'exit 1');
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('2026.11.12-4 has no manifest.json');
    expect(result.stdout).toContain('Nothing was tagged or published');
    expect(sh.calls('gh').filter((args) => args[0] === 'release')).toEqual([
      downloadEarlier(sh, '2026.11.12-4'),
    ]);
    expect(sh.outputs()).toEqual({});
  });

  it('stops the record when the releases list cannot be read', () => {
    const sh = shell();
    sh.fake('gh', 'exit 1');
    const result = sh.run(recordStep('earlier').run, earlierEnv(sh), ROOT);
    expect(result.status).not.toBe(0);
    expect(sh.outputs()).toEqual({});
  });

  it('looks for an earlier release only when deploy found this release serving and no complete Release exists', () => {
    expect(recordStep('earlier').if).toBe(
      `${SUCCESS} && needs.deploy.outputs.serving == 'true' && steps.existing.outputs.state != 'complete'`,
    );
  });

  it.each([
    ['', ''],
    ['/tmp/earlier/manifest.json', ''],
    ['', 'true'],
  ])(
    'builds the manifest from the released commit and its infra-test tags (earlier manifest: %j, first release: %j)',
    (earlier, first) => {
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
        EARLIER: earlier,
        FIRST: first,
        EXISTING: 'missing',
      };
      const result = sh.run(recordStep('manifest').run, env);
      expect(result.status, result.stderr).toBe(0);
      expect(sh.calls('git')).toEqual([['tag', '--list', 'infra-test-*']]);
      expect(readFileSync(path.join(sh.tmp, 'stdin'), 'utf8')).toBe(
        'infra-test-data-2026.11.10-1\n',
      );
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
          ...(earlier ? ['--previous-release', earlier] : []),
          ...(first ? ['--first-release'] : []),
        ],
      ]);
      expect(recordStep('manifest')['working-directory']).toBe('web');
      expect(readFileSync(sh.summary, 'utf8')).toBe('notes\n');
    },
  );

  it('keeps the manifest of a complete Release instead of writing another', () => {
    const sh = shell();
    sh.fake('git');
    sh.fake('npx');
    const result = sh.run(recordStep('manifest').run, {
      ...release.env,
      VERSION: '2026.11.13-2',
      RUNNER_TEMP: sh.tmp,
      EXISTING: 'complete',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(sh.calls()).toEqual([]);
    expect(existsSync(path.join(sh.tmp, 'manifest.json'))).toBe(false);
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
