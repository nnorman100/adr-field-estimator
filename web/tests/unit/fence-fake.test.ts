import { canonicalManifest } from '@/lib/field/canonical';
import { fenceStoreContract } from '../submissions/fence-contract';
import { fakeField } from '../submissions/field-fake';

// The database tests' stand-in for the field database (tests/submissions/field-fake.ts) holds to
// the same contract as the real Firestore writer (tests/emu/submission-fence.test.ts).
fenceStoreContract('in-memory', () => {
  const store = fakeField();
  return {
    store,
    async seed(company, draft, manifest, fieldOwnerUid = null) {
      store.put(company, draft, JSON.parse(canonicalManifest(manifest)), fieldOwnerUid);
    },
    async peek(company, draft) {
      const found = store.draft(company, draft);
      if (!found) return null;
      return {
        state: found.state,
        fence: found.fence ? { submissionId: found.fence.submissionId, epoch: found.fence.epoch } : null,
        previous: found.previous,
        fieldOwnerUid: found.fieldOwnerUid,
        manifest: {
          draft: found.field,
          rooms: Object.entries(found.rooms).map(([id, field]) => ({ id, field })),
          photos: Object.entries(found.photos).map(([id, field]) => ({ id, field })),
        },
      };
    },
  };
});
