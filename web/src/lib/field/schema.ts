// Field map v3 (S5a-1, room inputs S5a-10, AI summary keys S7-6): the `field` map of a draft, a room and a photo
// reference in the field database. The phone writes these maps directly; `web/firestore.rules` checks the same keys,
// types and sizes (a unit test keeps the two key lists equal), and the server parses them again
// before pricing (`toInspection` in ./inspection.ts).
//
// Paths: companies/{c}/drafts/{d} holds the job-level facts, drafts/{d}/rooms/{roomId} one room,
// drafts/{d}/photos/{photoId} one photo reference. Every key is optional while the technician
// works; clearing a value deletes its key. Ranges follow the engine's own input checks
// (`web/src/engine/inspection.ts`), so a map that passes here is one the engine accepts.
import { z } from 'zod';

/** Most rooms on one draft; the engine refuses more than 30. */
export const MAX_ROOMS = 30;
/** Abuse-protection ceiling per draft (F5); the owner may raise it for larger evidence sets. */
export const MAX_PHOTO_REFS = 300;
/** Longest room or photo id the phone may use (it makes uuids, 36 characters). */
export const MAX_ID = 64;
export const MAX_NOTES = 40_000;
export const MAX_SUMMARY = 6_000;
export const MAX_ROOM_NAME = 100;
export const MAX_AREA_SF = 100_000;
export const MAX_COUNT = 100;
export const MAX_DAYS = 60;
export const MAX_HOURS = 500;
export const EARLIEST_YEAR = 1800;
/** Most items one room lists; the engine refuses more (MAX_ROOM_ITEMS in src/engine/inspection.ts). */
export const MAX_ROOM_ITEMS = 50;
/** Most prep tasks one room lists, and the longest one. */
export const MAX_PREP_TASKS = 10;
export const MAX_PREP_TASK = 300;
/** The longest findings note of one room. */
export const MAX_FINDINGS = 2_000;
export const MAX_CEILING_FT = 60;
/** The accepted AI notes (S7-6): the document engine's sizes (AI_NOTES in src/engine/documents.ts). */
export const MAX_AI_NOTE = 1_000;
export const MAX_AI_SUGGESTIONS = 30;
export const MAX_AI_UNPRICED_WORK = 30;
export const MAX_AI_TESTING_ADVICE = 10;

/** Who wrote the summary of findings: the technician, or an AI draft the technician accepted (S7-6). */
export const SUMMARY_SOURCES = ['manual', 'ai'] as const;

/** The categories a room may be: water categories 1 to 3, or mold. */
export const ROOM_CATEGORIES = [1, 2, 3, 'mold'] as const;
/** A room type id as the price table names one (src/engine/table.ts); none means Other. */
export const ROOM_TYPE_ID = /^[a-z][a-z0-9_]{1,29}$/;
/** A price-list item id as the price table names one (src/engine/table.ts). */
export const ITEM_ID = /^[a-z][a-z0-9_]{1,39}$/;

/** The shot list an adjuster expects in each room (the old app's backend/shot_list.py). */
export const SHOT_TAGS = ['overview', 'source', 'surface', 'meter', 'contents', 'equipment'] as const;

/** How a shot tag reads on screen and on the photo log's album headings. */
export const SHOT_NAMES: Record<(typeof SHOT_TAGS)[number], string> = {
  overview: 'Overview',
  source: 'Source of loss',
  surface: 'Affected surface',
  meter: 'Moisture meter',
  contents: 'Contents',
  equipment: 'Equipment',
};
/** The album of photos with no shot tag. */
export const UNTAGGED_ALBUM = 'Not tagged';

const ID = /^[A-Za-z0-9_-]+$/;

const count = () => z.int().min(0).max(MAX_COUNT);
const days = () => z.int().min(1).max(MAX_DAYS);
const hours = () => z.number().min(0).max(MAX_HOURS);
const area = () => z.number().min(0).max(MAX_AREA_SF);

export const fieldId = z.string().min(1).max(MAX_ID).regex(ID);

/**
 * A typed quantity as decimal text: 0 to 100,000 with at most two decimal places, as the engine
 * reads one. Text, not a number, so the field rules can check every quantity of a room with one
 * pattern (firestore.rules, okItems) and no binary fraction ever stands in for what was typed.
 */
export const ITEM_QUANTITY = /^(100000(\.0{1,2})?|\d{1,5}(\.\d{1,2})?)$/;
export const itemQuantity = z.string().regex(ITEM_QUANTITY);

/**
 * One accepted AI note: 1 to 1,000 characters on one line. One line, so the field rules can check
 * every note of a list with one pattern over the list joined by line breaks (firestore.rules,
 * okNoteList), as they check a room's items.
 */
