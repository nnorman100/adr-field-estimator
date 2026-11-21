import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { isQueueTimeout } from '@/db/client';
import { auditEvents, evidenceObjects, jobs, jobSubmissions } from '@/db/schema';
import { holdAcrossOutsideCall, withCompany, type CompanyTransaction, type Database } from '@/db/tenant';
import type { Capability } from '@/lib/access';
import { manifestDigest, type FieldManifest } from '@/lib/field/canonical';
import { roomFieldSchema } from '@/lib/field/schema';
import { claimDraft, hasAny, holdDraft, jobAccess, JobError, type JobCaller, type JobRow } from '@/lib/jobs/access';
import { jobPriceTable, namesPriceIds, priceIdsKnown, PricesUnreadable } from '@/lib/scope-lists/version';
import { readJobDetails } from './details';
import { SubmissionError, type SubmissionErrorCode } from './errors';
import { noDraft } from '@/lib/jobs/drafts';
import { afterFieldStep, stillMember, syncJobDrafts } from '@/lib/jobs/sync-job';
import type { DraftSync } from '@/lib/jobs/draft-sync';
import type { FenceStore } from './fence';
import { submitDigest, type NextDraftInput, type SubmitInput } from './schema';
import { manifestProblem, SNAPSHOT_FORMAT, snapshotBytes, storedManifest, type Snapshot } from './snapshot';

// Submit and Back to editing (S5a-8; docs/plans/S5.md, section 4). Field work lives in the Firestore
// field draft until Submit; Submit closes a fence on the draft, writes one immutable submission
// record in Postgres and marks the draft submitted. Firestore and Postgres share no transaction, so:
//
// 1. Intent row first. Under the job's row lock the server checks access and that the draft is the
//    job's current draft, then inserts a `pending` row with a server-made epoch and an expiry.
//    Postgres so knows every fence before it exists. The same id and body continues its row; the
//    same id with another body is 409; a row that was aborted is 409 "start again". While another
//    attempt on the draft is pending and unexpired, a new one is 409 (two phones: one record).
// 2. Fence: the job's draft sync (src/lib/jobs/sync-job.ts) writes what Postgres now says, the pending
//    row's fence among it: `editing` becomes `submitting` with {submissionId, epoch, expiresAt}. From
//    here the field rules refuse every phone write and the photo route refuses a new photo.
// 3. Snapshot: the fenced draft is read once, its canonical digest recomputed and compared with the
//    phone's, every photo reference checked against the evidence registry.
// 4. One row decides. Under the job lock and the row's own lock, a still `pending` row moves to
//    `committed` (with the snapshot bytes; the job becomes `submitted`) or to `aborted`. Whichever
//    attempt (this request, a retry, the worker) decides first wins; the database refuses any later
//    change to a decided row.
// 5. Marker: only after the row is decided, the job's draft sync again, at the version the decision
//    made (every change to a submission row raises jobs.field_revision, migration 0018): `submitted`
//    after a commit, back to `editing` after an abort. A sync that read Postgres before a later change
//    is refused at the job's marker document, or writes nothing when Postgres had moved on by its
//    in-transaction version check. A change that commits in the milliseconds between that check and
//    the Firestore commit can still see the older write land (the accepted residual window, the test
//    release runbook); the sync reads the version again after its commit and syncs the job again at
//    once. The worker (repair.ts) syncs a job whose decided row this request could not, and aborts rows
//    that stayed pending past their expiry.
//
// No Postgres transaction is held across a Firestore call. A failure talking to Firestore leaves the
// row pending: never an abort, so a retry racing a failing attempt can still commit, and never a
// release, so nothing is unlocked while its row could still commit.

// Submit and Back to editing are scope work: the owner and the estimator (docs/ACCESS.md).
const SUBMIT: readonly Capability[] = ['scope'];

