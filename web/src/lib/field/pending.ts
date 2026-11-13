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
//
// A send in flight is marked here, not in the screen, so a screen opened again while it is on its
// way cannot send it a second time; an answer settles only the request that still holds its slot.
// A refusal frees the slot but keeps what the person entered and the server's reason, for the
// screen to show whenever it is open next.
// All of it belongs to one signed-in person of one company (`openFor`): another sign-in on the same
// page starts empty.
import { useSyncExternalStore } from 'react';
import type { PhotoField } from './schema';

export type PendingJob = { id: string; draftId: string; propertyAddress: string; sending: boolean };
export type RecordKind = 'customer' | 'claim';
export type PendingRecord = {
  kind: RecordKind;
  changeId: string;
  revision: number;
  values: Record<string, string>;
  // Only the boxes the person changed, put back on the form if the server refuses the save.
  edits: Record<string, string>;
  sending: boolean;
};
export type RecordRefusal = { edits: Record<string, string>; message: string };
export type JobRefusal = { propertyAddress: string; message: string };
// What came back for a send: nothing (keep it to send again), an answer, or a refusal.
export type Settlement = 'unanswered' | 'answered' | { refused: string };
export type PendingPhoto = {
  id: string;
  bytes: Blob;
  field: PhotoField;
  step: 'sending' | 'send-failed' | 'saving' | 'save-failed';
  message?: string;
};

type State = {
  owner: string | null;
  job: PendingJob | null;
  jobRefusal: JobRefusal | null;
  records: Record<string, PendingRecord>;
  // By job and record kind.
  refusals: Record<string, RecordRefusal>;
  photos: Record<string, PendingPhoto[]>;
};

const EMPTY = { job: null, jobRefusal: null, records: {}, refusals: {}, photos: {} };
let state: State = { owner: null, ...EMPTY };
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
  // Keeps the unsent work only while `owner` (company and person) stays the one signed in.
  openFor(owner: string) {
    if (state.owner !== owner) change({ owner, ...EMPTY });
  },
  job: () => state.job,
  setJob(job: PendingJob) {
    change({ job });
  },
  // Ends the send of job `id` if it still holds the slot. Answers whether it did.
  settleJob(id: string, settlement: Settlement): boolean {
    const current = state.job;
    if (current?.id !== id) return false;
    if (settlement === 'unanswered') change({ job: { ...current, sending: false } });
    else if (settlement === 'answered') change({ job: null });
    else change({ job: null, jobRefusal: { propertyAddress: current.propertyAddress, message: settlement.refused } });
    return true;
  },
  jobRefusal: () => state.jobRefusal,
  dropJobRefusal() {
    if (state.jobRefusal) change({ jobRefusal: null });
  },
  record: (jobId: string): PendingRecord | null => state.records[jobId] ?? null,
  setRecord(jobId: string, record: PendingRecord) {
    change({ records: { ...state.records, [jobId]: record } });
  },
  settleRecord(jobId: string, changeId: string, settlement: Settlement): boolean {
    const current = state.records[jobId];
    if (current?.changeId !== changeId) return false;
    const records = { ...state.records };
    if (settlement === 'unanswered') records[jobId] = { ...current, sending: false };
    else delete records[jobId];
    if (typeof settlement === 'object') {
      const refusal = { edits: current.edits, message: settlement.refused };
      change({ records, refusals: { ...state.refusals, [`${jobId}/${current.kind}`]: refusal } });
    } else change({ records });
    return true;
  },
  refusal: (jobId: string, kind: RecordKind): RecordRefusal | null => state.refusals[`${jobId}/${kind}`] ?? null,
  dropRefusal(jobId: string, kind: RecordKind) {
    const key = `${jobId}/${kind}`;
    if (!state.refusals[key]) return;
    const refusals = { ...state.refusals };
    delete refusals[key];
    change({ refusals });
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
