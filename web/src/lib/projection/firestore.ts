import { getApps, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, Timestamp, type Firestore, type Transaction } from 'firebase-admin/firestore';
import type { ProjectionConfig } from '@/lib/config';
import { firestoreSpan } from '@/lib/telemetry/spans';
import { AccessStoreError, checkedUid, type AccessReader, type AccessStore } from './store';

// Access records in the field database, written with the Admin SDK, which the rules do not bind.
// Only ids, the role, the expiry and the decision version are written; nothing here is logged.

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

export function firestoreAccessStore(db: Firestore): AccessStore & AccessReader {
  const company = (companyId: string) => db.collection('companies').doc(companyId);
  const access = (companyId: string, uid: string) => company(companyId).collection('access').doc(checkedUid(uid));
  const applied = (companyId: string, uid: string) =>
    company(companyId).collection('accessVersions').doc(checkedUid(uid));

  // Each write is a transaction that reads the version last applied for the uid and refuses an
  // older decision, then writes its own version with the record. Firestore commits no transaction
  // whose read changed before it committed, so two decisions cannot both pass the check against the
  // same version, and a re-run (the SDK retries a contended transaction) checks again.
  async function newest(tx: Transaction, companyId: string, uid: string, version: number): Promise<void> {
    const stored = (await tx.get(applied(companyId, uid))).get('version');
    if (typeof stored === 'number' && stored > version) throw new AccessStoreError('stale_decision');
  }

  return {
    async grant({ companyId, authTenantId, uid, role, expiresAt, version }) {
      await firestoreSpan('runTransaction', 'access', () =>
        db.runTransaction(async (tx) => {
          await newest(tx, companyId, uid, version);
          // The header keeps any other server field; the access record is replaced whole.
          tx.set(company(companyId), { authTenantId }, { merge: true });
          tx.set(access(companyId, uid), { role, expiresAt: Timestamp.fromDate(expiresAt) });
          tx.set(applied(companyId, uid), { version });
        }),
      );
    },

    async remove(companyId, uid, version) {
      const record = access(companyId, uid);
      await firestoreSpan('runTransaction', 'access', () =>
        db.runTransaction(async (tx) => {
          await newest(tx, companyId, uid, version);
          tx.delete(record);
          tx.set(applied(companyId, uid), { version });
        }),
      );
      const after = await firestoreSpan('get', 'access', () => record.get());
      if (after.exists) throw new AccessStoreError('record_still_present');
    },

    async expiry(companyId, uid) {
      const snapshot = await firestoreSpan('get', 'access', () => access(companyId, uid).get());
      const expiresAt: unknown = snapshot.get('expiresAt');
      return snapshot.exists && expiresAt instanceof Timestamp ? expiresAt.toDate() : null;
    },
  };
}
