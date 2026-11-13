// Guards for the rebuilt app's images, assembled without a Docker daemon (owner decision
// 2026-11-10) by web/scripts/build-image.sh onto the base pinned in web/Dockerfile, the release's
// push by digest, the Web app CI image job and the Live relay placeholder. Run by vitest in the
// required node CI job. Ported from the image half of tests/test_web_release_workflow.py.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  commands,
  instructions,
  load,
  RELEASE,
  ROOT,
  Shell,
  step,
  type Ran,
  steps,
  WEB,
  type Data,
} from './workflow_support.ts';

const SHA = 'a'.repeat(40);
const VERSION = '2026.11.13-2';
const BASE_PIN = /^node:[\w.-]+@sha256:[0-9a-f]{64}$/;
const FAKE_BUILD = `if [ "$2" = --silent ] && [ "$3" = build:migrate ]; then
  mkdir -p "$5/migrations"; echo job > "$5/migrate.mjs"; echo sql > "$5/migrations/0001_foundation.sql"
  exit 0
fi
mkdir -p .next/standalone/node_modules .next/static/chunks
echo server > .next/standalone/server.js
echo chunk > .next/static/chunks/main.js`;
const CRANE_REGISTRY = `case $1 in
  digest) if [ -e "$STATE" ]; then echo sha256:${'b'.repeat(64)}; else exit 1; fi ;;
  config) if [ -e "$STATE" ]; then echo '{"config":{"Env":["APP_VERSION=${VERSION}"]}}'; else exit 1; fi ;;
esac`;
const IMAGE_STEPS = ['Run as on Cloud Run and smoke-check', 'Refuse to start without APP_ENV'];

const release: Data = load(RELEASE);

const shells: Shell[] = [];
afterEach(() => {
  for (const s of shells.splice(0)) rmSync(s.tmp, { recursive: true, force: true });
});
function shell(): Shell {
  const s = new Shell();
  shells.push(s);
  return s;
}

/** crane that logs its arguments and keeps a copy of the layer it was asked to append. */
function craneFake(sh: Shell): string {
  const keep = path.join(sh.tmp, 'appended.tar');
  sh.fake(
    'crane',
    `prev=; for a in "$@"; do [ "$prev" = --append ] && cp "$a" '${keep}'; prev=$a; done`,
  );
  return keep;
}

/** A copy of the files build-image.sh reads, so the real web/ build output is never touched. */
function repo(sh: Shell): string {
  const root = path.join(sh.tmp, 'repo');
  mkdirSync(path.join(root, 'web', 'scripts'), { recursive: true });
  mkdirSync(path.join(root, 'web', 'node_modules'));
  // The icons and the field worker (/sw.js) the standalone output leaves out of the image.
  mkdirSync(path.join(root, 'web', 'public'));
  writeFileSync(path.join(root, 'web', 'public', 'sw.js'), 'worker\n');
  mkdirSync(path.join(root, 'live-relay-placeholder'));
  for (const name of [
    'web/scripts/build-image.sh',
    'web/Dockerfile',
    'live-relay-placeholder/server.js',
  ]) {
    copyFileSync(path.join(ROOT, name), path.join(root, name));
  }
  chmodSync(path.join(root, 'web/scripts/build-image.sh'), 0o755);
  return root;
}

function layerMembers(layer: string): string[][] {
  const listing = spawnSync('tar', ['-tvf', layer], { encoding: 'utf8' });
  if (listing.status !== 0) throw new Error(`tar -tvf failed: ${listing.stderr}`);
  return listing.stdout
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => line.trim().split(/\s+/));
}

function imageJob(): Data {
  const web = load(WEB);
  // Pull requests run every job (tests/test_web_workflow.ts); master pushes filter on the path.
  expect(web.on.push.paths).toContain('live-relay-placeholder/**');
  return web.jobs.image;
}

