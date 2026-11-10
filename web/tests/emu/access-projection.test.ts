import { randomUUID } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseProjectionConfig } from '@/lib/config';
import { firestoreAccessStore, firestoreFor } from '@/lib/projection/firestore';
import type { AccessStore } from '@/lib/projection/store';
import { accessStoreContract } from '../projection/store-contract';
import { createTenant, projectId, signIn, signUp } from './auth-emulator';
import { getDoc, serverSet, updateDoc } from './rules/firestore-rest';

// The access records the server writes (S3-12), through the real firebase-admin store, against the
// Firestore emulator and web/firestore.rules, with real Auth emulator tokens. The outbox around the
// store runs against Postgres in tests/db/access-projection.test.ts.

let db: Firestore;
let store: AccessStore;

beforeAll(() => {
  const config = parseProjectionConfig({
    APP_ENV: 'local',
    GOOGLE_CLOUD_PROJECT: projectId,
    FIRESTORE_DATABASE_ID: '(default)',
    FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST,
  });
  db = firestoreFor(config);
  store = firestoreAccessStore(db);
});

accessStoreContract(
  'Firestore',
  () => ({
    store,
    async record(companyId, uid) {
      const snap = await db.doc(`companies/${companyId}/access/${uid}`).get();
      if (!snap.exists) return null;
      const data = snap.data()!;
      expect(Object.keys(data).sort()).toEqual(['expiresAt', 'role']);
      return { role: data.role as string, expiresAt: data.expiresAt.toDate() as Date };
    },
    async header(companyId) {
      const snap = await db.doc(`companies/${companyId}`).get();
      return snap.exists ? { authTenantId: snap.data()!.authTenantId as string } : null;
    },
  }),
  () => randomUUID(),
);

const DAY = 24 * 60 * 60 * 1000;

async function estimator(tenantId: string): Promise<{ uid: string; idToken: string }> {
  const email = `estimator-${randomUUID().slice(0, 8)}@field.example.test`;
  const password = 'synthetic-password-estimator';
  const uid = await signUp(tenantId, email, password);
  return { uid, idToken: await signIn(tenantId, email, password) };
}

describe('access records written by the server, checked by the rules', () => {
  it('a granted member edits their draft; once removed, their queued write is refused', async () => {
    const tenant = await createTenant('projection-a');
    const company = randomUUID();
    const member = await estimator(tenant);
    const caller = { idToken: member.idToken };
    const draft = `companies/${company}/drafts/d1`;
    await serverSet(draft, { fieldOwnerUid: member.uid, state: 'editing', field: { notes: 'wet carpet' } });

    // Before any grant there is no header and no record.
    expect(await updateDoc(caller, draft, { field: { notes: 'too early' } })).toBe(403);

    await store.grant({ companyId: company, authTenantId: tenant, uid: member.uid, role: 'estimator', expiresAt: new Date(Date.now() + 7 * DAY) });
    expect(await getDoc(caller, draft)).toBe(200);
    expect(await updateDoc(caller, draft, { field: { notes: 'wet carpet, dry wall' } })).toBe(200);

    await store.remove(company, member.uid);
    expect((await db.doc(`companies/${company}/access/${member.uid}`).get()).exists).toBe(false);
    // A write the phone queued while offline reaches the server after the removal, still with a
    // valid sign-in token. The rules read the record at that moment and refuse it.
    expect(await updateDoc(caller, draft, { field: { notes: 'queued offline' } })).toBe(403);
    expect(await getDoc(caller, draft)).toBe(403);
  });

  it('a record that has run out is refused, and the header names only the company tenant', async () => {
    const tenant = await createTenant('projection-b');
    const otherTenant = await createTenant('projection-c');
    const company = randomUUID();
    const member = await estimator(tenant);
    const outsider = await estimator(otherTenant);
    const draft = `companies/${company}/drafts/d1`;
    await serverSet(draft, { fieldOwnerUid: member.uid, state: 'editing', field: {} });

    await store.grant({ companyId: company, authTenantId: tenant, uid: member.uid, role: 'estimator', expiresAt: new Date(Date.now() - 1000) });
    expect(await updateDoc({ idToken: member.idToken }, draft, { field: { notes: 'expired' } })).toBe(403);

    // A user of another tenant, even with a record written under this company, fails the tenant check.
    await store.grant({ companyId: company, authTenantId: tenant, uid: outsider.uid, role: 'owner', expiresAt: new Date(Date.now() + DAY) });
    expect(await getDoc({ idToken: outsider.idToken }, draft)).toBe(403);
  });

  it('a client cannot write or remove its own access record', async () => {
    const tenant = await createTenant('projection-d');
    const company = randomUUID();
    const member = await estimator(tenant);
    await store.grant({ companyId: company, authTenantId: tenant, uid: member.uid, role: 'estimator', expiresAt: new Date(Date.now() + DAY) });
    const record = `companies/${company}/access/${member.uid}`;
    expect(await updateDoc({ idToken: member.idToken }, record, { role: 'owner' })).toBe(403);
    expect((await db.doc(record).get()).data()?.role).toBe('estimator');
  });
});

describe('a store write that lands late', () => {
  // A Firestore client whose transactions pause after their reads, just before they commit: a
  // write the outbox gave up on that is still on its way.
  function pausedBeforeCommit(gate: Promise<void>, paused: () => void): Firestore {
    return new Proxy(db, {
      get(target, property) {
        if (property === 'runTransaction') {
          return (work: (tx: unknown) => Promise<unknown>, options: unknown) =>
            target.runTransaction(async (tx) => {
              const result = await work(tx);
              paused();
              await gate;
              return result;
            }, options as never);
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  it('cannot bring back a record once its removal has succeeded', async () => {
    const company = randomUUID();
    const uid = `uid-${randomUUID().slice(0, 8)}`;
    const record = db.doc(`companies/${company}/access/${uid}`);
    await store.grant({ companyId: company, authTenantId: 't', uid, role: 'estimator', expiresAt: new Date(Date.now() + DAY) });

    let release!: () => void;
    let reachedCommit!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const atCommit = new Promise<void>((resolve) => (reachedCommit = resolve));
    const late = firestoreAccessStore(pausedBeforeCommit(gate, reachedCommit));

    // A renewal reads the record, then stalls before its commit.
    const renewal = late
      .grant({ companyId: company, authTenantId: 't', uid, role: 'estimator', expiresAt: new Date(Date.now() + 2 * DAY) })
      .then(
        () => 'committed' as const,
        () => 'refused' as const,
      );
    await atCommit;

    // Meanwhile the member is removed. While the stalled write can still land, the removal does
    // not succeed: Firestore holds it, then refuses it, and the outbox keeps its row waiting.
    const firstRemoval = await store.remove(company, uid).then(
      () => 'removed' as const,
      () => 'refused' as const,
    );
    release();
    expect(firstRemoval).toBe('refused');
    expect(['committed', 'refused']).toContain(await renewal);

    // The outbox's next try removes it, and nothing still on its way can undo that.
    await store.remove(company, uid);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await record.get()).exists).toBe(false);
  });
});
