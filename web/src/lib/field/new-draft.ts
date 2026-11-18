// Save as new draft (S6-4b; docs/plans/S6/S6-4.md): refused edits of a job that was archived (410)
// or whose field work moved to another person (owner decision J5) go into a new job of their own.
// The new job copies the draft as this phone's cache holds it (the job-level field map and the
// rooms), with the refused edits made on top of it, in the order they were made. Never after the
// person's own Finish: that path is Back to editing (J4).
//
// The new job's and draft's ids come from the refused entries themselves (newDraftIds), so they are
// chosen before the first send, survive a closed app with nothing more to store, and the same
// entries saved twice make one job (POST /api/jobs answers the same job for the same ids and body).
// Photo references are not copied: a photo id is registered to its job and cannot be used under
// another one, and photo bytes are not kept on the phone until the photo queue (S6-5).
import { collection, doc, getDocFromCache, getDocFromServer, getDocsFromCache } from 'firebase/firestore';
import { fieldUser, type FieldClient } from '@/lib/field-db';
import { COPY_CLEARED_KEYS } from '@/lib/jobs/archive';
import { createJob } from './api';
import { discardEntries, journaledEdit } from './journal-sync';
import type { DocWrite, JournalEntry, Owner } from './journal';
import { draftPath, type DraftRef } from './store';

function uuidOf(bytes: Uint8Array): string {
  const b = Uint8Array.from(bytes.subarray(0, 16));
  // Shaped as a version 4 UUID, as the jobs API checks.
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = [...b].map((n) => n.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// The new job's and draft's ids for these refused entries of one draft: the same entries always give
// the same ids.
export async function newDraftIds(owner: Owner, entries: readonly Pick<JournalEntry, 'id' | 'draftPath'>[]): Promise<{ jobId: string; draftId: string }> {
  const ids = entries.map((entry) => entry.id).sort();
  const text = JSON.stringify({ tenantId: owner.tenantId, uid: owner.uid, draftPath: entries[0]?.draftPath ?? '', ids });
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return { jobId: uuidOf(digest.subarray(0, 16)), draftId: uuidOf(digest.subarray(16, 32)) };
}

// The cached draft as it was read: its `field` map and its room documents' `field` maps by id.
export type CachedDraft = { field: Record<string, unknown>; rooms: { id: string; field: Record<string, unknown> }[] };

// The writes that make the new draft: the cached field map (without the approval a copy clears, as
// S5b-2's copy does), each cached room as it is, then the refused edits moved onto the new draft.
// A photo reference is left out.
export function copyWrites(cached: CachedDraft, entries: readonly JournalEntry[], oldPath: string, newPath: string): DocWrite[] {
  const moved = (path: string) => (path === oldPath ? newPath : path.startsWith(`${oldPath}/`) ? `${newPath}${path.slice(oldPath.length)}` : null);
  const cleared = new Set<string>(COPY_CLEARED_KEYS.map((key) => `field.${key}`));
  const fields = Object.fromEntries(
    Object.entries(cached.field)
      .map(([key, value]) => [`field.${key}`, value] as const)
      .filter(([key]) => !cleared.has(key)),
  );
  const writes: DocWrite[] = [];
  if (Object.keys(fields).length > 0) writes.push({ path: newPath, op: 'update', fields });
  for (const room of cached.rooms) writes.push({ path: `${newPath}/rooms/${room.id}`, op: 'set', data: { field: room.field } });
  for (const entry of [...entries].sort((a, b) => a.seq - b.seq)) {
    for (const write of entry.writes) {
      const path = moved(write.path);
      if (path === null || path.startsWith(`${newPath}/photos/`)) continue;
      if (write.op === 'update') {
        const kept = Object.fromEntries(Object.entries(write.fields).filter(([key]) => !(path === newPath && cleared.has(key))));
        if (Object.keys(kept).length > 0) writes.push({ ...write, path, fields: kept });
      } else writes.push({ ...write, path });
    }
  }
  return writes;
}

export type SaveAsNew =
  | { kind: 'saved'; jobId: string }
  // The draft is not kept on this phone, so there is nothing to copy.
  | { kind: 'not-kept' }
  // No answer from the server: the same ids are sent again on the next try.
  | { kind: 'no-answer' }
  | { kind: 'refused'; message: string };

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

// Makes the new job (POST /api/jobs, which makes its draft with this person as its field owner),
// writes the copy into it as one journaled edit, then drops the refused entries: the work is now the
// new draft's, kept on the phone until the server has it.
export async function saveAsNewDraft(client: FieldClient, entries: readonly JournalEntry[]): Promise<SaveAsNew> {
  const first = entries[0];
  const user = fieldUser(client.person);
  if (!first || !user) return { kind: 'no-answer' };
  const cached = await cachedDraft(client, first.draftPath);
  if (!cached) return { kind: 'not-kept' };
  const owner = { tenantId: client.person.tenantId, uid: client.person.uid };
  const { jobId, draftId } = await newDraftIds(owner, entries);
  const answer = await createJob(user, { id: jobId, draftId, propertyAddress: '' });
  if (!answer.ok) return answer.status === 0 || answer.status >= 500 ? { kind: 'no-answer' } : { kind: 'refused', message: answer.message };
  const companyId = /^companies\/([^/]+)\//.exec(first.draftPath)?.[1];
  if (!companyId) return { kind: 'no-answer' };
  const ref: DraftRef = { companyId, draftId };
  const newPath = draftPath(ref);
  try {
    // The new draft into this phone's cache first, so the edit has a draft to land on.
    await getDocFromServer(doc(client.db, newPath));
    await journaledEdit(client, ref, copyWrites(cached, entries, first.draftPath, newPath));
  } catch {
    return { kind: 'no-answer' };
  }
  await discardEntries(client, entries);
  return { kind: 'saved', jobId };
}
