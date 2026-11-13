import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { actors, auditEvents, evidenceObjects, jobClaims, jobCustomers, jobs, jobSubmissions } from '@/db/schema';
import { withCompany, type CompanyTransaction, type Database } from '@/db/tenant';
import type { Capability } from '@/lib/access';
import { manifestDigest, type FieldManifest } from '@/lib/field/canonical';
import { hasAny, jobAccess, JobError, type JobCaller, type JobRow } from '@/lib/jobs/access';
import { SubmissionError, type SubmissionErrorCode } from './errors';
import type { FenceStore } from './fence';
import { submitDigest, type NextDraftInput, type SubmitInput } from './schema';
import { manifestProblem, SNAPSHOT_FORMAT, snapshotBytes, snapshotManifest, storedManifest, type Snapshot } from './snapshot';

// Submit and Back to editing (S5a-8; docs/plans/S5.md, section 4). Field work lives in the Firestore
// field draft until Submit; Submit closes a fence on the draft, writes one immutable submission
// record in Postgres and marks the draft submitted. Firestore and Postgres share no transaction, so:
//
// 1. Intent row first. Under the job's row lock the server checks access and that the draft is the
//    job's current draft, then inserts a `pending` row with a server-made epoch and an expiry.
//    Postgres so knows every fence before it exists. The same id and body continues its row; the
//    same id with another body is 409; a row that was aborted is 409 "start again". While another
//    attempt on the draft is pending and unexpired, a new one is 409 (two phones: one record).
// 2. Fence: `editing` becomes `submitting` with {submissionId, epoch, expiresAt}. From here the
//    field rules refuse every phone write and the photo route refuses a new photo.
// 3. Snapshot: the fenced draft is read once, its canonical digest recomputed and compared with the
//    phone's, every photo reference checked against the evidence registry.
// 4. One row decides. Under the job lock and the row's own lock, a still `pending` row moves to
//    `committed` (with the snapshot bytes; the job becomes `submitted`) or to `aborted`. Whichever
//    attempt (this request, a retry, the worker) decides first wins; the database refuses any later
//    change to a decided row.
// 5. Marker: only after the row is decided, and only as the row says: `submitted` after a commit,
//    back to `editing` after an abort, each for this epoch only, so a stale release never unlocks a
//    newer fence. The worker (repair.ts) writes a marker this request could not, and aborts rows
//    that stayed pending past their expiry.
//
// No Postgres transaction is held across a Firestore call. A failure talking to Firestore leaves
// the row pending: never an abort, so a retry racing a failing attempt can still commit, and never
// a release, so nothing is unlocked while its row could still commit.

// Submit and Back to editing are scope work: the owner and the estimator (docs/ACCESS.md).
const SUBMIT: readonly Capability[] = ['scope'];

// How long a pending row may wait before the worker aborts it, and how close to that a request no
// longer closes a fence it has not closed yet (so a fence never lands after the worker has given up
// on its row; the worker runs every five minutes, docs/plans/S5.md section 4 step 6).
export const SUBMIT_WINDOW_MS = 2 * 60 * 1000;
export const FENCE_MARGIN_MS = 30 * 1000;

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

// The marker of a decided row (step 5), then the row's marker state. `false` when the marker could
// not be written now: the row stays as it is for the worker. Never throws.
export async function writeMarker(db: Database, store: FenceStore, companyId: string, row: DecidedRow): Promise<boolean> {
  try {
    if (row.status === 'committed') {
      const marked = await store.markSubmitted(companyId, row.draftId, row.epoch, row.id);
      // A missing draft has no marker to write. A fence that is not this row's cannot be: every
      // fence has its own row, and only an aborted row's fence is ever replaced or released.
      if (marked === 'conflict') {
        console.error('submission marker refused', 'conflict');
        return false;
      }
    } else if (row.status === 'aborted') {
      await store.release(companyId, row.draftId, row.epoch);
    } else {
      return false;
    }
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
    console.error('submission marker unavailable', error instanceof Error ? error.name : 'unknown');
    return false;
  }
}

