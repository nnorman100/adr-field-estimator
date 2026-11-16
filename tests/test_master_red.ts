// A red master is never silent (.github/workflows/master-red.yml, scripts/report-master-red.mjs).
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decide, failureText, greenText, issueTitle } from '../scripts/report-master-red.mjs';
import { load, WORKFLOWS, type Data } from './workflow_support.ts';

const master = (conclusion: string) => ({ conclusion, event: 'push', branch: 'master' });

describe('what a finished run does to the master-red issue', () => {
  it('opens or updates it when a master run fails or times out', () => {
    expect(decide(master('failure'))).toBe('open');
    expect(decide(master('timed_out'))).toBe('open');
  });

  it('ignores passed, cancelled and skipped runs; the fixing pull request closes the issue', () => {
    expect(decide(master('success'))).toBe('skip');
    expect(decide(master('cancelled'))).toBe('skip');
    expect(decide(master('skipped'))).toBe('skip');
  });

  it('ignores pull requests and other branches', () => {
    expect(decide({ conclusion: 'failure', event: 'pull_request', branch: 'master' })).toBe('skip');
    expect(decide({ conclusion: 'failure', event: 'push', branch: 'feature' })).toBe('skip');
  });

  it('keeps one issue per workflow and links the run and commit', () => {
    const run = { workflow: 'Web app', url: 'https://example.test/run/1', sha: 'a'.repeat(40) };
    expect(issueTitle('Web app')).toBe('master is red: Web app');
    expect(failureText(run)).toContain(run.url);
    expect(failureText(run)).toContain('a'.repeat(12));
    expect(failureText(run)).toContain('Fix forward');
    expect(failureText(run)).toContain('Fixes #');
  });
});

describe('master-red.yml', () => {
  const wf = (): Data => load(path.join(WORKFLOWS, 'master-red.yml'));

  it('runs after CI and Web app finish on master', () => {
    expect(wf().on.workflow_run).toEqual({
      workflows: ['CI', 'Web app'],
      types: ['completed'],
      branches: ['master'],
    });
  });

  it('starts a job only for a failed or timed-out run, so green runs take no runner place', () => {
    expect(wf().jobs.report.if.replace(/\s+/g, ' ')).toBe(
      "github.event.workflow_run.conclusion == 'failure' || github.event.workflow_run.conclusion == 'timed_out'",
    );
  });

  it('can write issues and nothing else', () => {
    expect(wf().permissions).toEqual({ contents: 'read', issues: 'write' });
  });

  it('runs the reporter with the run facts and a time limit', () => {
    const job = wf().jobs.report;
    expect(job['timeout-minutes']).toBeGreaterThan(0);
    const step = (job.steps as Data[]).find((s) => s.run === 'node scripts/report-master-red.mjs');
    expect(step).toBeDefined();
    expect(Object.keys(step.env).sort()).toEqual(
      [
        'CONCLUSION',
        'GITHUB_TOKEN',
        'HEAD_BRANCH',
        'HEAD_SHA',
        'RUN_EVENT',
        'RUN_URL',
        'WORKFLOW_NAME',
      ].sort(),
    );
  });
});
