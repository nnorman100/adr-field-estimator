// `npm run test:emu`: starts the Firebase Auth and Firestore emulators, runs tests/emu against
// them and stops them. DRYSCOPE_EMU_PROJECT picks the project id; anything not starting with
// `demo-` is refused before the Firebase CLI starts.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_EMU_PROJECT, requireDemoProject } from './guard';
import { acquireEmulatorLock } from './lock';

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

// The emulators use fixed ports, so only one run per machine may hold them at a time.
let release: () => void;
try {
  release = await acquireEmulatorLock();
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
    'firebase.json',
    ['npx vitest run --config vitest.emu.config.ts', ...files].join(' '),
  ],
  { cwd: webDir, stdio: 'inherit' },
);
child.on('error', (error) => {
  console.error(`Could not start the Firebase CLI: ${error.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => child.kill(signal)); // the child's exit then releases the lock
}
