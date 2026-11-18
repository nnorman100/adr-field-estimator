import { describe, expect, it } from 'vitest';
import { answerMessage } from '@/lib/field/api';
import { editsAfterSave, factChanges, formOf, FACT_FIELDS, roomChanges, roomName, ROOM_FIELDS, withEdits } from '@/lib/field/forms';
import { scaledSize } from '@/lib/field/photo';
import { draftFieldSchema, roomFieldSchema } from '@/lib/field/schema';
import { defaultList, FIELD_VIEWS, hrefOf, placeOf, type FieldPlace } from '@/lib/field/views';

// The pure parts of the job screens (S5a-6): where the field app is, what a form writes to the
// field draft, the size a photo is sent at, and what a refusal says. The screens themselves are
// driven in tests/e2e/jobs.spec.ts.

const JOB = '0b8f1e2a-3c4d-4e5f-8a6b-7c8d9e0f1a2b';
const at = (query: string) => placeOf(new URLSearchParams(query));

describe('field views', () => {
  it('reads every view from the address and writes it back the same', () => {
    const places: FieldPlace[] = [
      { view: 'jobs', list: null },
      { view: 'jobs', list: 'mine' },
      { view: 'jobs', list: 'company' },
      { view: 'jobs', list: 'archived' },
      { view: 'new-job' },
      { view: 'scope', jobId: JOB },
      { view: 'customer', jobId: JOB },
      { view: 'photos', jobId: JOB },
      { view: 'coordination', jobId: JOB },
    ];
    for (const place of places) expect(at(hrefOf(place).split('?')[1] ?? '')).toEqual(place);
    expect(new Set(places.map((place) => place.view))).toEqual(new Set(FIELD_VIEWS));
  });

  it('keeps every address under /field, where the field worker serves the shell', () => {
    expect(hrefOf({ view: 'photos', jobId: JOB })).toBe(`/field?job=${JOB}&view=photos`);
    expect(hrefOf({ view: 'scope', jobId: JOB })).toBe(`/field?job=${JOB}`);
    expect(hrefOf({ view: 'jobs', list: null })).toBe('/field');
  });

  it('turns an address the app did not write into the jobs list', () => {
    expect(at('job=not-a-uuid&view=photos')).toEqual({ view: 'jobs', list: null });
    expect(at('list=everyone')).toEqual({ view: 'jobs', list: null });
    expect(at(`job=${JOB}&view=admin`)).toEqual({ view: 'scope', jobId: JOB });
    expect(at(`job=${JOB.toUpperCase()}`)).toEqual({ view: 'scope', jobId: JOB });
  });

  it('starts the owner and office on the company list and an estimator on their own', () => {
    expect(defaultList('owner')).toBe('company');
    expect(defaultList('office')).toBe('company');
    expect(defaultList('estimator')).toBe('mine');
    expect(defaultList('someone-new')).toBe('mine');
  });
});

