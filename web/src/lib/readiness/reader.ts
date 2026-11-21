import type { Firestore } from 'firebase-admin/firestore';
import type { FieldDoc, FieldManifest } from '@/lib/field/canonical';
import { MAX_PHOTO_REFS, MAX_ROOMS } from '@/lib/field/schema';
import { draftOfOtherJob, placeholderOf } from '@/lib/jobs/drafts';
import { firestoreSpan } from '@/lib/telemetry/spans';

// The readiness check's read of a job's current field draft (S5b-11; plan amendment 4): a new
// read-only reader modelled on the Submit fence's read (src/lib/submissions/fence.ts, `read`), which
// cannot be reused because it answers only for a fenced draft. One read-only Firestore transaction
// reads the draft, its rooms and its photo references together, so the rooms and photos are those of
// the draft state that was read. It writes nothing.
//
// The server SDK is not bound by the field rules, so this read checks the binding itself: the caller's
// access to the job and the draft id come from Postgres (src/lib/readiness/service.ts), and the draft
// read must be that job's (`jobId`, security audit F1) and open for editing. A draft made before
// `jobId` names no job; the service then checks in Postgres that the draft id is this job's.
//
// A seam, so the route tests run without Firestore; tests/emu/readiness-reader.test.ts checks this
// reader against the emulator.

export type ReadinessRead =
  // The editing draft; `stamped` is false for a draft made before drafts carried their job id.
  | { outcome: 'read'; stamped: boolean; manifest: FieldManifest }
  // No draft under the id, or only the record an archive or restore left there (src/lib/jobs/drafts.ts).
  | { outcome: 'missing' }
  // The draft names another job.
  | { outcome: 'other_job' }
  // The draft is fenced, submitted or archived.
  | { outcome: 'not_editing' }
  // Its rooms or photo references exceed the safety caps (one above each cap is read, never more).
  | { outcome: 'too_many' };

export type ReadinessReader = {
  readEditing(companyId: string, jobId: string, draftId: string): Promise<ReadinessRead>;
};

const docs = (snapshot: { docs: { id: string; get(field: string): unknown }[] }): FieldDoc[] =>
  snapshot.docs.map((doc) => ({ id: doc.id, field: doc.get('field') ?? {} }));

export function firestoreReadinessReader(db: Firestore): ReadinessReader {
  return {
    async readEditing(companyId, jobId, draftId) {
      const ref = db.collection('companies').doc(companyId).collection('drafts').doc(draftId);
      return firestoreSpan('runTransaction', 'drafts', () =>
        db.runTransaction(
          async (tx): Promise<ReadinessRead> => {
            const draft = await tx.get(ref);
            if (!draft.exists || placeholderOf(draft)) return { outcome: 'missing' };
            const stamped: unknown = draft.get('jobId');
            if (draftOfOtherJob(stamped, jobId)) return { outcome: 'other_job' };
            if (draft.get('state') !== 'editing') return { outcome: 'not_editing' };
            const rooms = await tx.get(ref.collection('rooms').limit(MAX_ROOMS + 1));
            if (rooms.size > MAX_ROOMS) return { outcome: 'too_many' };
            const photos = await tx.get(ref.collection('photos').limit(MAX_PHOTO_REFS + 1));
            if (photos.size > MAX_PHOTO_REFS) return { outcome: 'too_many' };
            return { outcome: 'read', stamped: stamped === jobId, manifest: { draft: draft.get('field') ?? {}, rooms: docs(rooms), photos: docs(photos) } };
          },
          { readOnly: true },
        ),
      );
    },
  };
}
