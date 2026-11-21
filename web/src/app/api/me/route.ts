import { memberRoute } from '@/lib/auth';
import { fieldAccessExpiry } from '@/lib/projection/expiry';
import { renewSignedInAccess } from '@/lib/projection/services';

export const dynamic = 'force-dynamic';

// The signed-in member: company, role and capabilities, all from the verified sign-in. No email,
// uid or token is returned. Opening the app renews the member's field database access record
// (web/src/lib/projection/renew.ts); a renewal that fails leaves the answer unchanged.
// `fieldAccessExpiresAt` is when that record stops working, read after the renewal (null when
// there is none or it cannot be read): the phone sends its queued field edits only while it is in
// the future (S6-3's sync gate), since a skipped renewal still answers 200. A renewal skipped
// because the actor was busy leaves its outbox row due, so the next call tries it again.
// `features` are the company switches the screens read (an allowlist, never the whole flag list):
// `readiness` turns on "Ready to review?" (S5b-11), `drying_watch` the drying watch and `estimate_assist` the job close (S5b-10). The
// server checks each again on its own routes.
export const GET = memberRoute(async (_request, identity) => {
  await renewSignedInAccess(identity);
  const expiresAt = await fieldAccessExpiry(identity);
  return Response.json(
    {
      company: { id: identity.companyId, name: identity.companyName },
      actor: { id: identity.actorId, displayName: identity.displayName },
      role: identity.role,
      capabilities: identity.capabilities,
      features: { readiness: identity.flags?.readiness === true, drying_watch: identity.flags?.drying_watch === true, estimate_assist: identity.flags?.estimate_assist === true },
      fieldAccessExpiresAt: expiresAt ? expiresAt.toISOString() : null,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
});
