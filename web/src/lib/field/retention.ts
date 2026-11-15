import type { BrowserSignInConfig } from '@/lib/config';
import { discardFieldWork, type FieldPerson } from '@/lib/field-db';
import { meKey, readAllMe } from './ds-me';
import { sessionValid } from './sync-gate';
import { LOCKED_LIMIT_MS, lockOutlived, noteLocked, noteUnlocked, RETAINED_REASONS, savedReason, type SavedReason } from './unsent';
import { holdsWindow } from './window-lock';

// Locked work and the 30-day limit (owner decisions O5, 010 and 011), as one routine (S6-3b).
// Everything on the phone that refuses a person, lets them back in, or merely opens goes through
// evaluate(now, event) below, and nothing else changes a lock or removes locked work.
//
// Each person of each company is in one state, read from the phone's own storage and from `now`:
//
//   none      nothing refused them since they last got through; their work is theirs to send.
//   locked    refused since `since`, for `reason`: nothing is sent, everything is kept.
//   hidden    locked for more than 30 days under a refusal O5 applies to (RETAINED_REASONS): the
//             work is neither shown nor sent, and the field app does not open for it offline.
//
// "hidden" is only ever read, from the saved lock and the clock; nothing is written to hide, so any
// tab may judge it again, in any order. Work is removed only when the server itself, in the very
// operation that removes, says the person or the company is refused or removed (REMOVING_REASONS:
// company inactive, member turned off, membership removed, account turned off) while they are
// hidden (decisions 010, 011). Nothing the phone holds, retries or replays ever removes anything.
//
//   event \ state            none            locked                     hidden
//   refused                  locked (now)    locked (first time kept)   hidden; removed when the
//                                                                          server removed them just now
//   a saved sign-in past     locked (now)    locked (first time kept)   hidden
//     its role's limit
//   let-in                   none            none                       none
//   a saved sign-in that     none            none, when only its age    hidden
//     counts again                             had locked it
//   entry                    none            locked                     hidden
//
// The server letting the person in lifts their own lock, however old: their work shows and is sent
// again. It changes nothing for anyone else.
//
// The state lives apart from the saved sign-in (ds-me): the lock in the person's unsent-work mark
// (unsent.ts), and beside it the company's public browser settings (no email, no token, no field
// values). A lock is never saved without them. A refusal the phone could not save is held by the
// page with the time it was given and saved with that time at the next evaluate that can, so the 30
// days run from the refusal; held, it keeps the person's work closed, and it only ever locks.
//
// After the event, every evaluate sweeps the whole phone, whoever the event was about: every saved
// sign-in is judged; past its role's session limit it is locked out from now, so the clock starts
// though no server ever refused it; counting again (a newer sign-in was saved) it lifts a lock that
// only its age had made. The sweep removes nothing. A mark that cannot be read counts as locked and
// never as hidden.

const CLEANUP_PREFIX = 'ds-retain/';
export const cleanupKey = (tenantId: string): string => `${CLEANUP_PREFIX}${tenantId}`;

type Company = Pick<FieldPerson, 'tenantId' | 'config'>;

// Saves the company's public browser settings, which name the person's field database, beside the
// lock. False when they could not be saved.
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

export type RetentionState = 'none' | 'locked' | 'hidden';

function stateOf({ tenantId, uid }: Pick<FieldPerson, 'tenantId' | 'uid'>, now: number): RetentionState {
  if (lockOutlived(tenantId, uid, now)) return 'hidden';
  return savedReason(tenantId, uid) === null ? 'none' : 'locked';
}

// Saves the lock of a refusal, after the company's settings, so a lock is never saved without them.
// Returns when the refusals began, or null when either could not be saved: the caller must then
// leave the person's sign-in and their work exactly as they are. evaluate's own step; exported for
// its tests only.
export function lockWork(person: FieldPerson, reason: SavedReason, now = Date.now()): number | null {
  if (!keepCleanupContext(person) && cleanupContext(person.tenantId) === null) return null;
  return noteLocked(person.tenantId, person.uid, reason, now);
}

// What the server says when the person or the company is refused or removed: the only refusals
// that may remove work, and only as the server's own answer in the operation that removes (011).
const REMOVING_REASONS: ReadonlySet<SavedReason> = new Set<SavedReason>(['company-inactive', 'member-disabled', 'needs-invitation', 'account-disabled']);

