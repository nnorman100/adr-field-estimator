import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { accessProjectionOutbox, actors, auditEvents, companies, invitations, memberships } from '@/db/schema';
import { holdAcrossOutsideCall, withCompany, withOperator, type CompanyTransaction, type Database } from '@/db/tenant';
import type { Role } from '@/lib/access';
import { IdentityRefusal, sessionRefusal, type Account } from '@/lib/auth';
import type { TenantUsers } from './users';

// The company's team and its invitations (S3-10). Every function runs inside withCompany for a
// company id taken from the verified sign-in (or, for a platform operator, the company the
// operator is supporting), so the row-level security policies of migration 0003 limit it to that
// company. Every change writes one audit row in the same transaction, and every membership change
// queues the member's Firestore access record (access_projection_outbox, S3-12) and, once the
// change has committed, projects it before answering.
//
// Owner decisions this follows: an invitation link is the only way in, and nobody but the invitee
// ever knows a password (D11); the owner role is changed only by the platform operator (S3-9), so
// nothing here can disable, demote, promote or re-enable an owner.

// An invitation is open for 7 days from when it was sent or last resent.
export const INVITATION_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export const TEAM_ERRORS = {
  // The caller's role cannot use this team route.
  not_allowed: 403,
  // A platform operator may take only the listed support actions.
  support_action_refused: 403,
  // No such record in this company, or an invitation addressed to another email.
  not_found: 404,
  already_member: 409,
  // The email already has an open (or expired but not cleared) invitation: resend or cancel it.
  invitation_pending: 409,
  // The invitation was cancelled, or accepted by someone else.
  invitation_closed: 409,
  // Only a finished invitation can be cleared.
  invitation_active: 409,
  invitation_expired: 410,
  owner_protected: 409,
  // The company has no active owner, so its pending owner invitation is the only way one gets in.
  owner_invitation_required: 409,
  // The company has no sign-in address or tenant yet, so an invitation link cannot work.
  company_not_ready: 409,
  // Two changes met at the same moment; the caller may try again.
  conflict: 409,
} as const;
export type TeamErrorCode = keyof typeof TEAM_ERRORS;

export class TeamError extends Error {
  readonly status: number;
  constructor(readonly code: TeamErrorCode) {
    super(`Team change refused: ${code}`);
    this.name = 'TeamError';
    this.status = TEAM_ERRORS[code];
  }
}

// Who makes a change: an owner of the company, or a platform operator taking a support action.
export type TeamActor = { kind: 'member'; actorId: string } | { kind: 'operator'; operatorId: string };

// What a platform operator may do to a company's team (docs/spec.md, superadmin support actions).
// Inviting, clearing and disabling stay with the owner.
export const OPERATOR_SUPPORT_ACTIONS: ReadonlySet<string> = new Set([
  'invitation_resent',
  'invitation_cancelled',
  'member_role_changed',
  'member_enabled',
]);

export type StaffRole = Exclude<Role, 'owner'>;
export type InvitationStatus = 'pending' | 'expired' | 'accepted' | 'cancelled';

export type InvitationView = {
  id: string;
  email: string;
  role: Role;
  status: InvitationStatus;
  expiresAt: string;
  createdAt: string;
};

export type MemberView = {
  membershipId: string;
  actorId: string;
  displayName: string | null;
  email: string;
  role: Role;
  status: 'active' | 'disabled';
};

export type EstimatorView = Pick<MemberView, 'membershipId' | 'actorId' | 'displayName' | 'email'>;

export type TeamView =
  | { view: 'full'; members: MemberView[]; invitations: InvitationView[] }
  | { view: 'estimators'; estimators: EstimatorView[] };

// No email service is set up for the rebuilt app yet (S9), so every invitation is delivered by a
// link the owner copies and sends. The link is the company's own sign-in address (owner decision
// D5), so the invitee signs in to the right company; the screens (S3-13, S3-16) serve it.
export type Delivery = { delivery: 'copy_link'; link: string };

export function invitationLink(signInSlug: string, invitationId: string): string {
  return `/sign-in/${encodeURIComponent(signInSlug)}/invitations/${invitationId}`;
}