const base = () => instructions(path.join(ROOT, 'web', 'Dockerfile'))[0].split(' ')[1];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('building images', () => {
  it('pins the base image once and builds nothing else with Docker', () => {
    const lines = instructions(path.join(ROOT, 'web', 'Dockerfile'));
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith('FROM ')).toBe(true);
    expect(lines[0].split(' ')[1]).toMatch(BASE_PIN);
    expect(existsSync(path.join(ROOT, 'live-relay-placeholder', 'Dockerfile'))).toBe(false);
    expect(existsSync(path.join(ROOT, 'web', '.dockerignore'))).toBe(false);
  });

  it('appends one root-owned app layer onto the pinned base for the web image', () => {
    const sh = shell();
    const root = repo(sh);
    const keep = craneFake(sh);
    sh.fake('npm', FAKE_BUILD);
    const stage = path.join(sh.tmp, 'stage');
    const result = sh.run(
      `"${root}/web/scripts/build-image.sh" web --commit ${SHA} --version ${VERSION} --output out.tar --stage "${stage}"`,
    );
    expect(result.status, result.stderr).toBe(0);
    // The Next.js build, then the migration job bundle into the same /app tree.
    expect(sh.calls('npm')).toEqual([
      ['run', 'build'],
      ['run', '--silent', 'build:migrate', '--', `${stage}/app`],
    ]);
    const calls = sh.calls('crane');
    expect(calls).toHaveLength(1);
    const [mutate] = calls;
    expect(mutate.slice(0, 4)).toEqual(['mutate', base(), '--platform', 'linux/amd64']);
    const pairs: Record<string, string> = {};
    for (let i = 4; i + 1 < mutate.length; i += 2) pairs[mutate[i]] = mutate[i + 1];
    expect(pairs['--user']).toBe('node');
    expect(pairs['--workdir']).toBe('/app');
    expect(pairs['--cmd']).toBe('node,server.js');
    expect(pairs['--output']).toBe('out.tar');
    const envs = mutate.flatMap((arg, i) => (arg === '--env' ? [mutate[i + 1]] : []));
    expect(envs).toContain(`APP_COMMIT=${SHA}`);
    expect(envs).toContain(`APP_VERSION=${VERSION}`);
    expect(envs).toContain('PORT=8080');
    expect(envs).toContain('NODE_ENV=production');
    expect(envs.filter((e) => e.startsWith('APP_ENV='))).toEqual([]);
    const members = layerMembers(keep);
    const names = members.map((m) => m.at(-1));
    for (const name of [
      'app/server.js',
      'app/.next/static/chunks/main.js',
      'app/public/sw.js',
      'app/migrate.mjs',
      'app/migrations/0001_foundation.sql',
    ]) {
      expect(names).toContain(name);
    }
    for (const [mode, owner] of members) {
      expect(owner, mode).toBe('0/0');
      expect(mode.slice(4).includes('w'), `${mode} ${owner}`).toBe(false);
    }
    expect(readFileSync(path.join(stage, 'app', 'server.js'), 'utf8')).toBe('server\n');
  });

  it.each(['', 'main', SHA.slice(0, 7), SHA.toUpperCase(), SHA + 'a'])(
    'refuses to build the web image without a full commit (%j)',
    (commit) => {
      const sh = shell();
      const root = repo(sh);
      craneFake(sh);
      sh.fake('npm', FAKE_BUILD);
      const script = `"${root}/web/scripts/build-image.sh" web --commit "${commit}" --version ${VERSION} --output out.tar`;
      expect(sh.run(script).status).not.toBe(0);
      expect(sh.calls('npm')).toEqual([]);
      expect(sh.calls('crane')).toEqual([]);
    },
  );

  it.each(['', '2026.11.13', '2026.11.13-0', '2026.11.13-01', 'v2026.11.13-1', '2026.11.13-1;x'])(
    'refuses to build the web image without a release version (%j)',
    (version) => {
      const sh = shell();
      const root = repo(sh);
      craneFake(sh);
      sh.fake('npm', FAKE_BUILD);
      const script = `"${root}/web/scripts/build-image.sh" web --commit ${SHA} --version "${version}" --output out.tar`;
      expect(sh.run(script).status).not.toBe(0);
      expect(sh.calls('npm')).toEqual([]);
      expect(sh.calls('crane')).toEqual([]);
    },
  );

  it('refuses a release version on the placeholder', () => {
    const sh = shell();
    const root = repo(sh);
    craneFake(sh);
    const script = `"${root}/web/scripts/build-image.sh" live-placeholder --version ${VERSION} --output out.tar`;
    expect(sh.run(script).status).not.toBe(0);
    expect(sh.calls('crane')).toEqual([]);
  });

  it('refuses an unpinned base', () => {
    const sh = shell();
    const root = repo(sh);
    craneFake(sh);
    writeFileSync(path.join(root, 'web', 'Dockerfile'), 'FROM node:24-bookworm-slim\n');
    const script = `"${root}/web/scripts/build-image.sh" live-placeholder --output out.tar`;
    expect(sh.run(script).status).not.toBe(0);
    expect(sh.calls('crane')).toEqual([]);
  });

  it('puts only the placeholder, and no commit, in the placeholder image', () => {
    const sh = shell();
    const root = repo(sh);
    const keep = craneFake(sh);
    const result = sh.run(
      `"${root}/web/scripts/build-image.sh" live-placeholder --tag example/live:1`,
    );
    expect(result.status, result.stderr).toBe(0);
    const calls = sh.calls('crane');
    expect(calls).toHaveLength(1);
    const [mutate] = calls;
    expect(mutate.slice(-2)).toEqual(['--tag', 'example/live:1']);
    expect(mutate.filter((arg) => arg.startsWith('APP_COMMIT='))).toEqual([]);
    expect(
      layerMembers(keep)
        .map((m) => m.at(-1))
        .sort(),
    ).toEqual(['app/', 'app/server.js']);
  });

  // Stricter than the Python original: besides a corrupt file, the fake download is also a real
  // archive holding a crane binary, so only the checksum check can stop it being installed.
  it.each(['corrupt', 'archive'])(
    'never unpacks a crane download that fails its checksum (%s)',
    (kind) => {
      const sh = shell();
      const archive = path.join(sh.tmp, 'fake.tar.gz');
      mkdirSync(path.join(sh.tmp, 'fake'));
      writeFileSync(path.join(sh.tmp, 'fake', 'crane'), '#!/bin/sh\n');
      const packed = spawnSync('tar', ['-czf', archive, '-C', path.join(sh.tmp, 'fake'), 'crane']);
      expect(packed.status).toBe(0);
      const write = kind === 'corrupt' ? 'echo tampered > "$out"' : `cp '${archive}' "$out"`;
      sh.fake('curl', `while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done\n${write}`);
      const target = path.join(sh.tmp, 'tools');
      const result = sh.run(`"${ROOT}/web/scripts/install-crane.sh" "${target}"`);
      expect(result.status).not.toBe(0);
      expect(existsSync(path.join(target, 'crane'))).toBe(false);
      const calls = sh.calls('curl');
      expect(calls).toHaveLength(1);
      expect(calls[0].at(-1)).toMatch(
        /^https:\/\/github\.com\/google\/go-containerregistry\/releases\/download\/v\d+\.\d+\.\d+\/go-containerregistry_\w+\.tar\.gz$/,
      );
    },
  );
});

