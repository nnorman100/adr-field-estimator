#!/usr/bin/env node
'use strict';
// Required-docs check: every listed Markdown file must exist and hold text. Run by
// `npm run lint`, which is a required check on every pull request. It also runs
// check-protected-tests.mjs so lint fails when a test file is outside protected_paths.
// checkLawyerChecklist (S8-1) checks the lawyer checklist's items and that product-rules.md 4C
// agrees with it; tests/test_required_docs.js runs it on this repository in the vitest suite.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_DOCS = [
  'README.md',
  'CLAUDE.md',
  'AGENTS.md',
  'HANDOFF.md',
  'docs/spec.md',
  'docs/ARCHITECTURE.md',
  'docs/DECISIONS.md',
  'docs/DATA.md',
  'docs/RUNBOOK.md',
  'docs/AI.md',
  'docs/plans/S8/lawyer-checklist.md',
];

const LAWYER_CHECKLIST = 'docs/plans/S8/lawyer-checklist.md';
const PRODUCT_RULES = 'docs/architecture/product-rules.md';
const ITEM_HEADER = '| Id | Question | Why it matters | Where the answer lands | Until then |';
// What 4C and the checklist must cite alike: statute sections written with §, bills, and the
// W (wording review) and V (S7 decision) codes.
const REFERENCE = /§\s?\d+(?:\.\d+)?|\b(?:SB|AB) \d+\b|\b[WV]\d+\b/g;

function cellsOf(line) {
  return line
    .slice(1, line.endsWith('|') ? -1 : undefined)
    .split('|')
    .map((cell) => cell.trim());
}

function referencesOf(text) {
  return new Set((text.match(REFERENCE) ?? []).map((ref) => ref.replace(/\s/g, '')));
}

// Every row of a table headed ITEM_HEADER is an item: an id (A1, B12, optionally followed by a
// marker such as **(gate)**), a question and an "until then" line. Returns problems and items by id.
function readChecklist(text) {
  const problems = [];
  const items = new Map();
  let inTable = false;
  for (const line of text.split('\n')) {
    if (line === ITEM_HEADER) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (!line.startsWith('|')) {
      inTable = false;
      continue;
    }
    if (/^\|[\s|:-]+\|$/.test(line)) continue;
    const cells = cellsOf(line);
    const id = /^([A-H]\d+)\b/.exec(cells[0])?.[1];
    if (!id) {
      problems.push(`lawyer checklist: an item lacks its id: ${line.slice(0, 60)}`);
      continue;
    }
    if (cells.length !== 5)
      problems.push(`lawyer checklist: ${id} has ${cells.length} cells, not 5.`);
    if (!cells[1]) problems.push(`lawyer checklist: ${id} lacks its question.`);
    if (!cells[4]) problems.push(`lawyer checklist: ${id} lacks its "until then" line.`);
    if (items.has(id)) problems.push(`lawyer checklist: ${id} appears twice.`);
    items.set(id, line);
  }
  if (!items.size) problems.push(`lawyer checklist: no item table headed "${ITEM_HEADER}".`);
  return { problems, items };
}

// The numbered items of product-rules.md 4C, each ending "Checklist: <ids>.".
function readRules4C(text) {
  const start = text.indexOf('#### C. Wording held for lawyer review');
  if (start < 0) return null;
  const rest = text.slice(text.indexOf('\n', start) + 1);
  const end = rest.search(/^#{2,4} /m);
  const section = end < 0 ? rest : rest.slice(0, end);
  const items = section.split('\n').filter((line) => /^\d+\. /.test(line));
  return { section, items };
}

function checkLawyerChecklist(root = path.join(__dirname, '..')) {
  let checklist;
  let rules;
  try {
    checklist = fs.readFileSync(path.join(root, LAWYER_CHECKLIST), 'utf8');
    rules = fs.readFileSync(path.join(root, PRODUCT_RULES), 'utf8');
  } catch (error) {
    return [`lawyer checklist: cannot read ${error.path ?? 'a file'}.`];
  }
  const { problems, items } = readChecklist(checklist);
  const rules4C = readRules4C(rules);
  if (!rules4C) return [...problems, `${PRODUCT_RULES}: section 4C is missing.`];
  if (!rules4C.section.includes('(../plans/S8/lawyer-checklist.md)')) {
    problems.push(`${PRODUCT_RULES} 4C: no link to the lawyer checklist.`);
  }
  if (rules4C.items.length !== 5) {
    problems.push(
      `${PRODUCT_RULES} 4C: ${rules4C.items.length} numbered items, not the five numbered items.`,
    );
  }
  rules4C.items.forEach((item, index) => {
    const n = index + 1;
    const named = /Checklist: ([A-H]\d+(?:, [A-H]\d+)*)\.\s*$/.exec(item);
    if (!named) {
      problems.push(`${PRODUCT_RULES} 4C item ${n} does not end "Checklist: <ids>."`);
      return;
    }
    const rows = [];
    for (const id of named[1].split(', ')) {
      if (items.has(id)) rows.push(items.get(id));
      else
        problems.push(
          `${PRODUCT_RULES} 4C item ${n} names ${id}, which the checklist does not have.`,
        );
    }
    const ruleRefs = [...referencesOf(item.slice(0, named.index))].sort();
    const listRefs = [...referencesOf(rows.join('\n'))].sort();
    if (ruleRefs.join() !== listRefs.join()) {
      problems.push(
        `${PRODUCT_RULES} 4C item ${n} and checklist ${named[1]} disagree: ` +
          `4C cites [${ruleRefs.join(', ')}], the checklist [${listRefs.join(', ')}].`,
      );
    }
  });
  return problems;
}

function checkRequiredDocs(root = path.join(__dirname, '..')) {
  const problems = [];
  for (const name of REQUIRED_DOCS) {
    const file = path.join(root, name);
    let text;
    try {
      if (!fs.statSync(file).isFile()) throw new Error('not a file');
      text = fs.readFileSync(file, 'utf8');
    } catch {
      problems.push(`${name} is missing.`);
      continue;
    }
    if (!text.trim()) problems.push(`${name} is empty.`);
  }
  return problems;
}

function main() {
  const problems = checkRequiredDocs();
  for (const message of problems) console.error(`::error title=Required docs::${message}`);
  console.log(`required docs: ${problems.length} problem(s) in ${REQUIRED_DOCS.length} files`);
  const protectedTests = spawnSync(
    process.execPath,
    [path.join(__dirname, 'check-protected-tests.mjs')],
    { stdio: 'inherit' },
  );
  return problems.length || protectedTests.status !== 0 ? 1 : 0;
}

if (require.main === module) process.exit(main());

module.exports = {
  REQUIRED_DOCS,
  LAWYER_CHECKLIST,
  PRODUCT_RULES,
  checkRequiredDocs,
  checkLawyerChecklist,
};
