import type { Auth } from 'firebase/auth';
import { signOutCompany } from '@/lib/firebase-client';
import { forgetMe } from './ds-me';

// Ends this company's sign-in on the phone (S6-2). The field shell must not start from it again, so
// its ds-me row goes first, and the person stays signed in (false) when the row may still be there.
// Throws when Firebase cannot sign out.
export async function signOutOfCompany(auth: Auth, tenantId: string): Promise<boolean> {
  const user = auth.currentUser;
  if (user && !(await forgetMe(tenantId, user.uid))) return false;
  await signOutCompany(auth);
  return true;
}
