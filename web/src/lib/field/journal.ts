// `ds-journal`: the phone's own record of every field edit it has not yet seen the server accept
// (S6-4; docs/plans/S6.md section 4, steps 1, 2 and 6). Firestore's queue holds the same edits, but
// after the app is closed and opened again it says nothing about one the rules refused: it drops it
// (S6-1 (b)). So each edit is written here first, then handed to Firestore, and the entry says what
// became of it.
//
// An entry: the operation id, the (tenant, person) it belongs to, the draft, the document writes
// (absolute values only), when it was made, the server update time of each document as the phone
// held it, and its state:
// - pending: waiting for the server's answer;
// - rejected: the rules refused it (`reason`); never sent again (step 6);
// - changed: the server holds other values and nothing refused it (the same person's other phone
//   wrote later); kept, never sent again.
// An entry the server accepted is removed at once (pruned), so the journal holds only what is not
// saved. Several companies share one origin and one phone can hold two companies' sign-ins, so every
// read, change and removal here names its (tenant, person) and touches only their rows.
//
// Opened only through ./idb.ts. A phone whose storage does not answer within WRITE_WITHIN_MS gets
// JournalNotSaved for a new entry (ReopenTheApp when its connection was lost twice), and the edit
// is not made. While any entry is here the person's
// unsent mark (./unsent.ts) stays set, so the sign-in pages ask before anything is discarded.
import { canonicalJson } from './canonical';
import { ReopenTheApp, transact, withDatabase, type DbSpec } from './idb';

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
// another person now holds its field work, the person's role no longer edits field work (it can
// still read the draft: office), this person cannot read it at all, or none of these.
export type RejectReason = 'locked' | 'owner-changed' | 'role-changed' | 'no-access' | 'refused';

// The roles whose people edit field work (web/firestore.rules canEdit).
const EDIT_ROLES: ReadonlySet<string> = new Set(['owner', 'estimator']);
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
  // Per document written: the server's update time (microseconds) of the copy the phone held when
  // the edit was made, null when it held none (a new room or photo). What the server holds after a
  // restart is judged against it (judge). Absent on a path: unknown.
  bases?: Record<string, number | null>;
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

// Per (tenant, person), the edits between their unsent mark and their entry's commit: the journal
// read now may not hold their entries yet, so field-db.ts settle() leaves the mark while any is.
const adding = new Map<string, number>();
const ownerKey = (owner: Owner) => `${owner.tenantId}/${owner.uid}`;

export const addingEntries = (owner: Owner): boolean => (adding.get(ownerKey(owner)) ?? 0) > 0;

// Runs `work` (the unsent mark, then appendEntry) as one edit being added for `owner`.
export async function whileAdding<T>(owner: Owner, work: () => Promise<T>): Promise<T> {
  const key = ownerKey(owner);
  adding.set(key, (adding.get(key) ?? 0) + 1);
  try {
    return await work();
  } finally {
    const left = (adding.get(key) ?? 1) - 1;
    if (left > 0) adding.set(key, left);
    else adding.delete(key);
  }
}