describe('the release image', () => {
  it.each([true, false])(
    'is pushed once per commit and handed on by digest (already pushed: %s)',
    (pushed) => {
      const sh = shell();
      const image = step(release.jobs.build, 'image');
      const state = path.join(sh.tmp, 'pushed');
      if (pushed) writeFileSync(state, '');
      sh.fake('crane', CRANE_REGISTRY);
      const scripts = path.join(sh.tmp, 'web', 'scripts');
      mkdirSync(scripts, { recursive: true });
      const build = path.join(scripts, 'build-image.sh');
      writeFileSync(build, `#!/bin/bash\necho "$@" >> "${sh.tmp}/built"\ntouch "${state}"\n`);
      chmodSync(build, 0o755);
      const env = { ...release.env, COMMIT: SHA, STATE: state, VERSION };
      const result = sh.run(image.run, env, sh.tmp);
      expect(result.status, result.stderr).toBe(0);
      const built = path.join(sh.tmp, 'built');
      if (pushed) {
        expect(existsSync(built)).toBe(false);
      } else {
        expect(readFileSync(built, 'utf8').trim().split(/\s+/)).toEqual([
          'web',
          '--commit',
          SHA,
          '--version',
          VERSION,
          '--tag',
          `${release.env.IMAGE}:${SHA}`,
        ]);
      }
      expect(sh.outputs()).toEqual({ ref: `${release.env.IMAGE}@sha256:${'b'.repeat(64)}` });
    },
  );

  // The version step with the real numbering script (web/scripts/release-version.ts) and fake
  // git, crane and date: the old app's tags count, and a rerun keeps the image's own version.
  const OLD_TAGS = [
    '2026.11.04-1',
    '2026.11.04-9',
    '2026.11.04-10',
    '2026.11.05-4',
    'infra-test-app-2026.11.04-3',
  ];
  function versionStep(sh: Shell, crane: string, today = '2026.11.04', tagged = 'exit 1'): Ran {
    sh.fake('crane', crane);
    sh.fake(
      'git',
      `[ "$1" = rev-parse ] && { ${tagged}; exit $?; }; [ "$1 $2" = 'tag --list' ] || exit 9; printf '%s\\n' ${OLD_TAGS.join(' ')}`,
    );
    sh.fake('date', `[ "$1 $2" = '-u +%Y.%m.%d' ] || exit 9; echo ${today}`);
    return sh.run(step(release.jobs.build, 'version').run, { ...release.env, COMMIT: SHA }, ROOT);
  }

  it.each([
    ['2026.11.04', '2026.11.04-11'],
    ['2026.11.05', '2026.11.05-5'],
    ['2026.11.13', '2026.11.13-1'],
  ])('numbers a new commit after every tag of the day, old app included (%s)', (today, version) => {
    const sh = shell();
    const result = versionStep(sh, 'exit 1', today);
    expect(result.status, result.stderr).toBe(0);
    expect(sh.outputs()).toEqual({ version });
    expect(sh.calls('crane')).toEqual([['config', `${release.env.IMAGE}:${SHA}`]]);
    expect(sh.calls('git')).toEqual([['tag', '--list']]);
  });

  const REUSED = `echo '{"config":{"Env":["PATH=/bin","APP_VERSION=2026.11.03-2"]}}'`;
  const TAG_LOOKUP = ['rev-parse', '-q', '--verify', 'refs/tags/2026.11.03-2^{commit}'];

  it.each([
    ['not tagged yet', 'exit 1'],
    ['tagged at this commit', `echo ${SHA}`],
  ])('keeps the version baked into the image a rerun reuses (%s)', (_label, tagged) => {
    const sh = shell();
    const result = versionStep(sh, REUSED, '2026.11.04', tagged);
    expect(result.status, result.stderr).toBe(0);
    expect(sh.outputs()).toEqual({ version: '2026.11.03-2' });
    expect(sh.calls('git')).toEqual([TAG_LOOKUP]);
  });

  it('stops a rerun whose version another commit has since been tagged with', () => {
    const sh = shell();
    const result = versionStep(sh, REUSED, '2026.11.04', `echo ${'d'.repeat(40)}`);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(`already belongs to ${'d'.repeat(40)}`);
    expect(sh.outputs()).toEqual({});
    expect(sh.calls('git')).toEqual([TAG_LOOKUP]);
  });

  it.each([
    `echo '{"config":{"Env":["PATH=/bin"]}}'`,
    `echo '{"config":{"Env":["APP_VERSION=1"]}}'`,
  ])('stops when the image a rerun would reuse has no release version: %s', (crane) => {
    const sh = shell();
    const result = versionStep(sh, crane);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('carries no release version');
    expect(sh.outputs()).toEqual({});
  });

  it('stops when the tags cannot be read', () => {
    const sh = shell();
    sh.fake('crane', 'exit 1');
    sh.fake('git', 'exit 128');
    const result = sh.run(
      step(release.jobs.build, 'version').run,
      { ...release.env, COMMIT: SHA },
      ROOT,
    );
    expect(result.status).not.toBe(0);
    expect(sh.outputs()).toEqual({});
  });

  it('numbers from the tags of the commit it checks out', () => {
    const checkout = steps(release.jobs.build).find((s: Data) =>
      String(s.uses ?? '').startsWith('actions/checkout@'),
    );
    expect(checkout.with['fetch-tags']).toBe(true);
    const order = steps(release.jobs.build).map((s: Data) => s.id ?? s.name ?? s.uses);
    expect(order.indexOf('version')).toBeLessThan(order.indexOf('image'));
    expect(step(release.jobs.build, 'image').env).toEqual({
      VERSION: '${{ steps.version.outputs.version }}',
    });
    expect(release.jobs.build.outputs.version).toBe('${{ steps.version.outputs.version }}');
  });

  it('refuses an unexpected image reference', () => {
    const sh = shell();
    sh.fake('crane', 'echo not-a-digest');
    const result = sh.run(step(release.jobs.build, 'image').run, { ...release.env, COMMIT: SHA });
    expect(result.status).not.toBe(0);
    expect(sh.outputs()).not.toHaveProperty('ref');
  });
});

