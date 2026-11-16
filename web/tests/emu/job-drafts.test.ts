import { randomUUID } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseProjectionConfig } from '@/lib/config';
import { firestoreDraftStore, type DraftStore } from '@/lib/jobs/drafts';
import { firestoreAccessStore, firestoreFor } from '@/lib/projection/firestore';
import { createTenant, projectId, signIn, signUp, withSecondFactor } from './auth-emulator';
import { createDoc, deleteDoc, getDoc, listDocs, updateDoc } from './rules/firestore-rest';

// The first field draft a new job gets (S5a-3), written by the real firebase-admin writer against
// the Firestore emulator, then used the way the phone will: under web/firestore.rules, with real
// Auth emulator tokens. The route and the job rows are in tests/db/jobs-api.test.ts.

let db: Firestore;
let drafts: DraftStore;
let grants: ReturnType<typeof firestoreAccessStore>;

beforeAll(() => {
  const config = parseProjectionConfig({
    APP_ENV: 'local',
    GOOGLE_CLOUD_PROJECT: projectId,
    FIRESTORE_DATABASE_ID: '(default)',
    FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST,
  });
  db = firestoreFor(config);
  drafts = firestoreDraftStore(db);
  grants = firestoreAccessStore(db);
});

const DAY = 24 * 60 * 60 * 1000;

async function member(tenantId: string, company: string, role: 'owner' | 'estimator' | 'office'): Promise<{ uid: string; caller: { idToken: string } }> {
  const email = `${role}-${randomUUID().slice(0, 8)}@field.example.test`;
  const password = `synthetic-password-${role}`;
  const uid = await signUp(tenantId, email, password);
  await grants.grant({ companyId: company, authTenantId: tenantId, uid, role, expiresAt: new Date(Date.now() + DAY), version: 1 });
  // An owner or office user signs in with the authenticator app as the second step (D2).
  const idToken = await signIn(tenantId, email, password);
  return { uid, caller: { idToken: role === 'estimator' ? idToken : withSecondFactor(idToken) } };
}

const path = (company: string, draft: string) => `companies/${company}/drafts/${draft}`;

describe('the first draft of a job', () => {
  it('is made once, as an editing draft the field owner can use and nobody else can', async () => {
    const tenant = await createTenant('job-drafts-a');
    const company = randomUUID();
    const draft = randomUUID();
    const owner = await member(tenant, company, 'estimator');
    const other = await member(tenant, company, 'estimator');
    const office = await member(tenant, company, 'office');

    expect(await drafts.ensure(company, draft, owner.uid)).toBe('created');
    const stored = (await db.doc(path(company, draft)).get()).data();
    expect(stored).toEqual({ fieldOwnerUid: owner.uid, state: 'editing', field: {} });

    // The phone's first writes: job-level field data and a room, under the rules.
    expect(await updateDoc(owner.caller, path(company, draft), { field: { yearBuilt: 1990, notes: 'wet carpet' } })).toBe(200);
    expect(await createDoc(owner.caller, `${path(company, draft)}/rooms/kitchen`, { field: { name: 'Kitchen' } })).toBe(200);
    // Another estimator neither reads nor writes it; office reads it and writes nothing.
    expect(await getDoc(other.caller, path(company, draft))).toBe(403);
    expect(await updateDoc(other.caller, path(company, draft), { field: { notes: 'taken' } })).toBe(403);
    expect(await getDoc(office.caller, path(company, draft))).toBe(200);
    expect(await updateDoc(office.caller, path(company, draft), { field: { notes: 'taken' } })).toBe(403);
    // The server's own keys stay the server's.
    expect(await updateDoc(owner.caller, path(company, draft), { state: 'submitted' })).toBe(403);
    expect(await updateDoc(owner.caller, path(company, draft), { fieldOwnerUid: other.uid })).toBe(403);
  });

  it('is left as it is when the same create is sent again', async () => {
    const company = randomUUID();
    const draft = randomUUID();
    expect(await drafts.ensure(company, draft, 'uid-1')).toBe('created');
    await db.doc(path(company, draft)).update({ field: { notes: 'work done since' } });
    expect(await drafts.ensure(company, draft, 'uid-1')).toBe('exists');
    expect((await db.doc(path(company, draft)).get()).data()).toEqual({ fieldOwnerUid: 'uid-1', state: 'editing', field: { notes: 'work done since' } });
  });

  it('has no field owner while nobody owns the field work, and then nobody can edit it', async () => {
    const tenant = await createTenant('job-drafts-b');
    const company = randomUUID();
    const draft = randomUUID();
    const estimator = await member(tenant, company, 'estimator');
    const owner = await member(tenant, company, 'owner');
    expect(await drafts.ensure(company, draft, null)).toBe('created');
    expect((await db.doc(path(company, draft)).get()).data()).toEqual({ state: 'editing', field: {} });
    for (const who of [estimator, owner]) {
      expect(await updateDoc(who.caller, path(company, draft), { field: { notes: 'x' } })).toBe(403);
    }
  });

  it('is made only in the company it was asked for', async () => {
    const company = randomUUID();
    const other = randomUUID();
    const draft = randomUUID();
    await drafts.ensure(company, draft, 'uid-1');
    expect((await db.doc(path(other, draft)).get()).exists).toBe(false);
  });
});

