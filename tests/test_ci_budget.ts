// Pull-request jobs have time budgets (scripts/report-ci-budget.mjs, ci-budget.yml, run daily):
// a job that runs over its budget opens an issue for an agent to make it fast again. Queue time is
// not counted, only the job's own run time.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUDGET_MINUTES,
  budgetFor,
  issueTitle,
  overBudget,
  summarize,
  WATCHED,
} from '../scripts/report-ci-budget.mjs';
import { load, WEB, WORKFLOWS, type Data } from './workflow_support.ts';

const job = (name: string, minutes: number, conclusion = 'success') => ({
  name,
  conclusion,
  started_at: '2026-11-16T10:00:00Z',
  completed_at: new Date(Date.parse('2026-11-16T10:00:00Z') + minutes * 60_000).toISOString(),
  html_url: `https://example.test/${name}`,
});

describe('budgets', () => {
  it('holds the fast pull-request checks to five minutes or less', () => {
    for (const name of ['node', 'audit', 'test-guard', 'company-isolation', 'check']) {
      expect(BUDGET_MINUTES[name], name).toBeLessThanOrEqual(5);
    }
  });

  it('covers every job a pull request starts in CI, Test guard and Web app', () => {
    const web = load(WEB).jobs as Record<string, Data>;
    const prJobs = Object.keys(web).filter((n) => web[n].if === undefined);
    for (const name of [...prJobs, 'node', 'audit', 'test-guard', 'pr-database', 'pr-e2e']) {
      expect(budgetFor(name), name).toBeGreaterThan(0);
    }
  });

  it('reads a matrix job by its base name', () => {
    expect(budgetFor('pr-e2e (2)')).toBe(BUDGET_MINUTES['pr-e2e']);
  });
});

describe('overBudget', () => {
  it('reports only finished jobs that ran longer than their budget', () => {
    const over = overBudget([
      job('check', 7),
      job('node', 1),
      job('company-isolation', 9, 'failure'),
      job('pr-e2e (1)', 30, 'cancelled'),
      job('unknown-job', 99),
    ]);
    expect(over.map((o: { name: string }) => o.name)).toEqual(['check', 'company-isolation']);
    expect(over[0].minutes).toBeCloseTo(7);
    expect(over[0].budget).toBe(BUDGET_MINUTES.check);
  });

  it('keeps one issue per job, named by its base name', () => {
    expect(issueTitle('pr-e2e (2)')).toBe('CI budget exceeded: pr-e2e');
  });

  it('sums a day of overruns into one entry per job, with the slowest run', () => {
    const summary = summarize(
      overBudget([job('pr-e2e (1)', 22), job('pr-e2e (2)', 25), job('check', 6), job('check', 8)]),
    );
    expect(summary.map((s: { title: string; count: number }) => [s.title, s.count])).toEqual([
      ['CI budget exceeded: pr-e2e', 2],
      ['CI budget exceeded: check', 2],
    ]);
    expect(summary[0].minutes).toBeCloseTo(25);
    expect(summary[0].url).toBe('https://example.test/pr-e2e (2)');
  });
});

describe('ci-budget.yml', () => {
  const wf = (): Data => load(path.join(WORKFLOWS, 'ci-budget.yml'));

  it('runs once a day (and by hand), not after every run, to spare the two-place pool', () => {
    expect(Object.keys(wf().on).sort()).toEqual(['schedule', 'workflow_dispatch']);
    expect(wf().on.schedule).toHaveLength(1);
  });

  it('watches every pull-request workflow', () => {
    const names = ['ci.yml', 'test-guard.yml', 'web.yml', 'web-pr-database.yml', 'web-pr-e2e.yml'];
    expect(WATCHED).toEqual(names.map((f) => load(path.join(WORKFLOWS, f)).name));
  });

  it('can read run timings and write issues, nothing else', () => {
    expect(wf().permissions).toEqual({ contents: 'read', actions: 'read', issues: 'write' });
  });
});
