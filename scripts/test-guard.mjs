#!/usr/bin/env node
// Test guard: fails a pull request that weakens tests, evaluations or checks,
// unless the repository owner has added the "test-change-approved" label.
//
// It flags:
//   1. Any change to a protected file (scoring thresholds, eval scripts and
//      fixtures, workflow files, this guard and its config).
//   2. A deleted test file (or one renamed out of the test folders).
//   3. Fewer test definitions than before across the changed test files.
//   4. Newly added skip, only, todo or expected-failure markers in test files.
//
// Usage: node scripts/test-guard.mjs <base-commit>
// Config: .github/test-guard.json  { "tests": [globs], "protected": [globs] }

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const APPROVAL_LABEL = 'test-change-approved';

const base = process.argv[2] || process.env.GUARD_BASE;
if (!base) {
  console.error('test-guard: pass the base commit as the first argument.');
  process.exit(2);
}

// Read the rules from the base commit, so a pull request cannot loosen them
// for itself. When the base has no rules, this pull request is the one that
// installs the guard, so it passes.
function readConfig() {
  try {
    return JSON.parse(
      execFileSync('git', ['show', `${base}:.github/test-guard.json`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch {
    return null;
  }
}
const config = readConfig();
if (!config) {
  console.log(
    'test-guard: the base commit has no guard yet, so this pull request is installing it. Passing.',
  );
  process.exit(0);
}

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

const testPatterns = (config.tests || []).map(globToRegExp);
const protectedPatterns = (config.protected || []).map(globToRegExp);
const isTest = (p) => testPatterns.some((r) => r.test(p));
const isProtected = (p) => protectedPatterns.some((r) => r.test(p));

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

const range = `${base}...HEAD`;
const changes = git(['diff', '--name-status', '-M', range])
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const parts = line.split('\t');
    return { status: parts[0][0], from: parts[1], to: parts[2] || parts[1] };
  });

// Patterns that make a test stop running or stop counting.
const SKIP_MARKERS = [
  /\b(?:it|test|describe|suite)\s*\.\s*(?:skip|only|todo|fixme)\b/,
  /\b(?:xit|xtest|xdescribe|fit|fdescribe)\s*\(/,
  /\bskip\s*:\s*(?:true|['"`])/,
  /\btodo\s*:\s*(?:true|['"`])/,
  /@pytest\.mark\.(?:skip|skipif|xfail)\b/,
  /\bpytest\.(?:skip|xfail)\s*\(/,
  /@unittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b/,
];

// Lines that define a test.
const TEST_DEFINITIONS = [
  /^\s*(?:it|test)\s*(?:\.\s*(?:skip|only|todo|fixme|each\s*\([^)]*\))\s*)?\(/,
  /^\s*(?:async\s+)?def\s+test_\w*\s*\(/,
];

const violations = [];
let removedDefinitions = 0;
let addedDefinitions = 0;

for (const { status, from, to } of changes) {
  const touched = [...new Set([from, to])];
  for (const path of touched) {
    if (isProtected(path)) {
      violations.push(`Protected file changed (${status}): ${path}`);
    }
  }

  if (status === 'D' && isTest(from)) {
    violations.push(`Test file deleted: ${from}`);
    continue;
  }
  if (status === 'R' && isTest(from) && !isTest(to)) {
    violations.push(`Test file moved out of the test folders: ${from} -> ${to}`);
  }

  if (!isTest(to) || status === 'D') continue;

  const diffArgs =
    status === 'R'
      ? ['diff', '-U0', '-M', range, '--', from, to]
      : ['diff', '-U0', range, '--', to];
  const diff = git(diffArgs);
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) {
      const body = line.slice(1);
      if (SKIP_MARKERS.some((r) => r.test(body))) {
        violations.push(`Skip or only marker added in ${to}: ${body.trim().slice(0, 140)}`);
      }
      if (TEST_DEFINITIONS.some((r) => r.test(body))) addedDefinitions++;
    } else if (line.startsWith('-')) {
      if (TEST_DEFINITIONS.some((r) => r.test(line.slice(1)))) removedDefinitions++;
    }
  }
}

// Deleted test files count toward removed definitions too.
for (const { status, from } of changes) {
  if (status !== 'D' || !isTest(from)) continue;
  const old = git(['show', `${base}:${from}`]);
  for (const line of old.split('\n')) {
    if (TEST_DEFINITIONS.some((r) => r.test(line))) removedDefinitions++;
  }
}

if (removedDefinitions > addedDefinitions) {
  violations.push(
    `Fewer tests than before: ${removedDefinitions} test definitions removed, ${addedDefinitions} added.`,
  );
}

let labels = [];
if (process.env.GITHUB_EVENT_PATH) {
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    labels = (event.pull_request?.labels || []).map((l) => l.name);
  } catch {
    // No event file: treat as unapproved.
  }
}
const approved = labels.includes(APPROVAL_LABEL);

if (violations.length === 0) {
  console.log('test-guard: no test, evaluation or check weakening found.');
  process.exit(0);
}

console.log('test-guard found changes that can weaken testing:');
for (const v of violations) console.log(`  - ${v}`);

if (approved) {
  console.log(`\nApproved by the "${APPROVAL_LABEL}" label. Passing.`);
  process.exit(0);
}

console.log(
  `\nThe owner must review these and add the "${APPROVAL_LABEL}" label to this pull request.` +
    '\nCoding agents must never add that label themselves.',
);
process.exit(1);
