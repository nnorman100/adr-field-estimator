// The summary of findings on Check Scope (owner decision J1) and the AI draft of it (S7-6): what a
// save of the summary box and an accept of an AI draft write to the field map (v3, ./schema.ts).
// The phone writes these keys itself, under the field rules; nothing here sends anything.
//
// Who wrote the summary is kept in `summarySource`, which the documents read for the AI notice
// (docs/plans/S7.md V11, a later S7-6 slice): `ai` from the technician's accept of an AI draft,
// `manual` for a summary they typed with no AI draft accepted. Editing an accepted AI draft keeps
// `ai`: it is still an AI draft the technician checked. Emptying the box deletes the summary and its
// source. An AI draft reaches the field map only through `acceptChanges`, called by the technician's
// Accept; the server route that drafts it never writes the draft.
import type { SummaryProposal } from '@/lib/summary-draft/service';
import { aiNotesSchema, draftFieldSchema, MAX_AI_SUGGESTIONS, MAX_AI_TESTING_ADVICE, MAX_AI_UNPRICED_WORK, type AiNotes, type DraftField } from './schema';
import type { FieldChanges, FormResult } from './forms';

/** An AI proposal as the summary draft route answers it: the server's own type, never its code. */
export type { SummaryProposal };

/** The three note lists of a proposal, in the order the review screen shows them. */
export const NOTE_LISTS = [
  { key: 'suggestions', from: 'suggestions', title: 'Suggestions', max: MAX_AI_SUGGESTIONS },
  { key: 'unpricedWork', from: 'unpriced_work', title: 'Work with no price', max: MAX_AI_UNPRICED_WORK },
  { key: 'testingAdvice', from: 'testing_advice', title: 'Testing advice', max: MAX_AI_TESTING_ADVICE },
] as const;

export type NoteKey = (typeof NOTE_LISTS)[number]['key'];

/** A ticked note: its list and its place in the proposal's list. */
export const noteId = (key: NoteKey, index: number) => `${key}-${index}`;

/** A note as the field map keeps it: one line (the field rules check every note with one pattern). */
const LINE_BREAKS = new RegExp(`[\\r\\n${String.fromCharCode(0x2028, 0x2029)}]+`, 'g');
export const oneLine = (note: string) => note.replace(LINE_BREAKS, ' ').trim();

/** The notes of a proposal the review screen offers: one line each, empty ones left out. */
export function proposalNotes(proposal: SummaryProposal['proposal']): Record<NoteKey, string[]> {
  const notes = {} as Record<NoteKey, string[]>;
  for (const { key, from } of NOTE_LISTS) notes[key] = proposal[from].map(oneLine).filter((note) => note);
  return notes;
}

// What a save of the summary box writes: the text as typed (or a delete when it is left empty), and
// who wrote it, always together, so a save from a stale copy never leaves a summary without its
// source or a source without its summary. Nothing when it is what is stored.
export function summaryChanges(text: string, stored: DraftField): FormResult {
  const changes: FieldChanges = {};
  const errors: Record<string, string> = {};
  if (text.trim() === '') {
    if (stored.summary !== undefined || stored.summarySource !== undefined) {
      changes.summary = null;
      changes.summarySource = null;
    }
    return { changes, errors };
  }
  if (text === stored.summary) return { changes, errors };
  if (!draftFieldSchema.shape.summary.safeParse(text).success) {
    errors.summary = 'The summary is too long.';
    return { changes, errors };
  }
  changes.summary = text;
  changes.summarySource = stored.summarySource === 'ai' ? 'ai' : 'manual';
  return { changes, errors };
}

// What the technician's Accept of an AI draft writes: the summary as they left it in the review box,
// its source `ai`, and the notes they ticked, in the proposal's order, added to the notes accepted
// with an earlier draft (`accepted`): each list keeps its earlier notes first, an identical note is
// kept once, and an earlier note is never removed. A list that would pass its size refuses the
// accept and writes nothing.
export function acceptChanges(
  summary: string,
  proposal: SummaryProposal['proposal'],
  ticked: ReadonlySet<string>,
  accepted: AiNotes,
): FormResult {
  const errors: Record<string, string> = {};
  if (summary.trim() === '') {
    errors.summary = 'The drafted summary is empty. Write it, or discard the draft.';
    return { changes: {}, errors };
  }
  if (!draftFieldSchema.shape.summary.safeParse(summary).success) {
    errors.summary = 'The summary is too long.';
    return { changes: {}, errors };
  }
  const offered = proposalNotes(proposal);
  const notes: AiNotes = {};
  for (const { key, title, max } of NOTE_LISTS) {
    const kept = offered[key].filter((_, index) => ticked.has(noteId(key, index)));
    const merged = [...new Set([...(accepted[key] ?? []), ...kept])];
    if (merged.length > max) {
      errors.notes = `The ${title.toLowerCase()} list is full (${max} notes). Untick some notes.`;
      return { changes: {}, errors };
    }
    if (merged.length > 0) notes[key] = merged;
  }
  if (!aiNotesSchema.safeParse(notes).success) {
    errors.notes = 'A ticked note is too long to keep. Untick it.';
    return { changes: {}, errors };
  }
  const changes: FieldChanges = {
    summary,
    summarySource: 'ai',
    ...(Object.keys(notes).length > 0 ? { aiNotes: notes } : {}),
  };
  return { changes, errors };
}
