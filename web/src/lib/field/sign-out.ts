import type { Auth } from 'firebase/auth';
import type { BrowserSignInConfig } from '@/lib/config';
import { signOutCompany } from '@/lib/firebase-client';
import { discardFieldWork, stopFieldClient } from '@/lib/field-db';
import { forgetMe, saveMe } from './ds-me';
import { evaluate } from './retention';
import { unsentWork, type LockReason } from './unsent';

// Ends this company's sign-in on the phone (S6-2). The field shell must not start from it again, so
// its ds-me row goes first. Throws, and the person stays signed in with the row in place, when the
// row may still be there or Firebase cannot sign out (the removed row is then saved again).
//
// Both sign-outs here keep the person's field cache and unsent work (S6-3), because unsent work is
// kept through a re-sign-in (D7) and the same person signing in again sends it. Their cache is a
// database of its own (field-db.ts), which no other person's client opens.
async function leave(auth: Auth, tenantId: string): Promise<void> {
  const user = auth.currentUser;
  const removed = user ? await forgetMe(tenantId, user.uid) : null;
  if (removed === false) throw new Error('the saved sign-in may still be on this phone');
  try {
    if (user) await stopFieldClient({ tenantId, uid: user.uid });
    await signOutCompany(auth);
  } catch (error) {
    if (removed) await saveMe(removed);
    throw error;
  }
}

// The refusal could not be saved on the phone: nothing was signed out or removed, and the screen
// asks the person to try again.
export class WorkNotSecuredError extends Error {
  constructor() {
    super('the refusal could not be saved on this phone');
  }
}

export type FailedSignOut = { name: 'not-secured'; retry: () => Promise<void> } | { name: 'unavailable' };

// Makes a sign-out the server's refusal asks for (signOutOnRefusal), then `after`. When it fails,
// `show` gets the screen to show: 'not-secured' when the refusal could not be saved, whose retry is
// this whole call again (the same sign-out for the same refusal, then the same `after`), so the
// refusal is saved before anything of the company can open again; otherwise the screen's own
// "could not open".
export async function signOutOrShow(signOut: () => Promise<void>, show: (failed: FailedSignOut) => void, after?: () => void): Promise<void> {
  try {
    await signOut();
  } catch (error) {
    show(error instanceof WorkNotSecuredError ? { name: 'not-secured', retry: () => signOutOrShow(signOut, show, after) } : { name: 'unavailable' });
    return;
  }
  after?.();
}

// Every sign-out the person did not ask for: the server refused them (sign in again, a second step,
// another company's sign-in, an account turned off). The refusal goes to the phone's retention
// routine (retention.ts) first, which saves it apart from the saved sign-in, so the 30-day limit
// for locked work (O5) runs from now even though the field shell will not start for this person
// again (S6-3b). Throws WorkNotSecuredError, with the saved sign-in and the work left as they
// were, when the phone could not save it; calling it again is the retry.
export async function signOutOnRefusal(auth: Auth, tenantId: string, config: BrowserSignInConfig, refusal: LockReason): Promise<void> {
  const user = auth.currentUser;
  if (user) {
    const { state, done } = evaluate(Date.now(), { kind: 'refused', person: { tenantId, uid: user.uid, config }, reason: refusal });
    if (state === 'unsaved') throw new WorkNotSecuredError();
    // Work already past the limit is removed before the sign-in that names it goes.
    await done;
  }
  await leave(auth, tenantId);
}

// The person's own "Sign out" when they chose Keep: nothing refused them, so nothing is locked.
export async function signOutKeeping(auth: Auth, tenantId: string): Promise<void> {
  await leave(auth, tenantId);
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
  const user = auth.currentUser;
  if (user) {
    const result = await discardFieldWork({ tenantId, uid: user.uid, config });
    if (result !== 'discarded') return result;
  }
  await leave(auth, tenantId);
  return 'signed-out';
}
