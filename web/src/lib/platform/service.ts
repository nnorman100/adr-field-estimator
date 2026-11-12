import { and, eq, sql } from 'drizzle-orm';
import { actors, auditEvents, invitations, memberships } from '@/db/schema';
import { withOperator, type CompanyTransaction, type Database } from '@/db/tenant';
import { changeCompanyFlag, type FlagChangeResult } from '@/lib/flags';
import { postgresFlagStore } from '@/lib/flags/store';
import { readCompanyPrices, readVersionList, type PricesView, type VersionMeta } from '@/lib/prices/service';
import { enqueueAccessProjection } from '@/lib/projection/outbox';
import {
  INVITATION_DAYS,
  invitationLink,
  invitationView,
  readTeam,
  type InvitationView,
  type ProjectAccess,
  type TeamView,
} from '@/lib/team/service';
import type { PlatformUsers } from './users';

// The platform operator's actions (S3-9). Every one runs in withOperator (migration 0006), with the
// operator id taken from the verified operator sign-in, and writes exactly one audit row naming the
// operator in the same transaction; a refused action writes nothing. Actions on one company also
// set that company, so its own rows are reached under the 0003 policies. A change that affects
// members' access queues their Firestore access records (S3-12) and projects them after it commits.
//
// Owner decisions: a tenant is created by an owner- or operator-run command, never by the app (D4);
// operators are added only by the owner-run command, never here (D6); a second step is reset after
// the operator confirms the person by phone (D9); an owner gets in only through an invitation link
// (D11). The support actions on a company's team (resend or cancel an invitation, switch estimator
// and office, re-enable a member) are the team service's (web/src/lib/team/), called by the routes.

export const PLATFORM_ERRORS = {
  not_found: 404,
  // The status cannot move that way: archive needs a suspended company.
  suspend_first: 409,
  sign_in_address_taken: 409,
  tenant_already_bound: 409,
  // The tenant is another company's, or the operator tenant.
  tenant_in_use: 409,
  // The company has no sign-in address or tenant yet, so an invitation link cannot work.
  company_not_ready: 409,
  owner_exists: 409,
  no_owner: 409,
  already_member: 409,
  invitation_pending: 409,
  conflict: 409,
} as const;
export type PlatformErrorCode = keyof typeof PLATFORM_ERRORS;

export class PlatformError extends Error {
  readonly status: number;
  constructor(readonly code: PlatformErrorCode) {
    super(`Platform action refused: ${code}`);
    this.name = 'PlatformError';
    this.status = PLATFORM_ERRORS[code];
  }
}

export type CompanyStatus = 'active' | 'suspended' | 'archived';

