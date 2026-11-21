// The job screens' calls to this app's own API (S5a-6): the jobs routes (S5a-3) and the photo
// routes (S5a-5). Every create and save carries ids the phone made (the job, its first draft, a
// change, a photo), so sending it again after a lost answer is the same request, not a second one:
// the screens keep those ids until the server has answered, and "Try again" reuses them.
//
// Answers are parsed before use; an answer of another shape counts as no answer. Messages come from
// the status and the server's fixed error code only.
import type { User } from 'firebase/auth';
import { z } from 'zod';
import { appCheckHeaders } from '@/lib/app-check-client';
import { callApi } from '@/lib/firebase-client';
import type { ClaimView, CustomerView, JobDetail, JobListItem, JobPage } from '@/lib/jobs/service';
import { itemListResponseSchema } from '@/lib/prices/item-list';
import { MAX_PHOTO_REFS } from './schema';
import type { SummaryProposal } from './summary';
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
// `code` is the server's fixed error code, when it gave one.
export type Answer<T> = { ok: true; value: T } | { ok: false; status: number; message: string; code?: string; stale?: true; denied?: true };
// A refusal of the photo route or the field database, put as the jobs API answers one.
export type Refusal = { status: number; message: string };

const MESSAGES: Record<string, string> = {
  not_found: 'This job is not in your list.',
  not_allowed: 'Your role cannot change this.',
  archived: 'This job was archived.',
  job_signed: 'This job is signed; the office corrects its details.',
  conflict: 'This was already sent with other details. Start again.',
  draft_locked: 'This job is no longer being edited.',
  photo_limit: `This job has the most photos it can hold (${MAX_PHOTO_REFS}).`,
  photo_conflict: 'A different photo was already sent with this id. Take it again.',
  unsupported_image: 'This picture type cannot be used. Take the photo with the camera.',
  too_large: 'This picture is too large.',
  invalid_request: 'Something here is not valid. Check it and save again.',
  // S5b-1: the field owner and assignment.
  field_owner_taken: 'Another person already owns this job’s field work.',
  not_field_owner: 'Only the person who owns this job’s field work can add to it.',
  already_assigned: 'This estimator is already assigned to this job.',
  not_assignable: 'Only an active estimator assigned to this job (or you, the owner) can be given it.',
  assignment_not_found: 'This estimator is no longer assigned. The list is read again.',
  assigned_field_owner: 'This estimator owns the job’s field work. The company owner moves the field work first.',
  draft_unavailable: 'Saved, but the field work could not be updated just now. Try again.',
  // S5b-2: archive, restore and copy.
  submission_in_progress: 'A Submit of this job is still finishing. Try again in a moment.',
  not_archived: 'This job is not archived any more.',
  not_signed: 'Only a signed job can be copied.',
  // S7-6: the AI draft of the summary of findings.
  call_reused: 'This AI draft request was already used. Ask again.',
  draft_not_editing: 'This job is no longer being edited.',
  draft_invalid: 'Some of this job’s scope does not read right. Check the rooms and save the scope first.',
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
  const code = (body as { error?: unknown } | null)?.error;
  return {
    ok: false,
    status,
    message: answerMessage(status, body),
    ...(typeof code === 'string' ? { code } : {}),
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

const person = z.object({ actorId: z.string(), displayName: z.string().nullable(), email: z.string() });
const coordinationView = z.object({
  jobId: z.string(),
  status: z.enum(['draft', 'submitted', 'signed', 'archived']),
  // The coordination revision (job_coordination.revision), not the job's.
  revision: z.number(),
  notes: z.string(),
  fieldOwner: person.nullable(),
  assignments: z.array(person.extend({ id: z.string(), assignedAt: z.string() })),
  estimators: z.array(person),
});
export type Person = z.infer<typeof person>;
export type CoordinationView = z.infer<typeof coordinationView>;

// Job coordination (S5b-1): the office notes, the estimators assigned and the field owner. Owner
// and office only; the server refuses an estimator.
export async function readCoordination(user: User, jobId: string): Promise<Answer<CoordinationView>> {
  const { status, body } = await callApi(user, `/api/jobs/${jobId}/coordination`);
  return answerOf(status, body, coordinationView);
}

export type NotesSave = { revision: number; changeId: string; notes: string };

export async function saveCoordination(user: User, jobId: string, input: NotesSave): Promise<Answer<CoordinationView>> {
  const { status, body } = await callApi(user, `/api/jobs/${jobId}/coordination`, { method: 'PUT', json: input });
  return answerOf(status, body, coordinationView);
}

// 201 for a new assignment, 200 for the same id again.
export async function assignEstimator(user: User, jobId: string, input: { id: string; estimatorActorId: string }): Promise<Answer<CoordinationView>> {
  const { status, body } = await callApi(user, `/api/jobs/${jobId}/assignments`, { method: 'POST', json: input });
  return answerOf(status, body, coordinationView, [200, 201]);
}

export async function unassignEstimator(user: User, jobId: string, assignmentId: string): Promise<Answer<CoordinationView>> {
  const { status, body } = await callApi(user, `/api/jobs/${jobId}/assignments/${assignmentId}`, { method: 'DELETE' });
  return answerOf(status, body, coordinationView);
}

// "First capture makes me field owner": 201 when the caller became it now, 200 when they already were.
export async function claimFieldOwner(user: User, jobId: string): Promise<Answer<JobDetail>> {
  const { status, body } = await callApi(user, `/api/jobs/${jobId}/field-owner`, { method: 'POST' });
  return answerOf(status, body, jobDetail, [200, 201]) as Answer<JobDetail>;
}

export type TransferSave = { revision: number; changeId: string; toActorId: string };

// Owner decision J5: the owner moves the field work to themself or an assigned estimator.
export async function transferFieldOwner(user: User, jobId: string, input: TransferSave): Promise<Answer<CoordinationView>> {
  const { status, body } = await callApi(user, `/api/jobs/${jobId}/field-owner/transfer`, { method: 'POST', json: input });
  return answerOf(status, body, coordinationView);
}

export type ArchiveSave = { revision: number; changeId: string };
const archivedJob = z.object({ job: jobView });
export type ArchivedJob = z.infer<typeof archivedJob>;

// S5b-2, the owner: files away an unsigned draft (a draft or a submitted job). The same change id
// again is the same answer, so a lost answer is sent again as it was.
export async function archiveJob(user: User, jobId: string, input: ArchiveSave): Promise<Answer<ArchivedJob>> {
  const { status, body } = await callApi(user, `/api/jobs/${jobId}/archive`, { method: 'POST', json: input });
  return answerOf(status, body, archivedJob);
}

// S5b-2, the owner: puts an archived job back as it was.
export async function restoreJob(user: User, jobId: string, input: ArchiveSave): Promise<Answer<ArchivedJob>> {
  const { status, body } = await callApi(user, `/api/jobs/${jobId}/restore`, { method: 'POST', json: input });
  return answerOf(status, body, archivedJob);
}

// S5b-2: a new draft job from a signed job, with the new job's and draft's ids made on the phone.
// 201 for the new job, 200 for the same ids again.
export async function copyJob(user: User, jobId: string, input: { id: string; draftId: string }): Promise<Answer<JobDetail>> {
  const { status, body } = await callApi(user, `/api/jobs/${jobId}/copy`, { method: 'POST', json: input });
  return answerOf(status, body, jobDetail, [200, 201]) as Answer<JobDetail>;
}

async function authorized(user: User, path: string, init: RequestInit = {}): Promise<Response | null> {
  try {
    const token = await user.getIdToken();
    const headers = { ...init.headers, Authorization: `Bearer ${token}`, ...(await appCheckHeaders()) };
    return await fetch(path, { ...init, headers, cache: 'no-store' });
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

// A photo's bytes as a local address for an <img>; the server's refusal (401, 403, 404, or 410 for
// an archived job); or null when they cannot be read now. The caller revokes the address when the
// photo leaves the screen.
export async function photoAddress(user: User, jobId: string, photoId: string): Promise<string | Refusal | null> {
  const response = await authorized(user, `/api/jobs/${jobId}/photos/${photoId}?kind=photo`);
  if (!response) return null;
  if (!response.ok) {
    const answer = answerOf(response.status, await response.json().catch(() => null), z.never());
    return !answer.ok && (answer.denied || answer.status === 410) ? { status: answer.status, message: answer.message } : null;
  }
  const bytes = await response.blob().catch(() => null);
  return bytes ? URL.createObjectURL(bytes) : null;
}

const scopeLists = z.object({
  version: z.number().nullable(),
  roomTypes: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      suggestedItems: z.array(
        z.object({
          itemId: z.string(),
          name: z.string(),
          unit: z.string(),
          typed: z.boolean(),
          categories: z.array(z.union([z.literal(1), z.literal(2), z.literal(3), z.literal('mold')])),
        }),
      ),
    }),
  ),
  items: z.array(z.object({ itemId: z.string(), name: z.string(), unit: z.string() })),
  prepTasks: z.array(z.string()),
});
export type ScopeLists = z.infer<typeof scopeLists>;

// What Check Scope picks from for this job (S5a-10): room types, the items a room may list, and the
// company's prep-task templates. Names only; the server prices.
export async function readScopeLists(user: User, jobId: string): Promise<Answer<ScopeLists>> {
  const { status, body } = await callApi(user, `/api/jobs/${jobId}/scope-lists`);
  return answerOf(status, body, scopeLists);
}

export async function readPublishedItemList(user: User, signal: AbortSignal) {
  const { status, body } = await callApi(user, '/api/prices/item-list', { signal });
  return answerOf(status, body, itemListResponseSchema);
}

// The 403 codes of the member routes' identity check (src/lib/auth/identity.ts, REFUSALS): the
// person, their account or their company no longer allows the work. Not a refusal of one job.
export const IDENTITY_REFUSALS: ReadonlySet<string> = new Set([
  'account_disabled', 'no_tenant', 'unknown_tenant', 'email_unverified', 'not_a_member', 'member_disabled', 'company_inactive',
]);

const summaryProposal = z.object({
  result: z.object({
    id: z.string(),
    callId: z.string(),
    jobId: z.string(),
    draftId: z.string(),
    proposal: z.object({
      summary: z.string(),
      suggestions: z.array(z.string()),
      unpriced_work: z.array(z.string()),
      testing_advice: z.array(z.string()),
    }),
  }),
});

export type SummaryDraftAnswer =
  | { ok: true; value: SummaryProposal }
  | { ok: false; status: number; message: string; code?: string; retryAfterSeconds?: number };

// Asks for an AI draft of the job's summary of findings (S7-6). The phone sends its own call id and
// sends the same id again only after no answer came, so a lost answer finds the same proposal and
// never pays for a second model call. 201 for a new proposal, 200 for the stored one. An AI refusal
// carries the server's fixed words, and an allowance refusal how long to wait (Retry-After).
// The proposal is only shown: nothing reaches the draft until the technician accepts it.
export async function draftSummaryWithAi(user: User, jobId: string, callId: string): Promise<SummaryDraftAnswer> {
  const { status, body } = await callApi(user, `/api/jobs/${jobId}/ai/summary-draft`, { method: 'POST', json: { callId } });
  const answer = answerOf(status, body, summaryProposal, [200, 201]);
  if (answer.ok) return { ok: true, value: answer.value.result };
  const said = body as { error?: unknown; message?: unknown; retryAfterSeconds?: unknown } | null;
  const fixed = typeof said?.error === 'string' && said.error.startsWith('ai_') && typeof said.message === 'string' ? said.message : null;
  const wait = typeof said?.retryAfterSeconds === 'number' && said.retryAfterSeconds > 0 ? said.retryAfterSeconds : undefined;
  return {
    ok: false,
    status: answer.status,
    message: fixed ?? answer.message,
    ...(answer.code ? { code: answer.code } : {}),
    ...(wait !== undefined ? { retryAfterSeconds: wait } : {}),
  };
}

export { SHOT_NAMES } from './schema';

export type { JobDetail, JobListItem, JobPage };
