import { describe, expect, it } from 'vitest';
import { newerDetail, pending, typedBefore, type PendingRecord } from '@/lib/field/pending';
import type { JobDetail } from '@/lib/jobs/service';
import type { Answer } from '@/lib/field/api';

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
const photo = { id: 'p1', bytes: new Blob(['x']), field: {}, step: 'sending' as const, draftId: 'd1' };

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
    expect(pending.settleRecord(JOB, 'c1', 'unanswered')).toBe(true);
    expect(pending.record(JOB)).toMatchObject({ changeId: 'c1', sending: false, edits: { name: 'Ann' } });

    expect(pending.settleRecord(JOB, 'c1', 'answered')).toBe(true);
    pending.setRecord(JOB, record('claim', 'k1'));
    // A late answer to the customer save must not clear the claim save that came after it.
    expect(pending.settleRecord(JOB, 'c1', 'answered')).toBe(false);
    expect(pending.record(JOB)?.changeId).toBe('k1');
  });

  it('settles a new job only while it still holds the slot', () => {
    pending.openFor('company-a/user-d');
    pending.setJob({ id: 'j1', draftId: 'd1', propertyAddress: '', sending: true });
    expect(pending.settleJob('j1', 'unanswered')).toBe(true);
    expect(pending.job()).toMatchObject({ id: 'j1', sending: false });

    pending.openFor('company-a/user-e');
    expect(pending.settleJob('j1', 'answered')).toBe(false);
    expect(pending.job()).toBeNull();
  });

  it('frees the slot on a refusal and keeps the changes and the reason until the screen takes them', () => {
    pending.openFor('company-a/user-f');
    pending.setRecord(JOB, record('customer', 'c1'));
    expect(pending.settleRecord(JOB, 'c1', { refused: 'Changed elsewhere.' })).toBe(true);
    expect(pending.record(JOB)).toBeNull();
    expect(pending.refusal(JOB, 'customer')).toEqual({ edits: { name: 'Ann' }, message: 'Changed elsewhere.' });
    expect(pending.refusal(JOB, 'claim')).toBeNull();
    pending.dropRefusal(JOB, 'customer');
    expect(pending.refusal(JOB, 'customer')).toBeNull();

    pending.setJob({ id: 'j1', draftId: 'd1', propertyAddress: '1 Main St', sending: true });
    expect(pending.settleJob('j1', { refused: 'Not allowed.' })).toBe(true);
    expect(pending.job()).toBeNull();
    expect(pending.jobRefusal()).toEqual({ propertyAddress: '1 Main St', message: 'Not allowed.' });

    pending.openFor('company-a/user-g');
    expect(pending.jobRefusal()).toBeNull();
  });
});

