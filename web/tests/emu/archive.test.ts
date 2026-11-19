import { randomUUID } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseProjectionConfig } from '@/lib/config';
import { firestoreArchiveStore, type ArchiveStore } from '@/lib/jobs/archive-store';
import { firestoreDraftStore } from '@/lib/jobs/drafts';
import { firestoreAccessStore, firestoreFor } from '@/lib/projection/firestore';
import { firestoreFenceStore } from '@/lib/submissions/fence';
import { createTenant, projectId, signIn, signUp, withSecondFactor } from './auth-emulator';
import { commit, createDoc, deleteDoc, getDoc, updateDoc, type Caller } from './rules/firestore-rest';

// S5b-2: archive, restore and copy on the field database, by the real firebase-admin writer
// (src/lib/jobs/archive-store.ts) against the emulator, then used the way the phone would, under
// web/firestore.rules with real Auth emulator tokens. An archived draft refuses every client write;
// restore opens it again; a copy's draft is made whole once. Two companies in two sign-in tenants
// show that no one reaches the other's archived draft. The routes and the job rows are in
// tests/db/archive-api.test.ts.

let db: Firestore;
let store: ArchiveStore;
let grants: ReturnType<typeof firestoreAccessStore>;

beforeAll(() => {
  const config = parseProjectionConfig({
    APP_ENV: 'local',
    GOOGLE_CLOUD_PROJECT: projectId,
    FIRESTORE_DATABASE_ID: '(default)',
    FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST,
  });
  db = firestoreFor(config);
  store = firestoreArchiveStore(db);
  grants = firestoreAccessStore(db);
});

const DAY = 24 * 60 * 60 * 1000;
type Person = { uid: string; caller: Caller };

async function member(tenantId: string, company: string, role: 'owner' | 'estimator' | 'office'): Promise<Person> {
  const email = `${role}-${randomUUID().slice(0, 8)}@archive.example.test`;
  const password = `synthetic-password-${role}`;
  const uid = await signUp(tenantId, email, password);
  await grants.grant({ companyId: company, authTenantId: tenantId, uid, role, expiresAt: new Date(Date.now() + DAY), version: 1 });
  // An owner or office user signs in with the authenticator app as the second step (D2).
  const idToken = await signIn(tenantId, email, password);
  return { uid, caller: { idToken: role === 'estimator' ? idToken : withSecondFactor(idToken) } };
}

const path = (company: string, draft: string) => `companies/${company}/drafts/${draft}`;

// A company whose estimator owns a draft with a room and a photo reference, as the phone leaves it.
async function company(name: string) {
  const tenant = await createTenant(`${name}-${randomUUID().slice(0, 6)}`);
  const id = randomUUID();
  const job = randomUUID();
  const draft = randomUUID();
  const estimator = await member(tenant, id, 'estimator');
  const owner = await member(tenant, id, 'owner');
  const office = await member(tenant, id, 'office');
  expect(await firestoreDraftStore(db).ensure(id, job, draft, estimator.uid)).toBe('created');
  const at = path(id, draft);
  expect(await updateDoc(estimator.caller, at, { field: { notes: 'wet carpet', roomOrder: ['kitchen'] } })).toBe(200);
  expect(await createDoc(estimator.caller, `${at}/rooms/kitchen`, { field: { name: 'Kitchen' } })).toBe(200);
  expect(await createDoc(estimator.caller, `${at}/photos/p1`, { field: { roomId: 'kitchen' } })).toBe(200);
  return { id, job, draft, at, estimator, owner, office };
}

// Every client write the field rules could allow on a draft: the draft's field map, a room (made,
// changed, removed), a photo reference (made, changed), and a batch of them.
async function writes(caller: Caller, at: string): Promise<number[]> {
  return [
    await updateDoc(caller, at, { field: { notes: 'changed' } }),
    await createDoc(caller, `${at}/rooms/hall`, { field: { name: 'Hall' } }),
    await updateDoc(caller, `${at}/rooms/kitchen`, { field: { name: 'Galley' } }),
    await deleteDoc(caller, `${at}/rooms/kitchen`),
    await createDoc(caller, `${at}/photos/p2`, { field: { roomId: 'kitchen' } }),
    await updateDoc(caller, `${at}/photos/p1`, { field: { roomId: 'kitchen', shotTag: 'source' } }),
    await commit(caller, [{ path: at, data: { field: { notes: 'batched' } } }]),
  ];
}

