// A small client for the Auth emulator's REST API, for the sign-in browser tests. The emulator
// runs beside the dev server (playwright.config.ts) under a demo- project only, so nothing here can
// reach a real project. Error text carries only the emulator's error code.
import { requireDemoProject } from '../../emu/guard';

export const E2E_PROJECT = requireDemoProject('demo-dryscope');
export const AUTH_EMULATOR_HOST = '127.0.0.1:9399';

const base = `http://${AUTH_EMULATOR_HOST}`;
const ADMIN = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };

async function admin(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}/identitytoolkit.googleapis.com${path}`, {
    method: 'POST',
    headers: ADMIN,
    body: JSON.stringify(body),
  });
  const reply = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const message = (reply.error as { message?: string } | undefined)?.message ?? '';
    throw new Error(`Auth emulator ${path} answered ${response.status}: ${message}`);
  }
  return reply;
}

export async function createTenant(displayName: string): Promise<string> {
  const tenant = await admin(`/v2/projects/${E2E_PROJECT}/tenants`, { displayName, allowPasswordSignup: true });
  return tenant.tenantId as string;
}

// An account made by an administrator, as an invitation makes one (no password, unverified) or as
// a member who already set a password.
export async function createUser(
  tenantId: string,
  user: { email: string; password?: string; emailVerified?: boolean },
): Promise<string> {
  const created = await admin(`/v1/projects/${E2E_PROJECT}/tenants/${tenantId}/accounts`, {
    email: user.email,
    ...(user.password ? { password: user.password } : {}),
    emailVerified: user.emailVerified ?? false,
  });
  return created.localId as string;
}

type OobCode = { email: string; requestType: string; oobLink: string };

// The newest emailed link of one kind for one address. The emulator sends nothing; it lists them.
export async function emailedLink(tenantId: string, email: string, requestType: 'PASSWORD_RESET' | 'VERIFY_EMAIL'): Promise<string> {
  const response = await fetch(`${base}/emulator/v1/projects/${E2E_PROJECT}/tenants/${tenantId}/oobCodes`, {
    headers: ADMIN,
  });
  const { oobCodes } = (await response.json()) as { oobCodes: OobCode[] };
  const found = oobCodes.filter((code) => code.email === email && code.requestType === requestType).at(-1);
  if (!found) throw new Error(`Auth emulator listed no ${requestType} link`);
  return found.oobLink;
}

export async function getUser(tenantId: string, localId: string): Promise<{ emailVerified?: boolean }> {
  const reply = await admin(`/v1/projects/${E2E_PROJECT}/tenants/${tenantId}/accounts:lookup`, { localId: [localId] });
  return ((reply.users as { emailVerified?: boolean }[] | undefined) ?? [])[0] ?? {};
}
