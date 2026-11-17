import { randomUUID } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseProjectionConfig } from '@/lib/config';
import { firestoreArchiveStore, type ArchiveStore } from '@/lib/jobs/archive-store';
import { firestoreDraftStore } from '@/lib/jobs/drafts';
import { firestoreAccessStore, firestoreFor } from '@/lib/projection/firestore';
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
  const draft = randomUUID();
  const estimator = await member(tenant, id, 'estimator');
  const owner = await member(tenant, id, 'owner');
  const office = await member(tenant, id, 'office');
  expect(await firestoreDraftStore(db).ensure(id, draft, estimator.uid)).toBe('created');
  const at = path(id, draft);
  expect(await updateDoc(estimator.caller, at, { field: { notes: 'wet carpet', roomOrder: ['kitchen'] } })).toBe(200);
  expect(await createDoc(estimator.caller, `${at}/rooms/kitchen`, { field: { name: 'Kitchen' } })).toBe(200);
  expect(await createDoc(estimator.caller, `${at}/photos/p1`, { field: { roomId: 'kitchen' } })).toBe(200);
  return { id, draft, at, estimator, owner, office };
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
    expect(await store.archiveDraft(a.id, a.draft, 4)).toBe('set');
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
    expect(await store.archiveDraft(a.id, a.draft, 4)).toBe('same');

    expect(await store.restoreDraft(a.id, a.draft, 'editing', 5)).toBe('set');
    expect((await db.doc(a.at).get()).data()).toMatchObject({ state: 'editing', archiveRevision: 5 });
    expect(await updateDoc(a.estimator.caller, a.at, { field: { notes: 'back at work', roomOrder: ['kitchen'] } })).toBe(200);
    // The slower archive request that read the job before the restore changes nothing.
    expect(await store.archiveDraft(a.id, a.draft, 4)).toBe('newer');
    expect((await db.doc(a.at).get()).get('state')).toBe('editing');
  });

  it('is restored as submitted when its job was, and a restore leaves a draft that is not archived as it is', async () => {
    const company = randomUUID();
    const submitted = randomUUID();
    const fence = { submissionId: randomUUID(), epoch: 'epoch-1' };
    await db.doc(path(company, submitted)).create({ fieldOwnerUid: 'uid-1', state: 'submitted', fence, field: { notes: 'as submitted' } });
    expect(await store.archiveDraft(company, submitted, 3)).toBe('set');
    expect(await store.restoreDraft(company, submitted, 'submitted', 4)).toBe('set');
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
    expect(await store.restoreDraft(company, fenced, 'editing', 6)).toBe('set');
    expect((await db.doc(path(company, fenced)).get()).data()).toMatchObject({ state: 'submitting', fence, archiveRevision: 6 });
    expect(await store.archiveDraft(company, fenced, 5)).toBe('newer');
    const missing = randomUUID();
    expect(await store.archiveDraft(company, missing, 2)).toBe('missing');
    expect((await db.doc(path(company, missing)).get()).exists).toBe(false);
  });

  it('is never reached by the other company, archived or restored', async () => {
    const a = await company('archive-iso-a');
    const b = await company('archive-iso-b');
    expect(await store.archiveDraft(a.id, a.draft, 2)).toBe('set');
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

describe('a copy’s draft', () => {
  it('is made whole once, with its rooms, and the copier then works on it', async () => {
    const tenant = await createTenant(`copy-${randomUUID().slice(0, 6)}`);
    const companyId = randomUUID();
    const estimator = await member(tenant, companyId, 'estimator');
    const draft = randomUUID();
    const manifest = {
      draft: { roomOrder: ['kitchen', 'hall'], notes: 'from the signed job' },
      rooms: [
        { id: 'kitchen', field: { name: 'Kitchen', category: 2 } },
        { id: 'hall', field: { name: 'Hall' } },
      ],
    };
    expect(await store.createCopy(companyId, draft, estimator.uid, manifest)).toBe('created');
    const at = path(companyId, draft);
    expect((await db.doc(at).get()).data()).toEqual({ fieldOwnerUid: estimator.uid, state: 'editing', field: manifest.draft });
    const rooms = await db.collection(`${at}/rooms`).get();
    expect(Object.fromEntries(rooms.docs.map((doc) => [doc.id, doc.data()]))).toEqual({ kitchen: { field: { name: 'Kitchen', category: 2 } }, hall: { field: { name: 'Hall' } } });
    expect((await db.collection(`${at}/photos`).get()).size).toBe(0);
    expect(await updateDoc(estimator.caller, at, { field: { ...manifest.draft, scopeConfirmed: true } })).toBe(200);
    // Sent again, it changes nothing the copier has done since.
    expect(await store.createCopy(companyId, draft, estimator.uid, manifest)).toBe('exists');
    expect((await db.doc(at).get()).get('field')).toEqual({ ...manifest.draft, scopeConfirmed: true });
  });
});