// What the image's server prints to its log at start (src/lib/telemetry/start.ts) with tracing on and
// no exporter: the one line the step looks for.
const TRACING_STARTED =
  '{"severity":"INFO","message":"tracing started","component":"tracing","event":"started","code":"spans"}';
// scripts/smoke-release.ts waits for the server to answer; the fake waits for its first log line.
const WAIT_FOR_SERVER_LOG =
  '[ "$1" != server.js ] && for _ in $(seq 50); do [ -s "$RUNNER_TEMP/web.log" ] && break; sleep 0.1; done';
const SERVER_THAT_STARTS_TRACING = `if [ "$1" = server.js ]; then echo "$APP_ENV $APP_COMMIT $APP_VERSION $NODE_ENV $PORT" > started; echo '${TRACING_STARTED}'; fi; ${WAIT_FOR_SERVER_LOG}; exit 0`;

const TRACING_FAILURES = [
  ['says nothing about tracing', 'listening on 8080', 'Tracing did not start'],
  [
    'reports tracing unavailable',
    `${TRACING_STARTED}\\ntracing unavailable`,
    'Tracing failed to start',
  ],
  [
    'starts tracing with an exporter',
    TRACING_STARTED.replace('"spans"', '"export"'),
    'Tracing did not start',
  ],
];

