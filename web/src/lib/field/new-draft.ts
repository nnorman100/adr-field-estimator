// Save as new draft (S6-4b; docs/plans/S6/S6-4.md): refused edits of a job that was archived (410)
// or whose field work moved to another person (owner decision J5) go into a new job of their own.
// The new job copies the draft as this phone's cache holds it (the job-level field map and the
// rooms), with the refused edits made on top of it, in the order they were made. Never after the
// person's own Finish, also when that job was archived after: that path is Back to editing (J4). The
// server is asked first (journal-sync.ts refusalNow), never the reason last recorded.
//
// The new job's and draft's ids come from the person and the draft the edits were refused for
// (newDraftIds), so they are chosen before the first send, survive a closed app with nothing more to
// store, and every try for that draft makes one job (POST /api/jobs answers the same job for the
// same ids and body), also when a later refusal joins the edits. What the copy put into the new draft
// is recorded on the phone (journal.ts saveCopy). A later recovery into it writes the later refused
// edits only, and each field only while the new draft still holds what the copy put there (journal.ts
// mergeFields, checked in the transaction that writes them): a field changed since keeps its value
// and is kept here as changed on another device. The first copy is judged the same way against the
// new draft as POST /api/jobs makes it, so a copy that landed before its record was saved is not
// written again.
// Photo references are not copied: a photo id is registered to its job and cannot be used under
// another one, and photo bytes are not kept on the phone until the photo queue (S6-5).
import { collection, doc, getDocFromCache, getDocFromServer, getDocsFromCache, runTransaction } from 'firebase/firestore';
import { fieldUser, type FieldClient } from '@/lib/field-db';
import { createJob } from './api';
import { discardEntries, refusalNow } from './journal-sync';
import { appendEntry, jobOf, mergeFields, readCopy, rejectEntry, saveCopy, type DocWrite, type JournalEntry, type Owner } from './journal';
import { draftPath, stageWrites, type DraftRef } from './store';

