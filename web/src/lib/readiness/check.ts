import type { FieldManifest } from '@/lib/field/canonical';
import { draftFieldSchema, fieldId, photoFieldSchema, roomFieldSchema, type DraftField, type PhotoField, type RoomField } from '@/lib/field/schema';

// "Ready to review?" (S5b-11, flag `readiness`): the deterministic checklist of what a job still
// lacks before Finish, ported from the old app's backend/readiness.py and backend/shot_list.py to the
// rebuilt app's data. Advisory only: it is never stored, never priced and never a condition of Finish,
// Submit, the estimate or signing. Rooms are named by their stable id, never by name, and no value
// the technician or the office typed is ever repeated in a gap.
//
// The rebuilt rules (S5b-10/11 plan, 11A, "Recommended deterministic checklist"):
// - A room names water category 1, 2 or 3, or mold, itself (src/lib/field/schema.ts); a room with no
//   category gets a category gap and no guess at which kind it is.
// - A water room needs the area its price basis uses: the demolition area (finished or unfinished,
//   above zero) unless the job's price version prices by wet floor area, which a wet floor area or,
//   failing that, a floor area gives (an entered 0 counts). With no published price version there is
//   no basis: that area check is listed as unavailable and the prices gap is raised. Its drying check needs a floor area,
//   ceiling height and water class, and a wet floor area no larger than the floor area.
// - A mold room needs its affected area (an entered 0 counts) and condition, and no water sizing.
// - Every room needs the baseline photos: one overview, one affected surface and one moisture meter
//   photo, each a saved photo reference tagged with that shot and placed in that room. The room
//   switches and counts the old app asked for are not restored (owner answer Q2, option A).
// - A job with a water room and no drying equipment counted asks for the counts; with equipment, the
//   first affected air or material reading in the drying log is asked for once the log exists.
// - A part-filled claim asks for its other fields by key. No published price version asks the owner
//   to set prices.
// - A check the server cannot run is listed as unavailable, never as a gap: the setup reading while
//   the service has no drying log source or the read failed (src/lib/drying/setup.ts, S5b-10), the meter-photo reading status (the S7
//   meter workflow stores none yet), and the price basis while there is no readable price version.

/** The area a company's price version prices a water room's per-room items by (src/engine/table.ts). */
export type AreaBasis = 'demolition' | 'demolition_with_waste' | 'wet_floor';

export type PriceState =
  | { state: 'published'; areaBasis: AreaBasis }
  // The company has published no price version, and the job has none pinned.
  | { state: 'none' }
  // The price version could not be read (it does not parse or match its hash).
  | { state: 'unavailable' };

/** The drying log's first affected air or material reading: saved, absent, or not known. */
export type SetupReadings = 'present' | 'absent' | 'unavailable';

export type ReadinessFacts = {
  /** The job's property address, from Postgres. */
  propertyAddress: string;
  /** The job's claim, from Postgres: each field's text, or null or absent when not set. */
  claim: Readonly<Record<string, string | null | undefined>>;
  prices: PriceState;
  draft: DraftField;
  /** The draft's rooms, in the draft's room order (parseDraft gives them so): the gaps follow it. */
  rooms: readonly { id: string; field: RoomField }[];
  /** The draft's photo references whose photo is stored (the evidence registry holds it). */
  photos: readonly PhotoField[];
  setupReadings: SetupReadings;
};

export type ReadinessGap = { code: string; roomId?: string; count?: number };

/** A check the server could not run, so neither a gap nor a pass is claimed for it. */
export type UnavailableCheck = 'roomArea' | 'setupReadings' | 'ocr' | 'prices';

export type ReadinessResult = { gaps: ReadinessGap[]; unavailable: UnavailableCheck[] };

/** The claim fields the documents print (src/lib/jobs/schema.ts claimBody), in the form's order. */
export const CLAIM_KEYS = Object.freeze([
  'carrier',
  'claimNumber',
  'policyNumber',
  'dateOfLoss',
  'lossCause',
  'adjusterName',
  'adjusterEmail',
  'adjusterPhone',
  'deductible',
] as const);

/** The baseline photo shots every room needs, in the order they are asked for. */
export const BASELINE_SHOTS = Object.freeze(['overview', 'surface', 'meter'] as const);

/**
 * Every gap code. `claim:<key>` names a claim field of CLAIM_KEYS and `shot:<tag>` a baseline shot;
 * the rest name the field-map key, or the area, to fix.
 */
export const READINESS_CODES: ReadonlySet<string> = new Set([
  'propertyAddress',
  'yearBuilt',
  'rooms',
  'category',
  'demolitionArea',
  'wetFloorArea',
  'floorSf',
  'ceilingHeightFt',
  'waterClass',
  'wetFloorExceedsFloor',
  'affectedSf',
  'moldCondition',
  'shot',
  'equipment',
  'claim',
  'setupReadings',
  'prices',
  'summary',
  'scopeConfirmed',
]);

/** Whether a gap code is one the check gives: `claim:<key>` of CLAIM_KEYS, `shot:<shot>` of BASELINE_SHOTS, or a listed code. */
export function isReadinessCode(code: string): boolean {
  const at = code.indexOf(':');
  if (at === -1) return code !== 'claim' && code !== 'shot' && READINESS_CODES.has(code);
  const stem = code.slice(0, at);
  const rest = code.slice(at + 1);
  if (stem === 'claim') return (CLAIM_KEYS as readonly string[]).includes(rest);
  if (stem === 'shot') return (BASELINE_SHOTS as readonly string[]).includes(rest);
  return false;
}

