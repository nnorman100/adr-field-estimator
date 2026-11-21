// What the field screens' sync chip and "Can't save" sheet say (S6-4b; docs/plans/S6/S6-4.md and
// S6.md section 3), read from the person's recovery journal (./journal.ts). The screen uses three
// words for the phone's work: Saved (the server has it), Saved on this phone (waiting to send) and
// Can't save (refused, with the reason and what to do). An edit the server holds other values for,
// with no refusal, is "Changed on another device", never "Can't save".
import { FACT_FIELDS, ROOM_FIELDS } from './forms';
import { jobOf, type JournalEntry, type RejectReason } from './journal';
import type { PhotoQueueEntry } from './photo-queue-storage';

export type ProblemReason = 'finished' | Exclude<RejectReason, 'locked'> | 'unknown' | 'changed';

// One job's edits that the server refused for one reason (or holds other values for); a job whose
// drafts were refused for two reasons (an archived draft, an older finished one) has two.
export type Problem = {
  key: string;
  // The draft of its first edit.
  draftPath: string;
  reason: ProblemReason;
  // The job the edits were made on (journal.ts JournalEntry.jobId), when known.
  jobId: string | null;
  entries: JournalEntry[];
  // The photos the server refused for the same job and reason, whose bytes wait on this phone.
  photos: PhotoQueueEntry[];
  // Save as new draft: only for a job archived while it was being edited, or field work that moved
  // (owner decision J5), and never after the person's own Finish, also when that job was archived
  // after (that path is Back to editing, J4); only with the job the edits were made on known, which
  // the server is asked about again before the copy is made.
  saveAsNew: boolean;
  // Try again: only where the reason can clear (a restore, the field work moved back, access or the
  // role given back, a reason not known yet).
  tryAgain: boolean;
};

// `kind` is the chip's, the most urgent: Can't save, then Changed on another device, then waiting.
// `problems` are every refused and every changed set of edits, by job and reason, for the sheet.
export type SyncStatus = { kind: 'saved' | 'on-phone' | 'cant-save' | 'changed'; waiting: number; problems: Problem[] };

// The reason the server gave for the newest refusal: it was read from the server's copy of the draft
// when the edit was refused (journal-sync.ts), never from this phone's cache.
function reasonOf(entries: readonly JournalEntry[]): ProblemReason {
  const newest = [...entries].reverse().find((entry) => entry.state === 'rejected' && entry.reason);
  if (!newest?.reason) return 'unknown';
  return newest.reason === 'locked' ? 'finished' : newest.reason;
}

// `canSaveAsNew`: the person may start a job and does field work (jobs_create and scope). `photos`:
// the queue's photos the server refused for a reason of their job (photo-field.ts readRefusedPhotos).
export function syncStatus(entries: readonly JournalEntry[], canSaveAsNew: boolean, photos: readonly PhotoQueueEntry[] = []): SyncStatus {
  const refused = new Map<string, JournalEntry[]>();
  const changed = new Map<string, JournalEntry[]>();
  let waiting = 0;
  for (const entry of entries) {
    if (entry.state === 'pending') waiting += 1;
    else {
      const into = entry.state === 'changed' ? changed : refused;
      into.set(entry.draftPath, [...(into.get(entry.draftPath) ?? []), entry]);
    }
  }
  const problem = (key: string, draftPath: string, group: JournalEntry[], reason: ProblemReason, jobId: string | null): Problem => ({
    key,
    draftPath,
    reason,
    jobId,
    entries: group,
    photos: [],
    saveAsNew: canSaveAsNew && jobId !== null && (reason === 'archived' || reason === 'owner-changed'),
    tryAgain: reason !== 'finished' && reason !== 'changed',
  });
  const byJob = new Map<string, Problem>();
  const add = (path: string, group: JournalEntry[], reason: ProblemReason, jobId = jobOf(group)) => {
    const key = `${jobId ?? path}\u0000${reason}`;
    const found = byJob.get(key);
    byJob.set(
      key,
      found
        ? { ...found, entries: [...found.entries, ...group].sort((a, b) => a.seq - b.seq), jobId: found.jobId ?? jobId }
        : problem(key, path, group, reason, jobId),
    );
    return key;
  };
  for (const [path, group] of refused) add(path, group, reasonOf(group));
  for (const [path, group] of changed) add(path, group, 'changed');
  for (const photo of photos) {
    if (!photo.refusal) continue;
    const reason = photo.refusal.reason === 'locked' ? 'finished' : photo.refusal.reason;
    const key = add(photo.refusal.draftPath, [], reason, photo.jobId);
    const found = byJob.get(key)!;
    byJob.set(key, { ...found, photos: [...found.photos, photo] });
  }
  const kind = refused.size > 0 || photos.some((photo) => photo.refusal) ? 'cant-save' : changed.size > 0 ? 'changed' : waiting > 0 ? 'on-phone' : 'saved';
  return { kind, waiting, problems: [...byJob.values()] };
}

// A problem's edits, one draft's at a time, in the order they were made: Try again and Save as new
// draft work on one draft.
export function byDraft(entries: readonly JournalEntry[]): JournalEntry[][] {
  const drafts = new Map<string, JournalEntry[]>();
  for (const entry of entries) drafts.set(entry.draftPath, [...(drafts.get(entry.draftPath) ?? []), entry]);
  return [...drafts.values()];
}

