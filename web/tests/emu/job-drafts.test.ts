import { randomUUID } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseProjectionConfig } from '@/lib/config';
import { firestoreDraftStore, type DraftStore } from '@/lib/jobs/drafts';
import { firestoreAccessStore, firestoreFor } from '@/lib/projection/firestore';
import { createTenant, projectId, signIn, signUp, withSecondFactor } from './auth-emulator';
import { createDoc, deleteDoc, getDoc, listDocs, updateDoc } from './rules/firestore-rest';

// The first field draft a new job gets (S5a-3), as the draft sync makes it (the sync itself is checked
// against the emulator in draft-sync.test.ts), used the way the phone will: under web/firestore.rules,
// with real Auth emulator tokens; the server's draft lookup and job locator against the emulator. The
// route and the job rows are in tests/db/jobs-api.test.ts.

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

// A job's first draft as the draft sync makes it: the job id, the field owner (none while nobody owns
// the field work), `editing`, an empty field map and the revisions it was written at.
async function firstDraft(company: string, job: string, draft: string, fieldOwnerUid: string | null): Promise<void> {
  await db.doc(path(company, draft)).create({ jobId: job, ...(fieldOwnerUid === null ? {} : { fieldOwnerUid }), state: 'editing', field: {}, archiveRevision: 1, fieldOwnerRevision: 0 });
}

describe('the first draft of a job', () => {
  it('is an editing draft the field owner can use and nobody else can', async () => {
    const tenant = await createTenant('job-drafts-a');
    const company = randomUUID();
    const draft = randomUUID();
    const owner = await member(tenant, company, 'estimator');
    const other = await member(tenant, company, 'estimator');
    const office = await member(tenant, company, 'office');
    const job = randomUUID();

    await firstDraft(company, job, draft, owner.uid);

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


  it('has no field owner while nobody owns the field work, and then nobody can edit it', async () => {
    const tenant = await createTenant('job-drafts-b');
    const company = randomUUID();
    const draft = randomUUID();
    const estimator = await member(tenant, company, 'estimator');
    const owner = await member(tenant, company, 'owner');
    const job = randomUUID();
    await firstDraft(company, job, draft, null);
    for (const who of [estimator, owner]) {
      expect(await updateDoc(who.caller, path(company, draft), { field: { notes: 'x' } })).toBe(403);
    }
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
    await firstDraft(company, job, draft, owner.uid);
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

// The server's draft lookup (moved from archive.test.ts when the previous-version writers were removed).
describe('the draft lookup', () => {
  // A placeholder an earlier version's archive or restore left where a draft was missing is no draft:
  // the draft sync replaces it.
  it('reports a placeholder an earlier version left as a placeholder, and a draft as none', async () => {
    const company = randomUUID();
    const job = randomUUID();
    const draft = randomUUID();
    await db.doc(path(company, draft)).create({ jobId: job, state: 'absent', placeholder: true, archiveRevision: 6 });
    expect(await drafts.findDraft(company, draft)).toEqual({ jobId: job, placeholder: true });
    await db.doc(path(company, draft)).set({ jobId: job, fieldOwnerUid: 'uid-1', state: 'editing', field: {}, archiveRevision: 6, fieldOwnerRevision: 0 });
    expect(await drafts.findDraft(company, draft)).toEqual({ jobId: job });
    expect(await drafts.findDraft(company, randomUUID())).toBeNull();
  });

  // Slice 5 review round 3, R1: rooms or photos left under an id with no draft document take the id, so a
  // request's claim of it is refused before it commits.
  it('reports rooms or photos left under an id with no draft as leftovers, not as nothing', async () => {
    const company = randomUUID();
    for (const name of ['rooms', 'photos']) {
      const draft = randomUUID();
      await db.doc(`companies/${company}/drafts/${draft}/${name}/left-${name}`).set({ field: {} });
      expect(await drafts.findDraft(company, draft)).toEqual({ jobId: undefined, leftover: true });
    }
  });
});
