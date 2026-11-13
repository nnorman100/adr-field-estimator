import type { Role } from '@/lib/access';

// Where access records live: Firestore in the app (firestore.ts), an in-memory copy in tests.
// The records are the ones web/firestore.rules reads:
// - companies/{companyId}: the company header, `authTenantId` = the company's sign-in tenant.
// - companies/{companyId}/access/{uid}: `role` and `expiresAt`; the rules refuse it after that time.
// Beside them the server keeps companies/{companyId}/accessVersions/{uid}: `version`, the decision
// that last wrote or removed the record. No rule names it, so no client reads or writes it, and it
// stays after a removal deletes the access record.

export type AccessGrant = {
  companyId: string;
  authTenantId: string;
  uid: string;
  role: Role;
  expiresAt: Date;
  // Which decision this is; a later decision has a higher version (outbox.ts).
  version: number;
};

// Both calls refuse a decision older than the one the store already applied for that uid
// (`stale_decision`), so a write that arrives late can neither bring back a removed record nor
// remove a newer grant.
export type AccessStore = {
  // Writes the company header and the access record together. Writing the same grant twice
  // leaves the same records.
  grant(grant: AccessGrant): Promise<void>;
  // Removes the access record and resolves only once a read shows it is gone. Removing a record
  // that is already gone succeeds.
  remove(companyId: string, uid: string, version: number): Promise<void>;
};

// Reads one record's expiry: when the uid's access record stops working, or null when there is
// none. GET /api/me returns it (S6-3), so a phone opens its sync gate only on a record that works
// now: a renewal can be skipped (a busy actor, a row in back-off), and a 200 alone proves nothing
// about the record.
export type AccessReader = {
  expiry(companyId: string, uid: string): Promise<Date | null>;
};

// Firestore document ids cannot hold a slash, be `.` or `..`, or match __.*__; a uid that could
// address another document is refused rather than written.
const DOCUMENT_ID = /^(?!\.\.?$)(?!__.*__$)[^/]{1,128}$/;

export class AccessStoreError extends Error {
  constructor(readonly code: 'invalid_uid' | 'record_still_present' | 'stale_decision') {
    super(`Access record not written: ${code}`);
    this.name = 'AccessStoreError';
  }
}

export function checkedUid(uid: string): string {
  if (!DOCUMENT_ID.test(uid)) throw new AccessStoreError('invalid_uid');
  return uid;
}
