// Field map v1 (S5a-1): the `field` map of a draft, a room and a photo reference in the field
// database. The phone writes these maps directly; `web/firestore.rules` checks the same keys,
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
  category: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  unfinishedSf: area().optional(),
  finishedSf: area().optional(),
  /** The engine refuses a floor area of zero: delete the key instead. */
  floorSf: area().positive().optional(),
  wetFloorSf: area().optional(),
  wastePercent: z.number().min(0).max(100).optional(),
});

export const photoFieldSchema = z.strictObject({
  /** The room the photo was taken in; untagged when absent. */
  roomId: fieldId.optional(),
  shotTag: z.enum(SHOT_TAGS).optional(),
});

export type DraftField = z.infer<typeof draftFieldSchema>;
export type RoomField = z.infer<typeof roomFieldSchema>;
export type PhotoField = z.infer<typeof photoFieldSchema>;