export const aiNote = z.string().min(1).max(MAX_AI_NOTE).regex(/^[^\n]*$/, 'a note is one line');

/** The AI notes the technician ticked when accepting a summary draft (S7-6); each list is optional. */
export const aiNotesSchema = z.strictObject({
  suggestions: z.array(aiNote).max(MAX_AI_SUGGESTIONS).optional(),
  unpricedWork: z.array(aiNote).max(MAX_AI_UNPRICED_WORK).optional(),
  testingAdvice: z.array(aiNote).max(MAX_AI_TESTING_ADVICE).optional(),
});
export type AiNotes = z.infer<typeof aiNotesSchema>;

export const draftFieldSchema = z.strictObject({
  yearBuilt: z
    .int()
    .min(EARLIEST_YEAR)
    .refine((year) => year <= new Date().getUTCFullYear(), 'year built is in the future')
    .optional(),
  /** Room ids in the order the technician sees them; each names a document in `rooms`. */
  roomOrder: z
    .array(fieldId)
    .max(MAX_ROOMS)
    .refine((ids) => new Set(ids).size === ids.length, 'a room is listed twice')
    .optional(),
  notes: z.string().max(MAX_NOTES).optional(),
  /** The written summary of findings the documents need (owner decision J1). */
  summary: z.string().max(MAX_SUMMARY).optional(),
  /** `ai` once the technician accepted an AI draft of the summary (S7-6, V11), else `manual`. */
  summarySource: z.enum(SUMMARY_SOURCES).optional(),
  /** The AI notes the technician accepted with a summary draft (S7-6). */
  aiNotes: aiNotesSchema.optional(),
  scopeConfirmed: z.boolean().optional(),
  // Equipment counts and the days they run.
  airMovers: count().optional(),
  dehumidifiers: count().optional(),
  airScrubbers: count().optional(),
  dryingDays: days().optional(),
  woodFloorSystems: count().optional(),
  woodFloorDays: days().optional(),
  // Job charges.
  emergencyCalls: count().optional(),
  monitoringHours: hours().optional(),
  haulLoads: count().optional(),
  hepaFilters: count().optional(),
  matterportScans: count().optional(),
  dumpTruckLoads: count().optional(),
  equipmentDecon: count().optional(),
  powerDistribution: count().optional(),
  laborHours: hours().optional(),
  isAfterHours: z.boolean().optional(),
});

export const roomFieldSchema = z.strictObject({
  name: z.string().min(1).max(MAX_ROOM_NAME).optional(),
  /** The room type from the price list the job is priced from; absent means Other. */
  roomTypeId: z.string().regex(ROOM_TYPE_ID).optional(),
  category: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal('mold')]).optional(),
  /** Water rooms: the IICRC water class, and the ceiling height the drying suggestion needs. */
  waterClass: z.int().min(1).max(4).optional(),
  ceilingHeightFt: z.number().positive().max(MAX_CEILING_FT).optional(),
  /** Mold rooms: the condition and the affected area. */
  moldCondition: z.int().min(1).max(3).optional(),
  affectedSf: area().optional(),
  unfinishedSf: area().optional(),
  finishedSf: area().optional(),
  /** The engine refuses a floor area of zero: delete the key instead. */
  floorSf: area().positive().optional(),
  wetFloorSf: area().optional(),
  wastePercent: z.number().min(0).max(100).optional(),
  /**
   * The items typed for this room, each price-list item id with its quantity (decimal text); a map,
   * so an item is listed once. Whether each id is an item of the job's price list is the server's check, at
   * Submit and again when it prices (src/lib/scope-lists/version.ts).
   */
  items: z
    .record(z.string().regex(ITEM_ID), itemQuantity)
    .refine((items) => Object.keys(items).length <= MAX_ROOM_ITEMS, `at most ${MAX_ROOM_ITEMS} items`)
    .optional(),
  /**
   * The room's prep tasks, each the words themselves: a company template's text copied when picked
   * (so the submitted record keeps them if the template changes later) or the estimator's own.
   */
  prepTasks: z.array(z.string().min(1).max(MAX_PREP_TASK)).max(MAX_PREP_TASKS).optional(),
  /** The room's findings note. */
  findings: z.string().max(MAX_FINDINGS).optional(),
});

export const photoFieldSchema = z.strictObject({
  /** The room the photo was taken in; untagged when absent. */
  roomId: fieldId.optional(),
  shotTag: z.enum(SHOT_TAGS).optional(),
  /** Client-clock ISO 8601 timestamp recorded when the photo was taken; absent on older records. */
  capturedAt: z.iso.datetime({ offset: true }).max(40).optional(),
});

export type DraftField = z.infer<typeof draftFieldSchema>;
export type RoomField = z.infer<typeof roomFieldSchema>;
export type PhotoField = z.infer<typeof photoFieldSchema>;
