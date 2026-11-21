import type { z } from 'zod';
import { itemListResponseSchema } from '@/lib/prices/item-list';
import { readMe } from './ds-me';
import { meFacts } from './sync-gate';
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

// The browser's storage policy refuses to open the database. A copy saved before the refusal may
// still be there, so this never counts as erased.
class ListsUnavailable extends Error {}

// The item-list database was never created on this phone: only a save creates it.
class NoLists extends Error {}

const newest = new Map<string, symbol>();

// Registers the answer the server has just given for this owner and returns whether it still is the
// newest one in this page. A save made for an older answer asks this inside its own transaction.
export function governing(owner: ListOwner): () => boolean {
  const mine = Symbol('answer');
  const key = JSON.stringify([owner.tenantId, owner.uid, owner.companyId]);
  newest.set(key, mine);
  return () => newest.get(key) === mine;
}

// What the phone records of the server's refusals: one counter per scope, the company's list
// ([tenant, person, company]) or every list this person holds in this company tenant ([tenant,
// person]), in localStorage so every tab and a reload see it. Only the cross-tab lock below reads
// it to raise it, and a raise only adds one, so it never goes down. A request for the list notes
// the counters when it starts (its stamp) and its answer is shown and saved only while they are
// unchanged; a saved row keeps the stamp of the request that fetched it, and a row stamped below
// the current counters is owed an erase: it is never shown, and every read erases it first. No
// clock decides any of it. When the phone's localStorage refuses the raise, the copy is erased all
// the same, but one that cannot be erased may stay viewable offline until the next online check.
type Scope = { tenantId: string; uid: string; companyId?: string };
export type Stamp = readonly [number, number];
const COUNTER_PREFIX = 'ds-prices-erase/';

const scopeKey = ({ tenantId, uid, companyId }: Scope) =>
  JSON.stringify(companyId === undefined ? [tenantId, uid] : [tenantId, uid, companyId]);

