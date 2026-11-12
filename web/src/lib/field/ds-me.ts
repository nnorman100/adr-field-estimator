import type { BrowserSignInConfig } from '@/lib/config';

// `ds-me`: what the field shell needs to start with no signal (S6-2; docs/plans/S6.md section 3).
// The sign-in page writes one row at every online sign-in, and the shell reads the newest row
// before it asks the network for anything. A page the server renders per request cannot open
// offline, so the shell has nothing of the server's to start from but this.
//
// A row holds the browser settings of the company's sign-in (public values every visitor's browser
// receives anyway), the tenant, the signed-in person's id, the company's name and its sign-in
// address. No email, no token. Rows are keyed by (tenant id, uid), because several companies share
// one origin and one person's phone can hold two companies' sign-ins. S6-3 adds the role and the
// capabilities to the same row.
//
// IndexedDB can be missing or blocked (a private window, a full disk). Every call here then
// answers "not saved" instead of throwing, and the shell says so ("Not saved on this phone").

export const ME_DB = 'ds-me';
export const ME_STORE = 'me';
export const ME_DB_VERSION = 1;

export type DsMe = {
  tenantId: string;
  uid: string;
  companyName: string;
  address: string;
  config: BrowserSignInConfig;
  // Milliseconds since 1970 of the sign-in that wrote the row; the newest row wins.
  savedAt: number;
};

export const meKey = (tenantId: string, uid: string): string => `${tenantId}/${uid}`;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    try {
      const request = indexedDB.open(ME_DB, ME_DB_VERSION);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(ME_STORE, { keyPath: 'key' });
      };
      request.onsuccess = () => {
        const db = request.result;
        // An upgrade in another window must never wait for this one (a trap in the old app).
        db.onversionchange = () => db.close();
        resolve(db);
      };
      request.onerror = () => reject(request.error ?? new Error('ds-me could not be opened'));
      request.onblocked = () => reject(new Error('ds-me is blocked'));
    } catch (error) {
      reject(error instanceof Error ? error : new Error('ds-me could not be opened'));
    }
  });
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('ds-me request failed'));
  });
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

// A row of the shape this code writes, or null. A damaged or foreign row is skipped, never trusted.
export function parseMe(value: unknown): DsMe | null {
  if (value === null || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const config = row.config as Record<string, unknown> | null | undefined;
  if (
    !isString(row.tenantId) ||
    !isString(row.uid) ||
    !isString(row.companyName) ||
    !isString(row.address) ||
    typeof row.savedAt !== 'number' ||
    config === null ||
    typeof config !== 'object' ||
    !isString(config.apiKey) ||
    !isString(config.authDomain) ||
    !isString(config.projectId)
  ) {
    return null;
  }
  return row as unknown as DsMe;
}

// The newest row, null when there is none (or none readable), and 'unavailable' when the phone's
// storage cannot be opened at all.
export async function readLatestMe(): Promise<DsMe | null | 'unavailable'> {
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return 'unavailable';
  }
  try {
    const rows = (await done(db.transaction(ME_STORE, 'readonly').objectStore(ME_STORE).getAll())) as unknown[];
    const mine = rows.map(parseMe).filter((row): row is DsMe => row !== null);
    mine.sort((a, b) => b.savedAt - a.savedAt);
    return mine[0] ?? null;
  } catch {
    return 'unavailable';
  } finally {
    db.close();
  }
}

// A change to the rows, settled when the transaction has committed (not when its request was
// accepted: a page that navigates away first loses it) or has failed. True when it committed. A
// phone whose storage never answers is not waited on for longer than WRITE_WITHIN_MS.
const WRITE_WITHIN_MS = 3_000;

async function commit(change: (store: IDBObjectStore) => void): Promise<boolean> {
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return false;
  }
  try {
    const transaction = db.transaction(ME_STORE, 'readwrite');
    change(transaction.objectStore(ME_STORE));
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('ds-me write failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('ds-me write aborted'));
    });
    return true;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

async function write(change: (store: IDBObjectStore) => void): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), WRITE_WITHIN_MS);
  });
  try {
    return await Promise.race([commit(change), late]);
  } finally {
    clearTimeout(timer);
  }
}

// Saves this sign-in's row, replacing the same (tenant, person)'s earlier one. False when it could
// not be saved; the sign-in itself is not affected.
export function saveMe(me: Omit<DsMe, 'savedAt'>): Promise<boolean> {
  return write((store) => store.put({ key: meKey(me.tenantId, me.uid), ...me, savedAt: Date.now() }));
}

// Removes this sign-in's row (the phone is signed out of this company). Only this (tenant, person)'s
// row: another company's stays.
export function forgetMe(tenantId: string, uid: string): Promise<boolean> {
  return write((store) => store.delete(meKey(tenantId, uid)));
}
