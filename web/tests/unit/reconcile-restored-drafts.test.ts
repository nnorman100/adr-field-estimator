import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkExports, draftsAlreadyClosed, draftsToClose, locatorsToFix, parseClaims, parseJobs, parseReconcileArgs, type FoundDraft } from '../../scripts/reconcile-restored-drafts';

// The owner-run close of field drafts a restored Postgres no longer gives the job they name
// (docs/runbook/backups.md). Its Firestore read and write, against the emulator, are in
// tests/emu/reconcile-restored-drafts.test.ts.

describe('parseReconcileArgs', () => {
  it('needs a project, a Firestore database id and both exports; --apply makes it write', () => {
    const files = ['--job-drafts', 'job-drafts.csv', '--jobs', 'jobs.csv'];
    expect(parseReconcileArgs(['--project', 'dryscope', '--database', 'dryscope-field-test', ...files])).toEqual({
      project: 'dryscope',
      database: 'dryscope-field-test',
      apply: false,
      files: { 'job-drafts': 'job-drafts.csv', jobs: 'jobs.csv' },
    });
    expect(parseReconcileArgs(['--apply', ...files, '--database', '(default)', '--project', 'dryscope'])).toMatchObject({ database: '(default)', apply: true });
    expect(() => parseReconcileArgs(['--database', 'dryscope-field-test', ...files])).toThrow('--project is required');
    expect(() => parseReconcileArgs(['--project', 'dryscope', ...files])).toThrow('--database is required');
    expect(() => parseReconcileArgs(['--project', 'Not A Project', '--database', 'x-db', ...files])).toThrow('--project must be');
    expect(() => parseReconcileArgs(['--project', 'dryscope', '--database', 'Bad/Db', ...files])).toThrow('--database must be');
    expect(() => parseReconcileArgs(['--project', 'dryscope', '--database', 'dryscope-field-test', '--jobs', 'jobs.csv'])).toThrow('--job-drafts is required');
    expect(() => parseReconcileArgs(['--project', 'dryscope', '--database', 'dryscope-field-test', '--job-drafts', 'a.csv'])).toThrow('--jobs is required');
    expect(() => parseReconcileArgs(['--project', 'dryscope', '--database', 'dryscope-field-test', ...files, '--all'])).toThrow('unknown option --all');
    expect(() => parseReconcileArgs(['--project', 'dryscope', '--database', 'dryscope-field-test', '--jobs'])).toThrow('--jobs needs a value');
  });
});

describe('parseClaims', () => {
  it('reads the runbook export, skipping blank lines, and refuses anything else, an empty export included', () => {
    const [company, draft, job] = [randomUUID(), randomUUID(), randomUUID()];
    expect(parseClaims(`${company},${draft},${job}\r\n\n`)).toEqual(new Map([[`${company}/${draft}`, job]]));
    expect(() => parseClaims(`${company},${draft}`)).toThrow('line 1 is not');
    expect(() => parseClaims(`${company},${draft},not-a-job`)).toThrow('line 1 is not');
    expect(() => parseClaims('\n\n')).toThrow('the job_drafts export is empty');
  });
});

