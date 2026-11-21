import { randomUUID } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseProjectionConfig } from '@/lib/config';
import { firestoreAccessStore, firestoreFor } from '@/lib/projection/firestore';
import { createTenant, projectId, signIn, signUp, withSecondFactor } from './auth-emulator';
import { commit, createDoc, deleteDoc, getDoc, updateDoc, type Caller } from './rules/firestore-rest';

// The field rules (web/firestore.rules) on the draft states and field owners the draft sync writes
// (src/lib/jobs/draft-sync.ts; the sync itself is checked against the emulator in draft-sync.test.ts),
// with real Auth emulator tokens. An archived draft refuses every client write and is open again once it
// is back to `editing`; nobody reaches another company's archived draft; the field owner the sync names
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
  await db.doc(at).create({ jobId: job, fieldOwnerUid: estimator.uid, state: 'editing', field: {} });
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
    // The sync archives the job's drafts: `archived`, with the field work left as it was.
    await db.doc(a.at).update({ state: 'archived' });
    for (const who of [a.estimator, a.owner, a.office]) expect(await writes(who.caller, a.at)).toEqual([403, 403, 403, 403, 403, 403, 403]);
    // Nor may a client put the state or the revision back.
    expect(await updateDoc(a.estimator.caller, a.at, { state: 'editing' })).toBe(403);
    expect(await updateDoc(a.estimator.caller, a.at, { archiveRevision: 9 })).toBe(403);
    expect((await db.doc(`${a.at}/rooms/kitchen`).get()).data()).toEqual({ field: { name: 'Kitchen' } });
    // What the company may read stays readable (the phone shows it as archived).
    expect(await getDoc(a.estimator.caller, a.at)).toBe(200);
    expect(await getDoc(a.owner.caller, a.at)).toBe(200);

    // The restore's sync puts it back to `editing`.
    await db.doc(a.at).update({ state: 'editing' });
    expect(await updateDoc(a.estimator.caller, a.at, { field: { notes: 'back at work', roomOrder: ['kitchen'] } })).toBe(200);
  });

  it('is never reached by the other company, archived or not', async () => {
    const a = await company('archive-iso-a');
    const b = await company('archive-iso-b');
    await db.doc(a.at).update({ state: 'archived' });
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
    await db.doc(path(company, draft)).create({ jobId: randomUUID(), state: 'editing', field: {} });
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
    // The first capture: the sync names the first estimator.
    await db.doc(path(company, draft)).update({ fieldOwnerUid: first.uid });
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
    await db.doc(path(company, draft)).update({ fieldOwnerUid: first.uid });
    expect(await updateDoc(first.caller, path(company, draft), { field: { notes: 'before the move' } })).toBe(200);
    // The move's sync names the second estimator.
    await db.doc(path(company, draft)).update({ fieldOwnerUid: second.uid });
    expect(await updateDoc(first.caller, path(company, draft), { field: { notes: 'unsent on the old phone' } })).toBe(403);
    expect(await getDoc(first.caller, path(company, draft))).toBe(403);
    expect(await updateDoc(second.caller, path(company, draft), { field: { notes: 'after the move' } })).toBe(200);
  });
});