function uuidOf(bytes: Uint8Array): string {
  const b = Uint8Array.from(bytes.subarray(0, 16));
  // Shaped as a version 4 UUID, as the jobs API checks.
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = [...b].map((n) => n.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// The new job's and draft's ids for the person's refused edits of one draft: the same person and
// draft always give the same ids.
export async function newDraftIds(owner: Owner, draftPath: string): Promise<{ jobId: string; draftId: string }> {
  const text = JSON.stringify({ tenantId: owner.tenantId, uid: owner.uid, draftPath });
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return { jobId: uuidOf(digest.subarray(0, 16)), draftId: uuidOf(digest.subarray(16, 32)) };
}

// The cached draft as it was read: its `field` map and its room documents' `field` maps by id.
export type CachedDraft = { field: Record<string, unknown>; rooms: { id: string; field: Record<string, unknown> }[] };

// The refused edits moved onto the new draft, in the order they were made, without a photo reference.
function movedWrites(entries: readonly JournalEntry[], oldPath: string, newPath: string): DocWrite[] {
  const moved = (path: string) => (path === oldPath ? newPath : path.startsWith(`${oldPath}/`) ? `${newPath}${path.slice(oldPath.length)}` : null);
  const writes: DocWrite[] = [];
  for (const entry of [...entries].sort((a, b) => a.seq - b.seq)) {
    for (const write of entry.writes) {
      const path = moved(write.path);
      if (path !== null && !path.startsWith(`${newPath}/photos/`)) writes.push({ ...write, path });
    }
  }
  return writes;
}

// The writes that make the new draft: the cached field map, each cached room as it is, then the
// refused edits moved onto the new draft. A photo reference is left out. null when the room order
// they end with names a room they do not hold (the cache holds only part of the draft): such a copy
// could not be opened.
export function copyWrites(cached: CachedDraft, entries: readonly JournalEntry[], oldPath: string, newPath: string): DocWrite[] | null {
  const fields = Object.fromEntries(Object.entries(cached.field).map(([key, value]) => [`field.${key}`, value]));
  const writes: DocWrite[] = [];
  if (Object.keys(fields).length > 0) writes.push({ path: newPath, op: 'update', fields });
  for (const room of cached.rooms) writes.push({ path: `${newPath}/rooms/${room.id}`, op: 'set', data: { field: room.field } });
  writes.push(...movedWrites(entries, oldPath, newPath));
  const rooms = new Set<string>();
  let order: unknown = undefined;
  for (const write of writes) {
    if (write.path === newPath && write.op === 'update' && Object.hasOwn(write.fields, 'field.roomOrder')) order = write.fields['field.roomOrder'];
    const room = write.path.startsWith(`${newPath}/rooms/`) ? write.path.slice(`${newPath}/rooms/`.length) : null;
    if (room !== null) {
      if (write.op === 'delete') rooms.delete(room);
      else rooms.add(room);
    }
  }
  if (order !== undefined && order !== null && (!Array.isArray(order) || order.some((id) => typeof id !== 'string' || !rooms.has(id)))) return null;
  return writes;
}

export type SaveAsNew =
  | { kind: 'saved'; jobId: string }
  // The draft is not kept on this phone, so there is nothing to copy.
  | { kind: 'not-kept' }
  // No answer from the server: the same ids are sent again on the next try.
  | { kind: 'no-answer' }
  | { kind: 'refused'; message: string };

const NOT_NOW = 'This job takes these changes again now: use Try again.';
const ELIGIBLE: ReadonlySet<string> = new Set(['archived', 'owner-changed']);

async function cachedDraft(client: FieldClient, path: string): Promise<CachedDraft | null> {
  try {
    const draft = await getDocFromCache(doc(client.db, path));
    if (!draft.exists()) return null;
    const rooms = await getDocsFromCache(collection(client.db, path, 'rooms'));
    const field = (draft.data().field ?? {}) as Record<string, unknown>;
    return { field, rooms: rooms.docs.map((room) => ({ id: room.id, field: (room.data().field ?? {}) as Record<string, unknown> })) };
  } catch {
    return null;
  }
}

// The first copy's writes (copyWrites) from the cached draft; null when the draft is not kept here.
async function firstCopy(client: FieldClient, entries: readonly JournalEntry[], oldPath: string, newPath: string): Promise<DocWrite[] | null> {
  const cached = await cachedDraft(client, oldPath);
  return cached ? copyWrites(cached, entries, oldPath, newPath) : null;
}

// Asks the server whether these refused edits of one draft may still go into a new draft (archived
// while being edited, or the field work moved); makes the new job (POST /api/jobs, which makes its
// draft with this person as its field owner); writes the copy, or a later recovery, into it in one
// transaction (journal.ts mergeFields), records what it put there, keeps each field changed since as
// changed on another device, then drops the refused entries: the server has the work now.
export async function saveAsNewDraft(client: FieldClient, entries: readonly JournalEntry[]): Promise<SaveAsNew> {
  const first = entries[0];
  const user = fieldUser(client.person);
  const companyId = first ? /^companies\/([^/]+)\//.exec(first.draftPath)?.[1] : undefined;
  if (!first || !user || !companyId) return { kind: 'no-answer' };
  const reason = await refusalNow(client, first.draftPath, jobOf(entries));
  if (reason === 'no-answer') return { kind: 'no-answer' };
  if (reason === null) return { kind: 'refused', message: NOT_NOW };
  if (!ELIGIBLE.has(reason)) {
    for (const entry of entries) await rejectEntry(entry, reason);
    return { kind: 'refused', message: 'These changes cannot be saved as a new draft: the reason above changed.' };
  }
  const owner: Owner = { tenantId: client.person.tenantId, uid: client.person.uid };
  const { jobId, draftId } = await newDraftIds(owner, first.draftPath);
  const ref: DraftRef = { companyId, draftId };
  const newPath = draftPath(ref);
  const record = await readCopy(owner, newPath);
  const writes = record ? movedWrites(entries, first.draftPath, newPath) : await firstCopy(client, entries, first.draftPath, newPath);
  if (!writes) return { kind: 'not-kept' };
  const answer = await createJob(user, { id: jobId, draftId, propertyAddress: '' });
  if (!answer.ok) return answer.status === 0 || answer.status >= 500 ? { kind: 'no-answer' } : { kind: 'refused', message: answer.message };
  // Before the first copy, the new draft as POST /api/jobs makes it.
  const base = record ?? new Map([[newPath, { field: {} }]]);
  let plan: ReturnType<typeof mergeFields>;
  try {
    plan = await runTransaction(client.db, async (transaction) => {
      const server = new Map<string, Record<string, unknown> | null>();
      for (const path of new Set(writes.map((write) => write.path))) {
        const snapshot = await transaction.get(doc(client.db, path));
        server.set(path, snapshot.exists() ? snapshot.data() : null);
      }
      const found = mergeFields(writes, base, server);
      stageWrites(client.db, transaction, found.write);
      return found;
    });
  } catch {
    return { kind: 'no-answer' };
  }
  await saveCopy(owner, newPath, plan.copied);
  for (const field of plan.changed) await appendEntry(owner, newPath, [field], {}, { jobId, state: 'changed' });
  // The new draft into this phone's cache, so its screen opens on it.
  await getDocFromServer(doc(client.db, newPath)).catch(() => undefined);
  await discardEntries(client, entries);
  return { kind: 'saved', jobId };
}
