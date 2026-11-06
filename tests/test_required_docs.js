'use strict';
// The required-docs check fails when a listed Markdown file is missing or empty.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { REQUIRED_DOCS, checkRequiredDocs } = require('../scripts/check_required_docs');

const ROOT = path.join(__dirname, '..');

function makeRoot(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'required-docs-'));
  for (const name of REQUIRED_DOCS) {
    if (name in files) continue;
    files[name] = '# Present\n';
  }
  for (const [name, text] of Object.entries(files)) {
    if (text === null) continue;
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return root;
}

test('the list names every file the standard requires', () => {
  assert.deepEqual([...REQUIRED_DOCS].sort(), [
    'AGENTS.md',
    'CLAUDE.md',
    'HANDOFF.md',
    'README.md',
    'docs/AI.md',
    'docs/ARCHITECTURE.md',
    'docs/DATA.md',
    'docs/DECISIONS.md',
    'docs/RUNBOOK.md',
    'docs/spec.md',
  ]);
});

test('passes when every listed file has text', () => {
  assert.deepEqual(checkRequiredDocs(makeRoot({})), []);
});

test('fails for a missing file', () => {
  const problems = checkRequiredDocs(makeRoot({ 'HANDOFF.md': null }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /HANDOFF\.md.*missing/);
});

test('fails for an empty file and for one holding only whitespace', () => {
  const problems = checkRequiredDocs(makeRoot({ 'docs/DATA.md': '', 'docs/AI.md': ' \n\t\n' }));
  assert.equal(problems.length, 2);
  assert.ok(problems.every((p) => /empty/.test(p)));
});

test('a directory with a listed name counts as missing', () => {
  const root = makeRoot({ 'docs/spec.md': null });
  fs.mkdirSync(path.join(root, 'docs', 'spec.md'));
  const problems = checkRequiredDocs(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /docs\/spec\.md.*missing/);
});

test('this repository has every required doc', () => {
  assert.deepEqual(checkRequiredDocs(ROOT), []);
});
