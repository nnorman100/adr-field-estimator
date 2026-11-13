// Work the phone sent and has no answer for yet (S5a-6), kept for the life of the page rather than
// of one screen, so moving between views never drops it: a resend after a lost answer must carry
// the same ids, body and bytes, or it could make a second job or photo, or report a false conflict.
// It lives in memory only; S6 keeps it on the phone across reloads.
//
// - The new job: one at a time.
// - Customer and claim: one unsettled save per job. Both change the same job revision, so while one
//   is unanswered the other waits (a second save would move the revision on, and the first one's
//   resend would then meet a conflict instead of its own answer).
// - Photos: per job, each with its id and the very bytes sent.
import { useSyncExternalStore } from 'react';
import type { PhotoField } from './schema';

export type PendingJob = { id: string; draftId: string; propertyAddress: string };
export type RecordKind = 'customer' | 'claim';
export type PendingRecord = { kind: RecordKind; changeId: string; revision: number; values: Record<string, string> };
export type PendingPhoto = {
  id: string;
  bytes: Blob;
  field: PhotoField;
  step: 'sending' | 'send-failed' | 'saving' | 'save-failed';
  message?: string;
};

type State = {
  job: PendingJob | null;
  records: Record<string, PendingRecord>;
  photos: Record<string, PendingPhoto[]>;
};

let state: State = { job: null, records: {}, photos: {} };
const listeners = new Set<() => void>();

function change(next: Partial<State>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const NO_PHOTOS: PendingPhoto[] = [];

export const pending = {
  job: () => state.job,
  setJob(job: PendingJob | null) {
    change({ job });
  },
  record: (jobId: string): PendingRecord | null => state.records[jobId] ?? null,
  setRecord(jobId: string, record: PendingRecord | null) {
    const records = { ...state.records };
    if (record) records[jobId] = record;
    else delete records[jobId];
    change({ records });
  },
  photos: (jobId: string): PendingPhoto[] => state.photos[jobId] ?? NO_PHOTOS,
  addPhoto(jobId: string, photo: PendingPhoto) {
    change({ photos: { ...state.photos, [jobId]: [...pending.photos(jobId), photo] } });
  },
  updatePhoto(jobId: string, photoId: string, update: Partial<PendingPhoto>) {
    const list = pending.photos(jobId).map((photo) => (photo.id === photoId ? { ...photo, ...update } : photo));
    change({ photos: { ...state.photos, [jobId]: list } });
  },
  removePhoto(jobId: string, photoId: string) {
    change({ photos: { ...state.photos, [jobId]: pending.photos(jobId).filter((photo) => photo.id !== photoId) } });
  },
};

// Re-renders the caller whenever unsent work changes, and answers `read` now.
export function usePending<T>(read: () => T): T {
  return useSyncExternalStore(subscribe, read, read);
}
