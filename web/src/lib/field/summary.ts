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
import { aiNotesSchema, draftFieldSchema, type AiNotes, type DraftField } from './schema';
import type { FieldChanges, FormResult } from './forms';

/** An AI proposal as the summary draft route answers it (src/lib/summary-draft/service.ts). */
export type SummaryProposal = {
  id: string;
  callId: string;
  jobId: string;
  draftId: string;
  proposal: { summary: string; suggestions: string[]; unpriced_work: string[]; testing_advice: string[] };
};

/** The three note lists of a proposal, in the order the review screen shows them. */
export const NOTE_LISTS = [
  { key: 'suggestions', from: 'suggestions', title: 'Suggestions' },
  { key: 'unpricedWork', from: 'unpriced_work', title: 'Work with no price' },
  { key: 'testingAdvice', from: 'testing_advice', title: 'Testing advice' },
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
// who wrote it. Nothing when it is what is stored.
export function summaryChanges(text: string, stored: DraftField): FormResult {
  const changes: FieldChanges = {};
  const errors: Record<string, string> = {};
  if (text.trim() === '') {
    if (stored.summary !== undefined) changes.summary = null;
    if (stored.summarySource !== undefined) changes.summarySource = null;
    return { changes, errors };
  }
  if (text === stored.summary) return { changes, errors };
  if (!draftFieldSchema.shape.summary.safeParse(text).success) {
    errors.summary = 'The summary is too long.';
    return { changes, errors };
  }
  changes.summary = text;
  if (stored.summarySource !== 'ai') changes.summarySource = 'manual';
  return { changes, errors };
}

// What the technician's Accept of an AI draft writes: the summary as they left it in the review box,
// its source `ai`, and the notes they ticked, in the proposal's order. The ticked notes replace any
// accepted with an earlier draft; with none ticked the earlier ones are removed.
export function acceptChanges(summary: string, proposal: SummaryProposal['proposal'], ticked: ReadonlySet<string>): FormResult {
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
  for (const { key } of NOTE_LISTS) {
    const kept = offered[key].filter((_, index) => ticked.has(noteId(key, index)));
    if (kept.length > 0) notes[key] = kept;
  }
  if (!aiNotesSchema.safeParse(notes).success) {
    errors.notes = 'A ticked note is too long to keep. Untick it.';
    return { changes: {}, errors };
  }
  const changes: FieldChanges = {
    summary,
    summarySource: 'ai',
    aiNotes: Object.keys(notes).length > 0 ? notes : null,
  };
  return { changes, errors };
}
