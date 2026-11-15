import { and, desc, eq, sql } from 'drizzle-orm';
import { actors, companies, companyFeatureFlags, memberships } from '@/db/schema';
import type { CompanyTransaction } from '@/db/tenant';
import { capabilitiesFor, type Capability } from '@/lib/access';
import { accessFlags, flagsFromRows } from '@/lib/flags';
import type { JobCaller } from '@/lib/jobs/access';

// A link acts as the technician who made it (docs/ACCESS.md, "Homeowner signing link"), as they are
// now: on every use their membership, role and the company's switches are read again, inside the
// link's company, so a technician who was disabled, lost `sign` or lost the job, a company that is
// not active, or a company whose prices were switched off, makes the link unavailable. The job
// itself then goes through the one job-access function with that caller. A signing link needs its
// maker to hold `sign`; a document link, `sign` or `delivery_resend` (the owner or office may make one
// again after revoking it).
export async function technicianCaller(tx: CompanyTransaction, companyId: string, actorId: string, needs: readonly Capability[] = ['sign']): Promise<JobCaller | null> {
  const [company] = await tx.select({ status: companies.status }).from(companies).where(eq(companies.id, companyId));
  if (company?.status !== 'active') return null;
  const [actor] = await tx
    .select({ id: actors.id, uid: actors.uid })
    .from(actors)
    .where(and(eq(actors.companyId, companyId), eq(actors.id, actorId)));
  if (!actor) return null;
  const [membership] = await tx
    .select({ role: memberships.role, status: memberships.status })
    .from(memberships)
    .where(and(eq(memberships.companyId, companyId), eq(memberships.actorId, actorId)))
    .orderBy(sql`${memberships.status} = 'active' DESC`, desc(memberships.updatedAt))
    .limit(1);
  if (membership?.status !== 'active') return null;
  const flags = flagsFromRows(
    await tx.select({ flag: companyFeatureFlags.flag, enabled: companyFeatureFlags.enabled }).from(companyFeatureFlags).where(eq(companyFeatureFlags.companyId, companyId)),
  );
  // The link routes are part of the estimate and signing work, which needs the company's prices on.
  if (flags.price_books !== true) return null;
  const capabilities = capabilitiesFor(membership.role, accessFlags(flags));
  if (!needs.some((need) => capabilities.includes(need))) return null;
  return { companyId, actorId: actor.id, uid: actor.uid, role: membership.role, capabilities };
}
