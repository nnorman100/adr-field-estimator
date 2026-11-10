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
  },
});