describe('what a late send posts for the open screen of its job', () => {
  const at = (revision: number, name: string): JobDetail =>
    ({ job: { id: 'job-late', revision }, customer: { name, phone: '', email: '' } }) as unknown as JobDetail;

  it('keeps the newest job the server answered, and an older answer never replaces it', () => {
    pending.openFor('company-a/user-late');
    expect(pending.detail('job-late')).toBeNull();
    pending.publishDetail('job-late', at(3, 'third'), pending.mark('job-late'));
    pending.publishDetail('job-late', at(2, 'second, answered late'), pending.mark('job-late'));
    expect(pending.detail('job-late')?.customer.name).toBe('third');
    pending.publishDetail('job-late', at(4, 'fourth'), pending.mark('job-late'));
    expect(pending.detail('job-late')?.customer.name).toBe('fourth');
    expect(newerDetail(at(5, 'read'), pending.detail('job-late'))?.customer.name).toBe('read');
    expect(newerDetail(null, pending.detail('job-late'))?.customer.name).toBe('fourth');
  });

  it('drops a refused job and every answer to a request made before the refusal, until a read made after it', () => {
    pending.openFor('company-a/user-denied');
    const kept = { ...at(2, 'kept'), job: { id: 'job-kept', revision: 2 } } as unknown as JobDetail;
    const before = pending.mark('job-late');
    expect(pending.publishDetail('job-late', at(4, 'fourth'), before)).toBe(true);
    pending.publishDetail('job-kept', kept, pending.mark('job-kept'));

    pending.denyDetail('job-late', 'This job is not in your list.');
    expect(pending.detail('job-late')).toBeNull();
    expect(pending.denial('job-late')).toBe('This job is not in your list.');
    expect(pending.detail('job-kept')?.customer.name).toBe('kept');

    // A save sent before the refusal and answered after it.
    expect(pending.publishDetail('job-late', at(5, 'saved late'), before)).toBe(false);
    expect(pending.detail('job-late')).toBeNull();
    expect(pending.denial('job-late')).toBe('This job is not in your list.');

    expect(pending.publishDetail('job-late', at(5, 'read again'), pending.mark('job-late'))).toBe(true);
    expect(pending.detail('job-late')?.customer.name).toBe('read again');
    expect(pending.denial('job-late')).toBeNull();

    pending.openFor('company-a/user-other-denied');
    expect(pending.mark('job-late')).toBe(0);
    expect(pending.denial('job-late')).toBeNull();
  });

  // Slice 6 review R1: a refusal of a job whose field work is held on this phone (kept as moved, revoked)
  // is the newest word on it: an older read's 200 answered after it cannot clear the revocation.
  it('keeps a held job revoked when an older read answers after the refusal', () => {
    pending.openFor('company-a/user-held-refusal');
    pending.hold('job-held', true);
    const older = pending.markRead();
    const newer = pending.markRead();
    const refused = { ok: false as const, status: 404, message: 'This job is not in your list.', denied: true as const };
    expect(pending.readAnswered('job-held', refused, newer)).toBe(true);
    expect(pending.moved('job-held')?.revoked).toBe(true);
    expect(pending.readAnswered('job-held', { ok: true, value: at(6, 'older') }, older)).toBe(false);
    expect(pending.newestRead('job-held', older)).toBe(false);
    expect(pending.moved('job-held')?.revoked).toBe(true);
  });

  // Slice 6 review round 3, R2: an archive answered after a read started ends what that read started.
  it('counts no locator or draft answer of a read sent before the job was seen archived', () => {
    pending.openFor('company-a/user-archived-since');
    const sent = pending.markRead();
    expect(pending.readAnswered('job-arch', { ok: true, value: at(3, 'open') }, sent)).toBe(true);
    expect(pending.newestRead('job-arch', sent)).toBe(true);
    pending.archivedSeen('job-arch');
    expect(pending.newestRead('job-arch', sent)).toBe(false);
  });

  // Slice 6 review round 3, R3: a draft read no job read started counts only for the draft the job names.
  it('counts a draft read no job read started only for the draft the job names now', () => {
    pending.openFor('company-a/user-draft-reads');
    const named = at(2, 'named');
    pending.publishDetail('job-draft', { ...named, job: { ...named.job, currentDraftId: 'draft-b' } }, pending.mark('job-draft'));
    expect(pending.draftReadCounts('job-draft', 'draft-a', undefined, 'draft-a')).toBe(false);
    expect(pending.draftReadCounts('job-draft', 'draft-b', undefined, 'draft-a')).toBe(true);
    // With no job read yet (offline), the locator's draft is the one.
    expect(pending.draftReadCounts('job-unread', 'draft-a', undefined, 'draft-a')).toBe(true);
  });

  it('drops the job for a refused read that comes back after its screen closed, by job id', () => {
    pending.openFor('company-a/user-late-refusal');
    pending.publishDetail('job-late', at(4, 'cached'), pending.mark('job-late'));
    // The job is opened again and left before the read's refusal comes back.
    const sentAt = pending.mark('job-late');
    expect(pending.readAnswered('job-late', { ok: false, status: 0, message: 'No answer' }, sentAt)).toBe(true);
    expect(pending.detail('job-late')?.customer.name).toBe('cached');
    const refused = { ok: false as const, status: 404, message: 'This job is not in your list.', denied: true as const };
    expect(pending.readAnswered('job-late', refused, sentAt)).toBe(true);
    expect(pending.detail('job-late')).toBeNull();
    expect(pending.denial('job-late')).toBe('This job is not in your list.');
    // An answer to a read sent before that refusal no longer counts.
    expect(pending.readAnswered('job-late', { ok: true, value: at(5, 'late') }, sentAt)).toBe(false);
    expect(pending.publishDetail('job-late', at(5, 'late'), sentAt)).toBe(false);
    expect(pending.detail('job-late')).toBeNull();
  });

  it('counts draft changes per job, and starts empty for another sign-in', () => {
    pending.openFor('company-a/user-late');
    const before = pending.draftChanges('job-late');
    pending.draftChanged('job-late');
    expect(pending.draftChanges('job-late')).toBe(before + 1);
    expect(pending.draftChanges('job-other')).toBe(0);
    pending.openFor('company-a/user-other');
    expect(pending.draftChanges('job-late')).toBe(0);
    expect(pending.detail('job-late')).toBeNull();
  });
});

