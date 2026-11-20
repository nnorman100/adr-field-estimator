import { randomUUID } from 'node:crypto';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseProjectionConfig } from '@/lib/config';
import { MAX_PHOTO_REFS, MAX_ROOMS } from '@/lib/field/schema';
import { desired, MalformedGenerationError, MalformedMarkerError, type JobDraftSnapshot, type SyncMarker } from '@/lib/jobs/draft-lifecycle';
import { raiseGeneration } from '../../scripts/raise-draft-sync-generation';
import { firestoreDraftSync, GENERATION_PATH, type DraftSync } from '@/lib/jobs/draft-sync';
import { firestoreAccessStore, firestoreFor } from '@/lib/projection/firestore';
import { draftSyncContract } from '../submissions/sync-contract';
import { createTenant, projectId, signIn, signUp, withSecondFactor } from './auth-emulator';
import { createDoc, getDoc, updateDoc, type Caller } from './rules/firestore-rest';

// The draft life-cycle sync (src/lib/jobs/draft-sync.ts) against the emulator: held to the same
// contract as the database tests' stand-in, then used the way the phone would, under
// web/firestore.rules with real Auth emulator tokens. No client reads or writes the job's marker; after
// a sync moves the field work, the old owner reads none of the job's drafts. One sync makes a Back to
// editing draft at the room and photo caps, beside earlier drafts, in one transaction. Nothing calls the
// sync yet (slice 2 of the redesign).

let db: Firestore;
let store: DraftSync;
let grants: ReturnType<typeof firestoreAccessStore>;

beforeAll(() => {
  const config = parseProjectionConfig({
    APP_ENV: 'local',
    GOOGLE_CLOUD_PROJECT: projectId,
    FIRESTORE_DATABASE_ID: '(default)',
    FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST,
  });
  db = firestoreFor(config);
  store = firestoreDraftSync(db);
  grants = firestoreAccessStore(db);
});

const draftPath = (company: string, draft: string) => `companies/${company}/drafts/${draft}`;
const markerPath = (company: string, job: string) => `companies/${company}/draftLifecycle/${job}`;
const nested = async (path: string, name: string) => (await db.doc(path).collection(name).get()).docs.map((doc) => ({ id: doc.id, field: doc.get('field') }));

draftSyncContract('Firestore', () => ({
  store,
  async seed(company, draft, seed) {
    const ref = db.doc(draftPath(company, draft));
    const { rooms, photos, fence, ...data } = seed;
    await ref.set({
      ...data,
      ...(fence ? { fence: { submissionId: fence.submissionId, epoch: fence.epoch, expiresAt: Timestamp.fromDate(fence.expiresAt) } } : {}),
    });
    for (const room of rooms ?? []) await ref.collection('rooms').doc(room.id).set({ field: room.field });
    for (const photo of photos ?? []) await ref.collection('photos').doc(photo.id).set({ field: photo.field });
  },
  async peek(company, draft) {
    const path = draftPath(company, draft);
    const doc = await db.doc(path).get();
    if (!doc.exists) return null;
    const data = doc.data()!;
    const fence = data.fence as { submissionId: string; epoch: string; expiresAt: Timestamp } | undefined;
    return {
      jobId: (data.jobId as string | undefined) ?? null,
      state: data.state as string,
      fieldOwnerUid: (data.fieldOwnerUid as string | undefined) ?? null,
      fence: fence ? { submissionId: fence.submissionId, epoch: fence.epoch, expiresAt: fence.expiresAt.toMillis() } : null,
      previous: (data.previous as { draftId: string; submissionId: string } | undefined) ?? null,
      archiveRevision: (data.archiveRevision as number | undefined) ?? null,
      fieldOwnerRevision: (data.fieldOwnerRevision as number | undefined) ?? null,
      placeholder: data.placeholder === true,
      field: data.field,
      rooms: await nested(path, 'rooms'),
      photos: await nested(path, 'photos'),
    };
  },
  async marker(company, job) {
    const found = await db.doc(markerPath(company, job)).get();
    return found.exists ? (found.data() as SyncMarker) : null;
  },
  async remove(company, draft) {
    await db.recursiveDelete(db.doc(draftPath(company, draft)));
  },
  async seedMarker(company, job, data) {
    await db.doc(markerPath(company, job)).set(data);
  },
  async seedGeneration(data) {
    if (data === null) await db.doc(GENERATION_PATH).delete();
    else await db.doc(GENERATION_PATH).set(data);
  },
}));

