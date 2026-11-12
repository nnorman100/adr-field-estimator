import { getApps, initializeApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  TotpMultiFactorGenerator,
  connectAuthEmulator,
  getAuth,
  getMultiFactorResolver,
  multiFactor,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  type Auth,
  type MultiFactorResolver,
  type TotpSecret,
  type User,
} from 'firebase/auth';
import type { BrowserSignInConfig } from '@/lib/config';
import { authenticatorUri } from '@/lib/sign-in/second-step';
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

// A sign-in that passed the first step and now waits for a code from an authenticator app (S3-14).
// Identity Platform answers a correct password or Google account of an enrolled person this way
// instead of signing them in. `factors` are the person's authenticator apps; a text-message factor
// is never offered (owner decision D1).
export type SecondStepChallenge = { resolver: MultiFactorResolver; factors: { id: string; name: string }[] };

// The challenge inside a "second step required" error, or null when the error is something else.
function challengeFrom(auth: Auth, error: unknown): SecondStepChallenge | null {
  if (errorCode(error) !== 'auth/multi-factor-auth-required') return null;
  const resolver = getMultiFactorResolver(auth, error as Parameters<typeof getMultiFactorResolver>[1]);
  const factors = resolver.hints
    .filter((hint) => hint.factorId === TotpMultiFactorGenerator.FACTOR_ID)
    .map((hint) => ({ id: hint.uid, name: hint.displayName ?? 'Authenticator app' }));
  // No authenticator app on the account: nothing here can finish this sign-in.
  if (factors.length === 0) throw Object.assign(new Error('no authenticator app'), { code: 'dryscope/no-authenticator' });
  return { resolver, factors };
}

// Signs in with email and password. Returns the challenge when the account has a second step, so
// the screen asks for the code; null when the person is signed in (the auth state listener then
// takes over).
export async function signInWithPassword(
  auth: Auth,
  email: string,
  password: string,
): Promise<SecondStepChallenge | null> {
  try {
    await signInWithEmailAndPassword(auth, email.trim(), password);
    return null;
  } catch (error) {
    const challenge = challengeFrom(auth, error);
    if (challenge) return challenge;
    throw error;
  }
}

// A pop-up rather than a redirect: on Safari a redirect sign-in through another domain loses its
// result to storage partitioning; a pop-up opened by the tap works.
export async function signInWithGoogle(auth: Auth): Promise<SecondStepChallenge | null> {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    await signInWithPopup(auth, provider);
    return null;
  } catch (error) {
    const challenge = challengeFrom(auth, error);
    if (challenge) return challenge;
    throw error;
  }
}

// Finishes a sign-in with the code from the chosen authenticator app. A wrong code throws
// auth/invalid-verification-code and signs nobody in. Returns the signed-in account's id.
export async function completeSecondStepSignIn(
  challenge: SecondStepChallenge,
  factorId: string,
  code: string,
): Promise<{ uid: string }> {
  const result = await challenge.resolver.resolveSignIn(TotpMultiFactorGenerator.assertionForSignIn(factorId, code));
  return { uid: result.user.uid };
}

// A new authenticator app being set up: the secret Firebase made for it, as the address behind the
// QR code and as the key to type.
export type AuthenticatorSetup = { secret: TotpSecret; key: string; uri: string };

// Starts setting up an authenticator app for the signed-in person (the first one, or a spare).
// `issuer` labels the entry inside the person's app, with their email.
export async function startAuthenticatorSetup(user: User, issuer: string): Promise<AuthenticatorSetup> {
  const session = await multiFactor(user).getSession();
  const secret = await TotpMultiFactorGenerator.generateSecret(session);
  const uri = authenticatorUri({
    issuer,
    account: user.email ?? 'account',
    secret: secret.secretKey,
    digits: secret.codeLength,
    periodSeconds: secret.codeIntervalSeconds,
    algorithm: secret.hashingAlgorithm,
  });
  return { secret, key: secret.secretKey, uri };
}

// Finishes it with a code from the app the person just set up, which proves the app has the key.
// A wrong code throws auth/invalid-verification-code and enrols nothing.
export async function finishAuthenticatorSetup(
  user: User,
  setup: AuthenticatorSetup,
  code: string,
  name: string,
): Promise<void> {
  await multiFactor(user).enroll(TotpMultiFactorGenerator.assertionForEnrollment(setup.secret, code), name);
}

// How many authenticator apps the person has, after asking Firebase; null when that cannot be read.
export async function authenticatorCount(user: User): Promise<number | null> {
  try {
    await user.reload();
  } catch {
    return null;
  }
  return multiFactor(user).enrolledFactors.filter((factor) => factor.factorId === TotpMultiFactorGenerator.FACTOR_ID)
    .length;
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

// One call to this app's own API as the signed-in person (the team and invitation screens, S3-16).
// `status` 0 means the call never got an answer (no signal); the server's answer is judged by its
// status and fixed error code only, as in checkSignIn.
export type ApiAnswer = { status: number; body: unknown };

export async function callApi(user: User, path: string, init: { method?: string; json?: unknown } = {}): Promise<ApiAnswer> {
  let response: Response;
  try {
    const token = await user.getIdToken();
    response = await fetch(path, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
      cache: 'no-store',
    });
  } catch {
    return { status: 0, body: null };
  }
  try {
    return { status: response.status, body: await response.json() };
  } catch {
    return { status: response.status, body: null };
  }
}

// Removes this company's saved sign-in from the phone.
export async function signOutCompany(auth: Auth): Promise<void> {
  await signOut(auth);
}
