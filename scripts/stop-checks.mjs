#!/usr/bin/env node
// Claude Code Stop hook (.claude/settings.json): before an agent may finish, run the fast checks
// for the files it changed, so CI confirms work instead of finding the problems. Only files changed
// since the branch left master (plus uncommitted and new files) are checked:
//   root (non-web/) files: Prettier and ESLint on those files, vitest on tests related to them;
//   web/ files: the whole-project type check, ESLint on those files, vitest unit tests related to them.
// The slow suites (test:db, test:emu, test:e2e, the image build) stay in CI.
// A failure blocks the stop and hands the output back to the agent. After MAX_BLOCKS failed
// attempts in a row in one session the agent may stop, with a warning shown to the person, so a
// problem the agent cannot fix never loops forever. DRYSCOPE_SKIP_STOP_CHECKS=1 turns it off.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MAX_BLOCKS = 3;
const OUTPUT_LINES = 60;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Prettier covers what `npm run format` covers; web/ is in .prettierignore.
const PRETTIER = /\.(js|css|ts|mts)$/;
// The root ESLint config lints JavaScript only; web/ has its own config.
const ROOT_ESLINT = /\.(js|cjs|mjs)$/;
const CODE = /\.(js|cjs|mjs|ts|mts|cts|tsx|jsx)$/;

/** Which checks to run for these changed files (repo-relative, forward slashes). */
export function planChecks(files, base) {
  const web = files.filter((f) => f.startsWith('web/'));
  const root = files.filter((f) => !f.startsWith('web/'));
  const webRel = web.map((f) => f.slice('web/'.length));
  const checks = [];
  const vitestArgs = ['vitest', 'run', '--changed', base, '--passWithNoTests'];

  const pretty = root.filter((f) => PRETTIER.test(f));
  if (pretty.length) {
    checks.push({
      name: 'Prettier',
      cwd: '.',
      cmd: 'npx',
      args: ['prettier', '--check', ...pretty],
    });
  }
  const rootLint = root.filter((f) => ROOT_ESLINT.test(f));
  if (rootLint.length) {
    checks.push({
      name: 'ESLint (root)',
      cwd: '.',
      cmd: 'npx',
      args: ['eslint', '--no-warn-ignored', ...rootLint],
    });
  }
  if (root.some((f) => CODE.test(f))) {
    checks.push({ name: 'Vitest (root)', cwd: '.', cmd: 'npx', args: vitestArgs });
  }

  const webCode = webRel.filter((f) => CODE.test(f));
  if (webCode.length) {
    checks.push({
      name: 'Type check (web)',
      cwd: 'web',
      cmd: 'npm',
      args: ['run', '--silent', 'typecheck'],
    });
    checks.push({
      name: 'ESLint (web)',
      cwd: 'web',
      cmd: 'npx',
      args: ['eslint', '--no-warn-ignored', ...webCode],
    });
    checks.push({ name: 'Vitest (web unit)', cwd: 'web', cmd: 'npx', args: vitestArgs });
  }
  return checks;
}

function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** The commit the branch left master at, or HEAD when master is not fetched. */
function findBase() {
  for (const ref of ['origin/master', 'master']) {
    const base = git(['merge-base', 'HEAD', ref]);
    if (base) return base;
  }
  return 'HEAD';
}

function changedFiles(base) {
  const tracked = git(['diff', '--name-only', '--diff-filter=d', base]) ?? '';
  const untracked = git(['ls-files', '--others', '--exclude-standard']) ?? '';
  const all = `${tracked}\n${untracked}`
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);
  return [...new Set(all)].filter((f) => existsSync(path.join(ROOT, f)));
}

function run(check) {
  const r = spawnSync(check.cmd, check.args, {
    cwd: path.join(ROOT, check.cwd),
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}`.trim();
  return { ok: r.status === 0, output: output.split('\n').slice(-OUTPUT_LINES).join('\n') };
}

function counterFile(sessionId) {
  const dir = path.join(tmpdir(), 'dryscope-stop-checks');
  mkdirSync(dir, { recursive: true });
  return path.join(dir, String(sessionId || 'unknown').replace(/[^\w-]/g, '_'));
}

function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

function say(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

export function main() {
  const input = readInput();
  if (process.env.DRYSCOPE_SKIP_STOP_CHECKS === '1') return;
  if (!existsSync(path.join(ROOT, 'node_modules'))) {
    say({
      systemMessage: 'Stop checks skipped: run `npm ci` at the repo root (and in web/) first.',
    });
    return;
  }
  const base = findBase();
  const checks = planChecks(changedFiles(base), base);
  const counter = counterFile(input.session_id);
  if (!checks.length) return;
  if (checks.some((c) => c.cwd === 'web') && !existsSync(path.join(ROOT, 'web', 'node_modules'))) {
    say({ systemMessage: 'Stop checks for web/ skipped: run `npm ci` in web/ first.' });
    return;
  }

  const failures = [];
  for (const check of checks) {
    const result = run(check);
    if (!result.ok)
      failures.push(
        `## ${check.name} failed\n$ ${check.cmd} ${check.args.join(' ')}\n${result.output}`,
      );
  }
  if (!failures.length) {
    rmSync(counter, { force: true });
    return;
  }

  const blocks = (Number(existsSync(counter) ? readFileSync(counter, 'utf8') : 0) || 0) + 1;
  if (blocks > MAX_BLOCKS) {
    rmSync(counter, { force: true });
    say({
      systemMessage: `Stop checks still failing after ${MAX_BLOCKS} attempts; the agent stopped anyway. Failing: ${failures.map((f) => f.split('\n')[0].slice(3)).join(', ')}.`,
    });
    return;
  }
  writeFileSync(counter, String(blocks));
  say({
    decision: 'block',
    reason: [
      `The stop checks failed (attempt ${blocks} of ${MAX_BLOCKS}). Fix the code, not the tests (AGENTS.md hard rule 1), then finish again.`,
      'Formatting: `npx prettier --write <files>` at the repo root.',
      ...failures,
    ].join('\n\n'),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
