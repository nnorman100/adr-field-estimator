import type { Firestore } from 'firebase-admin/firestore';
import type { FieldManifest } from '@/lib/field/canonical';
import { firestoreSpan } from '@/lib/telemetry/spans';
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
// A seam, so the route tests run without Firestore; tests/emu/archive.test.ts checks this writer
// against the emulator and the field rules.

export type ArchiveResult =
  // Changed now.
  | 'set'
  // Already done at this revision (a retry), or a newer archive or restore is on the draft: nothing
  // is changed.
  | 'same'
  | 'newer'
  // No such draft (its job's create never reached the field database): nothing to change. A draft is
  // made only under its job's lock while the job is not archived (lockedJob), so none is made open
  // to the phone after its job's archive.
  | 'missing';

export type ArchiveStore = JobProjectionStore & {
  // In one Firestore transaction: the draft becomes `archived` at this job revision.
  archiveDraft(companyId: string, draftId: string, revision: number): Promise<ArchiveResult>;
  // In one Firestore transaction: an `archived` draft becomes `state` at this job revision. A draft
  // in any other state keeps it (its archive never reached the field database) and only takes the
  // revision, so that archive cannot land after this restore.
  restoreDraft(companyId: string, draftId: string, state: 'editing' | 'submitted', revision: number): Promise<ArchiveResult>;
  // A copy's first draft: an `editing` draft holding the given field map and rooms, made whole or
  // not at all; `exists` when the draft is already there (a retry), and nothing is changed then.
  createCopy(companyId: string, draftId: string, fieldOwnerUid: string | null, manifest: Pick<FieldManifest, 'draft' | 'rooms'>): Promise<'created' | 'exists'>;
};

function storedRevision(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

export function firestoreArchiveStore(db: Firestore): ArchiveStore {
  const draftRef = (companyId: string, draftId: string) => db.collection('companies').doc(companyId).collection('drafts').doc(draftId);

  async function step(companyId: string, draftId: string, revision: number, next: (state: unknown) => Record<string, unknown>): Promise<ArchiveResult> {
    const ref = draftRef(companyId, draftId);
    return firestoreSpan('runTransaction', 'drafts', () =>
      db.runTransaction(async (tx): Promise<ArchiveResult> => {
        const found = await tx.get(ref);
        if (!found.exists) return 'missing';
        const stored = storedRevision(found.get('archiveRevision'));
        if (stored > revision) return 'newer';
        if (stored === revision) return 'same';
        tx.update(ref, { ...next(found.get('state')), archiveRevision: revision });
        return 'set';
      }),
    );
  }

  return {
    ...firestoreJobProjectionStore(db),
    archiveDraft: (companyId, draftId, revision) => step(companyId, draftId, revision, () => ({ state: 'archived' })),
    restoreDraft: (companyId, draftId, state, revision) =>
      step(companyId, draftId, revision, (current) => (current === 'archived' ? { state } : {})),

    async createCopy(companyId, draftId, fieldOwnerUid, manifest) {
      const ref = draftRef(companyId, draftId);
      return firestoreSpan('runTransaction', 'drafts', () =>
        db.runTransaction(async (tx): Promise<'created' | 'exists'> => {
          if ((await tx.get(ref)).exists) return 'exists';
          tx.create(ref, {
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
