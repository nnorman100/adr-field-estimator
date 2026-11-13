import { describe, expect, it } from 'vitest';
import { pending, type PendingRecord } from '@/lib/field/pending';

// Unsent work of the job screens (S5a-6): it belongs to one signed-in person of one company, a
// send in flight is marked so it cannot go twice, and an answer settles only its own request.

const JOB = '0b8f1e2a-3c4d-4e5f-8a6b-7c8d9e0f1a2b';
const record = (kind: PendingRecord['kind'], changeId: string): PendingRecord => ({
  kind,
  changeId,
  revision: 1,
  values: { name: 'Ann' },
  edits: { name: 'Ann' },
  sending: true,
});
const photo = { id: 'p1', bytes: new Blob(['x']), field: {}, step: 'sending' as const };

describe('unsent work', () => {
  it('starts empty for another person or company, and keeps it for the same one', () => {
    pending.openFor('company-a/user-a');
    pending.setJob({ id: 'j1', draftId: 'd1', propertyAddress: '1 Main St', sending: false });
    pending.setRecord(JOB, record('customer', 'c1'));
    pending.addPhoto(JOB, photo);

    pending.openFor('company-a/user-a');
    expect(pending.job()?.id).toBe('j1');
    expect(pending.record(JOB)?.changeId).toBe('c1');
    expect(pending.photos(JOB)).toHaveLength(1);

    pending.openFor('company-a/user-b');
    expect(pending.job()).toBeNull();
    expect(pending.record(JOB)).toBeNull();
    expect(pending.photos(JOB)).toEqual([]);
  });

  it('settles a record save only while it still holds the job, and keeps it unsent after no answer', () => {
    pending.openFor('company-a/user-c');
    pending.setRecord(JOB, record('customer', 'c1'));
    expect(pending.settleRecord(JOB, 'c1', true)).toBe(true);
    expect(pending.record(JOB)).toMatchObject({ changeId: 'c1', sending: false, edits: { name: 'Ann' } });

    expect(pending.settleRecord(JOB, 'c1', false)).toBe(true);
    pending.setRecord(JOB, record('claim', 'k1'));
    // A late answer to the customer save must not clear the claim save that came after it.
    expect(pending.settleRecord(JOB, 'c1', false)).toBe(false);
    expect(pending.record(JOB)?.changeId).toBe('k1');
  });

  it('settles a new job only while it still holds the slot', () => {
    pending.openFor('company-a/user-d');
    pending.setJob({ id: 'j1', draftId: 'd1', propertyAddress: '', sending: true });
    expect(pending.settleJob('j1', true)).toBe(true);
    expect(pending.job()).toMatchObject({ id: 'j1', sending: false });

    pending.openFor('company-a/user-e');
    expect(pending.settleJob('j1', false)).toBe(false);
    expect(pending.job()).toBeNull();
  });
});
