import type { BrowserSignInConfig } from '@/lib/config';
import { connectionLost, ReopenTheApp, transact, withDatabase, type DbSpec } from './idb';

// `ds-me`: what the field shell needs to start with no signal (S6-2; docs/plans/S6.md section 3).
// The sign-in page writes one row at every online sign-in, and the shell reads the newest row
// before it asks the network for anything. A page the server renders per request cannot open
// offline, so the shell has nothing of the server's to start from but this.
//
// A row holds the browser settings of the company's sign-in (public values every visitor's browser
// receives anyway), the tenant, the signed-in person's id, the company's name and its sign-in
// address. No email, no token. Rows are keyed by (tenant id, uid), because several companies share
// one origin and one person's phone can hold two companies' sign-ins. S6-3 adds what the server
// said at the last online check (company id, role, capabilities) and when the person signed in, so
// the shell can stand in for the server offline until the role's session limit (D7).
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
  // From S6-3, each written at an online check; absent on a row written before it.
  companyId?: string;
  role?: string;
  capabilities?: string[];
  // The person's id in the company (GET /api/me `actor.id`), saved with the facts above; absent on a
  // row written before S5b-1.
  actorId?: string;
  // When the person signed in (the ID token's auth_time), in milliseconds since 1970.
  authTime?: number;
};

export const meKey = (tenantId: string, uid: string): string => `${tenantId}/${uid}`;

// Opened through the app's one IndexedDB wrapper (./idb.ts): it closes the connection on a version
// change and tries a lost connection once more.
const ME_SPEC: DbSpec = {
  name: ME_DB,
  version: ME_DB_VERSION,
  upgrade: (db) => {
    db.createObjectStore(ME_STORE, { keyPath: 'key' });
  },
};

// A storage request that failed for a reason other than a lost connection.
class MeWorkFailed extends Error {}

// One transaction on ds-me through the wrapper: a lost connection is tried once more, a second
// loss is ReopenTheApp. A failed open rejects with the open's own error, a failed transaction with
// MeWorkFailed, so each caller below keeps its own answer for each.
function onMe<T>(mode: IDBTransactionMode, use: (store: IDBObjectStore, transaction: IDBTransaction) => () => T, opened?: () => boolean): Promise<T> {
  return withDatabase(ME_SPEC, (db) => {
    if (opened && !opened()) return Promise.reject(new MeWorkFailed());
    return transact(db, ME_STORE, mode, (transaction) => use(transaction.objectStore(ME_STORE), transaction)).catch((error: unknown) => {
      throw connectionLost(error) ? error : new MeWorkFailed();
    });
  });
}

// What a call answers when its storage did not: the open failed, the work failed, or the
// connection was lost twice.
function failure(error: unknown): 'open' | 'work' | 'reopen' {
  if (error instanceof ReopenTheApp) return 'reopen';
  return error instanceof MeWorkFailed ? 'work' : 'open';
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
    !isString(config.projectId) ||
    (row.companyId !== undefined && !isString(row.companyId)) ||
    (row.role !== undefined && !isString(row.role)) ||
    (row.actorId !== undefined && !isString(row.actorId)) ||
    (row.capabilities !== undefined &&
      !(Array.isArray(row.capabilities) && row.capabilities.every((item) => typeof item === 'string'))) ||
    (row.authTime !== undefined && !(typeof row.authTime === 'number' && Number.isFinite(row.authTime)))
  ) {
    return null;
  }
  return row as unknown as DsMe;
}

// The newest row, null when there is none (or none readable), 'unavailable' when the phone's
// storage cannot be opened at all, and 'reopen' when its connection was lost twice (the shell says
// "Reopen the app").
export async function readLatestMe(): Promise<DsMe | null | 'unavailable' | 'reopen'> {
  try {
    const rows = await onMe('readonly', (store) => {
      const request = store.getAll();
      return () => request.result as unknown[];
    });
    const mine = rows.map(parseMe).filter((row): row is DsMe => row !== null);
    mine.sort((a, b) => b.savedAt - a.savedAt);
    return mine[0] ?? null;
  } catch (error) {
    return failure(error) === 'reopen' ? 'reopen' : 'unavailable';
  }
}

// This (tenant, person)'s row; null when there is none, or the storage cannot be opened at all (the
// shell cannot start from it either); false when it cannot be read or does not answer within
// WRITE_WITHIN_MS, so the row may be there.
export function readMe(tenantId: string, uid: string): Promise<DsMe | null | false> {
  const read = onMe('readonly', (store) => {
    const request = store.get(meKey(tenantId, uid));
    return () => parseMe(request.result);
  }).catch((error: unknown) => (failure(error) === 'open' ? null : false));
  return within(read, false);
}

