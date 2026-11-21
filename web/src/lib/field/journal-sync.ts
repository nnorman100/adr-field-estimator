// The recovery journal (./journal.ts) around the phone's Firestore client (S6-4; docs/plans/S6.md
// section 4, steps 1, 2 and 6).
//
// 1. Edit: the entry is saved first, with the server's update time of each document as the phone
//    held it (its base) and what the screen held of what the edit writes, then the writes go to
//    Firestore.
//    With a memory cache (Online only, an iPhone browser tab, the fallback) nothing is kept on the
//    phone: the entry is held in this page's memory only (journal.ts journalInMemory).
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
  heldOf,
  jobDecides,
  jobOf,
  journalInMemory,
  markRefused,
  NO_ANSWER,
  refusalOf,
  judge,
  markChanged,
  readJournal,
  rejectEntry,
  removeEntry,
  retryVerdict,
  untouchedSince,
  whileAdding,
  type DocWrite,
  type Docs,
  type JobNow,
  type JournalEntry,
  type RejectReason,
  type Owner,
  type RoleNow,
  type ServerDoc,
} from './journal';
import { readJob } from './api';
import { ReopenTheApp } from './idb';
import { queueFieldEdit } from './local-edit';
import { applyWrites, draftPath, stageWrites, type DraftRef } from './store';
import { ASK_WITHIN_MS, judgeMe } from './sync-gate';
import { noteWrite } from './unsent';

// The person's journal owner; an Online only client's journal is held in this page's memory.
const ownerOf = (client: FieldClient): Owner => {
  const owner = { tenantId: client.person.tenantId, uid: client.person.uid };
  if (client.cache !== 'persistent') journalInMemory(owner);
  return owner;
};
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

// A screen's read or change of the journal failed: a connection lost twice goes to the shell.
export function journalFailed(client: FieldClient, error: unknown): void {
  lose(personKey(ownerOf(client)), error);
}

// This person's entries, oldest first.
export const readEntries = (client: FieldClient): Promise<JournalEntry[]> => readJournal(ownerOf(client));

// The person's role now (GET /api/me), which tells why the rules refuse an edit (journal.ts
// draftRefusal): null when the server refused them, NO_ANSWER when there was no answer within
// ASK_WITHIN_MS, no sign-in to ask with, or access still renewing, so nothing is classified on a guess.
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
      return verdict.kind === 'open' ? verdict.facts.role : verdict.kind === 'locked' ? null : NO_ANSWER;
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

// What the jobs API says of the job now (journal.ts JobNow).
async function jobNow(client: FieldClient, jobId: string | null): Promise<JobNow> {
  if (!jobId) return null;
  const user = fieldUser(client.person);
  if (!user) return NO_ANSWER;
  const answer = await readJob(user, jobId).catch(() => null);
  if (!answer) return NO_ANSWER;
  if (answer.ok) return { status: answer.value.job.status, currentDraftId: answer.value.job.currentDraftId };
  if (answer.status === 410) return 'gone';
  return answer.denied ? 'denied' : NO_ANSWER;
}

type Classified = { reason: RejectReason | null | 'unknown'; jobId: string | null };

// Why the server refuses this person's edits to the draft at `path` now (journal.ts refusalOf), from
// its copy of the draft (`draft`, read here when not given), the person's role (`role`, likewise) and,
// when those leave it open, the job: `jobId`, else the one the draft names. `jobId` in the answer:
// the given one, else the one the server's copy of the draft names (null: neither).
async function classify(
  client: FieldClient,
  path: string,
  jobId: string | null,
  read?: { draft: ServerDoc | null; role: RoleNow },
): Promise<Classified> {
  const [draft, role]: [ServerDoc | null, RoleNow] = read ? [read.draft, read.role] : await Promise.all([readServer(client.db, path), roleNow(client)]);
  const uid = client.person.uid;
  const job = jobId ?? (draft && 'data' in draft && typeof draft.data.jobId === 'string' ? draft.data.jobId : null);
  if (!jobDecides(draft, uid, role)) return { reason: refusalOf(draft, path, uid, role, null), jobId: job };
  return { reason: refusalOf(draft, path, uid, role, await jobNow(client, job)), jobId: job };
}

