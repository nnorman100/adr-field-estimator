import { randomUUID } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseProjectionConfig } from '@/lib/config';
import { firestoreFor } from '@/lib/projection/firestore';
import { firestoreDraftMarks, type DraftMarks } from '@/lib/records-check/stores';
import { projectId } from './auth-emulator';

// S8-3: the records check's reader of the field drafts' marks (src/lib/records-check/stores.ts)
// against the emulator: the state and fence of named drafts, and the company's drafts paged by id.
// The check itself is in tests/db/records-check.test.ts, over a stand-in held to the same answers.

let db: Firestore;
let marks: DraftMarks;

beforeAll(() => {
  const config = parseProjectionConfig({
    APP_ENV: 'local',
    GOOGLE_CLOUD_PROJECT: projectId,
    FIRESTORE_DATABASE_ID: '(default)',
    FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST,
  });
  db = firestoreFor(config);
  marks = firestoreDraftMarks(db);
});

const draft = (company: string, id: string) => db.doc(`companies/${company}/drafts/${id}`);

describe('the draft marks reader', () => {
  it("reads each named draft's state and the submission its fence names, and leaves out a draft that is not there", async () => {
    const company = randomUUID();
    const [submitted, editing, archived, absent] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    const submission = randomUUID();
    await draft(company, submitted).set({
      state: 'submitted',
      fence: { submissionId: submission, epoch: randomUUID() },
      field: { notes: 'kept out' },
    });
    await draft(company, editing).set({ state: 'editing', field: {} });
    await draft(company, archived).set({
      state: 'archived',
      fence: { submissionId: submission, epoch: randomUUID() },
    });
    const found = await marks.marksOf(company, [submitted, editing, archived, absent]);
    expect(Object.fromEntries(found)).toEqual({
      [submitted]: { state: 'submitted', submissionId: submission },
      [editing]: { state: 'editing', submissionId: null },
      [archived]: { state: 'archived', submissionId: submission },
    });
    expect((await marks.marksOf(company, [])).size).toBe(0);
  });

  it("pages through one company's drafts in id order, after a cursor, and none of another company's", async () => {
    const company = randomUUID();
    const other = randomUUID();
    const ids = [randomUUID(), randomUUID(), randomUUID()].sort();
    for (const id of ids) await draft(company, id).set({ state: 'editing' });
    await draft(other, randomUUID()).set({ state: 'submitted' });
    const first = await marks.page(company, null, 2);
    expect(first).toEqual({
      drafts: ids.slice(0, 2).map((id) => ({ id, state: 'editing', submissionId: null })),
      more: true,
    });
    expect(await marks.page(company, ids[1]!, 2)).toEqual({
      drafts: [{ id: ids[2], state: 'editing', submissionId: null }],
      more: false,
    });
    expect(await marks.page(company, ids[2]!, 2)).toEqual({ drafts: [], more: false });
  });
});