// Every readable row, for judging each saved sign-in's age (retention.ts). None when the phone's
// storage cannot be read or does not answer within WRITE_WITHIN_MS: a row that cannot be read is
// never judged.
export function readAllMe(): Promise<DsMe[]> {
  const read = onMe('readonly', (store) => {
    const request = store.getAll();
    return () => (request.result as unknown[]).map(parseMe).filter((row): row is DsMe => row !== null);
  }).catch(() => [] as DsMe[]);
  return within(read, [] as DsMe[]);
}

// `promise`, or `otherwise` when the storage does not answer within WRITE_WITHIN_MS.
function within<T>(promise: Promise<T>, otherwise: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<T>((resolve) => (timer = setTimeout(() => resolve(otherwise), WRITE_WITHIN_MS)))]).finally(() => clearTimeout(timer));
}

// A change to the rows, settled when the transaction has committed (not when its request was
// accepted: a page that navigates away first loses it) or has failed. True when it committed. A
// phone whose storage does not answer within WRITE_WITHIN_MS gets false, and false is final: the
// change is aborted, or never made if the database opens later.
const WRITE_WITHIN_MS = 3_000;

function write(change: (store: IDBObjectStore) => void): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let transaction: IDBTransaction | null = null;
    const finish = (committed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(committed);
    };
    const timer = setTimeout(() => {
      try {
        transaction?.abort();
      } catch {
        return;
      }
      finish(false);
    }, WRITE_WITHIN_MS);
    // An open that answers after the time ran out starts no change.
    onMe(
      'readwrite',
      (store, started) => {
        transaction = started;
        change(store);
        return () => true;
      },
      () => !settled,
    ).then(finish, () => finish(false));
  });
}

// Whether the row at `key` may still be there: true when it is, when the read fails and when the
// storage does not answer within WRITE_WITHIN_MS; false when it is not, or when the storage cannot
// be opened at all (the shell then cannot start from it either).
function mayHold(key: string): Promise<boolean> {
  const counted = onMe('readonly', (store) => {
    const request = store.count(key);
    return () => request.result > 0;
  }).catch((error: unknown) => failure(error) !== 'open');
  return within(counted, true);
}

// Writes this sign-in's row over the same (tenant, person)'s earlier one, in one transaction:
// what `me` leaves out (a fact this answer did not carry) keeps its saved value. With `onlyIfThere`
// a row that is gone stays gone, so a sign-out that removed it is never undone. False when nothing
// was saved; the sign-in itself is not affected.
function merge(me: Omit<DsMe, 'savedAt'>, onlyIfThere: boolean): Promise<boolean> {
  let saved = false;
  return write((store) => {
    const key = meKey(me.tenantId, me.uid);
    const row = store.get(key);
    row.onsuccess = () => {
      const before = parseMe(row.result);
      if (onlyIfThere && !before) return;
      const given = Object.fromEntries(Object.entries(me).filter(([, value]) => value !== undefined));
      store.put({ ...before, ...given, key, savedAt: Date.now() });
      saved = true;
    };
  }).then((committed) => committed && saved);
}

export function saveMe(me: Omit<DsMe, 'savedAt'>): Promise<boolean> {
  return merge(me, false);
}

export function updateMe(me: Omit<DsMe, 'savedAt'>): Promise<boolean> {
  return merge(me, true);
}

// Removes this sign-in's row (the phone is signed out of this company). Only this (tenant, person)'s
// row: another company's stays. `savedAt` is that of the row the sign-out found (null: none), and
// only that row goes: one saved since, by a newer sign-in, stays. Resolves to the row it removed
// (null when there was none, or the phone's storage cannot be opened at all), or false when a row
// may still be there.
export async function forgetMe(tenantId: string, uid: string, savedAt: number | null): Promise<DsMe | null | false> {
  const key = meKey(tenantId, uid);
  let removed: unknown = null;
  let newer = false;
  const gone = await write((store) => {
    const row = store.get(key);
    row.onsuccess = () => {
      if ((parseMe(row.result)?.savedAt ?? null) !== savedAt) {
        newer = true;
        return;
      }
      removed = row.result;
      store.delete(key);
    };
  });
  if (newer) return false;
  if (gone) return parseMe(removed);
  return (await mayHold(key)) ? false : null;
}

// Puts back a row forgetMe removed, when the sign-out it was part of failed, unless a newer
// sign-in has saved one since. True when it was put back.
export function restoreMe(me: DsMe): Promise<boolean> {
  let saved = false;
  return write((store) => {
    const key = meKey(me.tenantId, me.uid);
    const row = store.get(key);
    row.onsuccess = () => {
      if (parseMe(row.result)) return;
      store.put({ ...me, key });
      saved = true;
    };
  }).then((committed) => committed && saved);
}
