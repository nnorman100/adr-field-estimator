// Checks that the Playwright shards of the Web app workflow's e2e job ran every browser test exactly
// once. Each shard writes a JSON report (PLAYWRIGHT_JSON_OUTPUT_NAME); the final `e2e` job lists the
// full set with `playwright test --list --reporter=json` and runs:
//
//   node scripts/check-e2e-shards.ts --list list.json --shards 2 shard-1.json shard-2.json
//
// It fails when a listed test is in no shard report or has no result there, when a test appears more
// than once (in one report or in two), when a report holds a test the list does not, when a report
// carries errors, or when the number of reports is not the shard count. A test that Playwright retried
// is one test with two results, not a test that ran twice.
// Plain Node with type stripping; no installed packages.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

type Test = { projectName?: string; results?: unknown[] };
type Spec = { title?: string; file?: string; line?: number; column?: number; tests?: Test[] };
type Suite = { title?: string; specs?: Spec[]; suites?: Suite[] };
export type Report = { suites?: Suite[]; errors?: unknown[] };

// One entry per test, in the report's order: the key names the project, the spec's file, line and
// column, and the titles above it, so two tests that share a title in different places stay apart.
export function testsIn(report: Report): { key: string; ran: boolean }[] {
  const found: { key: string; ran: boolean }[] = [];
  const walk = (suite: Suite, titles: string[]): void => {
    const here = suite.title ? [...titles, suite.title] : titles;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const place = `${spec.file}:${spec.line}:${spec.column}`;
        const name = [...here, spec.title].join(' > ');
        found.push({
          key: `${test.projectName} | ${place} | ${name}`,
          ran: (test.results ?? []).length > 0,
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, here);
  };
  for (const suite of report.suites ?? []) walk(suite, []);
  return found;
}

// Returns one line per problem; an empty list means every listed test ran exactly once.
export function checkShards(list: Report, shards: Report[], expectedShards: number): string[] {
  const problems: string[] = [];
  if (shards.length !== expectedShards) {
    problems.push(`expected ${expectedShards} shard reports, found ${shards.length}`);
  }
  const listed = new Map<string, number>();
  for (const { key } of testsIn(list)) listed.set(key, (listed.get(key) ?? 0) + 1);
  if (listed.size === 0) problems.push('the full list holds no tests');
  for (const [key, count] of listed) {
    if (count > 1) problems.push(`listed ${count} times: ${key}`);
  }
  if ((list.errors ?? []).length > 0) problems.push('the full list reported errors');

  const seen = new Map<string, number>();
  shards.forEach((report, index) => {
    const shard = index + 1;
    if ((report.errors ?? []).length > 0) problems.push(`shard ${shard} reported errors`);
    for (const { key, ran } of testsIn(report)) {
      if (!listed.has(key)) problems.push(`shard ${shard} ran a test that is not listed: ${key}`);
      if (!ran) problems.push(`shard ${shard} has no result for: ${key}`);
      const before = seen.get(key);
      if (before === undefined) seen.set(key, shard);
      else if (before === shard) problems.push(`shard ${shard} ran twice: ${key}`);
      else problems.push(`ran in shard ${before} and shard ${shard}: ${key}`);
    }
  });
  for (const key of listed.keys()) {
    if (!seen.has(key)) problems.push(`ran in no shard: ${key}`);
  }
  return problems;
}

function readReport(file: string): Report {
  return JSON.parse(readFileSync(file, 'utf8')) as Report;
}

function main(argv: string[]): number {
  let listFile: string | undefined;
  let expected: number | undefined;
  const files: string[] = [];
  const args = [...argv];
  for (let arg = args.shift(); arg !== undefined; arg = args.shift()) {
    if (arg === '--list') listFile = args.shift();
    else if (arg === '--shards') expected = Number(args.shift());
    else files.push(arg);
  }
  if (!listFile || !expected || !Number.isInteger(expected) || expected < 1) {
    console.error('usage: check-e2e-shards.ts --list <list.json> --shards <count> <shard report>...');
    return 2;
  }
  const list = readReport(listFile);
  const problems = checkShards(list, files.map(readReport), expected);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`::error::${problem}`);
    return 1;
  }
  console.log(`${testsIn(list).length} tests ran exactly once across ${expected} shards.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
