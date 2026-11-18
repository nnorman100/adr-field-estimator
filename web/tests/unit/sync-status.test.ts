import { describe, expect, it } from 'vitest';
import type { DocWrite, JournalEntry, JournalState, RejectReason } from '@/lib/field/journal';
import { copyWrites, newDraftIds } from '@/lib/field/new-draft';
import { chipText, syncStatus, type DraftFacts } from '@/lib/field/sync-status';

// What the field screens' sync chip and "Can't save" sheet offer (S6-4b; docs/plans/S6/S6-4.md),
// and what Save as new draft writes.
const DRAFT = 'companies/c/drafts/d';
let seq = 0;
function entry(state: JournalState, reason?: RejectReason, writes: DocWrite[] = [{ path: DRAFT, op: 'update', fields: { 'field.notes': 'x' } }]): JournalEntry {
  seq += 1;
  return { seq, id: `op${seq}`, tenantId: 't', uid: 'ana', draftPath: DRAFT, writes, at: seq, state, ...(reason ? { reason } : {}) };
}
const facts = (state: string | null) => new Map<string, DraftFacts>([[DRAFT, { state, jobId: 'job-1' }]]);

describe('the sync chip', () => {
  it('says Saved, then Saved on this phone with a count while entries wait', () => {
    expect(chipText(syncStatus([], facts(null), true))).toBe('Saved');
    expect(chipText(syncStatus([entry('pending'), entry('pending')], facts(null), true))).toBe('Saved on this phone (2 waiting to send)');
  });

  it.each([
    ['submitted', 'locked', 'finished', 'job finished', false, false],
    ['archived', 'locked', 'archived', 'job archived', true, true],
    ['editing', 'owner-changed', 'owner-changed', 'another person owns it', true, true],
    ['editing', 'role-changed', 'role-changed', 'your role changed', false, true],
    [null, 'no-access', 'no-access', 'no access', false, true],
  ] as const)('a draft %s refused as %s is Can’t save: %s', (state, reason, kind, short, saveAsNew, tryAgain) => {
    const status = syncStatus([entry('rejected', reason)], facts(state), true);
    expect(chipText(status)).toBe(`Can’t save: ${short}`);
    expect(status).toMatchObject({ kind: 'cant-save', problems: [{ reason: kind, saveAsNew, tryAgain, jobId: 'job-1' }] });
  });

  it('offers Save as new draft only to someone who may start a job', () => {
    expect(syncStatus([entry('rejected', 'owner-changed')], facts('editing'), false)).toMatchObject({ problems: [{ saveAsNew: false }] });
  });

  it('a refusal whose reason is not known yet is Can’t save, checked online', () => {
    expect(chipText(syncStatus([entry('refused')], facts(null), true))).toBe('Can’t save: checking why');
  });

  it('a different value with no refusal is Changed on another device, never Can’t save', () => {
    const status = syncStatus([entry('changed'), entry('pending')], facts('editing'), true);
    expect(chipText(status)).toBe('Changed on another device');
    expect(status).toMatchObject({ kind: 'changed', problems: [{ reason: 'changed', saveAsNew: false, tryAgain: false }] });
  });
});

describe('Save as new draft', () => {
  it('makes the same new ids from the same entries, and others from other entries', async () => {
    const owner = { tenantId: 't', uid: 'ana' };
    const [a, b] = [entry('rejected', 'locked'), entry('rejected', 'locked')];
    const first = await newDraftIds(owner, [a, b]);
    expect(await newDraftIds(owner, [b, a])).toEqual(first);
    expect(first.jobId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first.draftId).not.toBe(first.jobId);
    expect(await newDraftIds(owner, [a])).not.toEqual(first);
    expect(await newDraftIds({ tenantId: 't', uid: 'ben' }, [a, b])).not.toEqual(first);
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
});
