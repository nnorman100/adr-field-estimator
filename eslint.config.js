'use strict';
const js = require('@eslint/js');
const globals = require('globals');

// Lint only: formatting belongs to Prettier. The frontend has no build step, so the
// browser files are plain scripts that share globals (for example ADRCore) rather than modules.
module.exports = [
  {
    ignores: [
      'node_modules/**',
      '**/.venv*/**',
      'public/vendor/**',
      'test-results/**',
      'playwright-report/**',
      'review-artifacts/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser, ADRCore: 'readonly' } },
  },
  {
    // Test stand-in for the vendored Firebase auth module; loaded with import().
    files: ['tests/browser-auth.js'],
    languageOptions: { sourceType: 'module', globals: { ...globals.browser } },
  },
  {
    // Playwright specs run callbacks inside the page, so they reference page globals too.
    files: ['tests/browser/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    // Conservative rule set: no logic rewrites to satisfy the linter. The frontend scripts share
    // globals across files and Playwright callbacks run inside the page, so no-undef cannot be
    // checked here without a hand-kept global list.
    rules: {
      'no-undef': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      // A few existing unused bindings; reported as warnings rather than rewriting code here.
      'no-unused-vars': ['warn', { caughtErrors: 'none' }],
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off',
    },
  },
];
