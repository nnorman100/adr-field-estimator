import { z } from 'zod';
import type { AiRequest } from '@/lib/ai/call';
import { NO_IDENTITY, promptFacts, type JobIdentity } from '@/lib/ai/prompt-facts';
import { stripSentences } from '@/lib/ai/rules';
import { draftFieldSchema, roomFieldSchema, type DraftField, type RoomField } from '@/lib/field/schema';
import type { FieldManifest } from '@/lib/field/canonical';

// The findings summary draft request (docs/plans/S7.md, step S7-6): the facts the model gets, the
// output it must give, and the server rules that run on it. The route (./service.ts) and the summary
// evaluation (web/tests/ai-evals/runner.ts) both build their request here, so the eval measures the
// request the route sends.
//
// Facts: the draft's field map and rooms (field map v2), the number of photos, the walkthrough turns
// that passed screening, the voice-note transcripts the technician reviewed, and the meter readings
// the technician accepted. The job's saved customer name and address are never read into them, and
// every string goes through the shared prompt builder (web/src/lib/ai/prompt-facts.ts), which removes
// that name, the address parts and anything shaped like coordinates a technician typed into free
// text, before Model Armor or the model sees it. The technician's current summary is left out: it is
// the field being drafted. The age rule line comes first, as the old prompt gave it.

// The old app's limits (backend/contracts.py AIResult): each item at most 1,000 characters.
export const MAX_SUMMARY_TEXT = 6_000;
export const MAX_ITEM = 1_000;
export const MAX_SUGGESTIONS = 30;
export const MAX_UNPRICED = 30;
export const MAX_TESTING_ADVICE = 10;

// The year the pre-1978 rule turns on (docs/ARCHITECTURE.md, California clauses).
export const TESTING_YEAR = 1978;

const item = z.string().max(MAX_ITEM);

export const summaryDraftOutput = z.strictObject({
  summary: z.string().min(1).max(MAX_SUMMARY_TEXT),
  suggestions: z.array(item).max(MAX_SUGGESTIONS),
  unpriced_work: z.array(item).max(MAX_UNPRICED),
  testing_advice: z.array(item).max(MAX_TESTING_ADVICE).default([]),
});
export type SummaryDraftOutput = z.infer<typeof summaryDraftOutput>;

export type SummaryRoomFacts = RoomField & { photoCount: number };

export type SummaryFacts = {
  inspection: Omit<DraftField, 'summary' | 'roomOrder'> & { rooms: SummaryRoomFacts[] };
  photoCount: number;
  // Words said on the walkthrough that passed screening, in order (S7-12; none until then).
  walkthrough: { speaker: 'technician' | 'assistant'; text: string }[];
  // Voice-note transcripts the technician reviewed (S7-9; none until then).
  voiceNotes: string[];
  // Meter readings the technician accepted (S7-8, field map v3; none until then).
  meterReadings: { roomName: string | null; value: string; unit: string }[];
};

export class SummaryFactsError extends Error {
  constructor() {
    super('The draft does not match the field map.');
    this.name = 'SummaryFactsError';
  }
}

// The facts of an editing draft, from its field map and nested documents. A map the field rules
// would refuse, or a room order that does not list the room documents exactly (as Submit requires,
// src/lib/field/inspection.ts), throws SummaryFactsError.
export function summaryFacts(
  manifest: FieldManifest,
  extra: Pick<SummaryFacts, 'walkthrough' | 'voiceNotes' | 'meterReadings'>,
): SummaryFacts {
  const draft = draftFieldSchema.safeParse(manifest.draft ?? {});
  if (!draft.success) throw new SummaryFactsError();
  const { roomOrder = [], ...inspection } = draft.data;
  // The technician's own summary is the field being drafted, so the model does not get it.
  delete inspection.summary;
  const byId = new Map(manifest.rooms.map((room) => [room.id, room.field ?? {}]));
  if (roomOrder.length !== byId.size || roomOrder.some((id) => !byId.has(id))) throw new SummaryFactsError();
  const photosIn = new Map<string, number>();
  for (const photo of manifest.photos) {
    const roomId = (photo.field as { roomId?: unknown } | null)?.roomId;
    if (typeof roomId === 'string') photosIn.set(roomId, (photosIn.get(roomId) ?? 0) + 1);
  }
  const rooms = roomOrder.map((id): SummaryRoomFacts => {
    const room = roomFieldSchema.safeParse(byId.get(id));
    if (!room.success) throw new SummaryFactsError();
    return { ...room.data, photoCount: photosIn.get(id) ?? 0 };
  });
  return { inspection: { ...inspection, rooms }, photoCount: manifest.photos.length, ...extra };
}

