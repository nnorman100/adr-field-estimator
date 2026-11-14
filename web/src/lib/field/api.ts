// The job screens' calls to this app's own API (S5a-6): the jobs routes (S5a-3) and the photo
// routes (S5a-5). Every create and save carries ids the phone made (the job, its first draft, a
// change, a photo), so sending it again after a lost answer is the same request, not a second one:
// the screens keep those ids until the server has answered, and "Try again" reuses them.
//
// Answers are parsed before use; an answer of another shape counts as no answer. Messages come from
// the status and the server's fixed error code only.
import type { User } from 'firebase/auth';
import { z } from 'zod';
import { callApi } from '@/lib/firebase-client';
import type { ClaimView, CustomerView, JobDetail, JobListItem, JobPage } from '@/lib/jobs/service';
import type { JobsList } from './views';

const jobView = z.object({
  id: z.string(),
  status: z.enum(['draft', 'submitted', 'signed', 'archived']),
  currentDraftId: z.string(),
  fieldOwnerActorId: z.string().nullable(),
  propertyAddress: z.string(),
  revision: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const customerView = z.object({ name: z.string(), phone: z.string(), email: z.string() });
const claimView = z.object({
  carrier: z.string(),
  claimNumber: z.string(),
  policyNumber: z.string(),
  dateOfLoss: z.string().nullable(),
  lossCause: z.string(),
  adjusterName: z.string(),
  adjusterEmail: z.string(),
  adjusterPhone: z.string(),
  deductible: z.string(),
});
const jobDetail = z.object({ job: jobView, customer: customerView, claim: claimView });
const listItem = jobView
  .pick({ id: true, status: true, propertyAddress: true, revision: true, createdAt: true, updatedAt: true })
  .extend({ customerName: z.string(), mine: z.boolean() });
const jobPage = z.object({ jobs: z.array(listItem), nextCursor: z.string().nullable() });
const receipt = z.object({ photoId: z.string(), sha256: z.string() });

// `status` 0 means no answer, or a success answer that did not arrive whole: the request may have been
// made, so it is kept and sent again as it was. `stale` marks a save that met a newer revision (409
// stale_revision): the screen reads the job again. `denied` marks a refusal to show or change the job
// to this person at all (401, 403, 404): the screen drops any copy of it it holds.
export type Answer<T> = { ok: true; value: T } | { ok: false; status: number; message: string; stale?: true; denied?: true };
// A refusal of the photo route or the field database, put as the jobs API answers one.
export type Refusal = { status: number; message: string };

const MESSAGES: Record<string, string> = {
  not_found: 'This job is not in your list.',
  not_allowed: 'Your role cannot change this.',
  archived: 'This job was archived.',
  job_signed: 'This job is signed; the office corrects its details.',
  conflict: 'This was already sent with other details. Start again.',
  draft_locked: 'This job is no longer being edited.',
  photo_conflict: 'A different photo was already sent with this id. Take it again.',
  unsupported_image: 'This picture type cannot be used. Take the photo with the camera.',
  too_large: 'This picture is too large.',
  invalid_request: 'Something here is not valid. Check it and save again.',
};

export function answerMessage(status: number, body: unknown): string {
  if (status === 0) return 'No answer from the server. Check the signal and try again; nothing is lost.';
  const code = (body as { error?: unknown } | null)?.error;
  if (status === 409 && code === 'stale_revision') return 'Someone else changed this job. Their changes are now shown with yours; check and save again.';
  if (typeof code === 'string' && Object.hasOwn(MESSAGES, code)) return MESSAGES[code]!;
  if (status === 401 || status === 403) return 'Sign in again to continue.';
  return 'The server could not do this just now. Try again.';
}

function answerOf<T>(status: number, body: unknown, schema: z.ZodType<T>, okStatuses: number[] = [200]): Answer<T> {
  if (okStatuses.includes(status)) {
    const parsed = schema.safeParse(body);
    if (parsed.success) return { ok: true, value: parsed.data };
    // The server said yes but its answer did not arrive whole: the write may well be made, so this is
    // no answer, and the screen keeps the request to send again with the same ids.
    return { ok: false, status: 0, message: answerMessage(0, null) };
  }
  const stale = status === 409 && (body as { error?: unknown } | null)?.error === 'stale_revision';
  const denied = status === 401 || status === 403 || status === 404;
  return {
    ok: false,
    status,
    message: answerMessage(status, body),
    ...(stale ? { stale: true as const } : {}),
    ...(denied ? { denied: true as const } : {}),
  };
}

export async function listJobs(user: User, list: JobsList, cursor: string | null): Promise<Answer<JobPage>> {
  const query = new URLSearchParams({ scope: list, ...(cursor ? { cursor } : {}) });
  const { status, body } = await callApi(user, `/api/jobs?${query}`);
  return answerOf(status, body, jobPage) as Answer<JobPage>;
}

export type NewJob = { id: string; draftId: string; propertyAddress: string };

// 201 for the new job, 200 for the same request sent again.
export async function createJob(user: User, job: NewJob): Promise<Answer<JobDetail>> {
  const { status, body } = await callApi(user, '/api/jobs', { method: 'POST', json: job });
  return answerOf(status, body, jobDetail, [200, 201]) as Answer<JobDetail>;
}

export async function readJob(user: User, jobId: string): Promise<Answer<JobDetail>> {
  const { status, body } = await callApi(user, `/api/jobs/${jobId}`);
  return answerOf(status, body, jobDetail) as Answer<JobDetail>;
}

export type CustomerSave = CustomerView & { propertyAddress: string; revision: number; changeId: string };
export type ClaimSave = ClaimView & { revision: number; changeId: string };

export async function saveCustomer(user: User, jobId: string, input: CustomerSave): Promise<Answer<JobDetail>> {
  const { status, body } = await callApi(user, `/api/jobs/${jobId}/customer`, { method: 'PUT', json: input });
  return answerOf(status, body, jobDetail) as Answer<JobDetail>;
}

export async function saveClaim(user: User, jobId: string, input: ClaimSave): Promise<Answer<JobDetail>> {
  const { status, body } = await callApi(user, `/api/jobs/${jobId}/claim`, { method: 'PUT', json: input });
  return answerOf(status, body, jobDetail) as Answer<JobDetail>;
}

async function authorized(user: User, path: string, init: RequestInit = {}): Promise<Response | null> {
  try {
    const token = await user.getIdToken();
    return await fetch(path, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` }, cache: 'no-store' });
  } catch {
    return null;
  }
}

// Sends a photo's bytes (the screen keeps the same bytes and id for a resend). 201 for a new photo,
// 200 for the same bytes again.
export async function sendPhoto(user: User, jobId: string, photoId: string, bytes: Blob): Promise<Answer<{ photoId: string }>> {
  // The bytes themselves rather than the Blob: the same body on every send, whatever the browser
  // does with a Blob it streams.
  const response = await authorized(user, `/api/jobs/${jobId}/photos/${photoId}?kind=photo`, {
    method: 'PUT',
    headers: { 'Content-Type': bytes.type || 'application/octet-stream' },
    body: new Uint8Array(await bytes.arrayBuffer()),
  });
  if (!response) return { ok: false, status: 0, message: answerMessage(0, null) };
  const body = await response.json().catch(() => null);
  return answerOf(response.status, body, receipt, [200, 201]);
}

// A photo's bytes as a local address for an <img>; the server's refusal (401, 403, 404); or null
// when they cannot be read now. The caller revokes the address when the photo leaves the screen.
export async function photoAddress(user: User, jobId: string, photoId: string): Promise<string | Refusal | null> {
  const response = await authorized(user, `/api/jobs/${jobId}/photos/${photoId}?kind=photo`);
  if (!response) return null;
  if (!response.ok) {
    const answer = answerOf(response.status, await response.json().catch(() => null), z.never());
    return !answer.ok && answer.denied ? { status: answer.status, message: answer.message } : null;
  }
  const bytes = await response.blob().catch(() => null);
  return bytes ? URL.createObjectURL(bytes) : null;
}

export { SHOT_NAMES } from './schema';

export type { JobDetail, JobListItem, JobPage };
