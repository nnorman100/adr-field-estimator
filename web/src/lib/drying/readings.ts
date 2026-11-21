import { and, asc, count, eq, isNull, sql } from 'drizzle-orm';
import { dryingReadings } from '@/db/drying-schema';
import { companies, memberships } from '@/db/schema';
import { withCompany, type CompanyTransaction, type Database } from '@/db/tenant';
import type { Capability } from '@/lib/access';
import { IdentityRefusal } from '@/lib/auth';
import { hasAny, jobAccess, JobError, type JobCaller, type JobRow } from '@/lib/jobs/access';
import { audit, CHECK_VIOLATION, decodeCursor, encodeCursor, errorCode } from '@/lib/jobs/service';
import type { ReadinessReader } from '@/lib/readiness/reader';
import { draftIsJobs, hasPendingSubmission } from '@/lib/readiness/service';
import { DryingError } from './errors';
import { psychrometrics } from './psychrometrics';
import { roomsIn, submittedRooms, type ReadingRoom } from './rooms';
import {
  DEFAULT_PAGE,
  listQuery,
  MAX_READINGS,
  payloadView,
  readingBody,
  readingDigest,
  storedPayload,
  voidBody,
  voidDigest,
  type ReadingInput,
} from './schema';

// The drying log (S5b-10 slice 10B; docs/plans/S5/S5b-10.md): readings beside the job, never inside its
// field draft or signed record, so a monitoring visit after signing records the day's readings and
// changes no estimate, document, hash or signature. Every function runs inside withCompany for the
// company of the verified sign-in and goes through the one job-access function.
//
// - Read: `jobs_read` (the owner, office and the estimator with the job). The active readings, in the
//   order they were taken.
// - Add and void: `scope` (the owner and the estimator with the job), the job locked. Field work is
//   not needed: post-inspection readings are not field draft edits, so they take no field ownership.
//   Office reads only.
//
// Each reading and each void carries the phone's own id. A request sent again after a lost answer gets
// the stored receipt (the replay is looked up first, after the access checks and before any other
// precondition); the same id with another body, or on another job, is 409. A job keeps at most 400
// active readings, counted under the job lock, and a void frees a place. Each accepted change adds one
// audit row with ids only.

const READ: readonly Capability[] = ['jobs_read'];
const WRITE: readonly Capability[] = ['scope'];

const UNIQUE_VIOLATION = '23505';
const INVALID_DATETIME = new Set(['22007', '22008', '22009']);

// Times as the database holds them (microseconds, UTC), so a cursor names a reading exactly. The drying
// watch reads every time through this one formatter too.
export const micros = (column: unknown) => sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const readingColumns = {
  id: dryingReadings.id,
  jobId: dryingReadings.jobId,
  kind: dryingReadings.kind,
  roomId: dryingReadings.roomId,
  roomLabel: dryingReadings.roomLabel,
  takenAt: micros(dryingReadings.takenAt),
  takenKey: sql<string>`${dryingReadings.takenAt}::text`,
  receivedAt: micros(dryingReadings.receivedAt),
  payload: dryingReadings.payload,
  gpp: dryingReadings.gpp,
  dewPointF: dryingReadings.dewPointF,
  dewPointDepressionF: dryingReadings.dewPointDepressionF,
  vaporPressureInhg: dryingReadings.vaporPressureInhg,
  enthalpyBtuLb: dryingReadings.enthalpyBtuLb,
  requestDigest: dryingReadings.requestDigest,
  voidChangeId: dryingReadings.voidChangeId,
  voidDigest: dryingReadings.voidDigest,
  voidedAt: micros(dryingReadings.voidedAt),
};

type ReadingRow = {
  id: string;
  jobId: string;
  kind: string;
  roomId: string | null;
  roomLabel: string | null;
  takenAt: string;
  takenKey: string;
  receivedAt: string;
  payload: Record<string, unknown>;
  gpp: number | null;
  dewPointF: number | null;
  dewPointDepressionF: number | null;
  vaporPressureInhg: string | null;
  enthalpyBtuLb: string | null;
  requestDigest: string;
  voidChangeId: string | null;
  voidDigest: string | null;
  voidedAt: string | null;
};

/** One reading as the log shows it. The air values are the server's; nothing names who made it. */
export type ReadingView = {
  id: string;
  kind: string;
  roomId: string | null;
  roomLabel: string | null;
  takenAt: string;
  receivedAt: string;
  reading: Record<string, unknown>;
  air: { gpp: number; dewPointF: number; dewPointDepressionF: number; vaporPressureInhg: number; enthalpyBtuLb: number } | null;
};

