import type { Auth, User } from 'firebase/auth';
import type { BrowserSignInConfig } from '@/lib/config';
import { signOutCompany } from '@/lib/firebase-client';
import { discardFieldWork, stopFieldClient } from '@/lib/field-db';
import { forgetMe, readMe, restoreMe } from './ds-me';
import { evaluate, pendingReason } from './retention';
import { unsentWork, type LockReason } from './unsent';

// Ends this company's sign-in on the phone (S6-2). The field shell must not start from it again, so
// its ds-me row goes first. Throws, and the person stays signed in with the row in place, when the
// row may still be there or Firebase cannot sign out (the removed row is then saved again).
//
// Both sign-outs here keep the person's field cache and unsent work (S6-3), because unsent work is
// kept through a re-sign-in (D7) and the same person signing in again sends it. Their cache is a
// database of its own (field-db.ts), which no other person's client opens.
//
// Every sign-out ends here, the person's own and the app's. The saved sign-in is judged by the
// phone's retention routine (retention.ts) before it goes, so one past its role's limit locks the
// work from now even though no row is left to find later (O5, S6-3b). Throws WorkNotSecuredError,
// with the row and the work left as they were, when that lock cannot be saved, the page still holds
// a refusal for the person it could not save, or the row cannot be read in time (it may be there).
//
// `from` is the sign-in the sign-out was started for. When anyone has signed in since (another
// person, or the same person again, in this tab or another), that newer sign-in and its saved
// sign-in are left alone: the sign-in this was for has ended already.
async function leave(auth: Auth, tenantId: string, from: Session): Promise<void> {
  if (!stillSignedIn(auth, from)) return;
  const { user } = from;
  const found = user ? await readMe(tenantId, user.uid) : null;
  if (!stillSignedIn(auth, from)) return;
  if (found === false) throw new WorkNotSecuredError(() => leave(auth, tenantId, from));
  if (found) {
    const { state, done } = evaluate(Date.now(), { kind: 'entry', person: { tenantId, uid: found.uid, config: found.config }, saved: found });
    if (state === 'unsaved' || pendingReason(tenantId, found.uid) !== null) throw new WorkNotSecuredError(() => leave(auth, tenantId, from));
    await done;
    if (!stillSignedIn(auth, from)) return;
  }
  const removed = user ? await forgetMe(tenantId, user.uid, found?.savedAt ?? null) : null;
  if (!stillSignedIn(auth, from)) return;
  if (removed === false) throw new Error('the saved sign-in may still be on this phone');
  try {
    if (user) await stopFieldClient({ tenantId, uid: user.uid });
    if (stillSignedIn(auth, from)) await signOutCompany(auth);
  } catch (error) {
    if (removed) await restoreMe(removed);
    throw error;
  }
}

// One sign-in: Firebase keeps the same user object when another tab signs the same person in
// again, so the sign-in is told apart by its time, read when the sign-out starts, or by a screen
// when it sends the request whose refusal may end that sign-in (signInOf).
type Session = { user: User | null; key: string | null };
export type SignIn = Session;

function sessionKey(user: User | null): string | null {
  return user ? `${user.uid} ${user.metadata.lastSignInTime ?? ''}` : null;
}

function session(auth: Auth): Session {
  return { user: auth.currentUser, key: sessionKey(auth.currentUser) };
}

// The sign-in current on `auth` now: what a screen keeps as it sends a request whose refusal may
// end it, so the sign-out ends that sign-in and never a newer one.
export function signInOf(auth: Auth): SignIn {
  return session(auth);
}

function stillSignedIn(auth: Auth, from: Session): boolean {
  return sessionKey(auth.currentUser) === from.key;
}

// A lock (a refusal, or a saved sign-in past its limit) could not be saved on the phone: nothing was
// signed out or removed, and the screen asks the person to try again. `retry` is the same sign-out
// for the same sign-in; it does nothing once anyone has signed in since.
export class WorkNotSecuredError extends Error {
  constructor(readonly retry: () => Promise<void>) {
    super('the refusal could not be saved on this phone');
  }
}

