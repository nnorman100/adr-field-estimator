import { IdentityRefusal, type Identity } from '@/lib/auth';
import { JobError } from '@/lib/jobs/access';
import { scopeListsServices } from './services';
import { PricesUnreadable } from './version';

// GET /api/jobs/{jobId}/scope-lists (src/app/api/jobs/[jobId]/scope-lists), wrapped there in
// memberRoute. The company comes only from the verified sign-in; the request has no body or query.

type RouteContext = { params: Promise<Record<string, string | string[] | undefined>> };

const NO_STORE = { 'Cache-Control': 'no-store' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

// The room types, items and prep-task templates Check Scope picks from (src/lib/scope-lists/service.ts).
export async function readScopeLists(_request: Request, identity: Identity, context: RouteContext): Promise<Response> {
  try {
    const value = (await context.params).jobId;
    if (typeof value !== 'string' || !UUID.test(value)) throw new JobError('not_found');
    return json(await scopeListsServices().read(identity, value.toLowerCase()));
  } catch (error) {
    if (error instanceof JobError) return json({ error: error.code, ...error.extra }, error.status);
    if (error instanceof IdentityRefusal) return json({ error: error.code }, error.status);
    if (error instanceof PricesUnreadable) return json({ error: 'prices_unreadable' }, 503);
    // Fixed text only: an error from the database may quote a value.
    console.error('scope lists unavailable', error instanceof Error ? error.name : 'unknown');
    return json({ error: 'scope_lists_unavailable' }, 503);
  }
}
