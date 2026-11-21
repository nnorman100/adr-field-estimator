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
//   has left the list it was sent from. Once one is done, whether the job is archived is posted per
//   job, as its reads also post it, for whichever screen or list is open now: answers to requests
//   made before it no longer count, and they read again.
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
// What a person typed in a room's "Your own prep task" box or the "New room name" box and did not add
// is kept per job and per draft (`typed`), so a screen of the job opened again, or a newer draft read,
// still shows it: on the draft it was typed on as that draft's own text, and on every other draft of
// the job read only (`typedBefore`), never as something to save into it. Typing on one draft never
// changes what was typed on another.
// All of it belongs to one signed-in person of one company (`openFor`): another sign-in on the same
// page starts empty.
import { useSyncExternalStore } from 'react';
import type { JobDetail } from '@/lib/jobs/service';
import type { Answer } from './api';
import type { PhotoField, RoomField } from './schema';
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
// A prep task typed and not added in a room, with the room as last read, so its card can be shown
// again when the draft no longer lists the room.
// `at` / `nameAt` number each time the text was typed, so a save that sent text can tell it from the
// same words typed again afterwards.
export type TypedRoom = { task: string; field: RoomField; number: number; at: number };
export type TypedText = { roomName: string; nameAt: number; rooms: Record<string, TypedRoom> };
// By draft: what was typed on each draft of one job.
export type TypedDrafts = Record<string, TypedText>;
// What was typed on the other drafts of a job, for a draft to show read only.
export type TypedBefore = { roomNames: string[]; rooms: Record<string, { tasks: string[]; field: RoomField; number: number }> };
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
  // By job: its access mark, and the server's reason while it refuses to show the job. `marked` is
  // the last mark handed out, of any job; `readAt`, by job, the mark of the newest read that showed it.
  marks: Record<string, number>;
  marked: number;
  readAt: Record<string, number>;
  denials: Record<string, string>;
  // By job: the field work is on this phone as this person's (or its job says it is theirs).
  held: Record<string, true>;
  // By job: the field work moved away from this person; the draft as last read stays on screen.
  // `revoked`: the server refused the job to this person (nothing more is asked of it); otherwise the
  // job is still readable (the owner, office) but the field work is another person's.
  moved: Record<string, { draft: FieldDraft | null; draftId: string | null; revoked: boolean }>;
  coord: Record<string, PendingCoord>;
  // By job and draft: text typed and not added.
  typed: Record<string, TypedDrafts>;
  // By job and draft: a write of the room order (Add room, Remove room) is on its way.
  roomWrites: Record<string, true>;
  // By signed job: its copy sent and not answered yet.
  copies: Record<string, PendingCopy>;
  // By job: its archive or restore not settled yet.
  archivals: Record<string, PendingArchival>;
  // By job: archived, as the newest answer about it said; and how many archives or restores were done.
  archived: Record<string, true>;
  archivalsDone: Record<string, number>;
  // By job: a refusal waits for a read of the job sent after the mark handed out last when it came.
  verifying: Record<string, number>;
  // By job: an archive with no sure answer is being checked (a subset of `verifying`): nothing of the
  // job is sent from any screen until the read that settles it.
  archiveChecks: Record<string, true>;
  // By job: how many coordination writes were answered, so a screen that read before knows to read again.
  coordSettled: Record<string, number>;
  // The server refused a job list (a suspended company, a removed member): nothing that names a
  // property stays on screen from the saved lists and unfinished archives until a list is answered again.
  listDenied: boolean;
  // The newest list request whose answer counted (see listAnswered).
  listAt: number;
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
  marked: 0,
  readAt: {},
  denials: {},
  held: {},
  moved: {},
  coord: {},
  typed: {},
  roomWrites: {},
  copies: {},
  archivals: {},
  archived: {},
  archivalsDone: {},
  verifying: {},
  archiveChecks: {},
  coordSettled: {},
  listDenied: false,
  listAt: 0,
};
// Numbers of list requests never repeat, so an answer to one sent for an earlier sign-in is ignored.
let listsSent = 0;
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
export const NO_TYPED: TypedText = { roomName: '', nameAt: 0, rooms: {} };
let typedCount = 0;
const NO_DRAFTS: TypedDrafts = {};

// Keeps `drafts` as the job's typed text, without the drafts that hold none.
function putTyped(jobId: string, drafts: TypedDrafts) {
  const kept = Object.fromEntries(Object.entries(drafts).filter(([, typed]) => typed.roomName !== '' || Object.keys(typed.rooms).length > 0));
  const typed = { ...state.typed };
  if (Object.keys(kept).length === 0) delete typed[jobId];
  else typed[jobId] = kept;
  change({ typed });
}

// Changes what is typed for the job on `draftId`, and nothing typed on its other drafts.
function retype(jobId: string, draftId: string, edit: (typed: TypedText) => TypedText) {
  const drafts = state.typed[jobId] ?? NO_DRAFTS;
  putTyped(jobId, { ...drafts, [draftId]: edit(drafts[draftId] ?? NO_TYPED) });
}