export type VoidReceipt = { id: string; voided: true; changeId: string; voidedAt: string };

export type ReadingsPage = {
  jobId: string;
  readings: ReadingView[];
  // The cursor of the next page, or null on the last.
  next: string | null;
  // Whether the caller may add and void readings (the role's hint for the screen; the routes check it again).
  canChange: boolean;
};

function viewOf(row: ReadingRow): ReadingView {
  return {
    id: row.id,
    kind: row.kind,
    roomId: row.roomId,
    roomLabel: row.roomLabel,
    takenAt: row.takenAt,
    receivedAt: row.receivedAt,
    reading: payloadView(row.kind, row.payload),
    air:
      row.kind === 'air'
        ? {
            gpp: row.gpp!,
            dewPointF: row.dewPointF!,
            dewPointDepressionF: row.dewPointDepressionF!,
            vaporPressureInhg: Number(row.vaporPressureInhg),
            enthalpyBtuLb: Number(row.enthalpyBtuLb),
          }
        : null,
  };
}

const voidReceiptOf = (row: ReadingRow): VoidReceipt => ({ id: row.id, voided: true, changeId: row.voidChangeId!, voidedAt: row.voidedAt! });

// The cursor names the last reading of a page: its time as the database holds it (microseconds) and id, opaque to the phone.
const cursorOf = (row: ReadingRow): string => encodeCursor(row.takenKey, row.id);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function readingById(tx: CompanyTransaction, companyId: string, id: string): Promise<ReadingRow | undefined> {
  const [row] = await tx
    .select(readingColumns)
    .from(dryingReadings)
    .where(and(eq(dryingReadings.companyId, companyId), eq(dryingReadings.id, id)))
    .limit(1);
  return row as ReadingRow | undefined;
}

async function activeCount(tx: CompanyTransaction, job: JobRow): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(dryingReadings)
    .where(and(eq(dryingReadings.companyId, job.companyId), eq(dryingReadings.jobId, job.id), isNull(dryingReadings.voidedAt)));
  return row?.n ?? 0;
}

// The draft the job is being edited on, read before the write (rooms.ts), for a room reading on it.
// `read` is null when the field database could not be read.
type DraftRead = { draftId: string; read: Awaited<ReturnType<ReadinessReader['readEditing']>> | null };

// A room reading of a job being edited needs its draft's rooms from the field database, which is read
// with no Postgres transaction open. The write's transaction ends with the id of the draft to read, the
// read is made, and the write runs again with it.
type NeedsDraft = { needsDraft: string };

// The rooms a reading of the job may name, the one rule for the reading write and the room list
// (rooms.ts): a submitted or signed job's from the snapshot its current draft was committed with; a job
// being edited, its current field draft's, read before (none when the draft is missing, another job's or
// over its caps).
async function jobRooms(tx: CompanyTransaction, job: JobRow, draft: DraftRead | null): Promise<{ rooms: ReadingRoom[] } | NeedsDraft> {
  if (job.status !== 'draft') return { rooms: await submittedRooms(tx, job) };
  // A Submit of the current draft already committed its pending row: checked under the job lock (or in
  // the read's snapshot), whatever the field draft says.
  if (await hasPendingSubmission(tx, job)) throw new DryingError('submission_in_progress');
  if (draft?.draftId !== job.currentDraftId) return { needsDraft: job.currentDraftId };
  const { read } = draft;
  if (read === null) throw new DryingError('draft_unavailable');
  // A Submit is deciding the draft: its rooms are about to be the submitted record's.
  if (read.outcome === 'not_editing') throw new DryingError('submission_in_progress');
  if (read.outcome !== 'read') return { rooms: [] };
  // A draft made before drafts carried their job id: it is this job's only if Postgres says so.
  if (!read.stamped && !(await draftIsJobs(tx, job.companyId, job.id, draft.draftId))) return { rooms: [] };
  return { rooms: roomsIn(read.manifest) };
}

async function roomOf(tx: CompanyTransaction, job: JobRow, roomId: string, draft: DraftRead | null): Promise<{ room: ReadingRoom } | NeedsDraft> {
  const found = await jobRooms(tx, job, draft);
  if ('needsDraft' in found) return found;
  const room = found.rooms.find((one) => one.id === roomId);
  if (!room) throw new DryingError('unknown_room');
  return { room };
}

// The field database's read of the job's current draft, made with no Postgres transaction open; null
// when it fails (the write and the room list answer 503 then).
async function readDraft(reader: () => ReadinessReader, companyId: string, jobId: string, draftId: string): Promise<DraftRead> {
  try {
    return { draftId, read: await reader().readEditing(companyId, jobId, draftId) };
  } catch (failure) {
    // Fixed text only: the SDK's message may quote a path.
    console.error('drying reading draft unavailable', failure instanceof Error ? failure.name : 'unknown');
    return { draftId, read: null };
  }
}

