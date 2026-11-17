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
// - Copy a signed job (S5b-2): per signed job, the new job's and draft's ids, so a lost answer is
//   sent again with the same ids and makes one draft.
// - Archive and restore (S5b-2): per job, the change and its id while it has no answer or its field
//   step did not get through (5xx), to send again from wherever the job is shown next, also once it
//   has left the list it was sent from.
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
// A refusal is not always the end of a person's work on a job (owner decision J5): while this person
// held the field work, the owner may move it to someone else, or office may unassign them, and the
// server then refuses them the job. What they typed and did not send stays on screen, read only, so
// the refusal is kept as `moved` instead of dropping the job (`refused`), together with the draft as
// last read, for the screen of that job opened again on this page. Server access stays revoked: the
// screens ask nothing more about a moved job. Save as new draft is S6.
// All of it belongs to one signed-in person of one company (`openFor`): another sign-in on the same
// page starts empty.
import { useSyncExternalStore } from 'react';
import type { JobDetail } from '@/lib/jobs/service';
import type { Answer } from './api';
import type { PhotoField } from './schema';
import type { FieldDraft } from './store';

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
// A coordination write (S5b-1) kept with its ids until the server answers it, so a retry after no
// answer is the same request and nothing else is sent meanwhile.
export type CoordRequest =
  | { kind: 'move'; revision: number; changeId: string; toActorId: string }
  | { kind: 'assign'; id: string; estimatorActorId: string }
  | { kind: 'unassign'; assignmentId: string }
  | { kind: 'notes'; revision: number; changeId: string; notes: string };
