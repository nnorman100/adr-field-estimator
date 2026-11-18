// What the field screens' sync chip and "Can't save" sheet say (S6-4b; docs/plans/S6/S6-4.md and
// S6.md section 3), read from the person's recovery journal (./journal.ts). The screen uses three
// words for the phone's work: Saved (the server has it), Saved on this phone (waiting to send) and
// Can't save (refused, with the reason and what to do). An edit the server holds other values for,
// with no refusal, is "Changed on another device", never "Can't save".
import type { JournalEntry, RejectReason } from './journal';

// What this phone's cache holds of a draft: its state and its job (null when not held).
export type DraftFacts = { state: string | null; jobId: string | null };

export type ProblemReason = 'finished' | 'archived' | Exclude<RejectReason, 'locked'> | 'unknown' | 'changed';

export type Problem = {
  draftPath: string;
  reason: ProblemReason;
  jobId: string | null;
  entries: JournalEntry[];
  // Save as new draft: only for an archived job or field work that moved (owner decision J5), and
  // never after the person's own Finish (that path is Back to editing, J4).
  saveAsNew: boolean;
  // Try again: only where the reason can clear (a restore, the field work moved back, access or the
  // role given back, a reason not known yet).
  tryAgain: boolean;
};

export type SyncStatus =
  | { kind: 'saved' }
  | { kind: 'on-phone'; waiting: number }
  | { kind: 'cant-save'; problems: Problem[] }
  | { kind: 'changed'; problems: Problem[] };

function reasonOf(entries: readonly JournalEntry[], facts: DraftFacts | undefined): ProblemReason {
  const newest = [...entries].reverse().find((entry) => entry.state === 'rejected' && entry.reason);
  if (!newest?.reason) return 'unknown';
  if (newest.reason !== 'locked') return newest.reason;
  return facts?.state === 'archived' ? 'archived' : 'finished';
}

// `canSaveAsNew`: the person may start a job and does field work (jobs_create and scope).
export function syncStatus(entries: readonly JournalEntry[], facts: ReadonlyMap<string, DraftFacts>, canSaveAsNew: boolean): SyncStatus {
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
  const problem = (draftPath: string, group: JournalEntry[], reason: ProblemReason): Problem => ({
    draftPath,
    reason,
    jobId: facts.get(draftPath)?.jobId ?? null,
    entries: group,
    saveAsNew: canSaveAsNew && (reason === 'archived' || reason === 'owner-changed'),
    tryAgain: reason !== 'finished' && reason !== 'changed',
  });
  if (refused.size > 0) {
    return { kind: 'cant-save', problems: [...refused].map(([path, group]) => problem(path, group, reasonOf(group, facts.get(path)))) };
  }
  if (changed.size > 0) return { kind: 'changed', problems: [...changed].map(([path, group]) => problem(path, group, 'changed')) };
  return waiting > 0 ? { kind: 'on-phone', waiting } : { kind: 'saved' };
}

export const SAVED = 'Saved';
export const SAVED_ON_PHONE = 'Saved on this phone';
export const CANT_SAVE = 'Can’t save';
export const CHANGED_ELSEWHERE = 'Changed on another device';

// The chip's words.
export function chipText(status: SyncStatus): string {
  if (status.kind === 'saved') return SAVED;
  if (status.kind === 'on-phone') return `${SAVED_ON_PHONE} (${status.waiting} waiting to send)`;
  if (status.kind === 'changed') return CHANGED_ELSEWHERE;
  const [only] = status.problems;
  return status.problems.length === 1 && only ? `${CANT_SAVE}: ${REASONS[only.reason].short}` : `${CANT_SAVE}: ${status.problems.length} jobs`;
}

// Per reason: the chip's few words, the sheet's title and what to do.
export const REASONS: Record<ProblemReason, { short: string; title: string; text: string }> = {
  finished: {
    short: 'job finished',
    title: 'This job was finished',
    text: 'These changes were made after the job was finished, so they were not saved. To change the job, go to Finish and review, tap Back to editing, then make them again.',
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
    text: 'These changes were not saved. They stay on this phone: Try again once the company owner gives you back a role that does field work, or discard them.',
  },
  'no-access': {
    short: 'no access',
    title: 'You no longer have access to this job',
    text: 'These changes were not saved. They stay on this phone: Try again once the company owner gives you access again, or discard them.',
  },
  unknown: {
    short: 'checking why',
    title: 'DryScope did not accept these changes',
    text: 'The reason is checked the next time this phone has a signal. They stay on this phone until then: Try again, or discard them.',
  },
  changed: {
    short: 'changed on another device',
    title: CHANGED_ELSEWHERE,
    text: 'This job was changed on another device after these changes were made here, so they were not sent and the other device’s version is kept. Open the job to see it, then make them again, or discard them.',
  },
};

export const PHOTOS_STAY = 'Photos stay with the old job: they are not copied to the new draft.';
