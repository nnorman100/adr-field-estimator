import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { compareVersion, desired, type JobDraftSnapshot, type SyncFence } from '@/lib/jobs/draft-lifecycle';

// desired() (src/lib/jobs/draft-lifecycle.ts): what every draft of a job should hold, from one Postgres
// snapshot, over every job status, submission and owner. The writes it leads to are in
// tests/submissions/sync-contract.ts.

const fence = (): SyncFence => ({ submissionId: randomUUID(), epoch: randomUUID(), expiresAt: new Date(Date.UTC(2031, 0, 1)) });
const [EARLIER, CURRENT] = [randomUUID(), randomUUID()];

const snapshot = (extra: Partial<JobDraftSnapshot> = {}): JobDraftSnapshot => ({
  jobId: 'job-1',
  status: 'draft',
  currentDraftId: CURRENT,
  fieldOwnerUid: 'estimator-1',
  fieldRevision: 9,
  revision: 4,
  coordinationRevision: 2,
  draftIds: [EARLIER, CURRENT],
  pending: null,
  committed: null,
  content: { kind: 'empty' },
  ...extra,
});

describe('desired()', () => {
  it('puts the current draft in the state its job and submissions say, and every earlier draft submitted', () => {
    const [pending, committed] = [fence(), fence()];
    const cases: [Partial<JobDraftSnapshot>, string, SyncFence | null][] = [
      [{}, 'editing', null],
      [{ pending }, 'submitting', pending],
      // A committed row of an earlier attempt does not fence a draft still being edited.
      [{ committed }, 'editing', null],
      [{ status: 'submitted', committed }, 'submitted', committed],
      [{ status: 'signed', committed }, 'submitted', committed],
      [{ status: 'archived', committed }, 'archived', committed],
      [{ status: 'archived' }, 'archived', null],
    ];
    for (const [extra, state, held] of cases) {
      const job = desired(snapshot(extra));
      expect({ extra, current: job.drafts[CURRENT] }).toEqual({
        extra,
        current: { state, fence: held, fieldOwnerUid: 'estimator-1', archiveRevision: 4, fieldOwnerRevision: 2, content: { kind: 'empty' } },
      });
      // An earlier draft's own fence is left as it is (no `fence` key), and it has no content to be made from.
      expect({ extra, earlier: job.drafts[EARLIER] }).toEqual({
        extra,
        earlier: { state: 'submitted', fieldOwnerUid: 'estimator-1', archiveRevision: 4, fieldOwnerRevision: 2 },
      });
    }
  });

  it('names the same owner, or nobody, on every draft, at the snapshot’s field revision', () => {
    const job = desired(snapshot({ fieldOwnerUid: null }));
    expect(job).toMatchObject({ jobId: 'job-1', v: 9 });
    expect(Object.values(job.drafts).map((draft) => draft.fieldOwnerUid)).toEqual([null, null]);
    // The current draft counts even when job_drafts does not list it yet.
    expect(Object.keys(desired(snapshot({ draftIds: [EARLIER] })).drafts).sort()).toEqual([EARLIER, CURRENT].sort());
  });
});

describe('compareVersion()', () => {
  it('orders by generation first, then by field revision', () => {
    expect(compareVersion(null, 0, 0)).toBe('newer');
    expect(compareVersion({ gen: 0, v: 5, draftIds: [] }, 0, 6)).toBe('newer');
    expect(compareVersion({ gen: 0, v: 5, draftIds: [] }, 0, 5)).toBe('same');
    expect(compareVersion({ gen: 0, v: 5, draftIds: [] }, 0, 4)).toBe('older');
    expect(compareVersion({ gen: 0, v: 5, draftIds: [] }, 1, 1)).toBe('newer');
    expect(compareVersion({ gen: 2, v: 1, draftIds: [] }, 1, 99)).toBe('older');
  });
});
