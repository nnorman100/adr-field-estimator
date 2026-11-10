import type { Role } from '@/lib/access';

// Where access records live: Firestore in the app (firestore.ts), an in-memory copy in tests.
// The records are the ones web/firestore.rules reads:
// - companies/{companyId}: the company header, `authTenantId` = the company's sign-in tenant.
// - companies/{companyId}/access/{uid}: `role` and `expiresAt`; the rules refuse it after that time.

export type AccessGrant = {
  companyId: string;
  authTenantId: string;
  uid: string;
  role: Role;
  expiresAt: Date;
};

export type AccessStore = {
  // Writes the company header and the access record together. Writing the same grant twice
  // leaves the same records.
  grant(grant: AccessGrant): Promise<void>;
  // Removes the access record and resolves only once a read shows it is gone. Removing a record
  // that is already gone succeeds.
  remove(companyId: string, uid: string): Promise<void>;
};

// Firestore document ids cannot hold a slash, be `.` or `..`, or match __.*__; a uid that could
// address another document is refused rather than written.
const DOCUMENT_ID = /^(?!\.\.?$)(?!__.*__$)[^/]{1,128}$/;

export class AccessStoreError extends Error {
  constructor(readonly code: 'invalid_uid' | 'record_still_present') {
    super(`Access record not written: ${code}`);
    this.name = 'AccessStoreError';
  }
}

export function checkedUid(uid: string): string {
  if (!DOCUMENT_ID.test(uid)) throw new AccessStoreError('invalid_uid');
  return uid;
}