describe('an archived draft', () => {
  it('refuses every client write, and restore opens it again', async () => {
    const a = await company('archive-a');
    expect(await store.archiveDraft(a.id, a.job, a.draft, 4)).toBe('set');
    expect((await db.doc(a.at).get()).data()).toMatchObject({ state: 'archived', archiveRevision: 4, field: { notes: 'wet carpet', roomOrder: ['kitchen'] } });
    for (const who of [a.estimator, a.owner, a.office]) expect(await writes(who.caller, a.at)).toEqual([403, 403, 403, 403, 403, 403, 403]);
    // Nor may a client put the state or the revision back.
    expect(await updateDoc(a.estimator.caller, a.at, { state: 'editing' })).toBe(403);
    expect(await updateDoc(a.estimator.caller, a.at, { archiveRevision: 9 })).toBe(403);
    expect((await db.doc(`${a.at}/rooms/kitchen`).get()).data()).toEqual({ field: { name: 'Kitchen' } });
    // What the company may read stays readable (the phone shows it as archived).
    expect(await getDoc(a.estimator.caller, a.at)).toBe(200);
    expect(await getDoc(a.owner.caller, a.at)).toBe(200);
    // Asked again at the same revision, nothing changes.
    expect(await store.archiveDraft(a.id, a.job, a.draft, 4)).toBe('same');

    expect(await store.restoreDraft(a.id, a.job, a.draft, 'editing', 5)).toBe('set');
    expect((await db.doc(a.at).get()).data()).toMatchObject({ state: 'editing', archiveRevision: 5 });
    expect(await updateDoc(a.estimator.caller, a.at, { field: { notes: 'back at work', roomOrder: ['kitchen'] } })).toBe(200);
    // The slower archive request that read the job before the restore changes nothing.
    expect(await store.archiveDraft(a.id, a.job, a.draft, 4)).toBe('newer');
    expect((await db.doc(a.at).get()).get('state')).toBe('editing');
  });

  it('is restored as submitted when its job was, and a restore leaves a draft that is not archived as it is', async () => {
    const company = randomUUID();
    const job = randomUUID();
    const submitted = randomUUID();
    const fence = { submissionId: randomUUID(), epoch: 'epoch-1' };
    await db.doc(path(company, submitted)).create({ fieldOwnerUid: 'uid-1', state: 'submitted', fence, field: { notes: 'as submitted' } });
    expect(await store.archiveDraft(company, job, submitted, 3)).toBe('set');
    expect(await store.restoreDraft(company, job, submitted, 'submitted', 4)).toBe('set');
    expect((await db.doc(path(company, submitted)).get()).data()).toEqual({
      fieldOwnerUid: 'uid-1',
      state: 'submitted',
      fence,
      field: { notes: 'as submitted' },
      archiveRevision: 4,
    });
    // An archive that never reached the draft: the restore takes only the revision, so a Submit's
    // fence on it now is untouched and that archive can no longer land.
    const fenced = randomUUID();
    await db.doc(path(company, fenced)).create({ fieldOwnerUid: 'uid-1', state: 'submitting', fence, field: {} });
    expect(await store.restoreDraft(company, job, fenced, 'editing', 6)).toBe('set');
    expect((await db.doc(path(company, fenced)).get()).data()).toMatchObject({ state: 'submitting', fence, archiveRevision: 6 });
    expect(await store.archiveDraft(company, job, fenced, 5)).toBe('newer');
    // A draft that is not there: the archive leaves its placeholder (below).
    const missing = randomUUID();
    expect(await store.archiveDraft(company, job, missing, 2)).toBe('set');
    expect((await db.doc(path(company, missing)).get()).data()).toEqual({ jobId: job, state: 'archived', placeholder: true, archiveRevision: 2 });
  });

  it('is never reached by the other company, archived or restored', async () => {
    const a = await company('archive-iso-a');
    const b = await company('archive-iso-b');
    expect(await store.archiveDraft(a.id, a.job, a.draft, 2)).toBe('set');
    for (const [attacker, victim] of [
      [b, a],
      [a, b],
    ] as const) {
      for (const who of [attacker.estimator, attacker.owner, attacker.office]) {
        expect(await getDoc(who.caller, victim.at)).toBe(403);
        expect(await getDoc(who.caller, `${victim.at}/rooms/kitchen`)).toBe(403);
        expect(await writes(who.caller, victim.at)).toEqual([403, 403, 403, 403, 403, 403, 403]);
      }
    }
    // Company B's own draft, not archived, still takes its own estimator's writes: the refusals
    // above are the company boundary.
    expect(await updateDoc(b.estimator.caller, b.at, { field: { notes: 'still mine' } })).toBe(200);
  });
});

