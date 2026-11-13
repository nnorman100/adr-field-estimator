import type { Firestore } from 'firebase-admin/firestore';
import { firestoreSpan } from '@/lib/telemetry/spans';

// The state of a job's field draft (docs/data-ownership.md): `editing`, `submitting` (fenced by a
// submission) or `submitted`. The server only reads it here; a seam so the route tests run without
// Firestore (tests/emu/photo-draft-state.test.ts checks the real reader).
export type DraftStates = {
  // The draft's `state`, or null when there is no such draft.
  state(companyId: string, draftId: string): Promise<string | null>;
};

export function firestoreDraftStates(db: Firestore): DraftStates {
  return {
    async state(companyId, draftId) {
      const draft = await firestoreSpan('get', 'drafts', () =>
        db.collection('companies').doc(companyId).collection('drafts').doc(draftId).get(),
      );
      if (!draft.exists) return null;
      const state: unknown = draft.get('state');
      // A draft with no readable state is not one to add photos to.
      return typeof state === 'string' ? state : '';
    },
  };
}
