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
// A send can settle after its screen was closed and the job opened again in a new one. So what a
// settled send learned is posted here per job, for whichever screen of that job is open now: the
// job as the server answered it, and a mark that the field draft changed and must be read again.
// A refusal to show a job to this person (`denyDetail`) drops every copy of it and moves its access
// mark on: a job answered to a request made before then is not kept, until a read made after it.
// All of it belongs to one signed-in person of one company (`openFor`): another sign-in on the same
// page starts empty.
import { useSyncExternalStore } from 'react';
import type { JobDetail } from '@/lib/jobs/service';
import type { Answer } from './api';
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
  // By job: the newest job the server answered, and how many times its draft was changed by a send
  // that settled after its screen closed.
  details: Record<string, JobDetail>;
  draftChanges: Record<string, number>;
  // By job: its access mark, and the server's reason while it refuses to show the job.
  marks: Record<string, number>;
  denials: Record<string, string>;
};

const EMPTY = {
  job: null,
  jobRefusal: null,
  records: {},
  refusals: {},
  photos: {},
  details: {},
  draftChanges: {},
  marks: {},
  denials: {},
};
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
  // The job as the server last answered it; an older revision never replaces a newer one. A move of
  // the field work keeps the revision (it is coordination), so an answer at the same revision does.
  detail: (jobId: string): JobDetail | null => state.details[jobId] ?? null,
  // Taken before a request about the job is sent, and handed back with its answer.
  mark: (jobId: string): number => state.marks[jobId] ?? 0,
  // Keeps a job answered to a request made under `mark`, unless the job was refused since. Answers
  // whether the answer still counts.
  publishDetail(jobId: string, detail: JobDetail, mark: number): boolean {
    if (mark !== pending.mark(jobId)) return false;
    const known = state.details[jobId];
    if (known && known.job.revision > detail.job.revision) return true;
    const denials = { ...state.denials };
    delete denials[jobId];
    change({ details: { ...state.details, [jobId]: detail }, denials });
    return true;
  },
  // The server refused to show this job to this person: no copy of it is kept, and no answer to a
  // request made before now.
  denyDetail(jobId: string, message: string) {
    const details = { ...state.details };
    delete details[jobId];
    change({
      details,
      marks: { ...state.marks, [jobId]: pending.mark(jobId) + 1 },
      denials: { ...state.denials, [jobId]: message },
    });
  },
  denial: (jobId: string): string | null => state.denials[jobId] ?? null,
  // A read of the job sent under `mark` came back, whether or not a screen of the job is still
  // open: a refusal drops every copy of the job. Answers false when the job was refused since, so
  // the answer no longer counts.
  readAnswered(jobId: string, answer: Answer<unknown>, mark: number): boolean {
    if (mark !== pending.mark(jobId)) return false;
    if (!answer.ok && answer.denied) pending.denyDetail(jobId, answer.message);
    return true;
  },
  draftChanges: (jobId: string): number => state.draftChanges[jobId] ?? 0,
  // A send changed the job's field draft after its screen closed: the open screen reads it again.
  draftChanged(jobId: string) {
    change({ draftChanges: { ...state.draftChanges, [jobId]: pending.draftChanges(jobId) + 1 } });
  },
};

// The newer of two copies of a job, by revision; either may be missing.
export function newerDetail(a: JobDetail | null, b: JobDetail | null): JobDetail | null {
  if (!a) return b;
  if (!b) return a;
  return b.job.revision > a.job.revision ? b : a;
}

// Re-renders the caller whenever unsent work changes, and answers `read` now.
export function usePending<T>(read: () => T): T {
  return useSyncExternalStore(subscribe, read, read);
}