// Owner decision J5 (S5b-1): the field work moving to another person must never take what this person
// typed off their screen.
describe('field work that moved away', () => {
  const refusal = { ok: false as const, status: 404, message: 'This job is not in your list.', denied: true as const };
  const draft = { state: 'editing', fieldOwnerUid: 'u1', field: {}, rooms: [], photos: [] };
  const at = (revision: number, address: string): JobDetail =>
    ({ job: { id: 'job-held', revision, propertyAddress: address }, customer: { name: '', phone: '', email: '' } }) as unknown as JobDetail;

  it('keeps the job on screen when a refusal comes while the person held its field work', () => {
    pending.openFor('company-a/user-held');
    const sentAt = pending.mark('job-held');
    pending.publishDetail('job-held', at(1, 'held'), sentAt);
    pending.hold('job-held', true);
    expect(pending.readAnswered('job-held', refusal, sentAt)).toBe(true);
    expect(pending.moved('job-held')).not.toBeNull();
    expect(pending.denial('job-held')).toBeNull();
    expect(pending.detail('job-held')?.job.propertyAddress).toBe('held');
    // The draft as last read goes with it, for a screen of the job opened again on this page.
    pending.keepDraft('job-held', draft, 'd1');
    expect(pending.moved('job-held')).toEqual({ draft, draftId: 'd1', revoked: true });
  });

  it('drops the job as before when the person did not hold the field work, and on a refused sign-in', () => {
    pending.openFor('company-a/user-notheld');
    expect(pending.refused('job-a', 'This job is not in your list.', 404)).toBe(false);
    expect(pending.moved('job-a')).toBeNull();
    expect(pending.denial('job-a')).toBe('This job is not in your list.');
    pending.hold('job-b', true);
    expect(pending.refused('job-b', 'Sign in again to continue.', 401)).toBe(false);
    expect(pending.moved('job-b')).toBeNull();
    expect(pending.denial('job-b')).toBe('Sign in again to continue.');
  });

  it('stays moved through later refusals, and opens as usual once the job is theirs again', () => {
    pending.openFor('company-a/user-again');
    pending.hold('job-c', true);
    expect(pending.refused('job-c', 'no', 403)).toBe(true);
    pending.hold('job-c', false);
    expect(pending.refused('job-c', 'no', 404)).toBe(true);
    pending.returned('job-c');
    expect(pending.moved('job-c')).toBeNull();
    expect(pending.refused('job-c', 'no', 404)).toBe(false);
    pending.openFor('company-a/user-other-again');
    expect(pending.moved('job-c')).toBeNull();
  });
});

