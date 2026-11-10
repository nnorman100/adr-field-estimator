import { AccessStoreError, checkedUid, type AccessGrant, type AccessStore } from '@/lib/projection/store';

// An in-memory stand-in for the Firestore access records, for tests that run where no Firestore
// emulator is (the database job). tests/projection/store-contract.ts holds it and the real
// Firestore store (tests/emu) to the same behaviour.

export type StoredAccess = { role: string; expiresAt: Date };

export type MemoryStore = AccessStore & {
  records: Map<string, StoredAccess>;
  headers: Map<string, { authTenantId: string }>;
  writes: number;
};

export const key = (companyId: string, uid: string) => `${companyId}/${uid}`;

export function memoryStore(): MemoryStore {
  const store: MemoryStore = {
    records: new Map(),
    headers: new Map(),
    writes: 0,
    async grant({ companyId, authTenantId, uid, role, expiresAt }: AccessGrant) {
      checkedUid(uid);
      store.writes += 1;
      store.headers.set(companyId, { authTenantId });
      store.records.set(key(companyId, uid), { role, expiresAt: new Date(expiresAt) });
    },
    async remove(companyId: string, uid: string) {
      checkedUid(uid);
      if (store.records.has(key(companyId, uid))) store.writes += 1;
      store.records.delete(key(companyId, uid));
      if (store.records.has(key(companyId, uid))) throw new AccessStoreError('record_still_present');
    },
  };
  return store;
}
