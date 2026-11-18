import { describe, expect, it } from 'vitest';
import {
  appendEntry,
  draftRefusal,
  heldOf,
  journalInMemory,
  readJournal,
  rejectEntry,
  removeEntry,
  retryVerdict,
  watchJournal,
  type DocWrite,
  type JournalEntry,
  type JournalState,
  type RejectReason,
} from '@/lib/field/journal';
import { copyWrites, newDraftIds } from '@/lib/field/new-draft';
import { chipText, syncStatus } from '@/lib/field/sync-status';

// What the field screens' sync chip and "Can't save" sheet offer (S6-4b; docs/plans/S6/S6-4.md),
// what Save as new draft writes, and what Try again sends.
const DRAFT = 'companies/c/drafts/d';
const OTHER = 'companies/c/drafts/e';
let seq = 0;
function entry(state: JournalState, reason?: RejectReason, writes: DocWrite[] = [{ path: DRAFT, op: 'update', fields: { 'field.notes': 'x' } }], draftPath = DRAFT): JournalEntry {
  seq += 1;
  return { seq, id: `op${seq}`, tenantId: 't', uid: 'ana', draftPath, writes, at: seq, state, jobId: draftPath === DRAFT ? 'job-1' : 'job-2', ...(reason ? { reason } : {}) };
}

describe('the sync chip', () => {
  it('says Saved, then Saved on this phone with a count while entries wait', () => {
    expect(chipText(syncStatus([], true))).toBe('Saved');
    expect(chipText(syncStatus([entry('pending'), entry('pending')], true))).toBe('Saved on this phone (2 waiting to send)');
  });

  it.each([
    ['locked', 'finished', 'job finished', false, false],
    ['archived', 'archived', 'job archived', true, true],
    ['owner-changed', 'owner-changed', 'another person owns it', true, true],
    ['role-changed', 'role-changed', 'your role changed', false, true],
    ['no-access', 'no-access', 'no access', false, true],
  ] as const)('an edit refused as %s is Can’t save: %s', (reason, kind, short, saveAsNew, tryAgain) => {
    const status = syncStatus([entry('rejected', reason)], true);
    expect(chipText(status)).toBe(`Can’t save: ${short}`);
    expect(status).toMatchObject({ kind: 'cant-save', problems: [{ reason: kind, saveAsNew, tryAgain, jobId: 'job-1' }] });
  });

  it('offers Save as new draft only to someone who may start a job', () => {
    expect(syncStatus([entry('rejected', 'owner-changed')], false)).toMatchObject({ problems: [{ saveAsNew: false }] });
  });

  it('a refusal whose reason is not known yet is Can’t save, checked online', () => {
    expect(chipText(syncStatus([entry('refused')], true))).toBe('Can’t save: checking why');
  });

  it('a different value with no refusal is Changed on another device, never Can’t save', () => {
    const status = syncStatus([entry('changed'), entry('pending')], true);
    expect(chipText(status)).toBe('Changed on another device');
    expect(status).toMatchObject({ kind: 'changed', waiting: 1, problems: [{ reason: 'changed', saveAsNew: false, tryAgain: false }] });
  });

  it('keeps every set of edits for the sheet while the chip says the most urgent', () => {
    const status = syncStatus([entry('rejected', 'archived'), entry('changed', undefined, undefined, OTHER), entry('pending')], true);
    expect(chipText(status)).toBe('Can’t save: job archived');
    expect(status).toMatchObject({
      kind: 'cant-save',
      waiting: 1,
      problems: [
        { draftPath: DRAFT, reason: 'archived', jobId: 'job-1' },
        { draftPath: OTHER, reason: 'changed', jobId: 'job-2' },
      ],
    });
  });
});

