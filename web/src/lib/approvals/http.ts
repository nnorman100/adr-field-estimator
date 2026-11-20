import { IdentityRefusal, type Identity } from '@/lib/auth';
import { EstimateError } from '@/lib/estimates/errors';
import { JobError } from '@/lib/jobs/access';
import { ApprovalError } from './errors';
import { approveBody, proposalBody, proposalKind, SUPPORTED_KINDS, type ProposalInput } from './schema';
import { approvalsServices } from './services';

// The proposal and approval routes (src/app/api/jobs/[jobId]/approvals). Each is wrapped there in
// requireFlag('priced_extras', ...), so a company without priced extras gets 404 before anything here
// runs (owner decision D5); each also needs `price_books`, as every price route does, because a
// proposal reads and pins the company's published prices. The company comes only from the verified sign-in: no path or body names one.

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
    if (error instanceof ApprovalError) return json({ error: error.code }, error.status);
    if (error instanceof EstimateError) return json({ error: error.code, ...error.extra }, error.status);
    if (error instanceof JobError) return json({ error: error.code, ...error.extra }, error.status);
    if (error instanceof IdentityRefusal) return json({ error: error.code }, error.status);
    // Fixed text only: an error from the database may quote a value.
    console.error('approval request unavailable', error instanceof Error ? error.name : 'unknown');
    return json({ error: 'approvals_unavailable' }, 503);
  }
}

// The job id: a uuid, or the job does not exist (as in src/lib/jobs/http.ts).
async function jobPath(context: RouteContext): Promise<string> {
  const value = (await context.params).jobId;
  if (typeof value !== 'string' || !UUID.test(value)) throw new JobError('not_found');
  return value.toLowerCase();
}

// The proposal id: a uuid, or no proposal has it.
async function approvalPath(context: RouteContext): Promise<string> {
  const value = (await context.params).approvalId;
  if (typeof value !== 'string' || !UUID.test(value)) throw new ApprovalError('approval_not_found');
  return value.toLowerCase();
}

const priceBooksOff = (identity: Identity): Response | null => (identity.flags.price_books === true ? null : json({ error: 'not_found' }, 404));

async function bodyOf(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ApprovalError('invalid_request');
  }
}

// A kind the estimate cannot price yet is answered as such, whatever else the body carries.
function proposal(raw: unknown): ProposalInput {
  const kind = proposalKind.safeParse(raw);
  if (kind.success && !(SUPPORTED_KINDS as readonly string[]).includes(kind.data.kind)) throw new ApprovalError('not_yet_supported');
  const parsed = proposalBody.safeParse(raw);
  if (!parsed.success) throw new ApprovalError('invalid_request');
  return parsed.data;
}

// GET /api/jobs/{jobId}/approvals
// The submitted record's open proposals and approvals at the job's revision.
export async function listApprovals(_request: Request, identity: Identity, context: RouteContext): Promise<Response> {
  return priceBooksOff(identity) ?? respond(async () => json(await approvalsServices().list(identity, await jobPath(context))));
}

// POST /api/jobs/{jobId}/approvals  { id, revision, kind, ... }
// Proposes a named adjustment or an hourly addition: 201 when made, 200 when this id was already.
export async function proposeApproval(request: Request, identity: Identity, context: RouteContext): Promise<Response> {
  return priceBooksOff(identity) ?? respond(async () => {
    const id = await jobPath(context);
    const input = proposal(await bodyOf(request));
    const { created, approval } = await approvalsServices().propose(identity, id, input);
    return json({ approval }, created ? 201 : 200);
  });
}

// PUT /api/jobs/{jobId}/approvals/{approvalId}  { id, revision, kind, ... }
// Edits a proposal: ends it, approval and all, and proposes the new one (a new id).
export async function editApproval(request: Request, identity: Identity, context: RouteContext): Promise<Response> {
  return priceBooksOff(identity) ?? respond(async () => {
    const id = await jobPath(context);
    const approvalId = await approvalPath(context);
    const input = proposal(await bodyOf(request));
    const { created, approval } = await approvalsServices().edit(identity, id, approvalId, input);
    return json({ approval }, created ? 201 : 200);
  });
}

// POST /api/jobs/{jobId}/approvals/{approvalId}/approve  { revision, approverName? }
// The owner approves a proposal exactly as proposed.
export async function approveApproval(request: Request, identity: Identity, context: RouteContext): Promise<Response> {
  return priceBooksOff(identity) ?? respond(async () => {
    const id = await jobPath(context);
    const approvalId = await approvalPath(context);
    const parsed = approveBody.safeParse(await bodyOf(request));
    if (!parsed.success) throw new ApprovalError('invalid_request');
    return json(await approvalsServices().approve(identity, id, approvalId, parsed.data));
  });
}
