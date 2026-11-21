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

// What the phone records of the server's refusals, per scope: the company's list, or (with no
// company) every list this person holds in this company tenant. Each refusal writes a new token,
// and the token stays: a committed erase only clears `owed`. A request notes the tokens of its
// scopes when it starts (its stamp); an answer is saved only while they are still the current ones,
// and a copy whose stamp differs from the current tokens was fetched before a refusal and is covered
// by it. Tokens decide the order, never the clock. Every read settles an owed erase first. The
// record is kept in localStorage, apart from the IndexedDB writes that may be failing, so it
// survives a reload and every tab sees it; a phone whose localStorage refuses it keeps it in this
// page only.
type Refusal = { token: string; owed: boolean };
type Scope = { tenantId: string; uid: string; companyId?: string };
export type Stamp = readonly [string | null, string | null];
const INTENT_PREFIX = 'ds-prices-erase/';
const held = new Map<string, Refusal>();

const scopeKey = ({ tenantId, uid, companyId }: Scope) =>
  JSON.stringify(companyId === undefined ? [tenantId, uid] : [tenantId, uid, companyId]);

function parseRefusal(value: string | null): Refusal | null {
  if (value === null) return null;
  try {
    const record = JSON.parse(value) as Partial<Refusal> | null;
    return typeof record?.token === 'string' && typeof record.owed === 'boolean' ? { token: record.token, owed: record.owed } : null;
  } catch {
    return null;
  }
}

// What this page holds is newer than what it stored: it holds only what a failed write left.
function refusalAt(key: string): Refusal | null {
  const local = held.get(key);
  if (local) return local;
  try {
    return parseRefusal(window.localStorage.getItem(INTENT_PREFIX + key));
  } catch {
    return null;
  }
}

function record(key: string, refusal: Refusal): void {
  try {
    window.localStorage.setItem(INTENT_PREFIX + key, JSON.stringify(refusal));
    held.delete(key);
  } catch {
    held.set(key, refusal);
  }
}

function owe(scope: Scope): Refusal {
  const refusal: Refusal = { token: crypto.randomUUID(), owed: true };
  record(scopeKey(scope), refusal);
  return refusal;
}

// Another tab clearing an erase can overwrite one set between its read and its removal: writes the
// same refusal again, unless a newer one has replaced it.
function reassert(scope: Scope, refusal: Refusal): void {
  const key = scopeKey(scope);
  const now = refusalAt(key);
  if (!now || now.token === refusal.token) record(key, refusal);
}

function settled(key: string, token: string): void {
  const now = refusalAt(key);
  if (now?.token === token && now.owed) record(key, { token, owed: false });
}

// The person's own refusal and each company's, as this person's rows are judged by them.
function refusalsOf({ tenantId, uid }: Person): Map<string, Refusal> {
  const keys = new Set<string>([...held.keys()]);
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const name = window.localStorage.key(index);
      if (name?.startsWith(INTENT_PREFIX)) keys.add(name.slice(INTENT_PREFIX.length));
    }
  } catch {
    // Only what this page holds.
  }
  const found = new Map<string, Refusal>();
  for (const key of keys) {
    let parts: unknown;
    try {
      parts = JSON.parse(key);
    } catch {
      continue;
    }
    if (!Array.isArray(parts) || parts[0] !== tenantId || parts[1] !== uid) continue;
    const refusal = refusalAt(key);
    if (refusal) found.set(key, refusal);
  }
  return found;
}

function owedBy(person: Person): Map<string, Refusal> {
  return new Map([...refusalsOf(person)].filter(([, refusal]) => refusal.owed));
}

function stampOf({ tenantId, uid }: Person, companyId?: string): Stamp {
  const token = (scope: Scope) => refusalAt(scopeKey(scope))?.token ?? null;
  return [token({ tenantId, uid }), companyId === undefined ? null : token({ tenantId, uid, companyId })];
}

