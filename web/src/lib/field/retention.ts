import type { BrowserSignInConfig } from '@/lib/config';
import { discardFieldWork, type FieldPerson } from '@/lib/field-db';
import { meKey, readAllMe } from './ds-me';
import { sessionValid } from './sync-gate';
import { allOutlivedLocks, lockOutlived, noteLocked, noteUnlocked, readUnsent, savedReason, type SavedReason } from './unsent';
import { holdsWindow } from './window-lock';

// Locked work and the 30-day limit (owner decision O5), as one routine (S6-3b). Everything on the
// phone that refuses a person, lets them back in, or merely opens goes through evaluate(now, event)
// below, and nothing else changes a lock or removes locked work.
//
// Each person of each company is in one state, read from the phone's own storage and from `now`:
//
//   none      nothing refused them since they last got through; their work is theirs to send.
//   locked    refused since `since`, for `reason`: nothing is sent, everything is kept.
//   expired   locked for more than 30 days under a refusal O5 removes work for (RETAINED_REASONS):
//             the work may never be sent again, and is removed.
//
//   event \ state            none            locked                     expired
//   refused                  locked (now)    locked (first time kept)   expired
//   a saved sign-in past     locked (now)    locked (first time kept)   expired
//     its role's limit
//   let-in                   none            none                       expired
//   a saved sign-in that     none            none, when only its age    expired
//     counts again                             had locked it
//   entry                    none            locked                     expired
//   the sweep                -               -                          none, once the work is removed
//
// "expired" can only be left by the removal, which every evaluate tries again, so neither a later
// refusal of another kind nor the server letting the person in can make that work sendable.
//
// The state lives apart from the saved sign-in (ds-me): the lock in the person's unsent-work mark
// (unsent.ts), and beside it the company's public browser settings, the only thing that names the
// person's field database (no email, no token, no field values). A lock is never saved without
// them, so the work can still be removed after a sign-out took the saved sign-in away.
//
// After the event, every evaluate sweeps the whole phone, whoever the event was about:
// 1. every saved sign-in is judged: past its role's session limit it is locked out from now, so
//    the clock starts though no server ever refused it; counting again (a newer sign-in was saved)
//    it lifts a lock that only its age had made;
// 2. everyone who is expired has their work removed, unless a field window open elsewhere holds it
//    or the phone's storage refuses; whoever is left stays expired and is tried at the next evaluate.
// A mark that cannot be read counts as locked and never as expired: nothing is removed on a guess.

const CLEANUP_PREFIX = 'ds-retain/';
export const cleanupKey = (tenantId: string): string => `${CLEANUP_PREFIX}${tenantId}`;

type Company = Pick<FieldPerson, 'tenantId' | 'config'>;

// Saves what removing this company's locked work needs, for when no saved sign-in is left. False
// when it could not be saved.
function keepCleanupContext({ tenantId, config }: Company): boolean {
  const { apiKey, authDomain, projectId, authEmulatorUrl, firestoreDatabaseId, firestoreEmulatorUrl } = config;
  const value = JSON.stringify({ apiKey, authDomain, projectId, authEmulatorUrl, firestoreDatabaseId, firestoreEmulatorUrl });
  try {
    // Every event brings them; they are written only when they are new.
    if (window.localStorage.getItem(cleanupKey(tenantId)) !== value) window.localStorage.setItem(cleanupKey(tenantId), value);
    return true;
  } catch {
    return false;
  }
}

const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

function cleanupContext(tenantId: string): BrowserSignInConfig | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(cleanupKey(tenantId)) ?? 'null') as Record<string, unknown> | null;
    if (value === null || typeof value !== 'object') return null;
    const { apiKey, authDomain, projectId, authEmulatorUrl, firestoreDatabaseId, firestoreEmulatorUrl } = value;
    const optional = (field: unknown) => field === undefined || field === null || text(field);
    if (!text(apiKey) || !text(authDomain) || !text(projectId)) return null;
    if (!optional(authEmulatorUrl) || !optional(firestoreDatabaseId) || !optional(firestoreEmulatorUrl)) return null;
    return {
      apiKey,
      authDomain,
      projectId,
      authEmulatorUrl: text(authEmulatorUrl) ? authEmulatorUrl : null,
      ...(text(firestoreDatabaseId) ? { firestoreDatabaseId } : {}),
      ...(text(firestoreEmulatorUrl) ? { firestoreEmulatorUrl } : {}),
    };
  } catch {
    return null;
  }
}

export type RetentionState = 'none' | 'locked' | 'expired';

function stateOf({ tenantId, uid }: Pick<FieldPerson, 'tenantId' | 'uid'>, now: number): RetentionState {
  if (lockOutlived(tenantId, uid, now)) return 'expired';
  return savedReason(tenantId, uid) === null ? 'none' : 'locked';
}

// Saves the lock of a refusal, after what removes the work later, so a lock is never saved without
// it. Returns when the refusals began, or null when the phone holds no lock with a time for this
// person afterwards: the caller must then leave their sign-in and their work exactly as they are.
// evaluate's own step; exported for its tests only.
export function lockWork(person: FieldPerson, reason: SavedReason, now = Date.now()): number | null {
  if (!keepCleanupContext(person) && cleanupContext(person.tenantId) === null) return null;
  const since = noteLocked(person.tenantId, person.uid, reason, now);
  if (since !== null) return since;
  const mark = readUnsent(person.tenantId, person.uid);
  return mark === 'unreadable' ? null : mark.lockedSince;
}

