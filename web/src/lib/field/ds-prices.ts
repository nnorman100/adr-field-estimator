import type { z } from 'zod';
import { itemListResponseSchema } from '@/lib/prices/item-list';
import { readMe } from './ds-me';
import { transact, withDatabase, type DbSpec } from './idb';

export type ItemList = NonNullable<z.infer<typeof itemListResponseSchema>['current']>;
type Person = { tenantId: string; uid: string };
type ListOwner = Person & { companyId: string };

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

export function readItemList(owner: ListOwner): Promise<ItemList | null> {
  return within((signal) => onLists('readonly', signal, (store) => {
    const request = store.get(range(owner, owner.companyId));
    return () => {
      const parsed = itemListResponseSchema.safeParse({ current: request.result?.list });
      return parsed.success ? parsed.data.current : null;
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
      if (list) store.put({ ...owner, versionId: list.versionId, list });
      return () => true;
    });
  });
}

export async function forgetItemLists(person: Person, active: () => boolean = () => true): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  await changing(person, (signal) => onLists('readwrite', signal, (store) => {
    if (active()) store.delete(range(person));
    return () => undefined;
  }));
}
