import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { draftsAlreadyClosed, draftsToClose, parseClaims, parseReconcileArgs, type FoundDraft } from '../../scripts/reconcile-restored-drafts';

// The owner-run close of field drafts a restored Postgres no longer gives the job they name
// (docs/runbook/backups.md). Its Firestore read and write, against the emulator, are in
// tests/emu/reconcile-restored-drafts.test.ts.

describe('parseReconcileArgs', () => {
  it('needs a project and a Firestore database id; --apply makes it write', () => {
    expect(parseReconcileArgs(['--project', 'dryscope', '--database', 'dryscope-field-test'])).toEqual({ project: 'dryscope', database: 'dryscope-field-test', apply: false });
    expect(parseReconcileArgs(['--apply', '--database', '(default)', '--project', 'dryscope'])).toEqual({ project: 'dryscope', database: '(default)', apply: true });
    expect(() => parseReconcileArgs(['--database', 'dryscope-field-test'])).toThrow('--project is required');
    expect(() => parseReconcileArgs(['--project', 'dryscope'])).toThrow('--database is required');
    expect(() => parseReconcileArgs(['--project', 'Not A Project', '--database', 'x-db'])).toThrow('--project must be');
    expect(() => parseReconcileArgs(['--project', 'dryscope', '--database', 'Bad/Db'])).toThrow('--database must be');
    expect(() => parseReconcileArgs(['--project', 'dryscope', '--database', 'dryscope-field-test', '--all'])).toThrow('unknown option --all');
    expect(() => parseReconcileArgs(['--project'])).toThrow('--project needs a value');
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