export type CompanyView = {
  id: string;
  name: string;
  signInSlug: string | null;
  status: CompanyStatus;
  // Whether the company has its sign-in tenant yet; the tenant id itself is not shown.
  tenantBound: boolean;
  createdAt: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

const STATUS_ACTIONS: Record<CompanyStatus, string> = {
  active: 'company_reactivated',
  suspended: 'company_suspended',
  archived: 'company_archived',
};

type CompanyRow = {
  id: string;
  name: string;
  sign_in_slug: string | null;
  status: CompanyStatus;
  auth_tenant_id: string | null;
  created_at: Date | string;
};

function companyView(row: CompanyRow): CompanyView {
  return {
    id: row.id,
    name: row.name,
    signInSlug: row.sign_in_slug,
    status: row.status,
    tenantBound: row.auth_tenant_id !== null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

// D9's email to the person whose second step was reset. It waits for the email service (S9), which
// plugs in here; until then nothing is sent and the operator tells the person by phone.
export type SecondStepNotice = (companyId: string, membershipId: string) => Promise<'sent' | 'not_sent'>;
export const noEmailService: SecondStepNotice = async () => 'not_sent';

function rows<T>(result: unknown): T[] {
  return result as T[];
}

function constraintOf(error: unknown): { code: string | null; constraint: string | null } {
  const found = error as { code?: unknown; constraint_name?: unknown; cause?: { code?: unknown; constraint_name?: unknown } } | null;
  const code = found?.code ?? found?.cause?.code;
  const constraint = found?.constraint_name ?? found?.cause?.constraint_name;
  return {
    code: typeof code === 'string' ? code : null,
    constraint: typeof constraint === 'string' ? constraint : null,
  };
}

// One audit row naming the operator: ids, roles and counts only, never an email.
async function audit(
  tx: CompanyTransaction,
  operatorId: string,
  companyId: string,
  action: string,
  target: string,
  details: Record<string, string | number | boolean> = {},
): Promise<void> {
  await tx.insert(auditEvents).values({ companyId, actorId: null, operatorActorId: operatorId, action, target, details });
}

async function lockedCompany(tx: CompanyTransaction, companyId: string): Promise<CompanyRow> {
  const [row] = rows<CompanyRow>(
    await tx.execute(sql`
      SELECT id::text, name, sign_in_slug, status, auth_tenant_id, created_at
      FROM companies WHERE id = ${companyId}::uuid FOR UPDATE
    `),
  );
  if (!row) throw new PlatformError('not_found');
  return row;
}

export function platformService(db: Database, users: PlatformUsers, project: ProjectAccess, notice: SecondStepNotice) {
  // A unique index caught two operator actions racing; nothing was written.
  async function act<T>(operatorId: string, run: (tx: CompanyTransaction) => Promise<T>, companyId?: string): Promise<T> {
    try {
      return await withOperator(db, operatorId, run, companyId === undefined ? {} : { companyId });
    } catch (error) {
      const { code, constraint } = constraintOf(error);
      if (code === '23505' && constraint === 'companies_sign_in_slug_key') throw new PlatformError('sign_in_address_taken');
      if (code === '23505' && (constraint === 'auth_tenants_pkey' || constraint === 'companies_auth_tenant_id_key')) {
        throw new PlatformError('tenant_in_use');
      }
      if (code === '23505') throw new PlatformError('conflict');
      throw error;
    }
  }

  async function projectAll(companyId: string, actorIds: string[]): Promise<void> {
    for (const actorId of actorIds) await project(companyId, actorId);
  }

  return {
    // Every company, oldest first. A read: no audit row, and the transaction is read-only.
    async listCompanies(operatorId: string): Promise<{ companies: CompanyView[] }> {
      return withOperator(
        db,
        operatorId,
        async (tx) => {
          const found = rows<CompanyRow>(
            await tx.execute(sql`
              SELECT id::text, name, sign_in_slug, status, auth_tenant_id, created_at
              FROM companies ORDER BY created_at, id
            `),
          );
          return { companies: found.map(companyView) };
        },
        { readOnly: true },
      );
    },

    // A new, active company with its name and sign-in address and no tenant or owner yet: bind its
    // tenant (made by the owner-run command), then invite its owner.
    async createCompany(operatorId: string, input: { name: string; signInSlug: string }): Promise<{ company: CompanyView }> {
      return act(operatorId, async (tx) => {
        const [row] = rows<CompanyRow>(
          await tx.execute(sql`
            INSERT INTO companies (name, sign_in_slug) VALUES (${input.name}, ${input.signInSlug})
            RETURNING id::text, name, sign_in_slug, status, auth_tenant_id, created_at
          `),
        );
        await audit(tx, operatorId, row!.id, 'company_created', row!.id);
        return { company: companyView(row!) };
      });
    },

    // Suspend, reactivate or archive. Archive needs a suspended company; reactivating works from
    // suspended or archived. Setting the status a company already has changes nothing. Every member's
    // access record follows (a company that is not active has none).
    async setStatus(operatorId: string, companyId: string, status: CompanyStatus, now: Date): Promise<{ company: CompanyView }> {
      const queued: string[] = [];
      const result = await act(
        operatorId,
        async (tx) => {
          const row = await lockedCompany(tx, companyId);
          if (row.status === status) return { company: companyView(row) };
          if (status === 'archived' && row.status !== 'suspended') throw new PlatformError('suspend_first');
          const [updated] = rows<CompanyRow>(
            await tx.execute(sql`
              UPDATE companies SET status = ${status}, updated_at = ${now.toISOString()}::timestamptz
              WHERE id = ${companyId}::uuid
              RETURNING id::text, name, sign_in_slug, status, auth_tenant_id, created_at
            `),
          );
          const members = await tx.select({ id: actors.id }).from(actors).where(eq(actors.companyId, companyId));
          for (const { id } of members) {
            await enqueueAccessProjection(tx, companyId, id);
            queued.push(id);
          }
          await audit(tx, operatorId, companyId, STATUS_ACTIONS[status], companyId, { from: row.status, to: status });
          return { company: companyView(updated!) };
        },
        companyId,
      );
      await projectAll(companyId, queued);
      return result;
    },

    // Turns one known feature on or off for one company (S3-11b, owner decision D12: only an
    // operator does). The flag and exactly one audit row naming the operator commit together; an
    // unknown flag name or company is refused and writes nothing. Setting the value a flag already
    // has is still a change the operator made, so it is written and audited like any other.
    async setFlag(operatorId: string, companyId: string, input: { flag: string; enabled: boolean }): Promise<FlagChangeResult> {
      return changeCompanyFlag(postgresFlagStore(db, operatorId), {
        operatorActorId: operatorId,
        companyId,
        flag: input.flag,
        enabled: input.enabled,
      });
    },

    // Binds the company to the sign-in tenant made for it, once. The tenant id is registered as a
    // company tenant here; the operator tenant, or another company's, is refused.
    async bindTenant(operatorId: string, companyId: string, tenantId: string, now: Date): Promise<{ company: CompanyView }> {
      return act(
        operatorId,
        async (tx) => {
          const row = await lockedCompany(tx, companyId);
          if (row.auth_tenant_id === tenantId) return { company: companyView(row) };
          if (row.auth_tenant_id !== null) throw new PlatformError('tenant_already_bound');
          const [known] = rows<{ kind: string; used: boolean }>(
            await tx.execute(sql`
              SELECT t.kind, EXISTS (SELECT 1 FROM companies c WHERE c.auth_tenant_id = t.id) AS used
              FROM auth_tenants t WHERE t.id = ${tenantId}
            `),
          );
          if (known && (known.kind !== 'company' || known.used)) throw new PlatformError('tenant_in_use');
          if (!known) await tx.execute(sql`INSERT INTO auth_tenants (id, kind) VALUES (${tenantId}, 'company')`);
          const [updated] = rows<CompanyRow>(
            await tx.execute(sql`
              UPDATE companies SET auth_tenant_id = ${tenantId}, updated_at = ${now.toISOString()}::timestamptz
              WHERE id = ${companyId}::uuid
              RETURNING id::text, name, sign_in_slug, status, auth_tenant_id, created_at
            `),
          );
          await audit(tx, operatorId, companyId, 'company_tenant_bound', companyId);
          return { company: companyView(updated!) };
        },
        companyId,
      );
    },

    // Invites the company's owner by link (D11). With replace, the current owner is disabled and
    // signed out everywhere before this answers, and the new owner's invitation is the way back in;
    // without it, a company that has an active owner is refused. Older pending owner invitations
    // are cancelled, so only one owner invitation is ever open.
    async inviteOwner(
      operatorId: string,
      companyId: string,
      input: { email: string; replace: boolean },
      now: Date,
    ): Promise<{ invitation: InvitationView; delivery: 'copy_link'; link: string; replacedMembershipId: string | null }> {
      const queued: string[] = [];
      const result = await act(
        operatorId,
        async (tx) => {
          const company = await lockedCompany(tx, companyId);
          if (!company.sign_in_slug || !company.auth_tenant_id) throw new PlatformError('company_not_ready');

          const [current] = await tx
            .select({ membershipId: memberships.id, actorId: actors.id, tenant: actors.authTenantId, uid: actors.uid })
            .from(memberships)
            .innerJoin(actors, and(eq(actors.companyId, memberships.companyId), eq(actors.id, memberships.actorId)))
            .where(and(eq(memberships.companyId, companyId), eq(memberships.role, 'owner'), eq(memberships.status, 'active')))
            .for('update', { of: memberships });
          if (current && !input.replace) throw new PlatformError('owner_exists');
          if (!current && input.replace) throw new PlatformError('no_owner');

          // A convenience check only: acceptance binds the person by sign-in tenant and uid.
          const [member] = await tx
            .select({ id: memberships.id })
            .from(memberships)
            .innerJoin(actors, and(eq(actors.companyId, memberships.companyId), eq(actors.id, memberships.actorId)))
            .where(and(eq(memberships.companyId, companyId), eq(actors.email, input.email)))
            .limit(1);
          if (member) throw new PlatformError('already_member');

          const cancelled = rows<{ id: string }>(
            await tx.execute(sql`
              UPDATE invitations SET status = 'cancelled', cancelled_at = ${now.toISOString()}::timestamptz,
                updated_at = ${now.toISOString()}::timestamptz
              WHERE company_id = ${companyId}::uuid AND role = 'owner' AND status = 'pending'
              RETURNING id::text
            `),
          );
          const [pending] = await tx
            .select({ id: invitations.id })
            .from(invitations)
            .where(and(eq(invitations.companyId, companyId), eq(invitations.email, input.email), eq(invitations.status, 'pending')));
          if (pending) throw new PlatformError('invitation_pending');

          const [row] = await tx
            .insert(invitations)
            .values({
              companyId,
              email: input.email,
              role: 'owner',
              expiresAt: new Date(now.getTime() + INVITATION_DAYS * DAY_MS),
              createdByOperatorId: operatorId,
            })
            .returning({
              id: invitations.id,
              email: invitations.email,
              role: invitations.role,
              status: invitations.status,
              expiresAt: invitations.expiresAt,
              createdAt: invitations.createdAt,
            });

          if (current) {
            await tx
              .update(memberships)
              .set({ status: 'disabled', updatedAt: now })
              .where(and(eq(memberships.companyId, companyId), eq(memberships.id, current.membershipId)));
            await enqueueAccessProjection(tx, companyId, current.actorId);
            queued.push(current.actorId);
          }
          await audit(tx, operatorId, companyId, current ? 'owner_replaced' : 'owner_invited', row!.id, {
            cancelledInvitations: cancelled.length,
            ...(current ? { replacedMembershipId: current.membershipId } : {}),
          });
          // Last, and before the commit: if either fails, nothing changes and the operator can try
          // again. A commit that fails after the revocation only signs the old owner out.
          await users.ensureAccount(company.auth_tenant_id, input.email);
          if (current) await users.revokeSessions(current.tenant, current.uid);
          return {
            invitation: invitationView(row!, now),
            delivery: 'copy_link' as const,
            link: invitationLink(company.sign_in_slug, row!.id),
            replacedMembershipId: current?.membershipId ?? null,
          };
        },
        companyId,
      );
      await projectAll(companyId, queued);
      return result;
    },

    // D9: after the operator has confirmed the person by phone, removes their second steps and
    // signs them out; they enrol again at their next sign-in. The audit row is written first in the
    // same transaction, and the sign-in change runs before the commit, so a failure changes nothing.
    // The email follows the commit. With no email service yet (S9) it is not sent, and the answer
    // tells the operator to tell the person by phone.
    async resetSecondStep(
      operatorId: string,
      companyId: string,
      membershipId: string,
    ): Promise<{ reset: true; email: 'sent' | 'not_sent'; tellByPhone: boolean }> {
      await act(
        operatorId,
        async (tx) => {
          const [row] = await tx
            .select({ role: memberships.role, tenant: actors.authTenantId, uid: actors.uid })
            .from(memberships)
            .innerJoin(actors, and(eq(actors.companyId, memberships.companyId), eq(actors.id, memberships.actorId)))
            .where(and(eq(memberships.companyId, companyId), eq(memberships.id, membershipId)))
            .for('update', { of: memberships });
          if (!row) throw new PlatformError('not_found');
          await audit(tx, operatorId, companyId, 'second_step_reset', membershipId, { role: row.role, confirmedBy: 'phone' });
          await users.resetSecondStep(row.tenant, row.uid);
        },
        companyId,
      );
      const email = await notice(companyId, membershipId);
      return { reset: true as const, email, tellByPhone: email !== 'sent' };
    },

    // The read-only support view of a company's team: read in a read-only transaction, then one
    // audit row for the view. Nothing is returned unless that row committed.
    async supportTeam(operatorId: string, companyId: string, now: Date): Promise<{ company: CompanyView; team: TeamView }> {
      const seen = await withOperator(
        db,
        operatorId,
        async (tx) => {
          const [company] = rows<CompanyRow>(
            await tx.execute(sql`
              SELECT id::text, name, sign_in_slug, status, auth_tenant_id, created_at
              FROM companies WHERE id = ${companyId}::uuid
            `),
          );
          if (!company) throw new PlatformError('not_found');
          return { company: companyView(company), team: await readTeam(tx, companyId, 'full', now) };
        },
        { companyId, readOnly: true },
      );
      await act(operatorId, (tx) => audit(tx, operatorId, companyId, 'support_team_viewed', companyId), companyId);
      return seen;
    },

    // The read-only support view of a company's prices (S4-6): the current version, the working copy
    // and the version list, read in a read-only transaction, then one audit row for the view. The
    // database refuses an operator's price writes too (migration 0009). Nothing is returned unless
    // that row committed.
    async supportPrices(
      operatorId: string,
      companyId: string,
    ): Promise<{ company: CompanyView; prices: PricesView; versions: VersionMeta[]; moreVersions: boolean }> {
      const seen = await withOperator(
        db,
        operatorId,
        async (tx) => {
          const [company] = rows<CompanyRow>(
            await tx.execute(sql`
              SELECT id::text, name, sign_in_slug, status, auth_tenant_id, created_at
              FROM companies WHERE id = ${companyId}::uuid
            `),
          );
          if (!company) throw new PlatformError('not_found');
          const list = await readVersionList(tx, companyId);
          return {
            company: companyView(company),
            prices: await readCompanyPrices(tx, companyId, 'owner'),
            versions: list.versions,
            moreVersions: list.more,
          };
        },
        { companyId, readOnly: true },
      );
      await act(operatorId, (tx) => audit(tx, operatorId, companyId, 'support_prices_viewed', companyId), companyId);
      return seen;
    },
  };
}

export type PlatformService = ReturnType<typeof platformService>;
