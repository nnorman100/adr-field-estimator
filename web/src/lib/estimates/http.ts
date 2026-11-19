import { IdentityRefusal, type Identity } from '@/lib/auth';
import { JobError } from '@/lib/jobs/access';
import { EstimateError } from './errors';
import { repriceBody } from './schema';
import { estimatesServices } from './services';

// The estimate routes (src/app/api/jobs/[jobId]/estimate). Each is wrapped there in
// requireFlag('price_books', ...), so a company without price books gets 404 before anything here
// runs; these add the job and estimate rules. The company comes only from the verified sign-in: no
// path or body names one; only Reprice reads a body.

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
    if (error instanceof EstimateError) return json({ error: error.code, ...error.extra }, error.status);
    if (error instanceof JobError) return json({ error: error.code, ...error.extra }, error.status);
    if (error instanceof IdentityRefusal) return json({ error: error.code }, error.status);
    // Fixed text only: an error from the database may quote a value.
    console.error('estimate request unavailable', error instanceof Error ? error.name : 'unknown');
    return json({ error: 'estimates_unavailable' }, 503);
  }
}

// A path id: a uuid, or the job does not exist (as in src/lib/jobs/http.ts).
async function jobId(context: RouteContext): Promise<string> {
  const value = (await context.params).jobId;
  if (typeof value !== 'string' || !UUID.test(value)) throw new JobError('not_found');
  return value.toLowerCase();
}

// POST /api/jobs/{jobId}/estimate
// Prices the job's submitted record from its pinned prices (pinning it at first price) and builds
// the four documents: 201 when this request made the estimate, 200 when it was already made for
// this record and pin (a retry, or a second phone).
export async function makeEstimate(_request: Request, identity: Identity, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const id = await jobId(context);
    const { created, job, estimate } = await estimatesServices().make(identity, id);
    return json({ job, estimate }, created ? 201 : 200);
  });
}

// GET /api/jobs/{jobId}/estimate
// The job's current estimate (for its current record and pin), or `estimate: null` when there is
// none: the job is being edited, or nobody has made it yet.
export async function readEstimate(_request: Request, identity: Identity, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const id = await jobId(context);
    return json(await estimatesServices().read(identity, id));
  });
}

// POST /api/jobs/{jobId}/reprice  { revision, changeId, versionId }
// The owner's Reprice this draft (S5b-6): moves the job's pin to the price version the owner
// reviewed, which must still be the company's newest, for the job revision they saw; the same
// changeId again is answered as the first time.
export async function repriceJob(request: Request, identity: Identity, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const id = await jobId(context);
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      throw new EstimateError('invalid_request');
    }
    const parsed = repriceBody.safeParse(raw);
    if (!parsed.success) throw new EstimateError('invalid_request');
    return json(await estimatesServices().reprice(identity, id, parsed.data));
  });
}
