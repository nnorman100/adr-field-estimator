import { z } from 'zod';
import type { Account, Identity } from '@/lib/auth';
import { IdentityRefusal } from '@/lib/auth';
import { TeamError, type TeamActor } from './service';
import { teamServices } from './services';
import { TenantUsersUnavailable } from './users';

// The team and invitation routes (src/app/api/companies/[companyId]/..., src/app/api/invitations/).
// Each route file wraps one of these in its access rule (memberRoute or accountRoute); these add the
// team rules: the company in the path must be the caller's own, the owner manages the team
// (team_manage), and an office user may only list the active estimators (assignment).

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
    if (error instanceof TeamError || error instanceof IdentityRefusal) return json({ error: error.code }, error.status);
    if (error instanceof BadRequest) return json({ error: 'invalid_request' }, 400);
    // Fixed text only: an error from the database or the SDK may quote an email.
    if (error instanceof TenantUsersUnavailable) {
      console.error('team change unavailable', error.name);
      return json({ error: 'identity_unavailable' }, 503);
    }
    console.error('team change unavailable', error instanceof Error ? error.name : 'unknown');
    return json({ error: 'team_unavailable' }, 503);
  }
}

// A path id: a uuid, or the record does not exist. Never read as anything else.
async function pathId(context: RouteContext, name: string): Promise<string> {
  const value = (await context.params)[name];
  if (typeof value !== 'string' || !UUID.test(value)) throw new TeamError('not_found');
  return value.toLowerCase();
}

// The company comes from the verified sign-in; the one in the path must name it, or the caller is
// told it does not exist. The path never chooses a company.
async function ownCompany(context: RouteContext, identity: Identity): Promise<string> {
  const companyId = await pathId(context, 'companyId');
  if (companyId !== identity.companyId.toLowerCase()) throw new TeamError('not_found');
  return identity.companyId;
}

function requireTeamManage(identity: Identity): TeamActor {
  if (!identity.capabilities.includes('team_manage')) throw new TeamError('not_allowed');
  return { kind: 'member', actorId: identity.actorId };
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

const staffRole = z.enum(['estimator', 'office']);
const inviteBody = z.strictObject({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(254)
    .pipe(z.email()),
  role: staffRole,
});
const roleBody = z.strictObject({ role: staffRole });

// GET /api/companies/{companyId}/team
export async function listTeam(_request: Request, identity: Identity, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const companyId = await ownCompany(context, identity);
    let view: 'full' | 'estimators';
    if (identity.capabilities.includes('team_manage')) view = 'full';
    else if (identity.capabilities.includes('assignment')) view = 'estimators';
    else throw new TeamError('not_allowed');
    return json(await teamServices().list(companyId, view, new Date()));
  });
}

// POST /api/companies/{companyId}/invitations  { email, role }
export async function inviteMember(request: Request, identity: Identity, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const companyId = await ownCompany(context, identity);
    const by = requireTeamManage(identity);
    const input = await body(request, inviteBody);
    return json(await teamServices().invite(companyId, by, input, new Date()), 201);
  });
}

type InvitationAction = 'resend' | 'cancel' | 'clear';

// POST /api/companies/{companyId}/invitations/{invitationId}/{resend|cancel|clear}
export function invitationAction(action: InvitationAction) {
  return async (_request: Request, identity: Identity, context: RouteContext): Promise<Response> =>
    respond(async () => {
      const companyId = await ownCompany(context, identity);
      const by = requireTeamManage(identity);
      const invitationId = await pathId(context, 'invitationId');
      const team = teamServices();
      const now = new Date();
      if (action === 'resend') return json(await team.resend(companyId, by, invitationId, now));
      if (action === 'cancel') return json(await team.cancel(companyId, by, invitationId, now));
      return json(await team.clear(companyId, by, invitationId, now));
    });
}

// PATCH /api/companies/{companyId}/members/{membershipId}  { role }
export async function changeMemberRole(request: Request, identity: Identity, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const companyId = await ownCompany(context, identity);
    const by = requireTeamManage(identity);
    const membershipId = await pathId(context, 'membershipId');
    const { role } = await body(request, roleBody);
    return json(await teamServices().changeRole(companyId, by, membershipId, role, new Date()));
  });
}

// POST /api/companies/{companyId}/members/{membershipId}/{disable|enable}
export function memberStatusAction(action: 'disable' | 'enable') {
  return async (_request: Request, identity: Identity, context: RouteContext): Promise<Response> =>
    respond(async () => {
      const companyId = await ownCompany(context, identity);
      const by = requireTeamManage(identity);
      const membershipId = await pathId(context, 'membershipId');
      const team = teamServices();
      const now = new Date();
      return json(
        action === 'disable'
          ? await team.disable(companyId, by, membershipId, now)
          : await team.enable(companyId, by, membershipId, now),
      );
    });
}

// GET /api/invitations/{invitationId}: the invitation addressed to the signed-in email.
export async function readInvitation(_request: Request, account: Account, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const invitationId = await pathId(context, 'invitationId');
    return json(await teamServices().readInvitation(account, invitationId, new Date()));
  });
}

// POST /api/invitations/{invitationId}/accept
export async function acceptInvitation(_request: Request, account: Account, context: RouteContext): Promise<Response> {
  return respond(async () => {
    const invitationId = await pathId(context, 'invitationId');
    const { accepted, ...membership } = await teamServices().accept(account, invitationId, new Date());
    return json({ membership, company: { id: account.companyId, name: account.companyName } }, accepted ? 201 : 200);
  });
}
