// The required-docs check fails when a listed Markdown file is missing or empty. The lawyer
// checklist check (S8-1) fails when a checklist item lacks its id, question or "until then" line,
// or when product-rules.md 4C and the checklist disagree on the five California items.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const {
  REQUIRED_DOCS,
  checkRequiredDocs,
  checkLawyerChecklist,
  LAWYER_CHECKLIST,
  PRODUCT_RULES,
} = require('../scripts/check_required_docs.js');

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
    'docs/plans/S8/lawyer-checklist.md',
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

// A copy of the real checklist and product rules with one text replacement applied to one of them.
function lawyerRoot(file, from, to) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lawyer-checklist-'));
  for (const name of [LAWYER_CHECKLIST, PRODUCT_RULES]) {
    let text = fs.readFileSync(path.join(ROOT, name), 'utf8');
    if (name === file) {
      expect(text, `${name} holds the text the test changes`).toContain(from);
      text = text.replace(from, to);
    }
    fs.mkdirSync(path.join(root, path.dirname(name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  return checkLawyerChecklist(root);
}

test('the lawyer checklist and product rules 4C agree in this repository', () => {
  expect(checkLawyerChecklist(ROOT)).toEqual([]);
});

test('a checklist item without its id fails', () => {
  const problems = lawyerRoot(LAWYER_CHECKLIST, '| B5 |', '|  |');
  expect(problems).toHaveLength(1);
  expect(problems[0]).toMatch(/lacks its id/);
});

test('a checklist item without its question fails', () => {
  const problems = lawyerRoot(
    LAWYER_CHECKLIST,
    '| C2 | Does the California',
    '| C2 | | Does the California',
  );
  expect(problems.some((p) => /C2 lacks its question/.test(p))).toBe(true);
});

test('a checklist item without its "until then" line fails', () => {
  const text = fs.readFileSync(path.join(ROOT, LAWYER_CHECKLIST), 'utf8');
  const row = text.split('\n').find((line) => line.startsWith('| D4 |'));
  const cells = row.split(' | ');
  const blank = [...cells.slice(0, -1), ' |'].join(' | ');
  const problems = lawyerRoot(LAWYER_CHECKLIST, row, blank);
  expect(problems).toEqual(['lawyer checklist: D4 lacks its "until then" line.']);
});

test('4C naming a checklist item that does not exist fails', () => {
  const problems = lawyerRoot(PRODUCT_RULES, 'Checklist: A3.', 'Checklist: A30.');
  expect(problems.some((p) => /4C item 3 names A30/.test(p))).toBe(true);
});

test('4C and the checklist citing different statutes fails, either way round', () => {
  const ruleSide = lawyerRoot(PRODUCT_RULES, '§1689.13', '§1689.14');
  expect(ruleSide.some((p) => /4C item 4 .*disagree/.test(p))).toBe(true);
  const listSide = lawyerRoot(LAWYER_CHECKLIST, 'Code §7030.5', 'Code §7030.6');
  expect(listSide.some((p) => /4C item 2 .*disagree/.test(p))).toBe(true);
});

test('4C losing one of its five items or its link to the checklist fails', () => {
  const four = lawyerRoot(PRODUCT_RULES, '\n5. Also with the lawyer', '\nAlso with the lawyer');
  expect(four.some((p) => /five numbered items/.test(p))).toBe(true);
  const unlinked = lawyerRoot(PRODUCT_RULES, '(../plans/S8/lawyer-checklist.md)', '');
  expect(unlinked.some((p) => /link/.test(p))).toBe(true);
});
