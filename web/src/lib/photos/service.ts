import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { and, eq, inArray } from 'drizzle-orm';
import { auditEvents, evidenceObjects } from '@/db/schema';
import { withCompany, type CompanyTransaction, type Database } from '@/db/tenant';
import { jobAccess, type JobCaller, type JobRow } from '@/lib/jobs/access';
import type { DraftStates } from './drafts';
import { PhotoError } from './errors';
import { sha256Of, sniffImageType } from './image';
import type { EvidenceStore } from './store';

// Photo bytes of a job (S5a-5): the receipt for a photo or its full-size original, and the read.
// Every database step runs inside withCompany for the company of the verified sign-in and goes
// through the one job-access function. Bytes pass through the app server, so the bucket needs no
// signing key and no browser ever holds a bucket address.

export type PhotoKind = 'photo' | 'original';

// Who may do what (docs/ACCESS.md, "Photo routes"): sending needs `photos` (owner, estimator);
// reading needs only the right to see the job (`jobs_read`), so office can look at a job's photos.
const SEND = ['photos'] as const;
const READ = ['jobs_read'] as const;

export type Receipt = {
  photoId: string;
  kind: PhotoKind;
  sha256: string;
  sizeBytes: number;
  contentType: string;
  createdAt: string;
};

export type PhotoStream = { body: WebReadableStream<Uint8Array>; contentType: string; sizeBytes: number };

export type ReceiveInput = {
  // Called once access is settled, so a caller with no right to the job never has its body read.
  // Throws a PhotoError (too_large) when the body is over the limit.
  readBytes: () => Promise<Uint8Array>;
  // For an original: the SHA-256 of the registered photo it belongs to.
  photoSha256?: string;
};

export type PhotosService = {
  receive(caller: JobCaller, jobId: string, photoId: string, kind: PhotoKind, input: ReceiveInput): Promise<{ created: boolean; receipt: Receipt }>;
  open(caller: JobCaller, jobId: string, photoId: string, kind: PhotoKind): Promise<PhotoStream>;
};

type EvidenceRow = typeof evidenceObjects.$inferSelect;

// Under the job's own path in the bucket, named by ids only (no uid, no person's name). The name
// holds neither the hash nor a file extension: one photo id is one object name, so a second upload
// of that id meets the create-only precondition whatever its bytes or type are.
export function objectNameOf(companyId: string, jobId: string, kind: PhotoKind, photoId: string): string {
  return `companies/${companyId}/jobs/${jobId}/${kind === 'photo' ? 'photos' : 'originals'}/${photoId}`;
}

const receiptOf = (row: EvidenceRow): Receipt => ({
  photoId: row.objectId,
  kind: row.kind as PhotoKind,
  sha256: row.sha256,
  sizeBytes: row.sizeBytes,
  contentType: row.contentType,
  createdAt: row.createdAt.toISOString(),
});

async function registryRows(tx: CompanyTransaction, caller: JobCaller, jobId: string, photoId: string): Promise<EvidenceRow[]> {
  return tx
    .select()
    .from(evidenceObjects)
    .where(
      and(
        eq(evidenceObjects.companyId, caller.companyId),
        eq(evidenceObjects.jobId, jobId),
        eq(evidenceObjects.objectId, photoId),
        inArray(evidenceObjects.kind, ['photo', 'original']),
      ),
    );
}