describe('archived or finished, from the server’s copy of the draft', () => {
  const draft = (more: Record<string, unknown>) => ({ data: { fieldOwnerUid: 'ana', field: {}, ...more } });

  it('a job archived while its draft was being edited is archived: Save as new draft', () => {
    expect(draftRefusal(draft({ state: 'archived' }), 'ana', 'estimator')).toBe('archived');
  });

  it('a job finished by the person and archived after is still finished: Back to editing, never a new draft', () => {
    const fence = { submissionId: 's', epoch: 'e', expiresAt: new Date() };
    expect(draftRefusal(draft({ state: 'archived', fence }), 'ana', 'estimator')).toBe('locked');
    expect(draftRefusal(draft({ state: 'submitted', fence }), 'ana', 'estimator')).toBe('locked');
    expect(syncStatus([entry('rejected', 'locked')], true)).toMatchObject({ problems: [{ reason: 'finished', saveAsNew: false, tryAgain: false }] });
  });
});

describe('Save as new draft', () => {
  it('makes the same new ids for every try of one draft, whatever edits it holds, and others for another draft or person', async () => {
    const owner = { tenantId: 't', uid: 'ana' };
    const first = await newDraftIds(owner, DRAFT);
    expect(await newDraftIds(owner, DRAFT)).toEqual(first);
    expect(first.jobId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first.draftId).not.toBe(first.jobId);
    expect(await newDraftIds(owner, OTHER)).not.toEqual(first);
    expect(await newDraftIds({ tenantId: 't', uid: 'ben' }, DRAFT)).not.toEqual(first);
  });

  it('copies the cached draft and rooms, then the refused edits, onto the new draft, without photos or the scope approval', () => {
    const NEW = 'companies/c/drafts/n';
    const edits = entry('rejected', 'owner-changed', [
      { path: `${DRAFT}/rooms/r2`, op: 'set', data: { field: { name: 'Hall' } } },
      { path: DRAFT, op: 'update', fields: { 'field.roomOrder': ['r1', 'r2'], 'field.scopeConfirmed': true } },
      { path: `${DRAFT}/photos/p1`, op: 'set', data: { field: { capturedAt: 'now' } } },
    ]);
    const cached = { field: { yearBuilt: 1962, roomOrder: ['r1'], scopeConfirmed: true }, rooms: [{ id: 'r1', field: { name: 'Kitchen' } }] };
    expect(copyWrites(cached, [edits], DRAFT, NEW)).toEqual([
      { path: NEW, op: 'update', fields: { 'field.yearBuilt': 1962, 'field.roomOrder': ['r1'] } },
      { path: `${NEW}/rooms/r1`, op: 'set', data: { field: { name: 'Kitchen' } } },
      { path: `${NEW}/rooms/r2`, op: 'set', data: { field: { name: 'Hall' } } },
      { path: NEW, op: 'update', fields: { 'field.roomOrder': ['r1', 'r2'] } },
    ]);
  });

  it('copies nothing when the room order it ends with names a room the phone does not hold', () => {
    const NEW = 'companies/c/drafts/n';
    const year = entry('rejected', 'archived', [{ path: DRAFT, op: 'update', fields: { 'field.yearBuilt': 1962 } }]);
    expect(copyWrites({ field: { roomOrder: ['r1'] }, rooms: [] }, [year], DRAFT, NEW)).toBeNull();
    const removed = entry('rejected', 'archived', [
      { path: `${DRAFT}/rooms/r1`, op: 'delete' },
      { path: DRAFT, op: 'update', fields: { 'field.roomOrder': ['r1'] } },
    ]);
    expect(copyWrites({ field: {}, rooms: [{ id: 'r1', field: { name: 'Kitchen' } }] }, [removed], DRAFT, NEW)).toBeNull();
  });
});

