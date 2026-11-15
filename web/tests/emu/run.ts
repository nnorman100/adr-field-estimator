// `npm run test:emu`: starts the Firebase Auth and Firestore emulators, runs tests/emu against
// them and stops them. DRYSCOPE_EMU_PROJECT picks the project id; anything not starting with
// `demo-` is refused before the Firebase CLI starts.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_EMU_PROJECT, requireDemoProject } from './guard';
import { acquireEmulatorLock } from './lock';
import { claimEmuPorts, writeEmulatorConfig } from './ports';

// Same pinned CLI as the root app's emulator job (.github/workflows/ci.yml). It stays out of
// package.json so the other web jobs do not install it.
const FIREBASE_TOOLS = 'firebase-tools@15.31.0';
const webDir = fileURLToPath(new URL('../..', import.meta.url));

let projectId: string;
try {
  projectId = requireDemoProject(process.env.DRYSCOPE_EMU_PROJECT ?? DEFAULT_EMU_PROJECT);
} catch (error) {
  console.error((error as Error).message);
  process.exit(2);
}

// By default the emulators use the fixed ports in firebase.json, so only one such run per machine
// may hold them at a time and a second waits for the lock. A run with its own ports (EMU_*_PORT
// or EMU_PORTS=auto, ports.ts) claims just those and runs beside the others.
let release: () => void;
let config = 'firebase.json';
try {
  const claim = claimEmuPorts(['auth', 'firestore', 'firestoreWebsocket', 'hub', 'logging']);
  if (claim.custom) {
    release = claim.release;
    config = writeEmulatorConfig(join(webDir, 'firebase.json'), claim.ports);
    console.error(`test:emu ports: ${Object.entries(claim.ports).map(([name, port]) => `${name} ${port}`).join(', ')}`);
  } else {
    release = await acquireEmulatorLock();
  }
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
process.on('exit', release);

// Test files to run instead of all of tests/emu (`npm run test:isolation`). They join a command
// line the Firebase CLI runs through a shell, so only plain relative test-file paths are accepted.
const files = process.argv.slice(2);
if (files.some((file) => !/^tests\/emu\/[A-Za-z0-9_./-]+\.test\.ts$/.test(file) || file.includes('..'))) {
  console.error('Test files for test:emu must be paths like tests/emu/rules/example.test.ts');
  release();
  process.exit(2);
}

// The CLI runs in its own process group so that everything it starts (the emulators are Java
// processes that can outlive it) can be stopped together. Whenever the run ends, whether the tests
// failed, the CLI died, or the runner was interrupted, the whole group is stopped, so no emulator
// is left holding a port. SIGKILL of the runner itself cannot be caught.
const child = spawn(
  'npx',
  [
    '--yes',
    FIREBASE_TOOLS,
    'emulators:exec',
    '--only',
    'auth,firestore',
    '--project',
    projectId,
    '--config',
    config,
    ['npx vitest run --config vitest.emu.config.ts', ...files].join(' '),
  ],
  { cwd: webDir, stdio: 'inherit', detached: true },
);

const GRACE_MS = 5_000;
function stopGroup(signal: NodeJS.Signals | 0): boolean {
  if (child.pid === undefined) return false;
  try {
    process.kill(-child.pid, signal); // signal 0 only checks that the group still has members
    return true;
  } catch {
    return false; // nobody left in the group
  }
}

// Stops what the CLI left behind: ask politely, then force after a short grace.
async function cleanUp(): Promise<void> {
  if (!stopGroup('SIGTERM')) return;
  const deadline = Date.now() + GRACE_MS;
  while (Date.now() < deadline && stopGroup(0)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  stopGroup('SIGKILL');
}
// Last resort if the process is torn down without going through the paths below.
process.on('exit', () => {
  stopGroup('SIGKILL');
});

let finishing = false;
async function finish(code: number): Promise<never> {
  if (!finishing) {
    finishing = true;
    await cleanUp();
    release();
  }
  process.exit(code);
}

child.on('error', (error) => {
  console.error(`Could not start the Firebase CLI: ${error.message}`);
  void finish(1);
});
child.on('exit', (code, signal) => void finish(code ?? (signal ? 1 : 0)));
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    stopGroup(signal);
    // The child's exit finishes the run; if it does not exit, finish anyway after the grace.
    setTimeout(() => void finish(1), GRACE_MS + 1_000).unref();
  });
}
