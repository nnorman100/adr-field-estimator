import type { Firestore } from 'firebase-admin/firestore';
import type { FieldManifest } from '@/lib/field/canonical';
import { firestoreSpan } from '@/lib/telemetry/spans';
import { draftOfOtherJob, firestoreDraftLookup, type DraftLookup } from './drafts';
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
// The fence holds where the draft is missing too. Archive then leaves a placeholder under the draft id
// (`placeholder: true`, `archived`, the job id and the revision, no field work and no field owner), so
// a draft made later without the job's lock (office.ts remakeCurrentDraft) finds it there and makes
// nothing over it (createFrom, src/lib/submissions/fence.ts), and nobody is named on it
// (setFieldOwner, drafts.ts). Restore takes the placeholder away, so the draft is missing again as it
// was before the archive. Every step is one Firestore transaction on the draft id, so an archive and a
// draft being made never both win.
//
// A seam, so the route tests run without Firestore; tests/emu/archive.test.ts checks this writer
// against the emulator and the field rules.

export type ArchiveResult =
  // Changed now.
  | 'set'
  // Already done at this revision (a retry), or a newer archive or restore is on the draft: nothing
  // is changed.
  | 'same'
  | 'newer'
  // No such draft (its job's create never reached the field database) for a restore: nothing to
  // change. An archive never answers it: it leaves its placeholder there instead.
  | 'missing';

export type ArchiveStore = JobProjectionStore & DraftLookup & {
  // In one Firestore transaction: the draft becomes `archived` at this job revision, or, when there is
  // no draft, the job's placeholder is left in its place.
  archiveDraft(companyId: string, jobId: string, draftId: string, revision: number): Promise<ArchiveResult>;
  // In one Firestore transaction: an `archived` draft becomes `state` at this job revision. A draft
  // in any other state keeps it (its archive never reached the field database) and only takes the
  // revision, so that archive cannot land after this restore. A placeholder is taken away.
  restoreDraft(companyId: string, draftId: string, state: 'editing' | 'submitted', revision: number): Promise<ArchiveResult>;
  // A copy's first draft: an `editing` draft of the copy (`jobId`, as src/lib/jobs/drafts.ts)
  // holding the given field map and rooms, made whole or not at all; `exists` when the draft is
  // already there for this job (a retry), and nothing is changed then, except that a draft made
  // before `jobId` takes it (the caller holds the draft id for this job in Postgres first); `taken`
  // when the draft there was made for another job, and nothing is changed either.
  createCopy(
    companyId: string,
    jobId: string,
    draftId: string,
    fieldOwnerUid: string | null,
    manifest: Pick<FieldManifest, 'draft' | 'rooms'>,
  ): Promise<'created' | 'exists' | 'taken'>;
};

function storedRevision(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

export function firestoreArchiveStore(db: Firestore): ArchiveStore {
  const draftRef = (companyId: string, draftId: string) => db.collection('companies').doc(companyId).collection('drafts').doc(draftId);

  // `missing` is what an absent draft gets (null: nothing); `next` is the change to a draft there, from
  // its state and whether it is a placeholder, or null to take the placeholder away.
  async function step(
    companyId: string,
    draftId: string,
    revision: number,
    missing: Record<string, unknown> | null,
    next: (state: unknown, placeholder: boolean) => Record<string, unknown> | null,
  ): Promise<ArchiveResult> {
    const ref = draftRef(companyId, draftId);
    return firestoreSpan('runTransaction', 'drafts', () =>
      db.runTransaction(async (tx): Promise<ArchiveResult> => {
        const found = await tx.get(ref);
        if (!found.exists) {
          if (!missing) return 'missing';
          tx.create(ref, { ...missing, archiveRevision: revision });
          return 'set';
        }
        const stored = storedRevision(found.get('archiveRevision'));
        if (stored > revision) return 'newer';
        if (stored === revision) return 'same';
        const change = next(found.get('state'), found.get('placeholder') === true);
        if (change) tx.update(ref, { ...change, archiveRevision: revision });
        else tx.delete(ref);
        return 'set';
      }),
    );
  }

  return {
    ...firestoreJobProjectionStore(db),
    ...firestoreDraftLookup(db),
    archiveDraft: (companyId, jobId, draftId, revision) =>
      step(companyId, draftId, revision, { jobId, state: 'archived', placeholder: true }, () => ({ state: 'archived' })),
    restoreDraft: (companyId, draftId, state, revision) =>
      step(companyId, draftId, revision, null, (current, placeholder) => {
        if (placeholder) return null;
        return current === 'archived' ? { state } : {};
      }),

    async createCopy(companyId, jobId, draftId, fieldOwnerUid, manifest) {
      const ref = draftRef(companyId, draftId);
      return firestoreSpan('runTransaction', 'drafts', () =>
        db.runTransaction(async (tx): Promise<'created' | 'exists' | 'taken'> => {
          const found = await tx.get(ref);
          if (found.exists) {
            const stamped = found.get('jobId');
            if (draftOfOtherJob(stamped, jobId)) return 'taken';
            // A draft made before `jobId` takes it: the caller holds the draft id for this job in Postgres.
            if (stamped === undefined) tx.update(ref, { jobId });
            return 'exists';
          }
          tx.create(ref, {
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
