// The recovery journal (./journal.ts) around the phone's Firestore client (S6-4; docs/plans/S6.md
// section 4, steps 1, 2 and 6).
//
// 1. Edit: the entry is saved first, with the server's update time of each document as the phone
//    held it (its base), then the writes go to Firestore. With a memory cache (Online only, an
//    iPhone browser tab, the fallback) nothing is kept on the phone, so nothing is journaled.
// 2. Acknowledge: while the page lives, the write's own promise answers. Accepted: the entry is
//    pruned. Refused by the rules: rejected, with the reason the server's copy of the draft and the
//    person's access now give. No answer (the client stopped): the entry stays pending.
//    After a restart (the promise is gone) whether an entry reached Firestore is unknown: its
//    "reached" mark is written after the fact and a killed page can lose it. So nothing is made
//    again blindly. Once the sync gate has opened and Firestore has sent its queue, the documents
//    are read from the server and judged against each entry's base (journal.ts judge): an entry is
//    made again only when the server has not changed its documents since it was made.
// 6. A refused entry is never sent again, so nothing changes a submitted record.
//
// The server's update time is not in the web SDK's public API. Firebase is pinned (package.json);
// it is read from the snapshot's document version, and a shape this does not know gives none, so
// the entry is kept rather than judged on a guess.
import { doc, getDocFromCache, getDocFromServer, waitForPendingWrites, type DocumentSnapshot, type Firestore } from 'firebase/firestore';
import { fieldUser, settle, UnsentMarkNotSaved, type FieldClient } from '@/lib/field-db';
import { callApi } from '@/lib/firebase-client';
import {
  appendEntry,
  draftRefusal,
  judge,
  markChanged,
  markReached,
  readJournal,
  rejectEntry,
  removeEntry,
  type DocWrite,
  type JournalEntry,
  type Owner,
  type ServerDoc,
} from './journal';
import { ReopenTheApp } from './idb';
import { queueFieldEdit } from './local-edit';
import { applyWrites, draftPath, type DraftRef } from './store';
import { judgeMe } from './sync-gate';
import { noteWrite } from './unsent';

const ownerOf = (client: FieldClient): Owner => ({ tenantId: client.person.tenantId, uid: client.person.uid });
const personKey = (owner: Owner) => `${owner.tenantId}/${owner.uid}`;
const entryKey = (entry: JournalEntry) => `${personKey(entry)}/${entry.seq}`;
const refOf = (path: string): DraftRef => {
  const [, companyId = '', , draftId = ''] = path.split('/');
  return { companyId, draftId };
};

// Entries whose write promise this page holds: their promise answers for them.
const followed = new Set<string>();
// The people whose entries from an earlier page have all been judged on this page.
const judgedHere = new Set<string>();
// Per person, until judgedHere: every entry this page sent that the server has not refused, kept
// after it is pruned, so a key this page wrote is never held against an earlier page's entry.
const sentHere = new Map<string, JournalEntry[]>();
// Per person, the check of their access now (GET /api/me) that is under way.
const asking = new Map<string, Promise<string | null>>();
// Per person, while entries judged as never landed are being made again: a new edit waits for them,
// so an older value never lands after it.
const remaking = new Map<string, Promise<void>>();
// Per person, who to tell when the journal's storage lost its connection twice in work nobody
// awaits (recovery, an answer being recorded): the field shell then says "Reopen the app".
const lostHandlers = new Map<string, () => void>();

export function onJournalLost(client: FieldClient, handler: () => void): () => void {
  const key = personKey(ownerOf(client));
  lostHandlers.set(key, handler);
  return () => {
    if (lostHandlers.get(key) === handler) lostHandlers.delete(key);
  };
}

function lose(person: string, error: unknown): void {
  if (error instanceof ReopenTheApp) lostHandlers.get(person)?.();
}

