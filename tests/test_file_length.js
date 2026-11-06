'use strict';
// ESLint max-lines for the 1,000-line limit: a new over-limit JavaScript file is an error,
// an allowlisted one only a warning.
const test = require('node:test');
const assert = require('node:assert/strict');
const { ESLint } = require('eslint');
const { fileLengthConfig } = require('../scripts/file_length_eslint');
const allowlist = require('../scripts/file_length_allowlist.json');

const body = (lines) => '// line\n'.repeat(lines);

async function lint(config, file, lines) {
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: config,
    cwd: process.cwd(),
  });
  const [result] = await eslint.lintText(body(lines), { filePath: file });
  return result;
}

const config = fileLengthConfig({ limit: 1000, files: ['public/old.js', 'backend/old.py'] });

test('a new JavaScript file over 1,000 lines is an error', async () => {
  const result = await lint(config, 'public/new-module.js', 1001);
  assert.equal(result.errorCount, 1);
  assert.equal(result.messages[0].ruleId, 'max-lines');
});

test('a JavaScript file of exactly 1,000 lines passes', async () => {
  const result = await lint(config, 'public/new-module.js', 1000);
  assert.equal(result.errorCount + result.warningCount, 0);
});

test('an allowlisted JavaScript file over the limit only warns', async () => {
  const result = await lint(config, 'public/old.js', 1500);
  assert.equal(result.errorCount, 0);
  assert.equal(result.warningCount, 1);
  assert.equal(result.messages[0].ruleId, 'max-lines');
});

test('the committed allowlist warns for its JavaScript files and nothing else', () => {
  const real = fileLengthConfig();
  const warned = real.slice(1).flatMap((entry) => entry.files);
  assert.deepEqual(warned.sort(), allowlist.files.filter((f) => f.endsWith('.js')).sort());
});
