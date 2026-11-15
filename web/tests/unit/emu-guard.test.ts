import { spawn, execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requireDemoProject, requireEmulatorEnv } from '../emu/guard';

const exec = promisify(execFile);
const webDir = fileURLToPath(new URL('../..', import.meta.url));

describe('emulator project guard', () => {
  it('refuses any project id that does not start with demo-', () => {
    for (const projectId of [
      undefined,
      '',
      'dryscope',
      'alert-disaster-field-2026',
      'Demo-dryscope',
      'xdemo-dryscope',
      'demo-',
      'demo-dryscope-',
      'demo-UPPER',
      'demo-dryscope/../real-project',
      'demo-a-name-that-is-far-too-long-for-gcp',
    ]) {
      expect(() => requireDemoProject(projectId)).toThrow(/must start with "demo-"/);
    }
  });

  it('accepts a demo- project id', () => {
    expect(requireDemoProject('demo-dryscope')).toBe('demo-dryscope');
    expect(requireDemoProject('demo-a')).toBe('demo-a');
  });

  it('refuses a test run whose emulators are not on loopback under a demo- project', () => {
    const good = {
      GCLOUD_PROJECT: 'demo-dryscope',
      FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9399',
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8399',
    };
    expect(requireEmulatorEnv(good)).toEqual({
      projectId: 'demo-dryscope',
      authHost: '127.0.0.1:9399',
      firestoreHost: '127.0.0.1:8399',
    });
    expect(() => requireEmulatorEnv({ ...good, GCLOUD_PROJECT: 'dryscope' })).toThrow(/demo-/);
    expect(() => requireEmulatorEnv({ ...good, FIREBASE_AUTH_EMULATOR_HOST: undefined })).toThrow(/not set/);
    expect(() => requireEmulatorEnv({ ...good, FIRESTORE_EMULATOR_HOST: 'firestore.example:8080' })).toThrow(
      /loopback/,
    );
  });
});

// The runner is started with a stand-in `npx` first on PATH that only records its arguments,
// so these tests prove what would reach the Firebase CLI without starting it.
describe('npm run test:emu runner', () => {
  let fakeBin: string;
  let record: string;

  beforeEach(async () => {
    fakeBin = await mkdtemp(join(tmpdir(), 'dryscope-emu-runner-'));
    record = join(fakeBin, 'npx-args');
    const npx = join(fakeBin, 'npx');
    await writeFile(npx, `#!/bin/sh\nprintf '%s\\n' "$@" > '${record}'\n`);
    await chmod(npx, 0o755);
  });

  afterEach(async () => {
    await rm(fakeBin, { recursive: true, force: true });
  });

  function runRunner(projectId: string | undefined) {
    // A private host lock: another test:emu run holding the real one must not make these wait.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
      DRYSCOPE_EMU_LOCK: join(fakeBin, 'host.lock'),
    };
    if (projectId === undefined) delete env.DRYSCOPE_EMU_PROJECT;
    else env.DRYSCOPE_EMU_PROJECT = projectId;
    return exec(process.execPath, ['--import', 'tsx', 'tests/emu/run.ts'], { cwd: webDir, env });
  }

  it('refuses a non-demo project id without starting the Firebase CLI', async () => {
    for (const projectId of ['dryscope', 'alert-disaster-field-2026']) {
      const failure = await runRunner(projectId).then(
        () => null,
        (error: { code?: number; stderr?: string }) => error,
      );
      expect(failure?.code).toBe(2);
      expect(failure?.stderr).toMatch(/must start with "demo-"/);
      await expect(readFile(record, 'utf8')).rejects.toThrow(/ENOENT/);
    }
  });

  it('starts only the Auth and Firestore emulators under the demo- project', async () => {
    await runRunner(undefined);
    const args = (await readFile(record, 'utf8')).trim().split('\n');
    expect(args).toEqual([
      '--yes',
      'firebase-tools@15.31.0',
      'emulators:exec',
      '--only',
      'auth,firestore',
      '--project',
      'demo-dryscope',
      '--config',
      'firebase.json',
      'npx vitest run --config vitest.emu.config.ts',
    ]);
  });
});

// The Firebase CLI starts the emulators as detached processes (their own process group) that can
// outlive it. The stand-in `npx` here starts one the same way, then ends the way a run can end; the
// runner must leave nothing of it running.
describe('npm run test:emu cleanup', () => {
  let dir: string;
  let pidFile: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dryscope-emu-cleanup-'));
    pidFile = join(dir, 'emulator.pid');
    const npx = join(dir, 'npx');
    await writeFile(
      npx,
      [
        `#!${process.execPath}`,
        "const { spawn } = require('node:child_process');",
        "const { DRYSCOPE_EMU_RUN, ...unmarked } = process.env;",
        "const emulator = spawn('sleep', ['300'], {",
        '  detached: true,',
        "  stdio: 'ignore',",
        '  env: process.env.FAKE_UNMARKED ? unmarked : process.env,',
        '});',
        'emulator.unref();',
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(emulator.pid));`,
        "if (process.env.FAKE_END === 'fail') process.exit(3);",
        "if (process.env.FAKE_END === 'late-fail') setTimeout(() => process.exit(3), 1500);",
        'setInterval(() => {}, 1000);',
        '',
      ].join('\n'),
    );
    await chmod(npx, 0o755);
  });

  afterEach(async () => {
    try {
      process.kill(Number(await readFile(pidFile, 'utf8')), 'SIGKILL');
    } catch {
      // already stopped, which is the point
    }
    await rm(dir, { recursive: true, force: true });
  });

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  function start(end: 'fail' | 'late-fail' | 'hang', unmarked = false) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${dir}${delimiter}${process.env.PATH ?? ''}`,
      DRYSCOPE_EMU_LOCK: join(dir, 'host.lock'),
      FAKE_END: end,
    };
    if (unmarked) env.FAKE_UNMARKED = '1';
    return spawn(process.execPath, ['--import', 'tsx', 'tests/emu/run.ts'], { cwd: webDir, env, stdio: 'ignore' });
  }
  const exited = (child: ReturnType<typeof start>) =>
    new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  async function waitFor(condition: () => boolean | Promise<boolean>) {
    for (let i = 0; i < 100; i += 1) {
      if (await condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('timed out waiting');
  }

  it('stops what the CLI started when the tests fail', async () => {
    const child = start('fail');
    expect(await exited(child)).toBe(3);
    const pid = Number(await readFile(pidFile, 'utf8'));
    await waitFor(() => !alive(pid));
  });

  it('stops what the CLI started when the run is interrupted', async () => {
    const child = start('hang');
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '');
    const pid = Number(await readFile(pidFile, 'utf8'));
    expect(alive(pid)).toBe(true);
    const done = exited(child);
    child.kill('SIGTERM');
    await done;
    await waitFor(() => !alive(pid));
  }, 30_000);

  // An emulator that does not carry the run marker, in a session of its own, is found only as a
  // descendant of the CLI seen while the CLI ran.
  it('stops an unmarked emulator in its own session when the CLI exits', async () => {
    const child = start('late-fail', true);
    expect(await exited(child)).toBe(3);
    const pid = Number(await readFile(pidFile, 'utf8'));
    await waitFor(() => !alive(pid));
  }, 30_000);

  it('stops an unmarked emulator in its own session when the run is interrupted', async () => {
    const child = start('hang', true);
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '');
    const pid = Number(await readFile(pidFile, 'utf8'));
    expect(alive(pid)).toBe(true);
    const done = exited(child);
    child.kill('SIGTERM');
    await done;
    await waitFor(() => !alive(pid));
  }, 30_000);
});
