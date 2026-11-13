import { can, isRole } from '@/lib/access';
import { PROFILE_FIELDS } from './schema';
import type { ProfileView } from './service';

// What the Company settings screen decides in the browser, as pure functions so they are
// unit-tested. Everything here is convenience: the server checks the sign-in, the company and the
// role again on every call (src/lib/profile/http.ts), so a wrong answer here shows the wrong screen
// but never grants anything. Words come from fixed codes only; nothing the person typed goes into a
// message.

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

// Whether the sign-in page should offer "Company settings" for a role: the table the server reads.
export function offersCompanyScreen(role: string): boolean {
  return isRole(role) && can(role, 'profile_manage', { priceBooks: false });
}

// GET /api/me's answer as who is signed in: the company id the profile route names, and whether the
// role may manage the profile. null for an answer of an unexpected shape.
export type SignedInProfileManager = { companyId: string; canManageProfile: boolean };

export function signedInProfileManager(body: unknown): SignedInProfileManager | null {
  const companyId = field(field(body, 'company'), 'id');
  const capabilities = field(body, 'capabilities');
  if (typeof companyId !== 'string' || !Array.isArray(capabilities)) return null;
  return { companyId, canManageProfile: capabilities.includes('profile_manage') };
}

// GET or PUT /api/companies/{id}/profile's answer, or null when it is not the shape the server sends.
export function profileView(body: unknown): ProfileView | null {
  const companyId = field(body, 'companyId');
  const name = field(body, 'name');
  const revision = field(body, 'revision');
  const setupMissing = field(body, 'setupMissing');
  if (typeof companyId !== 'string' || typeof name !== 'string' || typeof revision !== 'string') return null;
  if (!Array.isArray(setupMissing) || !setupMissing.every((item) => typeof item === 'string')) return null;
  const values = PROFILE_FIELDS.map((key) => field(body, key));
  if (!values.every((value) => typeof value === 'string')) return null;
  const [address, phone, email, license, signoff] = values as string[];
  return { companyId, name, revision, address: address!, phone: phone!, email: email!, license: license!, signoff: signoff!, setupMissing };
}

// A 409 to a save: the profile the server holds now, which changed since the screen read it.
export function changedProfile(status: number, body: unknown): ProfileView | null {
  return status === 409 && field(body, 'error') === 'stale_revision' ? profileView(field(body, 'profile')) : null;
}

const MESSAGES: Record<string, string> = {
  not_allowed: 'Only the company owner can change the company settings.',
  invalid_request: 'Check each line and try again. Every line must fit on one row and stay within its length limit.',
  not_found: 'The company could not be found. Reload the page.',
  stale_revision: 'The company settings were changed somewhere else. This screen now shows what is saved; make your change again.',
};

export function profileMessage(_status: number, body: unknown): string {
  const code = field(body, 'error');
  return (typeof code === 'string' ? MESSAGES[code] : undefined) ?? 'We could not save the company settings. Check your connection and try again.';
}
