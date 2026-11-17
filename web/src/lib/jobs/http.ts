import type { z } from 'zod';
import { IdentityRefusal, type Identity } from '@/lib/auth';
import { JobError, type JobCaller } from './access';
import { archiveBody, assignBody, claimBody, coordinationBody, copyBody, createBody, customerBody, parseListQuery, transferBody } from './schema';
import { jobsServices } from './services';

// The jobs routes (src/app/api/jobs/). Each route file wraps one of these in memberRoute; these add
// the job rules. The company comes only from the verified sign-in: no path, query or body names one.

type RouteContext = { params: Promise<Record<string, string | string[] | undefined>> };

const NO_STORE = { 'Cache-Control': 'no-store' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The largest valid jobs body is the 4,000-character office note, about 24,100 characters even with
// every character written as a \u escape. A body over this is refused before it is parsed (security
// audit F2). Counted in UTF-16 code units, never more than the UTF-8 bytes of the same text.
const MAX_BODY_LENGTH = 32_768;

class BadRequest extends Error {}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

async function respond(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof JobError) return json({ error: error.code, ...error.extra }, error.status);
    if (error instanceof IdentityRefusal) return json({ error: error.code }, error.status);
    if (error instanceof BadRequest) return json({ error: 'invalid_request' }, 400);
    // Fixed text only: an error from the database may quote a name or an address.
    console.error('jobs request unavailable', error instanceof Error ? error.name : 'unknown');
    return json({ error: 'jobs_unavailable' }, 503);
  }
}

const callerOf = (identity: Identity): JobCaller => identity;

// A path id: a uuid, or the job (or the assignment) does not exist.
async function pathId(context: RouteContext, name: 'jobId' | 'assignmentId'): Promise<string> {
  const value = (await context.params)[name];
  if (typeof value !== 'string' || !UUID.test(value)) throw new JobError(name === 'jobId' ? 'not_found' : 'assignment_not_found');
  return value.toLowerCase();
}

const jobId = (context: RouteContext) => pathId(context, 'jobId');

async function body<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_LENGTH) throw new BadRequest();
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new BadRequest();
  }
  if (text.length > MAX_BODY_LENGTH) throw new BadRequest();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BadRequest();
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new BadRequest();
  return parsed.data;
}

// GET /api/jobs?scope=company|mine|archived&limit=&cursor=
export async function listJobs(request: Request, identity: Identity): Promise<Response> {
  return respond(async () => {
    const query = parseListQuery(new URL(request.url).searchParams);
    if (!query) throw new BadRequest();
    return json(await jobsServices().list(callerOf(identity), query));
  });
}

// POST /api/jobs  { id, draftId, propertyAddress? }: 201 for a new job, 200 for the same request again.
export async function createJob(request: Request, identity: Identity): Promise<Response> {
  return respond(async () => {
    const input = await body(request, createBody);
    const { created, detail } = await jobsServices().create(callerOf(identity), input);
    return json(detail, created ? 201 : 200);
  });
}

// GET /api/jobs/{jobId}
export async function readJob(_request: Request, identity: Identity, context: RouteContext): Promise<Response> {
  return respond(async () => json(await jobsServices().read(callerOf(identity), await jobId(context))));
}

// PUT /api/jobs/{jobId}/customer  { revision, changeId, name, phone, email, propertyAddress }
export async function saveCustomer(request: Request, identity: Identity, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const id = await jobId(context);
    const input = await body(request, customerBody);
    return json(await jobsServices().saveCustomer(callerOf(identity), id, input));
  });
}

// PUT /api/jobs/{jobId}/claim  { revision, changeId, carrier, claimNumber, ... }
export async function saveClaim(request: Request, identity: Identity, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const id = await jobId(context);
    const input = await body(request, claimBody);
    return json(await jobsServices().saveClaim(callerOf(identity), id, input));
  });
}

// GET /api/jobs/{jobId}/coordination: office notes, the assigned estimators and the field owner
// (owner and office; an estimator is refused, as the customer view is all they see).
export async function readCoordination(_request: Request, identity: Identity, context: RouteContext): Promise<Response> {
  return respond(async () => json(await jobsServices().coordination(callerOf(identity), await jobId(context))));
}

// PUT /api/jobs/{jobId}/coordination  { revision, changeId, notes }
export async function saveCoordination(request: Request, identity: Identity, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const id = await jobId(context);
    const input = await body(request, coordinationBody);
    return json(await jobsServices().saveCoordination(callerOf(identity), id, input));
  });
}

// POST /api/jobs/{jobId}/assignments  { id, estimatorActorId }: 201 for a new assignment, 200 for
// the same request again.
export async function assignEstimator(request: Request, identity: Identity, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const id = await jobId(context);
    const input = await body(request, assignBody);
    const { created, view } = await jobsServices().assign(callerOf(identity), id, input);
    return json(view, created ? 201 : 200);
  });
}

// DELETE /api/jobs/{jobId}/assignments/{assignmentId}: ends the assignment (sent again, the same answer).
export async function unassignEstimator(_request: Request, identity: Identity, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const id = await jobId(context);
    const assignment = await pathId(context, 'assignmentId');
    return json(await jobsServices().unassign(callerOf(identity), id, assignment));
  });
}

// POST /api/jobs/{jobId}/field-owner: "first capture makes me field owner"; no body. 201 when the
// caller became the field owner now, 200 when they already were.
export async function claimFieldOwner(_request: Request, identity: Identity, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const { claimed, detail } = await jobsServices().claimFieldOwner(callerOf(identity), await jobId(context));
    return json(detail, claimed ? 201 : 200);
  });
}

// POST /api/jobs/{jobId}/field-owner/transfer  { revision, changeId, toActorId } (owner decision J5).
export async function transferFieldOwner(request: Request, identity: Identity, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const id = await jobId(context);
    const input = await body(request, transferBody);
    return json(await jobsServices().transferFieldOwner(callerOf(identity), id, input));
  });
}

// POST /api/jobs/{jobId}/archive  { revision, changeId } (S5b-2, the owner): an unsigned draft leaves
// every list and answers 410 on every other job route.
export async function archiveJob(request: Request, identity: Identity, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const id = await jobId(context);
    const input = await body(request, archiveBody);
    return json(await jobsServices().archive(callerOf(identity), id, input));
  });
}

// POST /api/jobs/{jobId}/restore  { revision, changeId } (S5b-2, the owner): an archived job back as
// it was.
export async function restoreJob(request: Request, identity: Identity, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const id = await jobId(context);
    const input = await body(request, archiveBody);
    return json(await jobsServices().restore(callerOf(identity), id, input));
  });
}

// POST /api/jobs/{jobId}/copy  { id, draftId } (S5b-2): a new draft job from a signed job's scope.
// 201 for the new job, 200 for the same request again.
export async function copyJob(request: Request, identity: Identity, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const id = await jobId(context);
    const input = await body(request, copyBody);
    const { created, detail } = await jobsServices().copy(callerOf(identity), id, input);
    return json(detail, created ? 201 : 200);
  });
}
