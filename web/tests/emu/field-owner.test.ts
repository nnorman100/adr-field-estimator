import { randomUUID } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseProjectionConfig } from '@/lib/config';
import { firestoreDraftStore, type DraftStore } from '@/lib/jobs/drafts';
import { firestoreAccessStore, firestoreFor } from '@/lib/projection/firestore';
import { createTenant, projectId, signIn, signUp, withSecondFactor } from './auth-emulator';
import { getDoc, updateDoc } from './rules/firestore-rest';

// S5b-1: the field owner on a draft, set by the real firebase-admin writer in a Firestore
// transaction (src/lib/jobs/drafts.ts, setFieldOwner) against the emulator, then used the way the
// phone will, under web/firestore.rules with real Auth emulator tokens. The first capture on an
// office job makes the first estimator its field owner and a second estimator is refused (docs/spec.md
// 6.2); a move (owner decision J5) refuses the phone that held it. The routes and the job rows are in
// tests/db/office-jobs-api.test.ts.

let db: Firestore;
let drafts: DraftStore;
let grants: ReturnType<typeof firestoreAccessStore>;

beforeAll(() => {
  const config = parseProjectionConfig({
    APP_ENV: 'local',
    GOOGLE_CLOUD_PROJECT: projectId,
    FIRESTORE_DATABASE_ID: '(default)',
    FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST,
  });
  db = firestoreFor(config);
  drafts = firestoreDraftStore(db);
  grants = firestoreAccessStore(db);
});

const DAY = 24 * 60 * 60 * 1000;

async function member(tenantId: string, company: string, role: 'owner' | 'estimator' | 'office'): Promise<{ uid: string; caller: { idToken: string } }> {
  const email = `${role}-${randomUUID().slice(0, 8)}@field.example.test`;
  const password = `synthetic-password-${role}`;
  const uid = await signUp(tenantId, email, password);
  await grants.grant({ companyId: company, authTenantId: tenantId, uid, role, expiresAt: new Date(Date.now() + DAY), version: 1 });
  // An owner or office user signs in with the authenticator app as the second step (D2).
  const idToken = await signIn(tenantId, email, password);
  return { uid, caller: { idToken: role === 'estimator' ? idToken : withSecondFactor(idToken) } };
}

const path = (company: string, draft: string) => `companies/${company}/drafts/${draft}`;

async function officeDraft(name: string) {
  const tenant = await createTenant(name);
  const company = randomUUID();
  const draft = randomUUID();
  const first = await member(tenant, company, 'estimator');
  const second = await member(tenant, company, 'estimator');
  const office = await member(tenant, company, 'office');
  // An office user's job: an empty draft with no field owner (S5a-3).
  expect(await drafts.ensure(company, draft, null)).toBe('created');
  return { company, draft, first, second, office };
}

describe('the field owner of a draft', () => {
  it('makes the first estimator to capture the field owner, and refuses a second estimator’s field write', async () => {
    const { company, draft, first, second, office } = await officeDraft('field-owner-a');
    // Before anyone owns it, no estimator reads or writes it, and none can name themself its owner.
    for (const who of [first, second]) {
      expect(await getDoc(who.caller, path(company, draft))).toBe(403);
      expect(await updateDoc(who.caller, path(company, draft), { field: { notes: 'x' } })).toBe(403);
      expect(await updateDoc(who.caller, path(company, draft), { fieldOwnerUid: who.uid })).toBe(403);
    }

    expect(await drafts.setFieldOwner(company, draft, first.uid, 2)).toBe('set');
    expect((await db.doc(path(company, draft)).get()).data()).toEqual({ state: 'editing', field: {}, fieldOwnerUid: first.uid, fieldOwnerRevision: 2 });
    expect(await updateDoc(first.caller, path(company, draft), { field: { notes: 'wet carpet' } })).toBe(200);
    // The second estimator's later write is refused; office reads and never writes.
    expect(await getDoc(second.caller, path(company, draft))).toBe(403);
    expect(await updateDoc(second.caller, path(company, draft), { field: { notes: 'mine now' } })).toBe(403);
    expect(await getDoc(office.caller, path(company, draft))).toBe(200);
    expect(await updateDoc(office.caller, path(company, draft), { field: { notes: 'office' } })).toBe(403);
    // The owner keys are the server's: the field owner cannot hand them on or rewind them.
    expect(await updateDoc(first.caller, path(company, draft), { fieldOwnerUid: second.uid })).toBe(403);
    expect(await updateDoc(first.caller, path(company, draft), { fieldOwnerRevision: 99 })).toBe(403);
    // Asked again at the same revision, nothing changes.
    expect(await drafts.setFieldOwner(company, draft, first.uid, 2)).toBe('same');
    expect((await db.doc(path(company, draft)).get()).get('field')).toEqual({ notes: 'wet carpet' });
  });

  it('moves the field work and refuses the phone that held it, and never lets an older owner back', async () => {
    const { company, draft, first, second } = await officeDraft('field-owner-b');
    expect(await drafts.setFieldOwner(company, draft, first.uid, 2)).toBe('set');
    expect(await updateDoc(first.caller, path(company, draft), { field: { notes: 'before the move' } })).toBe(200);

    expect(await drafts.setFieldOwner(company, draft, second.uid, 3)).toBe('set');
    expect(await updateDoc(first.caller, path(company, draft), { field: { notes: 'unsent on the old phone' } })).toBe(403);
    expect(await getDoc(first.caller, path(company, draft))).toBe(403);
    expect(await updateDoc(second.caller, path(company, draft), { field: { notes: 'after the move' } })).toBe(200);
    // A slower request that read the job before the move changes nothing.
    expect(await drafts.setFieldOwner(company, draft, first.uid, 2)).toBe('newer');
    expect((await db.doc(path(company, draft)).get()).data()).toEqual({
      state: 'editing',
      field: { notes: 'after the move' },
      fieldOwnerUid: second.uid,
      fieldOwnerRevision: 3,
    });
  });

  it('settles two moves made at once on the newer one', async () => {
    const { company, draft, first, second } = await officeDraft('field-owner-c');
    const results = await Promise.all([drafts.setFieldOwner(company, draft, second.uid, 5), drafts.setFieldOwner(company, draft, first.uid, 4)]);
    expect(results.filter((result) => result === 'set').length).toBeGreaterThanOrEqual(1);
    const stored = (await db.doc(path(company, draft)).get()).data();
    expect(stored).toMatchObject({ fieldOwnerUid: second.uid, fieldOwnerRevision: 5 });
  });

  it('changes only the owner on a draft Submit has fenced, and makes no draft that is not there', async () => {
    const company = randomUUID();
    const draft = randomUUID();
    const fence = { submissionId: randomUUID(), epoch: 'epoch-1' };
    await db.doc(path(company, draft)).create({ fieldOwnerUid: 'uid-1', state: 'submitting', fence, field: { notes: 'as fenced' } });
    expect(await drafts.setFieldOwner(company, draft, 'uid-2', 7)).toBe('set');
    expect((await db.doc(path(company, draft)).get()).data()).toEqual({
      fieldOwnerUid: 'uid-2',
      fieldOwnerRevision: 7,
      state: 'submitting',
      fence,
      field: { notes: 'as fenced' },
    });
    const missing = randomUUID();
    expect(await drafts.setFieldOwner(company, missing, 'uid-2', 7)).toBe('missing');
    expect((await db.doc(path(company, missing)).get()).exists).toBe(false);
  });
});
