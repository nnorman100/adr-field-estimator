import type { User } from 'firebase/auth';
import type { CompanyView } from '@/lib/platform/service';
import type { MemberView, TeamView } from '@/lib/team/service';

// The operator screens' calls to the platform operator routes (src/app/api/platform). The ID token
// goes only into the Authorization header of these same-origin calls; nothing here logs a token or
// an email. An answer is either the route's JSON or its fixed error code.

export type ApiResult<T> = { ok: true; status: number; body: T } | { ok: false; status: number; code: string };

type Call = { method?: 'GET' | 'POST'; body?: unknown };

export async function operatorCall<T>(user: Pick<User, 'getIdToken'>, path: string, call: Call = {}): Promise<ApiResult<T>> {
  let response: Response;
  try {
    const token = await user.getIdToken();
    response = await fetch(path, {
      method: call.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(call.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: call.body === undefined ? undefined : JSON.stringify(call.body),
      cache: 'no-store',
    });
  } catch {
    return { ok: false, status: 0, code: 'unavailable' };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // An answer with no JSON is judged on its status alone.
  }
  if (response.ok) return body === null ? { ok: false, status: response.status, code: 'unavailable' } : { ok: true, status: response.status, body: body as T };
  const code = body !== null && typeof body === 'object' ? (body as Record<string, unknown>).error : undefined;
  return { ok: false, status: response.status, code: typeof code === 'string' ? code : 'unavailable' };
}

// A path segment is one uuid; anything else never reaches the address.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function id(value: string): string {
  if (!UUID.test(value)) throw new Error('Not an id');
  return value.toLowerCase();
}

export const platformPaths = {
  companies: () => '/api/platform/companies',
  status: (companyId: string) => `/api/platform/companies/${id(companyId)}/status`,
  owner: (companyId: string) => `/api/platform/companies/${id(companyId)}/owner`,
  team: (companyId: string) => `/api/platform/companies/${id(companyId)}/team`,
  resetSecondStep: (companyId: string, membershipId: string) =>
    `/api/platform/companies/${id(companyId)}/members/${id(membershipId)}/reset-second-step`,
} as const;

export type CompaniesAnswer = { companies: CompanyView[] };
export type CompanyAnswer = { company: CompanyView };
export type OwnerAnswer = {
  invitation: { id: string; email: string; role: string; status: string; expiresAt: string };
  delivery: 'copy_link';
  // A path on this app, to be sent to the new owner (S3-10); the screen puts this app's address in front.
  link: string;
  replacedMembershipId: string | null;
};
export type ResetAnswer = { reset: true; email: 'sent' | 'not_sent'; tellByPhone: boolean };
export type SupportTeamAnswer = { company: CompanyView; team: TeamView };

// The operator's team view is always the full one; anything else is treated as unavailable.
export function fullTeam(team: TeamView): Extract<TeamView, { view: 'full' }> | null {
  return team.view === 'full' ? team : null;
}

export type { CompanyView, MemberView };
