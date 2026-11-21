import { createHash } from 'node:crypto';
import { canonicalJson } from '@/lib/field/canonical';

// The drying watch's status (S5b-10 slice 10B): a port of the old app's backend/drying_watch.py
// (watch_state and the parts of day_groups it reads; docs/drying-watch.md), worked out on every read
// from the signed facts, the live drying log and the clock. Nothing here is stored: the watch keeps only
// the staff's explicit decisions (job_coordination.drying_watch, 0020).
//
// - Calendar days are the company's California days (America/Los_Angeles, daylight saving included).
//   The original signing starts day 1.
// - A visit is due 24 hours after the latest reading taken by now, or after the signing when there is
//   none; overdue means that instant has passed. A reading taken in the future is left out of everything
//   here, so it never defers a visit or attests dryness; a voided reading is not in the log.
// - Automatic dry needs every signed room to have its latest affected material readings (at least one a
//   room: the field app records no wet-material count) and every latest affected material at or under
//   its own dry standard, in its own unit. Air alone never proves dryness.
// - Stalled: a room's latest affected-air GPP has not fallen across its last three recorded days.
// - Past signed plan: the day number is beyond the signed drying days. An extension adds a note; it
//   never extends the signed days.
// - Mark dry and Close monitoring close the watch for good; a closed watch has no due time or flags.

export const ZONE = 'America/Los_Angeles';
const DAY_MS = 24 * 60 * 60 * 1000;

// An instant: a Date (whole milliseconds) or the database's text of one, YYYY-MM-DDTHH:MM:SS[.ffffff]Z,
// which keeps its microseconds. Order, eligibility and due times compare microseconds.
export type Stamp = Date | string;

export type WatchReading = {
  id: string;
  kind: 'air' | 'material' | 'thermal';
  roomId: string | null;
  takenAt: Stamp;
  // When the server received it: the order of two readings taken at the same instant (the old app's
  // recorded_at), then the id.
  receivedAt?: Stamp;
  // Air: the zone and the server's GPP. Material: the label, unit, reading, standard and affected flag.
  zone?: string;
  gpp?: number;
  material?: string;
  unit?: string;
  moisture?: number;
  dryStandard?: number | null;
  affected?: boolean;
};

export type SignedRoom = { id: string; name: string };

export type WatchDecision = { action: 'mark_dry' | 'extend' | 'close' };

export type WatchStatus = 'active' | 'dry_standard_met' | 'marked_dry' | 'closed';
export type WatchFlag = 'missing_dry_standard' | 'stalled' | 'overdue' | 'due_today' | 'past_signed_plan';
export type AirTrend = 'stalled' | 'improving' | 'recorded';

export type WatchState = {
  status: WatchStatus;
  plannedDays: number;
  signedRooms: SignedRoom[];
  dayNumber: number;
  setupAt: string;
  lastReadingAt: string | null;
  nextDueAt: string | null;
  flags: WatchFlag[];
  materials: { roomId: string | null; material: string; unit: string; moisture: number; dryStandard: number | null }[];
  air: { roomId: string | null; firstGpp: number; latestGpp: number; referenceGpp: number; percent: number; days: number }[];
  missingRooms: string[];
  airTrends: { roomId: string | null; trend: AirTrend }[];
  roomReadings: { roomId: string | null; lastReadingAt: string | null; overdue: boolean }[];
};

const pacificDay = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

/** The California calendar day of an instant, as YYYY-MM-DD. */
export function calendarDay(at: Date): string {
  return pacificDay.format(at);
}

// Whole days from one calendar day to another.
function daysBetween(from: string, to: string): number {
  const utc = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
  return Math.round((utc(to) - utc(from)) / DAY_MS);
}

// JavaScript's Math.round, as the old app's browser code rounded (half up, negative halves too).
const rounded = (value: number) => Math.floor(value + 0.5);