function counter(scope: Scope): number {
  try {
    const value = Number(window.localStorage.getItem(COUNTER_PREFIX + scopeKey(scope)));
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

// Under the lock only.
function raise(scope: Scope): void {
  try {
    window.localStorage.setItem(COUNTER_PREFIX + scopeKey(scope), String(counter(scope) + 1));
  } catch {
    // Nothing more can be recorded.
  }
}

function stampOf({ tenantId, uid }: Person, companyId?: string): Stamp {
  return [counter({ tenantId, uid }), companyId === undefined ? 0 : counter({ tenantId, uid, companyId })];
}

// Noted when a request for this owner's list starts.
export const refusalStamp = (owner: ListOwner): Stamp => stampOf(owner, owner.companyId);

const sameStamp = (left: Stamp, right: Stamp) => left[0] === right[0] && left[1] === right[1];

// Whether a refusal came after the request that fetched a row of `companyId` started. A row that
// kept no stamp (saved before rows did) was fetched before any refusal.
function covered(person: Person, companyId: unknown, seen: unknown): boolean {
  const [people, companies] =
    Array.isArray(seen) && seen.length === 2 && seen.every((count) => Number.isSafeInteger(count) && count >= 0) ? (seen as unknown as Stamp) : [0, 0];
  const now = stampOf(person, typeof companyId === 'string' ? companyId : undefined);
  return people < now[0] || companies < now[1];
}

// Whether no refusal has been recorded since a request with `stamp` started; asked under the lock,
// so a refusal already waiting for it has been recorded.
export function unchanged(owner: ListOwner, stamp: Stamp): Promise<boolean> {
  return changing(owner, async () => sameStamp(stamp, refusalStamp(owner)));
}

// What an authenticated GET /api/me answer that the caller accepts means for the item list: without
// prices_read the person may no longer see this company's list, so it is erased, whether or not
// Check Scope is open.
export function noteItemListAccess(person: Person, answer: { status: number; body: unknown }): void {
  if (answer.status !== 200) return;
  const facts = meFacts(answer.body);
  if (facts && !facts.capabilities.includes('prices_read')) {
    void eraseItemList({ tenantId: person.tenantId, uid: person.uid, companyId: facts.companyId });
  }
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

const refusedOpen = (error: unknown) => {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'SecurityError' || name === 'InvalidStateError';
};

// Only a save creates the database (`create`); every other use opens it without creating it. The
// database counts as absent only when this open's own first-creation upgrade was aborted here.
function onLists<T>(
  mode: IDBTransactionMode,
  signal: AbortSignal,
  create: boolean,
  change: (store: IDBObjectStore) => () => T,
): Promise<T> {
  let openTransaction: IDBTransaction | undefined;
  let opened = false;
  let abortedCreation = false;
  const spec: DbSpec = create
    ? SPEC
    : {
        ...SPEC,
        upgrade: (_db, _oldVersion, transaction) => {
          abortedCreation = true;
          transaction.abort();
        },
      };
  const abort = () => {
    try {
      openTransaction?.abort();
    } catch {
      // The transaction already finished.
    }
  };
  signal.addEventListener('abort', abort);
  return withDatabase(spec, (db) => {
    opened = true;
    signal.throwIfAborted();
    return transact(db, STORE, mode, (transaction) => {
      openTransaction = transaction;
      return change(transaction.objectStore(STORE));
    });
  })
    .catch((error: unknown) => {
      if (opened || error instanceof ReopenTheApp) throw error;
      if (abortedCreation) throw new NoLists();
      throw refusedOpen(error) ? new ListsUnavailable() : error;
    })
    .finally(() => signal.removeEventListener('abort', abort));
}

function changing<T>({ tenantId, uid }: Person, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  // Serialize sign-out, erases and writes for this pair, including when the sign-in page is in another tab.
  const lock = JSON.stringify(['ds-prices', tenantId, uid]);
  return within(async (signal) => {
    if (navigator.locks) return await navigator.locks.request(lock, { signal }, () => work(signal));
    return work(signal);
  });
}

function twice<T>(attempt: () => Promise<T>): Promise<T> {
  return attempt().catch((error: unknown) => {
    if (error instanceof ListsUnavailable || error instanceof ReopenTheApp) throw error;
    return attempt();
  });
}

// Under the lock: removes the rows of `wipe`'s scope (when given) and every row a refusal covers. A
// phone with no item-list database has none.
async function erase(person: Person, signal: AbortSignal, wipe: Scope | null): Promise<void> {
  try {
    await onLists('readwrite', signal, false, (store) => {
      const request = store.openCursor(range(person));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const row = cursor.value as { companyId?: unknown; seen?: unknown };
        const inScope = wipe !== null && (wipe.companyId === undefined || wipe.companyId === row.companyId);
        if (inScope || covered(person, row.companyId, row.seen)) cursor.delete();
        cursor.continue();
      };
      return () => undefined;
    });
  } catch (error) {
    if (!(error instanceof NoLists)) throw error;
  }
}

// The row stored for the owner's company, or none. Under the lock.
async function stored(owner: ListOwner, signal: AbortSignal): Promise<{ versionId?: unknown; list?: unknown; seen?: unknown } | undefined> {
  try {
    return await onLists('readonly', signal, false, (store) => {
      const request = store.get(range(owner, owner.companyId));
      return () => request.result as { versionId?: unknown; list?: unknown; seen?: unknown } | undefined;
    });
  } catch (error) {
    if (error instanceof NoLists) return undefined;
    throw error;
  }
}

export function readItemList(owner: ListOwner): Promise<SavedList> {
  return changing(owner, async (signal): Promise<SavedList> => {
    const row = await stored(owner, signal);
    if (!row) return null;
    // Refused since it was saved, in this tab or another: never shown, erased first.
    if (covered(owner, owner.companyId, row.seen)) {
      try {
        await erase(owner, signal, null);
      } catch (error) {
        if (error instanceof ReopenTheApp) throw error;
        return 'withheld';
      }
      return null;
    }
    if (row.versionId === NONE) return { list: null };
    const parsed = itemListResponseSchema.safeParse({ current: row.list });
    return parsed.success && parsed.data.current ? { list: parsed.data.current } : null;
  });
}

// Saves the answer to a request that started with `stamp`. Nothing is saved when a refusal has been
// recorded since (the answer may be older than it), when the sign-in has changed, or when `active`
// says a newer answer governs. A version already stored and not covered by a refusal is not written
// again, so a phone that now refuses writes keeps it without a warning.
export function replaceItemList(owner: ListOwner, list: ItemList | null, authTime: number, stamp: Stamp, active: () => boolean): Promise<boolean> {
  return changing(owner, async (signal) => {
    // Sign-out removes ds-me before clearing the item list. A later reply for that sign-in
    // cannot put it back. authTime also guards a new sign-in by the same person.
    const me = await readMe(owner.tenantId, owner.uid);
    if (!me || me.companyId !== owner.companyId || me.authTime !== authTime || !active()) return false;
    if (!sameStamp(stamp, refusalStamp(owner))) return false;
    const versionId = list?.versionId ?? NONE;
    const row = await stored(owner, signal);
    if (row?.versionId === versionId && !covered(owner, owner.companyId, row.seen)) return true;
    return onLists('readwrite', signal, true, (store) => {
      store.delete(range(owner, owner.companyId));
      store.put({ ...owner, versionId, list, seen: stamp });
      return () => true;
    });
  });
}

// The server refused this company's list for this person (an item-list refusal, or GET /api/me
// without prices_read): the refusal is recorded and the copy erased. True when the copy is gone;
// when it is not, it is owed (a row stamped below the counter) and every read erases it first.
export async function eraseItemList(owner: ListOwner): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return true;
  return twice(() => changing(owner, async (signal) => {
    raise(owner);
    await erase(owner, signal, owner);
  })).then(() => true, () => false);
}

// Sign-out: every list this person holds in this company tenant goes. Throws, with the erase owed,
// when the phone could not finish it. `active` says the sign-in this is for has not been replaced,
// asked under the lock: a newer one's lists stay and nothing is recorded.
export async function forgetItemLists(person: Person, active: () => boolean = () => true): Promise<void> {
  if (typeof indexedDB === 'undefined' || !active()) return;
  const whole = { tenantId: person.tenantId, uid: person.uid };
  await twice(() => changing(person, async (signal) => {
    if (!active()) return;
    raise(whole);
    await erase(person, signal, whole);
  }));
}
