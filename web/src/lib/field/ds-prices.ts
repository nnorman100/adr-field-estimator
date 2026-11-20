import type { z } from 'zod';
import { itemListResponseSchema } from '@/lib/prices/item-list';
import { readMe } from './ds-me';
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

const newest = new Map<string, symbol>();

// Registers the answer the server has just given for this owner and returns whether it still is the
// newest one in this page. A save made for an older answer asks this inside its own transaction.
export function governing(owner: ListOwner): () => boolean {
  const mine = Symbol('answer');
  const key = JSON.stringify([owner.tenantId, owner.uid, owner.companyId]);
  newest.set(key, mine);
  return () => newest.get(key) === mine;
}

// An erase the phone owes: every copy of this company's list (or, with no company, of every list
// this person holds in this company tenant) that is not newer than `asOf` must go before anything
// shows it. `asOf` is when the refusal arrived (Date.now()), and a row keeps when the request for
// the answer it holds was sent: a copy survives only when it was asked for after the refusal came,
// so the server gave it later. An older refusal replayed in this tab, another tab or after a reload
// never erases it; any doubt erases (a re-download). The intent is kept in localStorage, apart from
// the IndexedDB writes that may be failing, so it survives a reload and every tab sees it; a phone
// whose localStorage refuses it keeps it in this page. Only a committed erase (or a committed newer
// save) clears it, under the lock, and only if no newer intent replaced it meanwhile (its token).
type Intent = { token: string; asOf: number };
type Scope = { tenantId: string; uid: string; companyId?: string };
const INTENT_PREFIX = 'ds-prices-erase/';
const held = new Map<string, Intent>();

const scopeKey = ({ tenantId, uid, companyId }: Scope) =>
  JSON.stringify(companyId === undefined ? [tenantId, uid] : [tenantId, uid, companyId]);

function parseIntent(value: string | null): Intent | null {
  if (value === null) return null;
  try {
    const intent = JSON.parse(value) as Partial<Intent> | null;
    return typeof intent?.token === 'string' && typeof intent.asOf === 'number' ? { token: intent.token, asOf: intent.asOf } : null;
  } catch {
    return null;
  }
}

function intentAt(key: string): Intent | null {
  let stored: Intent | null = null;
  try {
    stored = parseIntent(window.localStorage.getItem(INTENT_PREFIX + key));
  } catch {
    // Only what this page holds.
  }
  const local = held.get(key) ?? null;
  if (!stored) return local;
  if (!local) return stored;
  return local.asOf > stored.asOf ? local : stored;
}

function owe(scope: Scope, asOf: number): void {
  const key = scopeKey(scope);
  const before = intentAt(key);
  const intent: Intent = { token: crypto.randomUUID(), asOf: Math.max(asOf, before?.asOf ?? -Infinity) };
  try {
    window.localStorage.setItem(INTENT_PREFIX + key, JSON.stringify(intent));
    held.delete(key);
  } catch {
    held.set(key, intent);
  }
}

function settled(key: string, token: string): void {
  if (held.get(key)?.token === token) held.delete(key);
  try {
    if (parseIntent(window.localStorage.getItem(INTENT_PREFIX + key))?.token === token) window.localStorage.removeItem(INTENT_PREFIX + key);
  } catch {
    // Left in place: the next read settles again.
  }
}

// The intents that apply to this person's rows: the person's own, and each company's.
function intentsOf({ tenantId, uid }: Person): Map<string, Intent> {
  const keys = new Set<string>([...held.keys()]);
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const name = window.localStorage.key(index);
      if (name?.startsWith(INTENT_PREFIX)) keys.add(name.slice(INTENT_PREFIX.length));
    }
  } catch {
    // Only what this page holds.
  }
  const found = new Map<string, Intent>();
  for (const key of keys) {
    let parts: unknown;
    try {
      parts = JSON.parse(key);
    } catch {
      continue;
    }
    if (!Array.isArray(parts) || parts[0] !== tenantId || parts[1] !== uid) continue;
    const intent = intentAt(key);
    if (intent) found.set(key, intent);
  }
  return found;
}