// JSON.stringify leaves these two line separators as they are; escaped, the facts stay one block.
const LINE_SEPARATORS = new RegExp(`[${String.fromCharCode(0x2028, 0x2029)}]`, 'g');

// The text after the instruction, as the old audit_prompt built it: the age rule, then the evidence
// as JSON, cleaned by the shared prompt builder. JSON escapes every line break in a value, so no note
// can start a line of its own. With no year built the rule is left unresolved: the app needs the year
// to decide, and the model is not told testing is exempt.
export function summaryFactsText(facts: SummaryFacts, identity: JobIdentity = NO_IDENTITY): string {
  const year = facts.inspection.yearBuilt;
  const rule =
    year === undefined
      ? 'App age rule: the year built is not recorded, so the app has not determined whether lead/asbestos testing is required before demolition.'
      : `App age rule: the home was built in ${year}, so the app ${year < TESTING_YEAR ? 'requires' : 'does not require'} lead/asbestos testing before demolition.`;
  const json = JSON.stringify(promptFacts(facts, identity)).replace(
    LINE_SEPARATORS,
    (separator) => `\\u${separator.charCodeAt(0).toString(16)}`,
  );
  return `${rule}\nInspection evidence (JSON):\n${json}`;
}

// A sentence of lead or asbestos testing advice: it names asbestos or lead ("lead" as a word, so
// "leads to" or "mislead" do not count) and a test, check, inspection, sample, survey or abatement
// ("have the drywall checked for asbestos" is advice), and it is not a finding about a test already
// done ("a prior asbestos test was negative", "no asbestos was found").
const HAZARD = /\b(?:asbestos|lead)\b/i;
const TESTING =
  /\b(?:test(?:s|ed|ing)?|check(?:s|ed|ing)?|inspect(?:s|ed|ing|ion|ions)?|sampl(?:e|es|ed|ing)|survey(?:s|ed|ing)?|abatement)\b/i;
const FINDING =
  /\b(?:was|were|came back|tested|showed|found|returned|is|are)\s+(?:\w+\s+){0,3}?(?:negative|positive|clear|non-?detect(?:ed)?)\b|\b(?:prior|previous|earlier|existing|past)\s+(?:\w+\s+){0,2}?(?:tests?|testing|reports?|surveys?|results?|inspections?)\b|\bno\s+(?:asbestos|lead)\b(?:\s+\w+){0,4}?\s+(?:found|detected)\b/i;
export function advisesTesting(sentence: string): boolean {
  return HAZARD.test(sentence) && TESTING.test(sentence) && !FINDING.test(sentence);
}

const kept = (lines: readonly string[]) => lines.map((line) => line.trim()).filter((line) => line.length > 0);

// The summary's own server rules, after the boundary's price rule (S7-6: testing advice kept only
// when the year built is before 1978; owner decisions of 2026-11-17). Lead and asbestos testing advice
// stays only when the year built is known and before 1978. Otherwise (1978 or later, or not recorded)
// the testing advice field is emptied and every advising sentence is dropped from the summary,
// suggestions and unpriced work; a finding about a test already done stays. An item a rule emptied is
// dropped.
export function summaryRules(yearBuilt: number | undefined) {
  const before = yearBuilt !== undefined && yearBuilt < TESTING_YEAR;
  const clean = (text: string) => (before ? text : stripSentences(text, advisesTesting));
  return (output: SummaryDraftOutput): SummaryDraftOutput => ({
    summary: clean(output.summary).trim(),
    suggestions: kept(output.suggestions.map(clean)),
    unpriced_work: kept(output.unpriced_work.map(clean)),
    testing_advice: before ? kept(output.testing_advice) : [],
  });
}

// `identity` is the job's saved customer name and address, removed from the facts wherever typed.
export function summaryDraftRequest(
  facts: SummaryFacts,
  options: { callId?: string; identity?: JobIdentity } = {},
): AiRequest<SummaryDraftOutput> {
  const { callId, identity = NO_IDENTITY } = options;
  return {
    feature: 'summary_draft',
    facts: summaryFactsText(facts, identity),
    schema: summaryDraftOutput,
    rules: summaryRules(facts.inspection.yearBuilt),
    ...(callId === undefined ? {} : { callId }),
  };
}
