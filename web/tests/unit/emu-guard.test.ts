import { execFile } from 'node:child_process';
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
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}` };
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
