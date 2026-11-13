import type { Auth } from 'firebase/auth';
import type { BrowserSignInConfig } from '@/lib/config';
import { signOutCompany } from '@/lib/firebase-client';
import { discardFieldWork, stopFieldClient } from '@/lib/field-db';
import { forgetMe, saveMe } from './ds-me';
import { unsentWork } from './unsent';

// Ends this company's sign-in on the phone (S6-2). The field shell must not start from it again, so
// its ds-me row goes first. Throws, and the person stays signed in with the row in place, when the
// row may still be there or Firebase cannot sign out (the removed row is then saved again).
//
// This keeps the person's field cache and unsent work (S6-3): it is what every sign-out the person
// did not ask for uses (a sign-in that must be made again, a refusal), because unsent work is kept
// through a re-sign-in (D7) and the same person signing in again sends it. Their cache is a
// database of its own (field-db.ts), which no other person's client opens.
export async function signOutOfCompany(auth: Auth, tenantId: string): Promise<void> {
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
  await signOutOfCompany(auth, tenantId);
  return 'signed-out';
}