// How long a pending row may wait before the worker aborts it, and how close to that a request no
// longer closes a fence it has not closed yet, so an attempt does not start a fence its row is about
// to lose (the worker runs every five minutes, docs/plans/S5.md section 4 step 6). While closeFence's
// transaction is open, its row lock, not this margin, keeps a fence from landing after its row is
// decided. A fence call still retrying after that transaction ended (cut off by the server's idle
// limit, db/tenant.ts holdAcrossOutsideCall, or by the request's end) is the draft sync's, which writes
// only at the job's newest version: once the worker aborted the row, the late fence is refused at the
// job's marker (src/lib/jobs/draft-sync.ts). The margin is no rollout measure: it keeps today's Submit
// from closing a fence its own row is about to lose.
export const SUBMIT_WINDOW_MS = 2 * 60 * 1000;
export const FENCE_MARGIN_MS = 30 * 1000;

/** What Submit writes through: the fence store's read and Back to editing, and the job's draft sync. */
export type SubmitStore = FenceStore & DraftSync;

export type SubmissionOptions = { windowMs?: number; fenceMarginMs?: number; now?: () => Date };

export type SubmissionView = {
  id: string;
  jobId: string;
  draftId: string;
  status: 'committed';
  snapshotSha256: string;
  createdAt: string;
  decidedAt: string;
};

export type JobState = { id: string; status: JobRow['status']; currentDraftId: string; revision: number };

export type SubmissionsService = {
  submit(caller: JobCaller, jobId: string, input: SubmitInput): Promise<{ created: boolean; submission: SubmissionView; job: JobState }>;
  backToEditing(caller: JobCaller, jobId: string, input: NextDraftInput): Promise<{ created: boolean; job: JobState }>;
};

type SubmissionRow = typeof jobSubmissions.$inferSelect;

const UNIQUE_VIOLATION = '23505';

function errorCode(error: unknown): unknown {
  const found = error as { code?: unknown; cause?: { code?: unknown } } | null;
  return found?.code ?? found?.cause?.code;
}

// Whether the rooms' types and items are in the job's price version (its pin, else the company's
// current version; docs/plans/S5.md S5a-10), or why not. A draft naming none of either reads no
// version. The manifest already passed `manifestProblem`, so each room map parses.
async function priceIdProblem(tx: CompanyTransaction, companyId: string, jobId: string, manifest: FieldManifest): Promise<SubmissionErrorCode | null> {
  const rooms = manifest.rooms.map((room) => roomFieldSchema.parse(room.field ?? {}));
  if (!namesPriceIds(rooms)) return null;
  try {
    const found = await jobPriceTable(tx, companyId, jobId);
    return priceIdsKnown(rooms, found?.table ?? null) ? null : 'unknown_price_ids';
  } catch (error) {
    if (error instanceof PricesUnreadable) return 'prices_unreadable';
    throw error;
  }
}

const jobState = (row: JobRow): JobState => ({ id: row.id, status: row.status, currentDraftId: row.currentDraftId, revision: row.revision });

function submissionView(row: SubmissionRow): SubmissionView {
  return {
    id: row.id,
    jobId: row.jobId,
    draftId: row.draftId,
    status: 'committed',
    snapshotSha256: row.snapshotSha256!,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt!.toISOString(),
  };
}

async function audit(
  tx: CompanyTransaction,
  companyId: string,
  actorId: string | null,
  action: string,
  jobId: string,
  details: Record<string, string | number | boolean> = {},
): Promise<void> {
  await tx.insert(auditEvents).values({ companyId, actorId, action, target: jobId, details });
}

async function submissionRow(tx: CompanyTransaction, companyId: string, id: string, lock = false): Promise<SubmissionRow | undefined> {
  const found = tx
    .select()
    .from(jobSubmissions)
    .where(and(eq(jobSubmissions.companyId, companyId), eq(jobSubmissions.id, id)));
  const [row] = await (lock ? found.for('update') : found);
  return row;
}

