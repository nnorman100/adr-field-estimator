import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { writeApiRoutes } from './scripts/gen-api-routes';

// The App Check route list is generated, not committed (scripts/gen-api-routes.ts).
writeApiRoutes();

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: { include: ['tests/unit/**/*.test.ts'], environment: 'node' },
});
