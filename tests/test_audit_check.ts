// The required `audit` CI job runs scripts/audit-check.mjs: it fails on any high or critical npm
// advisory except the owner-approved exceptions in .github/audit-exceptions.json, until each
// exception's re-check date. The fixtures in tests/fixtures/npm-audit/ are `npm audit --json`
// reports; picomatch-only.json is a real one from 2026-11-18, the others are edited copies of it.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkAudit, EXCEPTIONS_FILE, parseExceptions } from '../scripts/audit-check.mjs';
import { ROOT } from './workflow_support.ts';

const report = (name: string) =>
  JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/npm-audit', `${name}.json`), 'utf8'));
const exceptions = () => parseExceptions(readFileSync(EXCEPTIONS_FILE, 'utf8'));
const BEFORE_RECHECK = '2026-11-18';

describe('audit-check', () => {
  it('lists only the picomatch advisory, approved 2026-11-18, re-check by 2026-12-18', () => {
    expect(exceptions()).toEqual([
      expect.objectContaining({
        id: 'GHSA-fc5q-39xc-vjpf',
        approved: '2026-11-18',
        recheckBy: '2026-12-18',
      }),
    ]);
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