// Moves a still pending row to aborted; false when it was already decided.
export async function abortPending(tx: CompanyTransaction, companyId: string, id: string): Promise<boolean> {
  const moved = await tx
    .update(jobSubmissions)
    .set({ status: 'aborted' })
    .where(and(eq(jobSubmissions.companyId, companyId), eq(jobSubmissions.id, id), eq(jobSubmissions.status, 'pending')))
    .returning({ id: jobSubmissions.id });
  return moved.length > 0;
}

export type DecidedRow = Pick<SubmissionRow, 'id' | 'jobId' | 'draftId' | 'epoch' | 'status'>;

// The marker of a decided row (step 5): the job's draft sync, then the row's marker state. `false` when
// the drafts could not be synced now: the row stays as it is for the worker. Never throws, except when
// no database connection came free in time (isQueueTimeout): a request answers 503 (the record stands,
// and the same request again writes the marker), and the worker's pass ends there.
export async function writeMarker(db: Database, store: SubmitStore, companyId: string, row: DecidedRow): Promise<boolean> {
  if (row.status === 'pending') return false;
  try {
    // Postgres's state now, the decision among it. A current draft that cannot be made now is refused
    // (JobError draft_unavailable) and left for the next pass. A conflict (the current draft is another
    // job's, or rooms or photos are left under its id) leaves nothing this row could still release or
    // mark: the decision is final, so the row's marker is done, and the job stays due for the draft
    // sync's repair pass, which reports it.
    // A current draft that is missing and cannot be made now (JobError draft_unavailable, with the
    // draft not there) leaves nothing to release or mark either: settled, and the repair pass makes the
    // draft once its content can be read. The field database failing leaves the row for the next pass.
    await syncJobDrafts(db, store, store, companyId, row.jobId).catch(async (error: unknown) => {
      if (error instanceof JobError && error.code === 'conflict') {
        console.error('submission marker refused', 'conflict');
        return;
      }
      if (error instanceof JobError && error.code === 'draft_unavailable') {
        const [job] = await withCompany(db, companyId, (tx) =>
          tx.select({ currentDraftId: jobs.currentDraftId }).from(jobs).where(and(eq(jobs.companyId, companyId), eq(jobs.id, row.jobId))),
        );
        const found = job ? await store.findDraft(companyId, job.currentDraftId) : null;
        if (job && noDraft(found)) {
          console.error('submission marker refused', 'draft_missing');
          return;
        }
      }
      throw error;
    });
    await withCompany(db, companyId, async (tx) => {
      await tx
        .update(jobSubmissions)
        .set({ markerState: 'done' })
        .where(
          and(
            eq(jobSubmissions.companyId, companyId),
            eq(jobSubmissions.id, row.id),
            eq(jobSubmissions.markerState, 'pending'),
            sql`${jobSubmissions.status} <> 'pending'`,
          ),
        );
    });
    return true;
  } catch (error) {
    if (isQueueTimeout(error)) throw error;
    console.error('submission marker unavailable', error instanceof Error ? error.name : 'unknown');
    return false;
  }
}

