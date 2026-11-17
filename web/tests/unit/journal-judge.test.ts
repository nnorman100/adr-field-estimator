import { describe, expect, it } from 'vitest';
import { draftRefusal, judge, type DocWrite, type JournalEntry, type ServerDoc } from '@/lib/field/journal';

// What the recovery journal decides after a restart (S6-4; docs/plans/S6.md section 4, step 2):
// only the newest entry per document and key is compared with the server.
const DRAFT = 'companies/c/drafts/d';
const ROOM = `${DRAFT}/rooms/r1`;
let seq = 0;
function entry(writes: DocWrite[]): JournalEntry {
  seq += 1;
  return { seq, id: `op${seq}`, tenantId: 't', uid: 'ana', draftPath: DRAFT, writes, at: seq, state: 'pending', reached: true };
}
const notes = (value: string | null): DocWrite => ({ path: DRAFT, op: 'update', fields: { 'field.notes': value } });
const editing = (field: Record<string, unknown>, more: Record<string, unknown> = {}): ServerDoc => ({ data: { state: 'editing', fieldOwnerUid: 'ana', field, ...more } });
const run = (judged: JournalEntry[], docs: Record<string, ServerDoc>, newer: JournalEntry[] = [], role: string | null = null) => {
  const map = new Map(Object.entries(docs));
  return Object.fromEntries([...judge(judged, newer, map, map, 'ana', role)].map(([key, value]) => [key, value]));
};

describe('the journal after a restart', () => {
  it('acks an entry whose values the server holds, and an older one a newer entry overwrote', () => {
    const older = entry([notes('first')]);
    const newest = entry([notes('second')]);
    expect(run([older, newest], { [DRAFT]: editing({ notes: 'second' }) })).toEqual({ [older.seq]: { kind: 'acked' }, [newest.seq]: { kind: 'acked' } });
  });

  it('says changed when the server holds other values and the rules do not refuse the draft', () => {
    const one = entry([notes('mine')]);
    expect(run([one], { [DRAFT]: editing({ notes: 'other phone' }) })).toEqual({ [one.seq]: { kind: 'changed' } });
  });

  it.each([
    ['locked', { data: { state: 'submitted', fieldOwnerUid: 'ana', field: {} } }],
    ['owner-changed', { data: { state: 'editing', fieldOwnerUid: 'ben', field: {} } }],
    ['no-access', { denied: true }],
    ['no-access', { missing: true }],
  ] as [string, ServerDoc][])('rejects with %s when the rules refuse the draft', (reason, draft) => {
    const one = entry([notes('after the fence')]);
    expect(run([one], { [DRAFT]: draft })).toEqual({ [one.seq]: { kind: 'rejected', reason } });
  });

  it('acks an entry that landed before the draft was finished', () => {
    const one = entry([notes('in time')]);
    expect(run([one], { [DRAFT]: editing({ notes: 'in time' }, { state: 'submitted' }) })).toEqual({ [one.seq]: { kind: 'acked' } });
  });

  it('does not hold a key against an older entry when this page wrote it since', () => {
    const older = entry([notes('old')]);
    const live = entry([notes('typed now')]);
    expect(run([older], { [DRAFT]: editing({ notes: 'something else' }) }, [live])).toEqual({ [older.seq]: { kind: 'acked' } });
  });

  it('compares removals, whole documents and removed keys', () => {
    const removed = entry([{ path: ROOM, op: 'delete' }, { path: DRAFT, op: 'update', fields: { 'field.roomOrder': [] } }]);
    const cleared = entry([notes(null)]);
    const photo = entry([{ path: `${DRAFT}/photos/p1`, op: 'set', data: { field: { shotTag: 'overview', roomId: 'r2' } } }]);
    const docs = { [DRAFT]: editing({ roomOrder: [] }), [ROOM]: { missing: true } as ServerDoc, [`${DRAFT}/photos/p1`]: { data: { field: { roomId: 'r2', shotTag: 'overview' } } } };
    expect(run([removed, cleared, photo], docs)).toEqual({ [removed.seq]: { kind: 'acked' }, [cleared.seq]: { kind: 'acked' }, [photo.seq]: { kind: 'acked' } });
    expect(run([removed], { ...docs, [ROOM]: { data: { field: { name: 'Kitchen' } } } })).toEqual({ [removed.seq]: { kind: 'changed' } });
  });

  it('acks a room added, edited and removed offline: the removal supersedes its earlier keys', () => {
    const added = entry([{ path: ROOM, op: 'set', data: { field: { name: 'Kitchen' } } }, { path: DRAFT, op: 'update', fields: { 'field.roomOrder': ['r1'] } }]);
    const edited = entry([{ path: ROOM, op: 'update', fields: { 'field.name': 'Hall', 'field.notes': 'wet' } }]);
    const removed = entry([{ path: ROOM, op: 'delete' }, { path: DRAFT, op: 'update', fields: { 'field.roomOrder': [] } }]);
    const docs = { [DRAFT]: editing({ roomOrder: [] }), [ROOM]: { missing: true } as ServerDoc };
    expect(run([added, edited, removed], docs)).toEqual({ [added.seq]: { kind: 'acked' }, [edited.seq]: { kind: 'acked' }, [removed.seq]: { kind: 'acked' } });
  });

  it('treats a whole-document write as removing the keys it does not name', () => {
    const PHOTO = `${DRAFT}/photos/p1`;
    const older = entry([{ path: PHOTO, op: 'update', fields: { 'field.roomId': 'r1' } }]);
    const replaced = entry([{ path: PHOTO, op: 'set', data: { field: { shotTag: 'overview' } } }]);
    const docs = { [DRAFT]: editing({}), [PHOTO]: { data: { field: { shotTag: 'overview' } } } as ServerDoc };
    expect(run([older, replaced], docs)).toEqual({ [older.seq]: { kind: 'acked' }, [replaced.seq]: { kind: 'acked' } });
    expect(run([older, replaced], { ...docs, [PHOTO]: { data: { field: { shotTag: 'overview', roomId: 'r1' } } } })).toEqual({ [older.seq]: { kind: 'changed' }, [replaced.seq]: { kind: 'acked' } });
  });

  it('leaves out an entry whose documents did not all answer', () => {
    const one = entry([{ path: ROOM, op: 'update', fields: { 'field.name': 'Hall' } }]);
    expect(run([one], { [DRAFT]: editing({}) })).toEqual({});
  });
});

