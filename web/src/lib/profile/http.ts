import type { Identity } from '@/lib/auth';
import { IdentityRefusal } from '@/lib/auth';
import { profileInput } from './schema';
import { ProfileError } from './service';
import { profileServices } from './services';

// The company profile routes (src/app/api/companies/[companyId]/profile/route.ts). The route file
// wraps each in memberRoute; these add the profile rules, in this order: the company in the path
// must be the caller's own (else it "does not exist"), the caller's role must hold profile_manage
// (the owner), and only then is the body read. A refused request reads and writes nothing.

type RouteContext = { params: Promise<Record<string, string | string[] | undefined>> };

const NO_STORE = { 'Cache-Control': 'no-store' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Five short lines of text; far more than any real profile.
const MAX_BODY_BYTES = 8_192;

class BadRequest extends Error {}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

async function respond(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ProfileError) return json({ error: error.code, ...error.extra }, error.status);
    if (error instanceof IdentityRefusal) return json({ error: error.code }, error.status);
    if (error instanceof BadRequest) return json({ error: 'invalid_request' }, 400);
    // Fixed text only: an error from the database may quote an address or an email.
    console.error('company profile unavailable', error instanceof Error ? error.name : 'unknown');
    return json({ error: 'profile_unavailable' }, 503);
  }
}

// The company comes from the verified sign-in; the one in the path must name it, or the caller is
// told it does not exist. The path never chooses a company.
async function ownCompany(context: RouteContext, identity: Identity): Promise<string> {
  const value = (await context.params).companyId;
  if (typeof value !== 'string' || !UUID.test(value) || value.toLowerCase() !== identity.companyId.toLowerCase()) {
    throw new ProfileError('not_found');
  }
  return identity.companyId;
}

function requireProfileManage(identity: Identity): void {
  if (!identity.capabilities.includes('profile_manage')) throw new ProfileError('not_allowed');
}

async function body(request: Request) {
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new BadRequest();
  }
  if (text.length > MAX_BODY_BYTES) throw new BadRequest();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BadRequest();
  }
  const parsed = profileInput.safeParse(raw);
  if (!parsed.success) throw new BadRequest();
  return parsed.data;
}

// GET /api/companies/{companyId}/profile
export async function readProfile(_request: Request, identity: Identity, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const companyId = await ownCompany(context, identity);
    requireProfileManage(identity);
    return json(await profileServices().read(companyId));
  });
}

// PUT /api/companies/{companyId}/profile  { revision, changeId, address, phone, email, license, signoff }:
// 409 stale_revision with the current profile when it changed since that revision.
export async function saveProfile(request: Request, identity: Identity, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const companyId = await ownCompany(context, identity);
    requireProfileManage(identity);
    const input = await body(request);
    return json(await profileServices().save(companyId, identity.actorId, input));
  });
}
