import { randomUUID } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseProjectionConfig } from '@/lib/config';
import { firestoreAccessStore, firestoreFor } from '@/lib/projection/firestore';
import { createTenant, projectId, signIn, signUp, withSecondFactor } from './auth-emulator';
import { commit, createDoc, deleteDoc, getDoc, updateDoc, type Caller } from './rules/firestore-rest';

// The field rules (web/firestore.rules) on the draft states and field owners the draft sync writes
// (src/lib/jobs/draft-sync.ts; the sync itself is checked against the emulator in draft-sync.test.ts),
// with real Auth emulator tokens. An archived draft (the job's current one while the job is archived)
// refuses every client write and is open again once it is back to `editing`; nobody reaches another company's archived draft; the field owner the sync names
// is the only person who writes the draft, and a move refuses the phone that held it. Moved here from
// archive.test.ts and field-owner.test.ts, which tested the previous-version writers (draft life-cycle
// redesign, slice 7). The routes and the job rows are in tests/db/archive-api.test.ts and
// tests/db/office-jobs-field-owner.test.ts.

let db: Firestore;
let grants: ReturnType<typeof firestoreAccessStore>;

beforeAll(() => {
  const config = parseProjectionConfig({
    APP_ENV: 'local',
    GOOGLE_CLOUD_PROJECT: projectId,
    FIRESTORE_DATABASE_ID: '(default)',
    FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST,
  });
  db = firestoreFor(config);
  grants = firestoreAccessStore(db);
});

const DAY = 24 * 60 * 60 * 1000;
type Person = { uid: string; caller: Caller };

async function member(tenantId: string, company: string, role: 'owner' | 'estimator' | 'office'): Promise<Person> {
  const email = `${role}-${randomUUID().slice(0, 8)}@draft-rules.example.test`;
  const password = `synthetic-password-${role}`;
  const uid = await signUp(tenantId, email, password);
  await grants.grant({ companyId: company, authTenantId: tenantId, uid, role, expiresAt: new Date(Date.now() + DAY), version: 1 });
  // An owner or office user signs in with the authenticator app as the second step (D2).
  const idToken = await signIn(tenantId, email, password);
  return { uid, caller: { idToken: role === 'estimator' ? idToken : withSecondFactor(idToken) } };
}

const path = (company: string, draft: string) => `companies/${company}/drafts/${draft}`;

// A draft as the draft sync makes it (draft-lifecycle.ts, planSync): the job id, the field owner (none
// while nobody owns the field work), the state, the field map and the revisions it was written at.
const synced = (job: string, fieldOwnerUid: string | null, revisions = { archiveRevision: 1, fieldOwnerRevision: 0 }) => ({
  jobId: job,
  ...(fieldOwnerUid === null ? {} : { fieldOwnerUid }),
  state: 'editing',
  field: {},
  ...revisions,
});

