import { randomUUID } from 'node:crypto';
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseProjectionConfig } from '@/lib/config';
import type { FieldManifest } from '@/lib/field/canonical';
import { firestoreAccessStore, firestoreFor } from '@/lib/projection/firestore';
import { firestoreFenceStore, type FenceStore } from '@/lib/submissions/fence';
import { fenceStoreContract } from '../submissions/fence-contract';
import { createTenant, projectId, signIn, signUp, withSecondFactor } from './auth-emulator';
import { createDoc, updateDoc } from './rules/firestore-rest';

// S5a-8: the real Firestore fence reader (src/lib/submissions/fence.ts) against the emulator, held to
// the same contract as the database tests' stand-in, and the field rules on a fenced, submitted and
// released draft and on the draft Back to editing makes, with real Auth emulator tokens: a locked draft
// refuses every phone write. The drafts are left as the draft sync writes them (`place`, `release`,
// `nextDraft`; the sync itself is checked against the emulator in draft-sync.test.ts). The routes are in
// tests/db/submissions-api.test.ts.

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

// An editing draft as the draft sync makes it (the job id, the field owner, the state, the field map and
// the revisions it was written at), with the phone's rooms and photo references.
async function seed(company: string, draft: string, manifest: FieldManifest, fieldOwnerUid: string | null = null): Promise<void> {
  const ref = db.doc(draftPath(company, draft));
  await ref.set({ jobId: randomUUID(), ...(fieldOwnerUid === null ? {} : { fieldOwnerUid }), state: 'editing', field: manifest.draft ?? {}, archiveRevision: 1, fieldOwnerRevision: 0 });
  for (const room of manifest.rooms) await ref.collection('rooms').doc(room.id).set({ field: room.field });
  for (const photo of manifest.photos) await ref.collection('photos').doc(photo.id).set({ field: photo.field });
}

// The keys the draft sync writes for a Submit's fence (`submitting`) and its marker (`submitted`); the
// marker also takes the job's new revision (a Submit raises it).
async function place(company: string, draft: string, state: 'submitting' | 'submitted', fence: { submissionId: string; epoch: string; expiresAt: Date }): Promise<void> {
  await db.doc(draftPath(company, draft)).update({
    state,
    fence: { submissionId: fence.submissionId, epoch: fence.epoch, expiresAt: Timestamp.fromDate(fence.expiresAt) },
    ...(state === 'submitted' ? { archiveRevision: 2 } : {}),
  });
}

// What the draft sync writes when a Submit is aborted: back to `editing`, with no fence.
async function release(company: string, draft: string): Promise<void> {
  await db.doc(draftPath(company, draft)).update({ state: 'editing', fence: FieldValue.delete() });
}

fenceStoreContract('Firestore', () => ({
  store,
  seed,
  place,
}));

const DAY = 24 * 60 * 60 * 1000;

async function member(tenantId: string, company: string, role: 'owner' | 'estimator' | 'office') {
  const email = `${role}-${randomUUID().slice(0, 8)}@fence.example.test`;
  const password = `synthetic-password-${role}`;
  const uid = await signUp(tenantId, email, password);
  await grants.grant({ companyId: company, authTenantId: tenantId, uid, role, expiresAt: new Date(Date.now() + DAY), version: 1 });
  // An owner or office user signs in with the authenticator app as the second step (D2).
  const idToken = await signIn(tenantId, email, password);
  return { uid, caller: { idToken: role === 'estimator' ? idToken : withSecondFactor(idToken) } };
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
    await place(company, submittedDraft, 'submitting', submitted);
    await phoneWrites(owner.caller, company, submittedDraft, 403);
    await place(company, submittedDraft, 'submitted', submitted);
    await phoneWrites(owner.caller, company, submittedDraft, 403);
    // The phone cannot undo the server's keys either.
    expect(await updateDoc(owner.caller, draftPath(company, submittedDraft), { state: 'editing' })).toBe(403);

    const released = fenceOf();
    await place(company, releasedDraft, 'submitting', released);
    await phoneWrites(owner.caller, company, releasedDraft, 403);
    await release(company, releasedDraft);
    await phoneWrites(owner.caller, company, releasedDraft, 200);
  });

  it('let the field owner edit the next draft version Back to editing makes, and nobody else', async () => {
    const tenant = await createTenant('fence-rules-b');
    const company = randomUUID();
    const owner = await member(tenant, company, 'estimator');
    const other = await member(tenant, company, 'estimator');
    const office = await member(tenant, company, 'office');
    const next = randomUUID();
    // As the draft sync makes it: the job id, the field owner, `editing`, the field data and its provenance.
    await seed(company, next, MANIFEST, owner.uid);
    await db.doc(draftPath(company, next)).update({ previous: { draftId: randomUUID(), submissionId: randomUUID() }, archiveRevision: 3 });
    await phoneWrites(owner.caller, company, next, 200);
    await phoneWrites(other.caller, company, next, 403);
    await phoneWrites(office.caller, company, next, 403);
    // Its provenance is the server's.
    expect(await updateDoc(owner.caller, draftPath(company, next), { previous: { draftId: 'x', submissionId: 'y' } })).toBe(403);
  });
});