describe('coordination writes kept until answered (S5b-1)', () => {
  const write = (key: string) => ({ key, at: 'move', done: 'The field work was moved.', request: { kind: 'move' as const, revision: 1, changeId: 'c1', toActorId: 'a1' }, sending: true });

  it('keeps a write with its ids after no answer, and settles only the request that holds the slot', () => {
    pending.openFor('company-a/user-coord');
    pending.setCoordWrite('job-x', write('move:a1'));
    expect(pending.settleCoordWrite('job-x', 'assign:a2', 'answered')).toBe(false);
    expect(pending.settleCoordWrite('job-x', 'move:a1', 'unanswered')).toBe(true);
    expect(pending.coordWrite('job-x')).toMatchObject({ sending: false, request: { changeId: 'c1' } });
    expect(pending.settleCoordWrite('job-x', 'move:a1', 'answered')).toBe(true);
    expect(pending.coordWrite('job-x')).toBeNull();
  });

  it('starts empty for another sign-in', () => {
    pending.openFor('company-a/user-coord');
    pending.setCoordWrite('job-x', write('move:a1'));
    pending.openFor('company-a/user-coord-2');
    expect(pending.coordWrite('job-x')).toBeNull();
  });

  it('records a move away before any newer draft, and keeps reading until the server refuses', () => {
    pending.openFor('company-a/user-away');
    pending.moveAway('job-y');
    expect(pending.moved('job-y')).toMatchObject({ revoked: false });
    expect(pending.refused('job-y', 'This job is not in your list.', 404)).toBe(true);
    expect(pending.moved('job-y')).toMatchObject({ revoked: true });
  });
});


describe('archive and restore done on this page (S5b-2)', () => {
  const gone: Answer<unknown> = { ok: false, status: 410, code: 'archived', message: 'This job is archived.' };
  const read: Answer<unknown> = { ok: true, value: {} };

  it('posts the archive for whichever screen of the job is open, and no read sent before it counts', () => {
    pending.openFor('company-a/user-archive');
    const before = pending.mark('job-a');
    expect(pending.readAnswered('job-a', read, before)).toBe(true);
    pending.archivalDone('job-a', true);
    expect(pending.archived('job-a')).toBe(true);
    expect(pending.archivalsDone('job-a')).toBe(1);
    // A read of the draft sent before the archive and answered after it.
    expect(pending.readAnswered('job-a', read, before)).toBe(false);
    expect(pending.readAnswered('job-a', gone, pending.mark('job-a'))).toBe(true);
  });

  it('follows a read of the job either way, and a restore done here', () => {
    pending.openFor('company-a/user-restore');
    expect(pending.readAnswered('job-r', gone, pending.mark('job-r'))).toBe(true);
    expect(pending.archived('job-r')).toBe(true);
    // Restored elsewhere, then read again here.
    expect(pending.readAnswered('job-r', read, pending.mark('job-r'))).toBe(true);
    expect(pending.archived('job-r')).toBe(false);
    pending.archivalDone('job-r', true);
    pending.archivalDone('job-r', false);
    pending.archivalDone('job-s', true);
    expect(pending.archived('job-r')).toBe(false);
    expect(pending.archived('job-s')).toBe(true);
    expect(pending.archivalsDone('job-r')).toBe(2);
    expect(pending.archivalsDone()).toBe(3);
  });

  it('keeps an archive answered elsewhere over a read sent before it and answered after it', () => {
    pending.openFor('company-a/user-archived-elsewhere');
    // Two reads of the job are on their way; the job is archived on another phone between them.
    const older = pending.mark('job-o');
    const newer = pending.mark('job-o');
    expect(pending.readAnswered('job-o', gone, newer)).toBe(true);
    expect(pending.archived('job-o')).toBe(true);
    expect(pending.readAnswered('job-o', read, older)).toBe(false);
    expect(pending.archived('job-o')).toBe(true);
    // A read sent after the archived answer still says how the job is now.
    expect(pending.readAnswered('job-o', read, pending.mark('job-o'))).toBe(true);
    expect(pending.archived('job-o')).toBe(false);
  });

  it('keeps a restore read later over an archived answer to a read sent before it', () => {
    pending.openFor('company-a/user-restored-elsewhere');
    // A read of the archived job is on its way; the job is restored on another phone and opened again.
    const older = pending.markRead();
    const newer = pending.markRead();
    expect(pending.readAnswered('job-n', read, newer)).toBe(true);
    expect(pending.readAnswered('job-n', gone, older)).toBe(false);
    expect(pending.archived('job-n')).toBe(false);
    expect(pending.readAnswered('job-n', read, older)).toBe(false);
  });

  it('keeps a restore read later when the archived answer to an earlier read comes back first', () => {
    pending.openFor('company-a/user-restored-late');
    const before = pending.markRead();
    // The archived job is opened; the screen closes, the job is restored on another phone and opened again.
    const older = pending.markRead();
    const newer = pending.markRead();
    expect(pending.readAnswered('job-l', gone, older)).toBe(true);
    expect(pending.archived('job-l')).toBe(true);
    expect(pending.readAnswered('job-l', read, before)).toBe(false);
    expect(pending.readAnswered('job-l', read, newer)).toBe(true);
    expect(pending.archived('job-l')).toBe(false);
    expect(pending.mark('job-l')).toBeLessThanOrEqual(newer);
  });

  it('shows the job archived as soon as any route of it answers 410, also when no read gets through after', () => {
    pending.openFor('company-a/user-archived-save');
    const before = pending.markRead();
    pending.archivedSeen('job-s');
    expect(pending.archived('job-s')).toBe(true);
    expect(pending.readAnswered('job-s', { ok: false, status: 0, message: 'No answer' }, pending.markRead())).toBe(true);
    expect(pending.archived('job-s')).toBe(true);
    expect(pending.readAnswered('job-s', read, before)).toBe(false);
    expect(pending.archived('job-s')).toBe(true);
    expect(pending.readAnswered('job-s', read, pending.markRead())).toBe(true);
    expect(pending.archived('job-s')).toBe(false);
  });

  it('starts empty for another sign-in', () => {
    pending.openFor('company-a/user-archive-1');
    pending.archivalDone('job-a', true);
    pending.openFor('company-a/user-archive-2');
    expect(pending.archived('job-a')).toBe(false);
    expect(pending.archivalsDone()).toBe(0);
  });
});

