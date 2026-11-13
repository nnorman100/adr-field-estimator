import { describe, expect, it } from 'vitest';
import { SUBMISSION_ERRORS } from '@/lib/submissions/errors';
import { draftSummary, finisherOf, jobOf, outcomeOf } from '@/lib/submissions/screen';

// The Finish and review screen's decisions in the browser (src/lib/submissions/screen.ts).

describe('the Finish and review screen', () => {
  it('lets the roles with scope finish, and reads the company from /api/me', () => {
    expect(finisherOf({ company: { id: 'c1' }, capabilities: ['jobs_read', 'scope'] })).toEqual({ companyId: 'c1', canFinish: true });
    expect(finisherOf({ company: { id: 'c1' }, capabilities: ['jobs_read', 'coordination'] })).toEqual({ companyId: 'c1', canFinish: false });
    expect(finisherOf({ company: {}, capabilities: [] })).toBeNull();
    expect(finisherOf(null)).toBeNull();
  });

  it('reads the job from the job, Submit and Back to editing answers', () => {
    expect(jobOf({ job: { id: 'j', status: 'submitted', currentDraftId: 'd', revision: 3 } })).toEqual({ id: 'j', status: 'submitted', currentDraftId: 'd' });
    expect(jobOf({ job: { id: 'j', status: 'draft' } })).toBeNull();
    expect(jobOf({ error: 'conflict' })).toBeNull();
  });

  it('lists the rooms in the technician’s order, the photos and the summary', () => {
    const summary = draftSummary({
      draft: { roomOrder: ['b', 'a', 'gone'], summary: '  Water in the hall. ' },
      rooms: [
        { id: 'a', field: { name: 'Kitchen' } },
        { id: 'b', field: { name: 'Hall' } },
        { id: 'c', field: { category: 1 } },
      ],
      photos: [{ id: 'p', field: {} }],
    });
    expect(summary).toEqual({ rooms: ['Hall', 'Kitchen'], photos: 1, summaryWritten: true, unnamedRooms: 1 });
    expect(draftSummary({ draft: {}, rooms: [], photos: [] })).toEqual({ rooms: [], photos: 0, summaryWritten: false, unnamedRooms: 0 });
  });

  it('has a fixed message and a next step for every refusal the routes send', () => {
    for (const code of Object.keys(SUBMISSION_ERRORS).filter((code) => code !== 'invalid_request')) {
      const outcome = outcomeOf(SUBMISSION_ERRORS[code as keyof typeof SUBMISSION_ERRORS], { error: code });
      expect({ code, generic: outcome.message.startsWith('Something went wrong') }).toEqual({ code, generic: false });
    }
    // Only a failure to reach the server sends the same request again; a changed draft starts over.
    expect(outcomeOf(503, { error: 'submissions_unavailable' }).next).toBe('retry');
    expect(outcomeOf(0, null).next).toBe('retry');
    expect(outcomeOf(409, { error: 'digest_mismatch' }).next).toBe('reload');
    expect(outcomeOf(409, { error: 'submission_aborted' }).next).toBe('reload');
    expect(outcomeOf(409, { error: 'already_submitted' }).next).toBe('done');
    expect(outcomeOf(400, { error: 'something new' })).toEqual({ message: 'Something went wrong. Reload the job.', next: 'reload' });
  });
});