// The fence where the draft is missing: an archive or restore that finds no draft leaves a placeholder
// under its id that keeps the job revision, so a draft made later without the job's lock
// (src/lib/jobs/office.ts remakeCurrentDraft) is not made over an archived job's, nobody is named on
// it, and an older archive or restore never lands after a newer one.
describe('a missing draft of an archived job', () => {
  it('holds the archive’s placeholder, which nothing is made over and nobody is named on, until the restore', async () => {
    const a = await company('archive-missing');
    const draft = randomUUID();
    const at = path(a.id, draft);
    const manifest = { draft: { notes: 'from the record' }, rooms: [{ id: 'kitchen', field: { name: 'Kitchen' } }], photos: [] };
    const previous = { draftId: a.draft, submissionId: randomUUID() };
    const placeholder = { jobId: a.job, state: 'archived', placeholder: true, archiveRevision: 3 };
    expect(await store.archiveDraft(a.id, a.job, draft, 3)).toBe('set');
    expect((await db.doc(at).get()).data()).toEqual(placeholder);
    // Asked again at the same revision, nothing changes.
    expect(await store.archiveDraft(a.id, a.job, draft, 3)).toBe('same');

    // No creation reports a draft that is not there, and none is made over the placeholder.
    expect(await firestoreFenceStore(db).createFrom(a.id, a.job, draft, null, manifest, previous)).toBe('archived');
    expect(await firestoreDraftStore(db).ensure(a.id, a.job, draft, a.estimator.uid)).toBe('archived');
    expect(await store.createCopy(a.id, a.job, draft, a.estimator.uid, manifest)).toBe('archived');
    expect(await firestoreDraftStore(db).setFieldOwner(a.id, a.job, draft, a.estimator.uid, 9)).toBe('missing');
    expect(await firestoreFenceStore(db).createFrom(a.id, randomUUID(), draft, null, manifest, previous)).toBe('taken');
    expect((await db.doc(at).get()).data()).toEqual(placeholder);
    expect((await db.collection(`${at}/rooms`).get()).size).toBe(0);
    expect(await getDoc(a.estimator.caller, at)).toBe(403);
    for (const who of [a.estimator, a.owner, a.office]) expect(await writes(who.caller, at)).toEqual([403, 403, 403, 403, 403, 403, 403]);

    // A slower restore that read the job before this archive changes nothing.
    expect(await store.restoreDraft(a.id, a.job, draft, 'editing', 2)).toBe('newer');
    // The restore keeps the revision where there is still no draft, so the archive it follows, delayed
    // in the field database, cannot land after it and bring the placeholder back.
    expect(await store.restoreDraft(a.id, a.job, draft, 'editing', 4)).toBe('set');
    expect((await db.doc(at).get()).data()).toEqual({ jobId: a.job, state: 'absent', placeholder: true, archiveRevision: 4 });
    expect(await store.archiveDraft(a.id, a.job, draft, 3)).toBe('newer');
    expect(await firestoreDraftStore(db).setFieldOwner(a.id, a.job, draft, a.estimator.uid, 9)).toBe('missing');

    // The draft is made over the restored job's placeholder and carries the revision forward.
    expect(await firestoreFenceStore(db).createFrom(a.id, a.job, draft, null, manifest, previous)).toBe('created');
    expect((await db.doc(at).get()).data()).toEqual({
      jobId: a.job,
      state: 'editing',
      field: manifest.draft,
      previous,
      archiveRevision: 4,
    });
    expect((await db.collection(`${at}/rooms`).get()).size).toBe(1);
    expect(await store.archiveDraft(a.id, a.job, draft, 3)).toBe('newer');
    expect((await db.doc(at).get()).get('state')).toBe('editing');

    // A stamp already on its way when the job is archived again names nobody on the archived draft.
    expect(await store.archiveDraft(a.id, a.job, draft, 5)).toBe('set');
    expect(await firestoreDraftStore(db).setFieldOwner(a.id, a.job, draft, a.estimator.uid, 9)).toBe('archived');
    expect((await db.doc(at).get()).get('fieldOwnerUid')).toBeUndefined();
    expect(await getDoc(a.estimator.caller, at)).toBe(403);
  });

  it('keeps the revision of a restore that found no draft, and a draft made then is the restored job’s', async () => {
    const a = await company('restore-missing');
    const draft = randomUUID();
    const at = path(a.id, draft);
    expect(await store.restoreDraft(a.id, a.job, draft, 'editing', 6)).toBe('set');
    expect(await store.archiveDraft(a.id, a.job, draft, 5)).toBe('newer');
    expect(await firestoreDraftStore(db).ensure(a.id, a.job, draft, a.estimator.uid)).toBe('created');
    expect((await db.doc(at).get()).data()).toEqual({
      jobId: a.job,
      fieldOwnerUid: a.estimator.uid,
      state: 'editing',
      field: {},
      archiveRevision: 6,
    });
    expect(await updateDoc(a.estimator.caller, at, { field: { notes: 'mine' } })).toBe(200);
  });
});

