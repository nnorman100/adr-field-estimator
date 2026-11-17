// `ds-journal`: the phone's own record of every field edit it has not yet seen the server accept
// (S6-4; docs/plans/S6.md section 4, steps 1, 2 and 6). Firestore's queue holds the same edits, but
// after the app is closed and opened again it says nothing about one the rules refused: it drops it
// (S6-1 (b)). So each edit is written here first, then handed to Firestore, and the entry says what
// became of it.
//
// An entry: the operation id, the (tenant, person) it belongs to, the draft, the document writes
// (absolute values only), when it was made, whether it reached Firestore's cache, and its state:
// - pending: waiting for the server's answer;
// - rejected: the rules refused it (`reason`); never sent again (step 6);
// - changed: the server holds other values and nothing refused it (the same person's other phone
//   wrote later); kept, never sent again.
// An entry the server accepted is removed at once (pruned), so the journal holds only what is not
// saved. Several companies share one origin and one phone can hold two companies' sign-ins, so every
// read, change and removal here names its (tenant, person) and touches only their rows.
//
// Opened only through ./idb.ts. A phone whose storage does not answer within WRITE_WITHIN_MS gets
// JournalNotSaved for a new entry, and the edit is not made.
import { canonicalJson } from './canonical';
import { transact, withDatabase, type DbSpec } from './idb';

export const JOURNAL_DB = 'ds-journal';
export const JOURNAL_STORE = 'entries';
export const JOURNAL_DB_VERSION = 1;
// The index of a (tenant, person)'s rows.
export const JOURNAL_OWNER_INDEX = 'owner';

const SPEC: DbSpec = {
  name: JOURNAL_DB,
  version: JOURNAL_DB_VERSION,
  upgrade: (db) => {
    const store = db.createObjectStore(JOURNAL_STORE, { keyPath: 'seq', autoIncrement: true });
    store.createIndex(JOURNAL_OWNER_INDEX, ['tenantId', 'uid']);
  },
};

// One document write, as data, so it can be made again after a restart. `update` changes only the
// dotted keys it names (null removes a key) and needs the document to exist; `set` replaces the
// document; `delete` removes it.
export type DocWrite =
  | { path: string; op: 'update'; fields: Record<string, unknown> }
  | { path: string; op: 'set'; data: Record<string, unknown> }
  | { path: string; op: 'delete' };

// Why the rules refused: the draft is no longer being edited (finished, archived: "locked"),
// another person now holds its field work, this person cannot read it at all, or none of these.
export type RejectReason = 'locked' | 'owner-changed' | 'no-access' | 'refused';
export type JournalState = 'pending' | 'rejected' | 'changed';

export type JournalEntry = {
  seq: number;
  id: string;
  tenantId: string;
  uid: string;
  draftPath: string;
  writes: DocWrite[];
  at: number;
  state: JournalState;
  // Firestore's local write finished: the SDK holds the edit in its own queue.
  reached: boolean;
  reason?: RejectReason;
};

export type Owner = { tenantId: string; uid: string };

export class JournalNotSaved extends Error {
  constructor() {
    super('This phone could not record the change, so it was not made.');
    this.name = 'JournalNotSaved';
  }
}

export const WRITE_WITHIN_MS = 3_000;

function within<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<'timeout'>((done) => (timer = setTimeout(() => done('timeout'), ms)))]).finally(() => clearTimeout(timer));
}

const ownerRange = (owner: Owner) => IDBKeyRange.only([owner.tenantId, owner.uid]);

// Adds an entry, state pending, and answers it once the transaction has committed. Throws
// JournalNotSaved when it could not be saved in time; a late commit is then removed again.
export async function appendEntry(owner: Owner, draftPath: string, writes: DocWrite[], id: string = crypto.randomUUID()): Promise<JournalEntry> {
  const row: Omit<JournalEntry, 'seq'> = { id, tenantId: owner.tenantId, uid: owner.uid, draftPath, writes, at: Date.now(), state: 'pending', reached: false };
  const added = withDatabase(SPEC, (db) =>
    transact(db, JOURNAL_STORE, 'readwrite', (transaction) => {
      const request = transaction.objectStore(JOURNAL_STORE).add(row);
      return () => ({ ...row, seq: request.result as number });
    }),
  );
  const answer = await within(added, WRITE_WITHIN_MS).catch(() => 'failed' as const);
  if (answer === 'timeout' || answer === 'failed') {
    // An entry for an edit that was not made must never be sent later.
    void added.then((entry) => removeEntry(entry), () => undefined);
    throw new JournalNotSaved();
  }
  return answer;
}

// This (tenant, person)'s entries, oldest first.
export function readJournal(owner: Owner): Promise<JournalEntry[]> {
  return withDatabase(SPEC, (db) =>
    transact(db, JOURNAL_STORE, 'readonly', (transaction) => {
      const request = transaction.objectStore(JOURNAL_STORE).index(JOURNAL_OWNER_INDEX).getAll(ownerRange(owner));
      return () => (request.result as JournalEntry[]).sort((a, b) => a.seq - b.seq);
    }),
  );
}

// Changes one entry of its own (tenant, person), if it is still there; a removed entry stays removed.
function changeEntry(entry: Pick<JournalEntry, 'seq' | 'tenantId' | 'uid'>, change: (row: JournalEntry) => JournalEntry | null): Promise<void> {
  return withDatabase(SPEC, (db) =>
    transact(db, JOURNAL_STORE, 'readwrite', (transaction) => {
      const store = transaction.objectStore(JOURNAL_STORE);
      const request = store.get(entry.seq);
      request.onsuccess = () => {
        const row = request.result as JournalEntry | undefined;
        if (!row || row.tenantId !== entry.tenantId || row.uid !== entry.uid) return;
        const next = change(row);
        if (next === null) store.delete(entry.seq);
        else store.put(next);
      };
      return () => undefined;
    }),
  );
}

