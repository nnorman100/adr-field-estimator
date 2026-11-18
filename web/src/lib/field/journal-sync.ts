// The recovery journal (./journal.ts) around the phone's Firestore client (S6-4; docs/plans/S6.md
// section 4, steps 1, 2 and 6).
//
// 1. Edit: the entry is saved first, with the server's update time of each document as the phone
//    held it (its base), then the writes go to Firestore. With a memory cache (Online only, an
//    iPhone browser tab, the fallback) nothing is kept on the phone, so nothing is journaled.
// 2. Acknowledge: while the page lives, the write's own promise answers. Accepted: the entry is
//    pruned. Refused by the rules: rejected, with the reason the server's copy of the draft and the
//    person's access now give. No answer (the client stopped): the entry stays pending.
//    After a restart (the promise is gone) whether an entry reached Firestore is unknown (a page
//    can be killed between the entry and the write, or after both). So nothing is made again
//    blindly. Once the sync gate has opened and Firestore has sent its queue, the documents
//    are read from the server and judged against each entry's base (journal.ts judge): an entry is
//    made again only when the server has not changed its documents since it was made, checked
//    again in the transaction that makes it, so a later save (another phone's, or an edit this page
//    queued meanwhile) is never overwritten.
// 6. A refused entry is never sent again, so nothing changes a submitted record.
//
// The server's update time is not in the web SDK's public API. Firebase is pinned (package.json);
// it is read from the snapshot's document version, and a shape this does not know gives none, so
// the entry is kept rather than judged on a guess.
import { doc, getDocFromCache, getDocFromServer, runTransaction, waitForPendingWrites, type DocumentSnapshot, type Firestore } from 'firebase/firestore';
import { fieldUser, settle, UnsentMarkNotSaved, type FieldClient } from '@/lib/field-db';
import { callApi } from '@/lib/firebase-client';
import {
  appendEntry,
  markRefused,
  NO_ANSWER,
  refusalReason,
  judge,
  markChanged,
  readJournal,
  rejectEntry,
  removeEntry,
  untouchedSince,
  whileAdding,
  type DocWrite,
  type JournalEntry,
  type Owner,
  type RoleNow,
  type ServerDoc,
} from './journal';
import { ReopenTheApp } from './idb';
import { queueFieldEdit } from './local-edit';
import { applyWrites, draftPath, stageWrites, type DraftRef } from './store';
import { ASK_WITHIN_MS, judgeMe } from './sync-gate';
import { noteWrite } from './unsent';

const ownerOf = (client: FieldClient): Owner => ({ tenantId: client.person.tenantId, uid: client.person.uid });
const personKey = (owner: Owner) => `${owner.tenantId}/${owner.uid}`;