// Noted when a request for this owner's list starts.
export const refusalStamp = (owner: ListOwner): Stamp => stampOf(owner, owner.companyId);

const sameStamp = (left: Stamp, right: Stamp) => left[0] === right[0] && left[1] === right[1];

// Whether a refusal came after the request that fetched a row of `companyId` started. A row that
// kept no stamp (saved before rows did) was fetched before any refusal.
function covered(person: Person, companyId: unknown, seen: unknown): boolean {
  const was: Stamp =
    Array.isArray(seen) && seen.length === 2 && seen.every((token) => token === null || typeof token === 'string')
      ? (seen as unknown as Stamp)
      : [null, null];
  return !sameStamp(was, stampOf(person, typeof companyId === 'string' ? companyId : undefined));
}

// The lists Check Scope must not show in this page: access was lost, or the sign-in must be renewed,
// and has not been confirmed again. Every Check Scope view of the owner follows it.
const hidden = new Set<string>();
const watchers = new Set<() => void>();

export function hideItemList(owner: ListOwner): void {
  const key = scopeKey(owner);
  if (hidden.has(key)) return;
  hidden.add(key);
  watchers.forEach((watcher) => watcher());
}

export function showItemList(owner: ListOwner): void {
  if (hidden.delete(scopeKey(owner))) watchers.forEach((watcher) => watcher());
}

export const itemListHidden = (owner: ListOwner): boolean => hidden.has(scopeKey(owner));

export function watchItemListHidden(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => void watchers.delete(watcher);
}

// What an authenticated GET /api/me answer that the caller accepts means for the item list: without
// prices_read the person may no longer see this company's list, so it is hidden now and erased
// whether or not Check Scope is open; with it, a list hidden for that is shown again.
export function noteItemListAccess(person: Person, answer: { status: number; body: unknown }): void {
  if (answer.status !== 200) return;
  const facts = meFacts(answer.body);
  if (!facts) return;
  const owner = { tenantId: person.tenantId, uid: person.uid, companyId: facts.companyId };
  if (facts.capabilities.includes('prices_read')) return showItemList(owner);
  hideItemList(owner);
  void eraseItemList(owner);
}

const STORE = 'item-lists';
const SPEC: DbSpec = {
  name: 'ds-prices',
  version: 1,
  upgrade: (db) => {
    db.createObjectStore(STORE, { keyPath: ['tenantId', 'uid', 'companyId', 'versionId'] });
  },
};
// The same database opened without creating it.
const EXISTING: DbSpec = { ...SPEC, upgrade: (_db, _oldVersion, transaction) => transaction.abort() };

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

const abortedOpen = (error: unknown) => (error as { name?: unknown } | null)?.name === 'AbortError';