type InvitationRow = {
  id: string;
  email: string;
  role: Role;
  status: 'pending' | 'accepted' | 'cancelled';
  expiresAt: Date;
  createdAt: Date;
};

function isExpired(row: Pick<InvitationRow, 'status' | 'expiresAt'>, now: Date): boolean {
  return row.status === 'pending' && row.expiresAt.getTime() <= now.getTime();
}

export function invitationView(row: InvitationRow, now: Date): InvitationView {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: isExpired(row, now) ? 'expired' : row.status,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

const invitationColumns = {
  id: invitations.id,
  email: invitations.email,
  role: invitations.role,
  status: invitations.status,
  expiresAt: invitations.expiresAt,
  createdAt: invitations.createdAt,
};

const memberColumns = {
  membershipId: memberships.id,
  actorId: actors.id,
  displayName: actors.displayName,
  email: actors.email,
  role: memberships.role,
  status: memberships.status,
};

const actorOfMembership = and(eq(actors.companyId, memberships.companyId), eq(actors.id, memberships.actorId));

function expiryFrom(now: Date): Date {
  return new Date(now.getTime() + INVITATION_DAYS * DAY_MS);
}

function isUniqueViolation(error: unknown): boolean {
  const found = error as { code?: unknown; cause?: { code?: unknown } } | null;
  return found?.code === '23505' || found?.cause?.code === '23505';
}

// A unique index caught two changes racing (for example two invitations for one email, or two
// active memberships for one person). Nothing was written; the caller may try again.
//
// A platform operator's support action runs in that operator's own context (withOperator, migration
// 0006) as well as the company's, because an audit row may name an operator only there.
async function inCompany<T>(
  db: Database,
  companyId: string,
  run: (tx: CompanyTransaction) => Promise<T>,
  by?: TeamActor,
): Promise<T> {
  try {
    return by?.kind === 'operator'
      ? await withOperator(db, by.operatorId, run, { companyId })
      : await withCompany(db, companyId, run);
  } catch (error) {
    if (isUniqueViolation(error)) throw new TeamError('conflict');
    throw error;
  }
}

function allowed(by: TeamActor, action: string): void {
  if (by.kind === 'operator' && !OPERATOR_SUPPORT_ACTIONS.has(action)) throw new TeamError('support_action_refused');
}

// One audit row per change: ids and roles only, never an email.
async function audit(
  tx: CompanyTransaction,
  companyId: string,
  by: TeamActor | { kind: 'invitee'; actorId: string },
  action: string,
  target: string,
  details: Record<string, string | number | boolean> = {},
): Promise<void> {
  await tx.insert(auditEvents).values({
    companyId,
    actorId: by.kind === 'operator' ? null : by.actorId,
    operatorActorId: by.kind === 'operator' ? by.operatorId : null,
    action,
    target,
    details,
  });
}

async function readyCompany(tx: CompanyTransaction, companyId: string): Promise<{ slug: string; tenant: string }> {
  const [company] = await tx
    .select({ slug: companies.signInSlug, tenant: companies.authTenantId })
    .from(companies)
    .where(eq(companies.id, companyId));
  if (!company) throw new TeamError('not_found');
  if (!company.slug || !company.tenant) throw new TeamError('company_not_ready');
  return { slug: company.slug, tenant: company.tenant };
}

async function invitationRow(tx: CompanyTransaction, companyId: string, invitationId: string, lock: boolean) {
  const found = tx
    .select({ ...invitationColumns, clearedAt: invitations.clearedAt, acceptedByActorId: invitations.acceptedByActorId })
    .from(invitations)
    .where(and(eq(invitations.companyId, companyId), eq(invitations.id, invitationId)));
  const [row] = await (lock ? found.for('update') : found);
  return row ?? null;
}

async function lockedInvitation(tx: CompanyTransaction, companyId: string, invitationId: string) {
  return invitationRow(tx, companyId, invitationId, true);
}

// The owner who writes an invitation is still the company's active owner when it is written, and
// stays so until it commits: the operator's owner replacement locks the same membership row.
async function lockActiveOwner(tx: CompanyTransaction, companyId: string, by: TeamActor): Promise<void> {
  if (by.kind !== 'member') return;
  const [owner] = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        eq(memberships.companyId, companyId),
        eq(memberships.actorId, by.actorId),
        eq(memberships.role, 'owner'),
        eq(memberships.status, 'active'),
      ),
    )
    .for('update');
  if (!owner) throw new TeamError('not_allowed');
}