// What was typed on the drafts of a job other than `draftId`, oldest first.
export function typedBefore(drafts: TypedDrafts, draftId: string): TypedBefore {
  const before: TypedBefore = { roomNames: [], rooms: {} };
  for (const [id, typed] of Object.entries(drafts)) {
    if (id === draftId) continue;
    if (typed.roomName !== '') before.roomNames.push(typed.roomName);
    for (const [roomId, room] of Object.entries(typed.rooms)) {
      const known = before.rooms[roomId];
      before.rooms[roomId] = { tasks: [...(known?.tasks ?? []), room.task], field: room.field, number: room.number };
    }
  }
  return before;
}

export const pending = {
  // Keeps the unsent work only while `owner` (company and person) stays the one signed in.
  openFor(owner: string) {
    if (state.owner !== owner) change({ owner, ...EMPTY, listAt: listsSent });
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
  // Discard text typed for this job and refused record edits. Keep writes that can still be retried.
  discardUnsent(jobId: string) {
    putTyped(jobId, NO_DRAFTS);
    pending.dropRefusal(jobId, 'customer');
    pending.dropRefusal(jobId, 'claim');
  },
  photos: (jobId: string): PendingPhoto[] => state.photos[jobId] ?? NO_PHOTOS,
  hasPhotos: (): boolean => Object.values(state.photos).some((photos) => photos.length > 0),
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
  // Taken before a read of a job is sent: newer than every mark handed out before it, so of two
  // reads the one sent later decides.
  markRead(): number {
    state = { ...state, marked: state.marked + 1 };
    return state.marked;
  },
  // Keeps a job answered to a request made under `mark`, unless the job was refused since. Answers
  // whether the answer still counts.
  publishDetail(jobId: string, detail: JobDetail, mark: number): boolean {
    if (mark < pending.mark(jobId)) return false;
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
      ...remarked(jobId),
      denials: { ...state.denials, [jobId]: message },
      archived: flagged(state.archived, jobId, false),
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
  // What was typed and not added on each draft of the job; the same object until it changes.
  typed: (jobId: string): TypedDrafts => state.typed[jobId] ?? NO_DRAFTS,
  typeRoomName(jobId: string, draftId: string, text: string) {
    retype(jobId, draftId, (typed) => ({ ...typed, roomName: text, nameAt: ++typedCount }));
  },
  typeTask(jobId: string, draftId: string, roomId: string, text: string, room: { field: RoomField; number: number }) {
    retype(jobId, draftId, (typed) => {
      const rooms = { ...typed.rooms };
      if (text === '') delete rooms[roomId];
      else rooms[roomId] = { task: text, ...room, at: ++typedCount };
      return { ...typed, rooms };
    });
  },
  // The room name sent with Add room (typed as `at`, see `TypedText.nameAt`) was saved on the phone: it
  // is not left typed on `draftId`, unless it was typed again since.
  settleRoomName(jobId: string, draftId: string, at: number) {
    if (at !== 0 && state.typed[jobId]?.[draftId]?.nameAt === at) pending.typeRoomName(jobId, draftId, '');
  },
  // The server acknowledged the removal of a room by this person, which sent its typed task (typed as
  // `at`): that text goes with the room, from `draftId` only, unless it was typed again since.
  settleRoomRemoved(jobId: string, draftId: string, roomId: string, at: number) {
    const drafts = state.typed[jobId] ?? NO_DRAFTS;
    const typed = drafts[draftId];
    if (at === 0 || typed?.rooms[roomId]?.at !== at) return;
    putTyped(jobId, { ...drafts, [draftId]: { ...typed, rooms: Object.fromEntries(Object.entries(typed.rooms).filter(([one]) => one !== roomId)) } });
  },
  // Adding or removing a room writes the whole room order, so only one such write is on its way for a
  // draft, also when its screen is closed and opened again. Answers whether this one took the turn.
  startRoomWrite(jobId: string, draftId: string): boolean {
    const key = `${jobId}/${draftId}`;
    if (state.roomWrites[key]) return false;
    change({ roomWrites: { ...state.roomWrites, [key]: true } });
    return true;
  },
  endRoomWrite(jobId: string, draftId: string) {
    const roomWrites = { ...state.roomWrites };
    delete roomWrites[`${jobId}/${draftId}`];
    change({ roomWrites });
  },
  roomWriting: (jobId: string, draftId: string): boolean => Boolean(state.roomWrites[`${jobId}/${draftId}`]),
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
  // A refusal of a write or a read of the job that only a read of the job sent after now can explain
  // (a move, an archive, a missing photo): nothing of it is saved until such a read is answered.
  verify(jobId: string, archive = false) {
    change({ verifying: { ...state.verifying, [jobId]: state.marked }, archiveChecks: archive ? { ...state.archiveChecks, [jobId]: true } : state.archiveChecks });
  },
  verifying: (jobId: string): number | null => state.verifying[jobId] ?? null,
  archiveChecking: (jobId: string): boolean => state.archiveChecks[jobId] === true,
  // A read of the job sent under `mark` came back, whether or not a screen of the job is still
  // open: one sent after a refusal to verify settles it; a refusal drops every copy of the job; the
  // job (archived or not, S5b-2) says whether it is archived, and an archived answer is newer than
  // any request made before it. Answers false when the job was refused or archived since, so the
  // answer no longer counts.
  // Whether the read sent under `mark` is still the newest that showed the job (no later read was
  // answered): what it started (its locator and draft reads) is applied only while it is.
  // An archive or a refusal since (410, archivedSeen, archivalDone, a denial: each moves the job's mark on)
  // ends it too.
  newestRead: (jobId: string, mark: number): boolean => mark >= (state.readAt[jobId] ?? 0) && mark >= pending.mark(jobId),
  // Whether a draft read's answer counts: one a job read (sent under `mark`) started counts while that read
  // is the newest; one no job read started (a photo sent, the journal) counts only for the draft the job
  // names now (the newest job read's, else `fallback`, the locator's), so a read of an older draft never
  // decides whether the field work is ready.
  draftReadCounts: (jobId: string, draftId: string, mark: number | undefined, fallback?: string): boolean =>
    mark === undefined ? draftId === (state.details[jobId]?.job.currentDraftId ?? fallback) : pending.newestRead(jobId, mark),
  // A read sent before the newest read that showed the job no longer counts either.
  readAnswered(jobId: string, answer: Answer<unknown>, mark: number): boolean {
    if (mark < pending.mark(jobId) || mark < (state.readAt[jobId] ?? 0)) return false;
    const archivedAnswer = !answer.ok && (answer.code === 'archived' || answer.status === 410);
    const verifying = state.verifying[jobId];
    if (verifying !== undefined && mark > verifying && (answer.ok || answer.denied || archivedAnswer)) {
      const next = { ...state.verifying };
      delete next[jobId];
      const checks = { ...state.archiveChecks };
      delete checks[jobId];
      change({ verifying: next, archiveChecks: checks });
    }
    if (archivedAnswer) change({ archived: flagged(state.archived, jobId, true), marks: { ...state.marks, [jobId]: mark + 0.5 } });
    else if (answer.ok) change({ readAt: { ...state.readAt, [jobId]: mark }, archived: flagged(state.archived, jobId, false) });
    // A refusal is the newest word on the job too: an older read answered after it counts for nothing (it
    // cannot clear a revocation, nor restart getting the field work ready).
    if (!answer.ok && answer.denied) {
      change({ readAt: { ...state.readAt, [jobId]: mark } });
      pending.refused(jobId, answer.message, answer.status);
    }
    return true;
  },
  coordSettled: (jobId: string): number => state.coordSettled[jobId] ?? 0,
  listDenied: (): boolean => state.listDenied,
  // A job list is asked for: the number to give back with its answer.
  listSend(): number {
    listsSent += 1;
    return listsSent;
  },
  // A list was answered, whether or not the view that asked is still open: a refusal records that the
  // server denied this person the jobs, an answer that came means access again. An answer to an
  // earlier request than the newest one counted is ignored.
  listAnswered(sent: number, denied: boolean) {
    if (sent <= state.listAt) return;
    change({ listAt: sent, listDenied: denied });
  },
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
  archived: (jobId: string): boolean => Boolean(state.archived[jobId]),
  // A route of the job answered 410: the job is archived, and no answer to a request made before now
  // counts.
  archivedSeen(jobId: string) {
    change({ archived: flagged(state.archived, jobId, true), ...remarked(jobId) });
  },
  // An archive or restore of the job is done: the open screens and lists of it read again. Unless a
  // read already showed a newer revision of the job than the one it answered (`revision`), whether
  // it is archived is posted and no answer to a request made before now counts.
  archivalDone(jobId: string, archived: boolean, revision?: number) {
    const current = revision === undefined || revision >= (state.details[jobId]?.job.revision ?? 0);
    change({
      ...(current ? { archived: flagged(state.archived, jobId, archived), ...remarked(jobId) } : {}),
      archivalsDone: { ...state.archivalsDone, [jobId]: pending.archivalsDone(jobId) + 1 },
    });
  },
  // Of one job, or of every job.
  archivalsDone: (jobId?: string): number =>
    jobId === undefined ? Object.values(state.archivalsDone).reduce((sum, count) => sum + count, 0) : (state.archivalsDone[jobId] ?? 0),
  draftChanges: (jobId: string): number => state.draftChanges[jobId] ?? 0,
  // A send changed the job's field draft after its screen closed: the open screen reads it again.
  draftChanged(jobId: string) {
    change({ draftChanges: { ...state.draftChanges, [jobId]: pending.draftChanges(jobId) + 1 } });
  },
};

// A new mark for the job, newer than every mark handed out so far.
function remarked(jobId: string): Pick<State, 'marks' | 'marked'> {
  const marked = state.marked + 1;
  return { marks: { ...state.marks, [jobId]: marked }, marked };
}

function flagged(flags: Record<string, true>, jobId: string, on: boolean): Record<string, true> {
  const next = { ...flags };
  if (on) next[jobId] = true;
  else delete next[jobId];
  return next;
}

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
