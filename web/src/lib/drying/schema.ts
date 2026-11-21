import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '@/lib/field/canonical';
import { fieldId } from '@/lib/field/schema';

// The drying log's request and answer shapes (S5b-10 slice 10B). Each reading kind is the strict
// variant of the old app's contracts (backend/contracts.py, AirReading, MaterialReading and
// ThermalReading) and accepts exactly what the database's payload check (0020,
// drying_reading_payload_ok) stores: no other key, and never an air value, which only the server works
// out (psychrometrics.ts). The text rules are the database's own, so a text this lets through is one
// the checks keep; a value they refuse anyway answers 400.

export const MAX_READINGS = 400;
export const MAX_NOTE = 500;
export const MAX_BOUNDARY = 300;
export const MAX_MATERIAL = 100;
export const MAX_UNIT = 20;
export const MAX_ROOM_LABEL = 100;

export const AIR_ZONES = ['outside', 'unaffected', 'affected', 'dehu_inlet', 'dehu_outlet'] as const;
export const THERMAL_PATTERNS = ['cold_anomaly', 'thermal_bridge', 'evaporative_cooling'] as const;

// The database's whitespace class (0020, drying_nonblank): Unicode spaces count as blank.
const NONBLANK = /[^ \t\n\v\f\r\u0085\u00a0\u1680\u180e\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]/;
// One line (drying_line_ok): no control character. A note (drying_note_ok): tab, line feed and
// carriage return allowed, no other control character.
const LINE_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const NOTE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

// Half of a UTF-16 surrogate pair on its own, which jsonb cannot store.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** Whether a text has a character that is not whitespace, by the database's class. */
export const nonblank = (value: string) => NONBLANK.test(value);

/** Characters as the database counts them (code points, not UTF-16 units). */
const characters = (value: string) => [...value].length;

/** One line a person reads back: 1 to `max` characters, not blank, no control character. */
export const lineText = (max: number) =>
  z.string().refine((value) => characters(value) >= 1 && characters(value) <= max && NONBLANK.test(value) && !LINE_CONTROL.test(value) && !LONE_SURROGATE.test(value));

/** A note: at most `max` characters, line breaks and tabs allowed, no other control character. */
export const noteText = (max: number) => z.string().refine((value) => characters(value) <= max && !NOTE_CONTROL.test(value) && !LONE_SURROGATE.test(value));

/** Whether a room's name can be kept as a reading's room label (0020, drying_readings.room_label). */
export function roomLabelOk(value: unknown): value is string {
  return typeof value === 'string' && characters(value) >= 1 && characters(value) <= MAX_ROOM_LABEL && NONBLANK.test(value) && !NOTE_CONTROL.test(value) && !LONE_SURROGATE.test(value);
}

const number = (min: number, max: number) => z.number().min(min).max(max);
// Lower-cased, as the database holds and returns a uuid: the digest and every comparison use one form.
const uuid = z.uuid().transform((value) => value.toLowerCase());

// An ISO time PostgreSQL stores as given: a real calendar day, and an offset of at most 15:59 either
// way (the most a timestamptz takes). Checked here, so every path answers 400 for it, never a 409 or
// a 503 that a resend could not get past.
const TIME_PARTS = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;
function storableTime(value: string): boolean {
  const parts = TIME_PARTS.exec(value);
  if (!parts) return false;
  const [year, month, day] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return false;
  return parts[4] === undefined || (Number(parts[4]) <= 15 && Number(parts[5]) <= 59);
}

// Every reading: the phone's own id (so a resend finds its row), the room's stable field id (none for a
// whole-job or outside reading) and when it was taken, with its offset as the phone recorded it.
const common = {
  id: uuid,
  roomId: fieldId.nullable().optional(),
  takenAt: z.iso.datetime({ offset: true }).max(40).refine(storableTime),
  note: noteText(MAX_NOTE).default(''),
};