// Refusals the phone could not save, held by this page in the order they were given, each with when
// it was given (the same refusal again keeps its first time). Tried again, with that time, at the
// start of every evaluate; dropped once saved or when the person is let in.
type Held = { reason: SavedReason; at: number };
const pending = new Map<string, { person: FieldPerson; held: Held[] }>();

function save(person: FieldPerson, reason: SavedReason, at: number, now: number): boolean {
  return stateOf(person, now) === 'hidden' || lockWork(person, reason, at) !== null;
}

// The "refused" row of the table: true when the phone holds the person's lock afterwards. A hidden
// lock is kept as it is, so no later refusal of another kind shows that work again. While this page
// holds refusals for the person, a new one is held behind them.
function refuse(person: FieldPerson, reason: SavedReason, now: number): boolean {
  const key = meKey(person.tenantId, person.uid);
  if (stateOf(person, now) === 'hidden' || (!pending.has(key) && save(person, reason, now, now))) return true;
  const entry = pending.get(key) ?? { person, held: [] };
  if (entry.held.at(-1)?.reason !== reason) entry.held.push({ reason, at: now });
  pending.set(key, entry);
  return false;
}

function retryPending(now: number): void {
  for (const [key, { person, held }] of [...pending]) {
    const left = held.filter((one) => !save(person, one.reason, one.at, now));
    if (left.length === 0) pending.delete(key);
    else pending.set(key, { person, held: left });
  }
}

// Whether the person's field content may not show: their work is hidden, locked for more than 30
// days under a refusal O5 applies to, by a lock saved on the phone or one this page holds with the
// time it was given (decisions 010, 011). The one answer the shell, its store and the job screens
// ask; read, never written.
export function contentHidden(tenantId: string, uid: string, now: number): boolean {
  if (lockOutlived(tenantId, uid, now)) return true;
  const held = pending.get(meKey(tenantId, uid))?.held ?? [];
  return held.some((one) => RETAINED_REASONS.has(one.reason) && now - one.at > LOCKED_LIMIT_MS);
}

// The first refusal this page holds for the person and could not save yet, or null. Their work
// stays closed while one is held.
export function pendingReason(tenantId: string, uid: string): SavedReason | null {
  return pending.get(meKey(tenantId, uid))?.held[0]?.reason ?? null;
}

// Forgets every refusal this page holds; for tests only, which share one page.
export function forgetPending(): void {
  pending.clear();
}

// What the phone saved of a sign-in, as far as its age goes (a ds-me row).
type SavedSignIn = { role?: string; authTime?: number };

// The two "saved sign-in" rows of the table. False when the sign-in is past its limit and the phone
// could not save the lock that says so.
function judgeSignIn(person: FieldPerson, saved: SavedSignIn, now: number): boolean {
  if (!sessionValid(saved, now)) return refuse(person, 'sign-in-expired', now);
  if (savedReason(person.tenantId, person.uid) === 'sign-in-expired' && stateOf(person, now) !== 'hidden') {
    noteUnlocked(person.tenantId, person.uid);
  }
  return true;
}

export type RetentionEvent =
  // The phone opened or was shown again (the field shell, signed in or not; the sign-in page; a
  // check of the sync gate that changed nothing). `person`: whose state to answer with, and
  // `saved`: the sign-in the caller started from for them, judged at once. `company`: the company
  // whose page this is, whose settings are kept.
  | { kind: 'entry'; person?: FieldPerson; saved?: SavedSignIn; company?: Company }
  // The person may not go on: the server refused them, the app ends their sign-in, or their saved
  // sign-in is past its role's limit ('sign-in-expired'). `fromServer`: the server gave this
  // refusal just now, in this operation (the sync gate's GET /api/me, or the answer that makes a
  // screen end the sign-in); only that, with a reason in REMOVING_REASONS, may remove hidden work.
  // A refusal the phone made itself, retried or replayed never does.
  | { kind: 'refused'; person: FieldPerson; reason: SavedReason; fromServer?: boolean }
  // The server let the person in: their own lock is lifted.
  | { kind: 'let-in'; person: FieldPerson };