export type PendingCoord = { key: string; at: string; done: string; request: CoordRequest; sending: boolean };
export type PendingCopy = { id: string; draftId: string; sending: boolean };
export type ArchivalKind = 'archive' | 'restore';
export type PendingArchival = { kind: ArchivalKind; address: string; revision: number; changeId: string; sending: boolean };
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
  // By job: the field work is on this phone as this person's (or its job says it is theirs).
  held: Record<string, true>;
  // By job: the field work moved away from this person; the draft as last read stays on screen.
  // `revoked`: the server refused the job to this person (nothing more is asked of it); otherwise the
  // job is still readable (the owner, office) but the field work is another person's.
  moved: Record<string, { draft: FieldDraft | null; draftId: string | null; revoked: boolean }>;
  coord: Record<string, PendingCoord>;
  // By signed job: its copy sent and not answered yet.
  copies: Record<string, PendingCopy>;
  // By job: its archive or restore not settled yet.
  archivals: Record<string, PendingArchival>;
  // By job: how many coordination writes were answered, so a screen that read before knows to read again.
  coordSettled: Record<string, number>;
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
  held: {},
  moved: {},
  coord: {},
  copies: {},
  archivals: {},
  coordSettled: {},
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
  // The job as the server last answered it; an older revision never replaces a newer one.
  detail: (jobId: string): JobDetail | null => state.details[jobId] ?? null,
  // Taken before a request about the job is sent, and handed back with its answer.
  mark: (jobId: string): number => state.marks[jobId] ?? 0,
  // Keeps a job answered to a request made under `mark`, unless the job was refused since. Answers
  // whether the answer still counts.
  publishDetail(jobId: string, detail: JobDetail, mark: number): boolean {
    if (mark !== pending.mark(jobId)) return false;
    const known = state.details[jobId];
    if (known && known.job.revision >= detail.job.revision) return true;
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
  // Whether this person's field work of the job is on this phone (the screen says so as it reads).
  hold(jobId: string, holding: boolean) {
    if (Boolean(state.held[jobId]) === holding) return;
    const held = { ...state.held };
    if (holding) held[jobId] = true;
    else delete held[jobId];
    change({ held });
  },
  // A refusal of the job to this person. While their field work is on the phone, the job and the
  // field work stay (kept as moved; answers true), otherwise it is a refusal to show the job and
  // every copy goes (answers false). A 401 is a sign-in refused, never a move.
  refused(jobId: string, message: string, status: number): boolean {
    if (status !== 401 && (state.held[jobId] || state.moved[jobId])) {
      const known = state.moved[jobId];
      if (!known?.revoked) change({ moved: { ...state.moved, [jobId]: { draft: known?.draft ?? null, draftId: known?.draftId ?? null, revoked: true } } });
      return true;
    }
    pending.denyDetail(jobId, message);
    return false;
  },
  moved: (jobId: string): { draft: FieldDraft | null; draftId: string | null; revoked: boolean } | null => state.moved[jobId] ?? null,
  // The job now names someone else as its field owner while this person held it: recorded before any
  // newer draft replaces the one on screen, whoever the draft then names.
  moveAway(jobId: string) {
    if (!state.moved[jobId]) change({ moved: { ...state.moved, [jobId]: { draft: null, draftId: null, revoked: false } } });
  },
  held: (jobId: string): boolean => Boolean(state.held[jobId]),
  // The draft as last read, kept with a moved job for a screen of it opened again on this page.
  keepDraft(jobId: string, draft: FieldDraft, draftId: string) {
    const moved = state.moved[jobId];
    if (moved && moved.draft !== draft) change({ moved: { ...state.moved, [jobId]: { ...moved, draft, draftId } } });
  },
  // The job is this person's field work again, as the server now says: it opens as usual.
  returned(jobId: string) {
    if (!state.moved[jobId]) return;
    const moved = { ...state.moved };
    delete moved[jobId];
    change({ moved });
  },
  // A read of the job sent under `mark` came back, whether or not a screen of the job is still
  // open: a refusal drops every copy of the job. Answers false when the job was refused since, so
  // the answer no longer counts.
  readAnswered(jobId: string, answer: Answer<unknown>, mark: number): boolean {
    if (mark !== pending.mark(jobId)) return false;
    if (!answer.ok && answer.denied) pending.refused(jobId, answer.message, answer.status);
    return true;
  },
  coordSettled: (jobId: string): number => state.coordSettled[jobId] ?? 0,
  coordWrite: (jobId: string): PendingCoord | null => state.coord[jobId] ?? null,
  setCoordWrite(jobId: string, write: PendingCoord) {
    change({ coord: { ...state.coord, [jobId]: write } });
  },
  // Ends the send of `key` if it still holds the job's slot: no answer keeps it to send again.
  settleCoordWrite(jobId: string, key: string, settlement: 'unanswered' | 'answered'): boolean {
    const current = state.coord[jobId];
    if (current?.key !== key) return false;
    const coord = { ...state.coord };
    if (settlement === 'unanswered') coord[jobId] = { ...current, sending: false };
    else delete coord[jobId];
    change(settlement === 'answered' ? { coord, coordSettled: { ...state.coordSettled, [jobId]: pending.coordSettled(jobId) + 1 } } : { coord });
    return true;
  },
  copy: (jobId: string): PendingCopy | null => state.copies[jobId] ?? null,
  setCopy(jobId: string, copy: PendingCopy) {
    change({ copies: { ...state.copies, [jobId]: copy } });
  },
  // Ends the copy `id` of a signed job if it still holds the slot: no answer keeps its ids to send
  // again; an answer or a refusal frees them.
  settleCopy(jobId: string, id: string, settlement: 'unanswered' | 'answered'): boolean {
    const current = state.copies[jobId];
    if (current?.id !== id) return false;
    const copies = { ...state.copies };
    if (settlement === 'unanswered') copies[jobId] = { ...current, sending: false };
    else delete copies[jobId];
    change({ copies });
    return true;
  },
  archivals: (): Record<string, PendingArchival> => state.archivals,
  archival: (jobId: string): PendingArchival | null => state.archivals[jobId] ?? null,
  setArchival(jobId: string, archival: PendingArchival) {
    change({ archivals: { ...state.archivals, [jobId]: archival } });
  },
  // Ends the archive or restore `changeId` of a job if it still holds the slot: no answer keeps it to
  // send again; an answer or a refusal frees it.
  settleArchival(jobId: string, changeId: string, settlement: 'unanswered' | 'answered'): boolean {
    const current = state.archivals[jobId];
    if (current?.changeId !== changeId) return false;
    const archivals = { ...state.archivals };
    if (settlement === 'unanswered') archivals[jobId] = { ...current, sending: false };
    else delete archivals[jobId];
    change({ archivals });
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
