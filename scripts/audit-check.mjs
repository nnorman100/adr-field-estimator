#!/usr/bin/env node
// Dependency audit for the required `audit` check in .github/workflows/ci.yml. It runs
// `npm audit --json` for each lockfile in AUDITED (the repository root and web/, the app that
// ships) and fails on any high or critical advisory, like `npm audit --audit-level=high`,
// except the advisories listed in .github/audit-exceptions.json. A package whose high finding comes
// only from a listed advisory (through its dependency chain) is skipped too. Every skipped advisory
// and package is printed, so nothing is hidden. Each exception carries a re-check date; after that
// date (UTC) the check fails until the owner re-checks and updates the file. The exceptions file sits
// under .github/, so the Test guard asks for the owner's approval before it can change.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EXCEPTIONS_FILE = path.join(ROOT, '.github', 'audit-exceptions.json');
/** The directories audited, relative to the repository root; each holds a package-lock.json. */
export const AUDITED = ['.', 'web'];

const BLOCKING = new Set(['high', 'critical']);
const GHSA = /^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Parses and checks the exceptions file; throws on anything malformed. */
export function parseExceptions(text) {
  const data = JSON.parse(text);
  if (!data || !Array.isArray(data.exceptions)) throw new Error('expected an "exceptions" list');
  return data.exceptions.map((e, i) => {
    const where = `exception ${i + 1}`;
    if (!e || typeof e !== 'object') throw new Error(`${where} is not an object`);
    if (typeof e.id !== 'string' || !GHSA.test(e.id)) throw new Error(`${where}: bad id`);
    if (typeof e.reason !== 'string' || !e.reason.trim()) throw new Error(`${where}: no reason`);
    for (const key of ['approved', 'recheckBy']) {
      if (typeof e[key] !== 'string' || !DATE.test(e[key])) {
        throw new Error(`${where}: ${key} must be a YYYY-MM-DD date`);
      }
    }
    return { id: e.id, reason: e.reason, approved: e.approved, recheckBy: e.recheckBy };
  });
}

const advisoryId = (advisory) => {
  const match = /\/(GHSA-[0-9a-z-]+)$/.exec(String(advisory.url ?? ''));
  return match ? match[1] : `npm advisory ${advisory.source ?? '(no id)'}`;
};

/**
 * Decides the check from an `npm audit --json` report.
 * @param report the parsed report
 * @param exceptions the parsed exceptions list
 * @param today the current UTC date as YYYY-MM-DD
 * @param label put before each package line, naming the audited directory (empty for one report)
 * @returns { problems: string[], skipped: string[] }; the check passes when problems is empty
 */
export function checkAudit(report, exceptions, today, label = '') {
  const problems = [];
  const skipped = [];

  for (const e of exceptions) {
    if (today > e.recheckBy) {
      problems.push(
        `Exception for ${e.id} expired on ${e.recheckBy}: re-check the advisory and update ` +
          '.github/audit-exceptions.json (owner approval needed).',
      );
    }
  }
  const active = new Map(exceptions.filter((e) => today <= e.recheckBy).map((e) => [e.id, e]));

  const vulns = report?.vulnerabilities;
  if (report?.error || !vulns || typeof vulns !== 'object') {
    problems.push(
      `${label}npm audit did not return a report: ${JSON.stringify(report?.error ?? report)}`,
    );
    return { problems, skipped };
  }

  // The advisories a package's finding comes from: its own, plus those of the packages it lists
  // by name in `via`, followed down the chain.
  const rootAdvisories = (name, seen = new Set()) => {
    if (seen.has(name)) return [];
    seen.add(name);
    const found = [];
    for (const via of vulns[name]?.via ?? []) {
      if (typeof via === 'string') found.push(...rootAdvisories(via, seen));
      else if (via && typeof via === 'object') found.push(via);
    }
    return found;
  };

  const skippedIds = new Set();
  for (const [name, vuln] of Object.entries(vulns)) {
    if (!BLOCKING.has(vuln?.severity)) continue;
    const roots = rootAdvisories(name).filter((a) => BLOCKING.has(a.severity));
    if (roots.length === 0) {
      problems.push(`${label}${name} (${vuln.severity}): could not trace the advisory behind it.`);
      continue;
    }
    const blocking = roots.filter((a) => !active.has(advisoryId(a)));
    for (const a of blocking) {
      problems.push(
        `${label}${name} (${vuln.severity}): ${advisoryId(a)} ${a.severity}: ${a.title}`,
      );
    }
    if (blocking.length === 0) {
      const ids = [...new Set(roots.map(advisoryId))];
      skipped.push(`${label}${name} (${vuln.severity}): comes only from ${ids.join(', ')}`);
      for (const id of ids) skippedIds.add(id);
    }
  }
  for (const id of skippedIds) {
    const e = active.get(id);
    skipped.unshift(
      `${id}: ${e.reason} (owner approved ${e.approved}; re-check by ${e.recheckBy})`,
    );
  }
  return { problems: [...new Set(problems)], skipped };
}

/**
 * Decides the check from one `npm audit --json` report per audited directory. Package lines name
 * their directory; an expired exception is reported once.
 * @param reports [{ dir, report }], dir as in AUDITED
 */
export function checkReports(reports, exceptions, today) {
  const problems = new Set();
  const notes = new Set();
  const packages = [];
  for (const { dir, report } of reports) {
    const result = checkAudit(report, exceptions, today, dir === '.' ? '[root] ' : `[${dir}/] `);
    for (const line of result.problems) problems.add(line);
    // Package lines start with the directory label; the rest name an approved exception.
    for (const line of result.skipped) {
      if (line.startsWith('[')) packages.push(line);
      else notes.add(line);
    }
  }
  return { problems: [...problems], skipped: [...notes, ...packages] };
}

function main() {
  const exceptions = parseExceptions(readFileSync(EXCEPTIONS_FILE, 'utf8'));
  const reports = [];
  for (const dir of AUDITED) {
    const where = dir === '.' ? 'the root' : `${dir}/`;
    const run = spawnSync('npm', ['audit', '--json'], {
      cwd: path.join(ROOT, dir),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    let report;
    try {
      report = JSON.parse(run.stdout);
    } catch {
      console.error(`npm audit in ${where} gave no JSON (exit ${run.status}):\n${run.stderr}`);
      return 1;
    }
    const counts = report?.metadata?.vulnerabilities;
    if (counts) console.log(`npm audit in ${where} found: ${JSON.stringify(counts)}`);
    reports.push({ dir, report });
  }
  const today = new Date().toISOString().slice(0, 10);
  const { problems, skipped } = checkReports(reports, exceptions, today);
  for (const line of skipped) console.log(`Skipped (approved exception): ${line}`);
  for (const line of problems) console.error(`::error title=npm audit::${line}`);
  console.log(
    problems.length
      ? `audit: ${problems.length} problem(s); failing.`
      : 'audit: no high or critical advisories outside the approved exceptions.',
  );
  return problems.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main());
