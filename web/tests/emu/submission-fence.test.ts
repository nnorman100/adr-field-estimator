import { randomUUID } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseProjectionConfig } from '@/lib/config';
import type { FieldManifest } from '@/lib/field/canonical';
import { firestoreAccessStore, firestoreFor } from '@/lib/projection/firestore';
import { firestoreFenceStore, type FenceStore } from '@/lib/submissions/fence';
import { fenceStoreContract } from '../submissions/fence-contract';
import { createTenant, projectId, signIn, signUp } from './auth-emulator';
import { createDoc, updateDoc } from './rules/firestore-rest';

// S5a-8: the real Firestore fence writer (src/lib/submissions/fence.ts) against the emulator, held
// to the same contract as the database tests' stand-in, and the field rules on a fenced, submitted
// and released draft and on the draft Back to editing makes, with real Auth emulator tokens: a
// locked draft refuses every phone write. The routes are in tests/db/submissions-api.test.ts.

let db: Firestore;
let store: FenceStore;
let grants: ReturnType<typeof firestoreAccessStore>;

beforeAll(() => {
  const config = parseProjectionConfig({
    APP_ENV: 'local',
    GOOGLE_CLOUD_PROJECT: projectId,
    FIRESTORE_DATABASE_ID: '(default)',
    FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST,
  });
  db = firestoreFor(config);
  store = firestoreFenceStore(db);
  grants = firestoreAccessStore(db);
});

const draftPath = (company: string, draft: string) => `companies/${company}/drafts/${draft}`;

async function seed(company: string, draft: string, manifest: FieldManifest, fieldOwnerUid: string | null = null): Promise<void> {
  const ref = db.doc(draftPath(company, draft));
  await ref.set({ ...(fieldOwnerUid === null ? {} : { fieldOwnerUid }), state: 'editing', field: manifest.draft ?? {} });
  for (const room of manifest.rooms) await ref.collection('rooms').doc(room.id).set({ field: room.field });
  for (const photo of manifest.photos) await ref.collection('photos').doc(photo.id).set({ field: photo.field });
}

fenceStoreContract('Firestore', () => ({
  store,
  seed,
  async peek(company, draft) {
    const ref = db.doc(draftPath(company, draft));
    const doc = await ref.get();
    if (!doc.exists) return null;
    const data = doc.data()!;
    const fence = data.fence as { submissionId: string; epoch: string } | undefined;
    const nested = async (name: string) => (await ref.collection(name).get()).docs.map((d) => ({ id: d.id, field: d.get('field') }));
    return {
      state: data.state as string,
      fence: fence ? { submissionId: fence.submissionId, epoch: fence.epoch } : null,
      previous: (data.previous as { draftId: string; submissionId: string } | undefined) ?? null,
      fieldOwnerUid: (data.fieldOwnerUid as string | undefined) ?? null,
      manifest: { draft: data.field, rooms: await nested('rooms'), photos: await nested('photos') },
    };
  },
}));

const DAY = 24 * 60 * 60 * 1000;

async function member(tenantId: string, company: string, role: 'owner' | 'estimator' | 'office') {
  const email = `${role}-${randomUUID().slice(0, 8)}@fence.example.test`;
  const password = `synthetic-password-${role}`;
  const uid = await signUp(tenantId, email, password);
  await grants.grant({ companyId: company, authTenantId: tenantId, uid, role, expiresAt: new Date(Date.now() + DAY), version: 1 });
  return { uid, caller: { idToken: await signIn(tenantId, email, password) } };
}

const MANIFEST: FieldManifest = {
  draft: { yearBuilt: 1985, roomOrder: ['kitchen'] },
  rooms: [{ id: 'kitchen', field: { name: 'Kitchen' } }],
  photos: [{ id: 'photo-1', field: { roomId: 'kitchen' } }],
};

const fenceOf = () => ({ submissionId: randomUUID(), epoch: randomUUID(), expiresAt: new Date(Date.now() + 120_000) });

// Every phone write the field rules allow on an editing draft: the draft's field map, a new room, a
// changed room, a new photo reference and a changed one. Each answers `expected`.
async function phoneWrites(caller: { idToken: string }, company: string, draft: string, expected: number): Promise<void> {
  const path = draftPath(company, draft);
  const tag = randomUUID().slice(0, 8);
  const answers = {
    draft: await updateDoc(caller, path, { field: { yearBuilt: 1985, roomOrder: ['kitchen'], notes: `note ${tag}` } }),
    newRoom: await createDoc(caller, `${path}/rooms/room-${tag}`, { field: { name: 'Hall' } }),
    room: await updateDoc(caller, `${path}/rooms/kitchen`, { field: { name: `Kitchen ${tag}` } }),
    newPhoto: await createDoc(caller, `${path}/photos/photo-${tag}`, { field: {} }),
    photo: await updateDoc(caller, `${path}/photos/photo-1`, { field: { shotTag: 'overview' } }),
  };
  expect(answers).toEqual({ draft: expected, newRoom: expected, room: expected, newPhoto: expected, photo: expected });
}

describe('the field rules on a draft Submit has fenced', () => {
  it('refuse every phone write while submitting and after submitted, and allow them again after a release', async () => {
    const tenant = await createTenant('fence-rules-a');
    const company = randomUUID();
    const owner = await member(tenant, company, 'estimator');
    const submittedDraft = randomUUID();
    const releasedDraft = randomUUID();
    await seed(company, submittedDraft, MANIFEST, owner.uid);
    await seed(company, releasedDraft, MANIFEST, owner.uid);
    await phoneWrites(owner.caller, company, submittedDraft, 200);

    const submitted = fenceOf();
    expect(await store.fence(company, submittedDraft, submitted)).toEqual({ outcome: 'fenced' });
    await phoneWrites(owner.caller, company, submittedDraft, 403);
    expect(await store.markSubmitted(company, submittedDraft, submitted.epoch, submitted.submissionId)).toBe('marked');
    await phoneWrites(owner.caller, company, submittedDraft, 403);
    // The phone cannot undo the server's keys either.
    expect(await updateDoc(owner.caller, draftPath(company, submittedDraft), { state: 'editing' })).toBe(403);

    const released = fenceOf();
    await store.fence(company, releasedDraft, released);
    await phoneWrites(owner.caller, company, releasedDraft, 403);
    expect(await store.release(company, releasedDraft, released.epoch)).toBe('released');
    await phoneWrites(owner.caller, company, releasedDraft, 200);
  });

  it('let the field owner edit the next draft version Back to editing makes, and nobody else', async () => {
    const tenant = await createTenant('fence-rules-b');
    const company = randomUUID();
    const owner = await member(tenant, company, 'estimator');
    const other = await member(tenant, company, 'estimator');
    const office = await member(tenant, company, 'office');
    const next = randomUUID();
    expect(await store.createFrom(company, next, owner.uid, MANIFEST, { draftId: randomUUID(), submissionId: randomUUID() })).toBe('created');
    await phoneWrites(owner.caller, company, next, 200);
    await phoneWrites(other.caller, company, next, 403);
    await phoneWrites(office.caller, company, next, 403);
    // Its provenance is the server's.
    expect(await updateDoc(owner.caller, draftPath(company, next), { previous: { draftId: 'x', submissionId: 'y' } })).toBe(403);
  });
});