// Per person, until judgedHere: the entries made on this page. Their write promise answers for
// them, so recovery never judges them as an earlier page's.
const madeHere = new Map<string, Set<number>>();
// The people whose entries from an earlier page have all been judged on this page.
const judgedHere = new Set<string>();
// Per person, until judgedHere: every entry this page sent that the server has not refused, kept
// after it is pruned, so a key this page wrote is never held against an earlier page's entry.
const sentHere = new Map<string, JournalEntry[]>();
// Per person, the check of their access now (GET /api/me) that is under way.
const asking = new Map<string, Promise<RoleNow>>();
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
// draftRefusal): null when the server did not let them in, NO_ANSWER when there was no answer
// within ASK_WITHIN_MS (or no sign-in to ask with), so nothing is classified on a guess.
function roleNow(client: FieldClient): Promise<RoleNow> {
  const key = personKey(ownerOf(client));
  const found = asking.get(key);
  if (found) return found;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ask = Promise.race([
    (async () => {
      const user = fieldUser(client.person);
      if (!user) return NO_ANSWER;
      const verdict = judgeMe(await callApi(user, '/api/me'), Date.now());
      return verdict.kind === 'open' ? verdict.facts.role : null;
    })(),
    new Promise<typeof NO_ANSWER>((done) => (timer = setTimeout(() => done(NO_ANSWER), ASK_WITHIN_MS))),
  ])
    .catch((): RoleNow => NO_ANSWER)
    .finally(() => {
      clearTimeout(timer);
      asking.delete(key);
    });
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

// What a snapshot read from the server holds of its document.
function serverDoc(snapshot: DocumentSnapshot): ServerDoc {
  if (!snapshot.exists()) return { missing: true };
  const time = updateTime(snapshot);
  return time === undefined || time === null ? { data: snapshot.data() } : { data: snapshot.data(), updateTime: time };
}

// The server's copy of a document; null when it did not answer (asked again on a later try).
async function readServer(db: Firestore, path: string): Promise<ServerDoc | null> {
  try {
    return serverDoc(await getDocFromServer(doc(db, path)));
  } catch (error) {
    return (error as { code?: unknown } | null)?.code === 'permission-denied' ? { denied: true } : null;
  }
}

// The server's answers that refuse a write: the rules, or an update of a document that is gone.
const REFUSALS = new Set(['permission-denied', 'not-found']);
const refused = (error: unknown) => REFUSALS.has(String((error as { code?: unknown } | null)?.code));

// Records an entry the server refused: rejected with the reason the server's copy of its draft and
// the person's role now give, or kept refused, its reason not known yet, when those could not be
// read (Firstmate ruling R1, 2026-11-17). Either way it is never sent again. True when the reason is
// known.
async function refuse(client: FieldClient, entry: JournalEntry): Promise<boolean> {
  const [draft, role] = await Promise.all([readServer(client.db, entry.draftPath), roleNow(client)]);
  const reason = refusalReason(draft, entry.uid, role);
  await (reason ? rejectEntry(entry, reason) : markRefused(entry));
  return reason !== null;
}

function follow(client: FieldClient, entry: JournalEntry, acknowledged: Promise<void>): void {
  const person = personKey(entry);
  if (!judgedHere.has(person)) sentHere.set(person, [...(sentHere.get(person) ?? []), entry]);
  acknowledged
    .then(
      async () => {
        await removeEntry(entry);
        void settle(client).catch(() => undefined);
      },
      async (error: unknown) => {
        if (!refused(error)) return;
        const kept = sentHere.get(person);
        if (kept) sentHere.set(person, kept.filter((sent) => sent !== entry));
        await refuse(client, entry);
      },
    )
    .catch((error: unknown) => lose(person, error));
}

// Hands an entry's writes to Firestore (./local-edit.ts), answering at the local receipt. `handed`
// says whether the writes reached the SDK at all; once they did, their promise answers for the entry.
async function send(client: FieldClient, ref: DraftRef, entry: JournalEntry): Promise<{ acknowledged: Promise<void> } | { error: unknown; handed: boolean }> {
  const sent: { made?: Promise<void> } = {};
  try {
    const receipt = await queueFieldEdit(client, ref, (db) => (sent.made = applyWrites(db, entry.writes)));
    follow(client, entry, receipt.acknowledged);
    return receipt;
  } catch (error) {
    if (sent.made) follow(client, entry, sent.made);
    return { error, handed: sent.made !== undefined };
  }
}

// A field edit from a screen: the unsent mark, then the journal entry with its bases (journal.ts
// whileAdding, so the mark is not cleared before the entry is there), then the edit
// (./local-edit.ts, which answers at the local receipt). Throws UnsentMarkNotSaved, JournalNotSaved
// or ReopenTheApp, and makes nothing, when the mark or the entry could not be saved.
export async function journaledEdit(client: FieldClient, ref: DraftRef, writes: DocWrite[]): Promise<{ acknowledged: Promise<void> }> {
  if (client.cache !== 'persistent') return queueFieldEdit(client, ref, (db) => applyWrites(db, writes));
  const owner = ownerOf(client);
  const person = personKey(owner);
  const entry = await whileAdding(owner, async () => {
    if (noteWrite(owner.tenantId, owner.uid) === null) throw new UnsentMarkNotSaved();
    const added = await appendEntry(owner, draftPath(ref), writes, await basesOf(client.db, writes));
    if (!judgedHere.has(person)) madeHere.set(person, (madeHere.get(person) ?? new Set<number>()).add(added.seq));
    return added;
  });
  const sent = await send(client, ref, entry);
  if ('acknowledged' in sent) return sent;
  // Never handed to Firestore: no entry.
  if (!sent.handed) void removeEntry(entry).catch(() => undefined);
  throw sent.error;
}

// Makes again the entries judged as never landed, in one transaction per draft that reads their
// documents from the server first: entries whose documents the server still holds as when they were
// made are written, oldest first, and pruned; the others are kept as changed. A later write to those
// documents fails the transaction's preconditions, so nothing newer is ever overwritten. A draft the
// rules refuse rejects its entries. False when the server did not answer: judged again later.
async function remake(client: FieldClient, entries: JournalEntry[]): Promise<boolean> {
  const byDraft = new Map<string, JournalEntry[]>();
  for (const entry of entries) byDraft.set(entry.draftPath, [...(byDraft.get(entry.draftPath) ?? []), entry]);
  let complete = true;
  for (const group of byDraft.values()) {
    let made: JournalEntry[];
    try {
      made = await runTransaction(client.db, async (transaction) => {
        const docs = new Map<string, ServerDoc>();
        for (const path of new Set(group.flatMap((entry) => entry.writes.map((write) => write.path)))) {
          docs.set(path, serverDoc(await transaction.get(doc(client.db, path))));
        }
        const untouched = group.filter((entry) => untouchedSince(entry, docs));
        stageWrites(client.db, transaction, untouched.flatMap((entry) => entry.writes));
        return untouched;
      });
    } catch (error) {
      if (!refused(error)) complete = false;
      else for (const entry of group) if (!(await refuse(client, entry))) complete = false;
      continue;
    }
    for (const entry of group) await (made.includes(entry) ? removeEntry(entry) : markChanged(entry));
  }
  return complete;
}

const judging = new Map<string, Promise<void>>();

// Once per page and person, when the sync gate opens: what became of the entries an earlier page
// left pending. Waits for Firestore to send its queue, then reads each entry's documents and draft
// from the server, asks the server for the person's role, and judges them against everything this
// page has sent up to then. Entries that never landed are made again here (remake). Entries the
// server refused before their reason could be read are classified now from the same reads, and
// never sent. An entry whose documents (or role) did not all answer stays as it is; the next opening
// of the gate on this page tries again.
export function reconcileJournal(client: FieldClient): Promise<void> {
  const owner = ownerOf(client);
  const key = personKey(owner);
  if (client.cache !== 'persistent' || judgedHere.has(key)) return Promise.resolve();
  const found = judging.get(key);
  if (found) return found;
  const done = () => {
    judgedHere.add(key);
    sentHere.delete(key);
    madeHere.delete(key);
  };
  const earlier = (entry: JournalEntry) => entry.state === 'pending' && !madeHere.get(key)?.has(entry.seq);
  const run = (async () => {
    const entries = await readJournal(owner);
    let judged = entries.filter(earlier);
    const unresolved = entries.filter((entry) => entry.state === 'refused');
    if (judged.length === 0 && unresolved.length === 0) return done();
    await waitForPendingWrites(client.db);
    const paths = [
      ...new Set([...judged.flatMap((entry) => [entry.draftPath, ...entry.writes.map((write) => write.path)]), ...unresolved.map((entry) => entry.draftPath)]),
    ];
    const read = new Map<string, ServerDoc>();
    await Promise.all(
      paths.map(async (path) => {
        const answer = await readServer(client.db, path);
        if (answer) read.set(path, answer);
      }),
    );
    const role = await roleNow(client);
    judged = judged.filter(earlier);
    const outcomes = judge(judged, sentHere.get(key) ?? [], read, read, owner.uid, role);
    let complete = true;
    for (const entry of unresolved) {
      const reason = refusalReason(read.get(entry.draftPath) ?? null, owner.uid, role);
      if (reason) await rejectEntry(entry, reason);
      else complete = false;
    }
    const reissued: JournalEntry[] = [];
    for (const entry of judged) {
      const outcome = outcomes.get(entry.seq);
      if (!outcome) complete = false;
      else if (outcome.kind === 'acked') await removeEntry(entry);
      else if (outcome.kind === 'rejected') await rejectEntry(entry, outcome.reason);
      else if (outcome.kind === 'changed') await markChanged(entry);
      else reissued.push(entry);
    }
    if (!(await remake(client, reissued))) complete = false;
    if (complete) done();
    void settle(client).catch(() => undefined);
  })()
    .catch((error: unknown) => lose(key, error))
    .finally(() => judging.delete(key));
  judging.set(key, run);
  return run;
}
