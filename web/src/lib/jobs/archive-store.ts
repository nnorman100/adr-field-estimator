import type { Firestore } from 'firebase-admin/firestore';
import type { FieldManifest } from '@/lib/field/canonical';
import { firestoreSpan } from '@/lib/telemetry/spans';
import { draftOfOtherJob, firestoreDraftLookup, placeholderOf, startDraft, type DraftLookup, type DraftMade } from './drafts';
import { firestoreJobProjectionStore, type JobProjectionStore } from './projection';

// The field database side of archive, restore and copy (S5b-2). Postgres decides; these follow it.
//
// Archive puts the job's current draft in the state `archived`, which the field rules refuse every
// client write to (web/firestore.rules: a client writes only while `state` is `editing`). Restore
// puts it back as Postgres says: `editing` for a draft job, `submitted` for a submitted one.
// `archiveRevision` on the draft is the job revision at which the server last archived or restored
// it, so a slower request carrying an older revision never undoes a newer one; a client cannot
// change it (the rules let a client change only `field`).
//
// The fence holds where the draft is missing too. An archive or restore that finds no draft leaves a
// placeholder under the draft id (`placeholder: true`, the job id, the revision and `state`: `archived`
// after an archive, `absent` after a restore; no field work and no field owner), so the latest revision
// is kept where there is no draft to keep it on. A stale archive or restore then changes nothing there
// either. Nothing is made over an archived placeholder and nobody is named on it (createFrom, ensure,
// createCopy answer `archived`; setFieldOwner answers `missing`), and a draft made over a restored one
// takes its revision. Every step is one Firestore transaction on the draft id, so an archive, a
// restore, a draft being made and an owner being named never overtake one another.
//
// A seam, so the route tests run without Firestore; tests/emu/archive.test.ts checks this writer
// against the emulator and the field rules.

export type ArchiveResult =
  // Changed now.
  | 'set'
  // Already done at this revision (a retry), or a newer archive or restore is on the draft: nothing
  // is changed.
  | 'same'
  | 'newer';

export type ArchiveStore = JobProjectionStore & DraftLookup & {
  // In one Firestore transaction: the draft becomes `archived` at this job revision, or, when there is
  // no draft, the job's placeholder is left in its place, archived. A draft a Submit has fenced keeps
  // its state and only takes the revision: this archive was decided before that Submit began (an
  // archive waits for a Submit in flight), and the Submit's marker or release follows.
  archiveDraft(companyId: string, jobId: string, draftId: string, revision: number): Promise<ArchiveResult>;
  // In one Firestore transaction: an `archived` draft becomes `state` at this job revision. A draft
  // in any other state keeps it (its archive never reached the field database) and only takes the
  // revision, so that archive cannot land after this restore. When there is no draft, the job's
  // placeholder is left in its place, no longer archived, so that archive cannot land either.
  restoreDraft(companyId: string, jobId: string, draftId: string, state: 'editing' | 'submitted', revision: number): Promise<ArchiveResult>;
  // A copy's first draft: an `editing` draft of the copy (`jobId`, as src/lib/jobs/drafts.ts)
  // holding the given field map and rooms, made whole or not at all; `exists` when the draft is
  // already there for this job (a retry), and nothing is changed then, except that a draft made
  // before `jobId` takes it (the caller holds the draft id for this job in Postgres first); `taken`
  // when the draft there was made for another job, and nothing is changed either; `archived` when only
  // an archived job's placeholder is there (a restored job's gives way to the draft, with its revision).
  createCopy(
    companyId: string,
    jobId: string,
    draftId: string,
    fieldOwnerUid: string | null,
    manifest: Pick<FieldManifest, 'draft' | 'rooms'>,
  ): Promise<DraftMade>;
};

function storedRevision(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

export function firestoreArchiveStore(db: Firestore): ArchiveStore {
  const draftRef = (companyId: string, draftId: string) => db.collection('companies').doc(companyId).collection('drafts').doc(draftId);

  // `placeholder` is the state an absent draft's placeholder is left in; `draftChange` is the change to a
  // draft there, from its state.
  async function step(
    companyId: string,
    jobId: string,
    draftId: string,
    revision: number,
    placeholder: 'archived' | 'absent',
    draftChange: (state: unknown) => Record<string, unknown>,
  ): Promise<ArchiveResult> {
    const ref = draftRef(companyId, draftId);
    return firestoreSpan('runTransaction', 'drafts', () =>
      db.runTransaction(async (tx): Promise<ArchiveResult> => {
        const found = await tx.get(ref);
        if (!found.exists) {
          tx.create(ref, { jobId, state: placeholder, placeholder: true, archiveRevision: revision });
          return 'set';
        }
        const stored = storedRevision(found.get('archiveRevision'));
        if (stored > revision) return 'newer';
        if (stored === revision) return 'same';
        const change = placeholderOf(found) ? { state: placeholder } : draftChange(found.get('state'));
        tx.update(ref, { ...change, archiveRevision: revision });
        return 'set';
      }),
    );
  }

  return {
    ...firestoreJobProjectionStore(db),
    ...firestoreDraftLookup(db),
    archiveDraft: (companyId, jobId, draftId, revision) =>
      step(companyId, jobId, draftId, revision, 'archived', (current) => (current === 'submitting' ? {} : { state: 'archived' })),
    restoreDraft: (companyId, jobId, draftId, state, revision) =>
      step(companyId, jobId, draftId, revision, 'absent', (current) => (current === 'archived' ? { state } : {})),

    async createCopy(companyId, jobId, draftId, fieldOwnerUid, manifest) {
      const ref = draftRef(companyId, draftId);
      return firestoreSpan('runTransaction', 'drafts', () =>
        db.runTransaction(async (tx): Promise<DraftMade> => {
          const found = await tx.get(ref);
          const left = placeholderOf(found);
          if (left) {
            if (draftOfOtherJob(left.jobId, jobId)) return 'taken';
            if (left.archived) return 'archived';
          } else if (found.exists) {
            const stamped = found.get('jobId');
            if (draftOfOtherJob(stamped, jobId)) return 'taken';
            // A draft made before `jobId` takes it: the caller holds the draft id for this job in Postgres.
            if (stamped === undefined) tx.update(ref, { jobId });
            return 'exists';
          }
          startDraft(tx, ref, left, {
            jobId,
            ...(fieldOwnerUid === null ? {} : { fieldOwnerUid }),
            state: 'editing',
            field: manifest.draft ?? {},
          });
          for (const room of manifest.rooms) tx.create(ref.collection('rooms').doc(room.id), { field: room.field ?? {} });
          return 'created';
        }),
      );
    },
  };
}