// An email already a member, or with an open invitation, is not invited again. A convenience check
// only: acceptance binds the person by sign-in tenant and uid, never by email.
async function refuseUninvitable(tx: CompanyTransaction, companyId: string, email: string): Promise<void> {
  const [member] = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .innerJoin(actors, actorOfMembership)
    .where(and(eq(memberships.companyId, companyId), eq(actors.email, email)))
    .limit(1);
  if (member) throw new TeamError('already_member');
  const [pending] = await tx
    .select({ id: invitations.id })
    .from(invitations)
    .where(and(eq(invitations.companyId, companyId), eq(invitations.email, email), eq(invitations.status, 'pending')));
  if (pending) throw new TeamError('invitation_pending');
}

async function pendingInvitation(tx: CompanyTransaction, companyId: string, invitationId: string, lock: boolean) {
  const row = await invitationRow(tx, companyId, invitationId, lock);
  if (!row || row.clearedAt) throw new TeamError('not_found');
  if (row.status !== 'pending') throw new TeamError('invitation_closed');
  return row;
}

async function lockedMember(tx: CompanyTransaction, companyId: string, membershipId: string) {
  const [row] = await tx
    .select({ ...memberColumns, tenant: actors.authTenantId, uid: actors.uid })
    .from(memberships)
    .innerJoin(actors, actorOfMembership)
    .where(and(eq(memberships.companyId, companyId), eq(memberships.id, membershipId)))
    .for('update', { of: memberships });
  if (!row) throw new TeamError('not_found');
  // The owner is changed only by the platform operator's owner replacement (S3-9).
  if (row.role === 'owner') throw new TeamError('owner_protected');
  return row;
}

function memberView(row: MemberView): MemberView {
  const { membershipId, actorId, displayName, email, role, status } = row;
  return { membershipId, actorId, displayName, email, role, status };
}

// The team as the owner (full) or an office user (estimators) sees it, read in the caller's
// transaction for that company: the team list, and the operator's read-only support view (S3-9).
export async function readTeam(
  tx: CompanyTransaction,
  companyId: string,
  view: 'full' | 'estimators',
  now: Date,
): Promise<TeamView> {
  if (view === 'estimators') {
    const estimators = await tx
      .select({
        membershipId: memberships.id,
        actorId: actors.id,
        displayName: actors.displayName,
        email: actors.email,
      })
      .from(memberships)
      .innerJoin(actors, actorOfMembership)
      .where(
        and(
          eq(memberships.companyId, companyId),
          eq(memberships.role, 'estimator'),
          eq(memberships.status, 'active'),
        ),
      )
      .orderBy(asc(memberships.createdAt), asc(memberships.id));
    return { view, estimators };
  }
  const members = await tx
    .select(memberColumns)
    .from(memberships)
    .innerJoin(actors, actorOfMembership)
    .where(eq(memberships.companyId, companyId))
    .orderBy(asc(memberships.createdAt), asc(memberships.id));
  const open = await tx
    .select(invitationColumns)
    .from(invitations)
    .where(and(eq(invitations.companyId, companyId), isNull(invitations.clearedAt)))
    .orderBy(desc(invitations.createdAt), asc(invitations.id));
  return { view, members, invitations: open.map((row) => invitationView(row, now)) };
}

// Brings one member's Firestore access record in line with what just committed. It never throws:
// a record it cannot write stays waiting in the outbox (web/src/lib/projection/services.ts).
export type ProjectAccess = (companyId: string, actorId: string) => Promise<void>;

