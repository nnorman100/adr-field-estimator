import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkShards, testsIn, type Report } from '../../scripts/check-e2e-shards';

type Place = { project: string; file: string; line: number; title: string; group?: string };

// A Playwright JSON report: a suite per file, an optional describe suite inside it, a spec per
// title and a test per project. `results` is empty in a --list report and holds a result per
// attempt in a run report.
function report(places: Place[], results: number, errors: unknown[] = []): Report {
  const files = new Map<string, Place[]>();
  for (const place of places) files.set(place.file, [...(files.get(place.file) ?? []), place]);
  return {
    errors,
    suites: [...files].map(([file, inFile]) => {
      const spec = (p: Place) => ({
        title: p.title,
        file,
        line: p.line,
        column: 1,
        tests: [{ projectName: p.project, results: Array.from({ length: results }, () => ({})) }],
      });
      const plain = inFile.filter((p) => !p.group).map(spec);
      const groups = [...new Set(inFile.flatMap((p) => (p.group ? [p.group] : [])))];
      return {
        title: file,
        specs: plain,
        suites: groups.map((group) => ({
          title: group,
          specs: inFile.filter((p) => p.group === group).map(spec),
        })),
      };
    }),
  };
}

const tests: Place[] = [
  { project: 'chromium', file: 'a.spec.ts', line: 3, title: 'one' },
  { project: 'webkit', file: 'a.spec.ts', line: 3, title: 'one' },
  { project: 'chromium', file: 'a.spec.ts', line: 9, title: 'two', group: 'inner' },
  { project: 'webkit', file: 'a.spec.ts', line: 9, title: 'two', group: 'inner' },
  { project: 'chromium', file: 'b.spec.ts', line: 4, title: 'one' },
  { project: 'webkit', file: 'b.spec.ts', line: 4, title: 'one' },
];
const full = report(tests, 0);
const [shard1, shard2] = [report(tests.slice(0, 3), 1), report(tests.slice(3), 1)];

describe('testsIn', () => {
  it('names each test by project, place and titles, so same-titled tests stay apart', () => {
    const keys = testsIn(full).map((t) => t.key);
    expect(new Set(keys).size).toBe(tests.length);
    expect(keys).toContain('chromium | a.spec.ts:9:1 | a.spec.ts > inner > two');
    expect(keys).toContain('webkit | b.spec.ts:4:1 | b.spec.ts > one');
  });
});

describe('checkShards', () => {
  it('accepts two shards that together run every listed test once', () => {
    expect(checkShards(full, [shard1, shard2], 2)).toEqual([]);
  });

  it('accepts a retried test, which is one test with two results', () => {
    const retried = report(tests.slice(0, 3), 2);
    expect(checkShards(full, [retried, shard2], 2)).toEqual([]);
  });

  it('accepts either order of the reports', () => {
    expect(checkShards(full, [shard2, shard1], 2)).toEqual([]);
  });

  it('fails when a listed test ran in no shard', () => {
    const problems = checkShards(full, [shard1, report(tests.slice(3, 5), 1)], 2);
    expect(problems).toEqual(['ran in no shard: webkit | b.spec.ts:4:1 | b.spec.ts > one']);
  });

  it('fails when a test ran in both shards', () => {
    const problems = checkShards(full, [shard1, report(tests.slice(2), 1)], 2);
    expect(problems).toEqual([
      'ran in shard 1 and shard 2: chromium | a.spec.ts:9:1 | a.spec.ts > inner > two',
    ]);
  });

  it('fails when one shard ran a test twice', () => {
    const doubled = report([...tests.slice(3), ...tests.slice(3, 4)], 1);
    const problems = checkShards(full, [shard1, doubled], 2);
    expect(problems).toEqual([
      'shard 2 ran twice: webkit | a.spec.ts:9:1 | a.spec.ts > inner > two',
    ]);
  });

  it('fails when a shard has a listed test but no result for it', () => {
    const problems = checkShards(full, [shard1, report(tests.slice(3), 0)], 2);
    expect(problems).toHaveLength(3);
    expect(problems.every((p) => p.startsWith('shard 2 has no result for: '))).toBe(true);
  });

  it('fails when a shard ran a test the full list does not hold', () => {
    const extra = report([...tests.slice(3), { project: 'webkit', file: 'c.spec.ts', line: 1, title: 'new' }], 1);
    expect(checkShards(full, [shard1, extra], 2)).toEqual([
      'shard 2 ran a test that is not listed: webkit | c.spec.ts:1:1 | c.spec.ts > new',
    ]);
  });

  it('fails when a shard report is missing or extra', () => {
    expect(checkShards(full, [shard1], 2)).toContain('expected 2 shard reports, found 1');
    expect(checkShards(full, [shard1, shard2, shard2], 2)[0]).toBe(
      'expected 2 shard reports, found 3',
    );
  });

  it('fails when a report carries errors', () => {
    expect(checkShards(full, [report(tests.slice(0, 3), 1, [{ message: 'x' }]), shard2], 2)).toEqual([
      'shard 1 reported errors',
    ]);
    expect(checkShards(report(tests, 0, [{}]), [shard1, shard2], 2)).toEqual([
      'the full list reported errors',
    ]);
  });

  it('fails on an empty list, which would pass every run vacuously', () => {
    expect(checkShards({ suites: [] }, [{ suites: [] }, { suites: [] }], 2)).toEqual([
      'the full list holds no tests',
    ]);
  });
});

describe('check-e2e-shards.ts', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function run(reports: Report[], args: string[] = ['--shards', '2']) {
    const dir = mkdtempSync(path.join(tmpdir(), 'e2e-shards-'));
    dirs.push(dir);
    const files = reports.map((r, i) => {
      const file = path.join(dir, `r${i}.json`);
      writeFileSync(file, JSON.stringify(r));
      return file;
    });
    const [list = '', ...shards] = files;
    return spawnSync('node', ['scripts/check-e2e-shards.ts', '--list', list, ...args, ...shards], {
      encoding: 'utf8',
    });
  }

  it('exits 0 and says so when every test ran once', () => {
    const result = run([full, shard1, shard2]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('6 tests ran exactly once across 2 shards.');
  });

  it('exits 1 with an error line per problem when a test is missing', () => {
    const result = run([full, shard1, report(tests.slice(3, 5), 1)]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('::error::ran in no shard: webkit | b.spec.ts:4:1');
  });

  it('exits 2 with a usage line when the shard count is missing', () => {
    const result = run([full, shard1, shard2], []);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage:');
  });
});
