import { IdentityRefusal, type Identity } from '@/lib/auth';
import { JobError } from '@/lib/jobs/access';
import { readinessQuery } from './schema';
import { readinessServices } from './services';

// GET /api/jobs/{jobId}/readiness (src/app/api/jobs/[jobId]/readiness), wrapped there in
// requireFlag('readiness'), so a company without the switch gets 404 before this runs. The company
// comes only from the verified sign-in; the path names the job and nothing else is accepted.

type RouteContext = { params: Promise<Record<string, string | string[] | undefined>> };

const NO_STORE = { 'Cache-Control': 'no-store' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

// The gaps of the job's current editing draft, or why there are none to give (src/lib/readiness/service.ts).
export async function readReadiness(request: Request, identity: Identity, context: RouteContext): Promise<Response> {
  try {
    const value = (await context.params).jobId;
    if (typeof value !== 'string' || !UUID.test(value)) throw new JobError('not_found');
    if (!readinessQuery.safeParse(Object.fromEntries(new URL(request.url).searchParams)).success) return json({ error: 'invalid_request' }, 400);
    return json(await readinessServices().read(identity, value.toLowerCase()));
  } catch (error) {
    if (error instanceof JobError) return json({ error: error.code, ...error.extra }, error.status);
    if (error instanceof IdentityRefusal) return json({ error: error.code }, error.status);
    // Fixed text only: an error from the database may quote a value.
    console.error('readiness unavailable', error instanceof Error ? error.name : 'unknown');
    return json({ error: 'readiness_unavailable' }, 503);
  }
}