// Case folding close to Python's str.casefold for material labels and meter units: lower, upper, lower,
// so ß, SS and the capital ẞ all match. (Python keeps the dotless ı apart from i; this folds them
// together, an edge no material label in practice depends on.)
const fold = (text: string) => text.toLowerCase().toUpperCase().toLowerCase();
const DAY_US = DAY_MS * 1000;

// Microseconds since the epoch (exact in a double until the year 2255).
function micros(at: Stamp): number {
  if (typeof at !== 'string') return at.getTime() * 1000;
  const fraction = /\.(\d{1,6})Z$/.exec(at)?.[1] ?? '';
  return Date.parse(at.replace(/\.\d+Z$/, 'Z')) * 1000 + Number(fraction.padEnd(6, '0'));
}
const dateOf = (at: Stamp) => (typeof at === 'string' ? new Date(at) : at);
const dateOfMicros = (us: number) => new Date(Math.floor(us / 1000));
// An instant in microseconds as the database writes one: YYYY-MM-DDTHH:MM:SS.ffffffZ, so an answer keeps
// the microseconds every comparison here uses.
function isoMicros(us: number): string {
  const second = Math.floor(us / 1_000_000);
  return `${new Date(second * 1000).toISOString().slice(0, 19)}.${String(us - second * 1_000_000).padStart(6, '0')}Z`;
}

// A reading with its instants worked out once: whole-millisecond dates for calendar days and output,
// microseconds for every comparison.
type Timed = Omit<WatchReading, 'takenAt' | 'receivedAt'> & { takenAt: Date; takenUs: number; receivedUs: number };

type RoomDay = { key: string; number: number; affected: WatchReading | null; reference: WatchReading | null };

// For each room, in order (the signed rooms, then rooms only readings name, then the whole job), its
// readings' calendar days and on each the latest affected air reading and the latest reference
// (unaffected air, any room) of that day or before: the part of the old day_groups the status reads.
function dayGroups(readings: Timed[], rooms: SignedRoom[]) {
  const days = [...new Set(readings.map((reading) => calendarDay(reading.takenAt)))].sort();
  const signed = rooms.map((room) => room.id);
  const order: (string | null)[] = [...new Set<string | null>([...signed, ...readings.map((r) => r.roomId).filter((id): id is string => id !== null), null])];
  const references = readings.filter((r) => r.kind === 'air' && r.zone === 'unaffected');
  const groups: { roomId: string | null; days: RoomDay[]; progress: WatchState['air'][number] | null }[] = [];
  for (const roomId of order) {
    const mine = readings.filter((r) => r.roomId === roomId);
    const roomDays: RoomDay[] = [];
    for (const key of [...new Set(mine.map((r) => calendarDay(r.takenAt)))]) {
      const rows = mine.filter((r) => calendarDay(r.takenAt) === key);
      const affected = rows.filter((r) => r.kind === 'air' && r.zone === 'affected').at(-1) ?? null;
      const reference = references.filter((r) => calendarDay(r.takenAt) <= key).at(-1) ?? null;
      roomDays.push({ key, number: daysBetween(days[0]!, key) + 1, affected, reference });
    }
    const tracked = roomDays.filter((day) => day.affected);
    let progress: WatchState['air'][number] | null = null;
    const latest = tracked.at(-1);
    if (latest?.reference) {
      const first = tracked[0]!;
      const firstGpp = first.affected!.gpp!;
      const latestGpp = latest.affected!.gpp!;
      const referenceGpp = latest.reference.gpp!;
      const span = firstGpp - referenceGpp;
      const percent = span <= 0 ? (latestGpp <= referenceGpp ? 100 : 0) : Math.max(0, Math.min(100, rounded(((firstGpp - latestGpp) / span) * 100)));
      progress = { roomId, firstGpp, latestGpp, referenceGpp, percent, days: latest.number - first.number + 1 };
    }
    if (signed.includes(roomId as string) || mine.length > 0) groups.push({ roomId, days: roomDays, progress });
  }
  return groups;
}

