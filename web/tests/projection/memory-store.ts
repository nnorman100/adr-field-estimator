import { AccessStoreError, checkedUid, type AccessGrant, type AccessReader, type AccessStore } from '@/lib/projection/store';

// An in-memory stand-in for the Firestore access records, for tests that run where no Firestore
// emulator is (the database job). tests/projection/store-contract.ts holds it and the real
// Firestore store (tests/emu) to the same behaviour.

export type StoredAccess = { role: string; expiresAt: Date };

export type MemoryStore = AccessStore & AccessReader & {
  records: Map<string, StoredAccess>;
  headers: Map<string, { authTenantId: string }>;
  // The version of the decision last applied for each uid; it stays after a removal.
  versions: Map<string, number>;
  writes: number;
};

export const key = (companyId: string, uid: string) => `${companyId}/${uid}`;

export function memoryStore(): MemoryStore {
  const store: MemoryStore = {
    records: new Map(),
    headers: new Map(),
    versions: new Map(),
    writes: 0,
    async grant({ companyId, authTenantId, uid, role, expiresAt, version }: AccessGrant) {
      newest(companyId, checkedUid(uid), version);
      store.writes += 1;
      store.headers.set(companyId, { authTenantId });
      store.records.set(key(companyId, uid), { role, expiresAt: new Date(expiresAt) });
      store.versions.set(key(companyId, uid), version);
    },
    async remove(companyId: string, uid: string, version: number) {
      newest(companyId, checkedUid(uid), version);
      if (store.records.has(key(companyId, uid))) store.writes += 1;
      store.records.delete(key(companyId, uid));
      store.versions.set(key(companyId, uid), version);
      if (store.records.has(key(companyId, uid))) throw new AccessStoreError('record_still_present');
    },
    async expiry(companyId: string, uid: string) {
      const found = store.records.get(key(companyId, checkedUid(uid)));
      return found ? new Date(found.expiresAt) : null;
    },
  };
  function newest(companyId: string, uid: string, version: number) {
    if ((store.versions.get(key(companyId, uid)) ?? -1) > version) throw new AccessStoreError('stale_decision');
  }
  return store;
}