describe('a copy’s draft', () => {
  it('is made whole once, with its rooms, and the copier then works on it', async () => {
    const tenant = await createTenant(`copy-${randomUUID().slice(0, 6)}`);
    const companyId = randomUUID();
    const estimator = await member(tenant, companyId, 'estimator');
    const draft = randomUUID();
    const job = randomUUID();
    const manifest = {
      draft: { roomOrder: ['kitchen', 'hall'], notes: 'from the signed job' },
      rooms: [
        { id: 'kitchen', field: { name: 'Kitchen', category: 2 } },
        { id: 'hall', field: { name: 'Hall' } },
      ],
    };
    expect(await store.createCopy(companyId, job, draft, estimator.uid, manifest)).toBe('created');
    const at = path(companyId, draft);
    expect((await db.doc(at).get()).data()).toEqual({ jobId: job, fieldOwnerUid: estimator.uid, state: 'editing', field: manifest.draft });
    const rooms = await db.collection(`${at}/rooms`).get();
    expect(Object.fromEntries(rooms.docs.map((doc) => [doc.id, doc.data()]))).toEqual({ kitchen: { field: { name: 'Kitchen', category: 2 } }, hall: { field: { name: 'Hall' } } });
    expect((await db.collection(`${at}/photos`).get()).size).toBe(0);
    expect(await updateDoc(estimator.caller, at, { field: { ...manifest.draft, scopeConfirmed: true } })).toBe(200);
    // Sent again, it changes nothing the copier has done since; another job never takes it (F1).
    expect(await store.createCopy(companyId, job, draft, estimator.uid, manifest)).toBe('exists');
    expect(await store.createCopy(companyId, randomUUID(), draft, 'uid-other', manifest)).toBe('taken');
    expect((await db.doc(at).get()).data()).toEqual({ jobId: job, fieldOwnerUid: estimator.uid, state: 'editing', field: { ...manifest.draft, scopeConfirmed: true } });
  });

  // Security audit F1, across a release: a copy's draft the previous version made carries no job id.
  // The copy sent again (its job holds the draft id in Postgres first) stamps it, and from then on it
  // is that job's alone.
  it('takes the job id onto a draft made before it when the same copy is sent again, and is then refused to another job', async () => {
    const companyId = randomUUID();
    const draft = randomUUID();
    const job = randomUUID();
    const at = path(companyId, draft);
    const made = { fieldOwnerUid: 'uid-1', state: 'editing', field: { notes: 'made by the previous version' } };
    await db.doc(at).create(made);
    const manifest = { draft: { notes: 'from the signed job' }, rooms: [] };
    expect(await store.createCopy(companyId, job, draft, 'uid-1', manifest)).toBe('exists');
    expect((await db.doc(at).get()).data()).toEqual({ ...made, jobId: job });
    expect(await store.createCopy(companyId, randomUUID(), draft, 'uid-2', manifest)).toBe('taken');
    expect((await db.doc(at).get()).data()).toEqual({ ...made, jobId: job });
  });
});
