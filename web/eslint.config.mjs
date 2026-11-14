import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const SIGN_OUT_RULE = 'Sign out with signOutOnRefusal (or the person\'s own signOutKeeping or signOutDiscarding) from @/lib/field/sign-out.';
const RETENTION_RULE = 'Locks and locked work change only through evaluate(now, event) in @/lib/field/retention.';

// A lock on someone's unsent work is saved, lifted and acted on by one routine, evaluate() in
// src/lib/field/retention.ts (O5, S6-3b). Nothing else may reach the steps it is made of.
const RETENTION_STEPS = [
  { group: ['**/unsent', '@/lib/field/unsent'], importNames: ['noteLocked', 'noteUnlocked', 'noteLetIn'], message: RETENTION_RULE },
  { group: ['**/retention', '@/lib/field/retention'], importNames: ['lockWork'], message: RETENTION_RULE },
];

// The 1,000-line single-file limit from the repo rules applies to every source file here.
export default defineConfig([
  ...nextVitals,
  ...nextTs,
  { rules: { 'max-lines': ['error', { max: 1000 }] } },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/lib/field/retention.ts', 'src/app/**'],
    rules: { 'no-restricted-imports': ['error', { patterns: RETENTION_STEPS }] },
  },
  // Every sign-out a company screen or the field shell makes goes through src/lib/field/sign-out.ts,
  // which tells that routine of a refusal before the saved sign-in goes. The operator console signs
  // operators out, who have no field work.
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
          patterns: RETENTION_STEPS,
        },
      ],
    },
  },
  { files: ['src/app/operator/**/*.{ts,tsx}'], rules: { 'no-restricted-imports': ['error', { patterns: RETENTION_STEPS }] } },
  globalIgnores(['.next/**', 'out/**', 'next-env.d.ts', 'test-results/**', 'playwright-report/**', 'synthetic/node_modules/**', 'synthetic/dist/**']),
]);