// The person's role now (GET /api/me), which tells why the rules refuse an edit (journal.ts
// draftRefusal); null when the server did not let them in or did not answer.
function roleNow(client: FieldClient): Promise<string | null> {
  const key = personKey(ownerOf(client));
  const found = asking.get(key);
  if (found) return found;
  const ask = (async () => {
    const user = fieldUser(client.person);
    if (!user) return null;
    const verdict = judgeMe(await callApi(user, '/api/me'), Date.now());
    return verdict.kind === 'open' ? verdict.facts.role : null;
  })()
    .catch(() => null)
    .finally(() => asking.delete(key));
  asking.set(key, ask);
  return ask;
}

// The server's update time of a snapshot's document, in microseconds; undefined when the SDK's
// shape is not the one this knows, null when the snapshot holds no server copy.
function updateTime(snapshot: DocumentSnapshot): number | null | undefined {
  if (!snapshot.exists()) return null;
  const version = (snapshot as unknown as { _document?: { version?: { toMicroseconds?: () => unknown } } })._document?.version;
  const micros = typeof version?.toMicroseconds === 'function' ? version.toMicroseconds() : undefined;
  if (typeof micros !== 'number' || !Number.isFinite(micros)) return undefined;
  // A document made on this phone and never sent has no server version yet.
  return micros > 0 ? micros : null;
}

// The base of each document `writes` touch: the update time of the server copy the phone's cache
// holds now. A document the cache does not hold has none (null); one whose time cannot be read is
// left out (unknown).
export async function basesOf(db: Firestore, writes: readonly DocWrite[]): Promise<Record<string, number | null>> {
  const bases: Record<string, number | null> = {};
  for (const path of new Set(writes.map((write) => write.path))) {
    try {
      const time = updateTime(await getDocFromCache(doc(db, path)));
      if (time !== undefined) bases[path] = time;
    } catch {
      bases[path] = null;
    }
  }
  return bases;
}

// The server's copy of a document; null when it did not answer (asked again on a later try).
async function readServer(db: Firestore, path: string): Promise<ServerDoc | null> {
  try {
    const snapshot = await getDocFromServer(doc(db, path));
    if (!snapshot.exists()) return { missing: true };
    const time = updateTime(snapshot);
    return time === undefined || time === null ? { data: snapshot.data() } : { data: snapshot.data(), updateTime: time };
  } catch (error) {
    return (error as { code?: unknown } | null)?.code === 'permission-denied' ? { denied: true } : null;
  }
}

// The server's answers that refuse a write: the rules, or an update of a document that is gone.
const REFUSALS = new Set(['permission-denied', 'not-found']);

function follow(client: FieldClient, entry: JournalEntry, acknowledged: Promise<void>): void {
  const key = entryKey(entry);
  const person = personKey(entry);
  followed.add(key);
  if (!judgedHere.has(person)) sentHere.set(person, [...(sentHere.get(person) ?? []), entry]);
  acknowledged
    .then(
      async () => {
        await removeEntry(entry);
        void settle(client).catch(() => undefined);
      },
      async (error: unknown) => {
        if (!REFUSALS.has(String((error as { code?: unknown } | null)?.code))) return;
        const kept = sentHere.get(person);
        if (kept) sentHere.set(person, kept.filter((sent) => sent !== entry));
        const [draft, role] = await Promise.all([readServer(client.db, entry.draftPath), roleNow(client)]);
        await rejectEntry(entry, (draft && draftRefusal(draft, entry.uid, role)) ?? 'refused');
      },
    )
    .catch((error: unknown) => lose(person, error))
    .finally(() => followed.delete(key));
}

// Hands an entry's writes to Firestore (./local-edit.ts) and marks it reached only at the local
// receipt. `handed` says whether the writes reached the SDK at all; once they did, their promise
// answers for the entry.
async function send(client: FieldClient, ref: DraftRef, entry: JournalEntry): Promise<{ acknowledged: Promise<void> } | { error: unknown; handed: boolean }> {
  const sent: { made?: Promise<void> } = {};
  try {
    const receipt = await queueFieldEdit(client, ref, (db) => (sent.made = applyWrites(db, entry.writes)));
    void markReached(entry).catch((error: unknown) => lose(personKey(entry), error));
    follow(client, entry, receipt.acknowledged);
    return receipt;
  } catch (error) {
    if (sent.made) follow(client, entry, sent.made);
    return { error, handed: sent.made !== undefined };
  }
}

