#!/usr/bin/env node
'use strict';
// Required-docs check: every listed Markdown file must exist and hold text. Run by
// `npm run lint`, which is a required check on every pull request.
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
];

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
  return problems.length ? 1 : 0;
}

if (require.main === module) process.exit(main());

module.exports = { REQUIRED_DOCS, checkRequiredDocs };