describe('text typed and not added', () => {
  const room = { field: { name: 'Den' }, number: 1 };

  it('is kept per draft, shown read only on the job\'s other drafts, and ends with the sign-in', () => {
    pending.openFor('company-a/user-typed-1');
    pending.typeRoomName('job-t', 'd1', 'Attic');
    pending.typeTask('job-t', 'd1', 'room-1', 'Tape the vent', room);
    const drafts = pending.typed('job-t');
    expect(drafts.d1).toMatchObject({ roomName: 'Attic', rooms: { 'room-1': { task: 'Tape the vent', ...room } } });
    expect(drafts.d2).toBeUndefined();
    expect(typedBefore(drafts, 'd1')).toEqual({ roomNames: [], rooms: {} });
    expect(typedBefore(drafts, 'd2')).toEqual({ roomNames: ['Attic'], rooms: { 'room-1': { tasks: ['Tape the vent'], ...room } } });
    expect(pending.typed('job-t')).toBe(drafts);
    pending.openFor('company-a/user-typed-2');
    expect(pending.typed('job-t')).toEqual({});
  });

  it('typing on one draft never changes what was typed on another', () => {
    pending.openFor('company-a/user-typed-3');
    pending.typeRoomName('job-u', 'd1', 'Attic');
    pending.typeTask('job-u', 'd1', 'room-1', 'Tape the vent', room);
    pending.typeRoomName('job-u', 'd2', 'Loft');
    pending.typeTask('job-u', 'd2', 'room-1', 'Seal the duct', room);
    const drafts = pending.typed('job-u');
    expect(drafts.d1).toMatchObject({ roomName: 'Attic', rooms: { 'room-1': { task: 'Tape the vent' } } });
    expect(drafts.d2).toMatchObject({ roomName: 'Loft', rooms: { 'room-1': { task: 'Seal the duct' } } });
    expect(typedBefore(drafts, 'd2')).toEqual({ roomNames: ['Attic'], rooms: { 'room-1': { tasks: ['Tape the vent'], ...room } } });
    expect(typedBefore(drafts, 'd3').roomNames).toEqual(['Attic', 'Loft']);
    expect(typedBefore(drafts, 'd3').rooms['room-1']!.tasks).toEqual(['Tape the vent', 'Seal the duct']);
  });

  it('is dropped when emptied', () => {
    pending.openFor('company-a/user-typed-4');
    pending.typeTask('job-v', 'd1', 'room-1', 'Tape the vent', room);
    pending.typeTask('job-v', 'd1', 'room-1', '', room);
    expect(pending.typed('job-v')).toEqual({});
  });

  it('is settled for the draft it was sent on once its room name is added: only the text that was sent goes', () => {
    pending.openFor('company-a/user-typed-5');
    pending.typeRoomName('job-w', 'd1', 'Den');
    pending.typeRoomName('job-w', 'd2', 'Den');
    pending.settleRoomName('job-w', 'd1', pending.typed('job-w').d1!.nameAt);
    expect(pending.typed('job-w').d1).toBeUndefined();
    expect(pending.typed('job-w').d2!.roomName).toBe('Den');
    const sent = pending.typed('job-w').d2!.nameAt;
    pending.typeRoomName('job-w', 'd2', 'Den and more');
    pending.settleRoomName('job-w', 'd2', sent);
    expect(pending.typed('job-w').d2!.roomName).toBe('Den and more');
  });

  it('keeps a room name erased and typed again with the same words while its add was settling', () => {
    pending.openFor('company-a/user-typed-7');
    pending.typeRoomName('job-y', 'd1', 'Den');
    const sent = pending.typed('job-y').d1!.nameAt;
    pending.typeRoomName('job-y', 'd1', '');
    pending.typeRoomName('job-y', 'd1', 'Den');
    pending.settleRoomName('job-y', 'd1', sent);
    expect(pending.typed('job-y').d1!.roomName).toBe('Den');
  });

  it('is settled when its room is removed: only the task that was sent, only on the draft it was sent on', () => {
    pending.openFor('company-a/user-typed-6');
    pending.typeTask('job-x', 'd1', 'room-1', 'Tape the vent', room);
    pending.typeTask('job-x', 'd2', 'room-1', 'Seal the duct', room);
    pending.typeTask('job-x', 'd2', 'room-2', 'Other room', { field: { name: 'Attic' }, number: 2 });
    const sent = pending.typed('job-x').d2!.rooms['room-1']!.at;
    pending.settleRoomRemoved('job-x', 'd2', 'room-1', sent);
    expect(pending.typed('job-x').d1!.rooms['room-1']!.task).toBe('Tape the vent');
    expect(Object.keys(pending.typed('job-x').d2!.rooms)).toEqual(['room-2']);
  });

  it('does not clear a draft that had no text on the removed room, nor a task typed again with the same words', () => {
    pending.openFor('company-a/user-typed-8');
    pending.typeTask('job-z', 'd1', 'room-1', 'Tape the vent', room);
    pending.settleRoomRemoved('job-z', 'd2', 'room-1', 0);
    expect(pending.typed('job-z').d1!.rooms['room-1']!.task).toBe('Tape the vent');
    const sent = pending.typed('job-z').d1!.rooms['room-1']!.at;
    pending.typeTask('job-z', 'd1', 'room-1', '', room);
    pending.typeTask('job-z', 'd1', 'room-1', 'Tape the vent', room);
    pending.settleRoomRemoved('job-z', 'd1', 'room-1', sent);
    expect(pending.typed('job-z').d1!.rooms['room-1']!.task).toBe('Tape the vent');
  });

  it('lets one room-order write at a time through for a draft, until it ends, and ends with the sign-in', () => {
    pending.openFor('company-a/user-typed-9');
    expect(pending.startRoomWrite('job-r', 'd1')).toBe(true);
    expect(pending.startRoomWrite('job-r', 'd1')).toBe(false);
    expect(pending.startRoomWrite('job-r', 'd2')).toBe(true);
    expect(pending.roomWriting('job-r', 'd1')).toBe(true);
    pending.endRoomWrite('job-r', 'd1');
    expect(pending.roomWriting('job-r', 'd1')).toBe(false);
    expect(pending.startRoomWrite('job-r', 'd1')).toBe(true);
    pending.openFor('company-a/user-typed-10');
    expect(pending.roomWriting('job-r', 'd1')).toBe(false);
  });
});