// The caller as Postgres holds them now, read first in every transaction of this log: the company
// still active and the caller still an active member with the role they signed in with (the request's
// sign-in passed that role's session rules, so a changed role is refused, never taken on). In a write
// both rows are locked FOR SHARE, before the job, so a suspension, a disable or a role change waits for
// the write's commit, and a write that waited for one of them sees it.
export async function currentCaller(tx: CompanyTransaction, caller: JobCaller, lock: boolean): Promise<void> {
  const company = tx.select({ status: companies.status }).from(companies).where(eq(companies.id, caller.companyId));
  const [found] = await (lock ? company.for('share') : company);
  if (found?.status !== 'active') throw new IdentityRefusal('company_inactive');
  const membership = tx
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.companyId, caller.companyId), eq(memberships.actorId, caller.actorId), eq(memberships.status, 'active')))
    .limit(1);
  const [member] = await (lock ? membership.for('share') : membership);
  if (member?.role !== caller.role) throw new JobError('not_allowed');
}

function parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new DryingError('invalid_request');
  return parsed.data;
}

// The request body's text (null: over the size limit or not UTF-8) as JSON, checked against the schema: only after
// the job's access is decided.
export function parseBody<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, text: string | null): T {
  if (text === null) throw new DryingError('invalid_request');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new DryingError('invalid_request');
  }
  return parse(schema, raw);
}

// A refusal the database makes of a value the schema let through is a bad request; the same id taken
// by a request racing this one, on another job, is a conflict.
export function refusedByDatabase(error: unknown): never {
  const code = errorCode(error);
  if (code === CHECK_VIOLATION || (typeof code === 'string' && INVALID_DATETIME.has(code))) throw new DryingError('invalid_request');
  if (code === UNIQUE_VIOLATION) throw new DryingError('conflict');
  throw error;
}

export type ReadingsService = {
  list(caller: JobCaller, jobId: string, query: Record<string, string>): Promise<ReadingsPage>;
  rooms(caller: JobCaller, jobId: string): Promise<{ jobId: string; rooms: ReadingRoom[] }>;
  add(caller: JobCaller, jobId: string, body: string | null): Promise<{ created: boolean; reading: ReadingView }>;
  void(caller: JobCaller, jobId: string, readingId: string, body: string | null): Promise<VoidReceipt>;
};

