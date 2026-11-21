import type { FieldManifest } from '@/lib/field/canonical';
import type { Placeholder } from '@/lib/jobs/drafts';
import type { Fence, Provenance } from '@/lib/submissions/fence';

// The draft writers earlier versions of the app had before the draft life-cycle redesign put every
// draft write on the draft sync (src/lib/jobs/draft-sync.ts). The app no longer has them. The stand-ins
// (field-fake.ts, tests/db/draft-fake.ts) keep them so a test can leave the field database as an earlier
// version left it (a placeholder, a stray fence, an owner or archive revision ahead of Postgres) and
// show what the draft sync and the routes do with that data. They are not a contract of the app.

// What a previous-version creation answered: `archived` when only an archived job's placeholder was there.
export type DraftMade = 'created' | 'exists' | 'taken' | 'archived';

export type FieldOwnerResult = 'set' | 'same' | 'newer' | 'missing' | 'taken' | 'archived';

export type ArchiveResult = 'set' | 'same' | 'newer';

export type FenceResult = { outcome: 'fenced' } | { outcome: 'missing' } | { outcome: 'held'; epoch: string } | { outcome: 'submitted' };

/** The previous-version writers of a job's first draft and its field owner (src/lib/jobs/drafts.ts before slice 7). */
export type PreviousDraftWriters = {
  ensure(companyId: string, jobId: string, draftId: string, fieldOwnerUid: string | null): Promise<DraftMade>;
  setFieldOwner(companyId: string, jobId: string, draftId: string, fieldOwnerUid: string, revision: number): Promise<FieldOwnerResult>;
};

/** The previous-version Submit, archive, restore and copy writers (fence.ts and archive-store.ts before slice 7). */
export type PreviousFieldWriters = {
  fence(companyId: string, draftId: string, fence: Fence, replacing?: string): Promise<FenceResult>;
  markSubmitted(companyId: string, draftId: string, epoch: string, submissionId: string): Promise<'marked' | 'missing' | 'conflict'>;
  release(companyId: string, draftId: string, epoch: string): Promise<'released' | 'not_fenced'>;
  createFrom(companyId: string, jobId: string, draftId: string, fieldOwnerUid: string | null, manifest: FieldManifest, previous: Provenance): Promise<DraftMade>;
  archiveDraft(companyId: string, jobId: string, draftId: string, revision: number): Promise<ArchiveResult>;
  restoreDraft(companyId: string, jobId: string, draftId: string, state: 'editing' | 'submitted', revision: number): Promise<ArchiveResult>;
  createCopy(companyId: string, jobId: string, draftId: string, fieldOwnerUid: string | null, manifest: Pick<FieldManifest, 'draft' | 'rooms'>): Promise<DraftMade>;
};

// Whether a previous-version creation replaced a placeholder: only a restored one (`absent`) of this very
// job that held its revision.
export function placeholderRefusal(left: Placeholder, jobId: string): 'taken' | 'archived' | null {
  if (left.jobId !== jobId) return 'taken';
  if (left.state === 'archived') return 'archived';
  return left.state === 'absent' && left.archiveRevision !== null ? null : 'taken';
}
