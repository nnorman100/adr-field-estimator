import { randomUUID } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseProjectionConfig } from '@/lib/config';
import { firestoreFor } from '@/lib/projection/firestore';
import { closeDrafts, draftsToClose, readDrafts } from '../../scripts/reconcile-restored-drafts';
import { projectId } from './auth-emulator';

// The owner-run close of field drafts a restored Postgres no longer gives the job they name
// (scripts/reconcile-restored-drafts.ts, docs/runbook/backups.md), against the emulator: what it reads,
// what it closes (archived, naming nobody, field work kept), and a draft written since it was read.

let db: Firestore;

beforeAll(() => {
  const config = parseProjectionConfig({
    APP_ENV: 'local',
    GOOGLE_CLOUD_PROJECT: projectId,
    FIRESTORE_DATABASE_ID: '(default)',
    FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST,
  });
  db = firestoreFor(config);
});

const path = (company: string, draft: string) => `companies/${company}/drafts/${draft}`;

describe('closing the drafts a restored Postgres does not give their job', () => {
  it('closes each unclaimed draft, keeps its field work, and leaves the claimed ones and other collections alone', async () => {
    const company = randomUUID();
    const [kept, unclaimed, moved, written] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const job = randomUUID();
    for (const draft of [kept, unclaimed, moved, written]) {
      await db.doc(path(company, draft)).set({ jobId: job, state: 'editing', fieldOwnerUid: 'estimator-1', field: { notes: 'wet carpet' } });
    }
    await db.doc(`${path(company, unclaimed)}/rooms/kitchen`).set({ field: { name: 'Kitchen' } });
    // Not a company's draft: never read.
    await db.doc(`elsewhere/${company}/drafts/${randomUUID()}`).set({ state: 'editing' });
    const claims = new Map([
      [`${company}/${kept}`, job],
      [`${company}/${moved}`, randomUUID()],
    ]);
    const drafts = (await readDrafts(db)).filter((draft) => draft.companyId === company);
    expect(drafts.map((draft) => draft.draftId).sort()).toEqual([kept, unclaimed, moved, written].sort());
    const closing = draftsToClose(drafts, claims).map((draft) => ({ ...draft, readAt: drafts.find((one) => one.draftId === draft.draftId)!.readAt }));
    expect(closing.map((draft) => draft.draftId).sort()).toEqual([unclaimed, moved, written].sort());
    // Written since it was read: left for the next run.
    await db.doc(path(company, written)).update({ field: { notes: 'typed meanwhile' } });
    expect(await closeDrafts(db, closing)).toEqual({ closed: 2, changed: 1 });
    for (const draft of [unclaimed, moved]) {
      expect((await db.doc(path(company, draft)).get()).data()).toEqual({ jobId: job, state: 'archived', field: { notes: 'wet carpet' } });
    }
    expect((await db.doc(`${path(company, unclaimed)}/rooms/kitchen`).get()).data()).toEqual({ field: { name: 'Kitchen' } });
    expect((await db.doc(path(company, kept)).get()).data()).toMatchObject({ state: 'editing', fieldOwnerUid: 'estimator-1' });
    expect((await db.doc(path(company, written)).get()).data()).toMatchObject({ state: 'editing', fieldOwnerUid: 'estimator-1' });
    // The next run reads it again and closes it.
    const again = (await readDrafts(db)).filter((draft) => draft.companyId === company);
    const next = draftsToClose(again, claims).map((draft) => ({ ...draft, readAt: again.find((one) => one.draftId === draft.draftId)!.readAt }));
    expect(next.map((draft) => draft.draftId)).toEqual([written]);
    expect(await closeDrafts(db, next)).toEqual({ closed: 1, changed: 0 });
  });
});