// Records an entry the server refused: refused at once, so it is never sent again, also when the page
// closes before its reason is read; then rejected with the reason the server gives now (classify),
// or kept refused, its reason not known yet, when that could not be read (Firstmate ruling R1,
// 2026-11-17). True when the reason is known.
async function refuse(client: FieldClient, entry: JournalEntry): Promise<boolean> {
  await markRefused(entry);
  const { reason, jobId } = await classify(client, entry.draftPath, entry.jobId ?? null);
  if (!reason || reason === 'unknown') return false;
  await rejectEntry(entry, reason, jobId);
  return true;
}

function follow(client: FieldClient, entry: JournalEntry, acknowledged: Promise<void>): void {
  const person = personKey(entry);
  if (client.cache === 'persistent' && !judgedHere.has(person)) sentHere.set(person, [...(sentHere.get(person) ?? []), entry]);
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

// A field edit from a screen of the job `jobId`, built on `held`, the draft's documents as that screen
// held them (store.ts draftDocs): the unsent mark, then the journal entry with its bases and what the
// screen held of what it writes (journal.ts whileAdding, so the mark is not cleared before the entry
// is there), then the edit (./local-edit.ts, which answers at the local receipt). Throws
// UnsentMarkNotSaved, JournalNotSaved or ReopenTheApp, and makes nothing, when the mark or the entry
// could not be saved. An Online only client's entry is held in memory, with no mark.
export async function journaledEdit(client: FieldClient, ref: DraftRef, writes: DocWrite[], jobId: string | null, held: Docs): Promise<{ acknowledged: Promise<void> }> {
  const owner = ownerOf(client);
  const person = personKey(owner);
  const more = { before: heldOf(writes, held), ...(jobId ? { jobId } : {}) };
  const entry =
    client.cache !== 'persistent'
      ? await appendEntry(owner, draftPath(ref), writes, {}, more)
      : await whileAdding(owner, async () => {
          if (noteWrite(owner.tenantId, owner.uid) === null) throw new UnsentMarkNotSaved();
          const added = await appendEntry(owner, draftPath(ref), writes, await basesOf(client.db, writes), more);
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

// Each time the sync gate opens. Entries the server refused before their reason could be read are
// classified now (classify), and never sent; one still unread stays refused, for the next opening.
// So is an entry rejected before its job was kept (S6-4a), with the job the server's draft names.
// Once per page and person (with a cache that keeps entries on the phone), also what became of the
// entries an earlier page left pending: waits for Firestore to send its queue, then reads each
// entry's documents and draft from the server, asks the server for the person's role, and judges
// them against everything this page has sent up to then. A draft the server refuses now (classify,
// with the job's 410) rejects its entries; entries that never landed are made again here (remake).
// An entry whose documents (or role) did not all answer stays as it is; the next opening of the gate
// on this page tries again.
export function reconcileJournal(client: FieldClient): Promise<void> {
  const owner = ownerOf(client);
  const key = personKey(owner);
  const found = judging.get(key);
  if (found) return found;
  const replay = client.cache === 'persistent' && !judgedHere.has(key);
  const done = () => {
    judgedHere.add(key);
    sentHere.delete(key);
    madeHere.delete(key);
  };
  const earlier = (entry: JournalEntry) => entry.state === 'pending' && !madeHere.get(key)?.has(entry.seq);
  const run = (async () => {
    const entries = await readJournal(owner);
    let judged = replay ? entries.filter(earlier) : [];
    const unresolved = entries.filter((entry) => entry.state === 'refused' || (entry.state === 'rejected' && !entry.jobId));
    if (judged.length === 0 && unresolved.length === 0) {
      if (replay) done();
      return;
    }
    if (judged.length > 0) await waitForPendingWrites(client.db);
    const drafts = [...new Set([...judged, ...unresolved].map((entry) => entry.draftPath))];
    const paths = [...new Set([...drafts, ...judged.flatMap((entry) => entry.writes.map((write) => write.path))])];
    const read = new Map<string, ServerDoc>();
    await Promise.all(
      paths.map(async (path) => {
        const answer = await readServer(client.db, path);
        if (answer) read.set(path, answer);
      }),
    );
    const role = await roleNow(client);
    judged = judged.filter(earlier);
    const reasons = new Map<string, Classified>();
    for (const path of drafts) {
      const mine = [...judged, ...unresolved].filter((entry) => entry.draftPath === path);
      reasons.set(path, await classify(client, path, jobOf(mine), { draft: read.get(path) ?? null, role }));
    }
    const outcomes = judge(judged, sentHere.get(key) ?? [], read, read, owner.uid, role);
    let complete = true;
    for (const entry of unresolved) {
      const { reason, jobId } = reasons.get(entry.draftPath)!;
      if (reason && reason !== 'unknown') await rejectEntry(entry, reason, jobId);
    }
    const reissued: JournalEntry[] = [];
    for (const entry of judged) {
      const { reason, jobId } = reasons.get(entry.draftPath)!;
      const outcome = outcomes.get(entry.seq);
      if (reason === 'unknown' || !outcome) complete = false;
      else if (reason) await rejectEntry(entry, reason, jobId);
      else if (outcome.kind === 'acked') await removeEntry(entry);
      else if (outcome.kind === 'changed') await markChanged(entry);
      else if (outcome.kind === 'reissue') reissued.push(entry);
    }
    if (!(await remake(client, reissued))) complete = false;
    if (replay && complete) done();
    void settle(client).catch(() => undefined);
  })()
    .catch((error: unknown) => lose(key, error))
    .finally(() => judging.delete(key));
  judging.set(key, run);
  return run;
}

// ---- What the "Can't save" sheet does with a set of refused edits (S6-4b) ----

// Why the server refuses this person's edits to the draft now (classify): a fresh check of their
// access, the server's copy of the draft and, where it decides, the job. null: it takes them now;
// 'no-answer' when one of those did not answer.
export async function refusalNow(client: FieldClient, path: string, jobId: string | null): Promise<RejectReason | null | 'no-answer'> {
  const { reason } = await classify(client, path, jobId);
  return reason === 'unknown' ? 'no-answer' : reason;
}

// Try again for refused edits of one draft. Still refused: each entry keeps the reason the server
// now gives ('refused'). Not any more: in one transaction that reads their documents from the server,
// the edits are made again, in the order they were made, only while the server still holds what
// they were made against ('sent'; 'sent' too when it already holds them). Anything else changed
// since: they are kept as changed on another device ('changed'), never sent over newer work.
// 'no-answer' when the server did not answer: nothing changes.
export async function tryAgain(client: FieldClient, entries: readonly JournalEntry[]): Promise<'sent' | 'refused' | 'changed' | 'no-answer'> {
  const first = entries[0];
  if (!first) return 'no-answer';
  const reason = await refusalNow(client, first.draftPath, jobOf(entries));
  if (reason === 'no-answer') return 'no-answer';
  if (reason) {
    for (const entry of entries) await rejectEntry(entry, reason);
    return 'refused';
  }
  let verdict: 'held' | 'write' | 'changed';
  try {
    verdict = await runTransaction(client.db, async (transaction) => {
      const server = new Map<string, Record<string, unknown> | null>();
      for (const path of new Set(entries.flatMap((entry) => entry.writes.map((write) => write.path)))) {
        const snapshot = await transaction.get(doc(client.db, path));
        server.set(path, snapshot.exists() ? snapshot.data() : null);
      }
      const found = retryVerdict(entries, server);
      if (found === 'write') stageWrites(client.db, transaction, [...entries].sort((a, b) => a.seq - b.seq).flatMap((entry) => entry.writes));
      return found;
    });
  } catch (error) {
    if (!refused(error)) return 'no-answer';
    const now = await refusalNow(client, first.draftPath, jobOf(entries));
    if (now === null || now === 'no-answer') return 'no-answer';
    for (const entry of entries) await rejectEntry(entry, now);
    return 'refused';
  }
  if (verdict === 'changed') {
    for (const entry of entries) await markChanged(entry);
    return 'changed';
  }
  for (const entry of entries) await removeEntry(entry);
  void settle(client).catch(() => undefined);
  return 'sent';
}

// Discard: the edits are dropped from the phone. Only these entries go; the server keeps what it has.
export async function discardEntries(client: FieldClient, entries: readonly JournalEntry[]): Promise<void> {
  for (const entry of entries) await removeEntry(entry);
  void settle(client).catch(() => undefined);
}