export type FailedSignOut = { name: 'not-secured'; retry: () => Promise<void> } | { name: 'unavailable' };

// Makes a sign-out the server's refusal asks for (signOutOnRefusal), then `after`. When it fails,
// `show` gets the screen to show: 'not-secured' when the refusal could not be saved, whose retry is
// the same sign-out for the same person and refusal, then the same `after`, so the refusal is saved
// before anything of the company can open again; otherwise the screen's own "could not open".
export async function signOutOrShow(signOut: () => Promise<void>, show: (failed: FailedSignOut) => void, after?: () => void): Promise<void> {
  try {
    await signOut();
  } catch (error) {
    show(error instanceof WorkNotSecuredError ? { name: 'not-secured', retry: () => signOutOrShow(error.retry, show, after) } : { name: 'unavailable' });
    return;
  }
  after?.();
}

// Every sign-out the person did not ask for: the server refused them (sign in again, a second step,
// another company's sign-in, an account turned off). The refusal goes to the phone's retention
// routine (retention.ts) first, which saves it apart from the saved sign-in, so the 30-day limit
// for locked work (O5) runs from now even though the field shell will not start for this person
// again (S6-3b). Throws WorkNotSecuredError, with the saved sign-in and the work left as they
// were, when the phone could not save it; its `retry` is the retry. `fromServer`: the server gave
// this refusal just now; only then may work already past the limit be removed (decisions 010, 011).
// The retry is no answer from the server: it only locks. `from`: the sign-in refused (signInOf, kept
// when the request was sent); the current one when left out.
export function signOutOnRefusal(
  auth: Auth,
  tenantId: string,
  config: BrowserSignInConfig,
  refusal: LockReason,
  fromServer = false,
  from: SignIn = session(auth),
): Promise<void> {
  return refuse(auth, from, tenantId, config, refusal, fromServer);
}

async function refuse(auth: Auth, from: Session, tenantId: string, config: BrowserSignInConfig, refusal: LockReason, fromServer: boolean): Promise<void> {
  if (!stillSignedIn(auth, from)) return;
  const { user } = from;
  if (user) {
    const { state, done } = evaluate(Date.now(), { kind: 'refused', person: { tenantId, uid: user.uid, config }, reason: refusal, fromServer });
    if (state === 'unsaved') throw new WorkNotSecuredError(() => refuse(auth, from, tenantId, config, refusal, false));
    // Work past the limit that the server's refusal removes goes before the sign-in that names it.
    await done;
  }
  await leave(auth, tenantId, from);
}

// The person's own "Sign out" when they chose Keep: nothing refused them, so nothing is locked
// unless their saved sign-in is past its role's limit (leave).
export async function signOutKeeping(auth: Auth, tenantId: string): Promise<void> {
  await leave(auth, tenantId, session(auth));
}

// Whether the signed-in person may have field edits that the server does not have yet, in this
// company only: 'kept' on this phone (the sign-out button then asks to keep or discard them), or
// only in a window's memory, which nothing on this page can keep.
export function hasUnsentWork(auth: Auth, tenantId: string): 'none' | 'kept' | 'memory' {
  const user = auth.currentUser;
  return user === null ? 'none' : unsentWork(tenantId, user.uid);
}

export type SignOutResult = 'signed-out' | 'elsewhere' | 'failed';

// The person's own "Sign out" when they chose to leave nothing behind (no unsent work, or Discard):
// their cache and unsent work for this company go first, then the sign-in. Another company's and
// another person's stay. 'elsewhere' when a field window is open, which holds that cache; nothing is
// removed and the person stays signed in.
export async function signOutDiscarding(auth: Auth, tenantId: string, config: BrowserSignInConfig): Promise<SignOutResult> {
  const from = session(auth);
  if (from.user) {
    const result = await discardFieldWork({ tenantId, uid: from.user.uid, config });
    if (result !== 'discarded') return result === 'elsewhere' ? 'elsewhere' : 'failed';
  }
  await leave(auth, tenantId, from);
  return 'signed-out';
}
