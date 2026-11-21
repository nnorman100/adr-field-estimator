import { draftOfOtherJob } from '@/lib/jobs/drafts';
import type { SummaryDraftBoundary, SummaryDraftReader } from '@/lib/summary-draft/service';
import type { FakeField } from '../submissions/field-fake';

// The summary draft route's two seams for the database tests (S7-6): the field stand-in's drafts,
// read only, as src/lib/summary-draft/draft-reader.ts reads Firestore; and a boundary that fails the
// test if a model call is ever made (the isolation suite refuses every call before the AI).

export function fieldSummaryReader(field: FakeField): SummaryDraftReader {
  return {
    async read(companyId, jobId, draftId) {
      const draft = field.draft(companyId, draftId);
      if (!draft || draftOfOtherJob(draft.jobId, jobId)) return null;
      return {
        state: draft.state,
        manifest: {
          draft: draft.field ?? {},
          rooms: Object.entries(draft.rooms).map(([id, value]) => ({ id, field: value ?? {} })),
          photos: Object.entries(draft.photos).map(([id, value]) => ({ id, field: value ?? {} })),
        },
      };
    },
  };
}

export const refusingBoundary = (): SummaryDraftBoundary => ({
  call: () => {
    throw new Error('the AI boundary was called');
  },
});
