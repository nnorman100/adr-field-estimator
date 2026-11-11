// The 1,000-line single-file limit (Technology Standard 2.2), for every code, test, style and
// Markdown file in the repository, web/ included. Lockfiles, vendored and generated files are not
// counted. Run by `npm run lint` in the required `node` CI job; tests/test_file_length_limit.ts
// covers it in the same job's vitest run.
//
// The files already over the limit are listed with their exact line count in
// scripts/file_length_baselines.json, the one list of exceptions. A listed file only warns; it
// fails when it grows past its count, when it shrinks without its count being lowered to match,
// and once it is back under the limit (remove it then). Every file not on the list fails over the
// limit. scripts/file_length_allowlist.json repeats the list's names for the legacy Python check
// and the ESLint config until S8 removes them, and must name exactly the same files.
//
// Lines are counted like ESLint's max-lines: blank lines and comments count, a final newline
// does not.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LIMIT = 1000;
export const BASELINES = 'scripts/file_length_baselines.json';
export const ALLOWLIST = 'scripts/file_length_allowlist.json';

// Code, test, style and Markdown files, by suffix.
const COUNTED_SUFFIXES = [
  '.py',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.css',
  '.md',
  '.html',
  '.sh',
  '.sql',
  '.tf',
  '.tfvars',
  '.hcl',
  '.rules',
  '.toml',
  '.yml',
  '.yaml',
];
const COUNTED_NAMES = ['Dockerfile'];
// The rebuild's config JSON is hand-written code too (its lockfile is excluded below).
const WEB_PREFIX = 'web/';
const WEB_CONFIG_FILES = ['web/env.example'];
const EXCLUDED_PREFIXES = [
  'public/vendor/',
  'node_modules/',
  'web/node_modules/',
  'web/.next/',
  'web/package-lock.json',
];
const EXCLUDED_SUFFIXES = ['.lock.hcl']; // Terraform's provider lockfiles

const LINE_BREAK = /\r\n|[\r\n\u2028\u2029]/;

export function countLines(text: string): number {
  if (!text) return 0;
  const lines = text.split(LINE_BREAK);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

export function isCounted(name: string): boolean {
  if (EXCLUDED_PREFIXES.some((prefix) => name.startsWith(prefix))) return false;
  if (EXCLUDED_SUFFIXES.some((suffix) => name.endsWith(suffix))) return false;
  if (COUNTED_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
  if (COUNTED_NAMES.includes(path.posix.basename(name))) return true;
  return name.startsWith(WEB_PREFIX) && (name.endsWith('.json') || WEB_CONFIG_FILES.includes(name));
}

function walk(root: string, dir = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const name = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (name !== '.git') found.push(...walk(root, name));
    } else if (entry.isFile()) {
      found.push(name);
    }
  }
  return found;
}

/** Tracked and untracked-but-not-ignored files; every file under root outside a git checkout. */
export function countedFiles(root: string): string[] {
  let names: string[];
  try {
    const out = execFileSync(
      'git',
      ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 },
    );
    names = out.split('\0').filter(Boolean);
  } catch {
    names = walk(root);
  }
  return [...new Set(names)]
    .filter((name) => isCounted(name) && isFile(path.join(root, name)))
    .sort();
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

export type Baselines = Record<string, number>;
export type Allowlist = { limit: number; files: string[] };
export type Result = { errors: string[]; warnings: string[] };

export function readJson<T>(root: string, name: string): T {
  return JSON.parse(readFileSync(path.join(root, name), 'utf8')) as T;
}

/**
 * Check every counted file under root. `allowlist` is the legacy mirror of the baseline names;
 * pass null to skip comparing it (temporary test trees have none).
 */
export function check({
  root = ROOT,
  limit = LIMIT,
  baselines = readJson<Baselines>(ROOT, BASELINES),
  allowlist = readJson<Allowlist>(ROOT, ALLOWLIST) as Allowlist | null,
}: {
  root?: string;
  limit?: number;
  baselines?: Baselines;
  allowlist?: Allowlist | null;
} = {}): Result {
  const errors: string[] = [];
  const warnings: string[] = [];
  const counts = new Map<string, number>();
  for (const name of countedFiles(root)) {
    counts.set(name, countLines(readFileSync(path.join(root, name), 'utf8')));
  }
  for (const [name, ceiling] of Object.entries(baselines)) {
    if (!Number.isInteger(ceiling) || ceiling <= limit) {
      errors.push(
        `${name}: its ceiling in ${BASELINES} must be a whole number over the ${limit}-line limit.`,
      );
    }
    if (!counts.has(name)) {
      errors.push(`${name} is listed in ${BASELINES} but is not a counted file; remove it.`);
    }
  }
  for (const [name, lines] of counts) {
    if (!Object.hasOwn(baselines, name)) {
      if (lines > limit) {
        errors.push(
          `${name} has ${lines} lines, over the ${limit}-line limit. Split it; new files cannot ` +
            `be added to ${BASELINES}.`,
        );
      }
      continue;
    }
    const ceiling = baselines[name];
    if (lines > ceiling) {
      errors.push(`${name} has ${lines} lines, exceeding its ${ceiling}-line baseline.`);
    } else if (lines <= limit) {
      errors.push(
        `${name} is down to ${lines} lines (limit ${limit}); remove it from ${BASELINES} and ` +
          `${ALLOWLIST} so the limit is enforced.`,
      );
    } else if (lines < ceiling) {
      errors.push(
        `${name} has shrunk to ${lines} lines; lower its ceiling in ${BASELINES} from ` +
          `${ceiling} to ${lines}.`,
      );
    } else {
      warnings.push(`${name} has ${lines} lines (limit ${limit}); split it during planned work.`);
    }
  }
  if (allowlist) {
    const listed = [...allowlist.files].sort();
    const baselined = Object.keys(baselines).sort();
    if (allowlist.limit !== limit || JSON.stringify(listed) !== JSON.stringify(baselined)) {
      errors.push(
        `${ALLOWLIST} must have limit ${limit} and name exactly the files in ${BASELINES}.`,
      );
    }
  }
  return { errors, warnings };
}

function main(): number {
  const { errors, warnings } = check();
  for (const message of warnings) console.log(`::warning title=File length::${message}`);
  for (const message of errors) console.log(`::error title=File length::${message}`);
  console.log(
    `file length: ${errors.length} error(s), ${warnings.length} listed file(s) over the limit`,
  );
  return errors.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
