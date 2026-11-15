import { IdentityRefusal, type Identity } from '@/lib/auth';
import { JobError } from '@/lib/jobs/access';
import { AgreementError } from './errors';
import { signBody } from './schema';
import { agreementsServices } from './services';

// The signing routes (src/app/api/jobs/[jobId]/agreements). Each is wrapped there in
// requireFlag('price_books', ...), as the estimate routes are, so a company without price books gets
// 404 before anything here runs; these add the job and signing rules. The company comes only from
// the verified sign-in: no path or body names one.

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
    if (error instanceof AgreementError) return json({ error: error.code, ...error.extra }, error.status);
    if (error instanceof JobError) return json({ error: error.code, ...error.extra }, error.status);
    if (error instanceof IdentityRefusal) return json({ error: error.code }, error.status);
    // Fixed text only: an error from the database may quote a value, such as the signer's name.
    console.error('agreements request unavailable', error instanceof Error ? error.name : 'unknown');
    return json({ error: 'agreements_unavailable' }, 503);
  }
}

// A path id: a uuid, or the job does not exist (as in src/lib/jobs/http.ts).
async function jobId(context: RouteContext): Promise<string> {
  const value = (await context.params).jobId;
  if (typeof value !== 'string' || !UUID.test(value)) throw new JobError('not_found');
  return value.toLowerCase();
}

// POST /api/jobs/{jobId}/agreements  { id, estimateId, proposalSha256, signatureId, signerName, documentsConfirmed: true }
// 201 when this request signed the job, 200 for the same request again after it was signed; the
// answer is the signed record, read back from the stored bytes, the job's new state, and, in the
// answer that signed only, the tokens of the document links made at signing.
export async function signJob(request: Request, identity: Identity, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const id = await jobId(context);
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      throw new AgreementError('invalid_request');
    }
    const parsed = signBody.safeParse(raw);
    if (!parsed.success) throw new AgreementError('invalid_request');
    const { created, job, agreement, documentLinks } = await agreementsServices().sign(identity, id, parsed.data);
    return json({ job, agreement, documentLinks }, created ? 201 : 200);
  });
}

// GET /api/jobs/{jobId}/agreements
// The job's signed record from its stored bytes, or `agreement: null` when it is not signed.
export async function readAgreement(_request: Request, identity: Identity, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const id = await jobId(context);
    return json(await agreementsServices().read(identity, id));
  });
}
