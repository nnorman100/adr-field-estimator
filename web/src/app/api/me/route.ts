import { memberRoute } from '@/lib/auth';

export const dynamic = 'force-dynamic';

// The signed-in member: company, role and capabilities, all from the verified sign-in. No email,
// uid or token is returned.
export const GET = memberRoute((_request, identity) =>
  Response.json(
    {
      company: { id: identity.companyId, name: identity.companyName },
      actor: { id: identity.actorId, displayName: identity.displayName },
      role: identity.role,
      capabilities: identity.capabilities,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  ),
);
