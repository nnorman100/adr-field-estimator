import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Files run in parallel, each in a database of its own on one shared server (tests/db/global-setup.ts).
// A runner with a few cores gets few workers: half the cores, at least two and at most four, and
// DRYSCOPE_DB_TEST_WORKERS sets it by hand.
const workers = Number(process.env.DRYSCOPE_DB_TEST_WORKERS) || Math.max(2, Math.min(4, Math.floor(availableParallelism() / 2)));

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: ['tests/db/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['./tests/db/global-setup.ts'],
    maxWorkers: workers,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
