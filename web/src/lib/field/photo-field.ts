import { doc, getDocFromServer } from 'firebase/firestore';
import { fieldUser, settle, type FieldClient } from '@/lib/field-db';
import { sendQueuedPhoto } from './api';
import { canonicalJson } from './canonical';
import { ReopenTheApp } from './idb';
import type { RejectReason } from './journal';
import { journaledEdit, journalFailed, readEntries, refusalNow } from './journal-sync';
import {
  acknowledgeQueuedPhoto,
  readPhotoQueue,
  resumeQueuedPhoto,
  startPhotoQueue,
  whilePhotoQueueIdle,
  type PhotoOwner,
  type PhotoQueueEntry,
} from './photo-queue';
import { discardQueuedPhotos, hasPhotoBytes } from './photo-queue-storage';
import { pending } from './pending';
import { draftPath, fieldRefusal, photoRefWrites } from './store';
import type { GateState } from './sync-gate';
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

// The company photos may be sent to: the one the open gate names, and only for a person whose role takes photos.
export function photoCompanyOf(state: GateState): string | null {
  return state.kind === 'open' && state.facts.capabilities.includes('photos') ? state.facts.companyId : null;
}

// Why the server refused a photo's job, in the words the Photos screen shows.
const REFUSAL_TEXT: Record<RejectReason, string> = {
  locked: 'This job was finished.',
  archived: 'This job was archived.',
  'owner-changed': 'Another person owns this job’s field work now.',
  'role-changed': 'Your role no longer changes field work.',
  'no-access': 'This job is not in your list.',
};

// The photos the server refused for a reason of their job, which only the recovery sheet can settle.
export async function readRefusedPhotos(owner: PhotoOwner): Promise<PhotoQueueEntry[]> {
  return (await readPhotoQueue(owner)).filter((entry) => entry.kind === 'photo' && entry.stage === 'blocked' && entry.refusal);
}

type Result = { kind: 'acknowledged' } | { kind: 'retry' } | { kind: 'sign-in' } | { kind: 'blocked'; reason: string; refusal?: NonNullable<PhotoQueueEntry['refusal']> };

async function serverReference(client: FieldClient, path: string, entry: PhotoQueueEntry, signal: AbortSignal) {
  const current = await whileAvailable(getDocFromServer(doc(client.db, path)), signal);
  if (current.metadata.hasPendingWrites) return 'pending';
  if (!current.exists()) return 'missing';
  return canonicalJson(current.data().field) === canonicalJson(entry.field) ? 'matches' : 'different';
}

async function saveReference(
  client: FieldClient,
  companyId: string,
  entry: PhotoQueueEntry,
  written: () => Promise<void>,
  signal: AbortSignal,
  canWrite: () => boolean,
): Promise<Result> {
  const ref = { companyId, draftId: entry.draftId };
  const activeDraft = draftPath(ref);
  const writes = photoRefWrites(ref, entry.photoId, entry.field);
  const path = writes[0]!.path;
  let journaled = false;
  try {
    // The response may have been lost after the SDK committed the reference or after the journal
    // pruned its entry. Only a server read can settle that case.
    const current = await serverReference(client, path, entry, signal);
    if (current === 'pending') return { kind: 'retry' };
    if (current === 'different') return { kind: 'blocked', reason: 'This photo has different details on the server.' };
    if (current === 'matches') {
      await written();
      return { kind: 'acknowledged' };
    }
    const existing = (await whileAvailable(readEntries(client), signal)).find((record) => record.writes.some((write) => write.path === path));
    if (existing) {
      if (existing.state === 'pending') return { kind: 'retry' };
      return {
        kind: 'blocked',
        reason: existing.reason ? REFUSAL_TEXT[existing.reason] : 'The photo is stored. Its room and tag could not be saved.',
      };
    }
    signal.throwIfAborted();
    if (!canWrite()) return { kind: 'retry' };
    const edit = await whileAvailable(journaledEdit(client, ref, writes, entry.jobId, new Map([[path, null]])), signal);
    journaled = true;
    // The journal keeps following the server promise even when the phone goes offline.
    void edit.acknowledged.catch(() => undefined);
    await written();
    await whileAvailable(edit.acknowledged, signal);
    return { kind: 'acknowledged' };
  } catch (error) {
    if (error instanceof ReopenTheApp) throw error;
    if (signal.aborted) return { kind: 'retry' };
    const refusal = fieldRefusal(error);
    if (refusal?.status === 401) return { kind: 'sign-in' };
    if (!refusal) return { kind: 'retry' };
    const reason = await whileAvailable(refusalNow(client, activeDraft, entry.jobId), signal).catch(() => 'no-answer' as const);
    if (reason === null || reason === 'no-answer') return { kind: 'retry' };
    // A journal entry made for this reference carries the refusal in the sheet already.
    return { kind: 'blocked', reason: REFUSAL_TEXT[reason], ...(journaled ? {} : { refusal: { reason, draftPath: activeDraft } }) };
  }
}

export function mountFieldPhotos(client: FieldClient, company: () => string | null, signInRequired: () => void) {
  return startPhotoQueue(client.person, {
    canSend: () => company() !== null && fieldUser(client.person) !== null,
    async upload(entry, bytes, signal) {
      const user = fieldUser(client.person);
      if (!user || user.uid !== entry.uid) return { kind: 'failure', status: 401, reason: 'Sign in again to continue.' };
      const companyId = company();
      if (!companyId) return { kind: 'failure', status: 0, reason: 'Waiting to send.' };
      const answer = await whileAvailable(sendQueuedPhoto(user, entry, bytes, signal), signal);
      if (answer.ok) return { kind: 'receipt', ...answer.value };
      const failure = { kind: 'failure' as const, status: answer.status, reason: answer.message, code: answer.code, retryAfter: answer.retryAfter };
      if (entry.kind !== 'photo' || answer.status !== 410) return failure;
      const path = draftPath({ companyId, draftId: entry.draftId });
      const found = await whileAvailable(refusalNow(client, path, entry.jobId), signal).catch(() => 'no-answer' as const);
      const reason = found === null || found === 'no-answer' ? 'archived' : found;
      return { ...failure, reason: REFUSAL_TEXT[reason], refusal: { reason, draftPath: path } };
    },
    async recover(entry, signal) {
      const companyId = company();
      if (!companyId) return null;
      const path = photoRefWrites({ companyId, draftId: entry.draftId }, entry.photoId, entry.field)[0]!.path;
      const found = await serverReference(client, path, entry, signal).catch((error: unknown) => {
        const refusal = fieldRefusal(error);
        if (refusal) return refusal.status === 401 ? 'pending' : 'missing';
        throw error;
      });
      if (found === 'pending') return null;
      if (found === 'matches') pending.draftChanged(entry.jobId);
      return found === 'matches';
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
    storageError: (error) => journalFailed(client, error),
  });
}

// Try again for photos the server refused for their job: once the job takes edits again they
// go back to the step they stopped at.
export async function retryRefusedPhotos(client: FieldClient, photos: readonly PhotoQueueEntry[]): Promise<'queued' | 'refused' | 'no-answer'> {
  const first = photos[0];
  if (!first?.refusal) return 'no-answer';
  const reason = await refusalNow(client, first.refusal.draftPath, first.jobId);
  if (reason === 'no-answer') return 'no-answer';
  if (reason) return 'refused';
  for (const photo of photos) await resumeQueuedPhoto(photo);
  return 'queued';
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
