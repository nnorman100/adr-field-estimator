import { randomUUID } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseProjectionConfig } from '@/lib/config';
import { MAX_PHOTO_REFS } from '@/lib/field/schema';
import { firestoreDraftStore } from '@/lib/jobs/drafts';
import { firestoreDraftStates, type DraftStates } from '@/lib/photos/drafts';
import { firestoreFor } from '@/lib/projection/firestore';
import { projectId } from './auth-emulator';

// The state of a job's field draft as the photo routes read it (S5a-5), by the real firebase-admin
// reader against the Firestore emulator. The route and its rules about a locked draft are in
// tests/db/photos-api.test.ts, over a stand-in for this reader.

let db: Firestore;
let states: DraftStates;

beforeAll(() => {
  const config = parseProjectionConfig({
    APP_ENV: 'local',
    GOOGLE_CLOUD_PROJECT: projectId,
    FIRESTORE_DATABASE_ID: '(default)',
    FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST,
  });
  db = firestoreFor(config);
  states = firestoreDraftStates(db);
});

const path = (company: string, draft: string) => `companies/${company}/drafts/${draft}`;

describe('the state of a draft', () => {
  it('is editing for the draft a job starts with, and whatever the server sets after', async () => {
    const company = randomUUID();
    const draft = randomUUID();
    await firestoreDraftStore(db).ensure(company, randomUUID(), draft, 'uid-1');
    expect(await states.state(company, draft)).toBe('editing');
    for (const state of ['submitting', 'submitted']) {
      await db.doc(path(company, draft)).update({ state });
      expect(await states.state(company, draft)).toBe(state);
    }
  });

  it('is null for a draft that does not exist, and only in the company asked for', async () => {
    const company = randomUUID();
    const draft = randomUUID();
    expect(await states.state(company, draft)).toBeNull();
    await firestoreDraftStore(db).ensure(company, randomUUID(), draft, 'uid-1');
    expect(await states.state(randomUUID(), draft)).toBeNull();
  });

  it('is empty, never editing, for a draft whose state is not text', async () => {
    const company = randomUUID();
    const draft = randomUUID();
    await db.doc(path(company, draft)).set({ state: 7, field: {} });
    expect(await states.state(company, draft)).toBe('');
    await db.doc(path(company, draft)).set({ field: {} });
    expect(await states.state(company, draft)).toBe('');
  });

  it('counts the photo references of the draft asked for, up to the cap and no further', async () => {
    const company = randomUUID();
    const draft = randomUUID();
    await firestoreDraftStore(db).ensure(company, randomUUID(), draft, 'uid-1');
    expect(await states.photoRefs(company, draft)).toBe(0);
    const add = async (count: number) => {
      const batch = db.batch();
      for (let i = 0; i < count; i++) batch.set(db.doc(`${path(company, draft)}/photos/${randomUUID()}`), { field: {} });
      await batch.commit();
    };
    await add(MAX_PHOTO_REFS - 1);
    expect(await states.photoRefs(company, draft)).toBe(MAX_PHOTO_REFS - 1);
    expect(await states.photoRefs(randomUUID(), draft)).toBe(0);
    await add(2);
    expect(await states.photoRefs(company, draft)).toBe(MAX_PHOTO_REFS);
  });
});
