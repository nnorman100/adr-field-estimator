import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { and, eq, inArray } from 'drizzle-orm';
import { auditEvents, evidenceObjects } from '@/db/schema';
import { withCompany, type CompanyTransaction, type Database } from '@/db/tenant';
import { MAX_PHOTO_REFS } from '@/lib/field/schema';
import { currentEstimateRow } from '@/lib/estimates/service';
import { jobAccess, type JobCaller, type JobRow } from '@/lib/jobs/access';
import type { DraftStates } from './drafts';
import { PhotoError } from './errors';
import { sha256Of, sniffImageType } from './image';
import type { EvidenceStore } from './store';

// Photo bytes of a job (S5a-5): the receipt for a photo or its full-size original, and the read.
// The customer's signature image (S5a-11) comes through the same receipt as a third kind.
// Every database step runs inside withCompany for the company of the verified sign-in and goes
// through the one job-access function. Bytes pass through the app server, so the bucket needs no
// signing key and no browser ever holds a bucket address.

export type PhotoKind = 'photo' | 'original' | 'signature';

// Who may do what (docs/ACCESS.md, "Photo routes"): sending a photo needs `photos` (owner,
// estimator), sending a signature needs `sign` (who presents the documents for signing); reading
// needs only the right to see the job (`jobs_read`), so office can look at a job's photos.
const SEND = ['photos'] as const;
const SIGN = ['sign'] as const;
const READ = ['jobs_read'] as const;
const sendNeeds = (kind: PhotoKind) => (kind === 'signature' ? SIGN : SEND);

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
const FOLDERS: Record<PhotoKind, string> = { photo: 'photos', original: 'originals', signature: 'signatures' };

export function objectNameOf(companyId: string, jobId: string, kind: PhotoKind, photoId: string): string {
  return `companies/${companyId}/jobs/${jobId}/${FOLDERS[kind]}/${photoId}`;
}

const RECEIVED: Record<PhotoKind, string> = { photo: 'photo_received', original: 'photo_original_received', signature: 'signature_received' };

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
        inArray(evidenceObjects.kind, ['photo', 'original', 'signature']),
      ),
    );
}

export function photosService(db: Database, store: EvidenceStore, drafts: DraftStates): PhotosService {
  // A new photo needs a job still on its draft, and a draft still being edited that holds fewer than
  // MAX_PHOTO_REFS photo references (Submit refuses more, should two phones race past the count).
  // The job's status is read under the job's row lock when the row is made; the draft's state and
  // count are read here, before the bytes are stored. A fence that lands in between changes nothing: the submission's snapshot
  // lists its own photo ids and hashes (docs/plans/S5.md, section 4, step 4).
  async function requireEditing(caller: JobCaller, job: JobRow): Promise<void> {
    if (job.status !== 'draft') throw new PhotoError('draft_locked');
    let state: string | null;
    let refs: number;
    try {
      state = await drafts.state(caller.companyId, job.currentDraftId);
      refs = state === 'editing' ? await drafts.photoRefs(caller.companyId, job.currentDraftId) : 0;
    } catch (error) {
      console.error('photo draft state unavailable', error instanceof Error ? error.name : 'unknown');
      throw new PhotoError('photos_unavailable');
    }
    if (state === null) throw new PhotoError('photos_unavailable');
    if (state !== 'editing') throw new PhotoError('draft_locked');
    if (refs >= MAX_PHOTO_REFS) throw new PhotoError('photo_limit');
  }

  // A signature needs a current unsigned estimate (docs/plans/S5.md, S5a-5 and S5a-11): the job is
  // submitted, not signed, and its current record and pin have been priced. Read under the job's
  // row lock when the row is made; the agreement checks the rest (which estimate, its proposal).
  async function requireSignable(tx: CompanyTransaction, caller: JobCaller, job: JobRow): Promise<void> {
    if (job.status !== 'submitted') throw new PhotoError('not_ready_to_sign');
    if (!(await currentEstimateRow(tx, caller.companyId, job))) throw new PhotoError('not_ready_to_sign');
  }

  return {
    async receive(caller, jobId, photoId, kind, input) {
      // 1. Access, and what the registry already holds for this id. No lock: nothing is changed yet.
      const seen = await withCompany(db, caller.companyId, async (tx) => {
        // A new photo adds to the field work: only its field owner adds one, whatever their role (an
        // original or a signature does not need it).
        const job = await jobAccess(tx, caller, jobId, sendNeeds(kind), { fieldWork: kind === 'photo' });
        const rows = await registryRows(tx, caller, jobId, photoId);
        const same = rows.find((row) => row.kind === kind);
        if (kind === 'signature' && !same) await requireSignable(tx, caller, job);
        return { job, same, photo: rows.find((row) => row.kind === 'photo') };
      });

      const bytes = await input.readBytes();
      if (bytes.byteLength === 0) throw new PhotoError('invalid_request');
      const contentType = sniffImageType(bytes);
      if (contentType === null) throw new PhotoError('unsupported_image');
      const sha256 = sha256Of(bytes);

      // 2. An original may arrive after signing, but only for a photo the job already holds, and
      // only when it names that photo's hash, on its first sending and every one after.
      if (kind === 'original') {
        if (!seen.photo || !input.photoSha256) throw new PhotoError('photo_missing');
        if (seen.photo.sha256 !== input.photoSha256) throw new PhotoError('photo_conflict');
      }

      // 3. Sent before: the same bytes are the same receipt (a lost response is settled by sending
      // again), other bytes under the same id are a conflict.
      if (seen.same) {
        if (seen.same.sha256 !== sha256) throw new PhotoError('photo_conflict');
        return { created: false, receipt: receiptOf(seen.same) };
      }

      // A new photo needs the draft still being edited.
      if (kind === 'photo') await requireEditing(caller, seen.job);

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
        const job = await jobAccess(tx, caller, jobId, sendNeeds(kind), { lock: true, fieldWork: kind === 'photo' });
        if (kind === 'photo' && job.status !== 'draft') throw new PhotoError('draft_locked');
        if (kind === 'signature') {
          const [there] = (await registryRows(tx, caller, jobId, photoId)).filter((row) => row.kind === kind);
          if (!there) await requireSignable(tx, caller, job);
        }
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
            action: RECEIVED[kind],
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