// A problem's edits and refused photos together, one draft at a time.
export function draftGroups(problem: { entries: readonly JournalEntry[]; photos: readonly PhotoQueueEntry[] }): { entries: JournalEntry[]; photos: PhotoQueueEntry[] }[] {
  const groups = new Map<string, { entries: JournalEntry[]; photos: PhotoQueueEntry[] }>();
  const group = (path: string) => groups.get(path) ?? groups.set(path, { entries: [], photos: [] }).get(path)!;
  for (const entry of problem.entries) group(entry.draftPath).entries.push(entry);
  for (const photo of problem.photos) if (photo.refusal) group(photo.refusal.draftPath).photos.push(photo);
  return [...groups.values()];
}

export const SAVED = 'Saved';
export const SAVED_ON_PHONE = 'Saved on this phone';
export const CANT_SAVE = 'Can’t save';
export const CHANGED_ELSEWHERE = 'Changed on another device';

// Most urgent first: what the person can do least about.
const URGENCY: readonly ProblemReason[] = ['no-access', 'role-changed', 'owner-changed', 'archived', 'finished', 'unknown'];

// The chip's words: with refusals, the most urgent reason.
export function chipText(status: SyncStatus): string {
  if (status.kind === 'saved') return SAVED;
  if (status.kind === 'on-phone') return `${SAVED_ON_PHONE} (${status.waiting} waiting to send)`;
  if (status.kind === 'changed') return CHANGED_ELSEWHERE;
  const urgent = URGENCY.find((reason) => status.problems.some((problem) => problem.reason === reason)) ?? 'unknown';
  return `${CANT_SAVE}: ${REASONS[urgent].short}`;
}

// Per reason: the chip's few words, the sheet's title and what to do.
export const REASONS: Record<ProblemReason, { short: string; title: string; text: string }> = {
  finished: {
    short: 'job finished',
    title: 'This job was finished',
    text: 'These changes reached DryScope after the job was finished, so they were not saved. To change the job, go to Finish and review, tap Back to editing, then make them again.',
  },
  archived: {
    short: 'job archived',
    title: 'This job was archived',
    text: 'These changes were not saved to it. Save them as a new draft of their own, or discard them. If the job is restored, Try again sends them to it.',
  },
  'owner-changed': {
    short: 'another person owns it',
    title: 'Another person owns this job’s field work now',
    text: 'These changes were not saved to it. Save them as a new draft of your own, or discard them. If the field work is moved back to you, Try again sends them.',
  },
  'role-changed': {
    short: 'your role changed',
    title: 'Your role no longer changes field work',
    text: 'These changes were not saved. Try again once the company owner gives you back a role that does field work, or discard them.',
  },
  'no-access': {
    short: 'no access',
    title: 'You no longer have access to this job',
    text: 'These changes were not saved. Try again once the company owner gives you access again, or discard them.',
  },
  unknown: {
    short: 'checking why',
    title: 'DryScope did not accept these changes',
    text: 'The reason is checked the next time this phone has a signal. Try again, or discard them.',
  },
  changed: {
    short: 'changed on another device',
    title: CHANGED_ELSEWHERE,
    text: 'This job was changed on another device after these changes were made here, so DryScope keeps the other device’s version. Discard removes these changes from this phone; make them again if they are still needed.',
  },
};

// A finished job that was archived after: Finish and review opens only once it is restored.
export const RESTORE_FIRST =
  'These changes reached DryScope after the job was finished, so they were not saved. This job is archived too: the company owner must restore it before Finish and review opens. Then tap Back to editing there and make them again.';

// Where the refused and changed edits are kept: on this phone, or (Online only) on this page only.
export function keptText(onPhone: boolean): string {
  return onPhone
    ? 'These changes stay on this phone until they are sent or discarded.'
    : 'Online only keeps nothing on this phone: these changes go when this page closes.';
}

const FACT_LABELS = new Map<string, string>([...FACT_FIELDS.map((field) => [field.key, field.label] as const), ['roomOrder', 'Room order'], ['summary', 'Summary']]);
const ROOM_LABELS = new Map<string, string>(ROOM_FIELDS.map((field) => [field.key, field.label]));

// What edits change, by name, in the order they were made, each once: the job's fields, a room's
// (added, removed, or one of its fields), and a photo's room and tag.
export function changedFields(entries: readonly JournalEntry[]): string[] {
  const names = new Set<string>();
  for (const entry of [...entries].sort((a, b) => a.seq - b.seq)) {
    for (const write of entry.writes) {
      const rest = write.path.startsWith(`${entry.draftPath}/`) ? write.path.slice(entry.draftPath.length + 1).split('/') : [];
      const keys = write.op === 'update' ? Object.keys(write.fields).map((key) => key.replace(/^field\./, '')) : [];
      if (write.path === entry.draftPath) for (const key of keys) names.add(FACT_LABELS.get(key) ?? key);
      else if (rest[0] === 'photos') names.add('A photo’s room and tag');
      else if (rest[0] === 'rooms' && write.op === 'delete') names.add('A room removed');
      else if (rest[0] === 'rooms' && write.op === 'set') {
        const name = (write.data.field as { name?: unknown } | undefined)?.name;
        names.add(typeof name === 'string' && name ? `Room ${name}` : 'A room added');
      } else if (rest[0] === 'rooms') for (const key of keys) names.add(`A room’s ${(ROOM_LABELS.get(key) ?? key).toLowerCase()}`);
    }
  }
  return [...names];
}

export const PHOTOS_STAY = 'Photos stay with the old job once they are sent. Photos waiting on this phone move to the new draft.';
