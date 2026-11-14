import type { DocumentSettings } from './settings';

// The document settings as the Company settings screen edits them (S5a-4b): the same settings, with
// each clause and prep task given a key of its own so a list row keeps its text while rows above it
// are added or removed. Pure functions, so they are unit-tested; the server checks every value again
// (src/lib/profile/settings.ts).

export type ClauseDraft = { key: number; title: string; text: string };
export type PrepTaskDraft = { key: number; text: string };
export type DocumentsDraft = Omit<DocumentSettings, 'company_clauses' | 'prep_tasks'> & {
  company_clauses: ClauseDraft[];
  prep_tasks: PrepTaskDraft[];
};

let nextKey = 1;
/** A key no other row on this page holds. */
export function newRowKey(): number {
  return nextKey++;
}

export function draftOf(settings: DocumentSettings): DocumentsDraft {
  return {
    ...settings,
    company_clauses: settings.company_clauses.map(({ title, text }) => ({ key: newRowKey(), title, text })),
    prep_tasks: settings.prep_tasks.map((text) => ({ key: newRowKey(), text })),
  };
}

/**
 * The settings a save sends. A clause or prep task left entirely blank is an empty row the owner
 * added and did not fill in, so it is left out rather than refused; anything typed is sent as typed.
 */
export function settingsOf(draft: DocumentsDraft): DocumentSettings {
  return {
    ...draft,
    company_clauses: draft.company_clauses
      .filter(({ title, text }) => title.trim() || text.trim())
      .map(({ title, text }) => ({ title, text })),
    prep_tasks: draft.prep_tasks.filter(({ text }) => text.trim()).map(({ text }) => text),
  };
}
