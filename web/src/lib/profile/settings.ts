import { z } from 'zod';

// The company's document settings (S5a-4b, docs/plans/S5.md): one jsonb object on the company's row
// (`profile_documents`, migration 0013), checked by this one schema when the owner saves it and
// again whenever it is read, as a price version is. SQL holds only that it is an object under
// 64 KiB. Every key has a neutral default, so '{}' (every company's starting value) reads as the
// itemized proposal, no clauses or prep tasks, photos grouped by room, no authorization or payment
// terms and no previous price. No company's own wording is a default; each company enters its own.
//
// Line prices on the proposal are the price table's existing `show_line_breakdown` setting, so they
// are not repeated here. The steps that print these are S5a-9b (layout, clauses, prep tasks),
// S5a-9c (photo log grouping), S5a-10 (prep tasks on Check Scope), S5a-11 (authorization and
// payment terms on the signed page) and S5b-6 (previous price).

export const PROPOSAL_LAYOUTS = ['itemized', 'letter'] as const;
export const PHOTO_LOG_GROUPINGS = ['room', 'shot_tag'] as const;

export const DOCUMENT_LIMITS = {
  clauses: 10,
  clauseTitle: 120,
  clauseText: 2_000,
  prepTasks: 30,
  prepTask: 300,
  signingText: 4_000,
  // The settings as JSON text, in UTF-8 bytes. The database's check is under 64 KiB (65,536) of
  // jsonb's own text form, which adds a space after each ':' and ','; this limit leaves room for
  // those, so settings that pass here are never refused by the database.
  bytes: 64_000,
} as const;

// One line: no control character at all, so it cannot carry a line break into a heading or a list.
const LINE_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
// Paragraphs: line breaks (\n) are kept as entered; every other control character is refused.
const TEXT_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;
// Half of a UTF-16 surrogate pair on its own, which jsonb cannot store.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

const clean = (control: RegExp) => (value: string) => !control.test(value) && !LONE_SURROGATE.test(value);

// Text is kept exactly as entered, spaces and line breaks included, since it prints as entered.
// Where it must say something, it must hold more than blank space.
const notBlank = (value: string) => value.trim().length > 0;
const line = (max: number) => z.string().max(max).refine(notBlank).refine(clean(LINE_CONTROL));
const text = (max: number) => z.string().max(max).refine(clean(TEXT_CONTROL));

export const companyClause = z.strictObject({
  title: line(DOCUMENT_LIMITS.clauseTitle),
  text: text(DOCUMENT_LIMITS.clauseText).refine(notBlank),
});

const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

export const documentSettings = z
  .strictObject({
    proposal_layout: z.enum(PROPOSAL_LAYOUTS).default('itemized'),
    company_clauses: z.array(companyClause).max(DOCUMENT_LIMITS.clauses).default([]),
    prep_tasks: z.array(line(DOCUMENT_LIMITS.prepTask)).max(DOCUMENT_LIMITS.prepTasks).default([]),
    photo_log_grouping: z.enum(PHOTO_LOG_GROUPINGS).default('room'),
    authorization_text: text(DOCUMENT_LIMITS.signingText).default(''),
    payment_terms_text: text(DOCUMENT_LIMITS.signingText).default(''),
    show_previous_price: z.boolean().default(false),
  })
  .refine((value) => byteLength(value) <= DOCUMENT_LIMITS.bytes);

export type DocumentSettings = z.output<typeof documentSettings>;
export type CompanyClause = DocumentSettings['company_clauses'][number];
export const DOCUMENT_SETTING_KEYS = [
  'proposal_layout',
  'company_clauses',
  'prep_tasks',
  'photo_log_grouping',
  'authorization_text',
  'payment_terms_text',
  'show_previous_price',
] as const satisfies readonly (keyof DocumentSettings)[];

/** Every setting at its neutral default: what a new company starts with. */
export function neutralDocumentSettings(): DocumentSettings {
  return documentSettings.parse({});
}

/**
 * The stored settings, read through the one schema. Settings that do not parse are never used: the
 * read fails (the route answers 503), as a price version that does not parse is never priced from.
 */
export function readDocumentSettings(stored: unknown): DocumentSettings {
  return documentSettings.parse(stored);
}

/** The settings keys whose values differ, in schema order. */
export function changedDocumentSettings(before: DocumentSettings, after: DocumentSettings): string[] {
  return DOCUMENT_SETTING_KEYS.filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}