// Only a save creates the database (`create`); every other use finds it or finds none.
function onLists<T>(
  mode: IDBTransactionMode,
  signal: AbortSignal,
  create: boolean,
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
  return withDatabase(create ? SPEC : EXISTING, (db) => {
    opened = true;
    signal.throwIfAborted();
    return transact(db, STORE, mode, (transaction) => {
      openTransaction = transaction;
      return change(transaction.objectStore(STORE));
    });
  })
    .catch((error: unknown) => {
      if (opened || error instanceof ReopenTheApp) throw error;
      if (!create && abortedOpen(error)) throw new NoLists();
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

// The one erase: removes every row of this person that a refusal covers, then clears the erases it
// acted on once the removal has committed. Resolves when nothing a refusal covers is left (a phone
// with no item-list database has none: its owed erases are cleared); throws (ListsUnavailable
// included) with them left owed otherwise. Tried twice. `again`, run under the lock first, writes
// the caller's refusal again.
function settle(person: Person, again: () => void = () => undefined): Promise<void> {
  const attempt = () => changing(person, async (signal) => {
    again();
    const acted = owedBy(person);
    if (acted.size === 0) return;
    try {
      await onLists('readwrite', signal, false, (store) => {
        const request = store.openCursor(range(person));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          const row = cursor.value as { companyId?: unknown; seen?: unknown };
          if (covered(person, row.companyId, row.seen)) cursor.delete();
          cursor.continue();
        };
        return () => undefined;
      });
    } catch (error) {
      if (!(error instanceof NoLists)) throw error;
    }
    for (const [key, refusal] of acted) settled(key, refusal.token);
  });
  return attempt().catch((error: unknown) => {
    if (error instanceof ListsUnavailable || error instanceof ReopenTheApp) throw error;
    return attempt();
  });
}

export async function readItemList(owner: ListOwner): Promise<SavedList> {
  if (owedBy(owner).size > 0) {
    try {
      await settle(owner);
    } catch (error) {
      if (error instanceof ReopenTheApp) throw error;
      return 'withheld';
    }
  }
  try {
    return await within((signal) => onLists('readonly', signal, false, (store) => {
      const request = store.get(range(owner, owner.companyId));
      return (): SavedList => {
        const row = request.result as { versionId?: unknown; list?: unknown; seen?: unknown } | undefined;
        if (!row) return null;
        // Refused since the erase above, in this tab or another.
        if (covered(owner, owner.companyId, row.seen)) return 'withheld';
        if (row.versionId === NONE) return { list: null };
        const parsed = itemListResponseSchema.safeParse({ current: row.list });
        return parsed.success && parsed.data.current ? { list: parsed.data.current } : null;
      };
    }));
  } catch (error) {
    if (error instanceof NoLists) return null;
    throw error;
  }
}

// Saves the answer to a request that started with `stamp`. Nothing is saved when a refusal has
// been recorded since (the answer may be older than it), when the sign-in has changed, or when
// `active` says a newer answer governs. A version already stored and not covered by a refusal is
// not written again.
export function replaceItemList(owner: ListOwner, list: ItemList | null, authTime: number, stamp: Stamp, active: () => boolean): Promise<boolean> {
  return changing(owner, async (signal) => {
    // Sign-out removes ds-me before clearing the item list. A later reply for that sign-in
    // cannot put it back. authTime also guards a new sign-in by the same person.
    const me = await readMe(owner.tenantId, owner.uid);
    if (!me || me.companyId !== owner.companyId || me.authTime !== authTime || !active()) return false;
    const versionId = list?.versionId ?? NONE;
    const current = () => active() && sameStamp(stamp, refusalStamp(owner));
    let saved = false;
    return onLists('readwrite', signal, true, (store) => {
      const found = store.get(range(owner, owner.companyId));
      found.onsuccess = () => {
        if (!current()) return;
        const row = found.result as { versionId?: unknown; seen?: unknown } | undefined;
        saved = true;
        if (row?.versionId === versionId && !covered(owner, owner.companyId, row.seen)) return;
        store.delete(range(owner, owner.companyId));
        store.put({ ...owner, versionId, list, seen: stamp });
      };
      return () => saved;
    });
  });
}

// The server refused this company's list for this person (an item-list refusal, or GET /api/me
// without prices_read). The erase is owed from now until it commits: every read settles it first.
// True when the copy is gone.
export async function eraseItemList(owner: ListOwner): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return true;
  const refusal = owe(owner);
  return settle(owner, () => reassert(owner, refusal)).then(() => true, () => false);
}

// Sign-out: every list this person holds in this company tenant goes. Throws, with the erase left
// owed (it is made before any later read shows a list), when the phone could not finish it.
// `active` says the sign-in this is for has not been replaced: a newer one's lists stay.
export async function forgetItemLists(person: Person, active: () => boolean = () => true): Promise<void> {
  if (typeof indexedDB === 'undefined' || !active()) return;
  const whole = { tenantId: person.tenantId, uid: person.uid };
  const refusal = owe(whole);
  await settle(person, () => {
    if (active()) reassert(whole, refusal);
  });
}