const DAY = 24 * 60 * 60 * 1000;

async function member(tenantId: string, company: string, role: 'owner' | 'estimator' | 'office'): Promise<{ uid: string; caller: Caller }> {
  const email = `${role}-${randomUUID().slice(0, 8)}@sync.example.test`;
  const password = `synthetic-password-${role}`;
  const uid = await signUp(tenantId, email, password);
  await grants.grant({ companyId: company, authTenantId: tenantId, uid, role, expiresAt: new Date(Date.now() + DAY), version: 1 });
  const idToken = await signIn(tenantId, email, password);
  return { uid, caller: { idToken: role === 'estimator' ? idToken : withSecondFactor(idToken) } };
}

function snapshotOf(extra: Partial<JobDraftSnapshot> & Pick<JobDraftSnapshot, 'currentDraftId' | 'draftIds'>): JobDraftSnapshot {
  return {
    jobId: randomUUID(),
    status: 'draft',
    fieldOwnerUid: null,
    fieldRevision: 1,
    revision: 1,
    coordinationRevision: 0,
    pending: null,
    committed: null,
    abortedEpochs: [],
    content: { kind: 'empty' },
    ...extra,
  };
}

describe('the draft sync under the field rules', () => {
  it('keeps the job’s marker closed to every client, owner included', async () => {
    const tenant = await createTenant(`sync-m-${randomUUID().slice(0, 6)}`);
    const company = randomUUID();
    const [owner, estimator] = [await member(tenant, company, 'owner'), await member(tenant, company, 'estimator')];
    const draft = randomUUID();
    const job = snapshotOf({ currentDraftId: draft, draftIds: [draft], fieldOwnerUid: estimator.uid });
    expect(await store.sync(company, desired(job), 0)).toMatchObject({ outcome: 'synced' });
    for (const who of [owner, estimator]) {
      expect(await getDoc(who.caller, markerPath(company, job.jobId))).toBe(403);
      expect(await updateDoc(who.caller, markerPath(company, job.jobId), { gen: 9, v: 99 })).toBe(403);
      expect(await createDoc(who.caller, markerPath(company, randomUUID()), { gen: 9, v: 99 })).toBe(403);
    }
    // The estimator works on the draft the sync made, as the phone does.
    expect(await updateDoc(estimator.caller, draftPath(company, draft), { field: { notes: 'wet carpet' } })).toBe(200);
  });

  it('the operator script raises the generation by one in a transaction, and stops on a document not in its shape', async () => {
    try {
      await db.doc(GENERATION_PATH).delete();
      expect(await raiseGeneration(db)).toEqual({ from: 0, to: 1 });
      expect(await raiseGeneration(db)).toEqual({ from: 1, to: 2 });
      expect((await db.doc(GENERATION_PATH).get()).data()).toEqual({ gen: 2 });
      // The next sync of a job writes at that generation.
      const company = randomUUID();
      const draft = randomUUID();
      const job = snapshotOf({ currentDraftId: draft, draftIds: [draft] });
      expect(await store.sync(company, desired(job), 0)).toMatchObject({ outcome: 'synced' });
      expect((await db.doc(markerPath(company, job.jobId)).get()).get('gen')).toBe(2);
      await db.doc(GENERATION_PATH).set({ gen: 'two' });
      await expect(raiseGeneration(db)).rejects.toBeInstanceOf(MalformedGenerationError);
      expect((await db.doc(GENERATION_PATH).get()).data()).toEqual({ gen: 'two' });
      // Never past a generation the sync can read back.
      await db.doc(GENERATION_PATH).set({ gen: Number.MAX_SAFE_INTEGER });
      await expect(raiseGeneration(db)).rejects.toThrow('cannot be raised further');
      expect((await db.doc(GENERATION_PATH).get()).data()).toEqual({ gen: Number.MAX_SAFE_INTEGER });
    } finally {
      await db.doc(GENERATION_PATH).delete();
    }
  });

  it('keeps the operator’s generation document closed to every client, owner included', async () => {
    const tenant = await createTenant(`sync-g-${randomUUID().slice(0, 6)}`);
    const company = randomUUID();
    const [owner, estimator] = [await member(tenant, company, 'owner'), await member(tenant, company, 'estimator')];
    try {
      await db.doc(GENERATION_PATH).set({ gen: 1 });
      for (const who of [owner, estimator]) {
        expect(await getDoc(who.caller, GENERATION_PATH)).toBe(403);
        expect(await updateDoc(who.caller, GENERATION_PATH, { gen: 0 })).toBe(403);
        expect(await createDoc(who.caller, `draftSyncGeneration/${randomUUID()}`, { gen: 0 })).toBe(403);
      }
      await db.doc(GENERATION_PATH).delete();
      for (const who of [owner, estimator]) expect(await createDoc(who.caller, GENERATION_PATH, { gen: 9 })).toBe(403);
      expect((await db.doc(GENERATION_PATH).get()).exists).toBe(false);
    } finally {
      await db.doc(GENERATION_PATH).delete();
    }
  });

  it('after a sync moves the field work, the old owner reads none of the job’s drafts and the new owner reads all', async () => {
    const tenant = await createTenant(`sync-o-${randomUUID().slice(0, 6)}`);
    const company = randomUUID();
    const [first, second] = [await member(tenant, company, 'estimator'), await member(tenant, company, 'estimator')];
    const [earlier, current] = [randomUUID(), randomUUID()];
    // An earlier, submitted draft (made by Back to editing's predecessor) and the current one.
    await db.doc(draftPath(company, earlier)).set({ state: 'submitted', fieldOwnerUid: first.uid, field: { notes: 'first visit' } });
    const job = snapshotOf({ currentDraftId: current, draftIds: [earlier, current], fieldOwnerUid: first.uid });
    await store.sync(company, desired(job), 0);
    for (const draft of [earlier, current]) expect(await getDoc(first.caller, draftPath(company, draft))).toBe(200);

    await store.sync(company, desired({ ...job, fieldRevision: 2, fieldOwnerUid: second.uid }), 0);
    for (const draft of [earlier, current]) {
      expect(await getDoc(first.caller, draftPath(company, draft))).toBe(403);
      expect(await getDoc(second.caller, draftPath(company, draft))).toBe(200);
    }
    expect(await updateDoc(first.caller, draftPath(company, current), { field: { notes: 'late edit' } })).toBe(403);
    expect(await updateDoc(second.caller, draftPath(company, current), { field: { notes: 'taken over' } })).toBe(200);
  });

  it('makes a Back to editing draft at the room and photo caps, beside earlier drafts, in one transaction', async () => {
    const company = randomUUID();
    const earlier = Array.from({ length: 20 }, () => randomUUID());
    for (const draft of earlier) await db.doc(draftPath(company, draft)).set({ state: 'submitted', fieldOwnerUid: 'old-owner', field: {} });
    const rooms = Array.from({ length: MAX_ROOMS }, (_, i) => ({ id: `room-${i}`, field: { name: `Room ${i}`, notes: 'x'.repeat(2000) } }));
    const photos = Array.from({ length: MAX_PHOTO_REFS }, () => ({ id: randomUUID(), field: { roomId: 'room-0', shotTag: 'overview', capturedAt: '2026-11-20T09:00:00.000Z' } }));
    const current = randomUUID();
    const job = snapshotOf({
      currentDraftId: current,
      draftIds: [...earlier, current],
      fieldOwnerUid: 'estimator-1',
      content: { kind: 'next', manifest: { draft: { roomOrder: rooms.map((room) => room.id) }, rooms, photos }, previous: { draftId: earlier[0]!, submissionId: randomUUID() } },
    });
    expect(await store.sync(company, desired(job), 0)).toEqual({ outcome: 'synced', created: [current], changed: [...earlier].sort(), conflicts: [], missing: [], superseded: [], unmatched: [] });
    expect((await db.doc(draftPath(company, current)).collection('rooms').count().get()).data().count).toBe(MAX_ROOMS);
    expect((await db.doc(draftPath(company, current)).collection('photos').count().get()).data().count).toBe(MAX_PHOTO_REFS);
    for (const draft of earlier) expect((await db.doc(draftPath(company, draft)).get()).get('fieldOwnerUid')).toBe('estimator-1');
  });

  it('writes nothing at all when one of its writes fails: the new draft, the earlier drafts and the marker stay as they were', async () => {
    const company = randomUUID();
    const [earlier, current] = [randomUUID(), randomUUID()];
    await db.doc(draftPath(company, earlier)).set({ state: 'submitted', fieldOwnerUid: 'old-owner', field: {} });
    // A manifest naming one room twice: the second create of that room fails the transaction at commit,
    // after the earlier draft's update and the new draft were already written into it.
    const job = snapshotOf({
      currentDraftId: current,
      draftIds: [earlier, current],
      fieldOwnerUid: 'estimator-1',
      content: {
        kind: 'next',
        manifest: { draft: {}, rooms: [{ id: 'kitchen', field: { name: 'Kitchen' } }, { id: 'kitchen', field: { name: 'Again' } }], photos: [] },
        previous: { draftId: earlier, submissionId: randomUUID() },
      },
    });
    await expect(store.sync(company, desired(job), 0)).rejects.toThrow();
    expect((await db.doc(draftPath(company, current)).get()).exists).toBe(false);
    expect((await db.doc(draftPath(company, earlier)).get()).data()).toEqual({ state: 'submitted', fieldOwnerUid: 'old-owner', field: {} });
    expect((await db.doc(markerPath(company, job.jobId)).get()).exists).toBe(false);
    expect((await db.doc(`${draftPath(company, current)}/rooms/kitchen`).get()).exists).toBe(false);
  });

  it('stops, changing nothing, when the job’s marker is there but not in the shape the sync writes', async () => {
    const company = randomUUID();
    const draft = randomUUID();
    const job = snapshotOf({ currentDraftId: draft, draftIds: [draft], fieldOwnerUid: 'estimator-1' });
    await db.doc(markerPath(company, job.jobId)).set({ gen: 0, v: 'one' });
    await expect(store.sync(company, desired(job), 0)).rejects.toBeInstanceOf(MalformedMarkerError);
    expect((await db.doc(draftPath(company, draft)).get()).exists).toBe(false);
    expect((await db.doc(markerPath(company, job.jobId)).get()).data()).toEqual({ gen: 0, v: 'one' });
  });

  it('never makes a draft over rooms or photos left under its id, whatever their ids: it reports a conflict and hands them to nobody', async () => {
    const company = randomUUID();
    for (const name of ['rooms', 'photos']) {
      const draft = randomUUID();
      await db.doc(`${draftPath(company, draft)}/${name}/left-over`).set({ field: {} });
      const job = snapshotOf({
        currentDraftId: draft,
        draftIds: [draft],
        fieldOwnerUid: 'estimator-1',
        content: { kind: 'next', manifest: { draft: {}, rooms: [{ id: 'kitchen', field: {} }], photos: [] }, previous: { draftId: randomUUID(), submissionId: randomUUID() } },
      });
      expect(await store.sync(company, desired(job), 0)).toMatchObject({ outcome: 'synced', created: [], conflicts: [draft] });
      expect((await db.doc(draftPath(company, draft)).get()).exists).toBe(false);
      expect((await db.doc(`${draftPath(company, draft)}/rooms/kitchen`).get()).exists).toBe(false);
    }
  });

  it('removes a fence the sync cannot read (no expiry) when Postgres says the draft is editing', async () => {
    const company = randomUUID();
    const draft = randomUUID();
    // The fence of a row the snapshot knows (so not another writer's Submit), stored without its expiry:
    // an aborted one (a recorded attempt's fence is never opened, sync-contract.ts).
    const aborted = { submissionId: randomUUID(), epoch: randomUUID() };
    const job = snapshotOf({ currentDraftId: draft, draftIds: [draft], fieldOwnerUid: 'estimator-1', abortedEpochs: [aborted.epoch] });
    await db.doc(draftPath(company, draft)).set({ jobId: job.jobId, state: 'submitting', fieldOwnerUid: 'estimator-1', fence: { submissionId: aborted.submissionId, epoch: aborted.epoch }, field: {} });
    expect(await store.sync(company, desired(job), 0)).toMatchObject({ changed: [draft], superseded: [] });
    const found = (await db.doc(draftPath(company, draft)).get()).data()!;
    expect(found.state).toBe('editing');
    expect('fence' in found).toBe(false);
  });
});