// Why the rules refused, from the server's copy of the draft and the person's role at the last
// online check that let them in (GET /api/me).
describe('the refusal reason', () => {
  it('is owner-changed when the field work moved: an estimator with current access can no longer read the draft', () => {
    expect(draftRefusal({ denied: true }, 'ana', 'estimator')).toBe('owner-changed');
    const one = entry([notes('mine')]);
    expect(run([one], { [DRAFT]: { denied: true } }, [], 'estimator')).toEqual({ [one.seq]: { kind: 'rejected', reason: 'owner-changed' } });
  });

  it('stays no-access when no online check says the person still has access', () => {
    expect(draftRefusal({ denied: true }, 'ana')).toBe('no-access');
    // Owner and office read every draft of their company, so a refused read is not a move.
    expect(draftRefusal({ denied: true }, 'ana', 'office')).toBe('no-access');
  });

  it('is role-changed when the role can still read the draft but no longer edit it, never changed', () => {
    const draft = editing({ notes: 'before' });
    expect(draftRefusal(draft, 'ana', 'office')).toBe('role-changed');
    expect(draftRefusal(draft, 'ana', 'estimator')).toBeNull();
    expect(draftRefusal(draft, 'ana', 'owner')).toBeNull();
    const one = entry([notes('typed as an estimator')]);
    expect(run([one], { [DRAFT]: draft }, [], 'office')).toEqual({ [one.seq]: { kind: 'rejected', reason: 'role-changed' } });
  });
});
