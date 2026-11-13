import type { z } from 'zod';
import { IdentityRefusal, type Identity } from '@/lib/auth';
import { JobError, type JobCaller } from './access';
import { claimBody, createBody, customerBody, parseListQuery } from './schema';
import { jobsServices } from './services';

// The jobs routes (src/app/api/jobs/). Each route file wraps one of these in memberRoute; these add
// the job rules. The company comes only from the verified sign-in: no path, query or body names one.

type RouteContext = { params: Promise<Record<string, string | string[] | undefined>> };

const NO_STORE = { 'Cache-Control': 'no-store' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

// A path id: a uuid, or the job does not exist.
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
    throw new BadRequest();
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new BadRequest();
  return parsed.data;
}

// GET /api/jobs?scope=company|mine&limit=&cursor=
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