// An app update carries unsent work across its reload (S6-6): for the same person only, with the
// photo's own id and bytes, and never over work the page holds already.
describe('work kept through an app update', () => {
  const refusal = { edits: { name: 'Ann' }, message: 'Update needed' };

  it('is nothing to keep for no sign-in or no unsent work, and everything held otherwise', () => {
    pending.openFor('company-k/user-first');
    expect(pending.kept()).toBeNull();
    pending.addPhoto(JOB, { ...photo, step: 'send-failed' });
    pending.setRecord(JOB, { ...record('customer', 'c9'), sending: false });
    const kept = pending.kept();
    expect(kept?.owner).toBe('company-k/user-first');
    expect(kept?.work.photos[JOB]).toHaveLength(1);
    expect(kept?.work.records[JOB]?.changeId).toBe('c9');
  });

  it('puts the same work back for the same person, and resumes only a photo whose bytes were refused with 426', async () => {
    pending.openFor('company-k/user-second');
    pending.addPhoto(JOB, { ...photo, step: 'send-failed', updateRefused: true });
    pending.addPhoto(JOB, { ...photo, id: 'p2', step: 'send-failed', message: 'Conflict' });
    pending.addPhoto(JOB, { ...photo, id: 'p3', step: 'save-failed', message: 'Not saved' });
    pending.setRecord(JOB, { ...record('customer', 'c10'), sending: true });
    pending.setJob({ id: 'j2', draftId: 'd2', propertyAddress: '2 Main St', sending: true });
    pending.setCoordWrite(JOB, { key: 'k', at: 'a', done: 'Done', request: { kind: 'unassign', assignmentId: 'x' }, sending: true });
    const kept = pending.kept()!;
    pending.openFor('company-k/user-other');
    pending.openFor('company-k/user-second');
    expect(pending.photos(JOB)).toEqual([]);

    pending.restore('company-k/user-second', { ...kept.work, refusals: { [`${JOB}/customer`]: refusal }, jobRefusal: { propertyAddress: '3 Main St', message: 'Update needed' } });
    const [back, conflict, unsaved] = pending.photos(JOB);
    expect(back).toMatchObject({ id: 'p1', step: 'send-failed', resumed: true, draftId: 'd1' });
    expect(await back!.bytes.text()).toBe('x');
    expect(conflict).toMatchObject({ id: 'p2', step: 'send-failed', message: 'Conflict' });
    expect(conflict?.resumed).toBeUndefined();
    expect(unsaved).toMatchObject({ id: 'p3', step: 'save-failed' });
    expect(unsaved?.resumed).toBeUndefined();
    expect(pending.record(JOB)).toMatchObject({ changeId: 'c10', sending: false });
    expect(pending.refusal(JOB, 'customer')).toEqual(refusal);
    expect(pending.job()).toMatchObject({ id: 'j2', sending: false });
    expect(pending.jobRefusal()).toEqual({ propertyAddress: '3 Main St', message: 'Update needed' });
    expect(pending.coordWrite(JOB)).toMatchObject({ key: 'k', sending: false });

    pending.restore('company-k/user-second', kept.work);
    expect(pending.photos(JOB)).toHaveLength(3);
  });

  it('keeps a refused new job and nothing else as work to carry', () => {
    pending.openFor('company-k/user-fourth');
    pending.settleJob('none', 'answered');
    pending.setJob({ id: 'j3', draftId: 'd3', propertyAddress: '4 Main St', sending: true });
    pending.settleJob('j3', { refused: 'Update needed' });
    expect(pending.kept()?.work).toMatchObject({ job: null, jobRefusal: { propertyAddress: '4 Main St' } });
  });

  it('forgets the work of a discarded owner, and of that owner only', () => {
    pending.openFor('company-k/user-fifth');
    pending.addPhoto(JOB, { ...photo, step: 'send-failed' });
    pending.forget('company-k/user-other');
    expect(pending.kept()).not.toBeNull();
    pending.forget('company-k/user-fifth');
    expect(pending.kept()).toBeNull();
  });

  it('is never put back for another person of the same page', () => {
    pending.openFor('company-k/user-third');
    pending.addPhoto(JOB, { ...photo, step: 'send-failed' });
    const kept = pending.kept()!;
    pending.openFor('company-k/user-other');
    pending.restore('company-k/user-third', kept.work);
    expect(pending.photos(JOB)).toEqual([]);
    expect(pending.record(JOB)).toBeNull();
  });
});