describe('the server-owned job to current draft projection', () => {
  it('is readable only with access to the projected draft and cannot be written by a client', async () => {
    const tenant = await createTenant('job-map');
    const company = randomUUID();
    const draft = randomUUID();
    const job = randomUUID();
    const owner = await member(tenant, company, 'estimator');
    const other = await member(tenant, company, 'estimator');
    const office = await member(tenant, company, 'office');
    await drafts.ensure(company, draft, owner.uid);
    await drafts.projectJob(company, job, { currentDraftId: draft, revision: 1 });
    const at = `companies/${company}/jobs/${job}`;
    expect((await db.doc(at).get()).data()).toEqual({ currentDraftId: draft, revision: 1 });
    expect(await getDoc(owner.caller, at)).toBe(200);
    expect(await getDoc(office.caller, at)).toBe(200);
    expect(await getDoc(other.caller, at)).toBe(403);
    expect(await getDoc(null, at)).toBe(403);
    expect(await listDocs(owner.caller, `companies/${company}/jobs`)).toBe(403);
    expect(await listDocs(null, `companies/${company}/jobs`)).toBe(403);
    expect(await deleteDoc(owner.caller, at)).toBe(403);
    expect(await updateDoc(owner.caller, at, { currentDraftId: randomUUID(), revision: 2 })).toBe(403);
    expect(await createDoc(owner.caller, `companies/${company}/jobs/${randomUUID()}`, { currentDraftId: draft, revision: 1 })).toBe(403);
    const foreign = randomUUID();
    await drafts.projectJob(foreign, job, { currentDraftId: draft, revision: 1 });
    expect(await getDoc(owner.caller, `companies/${foreign}/jobs/${job}`)).toBe(403);
    // Ownership follows the current draft, not a grant embedded in the locator.
    await db.doc(path(company, draft)).update({ fieldOwnerUid: other.uid });
    expect(await getDoc(owner.caller, at)).toBe(403);
    expect(await getDoc(other.caller, at)).toBe(200);
    await db.doc(`companies/${company}/access/${other.uid}`).update({ expiresAt: new Date(Date.now() - 1000) });
    expect(await getDoc(other.caller, at)).toBe(403);
  });

  it('a delayed older write cannot replace the current draft, and an identical retry does not rewrite it', async () => {
    const company = randomUUID();
    const job = randomUUID();
    const before = { currentDraftId: randomUUID(), revision: 1 };
    const current = { currentDraftId: randomUUID(), revision: 3 };
    await drafts.projectJob(company, job, current);
    const doc = db.doc(`companies/${company}/jobs/${job}`);
    const written = (await doc.get()).updateTime!.toMillis();
    await drafts.projectJob(company, job, before);
    await drafts.projectJob(company, job, current);
    expect((await doc.get()).data()).toEqual(current);
    expect((await doc.get()).updateTime!.toMillis()).toBe(written);
  });
});
