const { defineConfig } = require('/home/nnorm/.no-mistakes/worktrees/e9831d793e9a/01M56MZGFDFA0BA7ANQ9HW120S/node_modules/@playwright/test');
const base = require('/home/nnorm/.no-mistakes/worktrees/e9831d793e9a/01M56MZGFDFA0BA7ANQ9HW120S/playwright.config.js');
module.exports = defineConfig({ ...base, testDir: '/home/nnorm/.no-mistakes/evidence/01M56MZGFDFA0BA7ANQ9HW120S', testMatch: 'palette-evidence.spec.js',
  outputDir: '/home/nnorm/.no-mistakes/evidence/01M56MZGFDFA0BA7ANQ9HW120S/pw-output', projects: [base.projects[0]],
  webServer: { ...base.webServer, cwd: '/home/nnorm/.no-mistakes/worktrees/e9831d793e9a/01M56MZGFDFA0BA7ANQ9HW120S' } });
