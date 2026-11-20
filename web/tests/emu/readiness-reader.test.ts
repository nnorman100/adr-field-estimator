import { randomUUID } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseProjectionConfig } from '@/lib/config';
import { MAX_PHOTO_REFS, MAX_ROOMS } from '@/lib/field/schema';
import { firestoreFor } from '@/lib/projection/firestore';
import { firestoreReadinessReader, type ReadinessReader } from '@/lib/readiness/reader';
import { projectId } from './auth-emulator';

// S5b-11 slice 11A: the readiness check's read-only reader of a job's current field draft
// (src/lib/readiness/reader.ts) against the Firestore emulator. It reads only an editing draft made for
// the job (or made before drafts carried their job id), with its rooms and photo references, within
// the safety caps, and leaves every document exactly as it was. The route is in
// tests/db/readiness-api.test.ts, over the stand-in that gives these same outcomes.

let db: Firestore;
let reader: ReadinessReader;

beforeAll(() => {
  const config = parseProjectionConfig({
    APP_ENV: 'local',
    GOOGLE_CLOUD_PROJECT: projectId,
    FIRESTORE_DATABASE_ID: '(default)',
    FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST,
  });
  db = firestoreFor(config);
  reader = firestoreReadinessReader(db);
});

const draftRef = (company: string, draft: string) => db.collection('companies').doc(company).collection('drafts').doc(draft);

async function seed(company: string, draft: string, data: Record<string, unknown>, rooms = 1, photos = 1): Promise<void> {
  const ref = draftRef(company, draft);
  await ref.set(data);
  for (let start = 0; start < Math.max(rooms, photos); start += 400) {
    const batch = db.batch();
    for (let i = start; i < Math.min(start + 400, rooms); i += 1) batch.set(ref.collection('rooms').doc(`room-${i}`), { field: { name: `Room ${i}` } });
    for (let i = start; i < Math.min(start + 400, photos); i += 1) batch.set(ref.collection('photos').doc(`photo-${i}`), { field: { roomId: 'room-0', shotTag: 'overview' } });
    await batch.commit();
  }
}

// Every document under the draft with its update time, to prove a read changed nothing.
async function snapshot(company: string, draft: string): Promise<string> {
  const ref = draftRef(company, draft);
  const doc = await ref.get();
  const nested = async (name: string) => (await ref.collection(name).get()).docs.map((d) => [d.id, d.updateTime.toMillis(), d.data()]);
  return JSON.stringify([doc.exists ? [doc.updateTime?.toMillis(), doc.data()] : null, await nested('rooms'), await nested('photos')]);
}

describe('the readiness draft reader', () => {
  it('reads an editing draft of the job, its rooms and photo references, and changes nothing', async () => {
    const [company, job, draft] = [randomUUID(), randomUUID(), randomUUID()];
    await seed(company, draft, { jobId: job, state: 'editing', fieldOwnerUid: 'uid-1', field: { yearBuilt: 1990, roomOrder: ['room-0'] } });
    const before = await snapshot(company, draft);
    expect(await reader.readEditing(company, job, draft)).toEqual({
      outcome: 'read',
      stamped: true,
      manifest: {
        draft: { yearBuilt: 1990, roomOrder: ['room-0'] },
        rooms: [{ id: 'room-0', field: { name: 'Room 0' } }],
        photos: [{ id: 'photo-0', field: { roomId: 'room-0', shotTag: 'overview' } }],
      },
    });
    expect(await snapshot(company, draft)).toBe(before);
  });

  it('reads a draft made before drafts carried their job id, and says so', async () => {
    const [company, job, draft] = [randomUUID(), randomUUID(), randomUUID()];
    await seed(company, draft, { state: 'editing', field: {} }, 0, 0);
    expect(await reader.readEditing(company, job, draft)).toEqual({ outcome: 'read', stamped: false, manifest: { draft: {}, rooms: [], photos: [] } });
  });

  it('refuses a draft of another job, one not editing, a missing one and an archive’s placeholder', async () => {
    const [company, job, draft] = [randomUUID(), randomUUID(), randomUUID()];
    await seed(company, draft, { jobId: randomUUID(), state: 'editing', field: {} });
    expect(await reader.readEditing(company, job, draft)).toEqual({ outcome: 'other_job' });
    for (const state of ['submitting', 'submitted', 'archived']) {
      await draftRef(company, draft).set({ jobId: job, state, field: {} });
      expect(await reader.readEditing(company, job, draft), state).toEqual({ outcome: 'not_editing' });
    }
    expect(await reader.readEditing(company, job, randomUUID())).toEqual({ outcome: 'missing' });
    await draftRef(company, draft).set({ placeholder: true, jobId: job, state: 'absent', archiveRevision: 2 });
    expect(await reader.readEditing(company, job, draft)).toEqual({ outcome: 'missing' });
    // Another company's draft under the same id is not this company's.
    expect(await reader.readEditing(randomUUID(), job, draft)).toEqual({ outcome: 'missing' });
  });

  it('refuses a draft over the room or photo reference cap, reading one above it and no more', async () => {
    const [company, job] = [randomUUID(), randomUUID()];
    const rooms = randomUUID();
    await seed(company, rooms, { jobId: job, state: 'editing', field: {} }, MAX_ROOMS + 1, 0);
    expect(await reader.readEditing(company, job, rooms)).toEqual({ outcome: 'too_many' });
    const photos = randomUUID();
    await seed(company, photos, { jobId: job, state: 'editing', field: {} }, 1, MAX_PHOTO_REFS + 1);
    expect(await reader.readEditing(company, job, photos)).toEqual({ outcome: 'too_many' });
    const full = randomUUID();
    await seed(company, full, { jobId: job, state: 'editing', field: {} }, MAX_ROOMS, MAX_PHOTO_REFS);
    const read = await reader.readEditing(company, job, full);
    expect(read.outcome).toBe('read');
    if (read.outcome === 'read') expect([read.manifest.rooms.length, read.manifest.photos.length]).toEqual([MAX_ROOMS, MAX_PHOTO_REFS]);
  });
});