// Adds an entry, state pending, and answers it once the transaction has committed. Throws
// JournalNotSaved when it could not be saved in time: the transaction is aborted, and an open that
// answers later starts none. Only a commit already under way when the time ran out is removed again.
export async function appendEntry(
  owner: Owner,
  draftPath: string,
  writes: DocWrite[],
  bases: Record<string, number | null> = {},
  id: string = crypto.randomUUID(),
): Promise<JournalEntry> {
  const row: Omit<JournalEntry, 'seq'> = { id, tenantId: owner.tenantId, uid: owner.uid, draftPath, writes, at: Date.now(), state: 'pending', bases };
  let abandoned = false;
  let active: IDBTransaction | undefined;
  const added = withDatabase(SPEC, (db) => {
    if (abandoned) return Promise.reject(new JournalNotSaved());
    return transact(db, JOURNAL_STORE, 'readwrite', (transaction) => {
      active = transaction;
      const request = transaction.objectStore(JOURNAL_STORE).add(row);
      return () => ({ ...row, seq: request.result as number });
    });
  });
  let lost = false;
  const answer = await within(added, WRITE_WITHIN_MS).catch((error: unknown) => {
    lost = error instanceof ReopenTheApp;
    return 'failed' as const;
  });
  if (answer === 'timeout' || answer === 'failed') {
    abandoned = true;
    try {
      active?.abort();
    } catch {
      // Already committing or finished: removed below.
    }
    // An entry for an edit that was not made must never be sent later.
    void added.then((entry) => removeEntry(entry), () => undefined);
    // A connection lost twice is said as it is: "Reopen the app."
    throw lost ? new ReopenTheApp() : new JournalNotSaved();
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

// The server's copy of one document: its data and its update time (microseconds; absent when
// unknown), none, or not readable by this person.
export type ServerDoc = { data: Record<string, unknown>; updateTime?: number } | { missing: true } | { denied: true };

// Whether the server's copy changed since `base` (the copy the edit was made against): null when
// that cannot be told.
function changedSince(doc: ServerDoc, base: number | null | undefined): boolean | null {
  if (base === undefined || 'denied' in doc) return null;
  if ('missing' in doc) return base !== null;
  if (doc.updateTime === undefined) return null;
  return base === null || doc.updateTime > base;
}

// Whether the server has changed none of the entry's documents since it was made, given its copies
// of them (by path). False when one was not read or that cannot be told.
export function untouchedSince(entry: JournalEntry, docs: ReadonlyMap<string, ServerDoc>): boolean {
  return [...new Set(entry.writes.map((write) => write.path))].every((path) => {
    const doc = docs.get(path);
    return doc !== undefined && changedSince(doc, entry.bases?.[path]) === false;
  });
}

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
// `role` is the person's role at the last online check (GET /api/me), which let them in: the
// company's access is current, so the role decides what the rules let them read and edit. An
// estimator may read only drafts whose field work is theirs (web/firestore.rules canRead), so a
// draft an estimator with current access cannot read is one whose field work moved to someone else.
// Without a role (no online check yet on this page) a refused read is no-access.
export function draftRefusal(draft: ServerDoc, uid: string, role: string | null = null): RejectReason | null {
  if (!('data' in draft)) return 'denied' in draft && role === 'estimator' ? 'owner-changed' : 'no-access';
  if (draft.data.state !== 'editing') return 'locked';
  if (draft.data.fieldOwnerUid !== uid) return 'owner-changed';
  if (role !== null && !EDIT_ROLES.has(role)) return 'role-changed';
  return null;
}

// `reissue`: the edit never reached the server and nothing changed its documents since it was made,
// so it is made again as it was.
export type Outcome = { kind: 'acked' } | { kind: 'rejected'; reason: RejectReason } | { kind: 'changed' } | { kind: 'reissue' };

// What became of each of `judged`, given the server's documents (by path) and drafts (by draft
// path), read after Firestore sent its queue. Only the newest entry per document and key is
// compared: an older entry's key that a newer entry wrote counts as the newer one's comparison, and
// a newer `set` or `delete` of the document writes every key it does not name as absent. `newer`
// are entries that are not judged here but were made after (this page's own, whose promises answer
// for them): a key one of them wrote is not held against an older entry.
// - The rules refuse the draft (finished or archived, moved, no access): every entry is rejected
//   with the reason and kept, even when the server's values happen to match it (step 6). A newer
//   document version never proves this phone's write landed: another phone may have changed the
//   same document before the fence (Firstmate rulings R3 and R2, 2026-11-17).
// - Otherwise an entry whose newest values the server holds is acked. One whose documents the server
//   has not changed since its base never landed and is made again (reissue); one whose documents
//   changed since (another phone wrote later), or whose base is unknown, is changed and kept.
// An entry whose documents were not all read is left out (judged on a later try).
export function judge(
  judged: JournalEntry[],
  newer: JournalEntry[],
  docs: ReadonlyMap<string, ServerDoc>,
  drafts: ReadonlyMap<string, ServerDoc>,
  uid: string,
  role: string | null = null,
): Map<number, Outcome> {
  // The newest entry and value per (document, key), across everything that is not yet saved.
  const newest = new Map<string, { seq: number; path: string; key: string; expected: unknown; live: boolean }>();
  const all = [...judged.map((entry) => ({ entry, live: false })), ...newer.map((entry) => ({ entry, live: true }))].sort((a, b) => a.entry.seq - b.entry.seq);
  for (const { entry, live } of all) {
    for (const write of entry.writes) {
      if (write.op !== 'update') {
        for (const [slot, prior] of newest) if (prior.path === write.path) newest.set(slot, { ...prior, seq: entry.seq, expected: undefined, live });
      }
      for (const [key, expected] of expectations(write)) newest.set(`${write.path}\u0000${key}`, { seq: entry.seq, path: write.path, key, expected, live });
    }
  }
  const outcomes = new Map<number, Outcome>();
  for (const entry of judged) {
    const draft = drafts.get(entry.draftPath);
    if (!draft || entry.writes.some((write) => !docs.has(write.path))) continue;
    let held = true;
    // A key of this entry that a later entry wrote: making this one again would undo that one.
    let overtaken = false;
    for (const write of entry.writes) {
      for (const [key] of expectations(write)) {
        const latest = newest.get(`${write.path}\u0000${key}`)!;
        if (latest.seq !== entry.seq) overtaken = true;
        if (latest.live) continue;
        if (!holds(docs.get(latest.path)!, latest.key, latest.expected)) held = false;
      }
    }
    const reason = draftRefusal(draft, uid, role);
    if (reason) outcomes.set(entry.seq, { kind: 'rejected', reason });
    else if (held) outcomes.set(entry.seq, { kind: 'acked' });
    else outcomes.set(entry.seq, !overtaken && untouchedSince(entry, docs) ? { kind: 'reissue' } : { kind: 'changed' });
  }
  return outcomes;
}
