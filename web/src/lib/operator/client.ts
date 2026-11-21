import { apiFetch } from '@/lib/api-fetch';
import type { User } from 'firebase/auth';
import { appCheckHeaders } from '@/lib/app-check-client';
import type { CompanyView } from '@/lib/platform/service';
import type { SupportJobListItem, SupportJobView } from '@/lib/platform/support-jobs';
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
    response = await apiFetch(path, {
      method: call.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(await appCheckHeaders()),
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
  return { ok: false, status: response.status, code: refusalCode(body) };
}

function refusalCode(body: unknown): string {
  const code = body !== null && typeof body === 'object' ? (body as Record<string, unknown>).error : undefined;
  return typeof code === 'string' ? code : 'unavailable';
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
  // The read-only support view of a company's jobs (S5b-5); the cursor is the one the list gave.
  supportJobs: (companyId: string, cursor: string | null = null) =>
    `/api/platform/companies/${id(companyId)}/jobs${cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`}`,
  supportJob: (companyId: string, jobId: string) => `/api/platform/companies/${id(companyId)}/jobs/${id(jobId)}`,
  supportPhoto: (companyId: string, jobId: string, photoId: string, kind: 'photo' | 'original' | 'signature') =>
    `/api/platform/companies/${id(companyId)}/jobs/${id(jobId)}/photos/${id(photoId)}?kind=${kind}`,
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
export type SupportJobsAnswer = { company: CompanyView; jobs: SupportJobListItem[]; nextCursor: string | null };
export type SupportJobAnswer = SupportJobView;

// One image of a job through the operator's photo route: a local blob address for an <img>, or the
// route's refusal, so the session can act on it as on any other operator answer. Each read is audited
// on the server, so it is made only when asked.
export async function operatorImage(user: Pick<User, 'getIdToken'>, path: string): Promise<ApiResult<string>> {
  try {
    const token = await user.getIdToken();
    const response = await fetch(path, { headers: { Authorization: `Bearer ${token}`, ...(await appCheckHeaders()) }, cache: 'no-store' });
    if (!response.ok) {
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        // A refusal with no JSON is judged on its status alone.
      }
      return { ok: false, status: response.status, code: refusalCode(body) };
    }
    return { ok: true, status: response.status, body: URL.createObjectURL(await response.blob()) };
  } catch {
    return { ok: false, status: 0, code: 'unavailable' };
  }
}

// The operator's team view is always the full one; anything else is treated as unavailable.
export function fullTeam(team: TeamView): Extract<TeamView, { view: 'full' }> | null {
  return team.view === 'full' ? team : null;
}

export type { CompanyView, MemberView };
