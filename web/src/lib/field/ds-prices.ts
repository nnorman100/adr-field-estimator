import type { z } from 'zod';
import { itemListResponseSchema } from '@/lib/prices/item-list';
import { readMe, updateMe } from './ds-me';
import { ReopenTheApp, transact, withDatabase, type DbSpec } from './idb';

export type ItemList = NonNullable<z.infer<typeof itemListResponseSchema>['current']>;
type Person = { tenantId: string; uid: string };
type ListOwner = Person & { companyId: string };
// What a phone knows of one company's published list: null when it never asked, `{ list: null }`
// when the server last said the company has none, 'withheld' while a refused copy could not be erased.
export type SavedList = { list: ItemList | null } | 'withheld' | null;

// Stored in the version part of the key for a confirmed "no published list". It is no UUID, so it
// never matches a version id.
const NONE = 'none';

// The browser's storage policy refuses to open the database: no copy can have been saved on it.
class ListsUnavailable extends Error {}

const ownerKey = ({ tenantId, uid, companyId }: ListOwner) => JSON.stringify([tenantId, uid, companyId]);
// Copies whose erasure after a refusal failed; each is erased before anything reads it.
const unerased = new Set<string>();
const newest = new Map<string, symbol>();

// Registers the answer the server has just given for this owner and returns whether it still is the
// newest one. A save or an erase made for an older answer asks this inside its own transaction.
export function governing(owner: ListOwner): () => boolean {
  const mine = Symbol('answer');
  const key = ownerKey(owner);
  newest.set(key, mine);
  return () => newest.get(key) === mine;
}

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
  let opened = false;
  const abort = () => {
    try {
      openTransaction?.abort();
    } catch {
      // The transaction already finished.
    }
  };
  signal.addEventListener('abort', abort);
  return withDatabase(SPEC, (db) => {
    opened = true;
    signal.throwIfAborted();
    return transact(db, STORE, mode, (transaction) => {
      openTransaction = transaction;
      return change(transaction.objectStore(STORE));
    });
  })
    .catch((error: unknown) => {
      const name = (error as { name?: unknown } | null)?.name;
      throw !opened && !(error instanceof ReopenTheApp) && (name === 'SecurityError' || name === 'InvalidStateError') ? new ListsUnavailable() : error;
    })
    .finally(() => signal.removeEventListener('abort', abort));
}

function changing<T>({ tenantId, uid }: Person, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  // Serialize sign-out and writes for this pair, including when the sign-in page is in another tab.
  const lock = JSON.stringify(['ds-prices', tenantId, uid]);
  return within(async (signal) => {
    if (navigator.locks) return await navigator.locks.request(lock, { signal }, () => work(signal));
    return work(signal);
  });
}

export async function readItemList(owner: ListOwner): Promise<SavedList> {
  if (unerased.has(ownerKey(owner)) && !(await eraseItemList(owner, () => true))) return 'withheld';
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
    }).then((committed) => {
      if (committed) unerased.delete(ownerKey(owner));
      return committed;
    });
  });
}

// The server refused this company's list for this person. `active` is asked inside the erase: it
// says the refusal still governs and the sign-in it answered is still this one. True when the copy
// is gone. When the erase fails twice, the copy is erased before its next read, and the saved
// sign-in stops offering `prices_read` (the next online check gives it back) so that a reload
// before then shows nothing either.
export async function eraseItemList(owner: ListOwner, active: () => boolean): Promise<boolean> {
  const attempt = () => changing(owner, (signal) => onLists('readwrite', signal, (store) => {
    if (!active()) return () => false;
    store.delete(range(owner, owner.companyId));
    return () => true;
  }));
  const key = ownerKey(owner);
  try {
    const ran = await attempt().catch(attempt);
    if (ran) unerased.delete(key);
    return ran;
  } catch (error) {
    if (error instanceof ListsUnavailable) {
      unerased.delete(key);
      return true;
    }
    if (active()) {
      unerased.add(key);
      await withdrawPricesRead(owner, active).catch(() => undefined);
    }
    return false;
  }
}

async function withdrawPricesRead(owner: ListOwner, active: () => boolean): Promise<void> {
  const me = await readMe(owner.tenantId, owner.uid);
  if (!me || me.companyId !== owner.companyId || !me.capabilities?.includes('prices_read') || !active()) return;
  const { savedAt: _savedAt, ...rest } = me;
  void _savedAt;
  await updateMe({ ...rest, capabilities: me.capabilities.filter((capability) => capability !== 'prices_read') });
}

export async function forgetItemLists(person: Person, active: () => boolean = () => true): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  let erased = false;
  try {
    await changing(person, (signal) => onLists('readwrite', signal, (store) => {
      erased = active();
      if (erased) store.delete(range(person));
      return () => undefined;
    }));
  } catch (error) {
    if (!(error instanceof ListsUnavailable)) throw error;
    return;
  }
  if (!erased) return;
  for (const key of unerased) {
    const [tenantId, uid] = JSON.parse(key) as string[];
    if (tenantId === person.tenantId && uid === person.uid) unerased.delete(key);
  }
}
