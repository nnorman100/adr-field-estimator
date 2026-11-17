import { describe, expect, it } from 'vitest';
import { draftRefusal, judge, NO_ANSWER, refusalReason, type DocWrite, type JournalEntry, type RoleNow, type ServerDoc } from '@/lib/field/journal';

// What the recovery journal decides after a restart (S6-4; docs/plans/S6.md section 4, step 2):
// only the newest entry per document and key is compared with the server.
const DRAFT = 'companies/c/drafts/d';
const ROOM = `${DRAFT}/rooms/r1`;
let seq = 0;
function entry(writes: DocWrite[], bases?: Record<string, number | null>): JournalEntry {
  seq += 1;
  return { seq, id: `op${seq}`, tenantId: 't', uid: 'ana', draftPath: DRAFT, writes, at: seq, state: 'pending', ...(bases ? { bases } : {}) };
}
const notes = (value: string | null): DocWrite => ({ path: DRAFT, op: 'update', fields: { 'field.notes': value } });
const editing = (field: Record<string, unknown>, more: Record<string, unknown> = {}): ServerDoc => ({ data: { state: 'editing', fieldOwnerUid: 'ana', field, ...more } });
const run = (judged: JournalEntry[], docs: Record<string, ServerDoc>, newer: JournalEntry[] = [], role: RoleNow = null) => {
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

  // The fence is checked before an entry is acknowledged (step 6, Firstmate rulings R3 and R2 of
  // 2026-11-17): a newer document version alone never proves this phone's write landed.
  it('rejects an entry of a finished draft as locked even when its room document was updated since with its value', () => {
    const one = entry([{ path: ROOM, op: 'update', fields: { 'field.name': 'Hall' } }], { [ROOM]: 10 });
    const docs = { [DRAFT]: editing({}, { state: 'submitted' }), [ROOM]: { data: { field: { name: 'Hall' } }, updateTime: 20 } };
    expect(run([one], docs)).toEqual({ [one.seq]: { kind: 'rejected', reason: 'locked' } });
  });

  it('rejects a draft-level entry as locked once the draft is finished, even when its value matches: the fence itself updates the draft', () => {
    const one = entry([notes('in time')], { [DRAFT]: 10 });
    expect(run([one], { [DRAFT]: { ...editing({ notes: 'in time' }, { state: 'submitted' }), updateTime: 30 } })).toEqual({ [one.seq]: { kind: 'rejected', reason: 'locked' } });
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

// Firstmate ruling R3 (2026-11-17): writes refused after the fence stay "rejected: locked", even
// when the server's value happens to match what they wrote.
describe('the journal after a restart, once the draft is finished', () => {
  const PHOTO = `${DRAFT}/photos/p1`;
  const fenced = (field: Record<string, unknown>): ServerDoc => ({ ...editing(field, { state: 'submitted' }), updateTime: 50 });

  it('rejects both of 1 then 0 saved offline and refused, though the server still holds 0', () => {
    const one = entry([{ path: DRAFT, op: 'update', fields: { 'field.airMovers': 1 } }], { [DRAFT]: 10 });
    const zero = entry([{ path: DRAFT, op: 'update', fields: { 'field.airMovers': 0 } }], { [DRAFT]: 10 });
    expect(run([one, zero], { [DRAFT]: fenced({ airMovers: 0 }) })).toEqual({
      [one.seq]: { kind: 'rejected', reason: 'locked' },
      [zero.seq]: { kind: 'rejected', reason: 'locked' },
    });
  });

  it('rejects a room edit refused after the fence whose value matches: the room was not updated since', () => {
    const hall = entry([{ path: ROOM, op: 'update', fields: { 'field.name': 'Hall' } }], { [ROOM]: 10 });
    const back = entry([{ path: ROOM, op: 'update', fields: { 'field.name': 'Kitchen' } }], { [ROOM]: 10 });
    const docs = { [DRAFT]: fenced({}), [ROOM]: { data: { field: { name: 'Kitchen' } }, updateTime: 10 } };
    expect(run([hall, back], docs)).toEqual({ [hall.seq]: { kind: 'rejected', reason: 'locked' }, [back.seq]: { kind: 'rejected', reason: 'locked' } });
  });

  it('rejects a photo reference whether or not a newer version holds its value, and one that never landed', () => {
    const landed = entry([{ path: PHOTO, op: 'set', data: { field: { shotTag: 'overview' } } }], { [PHOTO]: null });
    const other = `${DRAFT}/photos/p2`;
    const refused = entry([{ path: other, op: 'set', data: { field: { shotTag: 'meter' } } }], { [other]: null });
    const docs = { [DRAFT]: fenced({}), [PHOTO]: { data: { field: { shotTag: 'overview' } }, updateTime: 20 }, [other]: { missing: true } as ServerDoc };
    expect(run([landed, refused], docs)).toEqual({ [landed.seq]: { kind: 'rejected', reason: 'locked' }, [refused.seq]: { kind: 'rejected', reason: 'locked' } });
  });

  // The review's reproduction: the other phone's edit of another key gives the room a newer version.
  it('rejects Hall then Kitchen as locked when another phone changed the room and finished the job, though the room holds Kitchen', () => {
    const hall = entry([{ path: ROOM, op: 'update', fields: { 'field.name': 'Hall' } }], { [ROOM]: 10 });
    const kitchen = entry([{ path: ROOM, op: 'update', fields: { 'field.name': 'Kitchen' } }], { [ROOM]: 10 });
    const docs = { [DRAFT]: fenced({}), [ROOM]: { data: { field: { name: 'Kitchen', affectedSf: 120 } }, updateTime: 20 } };
    expect(run([hall, kitchen], docs)).toEqual({ [hall.seq]: { kind: 'rejected', reason: 'locked' }, [kitchen.seq]: { kind: 'rejected', reason: 'locked' } });
  });

  it('rejects a room removal as locked: a removed document has no update time to show it landed', () => {
    const removed = entry([{ path: ROOM, op: 'delete' }, { path: DRAFT, op: 'update', fields: { 'field.roomOrder': [] } }], { [ROOM]: 10, [DRAFT]: 10 });
    expect(run([removed], { [DRAFT]: fenced({ roomOrder: [] }), [ROOM]: { missing: true } })).toEqual({ [removed.seq]: { kind: 'rejected', reason: 'locked' } });
  });
});

// Firstmate ruling R1 (2026-11-17): whether an entry reached Firestore is unknown after a restart. It
// is made again only when the server has not changed its documents since it was made.
describe('the journal after a restart, for an edit that may never have reached Firestore', () => {
  const PHOTO = `${DRAFT}/photos/p1`;

  it.each([
    ['the draft', [notes('A')], { [DRAFT]: 10 }, { [DRAFT]: { ...editing({ notes: 'B' }), updateTime: 20 } }],
    ['a room', [{ path: ROOM, op: 'update', fields: { 'field.name': 'A' } }], { [ROOM]: 10 }, { [DRAFT]: editing({}), [ROOM]: { data: { field: { name: 'B' } }, updateTime: 20 } }],
    ['a photo', [{ path: PHOTO, op: 'set', data: { field: { shotTag: 'overview' } } }], { [PHOTO]: null }, { [DRAFT]: editing({}), [PHOTO]: { data: { field: { shotTag: 'meter' } }, updateTime: 20 } }],
    ['a removal', [{ path: ROOM, op: 'delete' }], { [ROOM]: 10 }, { [DRAFT]: editing({}), [ROOM]: { data: { field: { name: 'B' } }, updateTime: 20 } }],
  ] as [string, DocWrite[], Record<string, number | null>, Record<string, ServerDoc>][])(
    'never makes %s edit again over a later save from another phone: it is changed and kept',
    (_name, writes, bases, docs) => {
      const one = entry(writes, bases);
      expect(run([one], docs)).toEqual({ [one.seq]: { kind: 'changed' } });
    },
  );

  it.each([
    ['the draft', [notes('A')], { [DRAFT]: 10 }, { [DRAFT]: { ...editing({}), updateTime: 10 } }],
    ['a room', [{ path: ROOM, op: 'update', fields: { 'field.name': 'A' } }], { [ROOM]: 10 }, { [DRAFT]: editing({}), [ROOM]: { data: { field: { name: 'B' } }, updateTime: 10 } }],
    ['a photo', [{ path: PHOTO, op: 'set', data: { field: { shotTag: 'overview' } } }], { [PHOTO]: null }, { [DRAFT]: editing({}), [PHOTO]: { missing: true } }],
    ['a removal', [{ path: ROOM, op: 'delete' }], { [ROOM]: 10 }, { [DRAFT]: editing({}), [ROOM]: { data: { field: { name: 'B' } }, updateTime: 10 } }],
  ] as [string, DocWrite[], Record<string, number | null>, Record<string, ServerDoc>][])('makes %s edit again when the server has not changed it since', (_name, writes, bases, docs) => {
    const one = entry(writes, bases);
    expect(run([one], docs)).toEqual({ [one.seq]: { kind: 'reissue' } });
  });

  it('keeps an edit whose base is unknown rather than making it again', () => {
    const one = entry([notes('A')]);
    expect(run([one], { [DRAFT]: { ...editing({}), updateTime: 10 } })).toEqual({ [one.seq]: { kind: 'changed' } });
  });

  it('does not make an edit again when a later edit of this phone wrote one of its keys', () => {
    const older = entry([{ path: DRAFT, op: 'update', fields: { 'field.notes': 'A', 'field.airMovers': 2 } }], { [DRAFT]: 10 });
    const later = entry([notes('typed later')], { [DRAFT]: 10 });
    expect(run([older, later], { [DRAFT]: { ...editing({}), updateTime: 10 } })).toEqual({ [older.seq]: { kind: 'changed' }, [later.seq]: { kind: 'reissue' } });
  });
});

// Firstmate ruling R1 (2026-11-17): a reason that cannot be read yet is never recorded as a guess.
describe('a refusal whose reason cannot be read yet', () => {
  it('stays unresolved when the draft did not answer, or the role check did not and the role decides', () => {
    expect(refusalReason(null, 'ana', 'estimator')).toBeNull();
    expect(refusalReason({ denied: true }, 'ana', NO_ANSWER)).toBeNull();
    expect(refusalReason(editing({}), 'ana', NO_ANSWER)).toBeNull();
    // Nothing on the server refuses the draft: no reason to record either.
    expect(refusalReason(editing({}), 'ana', 'estimator')).toBeNull();
  });

  it('is classified as soon as what decides it is known', () => {
    expect(refusalReason({ data: { state: 'submitted', fieldOwnerUid: 'ana', field: {} } }, 'ana', NO_ANSWER)).toBe('locked');
    expect(refusalReason({ denied: true }, 'ana', 'estimator')).toBe('owner-changed');
    expect(refusalReason(editing({}), 'ana', 'office')).toBe('role-changed');
  });

  it('leaves an earlier entry out of the judging while the role decides it and the check did not answer', () => {
    const moved = entry([notes('A')], { [DRAFT]: 10 });
    expect(run([moved], { [DRAFT]: { denied: true } }, [], NO_ANSWER)).toEqual({});
    const office = entry([notes('A')], { [DRAFT]: 10 });
    expect(run([office], { [DRAFT]: { ...editing({}), updateTime: 10 } }, [], NO_ANSWER)).toEqual({});
    const fenced = entry([notes('A')], { [DRAFT]: 10 });
    expect(run([fenced], { [DRAFT]: { ...editing({}, { state: 'submitted' }), updateTime: 30 } }, [], NO_ANSWER)).toEqual({ [fenced.seq]: { kind: 'rejected', reason: 'locked' } });
  });
});