export function teamService(db: Database, users: TenantUsers, project: ProjectAccess) {
  // A change that alters a membership: `queue` adds the member's outbox row in the change's own
  // transaction, and each queued member is projected only after that transaction commits.
  async function membershipChange<T>(
    companyId: string,
    run: (tx: CompanyTransaction, queue: (actorId: string) => Promise<void>) => Promise<T>,
    by?: TeamActor,
  ): Promise<T> {
    const queued: string[] = [];
    const result = await inCompany(
      db,
      companyId,
      (tx) =>
        run(tx, async (actorId) => {
          await tx.insert(accessProjectionOutbox).values({ companyId, actorId });
          queued.push(actorId);
        }),
      by,
    );
    for (const actorId of queued) await project(companyId, actorId);
    return result;
  }

  return {
    // The owner (and a supporting operator) sees every member and every invitation not cleared.
    // An office user sees only the active estimators, to assign work to them.
    async list(companyId: string, view: 'full' | 'estimators', now: Date): Promise<TeamView> {
      return withCompany(db, companyId, async (tx) => {
        await tx.execute(sql`SET TRANSACTION READ ONLY`);
        return readTeam(tx, companyId, view, now);
      });
    },

    // The sign-in account is made with no transaction open (security audit F5): a short read finds
    // the company's tenant and checks the email may be invited, the account is made, and only then
    // does the transaction that writes the invitation open, checking all of it again. Making the
    // account is safe to repeat and writes nothing to Postgres, so a failure on either side leaves
    // nothing to undo and the owner can simply try again.
    async invite(
      companyId: string,
      by: TeamActor,
      input: { email: string; role: StaffRole },
      now: Date,
    ): Promise<{ invitation: InvitationView } & Delivery> {
      allowed(by, 'invitation_created');
      const { tenant } = await inCompany(db, companyId, async (tx) => {
        const company = await readyCompany(tx, companyId);
        await refuseUninvitable(tx, companyId, input.email);
        return company;
      });
      await users.ensureAccount(tenant, input.email);
      return inCompany(db, companyId, async (tx) => {
        await lockActiveOwner(tx, companyId, by);
        const { slug } = await readyCompany(tx, companyId);
        await refuseUninvitable(tx, companyId, input.email);
        const [row] = await tx
          .insert(invitations)
          .values({
            companyId,
            email: input.email,
            role: input.role,
            expiresAt: expiryFrom(now),
            createdByActorId: by.kind === 'member' ? by.actorId : null,
            createdByOperatorId: by.kind === 'operator' ? by.operatorId : null,
          })
          .returning(invitationColumns);
        await audit(tx, companyId, by, 'invitation_created', row!.id, { role: input.role });
        return { invitation: invitationView(row!, now), delivery: 'copy_link', link: invitationLink(slug, row!.id) };
      });
    },

    // A pending invitation, expired or not, gets a fresh 7 days and its link again. As for invite,
    // its sign-in account is made between a short read and the transaction that renews it. The
    // renewal counts from the later of this request's time and the last time it was issued, so a
    // resend that commits after a later one never shortens the invitation.
    async resend(
      companyId: string,
      by: TeamActor,
      invitationId: string,
      now: Date,
    ): Promise<{ invitation: InvitationView } & Delivery> {
      allowed(by, 'invitation_resent');
      const found = await inCompany(db, companyId, async (tx) => {
        const company = await readyCompany(tx, companyId);
        const row = await pendingInvitation(tx, companyId, invitationId, false);
        return { tenant: company.tenant, email: row.email };
      }, by);
      await users.ensureAccount(found.tenant, found.email);
      return inCompany(db, companyId, async (tx) => {
        await lockActiveOwner(tx, companyId, by);
        const { slug } = await readyCompany(tx, companyId);
        const row = await pendingInvitation(tx, companyId, invitationId, true);
        const lastIssued = row.expiresAt.getTime() - INVITATION_DAYS * DAY_MS;
        const issued = new Date(Math.max(now.getTime(), lastIssued));
        const wasExpired = isExpired(row, issued);
        const [updated] = await tx
          .update(invitations)
          .set({ expiresAt: expiryFrom(issued), updatedAt: issued })
          .where(and(eq(invitations.companyId, companyId), eq(invitations.id, invitationId)))
          .returning(invitationColumns);
        await audit(tx, companyId, by, 'invitation_resent', invitationId, { wasExpired });
        return {
          invitation: invitationView(updated!, now),
          delivery: 'copy_link',
          link: invitationLink(slug, invitationId),
        };
      }, by);
    },

    async cancel(companyId: string, by: TeamActor, invitationId: string, now: Date): Promise<{ invitation: InvitationView }> {
      allowed(by, 'invitation_cancelled');
      return inCompany(db, companyId, async (tx) => {
        const row = await lockedInvitation(tx, companyId, invitationId);
        if (!row || row.clearedAt) throw new TeamError('not_found');
        if (row.status !== 'pending') throw new TeamError('invitation_closed');
        if (row.role === 'owner') {
          const [owner] = await tx
            .select({ id: memberships.id })
            .from(memberships)
            .where(and(eq(memberships.companyId, companyId), eq(memberships.role, 'owner'), eq(memberships.status, 'active')))
            .limit(1);
          if (!owner) throw new TeamError('owner_invitation_required');
        }
        const [updated] = await tx
          .update(invitations)
          .set({ status: 'cancelled', cancelledAt: now, updatedAt: now })
          .where(and(eq(invitations.companyId, companyId), eq(invitations.id, invitationId)))
          .returning(invitationColumns);
        await audit(tx, companyId, by, 'invitation_cancelled', invitationId);
        return { invitation: invitationView(updated!, now) };
      }, by);
    },

    // Hides a finished invitation (accepted, cancelled or expired) from the team list. The record
    // stays until record retention removes it. An expired one is also closed, so the email can be
    // invited again.
    async clear(companyId: string, by: TeamActor, invitationId: string, now: Date): Promise<{ cleared: true }> {
      allowed(by, 'invitation_cleared');
      return inCompany(db, companyId, async (tx) => {
        const row = await lockedInvitation(tx, companyId, invitationId);
        if (!row || row.clearedAt) throw new TeamError('not_found');
        const expired = isExpired(row, now);
        if (row.status === 'pending' && !expired) throw new TeamError('invitation_active');
        await tx
          .update(invitations)
          .set(expired ? { status: 'cancelled', cancelledAt: now, clearedAt: now, updatedAt: now } : { clearedAt: now, updatedAt: now })
          .where(and(eq(invitations.companyId, companyId), eq(invitations.id, invitationId)));
        await audit(tx, companyId, by, 'invitation_cleared', invitationId, { expired });
        return { cleared: true };
      }, by);
    },

    // Between estimator and office only. Changing to the role the member already has changes nothing.
    async changeRole(
      companyId: string,
      by: TeamActor,
      membershipId: string,
      role: StaffRole,
      now: Date,
    ): Promise<{ member: MemberView }> {
      allowed(by, 'member_role_changed');
      return membershipChange(companyId, async (tx, queue) => {
        const row = await lockedMember(tx, companyId, membershipId);
        if (row.role === role) return { member: memberView(row) };
        await tx
          .update(memberships)
          .set({ role, updatedAt: now })
          .where(and(eq(memberships.companyId, companyId), eq(memberships.id, membershipId)));
        await queue(row.actorId);
        await audit(tx, companyId, by, 'member_role_changed', membershipId, { from: row.role, to: role });
        return { member: memberView({ ...row, role }) };
      }, by);
    },

    // Blocks the member at once: every request checks the membership, and their sessions are
    // revoked before this returns. The revocation runs before the commit, so if it fails nothing
    // changes and the owner can try again; a failed commit after it only signs the member out.
    async disable(companyId: string, by: TeamActor, membershipId: string, now: Date): Promise<{ member: MemberView }> {
      allowed(by, 'member_disabled');
      return membershipChange(companyId, async (tx, queue) => {
        const row = await lockedMember(tx, companyId, membershipId);
        if (row.status === 'disabled') return { member: memberView(row) };
        await tx
          .update(memberships)
          .set({ status: 'disabled', updatedAt: now })
          .where(and(eq(memberships.companyId, companyId), eq(memberships.id, membershipId)));
        await queue(row.actorId);
        await audit(tx, companyId, by, 'member_disabled', membershipId);
        await holdAcrossOutsideCall(tx);
        await users.revokeSessions(row.tenant, row.uid);
        return { member: memberView({ ...row, status: 'disabled' }) };
      }, by);
    },

    async enable(companyId: string, by: TeamActor, membershipId: string, now: Date): Promise<{ member: MemberView }> {
      allowed(by, 'member_enabled');
      return membershipChange(companyId, async (tx, queue) => {
        const row = await lockedMember(tx, companyId, membershipId);
        if (row.status === 'active') return { member: memberView(row) };
        await tx
          .update(memberships)
          .set({ status: 'active', updatedAt: now })
          .where(and(eq(memberships.companyId, companyId), eq(memberships.id, membershipId)));
        await queue(row.actorId);
        await audit(tx, companyId, by, 'member_enabled', membershipId);
        return { member: memberView({ ...row, status: 'active' }) };
      }, by);
    },

    // What the invitee sees before accepting. An invitation for another email reads as not found,
    // so the link alone shows nothing to anyone else.
    async readInvitation(account: Account, invitationId: string, now: Date) {
      return withCompany(db, account.companyId, async (tx) => {
        await tx.execute(sql`SET TRANSACTION READ ONLY`);
        const [row] = await tx
          .select(invitationColumns)
          .from(invitations)
          .where(and(eq(invitations.companyId, account.companyId), eq(invitations.id, invitationId)));
        if (!row || row.email !== account.email) throw new TeamError('not_found');
        const { id, role, status, expiresAt } = invitationView(row, now);
        return { invitation: { id, role, status, expiresAt }, company: { id: account.companyId, name: account.companyName } };
      });
    },

    // Creates the person's actor (bound to their sign-in tenant and uid) and one membership, once.
    // Accepting again returns the same membership and writes nothing.
    async accept(account: Account, invitationId: string, now: Date) {
      return membershipChange(account.companyId, async (tx, queue) => {
        const companyId = account.companyId;
        const row = await lockedInvitation(tx, companyId, invitationId);
        if (!row || row.email !== account.email) throw new TeamError('not_found');

        const [existing] = await tx
          .select({ id: actors.id })
          .from(actors)
          .where(and(eq(actors.companyId, companyId), eq(actors.authTenantId, account.tenant), eq(actors.uid, account.uid)));

        if (row.status === 'accepted') {
          if (!existing || row.acceptedByActorId !== existing.id) throw new TeamError('invitation_closed');
          const [membership] = await tx
            .select({ id: memberships.id, role: memberships.role, status: memberships.status })
            .from(memberships)
            .where(and(eq(memberships.companyId, companyId), eq(memberships.invitationId, invitationId)));
          if (!membership) throw new TeamError('invitation_closed');
          return { membershipId: membership.id, role: membership.role, status: membership.status, accepted: false };
        }
        if (row.status === 'cancelled') throw new TeamError('invitation_closed');
        if (isExpired(row, now)) throw new TeamError('invitation_expired');

        // The second step and sign-in age the role being accepted needs (an owner needs an
        // authenticator app before anything else, D8).
        const refused = sessionRefusal(row.role, account.session, {}, Math.floor(now.getTime() / 1000));
        if (refused) throw new IdentityRefusal(refused);

        if (existing) {
          const [held] = await tx
            .select({ id: memberships.id })
            .from(memberships)
            .where(and(eq(memberships.companyId, companyId), eq(memberships.actorId, existing.id)))
            .limit(1);
          if (held) throw new TeamError('already_member');
        }
        const [actor] = existing
          ? await tx
              .update(actors)
              .set({ email: account.email, updatedAt: now })
              .where(and(eq(actors.companyId, companyId), eq(actors.id, existing.id)))
              .returning({ id: actors.id })
          : await tx
              .insert(actors)
              .values({ companyId, authTenantId: account.tenant, uid: account.uid, email: account.email, displayName: account.name })
              .returning({ id: actors.id });
        const actorId = actor!.id;

        const [membership] = await tx
          .insert(memberships)
          .values({ companyId, actorId, role: row.role, invitationId })
          .returning({ id: memberships.id, role: memberships.role, status: memberships.status });
        await tx
          .update(invitations)
          .set({ status: 'accepted', acceptedByActorId: actorId, acceptedAt: now, updatedAt: now })
          .where(and(eq(invitations.companyId, companyId), eq(invitations.id, invitationId)));
        await queue(actorId);
        await audit(tx, companyId, { kind: 'invitee', actorId }, 'invitation_accepted', invitationId, { role: row.role });
        return { membershipId: membership!.id, role: membership!.role, status: membership!.status, accepted: true };
      });
    },
  };
}

export type TeamService = ReturnType<typeof teamService>;
