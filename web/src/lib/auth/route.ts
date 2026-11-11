import { parseFlagName, type FlagName } from '@/lib/flags';
import { IdentityRefusal, resolveAccount, resolveIdentity, type Account, type Identity } from './identity';
import type { RouteSessionRule } from './policy';
import { identityServices, type IdentityServices } from './services';

// Every API route declares its access rule where it is defined, by wrapping each handler:
//
//   export const GET = publicRoute(async () => ...);                 // no sign-in
//   export const GET = memberRoute(async (request, identity) => ...); // a company member
//   export const GET = requireFlag('price_books', async (request, identity) => ...);
//                                         // a company member whose company has the flag on
//
// A member route also applies the second-step and session rules of policy.ts. Two kinds of route
// say more, beside their own code:
//
//   memberRoute(handler, { freshSignIn: true })      // changes the team or a second step: the
//                                                    // sign-in must be under 15 minutes old
//   memberRoute(handler, { secondStep: 'enrolment' }) // sets up a second step, so an owner who
//                                                    // has none yet may reach it
//
// One more rule is for a signed-in account of the company that need not be a member yet:
//
//   export const GET = accountRoute(async (request, account) => ...); // opening an invitation
//
// The handler gets the verified email and session claims and must apply the session rules for the
// role it is about to grant (sessionRefusal in policy.ts) before it grants anything.
//
// tests/unit/route-rules.test.ts finds every route file and fails on a handler that is not
// wrapped, so a route with no rule cannot ship. Later rules (operator, a capability) are added
// here as further wrappers.

type RouteContext = { params: Promise<Record<string, string | string[] | undefined>> };
type Handler = (request: Request, context: RouteContext) => Response | Promise<Response>;
type MemberHandler = (request: Request, identity: Identity, context: RouteContext) => Response | Promise<Response>;
type AccountHandler = (request: Request, account: Account, context: RouteContext) => Response | Promise<Response>;

const NO_STORE = { 'Cache-Control': 'no-store' };

function refusal(code: string, status: number): Response {
  return Response.json({ error: code }, { status, headers: NO_STORE });
}

function refusalOf(error: unknown): Response {
  if (error instanceof IdentityRefusal) return refusal(error.code, error.status);
  // Fixed text only: the error may quote the token or the connection string.
  console.error('identity check unavailable', error instanceof Error ? error.name : 'unknown');
  return refusal('identity_unavailable', 503);
}

// Open to anyone. Use only for routes that read no company data.
export function publicRoute<H extends Handler>(handler: H): H {
  return handler;
}

// Only a signed-in, active member of an active company. The identity comes from the verified
// token alone; the handler gets it and must take the company from it, never from the request.
export function memberRoute(
  handler: MemberHandler,
  rule: RouteSessionRule = {},
  services: () => IdentityServices = identityServices,
): Handler {
  const route = Object.freeze({ ...rule });
  return async (request, context) => {
    let identity: Identity;
    try {
      const { verifier, directory } = services();
      identity = await resolveIdentity(request, verifier, directory, { route });
    } catch (error) {
      return refusalOf(error);
    }
    return handler(request, identity, context);
  };
}

// A member route of a switched-off feature. When the caller's company does not have the flag on,
// the route answers 404 as if it did not exist, and the handler never runs. The flag comes from
// the company of the verified sign-in, never from the request. An unknown flag name fails when
// the route module loads, so a misspelt gate cannot ship as a route that is always off.
export function requireFlag(
  flag: FlagName,
  handler: MemberHandler,
  rule: RouteSessionRule = {},
  services: () => IdentityServices = identityServices,
): Handler {
  const name = parseFlagName(flag);
  return memberRoute((request, identity, context) => {
    if (identity.flags?.[name] !== true) return refusal('not_found', 404);
    return handler(request, identity, context);
  }, rule, services);
}

// A signed-in account with a verified email in an active company, member or not. Use only for
// routes that act on what is addressed to that email (an invitation); the handler applies the
// session rules for the role it grants.
export function accountRoute(handler: AccountHandler, services: () => IdentityServices = identityServices): Handler {
  return async (request, context) => {
    let account: Account;
    try {
      const { verifier, directory } = services();
      account = await resolveAccount(request, verifier, directory);
    } catch (error) {
      return refusalOf(error);
    }
    return handler(request, account, context);
  };
}
