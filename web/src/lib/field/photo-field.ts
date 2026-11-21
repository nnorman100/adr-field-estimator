import { doc, getDocFromServer } from 'firebase/firestore';
import { fieldUser, settle, type FieldClient } from '@/lib/field-db';
import { sendQueuedPhoto } from './api';
import { canonicalJson } from './canonical';
import { journaledEdit, readEntries } from './journal-sync';
import { acknowledgeQueuedPhoto, readPhotoQueue, startPhotoQueue, whilePhotoQueueIdle, type PhotoOwner, type PhotoQueueEntry } from './photo-queue';
import { discardQueuedPhotos, hasPhotoBytes } from './photo-queue-storage';
import { pending } from './pending';
import { fieldRefusal, photoRefWrites } from './store';
import { queuedPhotoDone, readUnsent } from './unsent';

// Firestore owns the write once it has been handed off. A cancelled upload drainer stops waiting,
// while the existing journal still records the outcome when the SDK gets it.
function whileAvailable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancelled = () => reject(signal.reason);
    if (signal.aborted) cancelled();
    else signal.addEventListener('abort', cancelled, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancelled));
  });
}

export async function hasWaitingPhotos(owner: PhotoOwner, jobId: string, draftId: string): Promise<boolean> {
  const mark = readUnsent(owner.tenantId, owner.uid);
  if (mark !== 'unreadable' && !mark.queuedPhotos?.length) return false;
  return (await readPhotoQueue(owner)).some(
    (entry) => entry.jobId === jobId && entry.draftId === draftId && entry.kind === 'photo' && entry.stage !== 'done',
  );
}

type Result = { kind: 'acknowledged' } | { kind: 'retry' } | { kind: 'sign-in' } | { kind: 'blocked'; reason: string };

async function saveReference(
  client: FieldClient,
  companyId: string,
  entry: PhotoQueueEntry,
  written: () => Promise<void>,
  signal: AbortSignal,
  canWrite: () => boolean,
): Promise<Result> {
  const ref = { companyId, draftId: entry.draftId };
  const writes = photoRefWrites(ref, entry.photoId, entry.field);
  const path = writes[0]!.path;
  try {
    // The response may have been lost after the SDK committed the reference or after the journal
    // pruned its entry. Only a server read can settle that case.
    const current = await whileAvailable(getDocFromServer(doc(client.db, path)), signal);
    if (current.metadata.hasPendingWrites) return { kind: 'retry' };
    if (current.exists()) {
      if (canonicalJson(current.data().field) !== canonicalJson(entry.field)) {
        return { kind: 'blocked', reason: 'This photo has different details on the server.' };
      }
      await written();
      return { kind: 'acknowledged' };
    }
    const existing = (await whileAvailable(readEntries(client), signal)).find((record) => record.writes.some((write) => write.path === path));
    if (existing) {
      return existing.state === 'pending'
        ? { kind: 'retry' }
        : { kind: 'blocked', reason: 'The photo is stored. Its room and tag could not be saved.' };
    }
    signal.throwIfAborted();
    if (!canWrite()) return { kind: 'retry' };
    const edit = await whileAvailable(journaledEdit(client, ref, writes, entry.jobId, new Map([[path, null]])), signal);
    // The journal keeps following the server promise even when the phone goes offline.
    void edit.acknowledged.catch(() => undefined);
    await written();
    await whileAvailable(edit.acknowledged, signal);
    return { kind: 'acknowledged' };
  } catch (error) {
    if (signal.aborted) return { kind: 'retry' };
    const refusal = fieldRefusal(error);
    if (refusal?.status === 401) return { kind: 'sign-in' };
    if (refusal) return { kind: 'blocked', reason: refusal.message };
    return { kind: 'retry' };
  }
}

export function mountFieldPhotos(client: FieldClient, company: () => string | null, signInRequired: () => void) {
  return startPhotoQueue(client.person, {
    canSend: () => company() !== null && fieldUser(client.person) !== null,
    async upload(entry, bytes, signal) {
      const user = fieldUser(client.person);
      if (!user || user.uid !== entry.uid) return { kind: 'failure', status: 401, reason: 'Sign in again to continue.' };
      const answer = await whileAvailable(sendQueuedPhoto(user, entry, bytes, signal), signal);
      return answer.ok ? { kind: 'receipt', ...answer.value } : {
        kind: 'failure', status: answer.status, reason: answer.message, code: answer.code, retryAfter: answer.retryAfter,
      };
    },
    async reference(entry, written, signal) {
      const companyId = company();
      if (!companyId) return { kind: 'retry' };
      const result = await saveReference(client, companyId, entry, written, signal, () => company() === companyId);
      if (result.kind === 'acknowledged') pending.draftChanged(entry.jobId);
      return result;
    },
    changed(_photoId, sending) {
      if (!sending) void settle(client).catch(() => undefined);
    },
    signInRequired,
  });
}

export async function finishRecoveredPhotos(
  client: FieldClient,
  jobId: string,
  draftId: string,
  ids: ReadonlySet<string>,
  action: 'acknowledge' | 'discard',
): Promise<void> {
  const owner = client.person;
  if (ids.size === 0) return;
  const mark = readUnsent(owner.tenantId, owner.uid);
  if (mark !== 'unreadable' && !mark.queuedPhotos?.some((id) => ids.has(id))) return;
  const matches = (entry: PhotoQueueEntry) => entry.jobId === jobId && entry.draftId === draftId && ids.has(entry.photoId);
  const photos = (await readPhotoQueue(owner)).filter(matches);
  if (action === 'discard') {
    await whilePhotoQueueIdle(() => discardQueuedPhotos(owner, matches));
    for (const photo of photos) {
      if (!(await hasPhotoBytes(photo))) queuedPhotoDone(owner.tenantId, owner.uid, photo.photoId);
    }
  } else {
    for (const photo of photos) {
      if (photo.kind === 'photo' && photo.receipt && photo.stage !== 'done') await acknowledgeQueuedPhoto(photo);
    }
  }
  void settle(client).catch(() => undefined);
}