// A field edit from a screen: the unsent mark, then the journal entry with its bases, then the edit
// (./local-edit.ts, which answers at the local receipt). Throws UnsentMarkNotSaved, JournalNotSaved
// or ReopenTheApp, and makes nothing, when the mark or the entry could not be saved.
export async function journaledEdit(client: FieldClient, ref: DraftRef, writes: DocWrite[]): Promise<{ acknowledged: Promise<void> }> {
  if (client.cache !== 'persistent') return queueFieldEdit(client, ref, (db) => applyWrites(db, writes));
  const owner = ownerOf(client);
  await remaking.get(personKey(owner));
  if (noteWrite(owner.tenantId, owner.uid) === null) throw new UnsentMarkNotSaved();
  const entry = await appendEntry(owner, draftPath(ref), writes, await basesOf(client.db, writes));
  const sent = await send(client, ref, entry);
  if ('acknowledged' in sent) return sent;
  // Never handed to Firestore: no entry.
  if (!sent.handed) void removeEntry(entry).catch(() => undefined);
  throw sent.error;
}

const judging = new Map<string, Promise<void>>();

// Once per page and person, when the sync gate opens: what became of the entries an earlier page
// left pending. Waits for Firestore to send its queue, then reads each entry's documents and draft
// from the server, asks the server for the person's role, and judges them against everything this
// page has sent up to then. Entries that never landed are made again here, oldest first, while a
// new edit waits. An entry whose documents did not all answer stays pending; the next opening of
// the gate on this page tries again.
export function reconcileJournal(client: FieldClient): Promise<void> {
  const owner = ownerOf(client);
  const key = personKey(owner);
  if (client.cache !== 'persistent' || judgedHere.has(key)) return Promise.resolve();
  const found = judging.get(key);
  if (found) return found;
  const done = () => {
    judgedHere.add(key);
    sentHere.delete(key);
  };
  const run = (async () => {
    const judged = (await readJournal(owner)).filter((entry) => entry.state === 'pending' && !followed.has(entryKey(entry)));
    if (judged.length === 0) return done();
    await waitForPendingWrites(client.db);
    const paths = [...new Set(judged.flatMap((entry) => [entry.draftPath, ...entry.writes.map((write) => write.path)]))];
    const read = new Map<string, ServerDoc>();
    await Promise.all(
      paths.map(async (path) => {
        const answer = await readServer(client.db, path);
        if (answer) read.set(path, answer);
      }),
    );
    const role = await roleNow(client);
    // From the judging to the last entry made again, a new edit waits: it would otherwise be one the
    // judging did not see, and an older value made again would land after it.
    let release = () => undefined as void;
    remaking.set(key, new Promise<void>((resolve) => (release = resolve)));
    let complete = true;
    try {
      const outcomes = judge(judged, sentHere.get(key) ?? [], read, read, owner.uid, role);
      for (const entry of judged) {
        const outcome = outcomes.get(entry.seq);
        if (!outcome) complete = false;
        else if (outcome.kind === 'acked') await removeEntry(entry);
        else if (outcome.kind === 'rejected') await rejectEntry(entry, outcome.reason);
        else if (outcome.kind === 'changed') await markChanged(entry);
        else {
          const sent = await send(client, refOf(entry.draftPath), entry);
          // Not handed to Firestore (the unsent mark could not be saved): judged again on a later try.
          if ('error' in sent && !sent.handed) complete = false;
        }
      }
    } finally {
      remaking.delete(key);
      release();
    }
    if (complete) done();
    void settle(client).catch(() => undefined);
  })()
    .catch((error: unknown) => lose(key, error))
    .finally(() => judging.delete(key));
  judging.set(key, run);
  return run;
}
