// The required-docs check fails when a listed Markdown file is missing or empty.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const { REQUIRED_DOCS, checkRequiredDocs } = require('../scripts/check_required_docs.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

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
  expect([...REQUIRED_DOCS].sort()).toEqual([
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
  expect(checkRequiredDocs(makeRoot({}))).toEqual([]);
});

test('fails for a missing file', () => {
  const problems = checkRequiredDocs(makeRoot({ 'HANDOFF.md': null }));
  expect(problems).toHaveLength(1);
  expect(problems[0]).toMatch(/HANDOFF\.md.*missing/);
});

test('fails for an empty file and for one holding only whitespace', () => {
  const problems = checkRequiredDocs(makeRoot({ 'docs/DATA.md': '', 'docs/AI.md': ' \n\t\n' }));
  expect(problems).toHaveLength(2);
  expect(problems.every((p) => /empty/.test(p))).toBe(true);
});

test('a directory with a listed name counts as missing', () => {
  const root = makeRoot({ 'docs/spec.md': null });
  fs.mkdirSync(path.join(root, 'docs', 'spec.md'));
  const problems = checkRequiredDocs(root);
  expect(problems).toHaveLength(1);
  expect(problems[0]).toMatch(/docs\/spec\.md.*missing/);
});

test('this repository has every required doc', () => {
  expect(checkRequiredDocs(ROOT)).toEqual([]);
});
