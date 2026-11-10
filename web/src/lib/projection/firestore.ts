import { getApps, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';
import type { ProjectionConfig } from '@/lib/config';
import { AccessStoreError, checkedUid, type AccessStore } from './store';

// Access records in the field database, written with the Admin SDK, which the rules do not bind.
// Only ids, the role and the expiry are written; nothing here is logged.

function firebaseApp(config: ProjectionConfig): App {
  // firebase-admin reads FIRESTORE_EMULATOR_HOST from the process itself, so the checked config
  // must agree with what the SDK will see.
  if ((process.env.FIRESTORE_EMULATOR_HOST ?? null) !== config.firestoreEmulatorHost) {
    throw new Error('FIRESTORE_EMULATOR_HOST differs from the checked configuration');
  }
  const name = `dryscope-projection-${config.projectId}`;
  return getApps().find((app) => app.name === name) ?? initializeApp({ projectId: config.projectId }, name);
}

export function firestoreFor(config: ProjectionConfig): Firestore {
  return getFirestore(firebaseApp(config), config.databaseId);
}

export function firestoreAccessStore(db: Firestore): AccessStore {
  const company = (companyId: string) => db.collection('companies').doc(companyId);
  const access = (companyId: string, uid: string) => company(companyId).collection('access').doc(checkedUid(uid));

  // Each write runs as a transaction that reads the access record first and is tried once. Between
  // that read and the commit, Firestore lets no other write of the record commit: it holds it and
  // then refuses it. So a removal never succeeds while a grant that read the record earlier (one the
  // outbox gave up on at its deadline) can still land, and a refused removal stays waiting in the
  // outbox until it succeeds. maxAttempts 1 stops the SDK re-running a write against newer data.
  const once = { maxAttempts: 1 };

  return {
    async grant({ companyId, authTenantId, uid, role, expiresAt }) {
      const record = access(companyId, uid);
      await db.runTransaction(async (tx) => {
        await tx.get(record);
        // The header keeps any other server field; the access record is replaced whole.
        tx.set(company(companyId), { authTenantId }, { merge: true });
        tx.set(record, { role, expiresAt: Timestamp.fromDate(expiresAt) });
      }, once);
    },

    async remove(companyId, uid) {
      const record = access(companyId, uid);
      await db.runTransaction(async (tx) => {
        const before = await tx.get(record);
        if (before.exists) tx.delete(record);
      }, once);
      const after = await record.get();
      if (after.exists) throw new AccessStoreError('record_still_present');
    },
  };
}