export function submissionsService(db: Database, store: SubmitStore, options: SubmissionOptions = {}): SubmissionsService {
  const windowMs = options.windowMs ?? SUBMIT_WINDOW_MS;
  const marginMs = Math.min(options.fenceMarginMs ?? FENCE_MARGIN_MS, windowMs / 2);
  const now = options.now ?? (() => new Date());

  async function inCompany<T>(companyId: string, run: (tx: CompanyTransaction) => Promise<T>): Promise<T> {
    try {
      return await withCompany(db, companyId, run);
    } catch (error) {
      if (errorCode(error) === UNIQUE_VIOLATION) throw new SubmissionError('conflict');
      throw error;
    }
  }

  // A Firestore call: an error is "try again", never a decision.
  async function field<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      console.error('submission field draft unavailable', error instanceof Error ? error.name : 'unknown');
      throw new SubmissionError('submissions_unavailable');
    }
  }

  // Step 1.
  async function intent(caller: JobCaller, jobId: string, input: SubmitInput, digest: string): Promise<SubmissionRow> {
    return inCompany(caller.companyId, async (tx) => {
      // Submit closes the field work: only its field owner submits, whatever their role.
      const job = await jobAccess(tx, caller, jobId, SUBMIT, { lock: true, fieldWork: true });
      const existing = await submissionRow(tx, caller.companyId, input.id);
      if (existing) {
        if (existing.jobId !== jobId || existing.requestDigest !== digest) throw new SubmissionError('conflict');
        return existing;
      }
      if (job.status === 'signed') throw new SubmissionError('job_signed');
      if (job.status !== 'draft') throw new SubmissionError('already_submitted');
      if (input.draftId !== job.currentDraftId) throw new SubmissionError('not_current_draft');
      // Another attempt on this draft: still running (409), or past its expiry, when it is aborted
      // here as the worker would; its fence, if it closed one, is replaced at step 2.
      const others = await tx
        .select({ id: jobSubmissions.id, expired: sql<boolean>`${jobSubmissions.expiresAt} <= now()` })
        .from(jobSubmissions)
        .where(
          and(
            eq(jobSubmissions.companyId, caller.companyId),
            eq(jobSubmissions.draftId, input.draftId),
            eq(jobSubmissions.status, 'pending'),
          ),
        )
        .for('update');
      if (others.some((other) => !other.expired)) throw new SubmissionError('submission_in_progress');
      for (const other of others) {
        if (await abortPending(tx, caller.companyId, other.id)) {
          await audit(tx, caller.companyId, caller.actorId, 'submission_aborted', jobId, { reason: 'expired' });
        }
      }
      const [row] = await tx
        .insert(jobSubmissions)
        .values({
          id: input.id,
          companyId: caller.companyId,
          jobId,
          draftId: input.draftId,
          epoch: randomUUID(),
          kind: 'original',
          requestDigest: digest,
          expiresAt: sql`now() + make_interval(secs => ${windowMs / 1000})`,
          createdByActorId: caller.actorId,
        })
        .returning();
      await audit(tx, caller.companyId, caller.actorId, 'submission_started', jobId, { revision: job.revision });
      return row!;
    });
  }

  // Step 4, for a row whose outcome this request has worked out: `problem` null to commit.
  async function decide(
    caller: JobCaller,
    jobId: string,
    id: string,
    manifest: FieldManifest | null,
    problem: SubmissionErrorCode | null,
  ): Promise<{ row: SubmissionRow; job: JobRow; decidedHere: boolean; problem: SubmissionErrorCode | null; refused: JobError | null }> {
    return inCompany(caller.companyId, async (tx) => {
      // The caller lost the job or its field work after this attempt started (the field work moved,
      // or they were unassigned): the attempt is still decided, as an abort, and its fence released.
      let refused = null as JobError | null;
      const job = await jobAccess(tx, caller, jobId, SUBMIT, { lock: true, fieldWork: true }).catch(async (error: unknown) => {
        if (!(error instanceof JobError)) throw error;
        refused = error;
        const [locked] = await tx
          .select()
          .from(jobs)
          .where(and(eq(jobs.companyId, caller.companyId), eq(jobs.id, jobId)));
        return locked!;
      });
      const row = (await submissionRow(tx, caller.companyId, id, true))!;
      if (row.status !== 'pending') return { row, job, decidedHere: false, problem: null, refused };

      let failure = problem ?? (refused ? 'submission_aborted' : null);
      if (!failure && (job.status !== 'draft' || job.currentDraftId !== row.draftId)) failure = 'not_current_draft';
      let photos: (typeof evidenceObjects.$inferSelect)[] = [];
      if (!failure && manifest) {
        const ids = manifest.photos.map((photo) => photo.id);
        photos =
          ids.length === 0
            ? []
            : await tx
                .select()
                .from(evidenceObjects)
                .where(
                  and(
                    eq(evidenceObjects.companyId, caller.companyId),
                    eq(evidenceObjects.jobId, jobId),
                    eq(evidenceObjects.kind, 'photo'),
                    inArray(evidenceObjects.objectId, ids),
                  ),
                );
        if (photos.length !== ids.length) failure = 'photo_missing';
      }
      if (!failure && manifest) failure = await priceIdProblem(tx, caller.companyId, jobId, manifest);

      if (failure || !manifest) {
        await abortPending(tx, caller.companyId, id);
        await audit(tx, caller.companyId, caller.actorId, 'submission_aborted', jobId, { reason: failure ?? 'submission_aborted' });
        return { row: (await submissionRow(tx, caller.companyId, id))!, job, decidedHere: true, problem: failure ?? 'submission_aborted', refused };
      }

      const details = await readJobDetails(tx, caller.companyId, job);
      const byId = new Map(photos.map((photo) => [photo.objectId, photo]));
      const snapshot: Snapshot = {
        format: SNAPSHOT_FORMAT,
        submissionId: row.id,
        jobId,
        draftId: row.draftId,
        fieldSha256: await manifestDigest(manifest),
        field: storedManifest(manifest),
        photos: manifest.photos
          .map((photo) => byId.get(photo.id)!)
          .map((photo) => ({ id: photo.objectId, sha256: photo.sha256, sizeBytes: photo.sizeBytes, contentType: photo.contentType }))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
        ...details,
      };
      const { bytes, sha256 } = snapshotBytes(snapshot);
      const [committed] = await tx
        .update(jobSubmissions)
        .set({ status: 'committed', snapshotBytes: bytes, snapshotSha256: sha256 })
        .where(and(eq(jobSubmissions.companyId, caller.companyId), eq(jobSubmissions.id, id), eq(jobSubmissions.status, 'pending')))
        .returning();
      const [next] = await tx
        .update(jobs)
        .set({ status: 'submitted', revision: sql`${jobs.revision} + 1`, updatedAt: sql`now()` })
        .where(and(eq(jobs.companyId, caller.companyId), eq(jobs.id, jobId)))
        .returning();
      await audit(tx, caller.companyId, caller.actorId, 'submission_committed', jobId, {
        revision: next!.revision,
        rooms: manifest.rooms.length,
        photos: manifest.photos.length,
      });
      return { row: committed!, job: next!, decidedHere: true, problem: null, refused };
    });
  }

  // Step 2: the fence, as the job's draft sync writes it. Only while the caller still owns the job's
  // field work and the row is still pending (a short transaction of its own, held across nothing); a
  // move or an abort after that check is the next sync's to write, and this one is refused at the
  // job's marker or writes nothing (it reads Postgres's version again before it writes; a change in the
  // milliseconds between that read and the Firestore commit is the accepted residual window, closed by
  // the sync's catch-up after its commit). A fence of an
  // aborted attempt is replaced, as Postgres knows that epoch released; a draft held by an attempt
  // Postgres does not know, or by a recorded one, is not this attempt's to take.
  async function closeFence(caller: JobCaller, row: SubmissionRow): Promise<SubmissionErrorCode | null> {
    const allowed = await inCompany(caller.companyId, async (tx) => {
      const owner = await jobAccess(tx, caller, row.jobId, SUBMIT, { lock: true, fieldWork: true }).then(
        () => true,
        (error: unknown) => {
          if (error instanceof JobError) return false;
          throw error;
        },
      );
      return owner && (await submissionRow(tx, caller.companyId, row.id, true))?.status === 'pending';
    });
    if (!allowed) return 'submission_aborted';
    // A missing draft (or a placeholder left where one was) holds no field work to submit: never made
    // here for a fence.
    const found = await field(() => store.findDraft(caller.companyId, row.draftId));
    if (noDraft(found)) return 'draft_missing';
    let synced: Awaited<ReturnType<typeof syncJobDrafts>>;
    try {
      synced = await syncJobDrafts(db, store, store, caller.companyId, row.jobId);
    } catch (error) {
      if (!(error instanceof JobError && (error.code === 'conflict' || error.code === 'draft_unavailable'))) throw error;
      // The draft gone since the lookup above (the sync would not make it for a fence, and rooms or
      // photos left under its id are a conflict): draft_missing, as if the lookup had found it gone;
      // otherwise the draft's conflict, or the field database unavailable.
      const again = await field(() => store.findDraft(caller.companyId, row.draftId));
      if (noDraft(again)) return 'draft_missing';
      throw new SubmissionError(error.code === 'conflict' ? 'conflict' : 'submissions_unavailable');
    }
    const { result } = synced;
    if ((result.outcome === 'synced' || result.outcome === 'same') && result.superseded.includes(row.draftId)) return 'submission_in_progress';
    return null;
  }

  return {
    async submit(caller, jobId, input) {
      if (!hasAny(caller, SUBMIT)) throw new JobError('not_allowed');
      const digest = submitDigest(input);
      const row = await intent(caller, jobId, input, digest);

      if (row.status !== 'pending') {
        // A retry of a decided submission: its answer again, and its marker if still unwritten; the answer
        // only to a caller still an active member of an active company (afterFieldStep).
        await afterFieldStep(db, caller, async () => {
          if (row.markerState === 'pending') await writeMarker(db, store, caller.companyId, row);
        });
        if (row.status === 'aborted') throw new SubmissionError('submission_aborted');
        const job = await inCompany(caller.companyId, (tx) => jobAccess(tx, caller, jobId, SUBMIT));
        return { created: false, submission: submissionView(row), job: jobState(job) };
      }

      // Steps 2 and 3. Too close to the expiry to close a fence now: stop, as the worker would.
      let manifest: FieldManifest | null = null;
      let problem: SubmissionErrorCode | null = null;
      if (now().getTime() > row.expiresAt.getTime() - marginMs) {
        problem = 'submission_aborted';
      } else {
        problem = await closeFence(caller, row);
        if (!problem) {
          const read = await field(() => store.read(caller.companyId, row.draftId, row.epoch));
          if (read === 'too_many_rooms') problem = 'draft_invalid';
          else if (read === 'too_many_photos') problem = 'too_many_photos';
          else {
            manifest = read;
            // No longer fenced by this epoch: the row was aborted meanwhile and its fence released.
            if (!manifest) problem = 'submission_aborted';
            else if ((await manifestDigest(manifest)) !== input.digest) problem = 'digest_mismatch';
            else problem = manifestProblem(manifest);
          }
        }
      }

      // Steps 4 and 5.
      const decided = await decide(caller, jobId, row.id, manifest, problem);
      // The record stands whatever comes next; its answer only to a caller still an active member of an
      // active company with its role, read again after the marker's field step (afterFieldStep).
      await afterFieldStep(db, caller, () => writeMarker(db, store, caller.companyId, decided.row));
      if (decided.refused) throw decided.refused;
      if (decided.row.status === 'aborted') throw new SubmissionError(decided.decidedHere ? decided.problem! : 'submission_aborted');
      return { created: decided.decidedHere, submission: submissionView(decided.row), job: jobState(decided.job) };
    },

    async backToEditing(caller, jobId, input) {
      if (!hasAny(caller, SUBMIT)) throw new JobError('not_allowed');
      const made = await inCompany(caller.companyId, async (tx) => {
        // A new draft version of the field work: the field owner's to make.
        const job = await jobAccess(tx, caller, jobId, SUBMIT, { lock: true, fieldWork: true });
        // A next draft is never the draft it comes from (security audit F1): refused here, before any
        // claim, so the refused id commits nothing.
        if (input.draftId === input.fromDraftId) throw new SubmissionError('conflict');
        // The job's latest record: a new draft is made only from it.
        // Its id and draft only: the draft sync reads the record's bytes itself, after the commit.
        const [latest] = await tx
          .select({ id: jobSubmissions.id, draftId: jobSubmissions.draftId })
          .from(jobSubmissions)
          .where(
            and(
              eq(jobSubmissions.companyId, caller.companyId),
              eq(jobSubmissions.jobId, jobId),
              eq(jobSubmissions.status, 'committed'),
            ),
          )
          .orderBy(desc(jobSubmissions.createdAt))
          .limit(1);
        const source = latest?.draftId === input.fromDraftId ? latest : undefined;
        let next: JobRow | undefined = job;
        let changed = false;
        if (job.currentDraftId === input.draftId) {
          // The same change again (its answer was lost): nothing more to change in Postgres.
          if (!source) throw new SubmissionError('conflict');
          // A retry holds its draft id for the job in Postgres (security audit F1), in this transaction, which
          // commits before the field database is touched: a draft the previous version made is stamped only
          // once the claim is committed, so a lost answer from that stamp never leaves it unclaimed.
          if (!(await holdDraft(tx, caller.companyId, jobId, input.draftId))) throw new SubmissionError('conflict');
        } else {
          if (job.status === 'signed') throw new SubmissionError('job_signed');
          // Only from the job's current draft: a second call with another new id is 409.
          if (job.currentDraftId !== input.fromDraftId) throw new SubmissionError('conflict');
          if (job.status !== 'submitted' || !source) throw new SubmissionError('not_submitted');
          [next] = await tx
            .update(jobs)
            .set({
              status: 'draft',
              currentDraftId: input.draftId,
              revision: sql`${jobs.revision} + 1`,
              lastChangeId: input.draftId,
              updatedAt: sql`now()`,
            })
            .where(and(eq(jobs.companyId, caller.companyId), eq(jobs.id, jobId)))
            .returning();
          if (!(await claimDraft(tx, caller.companyId, jobId, input.draftId))) throw new SubmissionError('conflict');
          // A draft id claimed now was never this job's: a draft already under it was made for another
          // job or from another submission.
          await holdAcrossOutsideCall(tx);
          if (await field(() => store.findDraft(caller.companyId, input.draftId))) throw new SubmissionError('conflict');
          await audit(tx, caller.companyId, caller.actorId, 'job_back_to_editing', jobId, { revision: next!.revision });
          changed = true;
        }
        return { job: next!, changed };
      });
      // The next draft version, as the draft sync makes every draft (the draft life-cycle redesign, slice 5):
      // from the job's latest committed record (never from the old draft, whose phone copy may differ), with
      // where it came from, less the scope confirmation when an owner reprice postdates it (pricing plan 3),
      // naming the field owner Postgres holds when the sync reads it. A retry makes it if it is missing; a
      // draft another job holds under the id is 409; a placeholder an older version left is replaced. Its
      // 503 stays Submit's own (submissions_unavailable), as the phone reads it; its answer goes only to a
      // caller still an active member of an active company (afterFieldStep).
      await afterFieldStep(db, caller, () =>
        syncJobDrafts(db, store, store, caller.companyId, jobId, { requireDraft: true }).catch((error: unknown) => {
          if (error instanceof JobError && error.code === 'draft_unavailable') throw new SubmissionError('submissions_unavailable');
          throw error;
        }),
      );
      // The job as Postgres holds it after the field step, read with the caller's access again: a change
      // committed meanwhile (an archive) is the answer, not the row this request wrote. The locator follows
      // that read.
      const job = await withCompany(
        db,
        caller.companyId,
        async (tx) => {
          // The caller still a member of an active company, in the same snapshot as the job read.
          await stillMember(tx, caller);
          return jobAccess(tx, caller, jobId, SUBMIT);
        },
        { snapshot: true },
      );
      // The locator write is a field step too: the caller is checked again after it, written or not.
      await afterFieldStep(db, caller, () => field(() => store.projectJob(caller.companyId, jobId, { currentDraftId: job.currentDraftId, revision: job.revision })));
      return { created: made.changed, job: jobState(job) };
    },
  };
}
