import { getApps, initializeApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  connectAuthEmulator,
  getAuth,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateCurrentUser,
  type Auth,
  type User,
} from 'firebase/auth';
import type { BrowserSignInConfig } from '@/lib/config';
import { errorCode, meOutcome, type MeOutcome } from '@/lib/sign-in/outcome';

// The browser side of sign-in (S3-13), for the company sign-in screens only.
//
// Each company signs in through its own Identity Platform tenant (owner decision D3), which the
// sign-in page learns from the company's sign-in address (D5). Every company gets its own Firebase
// app instance, named after its tenant, so its saved sign-in is stored apart from any other
// company's on the same phone: signing in to company A never makes company B's page signed in, and
// signing out of one leaves the other alone. Methods at launch are email with password and Google
// (D10).
//
// The ID token goes only into the Authorization header of this app's own /api calls. Nothing here
// logs a token, an email or a password.

export type CompanySignIn = { config: BrowserSignInConfig; tenantId: string };

// The Auth instance for one company's tenant, created once per page load.
export function companyAuth({ config, tenantId }: CompanySignIn): Auth {
  const name = `dryscope-${tenantId}`;
  const app =
    getApps().find((existing) => existing.name === name) ??
    initializeApp({ apiKey: config.apiKey, authDomain: config.authDomain, projectId: config.projectId }, name);
  const auth = getAuth(app);
  // Every sign-in, email and token request goes to this company's tenant.
  if (auth.tenantId !== tenantId) auth.tenantId = tenantId;
  if (config.authEmulatorUrl !== null && auth.emulatorConfig === null) {
    connectAuthEmulator(auth, config.authEmulatorUrl, { disableWarnings: true });
  }
  return auth;
}

// A saved or new sign-in counts only on the page of the tenant it belongs to.
export function belongsTo(user: User, tenantId: string): boolean {
  return user.tenantId === tenantId;
}

export async function signInWithPassword(auth: Auth, email: string, password: string): Promise<void> {
  await signInWithEmailAndPassword(auth, email.trim(), password);
}

// A pop-up rather than a redirect: on Safari a redirect sign-in through another domain loses its
// result to storage partitioning; a pop-up opened by the tap works.
export async function signInWithGoogle(auth: Auth): Promise<void> {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  await signInWithPopup(auth, provider);
}

// "Set your own password": an invited person's account has no password (D11), and a person who
// forgot theirs takes the same path. Identity Platform emails a link to choose one; after it, the
// link continues back to this company's sign-in page. The answer is the same whether or not the
// email has an account, so the screen cannot be used to test which emails exist.
export async function sendSetPasswordEmail(auth: Auth, email: string, continueUrl: string): Promise<void> {
  try {
    await sendPasswordResetEmail(auth, email.trim(), { url: continueUrl });
  } catch (error) {
    if (errorCode(error) === 'auth/user-not-found') return;
    throw error;
  }
}

export async function sendVerifyEmail(user: User, continueUrl: string): Promise<void> {
  await sendEmailVerification(user, { url: continueUrl });
}

// Asks the server who this sign-in is (GET /api/me). `fresh` gets a new ID token first, so a just
// verified email is in it.
export async function checkSignIn(user: User, fresh = false): Promise<MeOutcome> {
  let response: Response;
  try {
    if (fresh) await user.reload();
    const token = await user.getIdToken(fresh);
    response = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
  } catch {
    return { kind: 'unavailable' };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // An answer with no JSON is judged on its status alone.
  }
  return meOutcome(response.status, body);
}

// Removes this company's saved sign-in from the phone.
export async function signOutCompany(auth: Auth): Promise<void> {
  const user = auth.currentUser;
  try {
    await signOut(auth);
  } catch (error) {
    if (user) await updateCurrentUser(auth, user).catch(() => undefined);
    throw error;
  }
}
