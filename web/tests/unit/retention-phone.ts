import type { Auth } from 'firebase/auth';
import type { BrowserSignInConfig } from '@/lib/config';
import type { FieldPerson } from '@/lib/field-db';
import type { DsMe } from '@/lib/field/ds-me';
import { forgetUnsent, noteWrite, readUnsent } from '@/lib/field/unsent';

// The phone the retention routine's tests run on (S6-3b; retention-machine.test.ts and
// retention-property.test.ts): real localStorage-shaped storage with the app's own marks in it, a
// list of saved sign-ins standing in for ds-me, and a set of people whose field database holds
// work. The test files mock ds-me, field-db and the window lock with what is built here, so a second
// tab (a second copy of the routine's modules) works on the same phone.

export const DAY = 24 * 60 * 60 * 1000;
export const START = Date.UTC(2026, 10, 14, 8, 0, 0);
export const config: BrowserSignInConfig = { apiKey: 'key', authDomain: 'example.test', projectId: 'demo-field', authEmulatorUrl: null, firestoreDatabaseId: 'field' };
export const keyOf = (person: { tenantId: string; uid: string }) => `${person.tenantId}/${person.uid}`;

export const phone = {
  items: new Map<string, string>(),
  rows: new Map<string, DsMe>(),
  work: new Set<string>(),
  // setItem throws (a full phone); removeItem and reads still answer.
  quota: false,
  // The field database cannot be cleared.
  discardFails: false,
  // A field window is open in another tab, which holds everyone's work.
  otherWindow: false,
  // This page is the field window and holds the one-window lock.
  ownsWindow: false,
  // ds-me cannot be read.
  rowsUnreadable: false,
  // What happens elsewhere while a removal has stopped the person's client and not yet erased.
  whileDiscarding: null as (() => void) | null,
  discards: [] as { person: string; lockHeld: boolean }[],
  // What happened, in order: 'removed <person>', 'forgot <person>' (the saved sign-in).
  log: [] as string[],
  reset() {
    this.items.clear();
    this.rows.clear();
    this.work.clear();
    this.discards.length = 0;
    this.log.length = 0;
    this.quota = this.discardFails = this.otherWindow = this.ownsWindow = this.rowsUnreadable = false;
    this.whileDiscarding = null;
  },
};

export const storage = {
  getItem: (key: string) => phone.items.get(key) ?? null,
  setItem(key: string, value: string) {
    if (phone.quota) throw new DOMException('full', 'QuotaExceededError');
    phone.items.set(key, value);
  },
  removeItem: (key: string) => void phone.items.delete(key),
  get length() {
    return phone.items.size;
  },
  key: (index: number) => [...phone.items.keys()][index] ?? null,
};

// ds-me as the phone holds it.
export function dsMe<T extends object>(original: T) {
  return {
    ...original,
    readAllMe: async () => (phone.rowsUnreadable ? [] : [...phone.rows.values()]),
    readMe: async (tenantId: string, uid: string) => phone.rows.get(keyOf({ tenantId, uid })) ?? null,
    // As src/lib/field/ds-me.ts: only the row the sign-out found goes.
    forgetMe: async (tenantId: string, uid: string, savedAt: number | null) => {
      const row = phone.rows.get(keyOf({ tenantId, uid })) ?? null;
      if ((row?.savedAt ?? null) !== savedAt) return false;
      phone.rows.delete(keyOf({ tenantId, uid }));
      phone.log.push(`forgot ${keyOf({ tenantId, uid })}`);
      return row;
    },
    saveMe: async () => true,
    restoreMe: async () => true,
  };
}

// field-db as the phone holds it: nothing goes while another window holds the work or the database
// cannot be cleared; once the client has stopped, `stillWanted` is asked right before anything is
// erased; otherwise the database and the person's mark go together.
export function fieldDb() {
  return {
    stopFieldClient: async () => undefined,
    discardFieldWork: async (person: FieldPerson, { lockHeld = false, stillWanted }: { lockHeld?: boolean; stillWanted?: () => boolean } = {}) => {
      phone.discards.push({ person: keyOf(person), lockHeld });
      // Clearing a database takes a while: anything not waiting for it runs first.
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
      if (phone.otherWindow && !lockHeld) return 'elsewhere';
      phone.whileDiscarding?.();
      if (stillWanted && !stillWanted()) return 'kept';
      if (phone.discardFails) return 'failed';
      phone.log.push(`removed ${keyOf(person)}`);
      phone.work.delete(keyOf(person));
      forgetUnsent(person.tenantId, person.uid);
      return 'discarded';
    },
  };
}

export const person = (tenantId: string, uid: string): FieldPerson => ({ tenantId, uid, config });
export const ana = person('t-a', 'ana');
export const ben = person('t-a', 'ben');
export const otherAna = person('t-b', 'ana');

export function saveRow(who: FieldPerson, role: string, authTime: number): void {
  phone.rows.set(keyOf(who), { ...who, companyName: 'Company', address: 'company', savedAt: authTime, role, authTime });
}
export function giveWork(who: FieldPerson, now: number): void {
  noteWrite(who.tenantId, who.uid, now);
  phone.work.add(keyOf(who));
}
export const lockOf = (who: FieldPerson) => {
  const mark = readUnsent(who.tenantId, who.uid);
  if (mark === 'unreadable' || mark.lockedSince === null) return null;
  return { since: mark.lockedSince, reason: mark.lockedReason };
};
export const authFor = (who: FieldPerson) =>
  ({ currentUser: { uid: who.uid, metadata: { lastSignInTime: 'Fri, 13 Nov 2026 09:00:00 GMT' } } }) as unknown as Auth;
