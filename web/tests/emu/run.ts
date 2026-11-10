// `npm run test:emu`: starts the Firebase Auth and Firestore emulators, runs tests/emu against
// them and stops them. DRYSCOPE_EMU_PROJECT picks the project id; anything not starting with
// `demo-` is refused before the Firebase CLI starts.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_EMU_PROJECT, requireDemoProject } from './guard';

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
    'npx vitest run --config vitest.emu.config.ts',
  ],
  { cwd: webDir, stdio: 'inherit' },
);
child.on('error', (error) => {
  console.error(`Could not start the Firebase CLI: ${error.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