export const markReached = (entry: JournalEntry): Promise<void> => changeEntry(entry, (row) => ({ ...row, reached: true }));

// The server accepted it: pruned.
export const removeEntry = (entry: Pick<JournalEntry, 'seq' | 'tenantId' | 'uid'>): Promise<void> => changeEntry(entry, () => null);

export const rejectEntry = (entry: JournalEntry, reason: RejectReason): Promise<void> =>
  changeEntry(entry, (row) => ({ ...row, state: 'rejected', reason }));

export const markChanged = (entry: JournalEntry): Promise<void> => changeEntry(entry, (row) => ({ ...row, state: 'changed' }));

// Removes every entry of this (tenant, person): their work was discarded from the phone. Another
// company's or person's entries stay.
export function forgetJournal(owner: Owner): Promise<void> {
  return withDatabase(SPEC, (db) =>
    transact(db, JOURNAL_STORE, 'readwrite', (transaction) => {
      const index = transaction.objectStore(JOURNAL_STORE).index(JOURNAL_OWNER_INDEX);
      const request = index.openKeyCursor(ownerRange(owner));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        transaction.objectStore(JOURNAL_STORE).delete(cursor.primaryKey);
        cursor.continue();
      };
      return () => undefined;
    }),
  );
}

// ---- After a restart: what became of each entry (step 2) ----

// The server's copy of one document: its data, none, or not readable by this person.
export type ServerDoc = { data: Record<string, unknown> } | { missing: true } | { denied: true };

// What one write expects the server to hold, by key: '' is whether the document exists; a dotted
// key is one value (undefined: no such key).
function expectations(write: DocWrite): [string, unknown][] {
  if (write.op === 'delete') return [['', false]];
  if (write.op === 'update') return Object.entries(write.fields).map(([key, value]) => [key, value ?? undefined]);
  const out: [string, unknown][] = [['', true]];
  for (const [top, value] of Object.entries(write.data)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [sub, inner] of Object.entries(value as Record<string, unknown>)) out.push([`${top}.${sub}`, inner ?? undefined]);
    } else out.push([top, value ?? undefined]);
  }
  return out;
}

function valueAt(data: Record<string, unknown>, dotted: string): unknown {
  let current: unknown = data;
  for (const part of dotted.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function same(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return a === b;
  try {
    return canonicalJson(a) === canonicalJson(b);
  } catch {
    return false;
  }
}

function holds(doc: ServerDoc, key: string, expected: unknown): boolean {
  if ('denied' in doc) return false;
  const exists = 'data' in doc;
  if (key === '') return exists === expected;
  return same(exists ? valueAt(doc.data, key) : undefined, expected);
}

// Whether the rules refuse this person's edits to the draft now, from the server's copy of it.
export function draftRefusal(draft: ServerDoc, uid: string): RejectReason | null {
  if (!('data' in draft)) return 'no-access';
  if (draft.data.state !== 'editing') return 'locked';
  if (draft.data.fieldOwnerUid !== uid) return 'owner-changed';
  return null;
}

export type Outcome = { kind: 'acked' } | { kind: 'rejected'; reason: RejectReason } | { kind: 'changed' };

// What became of each of `judged`, given the server's documents (by path) and drafts (by draft
// path). Only the newest entry per document and key is compared: an older entry's key that a newer
// entry wrote counts as the newer one's comparison. `newer` are entries that are not judged here
// but were made after (this page's own, whose promises answer for them): a key one of them wrote
// is not held against an older entry. An entry whose newest values the server holds is acked; any
// other is rejected when the rules refuse the draft, and changed when they do not. An entry whose
// documents were not all read is left out (judged on a later try).
export function judge(
  judged: JournalEntry[],
  newer: JournalEntry[],
  docs: ReadonlyMap<string, ServerDoc>,
  drafts: ReadonlyMap<string, ServerDoc>,
  uid: string,
): Map<number, Outcome> {
  // The newest entry and value per (document, key), across everything that is not yet saved.
  const newest = new Map<string, { seq: number; path: string; key: string; expected: unknown; live: boolean }>();
  const all = [...judged.map((entry) => ({ entry, live: false })), ...newer.map((entry) => ({ entry, live: true }))].sort((a, b) => a.entry.seq - b.entry.seq);
  for (const { entry, live } of all) {
    for (const write of entry.writes) {
      for (const [key, expected] of expectations(write)) newest.set(`${write.path}\u0000${key}`, { seq: entry.seq, path: write.path, key, expected, live });
    }
  }
  const outcomes = new Map<number, Outcome>();
  for (const entry of judged) {
    const draft = drafts.get(entry.draftPath);
    if (!draft || entry.writes.some((write) => !docs.has(write.path))) continue;
    let held = true;
    for (const write of entry.writes) {
      for (const [key] of expectations(write)) {
        const latest = newest.get(`${write.path}\u0000${key}`)!;
        if (latest.live) continue;
        if (!holds(docs.get(latest.path)!, latest.key, latest.expected)) held = false;
      }
    }
    if (held) outcomes.set(entry.seq, { kind: 'acked' });
    else {
      const reason = draftRefusal(draft, uid);
      outcomes.set(entry.seq, reason ? { kind: 'rejected', reason } : { kind: 'changed' });
    }
  }
  return outcomes;
}