describe('Try again', () => {
  const ROOM = (id: string) => `${DRAFT}/rooms/${id}`;
  // An edit made against what `docs` held, as the field screens journal it.
  function made(writes: DocWrite[], docs: Record<string, Record<string, unknown> | null>): JournalEntry {
    return { ...entry('rejected', 'owner-changed', writes), before: heldOf(writes, new Map(Object.entries(docs))) };
  }
  const server = (docs: Record<string, Record<string, unknown> | null>) => new Map(Object.entries(docs));

  it('sends the edits while the server holds what they were made against, though the draft was moved away and back', () => {
    const draft = { state: 'editing', fieldOwnerUid: 'ana', field: { roomOrder: ['r1', 'r2'] } };
    const removal = made([{ path: ROOM('r2'), op: 'delete' }, { path: DRAFT, op: 'update', fields: { 'field.roomOrder': ['r1'] } }], { [DRAFT]: draft, [ROOM('r2')]: { field: { name: 'Hall' } } });
    // The transfer and the transfer back changed only the server's own keys.
    expect(retryVerdict([removal], server({ [DRAFT]: { ...draft, fieldOwnerRevision: 3 }, [ROOM('r2')]: { field: { name: 'Hall' } } }))).toBe('write');
  });

  it('keeps them as changed when another person added a room since: the old room order is never sent over it', () => {
    const draft = { state: 'editing', fieldOwnerUid: 'ana', field: { roomOrder: ['r1', 'r2'] } };
    const removal = made([{ path: ROOM('r2'), op: 'delete' }, { path: DRAFT, op: 'update', fields: { 'field.roomOrder': ['r1'] } }], { [DRAFT]: draft, [ROOM('r2')]: { field: { name: 'Hall' } } });
    const bens = server({ [DRAFT]: { ...draft, field: { roomOrder: ['r1', 'r2', 'r3'] } }, [ROOM('r2')]: { field: { name: 'Hall' } } });
    expect(retryVerdict([removal], bens)).toBe('changed');
  });

  it('keeps them as changed when a room they write was deleted or renamed since, or what they were made against is not known', () => {
    const rename = made([{ path: ROOM('r1'), op: 'update', fields: { 'field.name': 'Den' } }], { [ROOM('r1')]: { field: { name: 'Kitchen' } } });
    expect(retryVerdict([rename], server({ [ROOM('r1')]: null }))).toBe('changed');
    expect(retryVerdict([rename], server({ [ROOM('r1')]: { field: { name: 'Pantry' } } }))).toBe('changed');
    const unknown: JournalEntry = { ...rename };
    delete unknown.before;
    expect(retryVerdict([unknown], server({ [ROOM('r1')]: { field: { name: 'Kitchen' } } }))).toBe('changed');
  });

  it('judges each edit against the server with the earlier ones made on top, as the phone made them', () => {
    const first = made([{ path: DRAFT, op: 'update', fields: { 'field.notes': 'one' } }], { [DRAFT]: { field: { notes: 'old' } } });
    const second = made([{ path: DRAFT, op: 'update', fields: { 'field.notes': 'two' } }], { [DRAFT]: { field: { notes: 'one' } } });
    expect(retryVerdict([second, first], server({ [DRAFT]: { field: { notes: 'old' } } }))).toBe('write');
  });

  it('sends nothing more when the server already holds what they write (an earlier try landed)', () => {
    const year = made([{ path: DRAFT, op: 'update', fields: { 'field.yearBuilt': 1962 } }], { [DRAFT]: { field: {} } });
    expect(retryVerdict([year], server({ [DRAFT]: { field: { yearBuilt: 1962 } } }))).toBe('held');
  });
});

describe('an Online only phone’s journal', () => {
  it('is held in this page’s memory: the chip is told of each edit, its refusal and its acknowledgement', async () => {
    const owner = { tenantId: 'mem', uid: 'ana' };
    journalInMemory(owner);
    let told = 0;
    const stop = watchJournal(owner, () => (told += 1));
    const writes: DocWrite[] = [{ path: DRAFT, op: 'update', fields: { 'field.notes': 'x' } }];
    const made = await appendEntry(owner, DRAFT, writes, {}, { jobId: 'job-1' });
    expect(chipText(syncStatus(await readJournal(owner), true))).toBe('Saved on this phone (1 waiting to send)');
    await rejectEntry(made, 'archived');
    expect(chipText(syncStatus(await readJournal(owner), true))).toBe('Can’t save: job archived');
    await removeEntry(made);
    expect(chipText(syncStatus(await readJournal(owner), true))).toBe('Saved');
    expect(told).toBe(3);
    stop();
  });
});