export function readingsService(db: Database, reader: () => ReadinessReader): ReadingsService {
  async function attempt(
    caller: JobCaller,
    jobId: string,
    body: string | null,
    draft: DraftRead | null,
  ): Promise<{ created: boolean; reading: ReadingView } | NeedsDraft> {
    return withCompany(db, caller.companyId, async (tx) => {
      await currentCaller(tx, caller, true);
      const job = await jobAccess(tx, caller, jobId, WRITE, { lock: true });
      const input: ReadingInput = parseBody(readingBody, body);
      const digest = readingDigest(input);
      const stored = await readingById(tx, caller.companyId, input.id);
      if (stored) {
        if (stored.jobId !== job.id || stored.requestDigest !== digest) throw new DryingError('conflict');
        return { created: false, reading: viewOf(stored) };
      }
      let room: ReadingRoom | null = null;
      if (input.roomId) {
        const found = await roomOf(tx, job, input.roomId, draft);
        if ('needsDraft' in found) return found;
        room = found.room;
      }
      if ((await activeCount(tx, job)) >= MAX_READINGS) throw new DryingError('reading_limit');
      const air = input.kind === 'air' ? psychrometrics(input.temperatureF, input.relativeHumidity) : null;
      try {
        // The columns named one by one: the runtime may insert only these (0020), and the receive
        // time and the void are the guard's.
        await tx.execute(sql`
          INSERT INTO drying_readings (id, company_id, job_id, kind, room_id, room_label, taken_at, payload, gpp, dew_point_f,
                                       dew_point_depression_f, vapor_pressure_inhg, enthalpy_btu_lb, request_digest, created_by_actor_id)
          VALUES (${input.id}::uuid, ${caller.companyId}::uuid, ${job.id}::uuid, ${input.kind}, ${room?.id ?? null}, ${room?.label ?? null},
                  ${input.takenAt}::timestamptz, ${JSON.stringify(storedPayload(input))}::jsonb, ${air?.gpp ?? null}, ${air?.dewPointF ?? null},
                  ${air?.dewPointDepressionF ?? null}, ${air === null ? null : String(air.vaporPressureInhg)}::numeric,
                  ${air === null ? null : String(air.enthalpyBtuLb)}::numeric, ${digest}, ${caller.actorId}::uuid)
        `);
      } catch (error) {
        refusedByDatabase(error);
      }
      await audit(tx, caller, 'drying_reading_added', job.id, { reading: input.id, kind: input.kind });
      return { created: true, reading: viewOf((await readingById(tx, caller.companyId, input.id))!) };
    });
  }

  return {
    async list(caller, jobId, query) {
      return withCompany(
        db,
        caller.companyId,
        async (tx) => {
          await currentCaller(tx, caller, false);
          await jobAccess(tx, caller, jobId, READ);
          const checked = parse(listQuery, query);
          const after = checked.cursor === undefined ? null : decodeCursor(checked.cursor);
          const limit = checked.limit ?? DEFAULT_PAGE;
          const rows = (await tx
            .select(readingColumns)
            .from(dryingReadings)
            .where(
              and(
                eq(dryingReadings.companyId, caller.companyId),
                eq(dryingReadings.jobId, jobId),
                isNull(dryingReadings.voidedAt),
                after === null ? undefined : sql`(${dryingReadings.takenAt}, ${dryingReadings.id}) > (${after.time}::timestamptz, ${after.id}::uuid)`,
              ),
            )
            .orderBy(asc(dryingReadings.takenAt), asc(dryingReadings.id))
            .limit(limit + 1)) as ReadingRow[];
          const page = rows.slice(0, limit);
          return {
            jobId,
            readings: page.map(viewOf),
            next: rows.length > limit ? cursorOf(page[page.length - 1]!) : null,
            canChange: hasAny(caller, WRITE),
          };
        },
        { snapshot: true },
      );
    },

    // GET .../drying-rooms: the rooms a reading of the job may name, by the write's own rule (jobRooms),
    // for every job reader (an assigned estimator who does not own the field work included). Each pass is
    // a read-only snapshot; the field database is read between two, as the write reads it.
    async rooms(caller, jobId) {
      const pass = (draft: DraftRead | null) =>
        withCompany(
          db,
          caller.companyId,
          async (tx) => {
            await currentCaller(tx, caller, false);
            const job = await jobAccess(tx, caller, jobId, READ);
            return jobRooms(tx, job, draft);
          },
          { snapshot: true },
        );
      const first = await pass(null);
      if (!('needsDraft' in first)) return { jobId, rooms: first.rooms };
      const second = await pass(await readDraft(reader, caller.companyId, jobId, first.needsDraft));
      // The job moved to another draft while its rooms were read: the screen reads the list again.
      if ('needsDraft' in second) throw new DryingError('conflict');
      return { jobId, rooms: second.rooms };
    },

    async add(caller, jobId, body) {
      const first = await attempt(caller, jobId, body, null);
      if (!('needsDraft' in first)) return first;
      const second = await attempt(caller, jobId, body, await readDraft(reader, caller.companyId, jobId, first.needsDraft));
      // The job moved to another draft while its rooms were read: the phone reads the job again.
      if ('needsDraft' in second) throw new DryingError('conflict');
      return second;
    },

    async void(caller, jobId, readingId, body) {
      return withCompany(db, caller.companyId, async (tx) => {
        await currentCaller(tx, caller, true);
        const job = await jobAccess(tx, caller, jobId, WRITE, { lock: true });
        const input = parseBody(voidBody, body);
        const digest = voidDigest(readingId, input);
        const stored = UUID.test(readingId) ? await readingById(tx, caller.companyId, readingId) : undefined;
        if (!stored || stored.jobId !== job.id) throw new DryingError('reading_not_found');
        if (stored.voidChangeId !== null) {
          // The same void again gets its receipt; another void of the reading never replaces the first.
          if (stored.voidChangeId === input.changeId && stored.voidDigest === digest) return voidReceiptOf(stored);
          if (stored.voidChangeId === input.changeId) throw new DryingError('conflict');
          throw new DryingError('already_voided');
        }
        try {
          await tx
            .update(dryingReadings)
            .set({ voidedByActorId: caller.actorId, voidChangeId: input.changeId, voidDigest: digest })
            .where(and(eq(dryingReadings.companyId, caller.companyId), eq(dryingReadings.id, readingId), isNull(dryingReadings.voidChangeId)));
        } catch (error) {
          // The change id already voided another reading.
          refusedByDatabase(error);
        }
        await audit(tx, caller, 'drying_reading_voided', job.id, { reading: readingId, change: input.changeId });
        return voidReceiptOf((await readingById(tx, caller.companyId, readingId))!);
      });
    },
  };
}