describe('draftsToClose', () => {
  const company = randomUUID();
  const draft = (extra: Partial<FoundDraft> = {}): FoundDraft => ({ companyId: company, draftId: randomUUID(), jobId: randomUUID(), state: 'editing', fieldOwnerUid: 'estimator-1', ...extra });

  it('closes a draft the restored Postgres does not give its job, and one it gives another job', () => {
    const kept = draft();
    const unstamped = draft({ jobId: undefined });
    const unclaimed = draft();
    const moved = draft();
    const claims = new Map([
      [`${company}/${kept.draftId}`, kept.jobId as string],
      [`${company}/${unstamped.draftId}`, randomUUID()],
      [`${company}/${moved.draftId}`, randomUUID()],
    ]);
    expect(draftsToClose([kept, unstamped, unclaimed, moved], claims)).toEqual([
      { companyId: company, draftId: unclaimed.draftId, reason: 'unclaimed' },
      { companyId: company, draftId: moved.draftId, reason: 'another_job' },
    ]);
  });

  it('leaves alone one already archived naming nobody, but closes an archived one that still names someone', () => {
    const closed = draft({ state: 'archived', fieldOwnerUid: undefined });
    const named = draft({ state: 'archived' });
    const submitted = draft({ state: 'submitted', fieldOwnerUid: undefined });
    expect(draftsToClose([closed, named, submitted], new Map([[`${randomUUID()}/${randomUUID()}`, randomUUID()]])).map((one) => one.draftId)).toEqual([named.draftId, submitted.draftId]);
  });

  it('lists the drafts not given to their job that are closed already, so the owner’s list is whole', () => {
    const closed = draft({ state: 'archived', fieldOwnerUid: undefined });
    const claimedClosed = draft({ state: 'archived', fieldOwnerUid: undefined });
    const open = draft();
    const claims = new Map([[`${company}/${claimedClosed.draftId}`, claimedClosed.jobId as string]]);
    expect(draftsAlreadyClosed([closed, claimedClosed, open], claims)).toEqual([{ companyId: company, draftId: closed.draftId, reason: 'unclaimed' }]);
    expect(draftsToClose([closed, claimedClosed, open], claims).map((one) => one.draftId)).toEqual([open.draftId]);
  });
});

describe('the job locators', () => {
  it('reads the restored jobs export, and refuses anything else, an empty export included', () => {
    const [company, job, draft] = [randomUUID(), randomUUID(), randomUUID()];
    expect(parseJobs(`${company},${job},${draft},7\r\n\n`)).toEqual(new Map([[`${company}/${job}`, { currentDraftId: draft, revision: 7 }]]));
    expect(() => parseJobs(`${company},${job},${draft}`)).toThrow('line 1 of the jobs export is not');
    expect(() => parseJobs(`${company},${job},${draft},-1`)).toThrow('line 1 of the jobs export is not');
    expect(() => parseJobs(`${company},${job},${draft},1.5`)).toThrow('line 1 of the jobs export is not');
    expect(() => parseJobs('')).toThrow('the jobs export is empty');
  });

  it('puts back a locator that differs from its restored job, removes one of a job Postgres does not have, and leaves the rest', () => {
    const company = randomUUID();
    const [same, ahead, gone] = [randomUUID(), randomUUID(), randomUUID()];
    const [draft, later] = [randomUUID(), randomUUID()];
    const jobs = new Map([
      [`${company}/${same}`, { currentDraftId: draft, revision: 3 }],
      [`${company}/${ahead}`, { currentDraftId: draft, revision: 3 }],
    ]);
    expect(
      locatorsToFix(
        [
          { companyId: company, jobId: same, currentDraftId: draft, revision: 3 },
          { companyId: company, jobId: ahead, currentDraftId: later, revision: 5 },
          { companyId: company, jobId: gone, currentDraftId: later, revision: 1 },
        ],
        jobs,
      ),
    ).toEqual([
      { companyId: company, jobId: ahead, action: 'set', currentDraftId: draft, revision: 3 },
      { companyId: company, jobId: gone, action: 'remove' },
    ]);
  });
});

describe('checkExports', () => {
  it('stops on exports that do not agree, before any write is planned', () => {
    const [company, job, draft, earlier] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const jobs = new Map([[`${company}/${job}`, { currentDraftId: draft, revision: 2 }]]);
    const claims = new Map([
      [`${company}/${draft}`, job],
      [`${company}/${earlier}`, job],
    ]);
    expect(() => checkExports(claims, jobs)).not.toThrow();
    // The job_drafts export cut short: the current draft's claim is missing.
    expect(() => checkExports(new Map([[`${company}/${earlier}`, job]]), jobs)).toThrow('1 jobs whose current draft the job_drafts export does not give them, 0 job_drafts rows');
    // The jobs export cut short: a claim names a job it does not have.
    expect(() => checkExports(new Map([...claims, [`${company}/${randomUUID()}`, randomUUID()]]), jobs)).toThrow('0 jobs whose current draft the job_drafts export does not give them, 1 job_drafts rows');
  });
});