describe('Check Scope forms', () => {
  it('covers every job-level key of field map v1 except the order and the summary', () => {
    const keys = Object.keys(draftFieldSchema.shape).filter((key) => key !== 'roomOrder' && key !== 'summary');
    expect(FACT_FIELDS.map((field) => field.key).sort()).toEqual(keys.sort());
    expect(ROOM_FIELDS.map((field) => field.key).sort()).toEqual(Object.keys(roomFieldSchema.shape).sort());
  });

  it('writes only the boxes that changed, as numbers, and deletes a box that was emptied', () => {
    const stored = { yearBuilt: 1975, airMovers: 4, notes: 'wet' };
    const values = { ...formOf(FACT_FIELDS, stored), airMovers: '6', notes: '', laborHours: '2.5', scopeConfirmed: true };
    expect(factChanges(values, stored)).toEqual({
      changes: { airMovers: 6, notes: null, laborHours: 2.5, scopeConfirmed: true },
      errors: {},
    });
  });

  it('leaves an untouched form with nothing to write', () => {
    const stored = { yearBuilt: 1990, isAfterHours: true, scopeConfirmed: false };
    expect(factChanges(formOf(FACT_FIELDS, stored), stored)).toEqual({ changes: {}, errors: {} });
  });

  it('clears a box that is unticked', () => {
    const stored = { scopeConfirmed: true };
    expect(factChanges({ ...formOf(FACT_FIELDS, stored), scopeConfirmed: false }, stored).changes).toEqual({ scopeConfirmed: null });
  });

  it('refuses what the field map refuses, and writes none of it', () => {
    const next = new Date().getUTCFullYear() + 1;
    const values = { ...formOf(FACT_FIELDS, {}), yearBuilt: String(next), airMovers: '2.5', dryingDays: '0', dehumidifiers: 'two' };
    const { changes, errors } = factChanges(values, {});
    expect(changes).toEqual({});
    expect(Object.keys(errors).sort()).toEqual(['airMovers', 'dehumidifiers', 'dryingDays', 'yearBuilt']);
  });

  it('keeps a room named, and refuses a zero floor area', () => {
    const stored = { name: 'Kitchen', floorSf: 120 };
    expect(roomChanges({ ...formOf(ROOM_FIELDS, stored), name: ' ' }, stored).errors.name).toBe('A room needs a name.');
    expect(roomChanges({ ...formOf(ROOM_FIELDS, stored), floorSf: '0' }, stored).errors.floorSf).toBeDefined();
    expect(roomChanges({ ...formOf(ROOM_FIELDS, stored), category: '3', floorSf: '' }, stored)).toEqual({
      changes: { category: 3, floorSf: null },
      errors: {},
    });
    expect(roomChanges({ ...formOf(ROOM_FIELDS, stored), category: '4' }, stored).errors.category).toBeDefined();
  });

  it('saves only what the person changed, never a stale copy of what someone else has since changed', () => {
    // The person edits air movers; meanwhile the draft is read again with another change in it.
    const edits = { airMovers: '6' };
    const readAgain = { airMovers: 4, notes: 'changed by the office', yearBuilt: 1970 };
    const shown = withEdits(FACT_FIELDS, readAgain, edits);
    expect(shown.notes).toBe('changed by the office');
    expect(factChanges(shown, readAgain).changes).toEqual({ airMovers: 6 });
    // After the save, an edit made again meanwhile stays; the one that was sent is done.
    expect(editsAfterSave({ airMovers: '6', notes: 'x' }, { airMovers: '6' })).toEqual({ notes: 'x' });
    expect(editsAfterSave({ airMovers: '7' }, { airMovers: '6' })).toEqual({ airMovers: '7' });
  });

  it('accepts a room name the field map accepts', () => {
    expect(roomName('  Hall ')).toBe('Hall');
    expect(roomName('   ')).toBeNull();
    expect(roomName('x'.repeat(101))).toBeNull();
  });
});

describe('photo size', () => {
  it('sends at most 2,560 px on the longer side, and never enlarges', () => {
    expect(scaledSize(4032, 3024)).toEqual({ width: 2560, height: 1920 });
    expect(scaledSize(3024, 4032)).toEqual({ width: 1920, height: 2560 });
    expect(scaledSize(800, 600)).toEqual({ width: 800, height: 600 });
  });
});

describe('answer messages', () => {
  it('says what a refusal means from its code only', () => {
    expect(answerMessage(0, null)).toMatch(/No answer/);
    expect(answerMessage(409, { error: 'stale_revision', revision: 4 })).toMatch(/Someone else changed/);
    expect(answerMessage(409, { error: 'draft_locked' })).toMatch(/no longer being edited/);
    expect(answerMessage(409, { error: 'photo_limit' })).toBe('This job has the most photos it can hold (300).');
    expect(answerMessage(404, { error: 'not_found' })).toMatch(/not in your list/);
    expect(answerMessage(401, { error: 'whatever <b>' })).toBe('Sign in again to continue.');
    expect(answerMessage(500, { error: 'a message with a name in it' })).toMatch(/could not do this/);
  });
});