/**
 * The watch's state at `at`: the signed rooms and drying days, the setup time (the original signing),
 * the log's active readings and the staff's decisions.
 */
export function watchState(input: { plannedDays: number; rooms: SignedRoom[]; setupAt: Date; readings: WatchReading[]; decisions: WatchDecision[]; at: Stamp }): WatchState {
  const { plannedDays, rooms, setupAt } = input;
  const atUs = micros(input.at);
  const at = dateOf(input.at);
  // Future entries cannot postpone a visit or attest that a material is dry today.
  const readings: Timed[] = input.readings
    .map((r) => ({ ...r, takenAt: dateOf(r.takenAt), takenUs: micros(r.takenAt), receivedUs: r.receivedAt === undefined ? 0 : micros(r.receivedAt) }))
    .filter((r) => r.takenUs <= atUs)
    .sort((a, b) => a.takenUs - b.takenUs || a.receivedUs - b.receivedUs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const groups = dayGroups(readings, rooms);
  const latestMaterials = new Map<string, WatchReading>();
  for (const r of readings) {
    if (r.kind === 'material' && r.affected !== false) latestMaterials.set(JSON.stringify([r.roomId, fold(r.material!), fold(r.unit!)]), r);
  }
  const latest = [...latestMaterials.values()];
  // No air-only or partial-room log can attest that all affected materials are dry.
  const missingRooms = rooms.filter((room) => latest.filter((m) => m.roomId === room.id).length < 1).map((room) => room.id);
  const dry = rooms.length > 0 && missingRooms.length === 0 && latest.every((m) => m.dryStandard !== null && m.dryStandard !== undefined && m.moisture! <= m.dryStandard);
  const lastReading = readings.at(-1);
  const dueUs = (lastReading?.takenUs ?? micros(setupAt)) + DAY_US;
  const due = dateOfMicros(dueUs);
  const dayNumber = Math.max(1, daysBetween(calendarDay(setupAt), calendarDay(at)) + 1);
  let flags: WatchFlag[] = [];
  if (rooms.length === 0 || missingRooms.length > 0 || latest.some((m) => m.dryStandard === null || m.dryStandard === undefined)) flags.push('missing_dry_standard');
  const airTrends: WatchState['airTrends'] = [];
  const roomReadings: WatchState['roomReadings'] = [];
  for (const group of groups) {
    const roomLast = readings.filter((r) => r.roomId === group.roomId).at(-1) ?? null;
    roomReadings.push({ roomId: group.roomId, lastReadingAt: roomLast ? isoMicros(roomLast.takenUs) : null, overdue: roomLast !== null && roomLast.takenUs + DAY_US < atUs });
    const airDays = group.days.filter((day) => day.affected);
    if (airDays.length === 0) continue;
    const gpp = (offset: number) => airDays.at(offset)!.affected!.gpp!;
    const stalled = airDays.length >= 3 && gpp(-2) >= gpp(-3) && gpp(-1) >= gpp(-2);
    const improving = airDays.length >= 2 && gpp(-1) < gpp(-2);
    airTrends.push({ roomId: group.roomId, trend: stalled ? 'stalled' : improving ? 'improving' : 'recorded' });
  }
  if (airTrends.some((entry) => entry.trend === 'stalled')) flags.push('stalled');
  const closing = input.decisions.find((decision) => decision.action === 'mark_dry' || decision.action === 'close');
  let status: WatchStatus = dry ? 'dry_standard_met' : 'active';
  if (closing) status = closing.action === 'mark_dry' ? 'marked_dry' : 'closed';
  if (status === 'active') {
    if (dueUs < atUs) flags.push('overdue');
    else if (calendarDay(due) === calendarDay(at)) flags.push('due_today');
    if (dayNumber > plannedDays) flags.push('past_signed_plan');
  } else {
    flags = [];
  }
  return {
    status,
    plannedDays,
    signedRooms: rooms,
    dayNumber,
    setupAt: isoMicros(micros(setupAt)),
    lastReadingAt: lastReading ? isoMicros(lastReading.takenUs) : null,
    nextDueAt: status === 'active' ? isoMicros(dueUs) : null,
    flags,
    materials: latest.map((m) => ({ roomId: m.roomId, material: m.material!, unit: m.unit!, moisture: m.moisture!, dryStandard: m.dryStandard ?? null })),
    air: groups.flatMap((group) => (group.progress ? [group.progress] : [])),
    missingRooms,
    airTrends,
    roomReadings,
  };
}

/** Whether monitoring has finished, so the watch suggests the day count for the job close. */
export const finished = (status: WatchStatus) => status !== 'active';

export const MAX_FINISHED_DAYS = 365;

/**
 * The day count a finished watch suggests for the job close: the California day number (the original
 * signing is day 1) of the instant monitoring finished, never above 365. Mark dry and Close monitoring
 * finish at their receipt's time, an automatic dry standard at the latest eligible reading. Null while
 * monitoring is active.
 */
export function finishedDayNumber(state: WatchState, receipts: { action: string; at: string }[]): number | null {
  if (!finished(state.status)) return null;
  const closing = receipts.find((receipt) => receipt.action === 'mark_dry' || receipt.action === 'close');
  const instant = closing?.at ?? state.lastReadingAt;
  if (!instant) return null;
  const day = daysBetween(calendarDay(new Date(state.setupAt)), calendarDay(new Date(instant))) + 1;
  return Math.min(MAX_FINISHED_DAYS, Math.max(1, day));
}

/**
 * The SHA-256 a person reviewed before confirming a watch action: the agreement, the state worked out
 * now, the log's version (every reading and void, so any change to the log is a change), and the
 * watch's own revision. A confirmation with another hash is stale.
 */
export function factsHash(input: { agreementId: string; state: WatchState; log: { readings: number; voids: number; changedAt: string | null }; revision: number }): string {
  const { state } = input;
  const facts = {
    agreementId: input.agreementId,
    status: state.status,
    plannedDays: state.plannedDays,
    signedRooms: state.signedRooms,
    dayNumber: state.dayNumber,
    flags: state.flags,
    materials: state.materials,
    air: state.air,
    missingRooms: state.missingRooms,
    airTrends: state.airTrends,
    roomReadings: state.roomReadings,
    log: input.log,
    revision: input.revision,
  };
  return createHash('sha256').update(canonicalJson(facts), 'utf8').digest('hex');
}

/**
 * Fixed sentences from the saved facts, for the card: no note, name of a person, address or amount.
 * Room names are the signed record's.
 */
export function watchSummary(state: WatchState): string[] {
  const name = (roomId: string | null) => state.signedRooms.find((room) => room.id === roomId)?.name ?? (roomId === null ? 'Whole job' : 'Another room');
  const lines = [`Day ${state.dayNumber} of ${state.plannedDays} signed drying days.`];
  const covered = state.signedRooms.length - state.missingRooms.length;
  lines.push(`${covered} of ${state.signedRooms.length} signed rooms have affected material readings.`);
  if (state.status === 'dry_standard_met') lines.push('Every latest affected material reading meets its dry standard.');
  if (state.status === 'marked_dry') lines.push('Marked dry by staff.');
  if (state.status === 'closed') lines.push('Monitoring closed by staff.');
  for (const entry of state.airTrends) if (entry.trend === 'stalled') lines.push(`${name(entry.roomId)}: affected air has not fallen across three recorded days.`);
  if (state.flags.includes('overdue')) lines.push('A reading is overdue.');
  else if (state.flags.includes('due_today')) lines.push('A reading is due today.');
  if (state.flags.includes('past_signed_plan')) lines.push('Past the signed drying plan.');
  return lines;
}
