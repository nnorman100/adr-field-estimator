import { memberRoute } from '@/lib/auth';
import { renewSignedInAccess } from '@/lib/projection/services';

export const dynamic = 'force-dynamic';

// The signed-in member: company, role and capabilities, all from the verified sign-in. No email,
// uid or token is returned. Opening the app renews the member's field database access record
// (web/src/lib/projection/renew.ts); a renewal that fails leaves the answer unchanged.
export const GET = memberRoute(async (_request, identity) => {
  await renewSignedInAccess(identity);
  return Response.json(
    {
      company: { id: identity.companyId, name: identity.companyName },
      actor: { id: identity.actorId, displayName: identity.displayName },
      role: identity.role,
      capabilities: identity.capabilities,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
});