export function submissionsService(db: Database, store: FenceStore, options: SubmissionOptions = {}): SubmissionsService {
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
      const job = await jobAccess(tx, caller, jobId, SUBMIT, { lock: true });
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
  ): Promise<{ row: SubmissionRow; job: JobRow; decidedHere: boolean; problem: SubmissionErrorCode | null }> {
    return inCompany(caller.companyId, async (tx) => {
      const job = await jobAccess(tx, caller, jobId, SUBMIT, { lock: true });
      const row = (await submissionRow(tx, caller.companyId, id, true))!;
      if (row.status !== 'pending') return { row, job, decidedHere: false, problem: null };

      let failure = problem;
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

      if (failure || !manifest) {
        await abortPending(tx, caller.companyId, id);
        await audit(tx, caller.companyId, caller.actorId, 'submission_aborted', jobId, { reason: failure ?? 'submission_aborted' });
        return { row: (await submissionRow(tx, caller.companyId, id))!, job, decidedHere: true, problem: failure ?? 'submission_aborted' };
      }

      const [customer] = await tx
        .select({ name: jobCustomers.name, phone: jobCustomers.phone, email: jobCustomers.email })
        .from(jobCustomers)
        .where(and(eq(jobCustomers.companyId, caller.companyId), eq(jobCustomers.jobId, jobId)));
      const [claim] = await tx
        .select({
          carrier: jobClaims.carrier,
          claimNumber: jobClaims.claimNumber,
          policyNumber: jobClaims.policyNumber,
          dateOfLoss: jobClaims.dateOfLoss,
          lossCause: jobClaims.lossCause,
          adjusterName: jobClaims.adjusterName,
          adjusterEmail: jobClaims.adjusterEmail,
          adjusterPhone: jobClaims.adjusterPhone,
          deductible: jobClaims.deductible,
        })
        .from(jobClaims)
        .where(and(eq(jobClaims.companyId, caller.companyId), eq(jobClaims.jobId, jobId)));
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
        job: { propertyAddress: job.propertyAddress },
        customer: customer ?? { name: '', phone: '', email: '' },
        claim: claim ?? {},
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
      return { row: committed!, job: next!, decidedHere: true, problem: null };
    });
  }

  // Step 2: the fence, replacing one whose own row is known to be aborted (its attempt fenced late
  // and never released it). Anything else is not this attempt's to take.
  async function closeFence(caller: JobCaller, row: SubmissionRow): Promise<SubmissionErrorCode | null> {
    const fence = { submissionId: row.id, epoch: row.epoch, expiresAt: row.expiresAt };
    let result = await field(() => store.fence(caller.companyId, row.draftId, fence));
    if (result.outcome === 'held') {
      const held = result.epoch;
      const [owner] = await inCompany(caller.companyId, (tx) =>
        tx
          .select({ status: jobSubmissions.status })
          .from(jobSubmissions)
          .where(
            and(eq(jobSubmissions.companyId, caller.companyId), eq(jobSubmissions.draftId, row.draftId), sql`${jobSubmissions.epoch}::text = ${held}`),
          ),
      );
      if (owner?.status === 'aborted') result = await field(() => store.fence(caller.companyId, row.draftId, fence, held));
    }
    if (result.outcome === 'fenced') return null;
    if (result.outcome === 'missing') return 'draft_missing';
    if (result.outcome === 'submitted') return 'already_submitted';
    return 'submission_in_progress';
  }

  return {
    async submit(caller, jobId, input) {
      if (!hasAny(caller, SUBMIT)) throw new JobError('not_allowed');
      const digest = submitDigest(input);
      const row = await intent(caller, jobId, input, digest);

      if (row.status !== 'pending') {
        // A retry of a decided submission: its answer again, and its marker if still unwritten.
        if (row.markerState === 'pending') await writeMarker(db, store, caller.companyId, row);
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
          manifest = await field(() => store.read(caller.companyId, row.draftId, row.epoch));
          // No longer fenced by this epoch: the row was aborted meanwhile and its fence released.
          if (!manifest) problem = 'submission_aborted';
          else if ((await manifestDigest(manifest)) !== input.digest) problem = 'digest_mismatch';
          else problem = manifestProblem(manifest);
        }
      }

      // Steps 4 and 5.
      const decided = await decide(caller, jobId, row.id, manifest, problem);
      await writeMarker(db, store, caller.companyId, decided.row);
      if (decided.row.status === 'aborted') throw new SubmissionError(decided.decidedHere ? decided.problem! : 'submission_aborted');
      return { created: decided.decidedHere, submission: submissionView(decided.row), job: jobState(decided.job) };
    },

    async backToEditing(caller, jobId, input) {
      if (!hasAny(caller, SUBMIT)) throw new JobError('not_allowed');
      const made = await inCompany(caller.companyId, async (tx) => {
        const job = await jobAccess(tx, caller, jobId, SUBMIT, { lock: true });
        const [source] = await tx
          .select()
          .from(jobSubmissions)
          .where(
            and(
              eq(jobSubmissions.companyId, caller.companyId),
              eq(jobSubmissions.jobId, jobId),
              eq(jobSubmissions.draftId, input.fromDraftId),
              eq(jobSubmissions.status, 'committed'),
            ),
          );
        let next: JobRow | undefined = job;
        let changed = false;
        if (job.currentDraftId === input.draftId) {
          // The same change again (its answer was lost): nothing more to change in Postgres.
          if (!source || job.lastChangeId !== input.draftId) throw new SubmissionError('conflict');
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
          await audit(tx, caller.companyId, caller.actorId, 'job_back_to_editing', jobId, { revision: next!.revision });
          changed = true;
        }
        let ownerUid: string | null = null;
        if (next!.fieldOwnerActorId) {
          const [actor] = await tx
            .select({ uid: actors.uid })
            .from(actors)
            .where(and(eq(actors.companyId, caller.companyId), eq(actors.id, next!.fieldOwnerActorId)));
          ownerUid = actor?.uid ?? null;
        }
        return { job: next!, source: source!, changed, ownerUid };
      });
      // The next draft version, from the submitted record (never from the old draft, whose phone
      // copy may differ), with where it came from. A retry makes it if it is missing.
      await field(() =>
        store.createFrom(caller.companyId, input.draftId, made.ownerUid, snapshotManifest(made.source.snapshotBytes!), {
          draftId: made.source.draftId,
          submissionId: made.source.id,
        }),
      );
      return { created: made.changed, job: jobState(made.job) };
    },
  };
}
