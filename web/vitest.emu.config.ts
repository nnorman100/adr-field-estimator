import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Started by `npm run test:emu` inside `firebase emulators:exec`; see tests/emu/run.ts.
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: ['tests/emu/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/emu/setup.ts'],
    testTimeout: 30_000,
    // Suite setup makes dozens of sequential emulator calls (tenants, sign-ups, documents); the 10s
    // default hook limit is within a second of a cold CI emulator's time, so it matches the tests.
    hookTimeout: 30_000,
  },
});
