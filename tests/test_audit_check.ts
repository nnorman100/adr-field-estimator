// The required `audit` CI job runs scripts/audit-check.mjs: it fails on any high or critical npm
// advisory except the owner-approved exceptions in .github/audit-exceptions.json, until each
// exception's re-check date. The fixtures in tests/fixtures/npm-audit/ are `npm audit --json`
// reports; picomatch-only.json is a real one from 2026-11-18, the others are edited copies of it.
// web-grpc-js.json is a real web/ report from 2026-11-19 (firebase -> @firebase/firestore ->
// @grpc/grpc-js 1.9.16).
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkAudit,
  checkReports,
  EXCEPTIONS_FILE,
  parseExceptions,
} from '../scripts/audit-check.mjs';
import { ROOT } from './workflow_support.ts';

const report = (name: string) =>
  JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/npm-audit', `${name}.json`), 'utf8'));
const exceptions = () => parseExceptions(readFileSync(EXCEPTIONS_FILE, 'utf8'));
const BEFORE_RECHECK = '2026-11-18';

describe('audit-check', () => {
  it('lists only the picomatch and the two grpc-js advisories, each with its re-check date', () => {
    expect(exceptions()).toEqual([
      expect.objectContaining({
        id: 'GHSA-fc5q-39xc-vjpf',
        approved: '2026-11-18',
        recheckBy: '2026-12-18',
      }),
      expect.objectContaining({
        id: 'GHSA-m9gg-hp2v-232j',
        approved: '2026-11-19',
        recheckBy: '2026-12-19',
      }),
      expect.objectContaining({
        id: 'GHSA-f596-whhp-79r4',
        approved: '2026-11-19',
        recheckBy: '2026-12-19',
      }),
    ]);
  });

  it('runs npm audit in web/ as well as the root and fails on a finding only web/ has', () => {
    // A stand-in `npm` on PATH answers with other-high.json only when run from web/.
    const bin = mkdtempSync(path.join(tmpdir(), 'audit-npm-'));
    try {
      const stub = path.join(bin, 'npm');
      writeFileSync(
        stub,
        [
          '#!/usr/bin/env node',
          "const fs = require('node:fs');",
          'const web = process.cwd() === process.env.STUB_WEB_DIR;',
          'process.stdout.write(fs.readFileSync(web ? process.env.STUB_WEB : process.env.STUB_ROOT));',
          'process.exit(1);',
        ].join('\n'),
      );
      chmodSync(stub, 0o755);
      const fixtures = path.join(ROOT, 'tests/fixtures/npm-audit');
      const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts/audit-check.mjs')], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          STUB_WEB_DIR: path.join(ROOT, 'web'),
          STUB_WEB: path.join(fixtures, 'other-high.json'),
          STUB_ROOT: path.join(fixtures, 'moderate-only.json'),
        },
      });
      expect(run.status).toBe(1);
      expect(run.stdout).toContain('npm audit in the root found');
      expect(run.stdout).toContain('npm audit in web/ found');
      expect(run.stderr).toContain(
        '[web/] example-lib (high): GHSA-0000-0000-0001 high: example-lib test advisory (fixture)',
      );
      expect(run.stderr).not.toContain('[root] example-lib');
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('applies each waiver only to the directory it names', () => {
    // The grpc-js waiver covers web/ only, and the picomatch waiver the root only.
    const grpc = checkReports(
      [{ dir: '.', report: report('web-grpc-js') }],
      exceptions(),
      BEFORE_RECHECK,
    );
    expect(grpc.problems.some((p) => p.startsWith('[root] @grpc/grpc-js (high): GHSA-m9gg'))).toBe(
      true,
    );
    const picomatch = checkReports(
      [{ dir: 'web', report: report('picomatch-only') }],
      exceptions(),
      BEFORE_RECHECK,
    );
    expect(picomatch.problems).toContain(
      '[web/] picomatch (high): GHSA-fc5q-39xc-vjpf high: picomatch vulnerable to ReDoS through single-branch repeated extglobs',
    );
  });

  it('fails the grpc-js advisory once a copy outside the reviewed Firestore one is affected', () => {
    const web = report('web-grpc-js');
    web.vulnerabilities['@grpc/grpc-js'].nodes.push('node_modules/@grpc/grpc-js');
    const { problems } = checkReports([{ dir: 'web', report: web }], exceptions(), BEFORE_RECHECK);
    expect(problems).toContain(
      '[web/] @grpc/grpc-js (high): GHSA-m9gg-hp2v-232j high: @grpc/grpc-js: In certain configurations, getAuthContext can return unauthorized certificates as though they were authorized',
    );
    expect(problems.some((p) => p.startsWith('[web/] firebase (high): GHSA-m9gg'))).toBe(true);
  });

  it('rejects a waiver scoped to an unknown directory or a bad package location', () => {
    const one = (extra: object) =>
      JSON.stringify({
        exceptions: [
          {
            id: 'GHSA-m9gg-hp2v-232j',
            reason: 'test',
            approved: '2026-11-19',
            recheckBy: '2026-12-19',
            ...extra,
          },
        ],
      });
    expect(() => parseExceptions(one({ projects: ['backend'] }))).toThrow(/projects/);
    expect(() => parseExceptions(one({ projects: [] }))).toThrow(/projects/);
    expect(() => parseExceptions(one({ nodes: ['@grpc/grpc-js'] }))).toThrow(/nodes/);
    expect(parseExceptions(one({ projects: ['web'], nodes: ['node_modules/x'] }))[0]).toEqual(
      expect.objectContaining({ projects: ['web'], nodes: ['node_modules/x'] }),
    );
  });

  it('passes the web/ grpc-js report alongside the root report and names its packages', () => {
    const { problems, skipped } = checkReports(
      [
        { dir: '.', report: report('picomatch-only') },
        { dir: 'web', report: report('web-grpc-js') },
      ],
      exceptions(),
      BEFORE_RECHECK,
    );
    expect(problems).toEqual([]);
    expect(skipped[0]).toMatch(/^GHSA-fc5q-39xc-vjpf: /);
    expect(skipped[1]).toMatch(/^GHSA-m9gg-hp2v-232j: .*re-check by 2026-12-19/);
    expect(skipped).toContain('[root] picomatch (high): comes only from GHSA-fc5q-39xc-vjpf');
    for (const pkg of [
      '@grpc/grpc-js',
      '@firebase/firestore',
      '@firebase/firestore-compat',
      'firebase',
    ]) {
      expect(skipped).toContain(`[web/] ${pkg} (high): comes only from GHSA-m9gg-hp2v-232j`);
    }
  });

  it('fails the web/ grpc-js report without its exception', () => {
    const others = exceptions().filter((e) => e.id !== 'GHSA-m9gg-hp2v-232j');
    const { problems } = checkReports(
      [{ dir: 'web', report: report('web-grpc-js') }],
      others,
      BEFORE_RECHECK,
    );
    expect(problems).toContain(
      '[web/] @grpc/grpc-js (high): GHSA-m9gg-hp2v-232j high: @grpc/grpc-js: In certain configurations, getAuthContext can return unauthorized certificates as though they were authorized',
    );
    expect(problems.some((p) => p.startsWith('[web/] firebase (high): GHSA-m9gg-hp2v-232j'))).toBe(
      true,
    );
  });

  it('fails the web/ report once the grpc-js exceptions pass 2026-12-19, naming each expiry once', () => {
    const reports = [
      { dir: '.', report: report('moderate-only') },
      { dir: 'web', report: report('web-grpc-js') },
    ];
    // On its re-check date the grpc-js exception still holds; only picomatch's has run out.
    expect(checkReports(reports, exceptions(), '2026-12-19').problems).toEqual([
      expect.stringMatching(/^Exception for GHSA-fc5q-39xc-vjpf expired on 2026-12-18/),
    ]);
    const { problems } = checkReports(reports, exceptions(), '2026-12-20');
    for (const id of ['GHSA-m9gg-hp2v-232j', 'GHSA-f596-whhp-79r4']) {
      expect(
        problems.filter((p) => p.startsWith(`Exception for ${id} expired on 2026-12-19`)),
      ).toHaveLength(1);
    }
    expect(
      problems.some((p) => p.startsWith('[web/] @grpc/grpc-js (high): GHSA-m9gg-hp2v-232j')),
    ).toBe(true);
  });

  it('passes the picomatch-only report and names every skipped advisory and package', () => {
    const { problems, skipped } = checkAudit(
      report('picomatch-only'),
      exceptions(),
      BEFORE_RECHECK,
    );
    expect(problems).toEqual([]);
    expect(skipped[0]).toMatch(/^GHSA-fc5q-39xc-vjpf: .*re-check by 2026-12-18/);
    for (const pkg of ['picomatch', 'fdir', 'tinyglobby', 'vite', 'vitest']) {
      expect(skipped).toContain(`${pkg} (high): comes only from GHSA-fc5q-39xc-vjpf`);
    }
  });

  it('fails any other high advisory', () => {
    const { problems } = checkAudit(report('other-high'), exceptions(), BEFORE_RECHECK);
    expect(problems).toEqual([
      'example-lib (high): GHSA-0000-0000-0001 high: example-lib test advisory (fixture)',
    ]);
  });

  it('fails picomatch plus another high advisory', () => {
    const { problems } = checkAudit(
      report('picomatch-plus-other-high'),
      exceptions(),
      BEFORE_RECHECK,
    );
    expect(problems).toContain(
      'vite (high): GHSA-0000-0000-0002 high: vite test advisory (fixture)',
    );
    // vitest reaches the new advisory through vite.
    expect(problems.some((p) => p.startsWith('vitest (high): GHSA-0000-0000-0002'))).toBe(true);
  });

  it('fails once the exception passes its re-check date', () => {
    expect(checkAudit(report('picomatch-only'), exceptions(), '2026-12-18').problems).toEqual([]);
    const { problems } = checkAudit(report('picomatch-only'), exceptions(), '2026-12-19');
    expect(problems[0]).toMatch(/^Exception for GHSA-fc5q-39xc-vjpf expired on 2026-12-18/);
    expect(problems).toContain(
      'picomatch (high): GHSA-fc5q-39xc-vjpf high: picomatch vulnerable to ReDoS through single-branch repeated extglobs',
    );
  });

  it('passes a moderate-only report', () => {
    expect(checkAudit(report('moderate-only'), exceptions(), BEFORE_RECHECK)).toEqual({
      problems: [],
      skipped: [],
    });
  });

  it('fails when npm audit returns an error instead of a report', () => {
    const { problems } = checkAudit({ error: { code: 'ENOAUDIT' } }, exceptions(), BEFORE_RECHECK);
    expect(problems).toHaveLength(1);
  });
});
