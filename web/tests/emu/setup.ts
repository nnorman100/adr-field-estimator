// Runs before any emulator test file: refuses a non-demo project or a non-loopback emulator,
// even when vitest is started directly instead of through npm run test:emu.
import { requireEmulatorEnv } from './guard';

requireEmulatorEnv(process.env);
