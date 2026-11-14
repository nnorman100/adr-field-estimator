import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const SIGN_OUT_RULE = 'Sign out with signOutOnRefusal (or the person\'s own signOutKeeping or signOutDiscarding) from @/lib/field/sign-out.';

// The 1,000-line single-file limit from the repo rules applies to every source file here.
export default defineConfig([
  ...nextVitals,
  ...nextTs,
  { rules: { 'max-lines': ['error', { max: 1000 }] } },
  // Every sign-out a company screen or the field shell makes goes through src/lib/field/sign-out.ts,
  // which saves a refusal's lock before the saved sign-in goes (O5, S6-3b). The operator console
  // signs operators out, who have no field work.
  {
    files: ['src/app/**/*.{ts,tsx}'],
    ignores: ['src/app/operator/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: '@/lib/firebase-client', importNames: ['signOutCompany'], message: SIGN_OUT_RULE },
            { name: '@/lib/field/ds-me', importNames: ['forgetMe'], message: SIGN_OUT_RULE },
          ],
        },
      ],
    },
  },
  globalIgnores(['.next/**', 'out/**', 'next-env.d.ts', 'test-results/**', 'playwright-report/**', 'synthetic/node_modules/**', 'synthetic/dist/**']),
]);