// The intent that covers a row of `companyId` saved from an answer started at `asOf` (a row from
// before rows kept that time counts as oldest), or null.
function covering({ tenantId, uid }: Person, companyId: unknown, asOf: unknown): Intent | null {
  // A time ahead of the clock (the clock was set back since) proves nothing.
  const rowAsOf = typeof asOf === 'number' && asOf <= Date.now() ? asOf : -Infinity;
  for (const scope of [{ tenantId, uid }, ...(typeof companyId === 'string' ? [{ tenantId, uid, companyId }] : [])]) {
    const intent = intentAt(scopeKey(scope));
    if (intent && intent.asOf >= rowAsOf) return intent;
  }
  return null;
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

// Whether the item-list database may be on the phone, asked without creating it: only a save
// creates it, so a refusal, a sign-out or a read on a phone that never saved a list leaves none
// behind. It only spares the open; it never clears an intent. A browser that cannot list its
// databases, or fails to, may have it.
async function saved(): Promise<boolean> {
  if (typeof indexedDB.databases !== 'function') return true;
  try {
    return (await indexedDB.databases()).some((database) => database.name === SPEC.name);
  } catch (error) {
    if (refusedOpen(error)) throw new ListsUnavailable();
    return true;
  }
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
      throw !opened && !(error instanceof ReopenTheApp) && refusedOpen(error) ? new ListsUnavailable() : error;
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

// The one erase: removes every row of this person that an intent covers, then clears the intents it
// acted on once the removal has committed. Resolves when nothing the intents cover is left (a phone
// with no item-list database has none; its intents stay, harmless); throws (ListsUnavailable
// included) with the intents left in place otherwise. Tried twice. `reassert`, run under the lock
// first, writes the caller's intent again: another tab clearing an intent can overwrite one set
// between its read and its removal.
function settle(person: Person, reassert: () => void = () => undefined): Promise<void> {
  const attempt = () => changing(person, async (signal) => {
    reassert();
    const acted = intentsOf(person);
    if (acted.size === 0 || !(await saved())) return;
    await onLists('readwrite', signal, (store) => {
      const request = store.openCursor(range(person));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const row = cursor.value as { companyId?: unknown; asOf?: unknown };
        if (covering(person, row.companyId, row.asOf)) cursor.delete();
        cursor.continue();
      };
      return () => undefined;
    });
    for (const [key, intent] of acted) settled(key, intent.token);
  });
  return attempt().catch((error: unknown) => {
    if (error instanceof ListsUnavailable || error instanceof ReopenTheApp) throw error;
    return attempt();
  });
}

export async function readItemList(owner: ListOwner): Promise<SavedList> {
  if (intentsOf(owner).size > 0) {
    try {
      await settle(owner);
    } catch (error) {
      if (error instanceof ReopenTheApp) throw error;
      return 'withheld';
    }
  }
  if (!(await within(saved))) return null;
  return within((signal) => onLists('readonly', signal, (store) => {
    const request = store.get(range(owner, owner.companyId));
    return (): SavedList => {
      const row = request.result as { versionId?: unknown; list?: unknown; asOf?: unknown } | undefined;
      if (!row) return null;
      // Refused since the erase above, in this tab or another.
      if (covering(owner, owner.companyId, row.asOf)) return 'withheld';
      if (row.versionId === NONE) return { list: null };
      const parsed = itemListResponseSchema.safeParse({ current: row.list });
      return parsed.success && parsed.data.current ? { list: parsed.data.current } : null;
    };
  }));
}

// Saves the answer to a request started at `asOf`. Nothing is saved when a refusal at least as new
// is owed (the answer is older than it), when the sign-in has changed, or when `active` says a newer
// answer governs. A save that commits supersedes the company's older intent.
export function replaceItemList(owner: ListOwner, list: ItemList | null, authTime: number, asOf: number, active: () => boolean): Promise<boolean> {
  return changing(owner, async (signal) => {
    // Sign-out removes ds-me before clearing the item list. A later reply for that sign-in
    // cannot put it back. authTime also guards a new sign-in by the same person.
    const me = await readMe(owner.tenantId, owner.uid);
    if (!me || me.companyId !== owner.companyId || me.authTime !== authTime || !active()) return false;
    const key = scopeKey(owner);
    let superseded: string | undefined;
    const committed = await onLists('readwrite', signal, (store) => {
      if (!active() || covering(owner, owner.companyId, asOf)) return () => false;
      superseded = intentAt(key)?.token;
      store.delete(range(owner, owner.companyId));
      store.put({ ...owner, versionId: list?.versionId ?? NONE, list, asOf });
      return () => true;
    });
    if (committed && superseded !== undefined) settled(key, superseded);
    return committed;
  });
}

// The server refused this company's list for this person, in an answer that arrived at `asOf` (an
// item-list refusal, or GET /api/me without prices_read). The erase is owed from now until it
// commits: every read settles it first. True when the copy is gone.
export async function eraseItemList(owner: ListOwner, asOf: number): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return true;
  owe(owner, asOf);
  return settle(owner, () => owe(owner, asOf)).then(() => true, () => false);
}

// Sign-out: every list this person holds in this company tenant goes. When the phone refuses to
// open the database the erase stays owed, and is made before any later read shows a list.
// `active` says the sign-in this is for has not been replaced: a newer one's lists stay.
export async function forgetItemLists(person: Person, active: () => boolean = () => true): Promise<void> {
  if (typeof indexedDB === 'undefined' || !active()) return;
  const whole = { tenantId: person.tenantId, uid: person.uid };
  const asOf = Date.now();
  owe(whole, asOf);
  try {
    await settle(person, () => {
      if (active()) owe(whole, asOf);
    });
  } catch (error) {
    if (!(error instanceof ListsUnavailable)) throw error;
  }
}