/** Whether the draft counts drying equipment: air movers, dehumidifiers or wood floor systems. */
export const countsEquipment = (draft: DraftField): boolean => positive(draft.airMovers) || positive(draft.dehumidifiers) || positive(draft.woodFloorSystems);

const filled = (value: unknown): boolean => typeof value === 'string' && value.trim() !== '';
const positive = (value: number | undefined): boolean => value !== undefined && value > 0;

function waterRoomGaps(room: RoomField, prices: PriceState, add: (code: string) => void, unavailable: (check: UnavailableCheck) => void): void {
  const basis: AreaBasis | null = prices.state === 'published' ? prices.areaBasis : null;
  if (basis === null) unavailable('roomArea');
  else if (basis === 'wet_floor') {
    if (room.wetFloorSf === undefined && room.floorSf === undefined) add('wetFloorArea');
  } else if (!positive(room.finishedSf) && !positive(room.unfinishedSf)) add('demolitionArea');
  if (room.floorSf === undefined) add('floorSf');
  if (room.ceilingHeightFt === undefined) add('ceilingHeightFt');
  if (room.waterClass === undefined) add('waterClass');
  if (room.wetFloorSf !== undefined && room.floorSf !== undefined && room.wetFloorSf > room.floorSf) add('wetFloorExceedsFloor');
}

/** The gaps and the checks that could not run, in one stable order. Pure: changes nothing given. */
export function checkReadiness(facts: ReadinessFacts): ReadinessResult {
  const gaps: ReadinessGap[] = [];
  const unavailable = new Set<UnavailableCheck>();
  const { draft } = facts;
  const { rooms } = facts;

  if (!filled(facts.propertyAddress)) gaps.push({ code: 'propertyAddress' });
  if (draft.yearBuilt === undefined) gaps.push({ code: 'yearBuilt' });
  if (rooms.length === 0) gaps.push({ code: 'rooms' });

  for (const { id, field: room } of rooms) {
    const add = (code: string) => gaps.push({ code, roomId: id });
    if (room.category === undefined) add('category');
    else if (room.category === 'mold') {
      if (room.affectedSf === undefined) add('affectedSf');
      if (room.moldCondition === undefined) add('moldCondition');
    } else waterRoomGaps(room, facts.prices, add, (check) => unavailable.add(check));
    for (const shot of BASELINE_SHOTS) {
      const taken = facts.photos.some((photo) => photo.roomId === id && photo.shotTag === shot);
      if (!taken) gaps.push({ code: `shot:${shot}`, roomId: id, count: 1 });
    }
  }

  const water = rooms.some(({ field }) => field.category !== undefined && field.category !== 'mold');
  const equipment = countsEquipment(draft);
  if (water && !equipment) gaps.push({ code: 'equipment' });

  if (CLAIM_KEYS.some((key) => filled(facts.claim[key]))) {
    for (const key of CLAIM_KEYS) if (!filled(facts.claim[key])) gaps.push({ code: `claim:${key}` });
  }

  if (equipment) {
    if (facts.setupReadings === 'absent') gaps.push({ code: 'setupReadings' });
    else if (facts.setupReadings === 'unavailable') unavailable.add('setupReadings');
  }
  // No meter-photo reading status is stored yet (the S7 meter workflow): never guessed from a photo.
  unavailable.add('ocr');

  if (facts.prices.state === 'none') gaps.push({ code: 'prices' });
  else if (facts.prices.state === 'unavailable') unavailable.add('prices');

  if (!filled(draft.summary)) gaps.push({ code: 'summary' });
  if (draft.scopeConfirmed !== true) gaps.push({ code: 'scopeConfirmed' });

  const order: UnavailableCheck[] = ['roomArea', 'setupReadings', 'ocr', 'prices'];
  return { gaps, unavailable: order.filter((check) => unavailable.has(check)) };
}

export type ParsedDraft = {
  draft: DraftField;
  rooms: { id: string; field: RoomField }[];
  photos: { id: string; field: PhotoField }[];
};

/**
 * The draft as the check reads it, or null when it does not match the field map: the draft map or a
 * room map fails its schema, a room id is not a field id, or the room order does not list exactly the
 * room documents (the rule Submit applies, src/lib/field/inspection.ts). A photo reference whose map
 * does not match is left out, so it satisfies no shot.
 */
export function parseDraft(manifest: FieldManifest): ParsedDraft | null {
  const draft = draftFieldSchema.safeParse(manifest.draft ?? {});
  if (!draft.success) return null;
  const byId = new Map<string, RoomField>();
  for (const room of manifest.rooms) {
    const field = roomFieldSchema.safeParse(room.field ?? {});
    if (!fieldId.safeParse(room.id).success || !field.success || byId.has(room.id)) return null;
    byId.set(room.id, field.data);
  }
  const order = draft.data.roomOrder ?? [];
  if (order.length !== byId.size || order.some((id) => !byId.has(id))) return null;
  const photos: ParsedDraft['photos'] = [];
  for (const photo of manifest.photos) {
    const field = photoFieldSchema.safeParse(photo.field ?? {});
    if (field.success) photos.push({ id: photo.id, field: field.data });
  }
  return { draft: draft.data, rooms: order.map((id) => ({ id, field: byId.get(id) as RoomField })), photos };
}