const BUILD_CASES = [
  [
    'the Web app image job',
    imageJob,
    'scripts',
    (tmp: string) => [
      ['web', '--output', `${tmp}/nocommit.tar`],
      [
        'web',
        '--commit',
        SHA,
        '--version',
        imageJob().env.CHECK_VERSION,
        '--output',
        `${tmp}/web-image.tar`,
        '--stage',
        `${tmp}/web-stage`,
      ],
      ['live-placeholder', '--output', `${tmp}/live-image.tar`, '--stage', `${tmp}/live-stage`],
    ],
  ],
  [
    'the release build job',
    () => release.jobs.build,
    'web/scripts',
    () => [
      ['web', '--commit', SHA, '--version', VERSION, '--tag', `${release.env.IMAGE}:${SHA}`],
      ['live-placeholder', '--tag', `${release.env.PLACEHOLDER_IMAGE}:${SHA}`],
    ],
  ],
];

describe('the Web app image job', () => {
  it('starts the image tree as test and smoke-checks it', async () => {
    const sh = shell();
    const app = path.join(sh.tmp, 'web-stage', 'app');
    mkdirSync(app, { recursive: true });
    sh.fake('node', SERVER_THAT_STARTS_TRACING);
    const check = imageJob().env.CHECK_VERSION;
    expect(check).toMatch(/^\d{4}\.\d{2}\.\d{2}-[1-9]\d*$/);
    const result = sh.run(commands(step(imageJob(), IMAGE_STEPS[0])), {
      GITHUB_SHA: SHA,
      RUNNER_TEMP: sh.tmp,
      CHECK_VERSION: check,
    });
    expect(result.status, result.stderr).toBe(0);
    const smoke = sh.calls('node').filter((args) => args[0] !== 'server.js');
    expect(smoke).toEqual([
      [
        'scripts/smoke-release.ts',
        '--url',
        'http://127.0.0.1:8080',
        '--commit',
        SHA,
        '--version',
        check,
        '--env',
        'test',
      ],
    ]);
    const started = path.join(app, 'started');
    for (let i = 0; i < 50 && !existsSync(started); i++) await sleep(100);
    expect(readFileSync(started, 'utf8').trim().split(/\s+/)).toEqual([
      'test',
      SHA,
      check,
      'production',
      '8080',
    ]);
  }, 15_000); // room for the 5 s wait for the background server, as pytest has no time limit

  it.each(TRACING_FAILURES)('fails when the server %s', (_name, line, error) => {
    const sh = shell();
    mkdirSync(path.join(sh.tmp, 'web-stage', 'app'), { recursive: true });
    sh.fake(
      'node',
      `[ "$1" = server.js ] && printf '%b\\n' '${line}'; ${WAIT_FOR_SERVER_LOG}; exit 0`,
    );
    const result = sh.run(commands(step(imageJob(), IMAGE_STEPS[0])), {
      GITHUB_SHA: SHA,
      RUNNER_TEMP: sh.tmp,
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(error);
  });

  it('fails and shows the server log when the smoke check fails', () => {
    const sh = shell();
    mkdirSync(path.join(sh.tmp, 'web-stage', 'app'), { recursive: true });
    writeFileSync(path.join(sh.tmp, 'web.log'), 'server said no\n');
    sh.fake('node', '[ "$1" = server.js ] && exit 0; exit 1');
    const original = commands(step(imageJob(), IMAGE_STEPS[0]));
    const script = original.replaceAll(' > "$RUNNER_TEMP/web.log"', ' > /dev/null');
    expect(script).not.toBe(original);
    const result = sh.run(script, { GITHUB_SHA: SHA, RUNNER_TEMP: sh.tmp });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('server said no');
  });

  it.each([
    [1, true],
    [0, false],
    [124, false],
  ])(
    'requires the server to refuse to start without APP_ENV (exit %i passes: %s)',
    (code, passes) => {
      const sh = shell();
      mkdirSync(path.join(sh.tmp, 'web-stage', 'app'), { recursive: true });
      sh.fake('node', `exit ${code}`);
      const result = sh.run(commands(step(imageJob(), IMAGE_STEPS[1])), { RUNNER_TEMP: sh.tmp });
      expect(result.status === 0).toBe(passes);
    },
  );

  it.each(BUILD_CASES)(
    'builds every image in %s through the script and never calls docker',
    (_name, job, scripts, built) => {
      const sh = shell();
      const state = path.join(sh.tmp, 'pushed');
      sh.fake('docker');
      sh.fake('npm');
      sh.fake('gcloud');
      sh.fake('tar');
      sh.fake('git', 'echo 2026.11.13-1');
      sh.fake('install-crane');
      sh.fake('crane', CRANE_REGISTRY);
      sh.fake(
        'node',
        `case $1 in
  server.js) [ -n "$APP_ENV" ] || exit 1; echo '${TRACING_STARTED}' ;;
  scripts/smoke-release.ts) for _ in $(seq 50); do [ -s "$RUNNER_TEMP/web.log" ] && break; sleep 0.1; done ;;
  web/scripts/release-version.ts) cat > /dev/null; echo ${VERSION} ;;
esac`,
      );
      sh.fake(
        'build-image',
        `[ "$1" = web ] && [ "$2" != --commit ] && exit 1
prev=; for a in "$@"; do
  case $prev in --output) : > "$a" ;; --stage) mkdir -p "$a/app" ;; --tag) touch "$STATE" ;; esac
  prev=$a
done`,
      );
      const dir = path.join(sh.tmp, scripts);
      mkdirSync(dir, { recursive: true });
      for (const [file, fake] of [
        ['build-image.sh', 'build-image'],
        ['install-crane.sh', 'install-crane'],
      ]) {
        writeFileSync(path.join(dir, file), `#!/bin/bash\nexec ${fake} "$@"\n`);
        chmodSync(path.join(dir, file), 0o755);
      }
      const env = {
        ...release.env,
        ...job().env,
        VERSION,
        COMMIT: SHA,
        GITHUB_SHA: SHA,
        GITHUB_PATH: path.join(sh.tmp, 'path'),
        RUNNER_TEMP: sh.tmp,
        STATE: state,
      };
      for (const s of steps(job()).filter((s) => s.run)) {
        rmSync(state, { force: true });
        const result = sh.run(commands(s), env);
        expect(result.status, `${s.name ?? s.id}: ${result.stdout}${result.stderr}`).toBe(0);
      }
      expect(sh.calls('build-image')).toEqual(built(sh.tmp));
      expect(sh.calls('docker')).toEqual([]);
    },
    15_000,
  );

  it('has Dependabot keep the pinned base image current', () => {
    const docker = new Set<string>();
    for (const update of load(path.join(ROOT, '.github', 'dependabot.yml')).updates) {
      if (update['package-ecosystem'] === 'docker') {
        const dirs = update.directories?.length ? update.directories : [update.directory];
        for (const dir of dirs) docker.add(dir);
      }
    }
    expect(docker.has('/web')).toBe(true);
  });
});