export function photosService(db: Database, store: EvidenceStore, drafts: DraftStates): PhotosService {
  // A new photo needs a job still on its draft, and a draft still being edited. The job's status is
  // read under the job's row lock when the row is made; the draft's state is read here, before the
  // bytes are stored. A fence that lands in between changes nothing: the submission's snapshot
  // lists its own photo ids and hashes (docs/plans/S5.md, section 4, step 4).
  async function requireEditing(caller: JobCaller, job: JobRow): Promise<void> {
    if (job.status !== 'draft') throw new PhotoError('draft_locked');
    let state: string | null;
    try {
      state = await drafts.state(caller.companyId, job.currentDraftId);
    } catch (error) {
      console.error('photo draft state unavailable', error instanceof Error ? error.name : 'unknown');
      throw new PhotoError('photos_unavailable');
    }
    if (state === null) throw new PhotoError('photos_unavailable');
    if (state !== 'editing') throw new PhotoError('draft_locked');
  }

  return {
    async receive(caller, jobId, photoId, kind, input) {
      // 1. Access, and what the registry already holds for this id. No lock: nothing is changed yet.
      const seen = await withCompany(db, caller.companyId, async (tx) => {
        const job = await jobAccess(tx, caller, jobId, SEND);
        const rows = await registryRows(tx, caller, jobId, photoId);
        return { job, same: rows.find((row) => row.kind === kind), photo: rows.find((row) => row.kind === 'photo') };
      });

      const bytes = await input.readBytes();
      if (bytes.byteLength === 0) throw new PhotoError('invalid_request');
      const contentType = sniffImageType(bytes);
      if (contentType === null) throw new PhotoError('unsupported_image');
      const sha256 = sha256Of(bytes);

      // 2. Sent before: the same bytes are the same receipt (a lost response is settled by sending
      // again), other bytes under the same id are a conflict.
      if (seen.same) {
        if (seen.same.sha256 !== sha256) throw new PhotoError('photo_conflict');
        return { created: false, receipt: receiptOf(seen.same) };
      }

      // 3. The state rule for a new object, by kind.
      if (kind === 'photo') {
        await requireEditing(caller, seen.job);
      } else {
        // An original may arrive after signing, but only for a photo the job already holds, and
        // only when it names that photo's hash.
        if (!seen.photo || !input.photoSha256) throw new PhotoError('photo_missing');
        if (seen.photo.sha256 !== input.photoSha256) throw new PhotoError('photo_conflict');
      }

      // 4. The bytes, create-only. An object already there with these bytes is a first attempt
      // that stored them and then lost its place (the registry row below was never made): it is
      // registered now. One with other bytes is a conflict.
      const name = objectNameOf(caller.companyId, jobId, kind, photoId);
      let made;
      try {
        made = await store.create(name, bytes, contentType, sha256);
      } catch (error) {
        console.error('photo store unavailable', error instanceof Error ? error.name : 'unknown');
        throw new PhotoError('photos_unavailable');
      }
      if (made.outcome === 'exists' && made.sha256 !== sha256) throw new PhotoError('photo_conflict');

      // 5. The registry row, once. Two requests that stored the same bytes at once make one row.
      return withCompany(db, caller.companyId, async (tx) => {
        const job = await jobAccess(tx, caller, jobId, SEND, { lock: true });
        if (kind === 'photo' && job.status !== 'draft') throw new PhotoError('draft_locked');
        const [inserted] = await tx
          .insert(evidenceObjects)
          .values({
            companyId: caller.companyId,
            jobId,
            objectId: photoId,
            kind,
            objectName: name,
            generation: made.generation,
            sha256,
            sizeBytes: bytes.byteLength,
            contentType,
            createdByActorId: caller.actorId,
          })
          .onConflictDoNothing()
          .returning();
        if (inserted) {
          await tx.insert(auditEvents).values({
            companyId: caller.companyId,
            actorId: caller.actorId,
            action: kind === 'photo' ? 'photo_received' : 'photo_original_received',
            target: jobId,
            details: { kind, sizeBytes: bytes.byteLength },
          });
          return { created: true, receipt: receiptOf(inserted) };
        }
        const [existing] = (await registryRows(tx, caller, jobId, photoId)).filter((row) => row.kind === kind);
        if (!existing || existing.sha256 !== sha256) throw new PhotoError('photo_conflict');
        return { created: false, receipt: receiptOf(existing) };
      });
    },

    async open(caller, jobId, photoId, kind) {
      const row = await withCompany(db, caller.companyId, async (tx) => {
        await jobAccess(tx, caller, jobId, READ);
        return (await registryRows(tx, caller, jobId, photoId)).find((found) => found.kind === kind);
      });
      if (!row) throw new PhotoError('not_found');
      let body;
      try {
        body = await store.open(row.objectName, row.generation);
      } catch (error) {
        console.error('photo store unavailable', error instanceof Error ? error.name : 'unknown');
        throw new PhotoError('photos_unavailable');
      }
      // A registered object that is not in the bucket is a fault, not a missing photo.
      if (!body) throw new PhotoError('photos_unavailable');
      return { body, contentType: row.contentType, sizeBytes: row.sizeBytes };
    },
  };
}