// A company whose estimator owns a draft with a room and a photo reference: the draft as the sync makes
// it, then the phone's own writes under the rules.
async function company(name: string) {
  const tenant = await createTenant(`${name}-${randomUUID().slice(0, 6)}`);
  const id = randomUUID();
  const job = randomUUID();
  const draft = randomUUID();
  const estimator = await member(tenant, id, 'estimator');
  const owner = await member(tenant, id, 'owner');
  const office = await member(tenant, id, 'office');
  const at = path(id, draft);
  await db.doc(at).create(synced(job, estimator.uid));
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
  it('refuses every client write, and is open again once it is back to editing', async () => {
    const a = await company('archive-a');
    // The archive's sync puts the job's current draft `archived` at the job's new revision, with the field
    // work left as it was (an earlier submitted draft would stay `submitted`).
    await db.doc(a.at).update({ state: 'archived', archiveRevision: 2 });
    for (const who of [a.estimator, a.owner, a.office]) expect(await writes(who.caller, a.at)).toEqual([403, 403, 403, 403, 403, 403, 403]);
    // Nor may a client put the state or the revision back.
    expect(await updateDoc(a.estimator.caller, a.at, { state: 'editing' })).toBe(403);
    expect(await updateDoc(a.estimator.caller, a.at, { archiveRevision: 9 })).toBe(403);
    expect((await db.doc(`${a.at}/rooms/kitchen`).get()).data()).toEqual({ field: { name: 'Kitchen' } });
    // What the company may read stays readable (the phone shows it as archived).
    expect(await getDoc(a.estimator.caller, a.at)).toBe(200);
    expect(await getDoc(a.owner.caller, a.at)).toBe(200);

    // The restore's sync puts it back to `editing` at the next revision.
    await db.doc(a.at).update({ state: 'editing', archiveRevision: 3 });
    expect(await updateDoc(a.estimator.caller, a.at, { field: { notes: 'back at work', roomOrder: ['kitchen'] } })).toBe(200);
  });

  // Moved from archive.test.ts: an office job's archived draft names nobody, so no estimator of the
  // company reads it; the company owner and office still do, and nobody writes it.
  it('is read by no estimator when it names no field owner, and still by the company owner and office', async () => {
    const a = await company('archive-unowned');
    const at = path(a.id, randomUUID());
    await db.doc(at).create({ ...synced(a.job, null), state: 'archived', archiveRevision: 2 });
    expect(await getDoc(a.estimator.caller, at)).toBe(403);
    expect(await getDoc(a.owner.caller, at)).toBe(200);
    expect(await getDoc(a.office.caller, at)).toBe(200);
    for (const who of [a.estimator, a.owner, a.office]) expect(await writes(who.caller, at)).toEqual([403, 403, 403, 403, 403, 403, 403]);
  });

  it('is never reached by the other company, archived or not', async () => {
    const a = await company('archive-iso-a');
    const b = await company('archive-iso-b');
    await db.doc(a.at).update({ state: 'archived', archiveRevision: 2 });
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

describe('the field owner of a draft', () => {
  // An office user's job: an empty draft with no field owner (S5a-3), as the sync makes it.
  async function officeDraft(name: string) {
    const tenant = await createTenant(name);
    const company = randomUUID();
    const draft = randomUUID();
    const first = await member(tenant, company, 'estimator');
    const second = await member(tenant, company, 'estimator');
    const office = await member(tenant, company, 'office');
    await db.doc(path(company, draft)).create(synced(randomUUID(), null));
    return { company, draft, first, second, office };
  }

  it('is the only estimator who writes the draft once the sync names them, and a second estimator is refused', async () => {
    const { company, draft, first, second, office } = await officeDraft('field-owner-a');
    // Before anyone owns it, no estimator reads or writes it, and none can name themself its owner.
    for (const who of [first, second]) {
      expect(await getDoc(who.caller, path(company, draft))).toBe(403);
      expect(await updateDoc(who.caller, path(company, draft), { field: { notes: 'x' } })).toBe(403);
      expect(await updateDoc(who.caller, path(company, draft), { fieldOwnerUid: who.uid })).toBe(403);
    }
    // The first capture: the sync names the first estimator at the job's new coordination revision.
    await db.doc(path(company, draft)).update({ fieldOwnerUid: first.uid, fieldOwnerRevision: 1 });
    expect(await updateDoc(first.caller, path(company, draft), { field: { notes: 'wet carpet' } })).toBe(200);
    // The second estimator's later write is refused; office reads and never writes.
    expect(await getDoc(second.caller, path(company, draft))).toBe(403);
    expect(await updateDoc(second.caller, path(company, draft), { field: { notes: 'mine now' } })).toBe(403);
    expect(await getDoc(office.caller, path(company, draft))).toBe(200);
    expect(await updateDoc(office.caller, path(company, draft), { field: { notes: 'office' } })).toBe(403);
    // The owner keys are the server's: the field owner cannot hand them on or rewind them.
    expect(await updateDoc(first.caller, path(company, draft), { fieldOwnerUid: second.uid })).toBe(403);
    expect(await updateDoc(first.caller, path(company, draft), { fieldOwnerRevision: 99 })).toBe(403);
  });

  it('moves with the field work and refuses the phone that held it', async () => {
    const { company, draft, first, second } = await officeDraft('field-owner-b');
    await db.doc(path(company, draft)).update({ fieldOwnerUid: first.uid, fieldOwnerRevision: 1 });
    expect(await updateDoc(first.caller, path(company, draft), { field: { notes: 'before the move' } })).toBe(200);
    // The move's sync names the second estimator.
    await db.doc(path(company, draft)).update({ fieldOwnerUid: second.uid, fieldOwnerRevision: 2 });
    expect(await updateDoc(first.caller, path(company, draft), { field: { notes: 'unsent on the old phone' } })).toBe(403);
    expect(await getDoc(first.caller, path(company, draft))).toBe(403);
    expect(await updateDoc(second.caller, path(company, draft), { field: { notes: 'after the move' } })).toBe(200);
  });

  // Moved from field-owner.test.ts: the job id is the server's, and of the estimators only the field owner
  // reads a submitted draft (the company owner and office read every draft); nobody writes it.
  it('keeps the job id the server’s, and shows a submitted draft and its rooms to its field owner and to no other estimator', async () => {
    const { company, draft, first, second, office } = await officeDraft('field-owner-d');
    await db.doc(path(company, draft)).update({ fieldOwnerUid: first.uid, fieldOwnerRevision: 1 });
    expect(await updateDoc(first.caller, path(company, draft), { field: { notes: 'submitted notes' } })).toBe(200);
    expect(await createDoc(first.caller, `${path(company, draft)}/rooms/kitchen`, { field: { name: 'Kitchen' } })).toBe(200);
    expect(await updateDoc(first.caller, path(company, draft), { jobId: randomUUID() })).toBe(403);
    // Submit's marker, as the sync writes it.
    await db.doc(path(company, draft)).update({ state: 'submitted', fence: { submissionId: randomUUID(), epoch: randomUUID() } });
    expect(await getDoc(second.caller, path(company, draft))).toBe(403);
    expect(await getDoc(second.caller, `${path(company, draft)}/rooms/kitchen`)).toBe(403);
    expect(await getDoc(first.caller, path(company, draft))).toBe(200);
    expect(await getDoc(first.caller, `${path(company, draft)}/rooms/kitchen`)).toBe(200);
    expect(await getDoc(office.caller, path(company, draft))).toBe(200);
    expect(await updateDoc(first.caller, path(company, draft), { field: { notes: 'after Finish' } })).toBe(403);
  });
});

// Placeholders an earlier version's archive or restore left are still read (the app writes none), and a
// copy's first draft is the sync's too: the rules on both, moved from archive.test.ts. Reads are scoped
// by role: an estimator reads only the drafts that name them; the company owner and office read every one.
describe('a placeholder an earlier version left, and the draft the sync makes over it', () => {
  it('is read by no estimator and written by nobody while it is a placeholder, and the field owner writes the draft the sync replaces it with', async () => {
    const a = await company('placeholder-rules');
    const draft = randomUUID();
    const at = path(a.id, draft);
    await db.doc(at).create({ jobId: a.job, state: 'archived', placeholder: true, archiveRevision: 3 });
    expect(await getDoc(a.estimator.caller, at)).toBe(403);
    // The company owner and office read every draft of the company, a placeholder too, and write none.
    expect(await getDoc(a.owner.caller, at)).toBe(200);
    for (const who of [a.estimator, a.owner, a.office]) expect(await writes(who.caller, at)).toEqual([403, 403, 403, 403, 403, 403, 403]);
    // The sync makes the job's draft over it (it replaces the whole document), taking the revisions.
    await db.doc(at).set(synced(a.job, a.estimator.uid, { archiveRevision: 4, fieldOwnerRevision: 0 }));
    expect(await updateDoc(a.estimator.caller, at, { field: { notes: 'mine' } })).toBe(200);
  });

  it('opens a copy’s first draft, with its rooms, to the copier and to no other estimator', async () => {
    const tenant = await createTenant(`copy-${randomUUID().slice(0, 6)}`);
    const companyId = randomUUID();
    const estimator = await member(tenant, companyId, 'estimator');
    const other = await member(tenant, companyId, 'estimator');
    const at = path(companyId, randomUUID());
    const field = { roomOrder: ['kitchen'], notes: 'from the signed job' };
    await db.doc(at).create({ ...synced(randomUUID(), estimator.uid), field });
    await db.doc(`${at}/rooms/kitchen`).create({ field: { name: 'Kitchen', category: 2 } });
    expect(await updateDoc(estimator.caller, at, { field: { ...field, scopeConfirmed: true } })).toBe(200);
    expect(await updateDoc(estimator.caller, `${at}/rooms/kitchen`, { field: { name: 'Galley', category: 2 } })).toBe(200);
    expect(await getDoc(other.caller, at)).toBe(403);
    expect(await updateDoc(other.caller, at, { field: { notes: 'taken' } })).toBe(403);
  });
});
