import { describe, expect, it } from 'vitest';
import { AccessStoreError, type AccessStore } from '@/lib/projection/store';

// The behaviour every access store must have. Run against the in-memory store in tests/db and the
// real Firestore store in tests/emu, so the database tests' stand-in cannot drift from Firestore.

export type StoreProbe = {
  store: AccessStore;
  // What the store holds now: the access record and the company header.
  record(companyId: string, uid: string): Promise<{ role: string; expiresAt: Date } | null>;
  header(companyId: string): Promise<{ authTenantId: string } | null>;
};

export function accessStoreContract(name: string, probe: () => StoreProbe, companyId: () => string): void {
  describe(`${name} access store contract`, () => {
    const later = new Date(Date.UTC(2031, 0, 2, 3, 4, 5));

    it('writes the header and the record, and the same grant twice leaves the same records', async () => {
      const { store, record, header } = probe();
      const company = companyId();
      const grant = { companyId: company, authTenantId: 'tenant-contract', uid: 'uid-1', role: 'estimator' as const, expiresAt: later };
      await store.grant(grant);
      await store.grant(grant);
      expect(await record(company, 'uid-1')).toEqual({ role: 'estimator', expiresAt: later });
      expect(await header(company)).toEqual({ authTenantId: 'tenant-contract' });
    });

    it('replaces the role and expiry of an existing record', async () => {
      const { store, record } = probe();
      const company = companyId();
      await store.grant({ companyId: company, authTenantId: 't', uid: 'uid-2', role: 'owner', expiresAt: later });
      const sooner = new Date(later.getTime() - 60_000);
      await store.grant({ companyId: company, authTenantId: 't', uid: 'uid-2', role: 'office', expiresAt: sooner });
      expect(await record(company, 'uid-2')).toEqual({ role: 'office', expiresAt: sooner });
    });

    it('removes a record, and removing one that is gone succeeds', async () => {
      const { store, record } = probe();
      const company = companyId();
      await store.grant({ companyId: company, authTenantId: 't', uid: 'uid-3', role: 'estimator', expiresAt: later });
      await store.remove(company, 'uid-3');
      expect(await record(company, 'uid-3')).toBeNull();
      await store.remove(company, 'uid-3');
      expect(await record(company, 'uid-3')).toBeNull();
    });

    it('keeps one uid apart from another and from another company', async () => {
      const { store, record } = probe();
      const a = companyId();
      const b = companyId();
      await store.grant({ companyId: a, authTenantId: 'ta', uid: 'uid-4', role: 'estimator', expiresAt: later });
      await store.grant({ companyId: b, authTenantId: 'tb', uid: 'uid-4', role: 'office', expiresAt: later });
      await store.remove(a, 'uid-4');
      expect(await record(a, 'uid-4')).toBeNull();
      expect(await record(b, 'uid-4')).toEqual({ role: 'office', expiresAt: later });
    });

    it('refuses a uid that would address another document', async () => {
      const { store } = probe();
      const company = companyId();
      for (const uid of ['a/b', '.', '..', '__x__', '', 'x'.repeat(129)]) {
        await expect(
          store.grant({ companyId: company, authTenantId: 't', uid, role: 'owner', expiresAt: later }),
        ).rejects.toBeInstanceOf(AccessStoreError);
        await expect(store.remove(company, uid)).rejects.toBeInstanceOf(AccessStoreError);
      }
    });
  });
}
