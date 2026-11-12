import type { Auth } from 'firebase/auth';
import { signOutCompany } from '@/lib/firebase-client';
import { forgetMe, saveMe } from './ds-me';

// Ends this company's sign-in on the phone (S6-2). The field shell must not start from it again, so
// its ds-me row goes first. Throws, and the person stays signed in with the row in place, when the
// row may still be there or Firebase cannot sign out (the removed row is then saved again).
export async function signOutOfCompany(auth: Auth, tenantId: string): Promise<void> {
  const user = auth.currentUser;
  const removed = user ? await forgetMe(tenantId, user.uid) : null;
  if (removed === false) throw new Error('the saved sign-in may still be on this phone');
  try {
    await signOutCompany(auth);
  } catch (error) {
    if (removed) await saveMe(removed);
    throw error;
  }
}
