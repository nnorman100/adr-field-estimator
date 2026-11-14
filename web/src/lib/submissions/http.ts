import type { z } from 'zod';
import { IdentityRefusal, type Identity } from '@/lib/auth';
import { JobError } from '@/lib/jobs/access';
import { SubmissionError } from './errors';
import { nextDraftBody, submitBody } from './schema';
import { submissionsServices } from './services';

// The Submit and Back to editing routes (src/app/api/jobs/[jobId]/submissions and .../drafts). Each
// is wrapped in memberRoute there; these add the job and submission rules. The company comes only
// from the verified sign-in: no path or body names one.

type RouteContext = { params: Promise<Record<string, string | string[] | undefined>> };

const NO_STORE = { 'Cache-Control': 'no-store' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

async function respond(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof SubmissionError) return json({ error: error.code }, error.status);
    if (error instanceof JobError) return json({ error: error.code, ...error.extra }, error.status);
    if (error instanceof IdentityRefusal) return json({ error: error.code }, error.status);
    // Fixed text only: an error from the database or Firestore may quote a path or a name.
    console.error('submissions request unavailable', error instanceof Error ? error.name : 'unknown');
    return json({ error: 'submissions_unavailable' }, 503);
  }
}

// A path id: a uuid, or the job does not exist (as in src/lib/jobs/http.ts).
async function jobId(context: RouteContext): Promise<string> {
  const value = (await context.params).jobId;
  if (typeof value !== 'string' || !UUID.test(value)) throw new JobError('not_found');
  return value.toLowerCase();
}

async function body<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new SubmissionError('invalid_request');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new SubmissionError('invalid_request');
  return parsed.data;
}

// POST /api/jobs/{jobId}/submissions  { id, draftId, digest }
// 201 when this request recorded the submission, 200 for the same request again after it was
// recorded; the answer is the submission and the job's new state.
export async function submitJob(request: Request, identity: Identity, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const id = await jobId(context);
    const input = await body(request, submitBody);
    const { created, submission, job } = await submissionsServices().submit(identity, id, input);
    return json({ submission, job }, created ? 201 : 200);
  });
}

// POST /api/jobs/{jobId}/drafts  { draftId, fromDraftId }
// Back to editing: 201 when this request made the next draft version, 200 for the same request again.
export async function nextDraft(request: Request, identity: Identity, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const id = await jobId(context);
    const input = await body(request, nextDraftBody);
    const { created, job } = await submissionsServices().backToEditing(identity, id, input);
    return json({ job }, created ? 201 : 200);
  });
}
