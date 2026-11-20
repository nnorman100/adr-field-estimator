import type { ReadinessRead, ReadinessReader } from '@/lib/readiness/reader';
import type { FakeField } from '../submissions/field-fake';

// The field database's read for the check, over the stand-in's drafts, with the outcomes of the real
// reader (src/lib/readiness/reader.ts). `fail` makes the next read throw as an unreachable Firestore;
// `during` runs while a read is under way, so a test can change the job between the two Postgres reads.
export function standIn(field: FakeField) {
  const reader = {
    reads: 0,
    fail: false,
    during: null as null | (() => Promise<void>),
    async readEditing(companyId: string, jobId: string, draftId: string): Promise<ReadinessRead> {
      reader.reads += 1;
      if (reader.fail) {
        reader.fail = false;
        throw new Error('field database unreachable');
      }
      const draft = field.draft(companyId, draftId);
      if (reader.during) {
        const run = reader.during;
        reader.during = null;
        await run();
      }
      if (!draft || draft.placeholder) return { outcome: 'missing' };
      if (draft.jobId !== undefined && draft.jobId !== jobId) return { outcome: 'other_job' };
      if (draft.state !== 'editing') return { outcome: 'not_editing' };
      const docs = (from: Record<string, unknown>) => Object.entries(from).map(([id, value]) => ({ id, field: value ?? {} }));
      return { outcome: 'read', stamped: draft.jobId === jobId, manifest: { draft: draft.field ?? {}, rooms: docs(draft.rooms), photos: docs(draft.photos) } };
    },
  } satisfies ReadinessReader & Record<string, unknown>;
  return reader;
}
