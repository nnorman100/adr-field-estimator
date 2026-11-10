import { IdentityRefusal, resolveIdentity, type Identity } from './identity';
import { identityServices, type IdentityServices } from './services';

// Every API route declares its access rule where it is defined, by wrapping each handler:
//
//   export const GET = publicRoute(async () => ...);                 // no sign-in
//   export const GET = memberRoute(async (request, identity) => ...); // a company member
//
// tests/unit/route-rules.test.ts finds every route file and fails on a handler that is not
// wrapped, so a route with no rule cannot ship. Later rules (operator, a capability, a feature
// flag) are added here as further wrappers.

type RouteContext = { params: Promise<Record<string, string | string[] | undefined>> };
type Handler = (request: Request, context: RouteContext) => Response | Promise<Response>;
type MemberHandler = (request: Request, identity: Identity, context: RouteContext) => Response | Promise<Response>;

const NO_STORE = { 'Cache-Control': 'no-store' };

function refusal(code: string, status: number): Response {
  return Response.json({ error: code }, { status, headers: NO_STORE });
}

// Open to anyone. Use only for routes that read no company data.
export function publicRoute<H extends Handler>(handler: H): H {
  return handler;
}

// Only a signed-in, active member of an active company. The identity comes from the verified
// token alone; the handler gets it and must take the company from it, never from the request.
export function memberRoute(
  handler: MemberHandler,
  services: () => IdentityServices = identityServices,
): Handler {
  return async (request, context) => {
    let identity: Identity;
    try {
      const { verifier, directory } = services();
      identity = await resolveIdentity(request, verifier, directory);
    } catch (error) {
      if (error instanceof IdentityRefusal) return refusal(error.code, error.status);
      // Fixed text only: the error may quote the token or the connection string.
      console.error('identity check unavailable', error instanceof Error ? error.name : 'unknown');
      return refusal('identity_unavailable', 503);
    }
    return handler(request, identity, context);
  };
}
