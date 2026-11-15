import type { Firestore } from 'firebase-admin/firestore';
import { MAX_PHOTO_REFS } from '@/lib/field/schema';
import { firestoreSpan } from '@/lib/telemetry/spans';

// The state of a job's field draft (docs/data-ownership.md): `editing`, `submitting` (fenced by a
// submission) or `submitted`. The server only reads it here; a seam so the route tests run without
// Firestore (tests/emu/photo-draft-state.test.ts checks the real reader).
export type DraftStates = {
  // The draft's `state`, or null when there is no such draft.
  state(companyId: string, draftId: string): Promise<string | null>;
  // How many photo references the draft holds, counted up to MAX_PHOTO_REFS (no further).
  photoRefs(companyId: string, draftId: string): Promise<number>;
};

export function firestoreDraftStates(db: Firestore): DraftStates {
  const draftRef = (companyId: string, draftId: string) => db.collection('companies').doc(companyId).collection('drafts').doc(draftId);
  return {
    async state(companyId, draftId) {
      const draft = await firestoreSpan('get', 'drafts', () => draftRef(companyId, draftId).get());
      if (!draft.exists) return null;
      const state: unknown = draft.get('state');
      // A draft with no readable state is not one to add photos to.
      return typeof state === 'string' ? state : '';
    },
    async photoRefs(companyId, draftId) {
      const counted = await firestoreSpan('count', 'photos', () =>
        draftRef(companyId, draftId).collection('photos').limit(MAX_PHOTO_REFS).count().get(),
      );
      return counted.data().count;
    },
  };
}
