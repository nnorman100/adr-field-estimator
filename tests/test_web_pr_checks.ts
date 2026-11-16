// Risky pull requests still run the suite that covers them before merge: database and migration
// changes get the database tests (web-pr-database.yml), screen changes get the browser tests
// (web-pr-e2e.yml). Each job's steps must stay identical to the Web app job it copies, so the two
// never drift. Not required checks: a pull request that touches neither area starts neither.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { load, WEB, WORKFLOWS, type Data } from './workflow_support.ts';

const web = (): Data => load(WEB);

const CASES: [string, string, string, string[]][] = [
  [
    'web-pr-database.yml',
    'pr-database',
    'database',
    ['web/src/db/**', 'web/migrations/**', 'web/tests/db/**', 'web/vitest.db.config.ts'],
  ],
  [
    'web-pr-e2e.yml',
    'pr-e2e',
    'e2e',
    [
      'web/src/app/**',
      'web/src/components/**',
      'web/sw/**',
      'web/public/**',
      'web/tests/e2e/**',
      'web/playwright.config.ts',
    ],
  ],
];

describe.each(CASES)('%s', (file, name, source, paths) => {
  const wf = (): Data => load(path.join(WORKFLOWS, file));

  it('starts only for pull requests that touch its files', () => {
    expect(Object.keys(wf().on)).toEqual(['pull_request']);
    expect(wf().on.pull_request.paths).toEqual([...paths, `.github/workflows/${file}`]);
  });

  it('has one job with a check name of its own, so it never stands in for a Web app check', () => {
    expect(Object.keys(wf().jobs)).toEqual([name]);
    expect(wf().permissions).toEqual({ contents: 'read' });
    expect(wf().defaults).toEqual(web().defaults);
  });

  it(`copies the Web app ${source} job exactly, without its after-merge condition`, () => {
    const job = wf().jobs[name];
    expect(job).not.toHaveProperty('if');
    for (const key of ['steps', 'env', 'strategy', 'timeout-minutes', 'runs-on']) {
      expect(job[key], key).toEqual(web().jobs[source][key]);
    }
  });
});

describe('web.yml concurrency', () => {
  it('cancels superseded pull request runs but lets a master run finish', () => {
    // On master a new merge waits behind the running full suite (and replaces any waiting one), so
    // fast merges cannot cancel every run and leave no green commit to release.
    expect(web().concurrency).toEqual({
      group: 'web-${{ github.ref }}',
      'cancel-in-progress': "${{ github.event_name == 'pull_request' }}",
    });
  });
});