export type Evaluation = {
  // The event's person afterwards. 'unsaved': they were refused, let in, or their saved sign-in was
  // past its limit, and the phone could not save it: on a refusal or an expired sign-in nothing of
  // theirs may be signed out or removed (the refusal is held); on a let-in their lock still stands
  // and nothing may open. Either way the caller tries again. An entry answers 'locked' for a person
  // whose refusal is held.
  state: RetentionState | 'unsaved';
  // Settles when this evaluate is over, with everyone whose work it removed (meKey).
  done: Promise<string[]>;
};

const removedListeners = new Set<(person: string, removed: boolean) => void>();
// Whose work this page removed and no field shell has said so yet.
const removedUntold = new Set<string>();

// True, once, when this page removed the person's work (meKey) and their field shell has not said
// so yet: whichever entry point removed it, before or after that shell started, the person is told.
export function takeRemoved(person: string): boolean {
  return removedUntold.delete(person);
}

// Calls `listener` with the person (meKey) each time an evaluate on this page removes someone's
// work (`removed`), or set out to and could not finish once it had stopped their field client
// (`removed` false: that client must be opened again). Returns what stops it.
export function onWorkRemoved(listener: (person: string, removed: boolean) => void): () => void {
  removedListeners.add(listener);
  return () => void removedListeners.delete(listener);
}

// The sweep, then the removal the event confirmed: `confirmed`, removed by the server just now while
// hidden. Still hidden when its turn comes, and again at the moment the work would be erased (a
// let-in elsewhere meanwhile lifts the lock), or nothing goes.
async function sweep(now: number, confirmed: FieldPerson | null): Promise<string[]> {
  try {
    const saved = await readAllMe();
    // Judged in one go after the read, so a sign-in saved since is never locked out.
    for (const row of saved) judgeSignIn(row, row, now);
    if (!confirmed || stateOf(confirmed, now) !== 'hidden') return [];
    // This page's own field window holds the one-window lock; any other page must find it free.
    const stillHidden = () => stateOf(confirmed, now) === 'hidden';
    const result = await discardFieldWork(confirmed, { lockHeld: holdsWindow(), stillWanted: stillHidden }).catch(() => 'failed' as const);
    // Another window holds the work: nothing was touched. Otherwise the person's client was stopped,
    // and unless the work is gone it must be opened again ('kept': let in meanwhile, nothing erased).
    if (result === 'elsewhere') return [];
    const person = meKey(confirmed.tenantId, confirmed.uid);
    const removed = result === 'discarded';
    if (removed) removedUntold.add(person);
    for (const listener of [...removedListeners]) listener(person, removed);
    return removed ? [person] : [];
  } catch {
    // Whatever could not be read or removed now waits for the next confirmation.
    return [];
  }
}

// One sweep at a time on a page: two would start the same removal twice.
let sweeping: Promise<unknown> = Promise.resolve();

// The one entry to the phone's refusal and retention bookkeeping. The event is applied at once
// (`state` is the person's state as this call returns), then the phone is swept (`done`).
export function evaluate(now: number, event: RetentionEvent): Evaluation {
  // Whoever the event names brings their company's settings: kept beside their lock.
  const company = event.kind === 'entry' ? (event.person ?? event.company) : event.person;
  if (company) keepCleanupContext(company);
  retryPending(now);
  let state: Evaluation['state'] = 'none';
  let confirmed: FieldPerson | null = null;
  if (event.kind === 'entry') {
    const { person, saved } = event;
    if (person && saved && !judgeSignIn(person, saved, now)) state = 'unsaved';
    else if (person) state = stateOf(person, now) === 'none' && pendingReason(person.tenantId, person.uid) ? 'locked' : stateOf(person, now);
  } else if (event.kind === 'refused') {
    state = refuse(event.person, event.reason, now) ? stateOf(event.person, now) : 'unsaved';
    if (state === 'hidden' && event.fromServer && REMOVING_REASONS.has(event.reason)) confirmed = event.person;
  } else if (noteUnlocked(event.person.tenantId, event.person.uid)) {
    pending.delete(meKey(event.person.tenantId, event.person.uid));
    state = 'none';
  } else {
    state = 'unsaved';
  }
  const done = sweeping.then(() => sweep(now, confirmed));
  sweeping = done;
  return { state, done };
}

// How often a page that stays shown runs the routine again.
export const WATCH_EVERY_MS = 60_000;

// The entry points every page shares: now, each time the page is shown again (made visible, or
// brought back from the back-forward cache), and every minute while it stays shown, so a saved
// sign-in that passed its role's limit meanwhile starts its clock. Returns what stops it.
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
