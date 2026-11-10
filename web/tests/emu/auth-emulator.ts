// A small client for the Auth emulator's REST API, enough for the harness tests. Admin calls
// use the emulator's `Bearer owner` token; user calls use any API key. Error text carries only
// the emulator's error code, never the request (no emails, passwords or tokens).
import { requireEmulatorEnv } from './guard';

const env = requireEmulatorEnv(process.env);
export const projectId = env.projectId;
const base = `http://${env.authHost}/identitytoolkit.googleapis.com`;
const ADMIN = { Authorization: 'Bearer owner' };

export type EmulatorReply = { status: number; body: Record<string, unknown> };

export async function call(path: string, body: unknown, admin = false): Promise<EmulatorReply> {
  const response = await fetch(`${base}${path}${admin ? '' : '?key=fake-api-key'}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(admin ? ADMIN : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

export function errorMessage(reply: EmulatorReply): string {
  const error = reply.body.error as { message?: string } | undefined;
  return error?.message ?? '';
}

async function ok(path: string, body: unknown, admin = false): Promise<Record<string, unknown>> {
  const reply = await call(path, body, admin);
  if (reply.status !== 200) {
    throw new Error(`Auth emulator ${path} answered ${reply.status}: ${errorMessage(reply)}`);
  }
  return reply.body;
}

export async function createTenant(displayName: string, extra: Record<string, unknown> = {}): Promise<string> {
  const tenant = await ok(
    `/v2/projects/${projectId}/tenants`,
    { displayName, allowPasswordSignup: true, ...extra },
    true,
  );
  return tenant.tenantId as string;
}

export async function signUp(tenantId: string, email: string, password: string): Promise<string> {
  const user = await ok('/v1/accounts:signUp', { tenantId, email, password, returnSecureToken: true });
  return user.localId as string;
}

export async function signIn(tenantId: string, email: string, password: string): Promise<string> {
  const session = await ok('/v1/accounts:signInWithPassword', {
    tenantId,
    email,
    password,
    returnSecureToken: true,
  });
  return session.idToken as string;
}

export async function markEmailVerified(tenantId: string, localId: string): Promise<void> {
  await ok(`/v1/projects/${projectId}/tenants/${tenantId}/accounts:update`, { localId, emailVerified: true }, true);
}

// Enrols a text-message second factor for a signed-in user (the only kind the emulator has) and
// returns the new ID token, which records that second factor. The code is read from the
// emulator's own list; nothing is sent.
export async function enrolTextMessageSecondFactor(tenantId: string, idToken: string, phoneNumber: string): Promise<string> {
  const started = await ok('/v2/accounts/mfaEnrollment:start', { idToken, tenantId, phoneEnrollmentInfo: { phoneNumber } });
  const sessionInfo = (started.phoneSessionInfo as { sessionInfo: string }).sessionInfo;
  const response = await fetch(`http://${env.authHost}/emulator/v1/projects/${projectId}/tenants/${tenantId}/verificationCodes`, {
    headers: ADMIN,
  });
  const { verificationCodes } = (await response.json()) as { verificationCodes: { sessionInfo: string; code: string }[] };
  const code = verificationCodes.find((entry) => entry.sessionInfo === sessionInfo)?.code;
  if (!code) throw new Error('Auth emulator listed no code for the enrolment');
  const finished = await ok('/v2/accounts/mfaEnrollment:finalize', {
    idToken,
    tenantId,
    phoneVerificationInfo: { sessionInfo, code },
  });
  return finished.idToken as string;
}

// The emulator's ID tokens are unsigned; the tests only read their claims.
export function tokenClaims(idToken: string): Record<string, unknown> {
  const payload = idToken.split('.')[1];
  if (!payload) throw new Error('Not a JWT');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}
