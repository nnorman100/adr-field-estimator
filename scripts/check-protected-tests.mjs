#!/usr/bin/env node
// Fails when a test file (*.test.*, *.spec.*, *.tftest.hcl) sits outside the
// protected_paths in .no-mistakes.yaml, so a new test directory cannot escape the
// approval gate for automatic fixes. Entries must be exact files or literal
// directory prefixes ending in /**, the only forms the no-mistakes matcher honors.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

const ROOT = path.resolve(import.meta.dirname, '..');
const TEST_FILE = /(\.(test|spec)\.[^/]+|\.tftest\.hcl)$/;

const entries =
  parse(readFileSync(path.join(ROOT, '.no-mistakes.yaml'), 'utf8')).protected_paths ?? [];
const problems = [];
const prefixes = [];
const exact = new Set();
for (const entry of entries) {
  const isPrefix = entry.endsWith('/**');
  const body = isPrefix ? entry.slice(0, -3) : entry;
  if (body.includes('*')) problems.push(`unsupported protected_paths pattern: ${entry}`);
  else if (isPrefix) prefixes.push(`${body}/`);
  else exact.add(entry);
}

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  cwd: ROOT,
  encoding: 'utf8',
})
  .split('\n')
  .filter((file) => file && !file.split('/').includes('node_modules'));
for (const file of files) {
  if (!TEST_FILE.test(file)) continue;
  if (exact.has(file) || prefixes.some((prefix) => file.startsWith(prefix))) continue;
  problems.push(`test file outside protected_paths: ${file}`);
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(
  `protected tests: ${files.filter((file) => TEST_FILE.test(file)).length} test files covered`,
);
