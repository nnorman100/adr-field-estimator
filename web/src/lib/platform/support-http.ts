import { OperatorContextError } from '@/db/tenant';
import type { Operator } from '@/lib/auth';
import { JobError } from '@/lib/jobs/access';
import { parseListQuery } from '@/lib/jobs/schema';
import { PhotoError } from '@/lib/photos/errors';
import { kindOf } from '@/lib/photos/http';
import { PlatformError } from './service';
import { supportJobsServices } from './support-services';

// The operator's read-only support view of a company's jobs (S5b-5): the route files under
// src/app/api/platform/companies/[companyId]/jobs wrap these in operatorRoute, so only an active
// platform operator reaches them. The company and job come from the path; one that names no record
// of that company is not found. Each view writes one audit row; a refused one writes none.

type RouteContext = { params: Promise<Record<string, string | string[] | undefined>> };

const NO_STORE = { 'Cache-Control': 'no-store' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class BadRequest extends Error {}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

async function respond(request: Request, run: () => Promise<Response>): Promise<Response> {
  // The framework answers HEAD through GET; a view is read and audited only by the GET that sends it.
  if (request.method === 'HEAD') return Response.json({ error: 'method_not_allowed' }, { status: 405, headers: { ...NO_STORE, Allow: 'GET' } });
  try {
    return await run();
  } catch (error) {
    if (error instanceof PlatformError) return json({ error: error.code }, error.status);
    // A cursor that is not one the list gave out.
    if (error instanceof BadRequest || (error instanceof JobError && error.code === 'invalid_request') || (error instanceof PhotoError && error.code === 'invalid_request')) return json({ error: 'invalid_request' }, 400);
    // The operator was disabled after the sign-in check: refuse as on every other operator route.
    if (error instanceof OperatorContextError) return json({ error: 'not_an_operator' }, 403);
    // Fixed text only: an error from the database or the bucket may quote a name or a path.
    console.error('support view unavailable', error instanceof Error ? error.name : 'unknown');
    return json({ error: 'support_unavailable' }, 503);
  }
}

// A path id: a uuid, or the record does not exist.
async function pathId(context: RouteContext, name: string): Promise<string> {
  const value = (await context.params)[name];
  if (typeof value !== 'string' || !UUID.test(value)) throw new PlatformError('not_found');
  return value.toLowerCase();
}

// GET /api/platform/companies/{companyId}/jobs?limit=1..50&cursor=...  Every job, archived ones too.
export async function supportJobs(request: Request, operator: Operator, context: RouteContext): Promise<Response> {
  return respond(request, async () => {
    const companyId = await pathId(context, 'companyId');
    const query = parseListQuery(new URL(request.url).searchParams);
    // The operator sees the whole company: no scope.
    if (!query || query.scope !== null) throw new BadRequest();
    return json(await supportJobsServices().jobs(operator.operatorId, companyId, { limit: query.limit, cursor: query.cursor }));
  });
}

// GET /api/platform/companies/{companyId}/jobs/{jobId}
export async function supportJob(request: Request, operator: Operator, context: RouteContext): Promise<Response> {
  return respond(request, async () => {
    const companyId = await pathId(context, 'companyId');
    const jobId = await pathId(context, 'jobId');
    return json(await supportJobsServices().job(operator.operatorId, companyId, jobId));
  });
}

// GET /api/platform/companies/{companyId}/jobs/{jobId}/photos/{photoId}?kind=photo|original|signature
// (exactly one kind, as the job view lists it), as the image it is.
export async function supportPhoto(request: Request, operator: Operator, context: RouteContext): Promise<Response> {
  return respond(request, async () => {
    const companyId = await pathId(context, 'companyId');
    const jobId = await pathId(context, 'jobId');
    const photoId = await pathId(context, 'photoId');
    const kind = kindOf(request, null);
    const found = await supportJobsServices().photo(operator.operatorId, companyId, jobId, photoId, kind);
    return new Response(found.bytes as BodyInit, {
      headers: {
        ...NO_STORE,
        'Content-Type': found.contentType,
        'Content-Length': String(found.bytes.length),
        // The bytes are only ever shown as the image they are.
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    });
  });
}
