import type { Firestore } from 'firebase-admin/firestore';
import type { FieldDoc } from '@/lib/field/canonical';
import { draftOfOtherJob } from '@/lib/jobs/drafts';
import { MAX_PHOTO_REFS, MAX_ROOMS } from '@/lib/field/schema';
import { firestoreSpan } from '@/lib/telemetry/spans';
import type { SummaryDraftReader } from './service';

// The summary draft's read of a field draft (docs/plans/S7.md, step S7-6): the draft's state, field
// map, rooms and photo references in one read-only transaction, as Submit reads a fenced draft
// (src/lib/submissions/fence.ts) but without a fence: the draft is still being edited. Read only:
// the route never writes the draft.

const docs = (snapshot: { docs: { id: string; get(field: string): unknown }[] }): FieldDoc[] =>
  snapshot.docs.map((doc) => ({ id: doc.id, field: doc.get('field') ?? {} }));

export function firestoreSummaryDraftReader(db: Firestore): SummaryDraftReader {
  return {
    async read(companyId, jobId, draftId) {
      const ref = db.collection('companies').doc(companyId).collection('drafts').doc(draftId);
      return firestoreSpan('runTransaction', 'drafts', () =>
        db.runTransaction(
          async (tx) => {
            const draft = await tx.get(ref);
            if (!draft.exists) return null;
            const data = draft.data();
            // A draft stamped for another job is never read; one made before the stamp names none.
            if (draftOfOtherJob(data?.jobId, jobId)) return null;
            // One above each cap detects overflow without reading an attacker-sized collection.
            const rooms = await tx.get(ref.collection('rooms').limit(MAX_ROOMS + 1));
            if (rooms.size > MAX_ROOMS) return 'too_many_rooms' as const;
            const photos = await tx.get(ref.collection('photos').limit(MAX_PHOTO_REFS + 1));
            if (photos.size > MAX_PHOTO_REFS) return 'too_many_photos' as const;
            const state = data?.state;
            return {
              state: typeof state === 'string' ? state : '',
              manifest: { draft: data?.field ?? {}, rooms: docs(rooms), photos: docs(photos) },
            };
          },
          { readOnly: true },
        ),
      );
    },
  };
}
