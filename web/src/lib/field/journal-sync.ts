// The recovery journal (./journal.ts) around the phone's Firestore client (S6-4; docs/plans/S6.md
// section 4, steps 1, 2 and 6).
//
// 1. Edit: the entry is saved first, then the writes go to Firestore. With a memory cache (Online
//    only, an iPhone browser tab, the fallback) nothing is kept on the phone, so nothing is journaled.
// 2. Acknowledge: while the page lives, the write's own promise answers. Accepted: the entry is
//    pruned. Refused by the rules: rejected, with the reason the server's copy of the draft gives.
//    No answer (the client stopped): the entry stays pending for the next start.
//    After a restart (the promise is gone): an entry still pending that never reached Firestore (the
//    page was killed between the two) is made again, as it was; then, once the sync gate has opened
//    and Firestore has sent its queue, the documents are read from the server and the newest entry
//    per document and key is compared with them (journal.ts judge).
// 6. A refused entry is never sent again, so nothing changes a submitted record.
import { doc, getDocFromServer, waitForPendingWrites, type Firestore } from 'firebase/firestore';
import { fieldWrite, type FieldClient } from '@/lib/field-db';
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
import { queueFieldEdit } from './local-edit';
import { applyWrites, draftPath, type DraftRef } from './store';

const ownerOf = (client: FieldClient): Owner => ({ tenantId: client.person.tenantId, uid: client.person.uid });
const personKey = (owner: Owner) => `${owner.tenantId}/${owner.uid}`;
const entryKey = (entry: JournalEntry) => `${personKey(entry)}/${entry.seq}`;

// Entries whose write promise this page holds: their promise answers for them.
const followed = new Set<string>();

// The server's copy of a document; null when it did not answer (asked again on a later try).
async function readServer(db: Firestore, path: string): Promise<ServerDoc | null> {
  try {
    const snapshot = await getDocFromServer(doc(db, path));
    return snapshot.exists() ? { data: snapshot.data() } : { missing: true };
  } catch (error) {
    return (error as { code?: unknown } | null)?.code === 'permission-denied' ? { denied: true } : null;
  }
}

// The server's answers that refuse a write: the rules, or an update of a document that is gone.
const REFUSALS = new Set(['permission-denied', 'not-found']);

function follow(client: FieldClient, entry: JournalEntry, acknowledged: Promise<void>): void {
  const key = entryKey(entry);
  followed.add(key);
  acknowledged
    .then(
      () => removeEntry(entry),
      async (error: unknown) => {
        if (!REFUSALS.has(String((error as { code?: unknown } | null)?.code))) return;
        const draft = await readServer(client.db, entry.draftPath);
        await rejectEntry(entry, (draft && draftRefusal(draft, entry.uid)) ?? 'refused');
      },
    )
    .catch(() => undefined)
    .finally(() => followed.delete(key));
}

// A field edit from a screen: journaled, then made (./local-edit.ts, which answers at the local
// receipt). Throws JournalNotSaved, and makes nothing, when the entry could not be saved.
export async function journaledEdit(client: FieldClient, ref: DraftRef, writes: DocWrite[]): Promise<{ acknowledged: Promise<void> }> {
  if (client.cache !== 'persistent') return queueFieldEdit(client, ref, (db) => applyWrites(db, writes));
  const entry = await appendEntry(ownerOf(client), draftPath(ref), writes);
  // Set once the writes are handed to Firestore.
  const sent: { made?: Promise<void> } = {};
  const write = (db: Firestore) => (sent.made = applyWrites(db, writes));
  try {
    const receipt = await queueFieldEdit(client, ref, write);
    void markReached(entry).catch(() => undefined);
    follow(client, entry, receipt.acknowledged);
    return receipt;
  } catch (error) {
    if (!sent.made) {
      // The edit was never handed to Firestore (the unsent mark could not be saved): no entry.
      void removeEntry(entry).catch(() => undefined);
    } else {
      void markReached(entry).catch(() => undefined);
      follow(client, entry, sent.made);
    }
    throw error;
  }
}

const reissues = new Map<string, Promise<void>>();

// Once per page and person, as the client starts: makes again every pending entry that never reached
// Firestore, oldest first, with its own values. Their promises then answer for them.
export function reissueJournal(client: FieldClient): Promise<void> {
  const owner = ownerOf(client);
  const key = personKey(owner);
  const found = reissues.get(key);
  if (found) return found;
  const run = (async () => {
    if (client.cache !== 'persistent') return;
    for (const entry of await readJournal(owner)) {
      if (entry.state !== 'pending' || entry.reached || followed.has(entryKey(entry))) continue;
      const sent: { made?: Promise<void> } = {};
      const acknowledged = fieldWrite(client, (db) => (sent.made = applyWrites(db, entry.writes)));
      if (!sent.made) {
        // The unsent mark could not be saved: nothing is made now; the next start tries again.
        void acknowledged.catch(() => undefined);
        reissues.delete(key);
        return;
      }
      void markReached(entry).catch(() => undefined);
      follow(client, entry, acknowledged);
    }
  })().catch(() => {
    reissues.delete(key);
  });
  reissues.set(key, run);
  return run;
}

const judgedHere = new Set<string>();
const judging = new Map<string, Promise<void>>();

// Once per page and person, when the sync gate opens: what became of the entries an earlier page
// left pending. Waits for Firestore to send its queue, then reads each entry's documents and draft
// from the server. An entry whose documents did not all answer stays pending, and the next opening
// of the gate on this page tries again.
export function reconcileJournal(client: FieldClient): Promise<void> {
  const owner = ownerOf(client);
  const key = personKey(owner);
  if (client.cache !== 'persistent' || judgedHere.has(key)) return Promise.resolve();
  const found = judging.get(key);
  if (found) return found;
  const run = (async () => {
    await reissueJournal(client);
    const pending = (await readJournal(owner)).filter((entry) => entry.state === 'pending');
    const judged = pending.filter((entry) => !followed.has(entryKey(entry)));
    if (judged.length === 0) {
      judgedHere.add(key);
      return;
    }
    const newer = pending.filter((entry) => followed.has(entryKey(entry)));
    await waitForPendingWrites(client.db);
    const paths = [...new Set(judged.flatMap((entry) => [entry.draftPath, ...entry.writes.map((write) => write.path)]))];
    const read = new Map<string, ServerDoc>();
    await Promise.all(
      paths.map(async (path) => {
        const answer = await readServer(client.db, path);
        if (answer) read.set(path, answer);
      }),
    );
    const outcomes = judge(judged, newer, read, read, owner.uid);
    await Promise.all(
      judged.map((entry) => {
        const outcome = outcomes.get(entry.seq);
        if (!outcome) return undefined;
        if (outcome.kind === 'acked') return removeEntry(entry);
        if (outcome.kind === 'rejected') return rejectEntry(entry, outcome.reason);
        return markChanged(entry);
      }),
    );
    if (outcomes.size === judged.length) judgedHere.add(key);
  })()
    .catch(() => undefined)
    .finally(() => judging.delete(key));
  judging.set(key, run);
  return run;
}
