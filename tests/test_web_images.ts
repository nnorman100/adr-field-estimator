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
  steps,
  WEB,
  type Data,
} from './workflow_support.ts';

const SHA = 'a'.repeat(40);
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
  expect(web.on.pull_request.paths).toContain('live-relay-placeholder/**');
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
      `"${root}/web/scripts/build-image.sh" web --commit ${SHA} --output out.tar --stage "${stage}"`,
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
      const script = `"${root}/web/scripts/build-image.sh" web --commit "${commit}" --output out.tar`;
      expect(sh.run(script).status).not.toBe(0);
      expect(sh.calls('npm')).toEqual([]);
      expect(sh.calls('crane')).toEqual([]);
    },
  );

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
      const env = { ...release.env, COMMIT: SHA, STATE: state };
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
          '--tag',
          `${release.env.IMAGE}:${SHA}`,
        ]);
      }
      expect(sh.outputs()).toEqual({ ref: `${release.env.IMAGE}@sha256:${'b'.repeat(64)}` });
    },
  );

  it('refuses an unexpected image reference', () => {
    const sh = shell();
    sh.fake('crane', 'echo not-a-digest');
    const result = sh.run(step(release.jobs.build, 'image').run, { ...release.env, COMMIT: SHA });
    expect(result.status).not.toBe(0);
    expect(sh.outputs()).not.toHaveProperty('ref');
  });
});

describe('the Web app image job', () => {
  it('starts the image tree as test and smoke-checks it', async () => {
    const sh = shell();
    const app = path.join(sh.tmp, 'web-stage', 'app');
    mkdirSync(app, { recursive: true });
    sh.fake(
      'node',
      '[ "$1" = server.js ] && echo "$APP_ENV $APP_COMMIT $NODE_ENV $PORT" > started; exit 0',
    );
    const result = sh.run(commands(step(imageJob(), IMAGE_STEPS[0])), {
      GITHUB_SHA: SHA,
      RUNNER_TEMP: sh.tmp,
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
        '--env',
        'test',
      ],
    ]);
    const started = path.join(app, 'started');
    for (let i = 0; i < 50 && !existsSync(started); i++) await sleep(100);
    expect(readFileSync(started, 'utf8').trim().split(/\s+/)).toEqual([
      'test',
      SHA,
      'production',
      '8080',
    ]);
  }, 15_000); // room for the 5 s wait for the background server, as pytest has no time limit

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

  it('builds every image through the script and never calls docker', () => {
    for (const job of [imageJob(), release.jobs.build]) {
      for (const s of steps(job)) {
        expect(/(^|\s)docker\s/.test(commands(s)), s.name ?? s.id).toBe(false);
      }
    }
    expect(commands(step(imageJob(), 'Build the image without Docker'))).toContain(
      'scripts/build-image.sh web --commit "$GITHUB_SHA"',
    );
  });

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
