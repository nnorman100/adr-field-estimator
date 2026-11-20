import type { z } from 'zod';
import { itemListResponseSchema } from '@/lib/prices/item-list';
import { readMe } from './ds-me';
import { transact, withDatabase, type DbSpec } from './idb';

export type ItemList = NonNullable<z.infer<typeof itemListResponseSchema>['current']>;
type Person = { tenantId: string; uid: string };
type ListOwner = Person & { companyId: string };
// What a phone knows of one company's published list: null when it never asked, `{ list: null }`
// when the server last said the company has none.
export type SavedList = { list: ItemList | null } | null;

// Stored in the version part of the key for a confirmed "no published list". It is no UUID, so it
// never matches a version id.
const NONE = 'none';

const STORE = 'item-lists';
const SPEC: DbSpec = {
  name: 'ds-prices',
  version: 1,
  upgrade: (db) => {
    db.createObjectStore(STORE, { keyPath: ['tenantId', 'uid', 'companyId', 'versionId'] });
  },
};

function range({ tenantId, uid }: Person, companyId?: string): IDBKeyRange {
  const prefix = companyId === undefined ? [tenantId, uid] : [tenantId, uid, companyId];
  // The remaining key parts are strings. In IndexedDB key order an array sorts after every string.
  return IDBKeyRange.bound(prefix, [...prefix, []]);
}

function within<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error('The item list storage did not answer.'));
    }, 5_000);
    Promise.resolve().then(() => work(controller.signal)).then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function onLists<T>(
  mode: IDBTransactionMode,
  signal: AbortSignal,
  change: (store: IDBObjectStore) => () => T,
): Promise<T> {
  let openTransaction: IDBTransaction | undefined;
  const abort = () => {
    try {
      openTransaction?.abort();
    } catch {
      // The transaction already finished.
    }
  };
  signal.addEventListener('abort', abort);
  return withDatabase(SPEC, (db) => {
    signal.throwIfAborted();
    return transact(db, STORE, mode, (transaction) => {
      openTransaction = transaction;
      return change(transaction.objectStore(STORE));
    });
  }).finally(() => signal.removeEventListener('abort', abort));
}

function changing<T>({ tenantId, uid }: Person, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  // Serialize sign-out and writes for this pair, including when the sign-in page is in another tab.
  const lock = JSON.stringify(['ds-prices', tenantId, uid]);
  return within(async (signal) => {
    if (navigator.locks) return await navigator.locks.request(lock, { signal }, () => work(signal));
    return work(signal);
  });
}

export function readItemList(owner: ListOwner): Promise<SavedList> {
  return within((signal) => onLists('readonly', signal, (store) => {
    const request = store.get(range(owner, owner.companyId));
    return () => {
      const row = request.result as { versionId?: unknown; list?: unknown } | undefined;
      if (!row) return null;
      if (row.versionId === NONE) return { list: null };
      const parsed = itemListResponseSchema.safeParse({ current: row.list });
      return parsed.success && parsed.data.current ? { list: parsed.data.current } : null;
    };
  }));
}

export function replaceItemList(owner: ListOwner, list: ItemList | null, authTime: number, active: () => boolean): Promise<boolean> {
  return changing(owner, async (signal) => {
    // Sign-out removes ds-me before clearing the item list. A later reply for that sign-in
    // cannot put it back. authTime also guards a new sign-in by the same person.
    const me = await readMe(owner.tenantId, owner.uid);
    if (!me || me.companyId !== owner.companyId || me.authTime !== authTime || !active()) return false;
    return onLists('readwrite', signal, (store) => {
      if (!active()) return () => false;
      store.delete(range(owner, owner.companyId));
      store.put({ ...owner, versionId: list?.versionId ?? NONE, list });
      return () => true;
    });
  });
}

function forget(person: Person, companyId: string | undefined, active: () => boolean): Promise<void> {
  return changing(person, (signal) => onLists('readwrite', signal, (store) => {
    if (active()) store.delete(range(person, companyId));
    return () => undefined;
  }));
}

// The server refused this company's item list: only that company's copy for this person goes.
export function forgetItemList(owner: ListOwner, active: () => boolean): Promise<void> {
  return forget(owner, owner.companyId, active);
}

export async function forgetItemLists(person: Person, active: () => boolean = () => true): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  await forget(person, undefined, active);
}