// The "refused" row of the table: true when the phone holds the person's lock afterwards.
function refuse(person: FieldPerson, reason: SavedReason, now: number): boolean {
  return stateOf(person, now) === 'expired' || lockWork(person, reason, now) !== null;
}

// What the phone saved of a sign-in, as far as its age goes (a ds-me row).
type SavedSignIn = { role?: string; authTime?: number };

// The two "saved sign-in" rows of the table.
function judgeSignIn(person: FieldPerson, saved: SavedSignIn, now: number): void {
  if (!sessionValid(saved, now)) refuse(person, 'sign-in-expired', now);
  else if (savedReason(person.tenantId, person.uid) === 'sign-in-expired' && stateOf(person, now) !== 'expired') {
    noteUnlocked(person.tenantId, person.uid);
  }
}

export type RetentionEvent =
  // The phone opened or was shown again (the field shell, signed in or not; the sign-in page; a
  // check of the sync gate that changed nothing). `person`: whose state to answer with, and
  // `saved`: the sign-in the caller started from for them, judged at once. `company`: the company
  // whose page this is, whose settings are kept for a removal with no saved sign-in.
  | { kind: 'entry'; person?: FieldPerson; saved?: SavedSignIn; company?: Company }
  // The person may not go on: the server refused them, the app ends their sign-in, or their saved
  // sign-in is past its role's limit ('sign-in-expired').
  | { kind: 'refused'; person: FieldPerson; reason: SavedReason }
  // The server let the person in.
  | { kind: 'let-in'; person: FieldPerson };

export type Evaluation = {
  // The event's person afterwards. 'unsaved': they were refused and the phone could not save it, so
  // nothing of theirs may be signed out or removed, and the caller tries again.
  state: RetentionState | 'unsaved';
  // Settles when this evaluate's sweep is over, with everyone whose work it removed (meKey).
  done: Promise<string[]>;
};

const removedListeners = new Set<(person: string) => void>();
// Whose work this page removed and no field shell has said so yet.
const removedUntold = new Set<string>();

// True, once, when this page removed the person's work (meKey) and their field shell has not said
// so yet: whichever entry point removed it, before or after that shell started, the person is told.
export function takeRemoved(person: string): boolean {
  return removedUntold.delete(person);
}

// Calls `listener` with the person (meKey) each time an evaluate on this page removes someone's
// work, whichever entry point it came from. Returns what stops it.
export function onWorkRemoved(listener: (person: string) => void): () => void {
  removedListeners.add(listener);
  return () => void removedListeners.delete(listener);
}

async function sweep(now: number): Promise<string[]> {
  const removed: string[] = [];
  try {
    const saved = await readAllMe();
    // Judged in one go after the read, so a sign-in saved since is never locked out.
    for (const row of saved) judgeSignIn(row, row, now);
    for (const { tenantId, uid } of allOutlivedLocks(now)) {
      const config = cleanupContext(tenantId) ?? saved.find((row) => row.tenantId === tenantId)?.config;
      if (!config) continue;
      // This page's own field window holds the one-window lock; any other page must find it free.
      const result = await discardFieldWork({ tenantId, uid, config }, { lockHeld: holdsWindow() }).catch(() => 'failed' as const);
      if (result !== 'discarded') continue;
      const person = meKey(tenantId, uid);
      removed.push(person);
      removedUntold.add(person);
      for (const listener of [...removedListeners]) listener(person);
    }
  } catch {
    // Whatever could not be read or removed now is tried at the next evaluate.
  }
  return removed;
}

// One sweep at a time on a page: two would start the same removal twice.
let sweeping: Promise<unknown> = Promise.resolve();

// The one entry to the phone's refusal and retention bookkeeping. The event is applied at once
// (`state` is the person's state as this call returns), then the phone is swept (`done`).
export function evaluate(now: number, event: RetentionEvent): Evaluation {
  // Whoever the event names brings their company's settings: kept, so that work locked before
  // they were (by an earlier version, or a storage failure) can be removed too.
  const company = event.kind === 'entry' ? (event.person ?? event.company) : event.person;
  if (company) keepCleanupContext(company);
  let state: Evaluation['state'] = 'none';
  if (event.kind === 'entry') {
    if (event.person && event.saved) judgeSignIn(event.person, event.saved, now);
    if (event.person) state = stateOf(event.person, now);
  } else if (event.kind === 'refused') {
    state = refuse(event.person, event.reason, now) ? stateOf(event.person, now) : 'unsaved';
  } else {
    if (stateOf(event.person, now) !== 'expired') noteUnlocked(event.person.tenantId, event.person.uid);
    state = stateOf(event.person, now);
  }
  const done = sweeping.then(() => sweep(now));
  sweeping = done;
  return { state, done };
}

// How often a page that stays shown runs the routine again.
export const WATCH_EVERY_MS = 60_000;

// The entry points every page shares: now, each time the page is shown again (made visible, or
// brought back from the back-forward cache), when locked work may have outlived the limit while
// the page was away, and every minute while it stays shown, for a page left open across the limit
// and for a removal the phone's storage refused. Returns what stops it.
export function watchRetention(company?: Company): () => void {
  const enter = () => {
    if (document.visibilityState === 'visible') void evaluate(Date.now(), company ? { kind: 'entry', company } : { kind: 'entry' });
  };
  void evaluate(Date.now(), company ? { kind: 'entry', company } : { kind: 'entry' });
  document.addEventListener('visibilitychange', enter);
  window.addEventListener('pageshow', enter);
  const tick = setInterval(enter, WATCH_EVERY_MS);
  return () => {
    document.removeEventListener('visibilitychange', enter);
    window.removeEventListener('pageshow', enter);
    clearInterval(tick);
  };
}
