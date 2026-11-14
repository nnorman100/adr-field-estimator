import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

// The 1,000-line single-file limit from the repo rules applies to every source file here.
export default defineConfig([
  ...nextVitals,
  ...nextTs,
  { rules: { 'max-lines': ['error', { max: 1000 }] } },
  globalIgnores(['.next/**', 'out/**', 'next-env.d.ts', 'test-results/**', 'playwright-report/**', 'synthetic/node_modules/**', 'synthetic/dist/**']),
]);
