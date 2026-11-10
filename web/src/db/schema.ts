import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

// Typed view of web/migrations. The SQL files are what the ledger applies and hold every check;
// this module only reads and writes those tables. Row-level security (0003) means the app's runtime
// role sees a company's rows only inside withCompany (./tenant.ts).

const createdAt = () => timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow();
const optionalTime = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const roles = ['owner', 'estimator', 'office'] as const;
export type Role = (typeof roles)[number];
export const companyStatuses = ['active', 'suspended', 'archived'] as const;
export const membershipStatuses = ['active', 'disabled'] as const;
export const invitationStatuses = ['pending', 'accepted', 'cancelled'] as const;
export const tenantKinds = ['company', 'operator'] as const;

export const migrationLedger = pgTable('migration_ledger', {
  id: text('id').primaryKey(),
  checksum: text('checksum').notNull(),
  appliedAt: timestamp('applied_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const authTenants = pgTable(
  'auth_tenants',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: tenantKinds }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique('auth_tenants_id_kind_key').on(t.id, t.kind)],
);

export const companies = pgTable(
  'companies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: createdAt(),
    name: text('name').notNull(),
    signInSlug: text('sign_in_slug').unique('companies_sign_in_slug_key'),
    status: text('status', { enum: companyStatuses }).notNull().default('active'),
    authTenantId: text('auth_tenant_id').unique('companies_auth_tenant_id_key'),
    authTenantKind: text('auth_tenant_kind', { enum: tenantKinds }).generatedAlwaysAs(sql`'company'`),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('companies_id_auth_tenant_id_key').on(t.id, t.authTenantId),
    foreignKey({
      name: 'companies_auth_tenant_fkey',
      columns: [t.authTenantId, t.authTenantKind],
      foreignColumns: [authTenants.id, authTenants.kind],
    }),
  ],
);

export const actors = pgTable(
  'actors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id'),
    authTenantId: text('auth_tenant_id').notNull(),
    uid: text('uid').notNull(),
    email: text('email').notNull(),
    displayName: text('display_name'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // 'operator' when the actor has no company, so it must sign in through an operator tenant.
    authTenantKind: text('auth_tenant_kind', { enum: tenantKinds }).generatedAlwaysAs(
      sql`CASE WHEN company_id IS NULL THEN 'operator' ELSE 'company' END`,
    ),
  },
  (t) => [
    unique('actors_tenant_uid_key').on(t.authTenantId, t.uid),
    unique('actors_company_id_id_key').on(t.companyId, t.id),
    unique('actors_id_auth_tenant_kind_key').on(t.id, t.authTenantKind),
    foreignKey({
      name: 'actors_company_tenant_fkey',
      columns: [t.companyId, t.authTenantId],
      foreignColumns: [companies.id, companies.authTenantId],
    }),
    foreignKey({
      name: 'actors_tenant_kind_fkey',
      columns: [t.authTenantId, t.authTenantKind],
      foreignColumns: [authTenants.id, authTenants.kind],
    }),
  ],
);

export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    email: text('email').notNull(),
    role: text('role', { enum: roles }).notNull(),
    status: text('status', { enum: invitationStatuses }).notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdByActorId: uuid('created_by_actor_id'),
    createdByOperatorId: uuid('created_by_operator_id').references((): AnyPgColumn => platformAdmins.actorId),
    acceptedByActorId: uuid('accepted_by_actor_id'),
    acceptedAt: optionalTime('accepted_at'),
    cancelledAt: optionalTime('cancelled_at'),
    clearedAt: optionalTime('cleared_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('invitations_company_id_id_key').on(t.companyId, t.id),
    foreignKey({
      name: 'invitations_created_by_fkey',
      columns: [t.companyId, t.createdByActorId],
      foreignColumns: [actors.companyId, actors.id],
    }),
    foreignKey({
      name: 'invitations_accepted_by_fkey',
      columns: [t.companyId, t.acceptedByActorId],
      foreignColumns: [actors.companyId, actors.id],
    }),
    uniqueIndex('invitations_one_pending_per_email')
      .on(t.companyId, t.email)
      .where(sql`status = 'pending'`),
  ],
);

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    actorId: uuid('actor_id').notNull(),
    role: text('role', { enum: roles }).notNull(),
    status: text('status', { enum: membershipStatuses }).notNull().default('active'),
    invitationId: uuid('invitation_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('memberships_company_id_id_key').on(t.companyId, t.id),
    unique('memberships_invitation_id_key').on(t.invitationId),
    foreignKey({
      name: 'memberships_actor_fkey',
      columns: [t.companyId, t.actorId],
      foreignColumns: [actors.companyId, actors.id],
    }),
    foreignKey({
      name: 'memberships_invitation_fkey',
      columns: [t.companyId, t.invitationId],
      foreignColumns: [invitations.companyId, invitations.id],
    }),
    uniqueIndex('memberships_one_active_owner')
      .on(t.companyId)
      .where(sql`role = 'owner' AND status = 'active'`),
    uniqueIndex('memberships_one_active_per_actor')
      .on(t.actorId)
      .where(sql`status = 'active'`),
  ],
);

// Platform operators: actors with no company, in an operator tenant.
export const platformAdmins = pgTable(
  'platform_admins',
  {
    actorId: uuid('actor_id').primaryKey(),
    actorKind: text('actor_kind', { enum: tenantKinds }).generatedAlwaysAs(sql`'operator'`),
    status: text('status', { enum: membershipStatuses }).notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'platform_admins_actor_fkey',
      columns: [t.actorId, t.actorKind],
      foreignColumns: [actors.id, actors.authTenantKind],
    }),
  ],
);

// actorId is a member of companyId; operatorActorId is a platform operator; both empty for system
// events.
export const auditEvents = pgTable(
  'audit_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    companyId: uuid('company_id').references(() => companies.id),
    actorId: uuid('actor_id'),
    operatorActorId: uuid('operator_actor_id').references(() => platformAdmins.actorId),
    action: text('action').notNull(),
    target: text('target'),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'audit_events_actor_fkey',
      columns: [t.companyId, t.actorId],
      foreignColumns: [actors.companyId, actors.id],
    }),
  ],
);

export const companyFeatureFlags = pgTable(
  'company_feature_flags',
  {
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    flag: text('flag').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    updatedByOperatorId: uuid('updated_by_operator_id').references(() => platformAdmins.actorId),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.flag] })],
);

export const accessProjectionOutbox = pgTable(
  'access_projection_outbox',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    actorId: uuid('actor_id').notNull(),
    createdAt: createdAt(),
    availableAt: timestamp('available_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    processedAt: optionalTime('processed_at'),
    lastErrorCode: text('last_error_code'),
  },
  (t) => [
    foreignKey({
      name: 'access_projection_outbox_actor_fkey',
      columns: [t.companyId, t.actorId],
      foreignColumns: [actors.companyId, actors.id],
    }),
  ],
);

export const schema = {
  migrationLedger,
  authTenants,
  companies,
  actors,
  invitations,
  memberships,
  platformAdmins,
  auditEvents,
  companyFeatureFlags,
  accessProjectionOutbox,
};
