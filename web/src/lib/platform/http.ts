import { z } from 'zod';
import { OperatorContextError } from '@/db/tenant';
import { IdentityRefusal, type Operator } from '@/lib/auth';
import { TeamError, type TeamActor } from '@/lib/team/service';
import { teamServices } from '@/lib/team/services';
import { TenantUsersUnavailable } from '@/lib/team/users';
import { PlatformError } from './service';
import { platformServices } from './services';

// The platform operator routes (src/app/api/platform/...). Each route file wraps one of these in
// operatorRoute, so only an active platform operator reaches them. The company comes from the path:
// an operator is not bound to one company, and a company id that names no company is not found.

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
    if (error instanceof PlatformError || error instanceof TeamError || error instanceof IdentityRefusal) {
      return json({ error: error.code }, error.status);
    }
    if (error instanceof BadRequest) return json({ error: 'invalid_request' }, 400);
    // The operator was disabled after the sign-in check: refuse as on every other operator route.
    if (error instanceof OperatorContextError) return json({ error: 'not_an_operator' }, 403);
    // Fixed text only: an error from the database or the SDK may quote an email.
    if (error instanceof TenantUsersUnavailable) {
      console.error('platform action unavailable', error.name);
      return json({ error: 'identity_unavailable' }, 503);
    }
    console.error('platform action unavailable', error instanceof Error ? error.name : 'unknown');
    return json({ error: 'platform_unavailable' }, 503);
  }
}

// A path id: a uuid, or the record does not exist.
async function pathId(context: RouteContext, name: string): Promise<string> {
  const value = (await context.params)[name];
  if (typeof value !== 'string' || !UUID.test(value)) throw new PlatformError('not_found');
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

const supportActor = (operator: Operator): TeamActor => ({ kind: 'operator', operatorId: operator.operatorId });

const email = z.string().trim().toLowerCase().max(254).pipe(z.email());
const createBody = z.strictObject({
  name: z
    .string()
    .trim()
    .refine((value) => Array.from(value).length >= 1 && Array.from(value).length <= 200),
  // The company's sign-in address (owner decision D5), as migration 0002 checks it.
  signInSlug: z.string().regex(/^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/),
});
const statusBody = z.strictObject({ status: z.enum(['active', 'suspended', 'archived']) });
// An Identity Platform tenant id, as the owner-run command printed it.
const tenantBody = z.strictObject({ tenantId: z.string().regex(/^[A-Za-z0-9-]{1,128}$/) });
const ownerBody = z.strictObject({ email, replace: z.boolean().default(false) });
// D9: the operator states that the person's identity was confirmed by phone.
const resetBody = z.strictObject({ confirmedBy: z.literal('phone') });
const roleBody = z.strictObject({ role: z.enum(['estimator', 'office']) });

// GET /api/platform/companies
export async function listCompanies(_request: Request, operator: Operator): Promise<Response> {
  return respond(async () => json(await platformServices().listCompanies(operator.operatorId)));
}

// POST /api/platform/companies  { name, signInSlug }
export async function createCompany(request: Request, operator: Operator): Promise<Response> {
  return respond(async () => {
    const input = await body(request, createBody);
    return json(await platformServices().createCompany(operator.operatorId, input), 201);
  });
}

// POST /api/platform/companies/{companyId}/status  { status }
export async function setCompanyStatus(request: Request, operator: Operator, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const companyId = await pathId(context, 'companyId');
    const { status } = await body(request, statusBody);
    return json(await platformServices().setStatus(operator.operatorId, companyId, status, new Date()));
  });
}

// POST /api/platform/companies/{companyId}/tenant  { tenantId }
export async function bindCompanyTenant(request: Request, operator: Operator, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const companyId = await pathId(context, 'companyId');
    const { tenantId } = await body(request, tenantBody);
    return json(await platformServices().bindTenant(operator.operatorId, companyId, tenantId, new Date()));
  });
}

// POST /api/platform/companies/{companyId}/owner  { email, replace? }
export async function inviteOwner(request: Request, operator: Operator, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const companyId = await pathId(context, 'companyId');
    const input = await body(request, ownerBody);
    return json(await platformServices().inviteOwner(operator.operatorId, companyId, input, new Date()), 201);
  });
}

// POST /api/platform/companies/{companyId}/members/{membershipId}/reset-second-step  { confirmedBy }
export async function resetSecondStep(request: Request, operator: Operator, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const companyId = await pathId(context, 'companyId');
    const membershipId = await pathId(context, 'membershipId');
    await body(request, resetBody);
    return json(await platformServices().resetSecondStep(operator.operatorId, companyId, membershipId));
  });
}

// GET /api/platform/companies/{companyId}/team: read-only, one audit row per view.
export async function supportTeam(_request: Request, operator: Operator, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const companyId = await pathId(context, 'companyId');
    return json(await platformServices().supportTeam(operator.operatorId, companyId, new Date()));
  });
}

// PATCH /api/platform/companies/{companyId}/members/{membershipId}  { role }
export async function supportChangeRole(request: Request, operator: Operator, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const companyId = await pathId(context, 'companyId');
    const membershipId = await pathId(context, 'membershipId');
    const { role } = await body(request, roleBody);
    return json(await teamServices().changeRole(companyId, supportActor(operator), membershipId, role, new Date()));
  });
}

// POST /api/platform/companies/{companyId}/members/{membershipId}/enable
export async function supportEnableMember(_request: Request, operator: Operator, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const companyId = await pathId(context, 'companyId');
    const membershipId = await pathId(context, 'membershipId');
    return json(await teamServices().enable(companyId, supportActor(operator), membershipId, new Date()));
  });
}

// POST /api/platform/companies/{companyId}/invitations/{invitationId}/{resend|cancel}
export function supportInvitationAction(action: 'resend' | 'cancel') {
  return async (_request: Request, operator: Operator, context: RouteContext): Promise<Response> =>
    respond(async () => {
      const companyId = await pathId(context, 'companyId');
      const invitationId = await pathId(context, 'invitationId');
      const team = teamServices();
      const by = supportActor(operator);
      return json(
        action === 'resend'
          ? await team.resend(companyId, by, invitationId, new Date())
          : await team.cancel(companyId, by, invitationId, new Date()),
      );
    });
}