export const airReadingBody = z.strictObject({
  ...common,
  kind: z.literal('air'),
  zone: z.enum(AIR_ZONES).default('affected'),
  temperatureF: number(-40, 150),
  relativeHumidity: number(1, 100),
});

export const materialReadingBody = z.strictObject({
  ...common,
  kind: z.literal('material'),
  material: lineText(MAX_MATERIAL),
  moisture: number(0, 1000),
  // Meters read on different scales (%MC, %WME, a relative pinless scale): the unit is the technician's.
  unit: lineText(MAX_UNIT),
  dryStandard: number(0, 1000).nullable().default(null),
  affected: z.boolean().default(true),
});

export const thermalReadingBody = z.strictObject({
  ...common,
  kind: z.literal('thermal'),
  deltaTF: number(-200, 200),
  pattern: z.enum(THERMAL_PATTERNS).default('cold_anomaly'),
  boundary: noteText(MAX_BOUNDARY).default(''),
});

export const readingBody = z
  .discriminatedUnion('kind', [airReadingBody, materialReadingBody, thermalReadingBody])
  // Outside air belongs to no room (0020, drying_readings_outside_check).
  .refine((reading) => !(reading.kind === 'air' && reading.zone === 'outside' && reading.roomId));

export type ReadingInput = z.infer<typeof readingBody>;

/** Voids one reading: the phone's own id for the void, so a resend finds its receipt, and the state it expects the reading in. */
export const voidBody = z.strictObject({ changeId: uuid, expectedState: z.literal('active') });
export type VoidInput = z.infer<typeof voidBody>;

export const MAX_PAGE = 200;
export const DEFAULT_PAGE = 100;
const CURSOR = /^[A-Za-z0-9_-]{1,200}$/;

/** GET .../drying-readings?limit=&cursor=: nothing else is accepted. */
export const listQuery = z.strictObject({
  limit: z
    .string()
    .regex(/^[1-9][0-9]{0,2}$/)
    .transform(Number)
    .pipe(z.int().min(1).max(MAX_PAGE))
    .optional(),
  cursor: z.string().regex(CURSOR).optional(),
});

/** What the database stores of a reading: its kind's fields under the payload check's keys. */
export function storedPayload(input: ReadingInput): Record<string, unknown> {
  switch (input.kind) {
    case 'air':
      return { zone: input.zone, temperature_f: input.temperatureF, relative_humidity: input.relativeHumidity, note: input.note };
    case 'material':
      return { material: input.material, moisture: input.moisture, unit: input.unit, dry_standard: input.dryStandard, affected: input.affected, note: input.note };
    case 'thermal':
      return { delta_t_f: input.deltaTF, pattern: input.pattern, boundary: input.boundary, note: input.note };
  }
}

/** A stored payload as the answer gives it back: the request's own field names. */
export function payloadView(kind: string, payload: Record<string, unknown>): Record<string, unknown> {
  switch (kind) {
    case 'air':
      return { zone: payload.zone, temperatureF: payload.temperature_f, relativeHumidity: payload.relative_humidity, note: payload.note };
    case 'material':
      return { material: payload.material, moisture: payload.moisture, unit: payload.unit, dryStandard: payload.dry_standard, affected: payload.affected, note: payload.note };
    default:
      return { deltaTF: payload.delta_t_f, pattern: payload.pattern, boundary: payload.boundary, note: payload.note };
  }
}

const sha256 = (value: unknown) => createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');

/** SHA-256 of a create request as parsed (defaults filled in): the same id and body is the same reading. */
export function readingDigest(input: ReadingInput): string {
  return sha256({ id: input.id, kind: input.kind, roomId: input.roomId ?? null, takenAt: input.takenAt, payload: storedPayload(input) });
}

/** SHA-256 of a void request: the same change of the same reading is the same void. */
export function voidDigest(readingId: string, input: VoidInput): string {
  return sha256({ readingId, changeId: input.changeId, expectedState: input.expectedState });
}
