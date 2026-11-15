import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
  date,
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
// Stored bytes (a snapshot, a proposal, the signed documents); the driver returns a Buffer.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

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
    // The profile the four documents print (0010). Empty means not set; the runtime changes these
    // columns of its own company, and only the owner's route does (profile_manage).
    profileAddress: text('profile_address').notNull().default(''),
    profilePhone: text('profile_phone').notNull().default(''),
    profileEmail: text('profile_email').notNull().default(''),
    profileLicense: text('profile_license').notNull().default(''),
    profileSignoff: text('profile_signoff').notNull().default(''),
    // The letterhead fields and the document settings (0013, S5a-4b), under the same rule. The
    // settings are one jsonb object whose shape the Zod schema in src/lib/profile/settings.ts checks
    // at write and at read; '{}' means every setting at its neutral default.
    profileEmergencyPhone: text('profile_emergency_phone').notNull().default(''),
    profileFax: text('profile_fax').notNull().default(''),
    profileWebsite: text('profile_website').notNull().default(''),
    profileTagline: text('profile_tagline').notNull().default(''),
    profileMailingAddress: text('profile_mailing_address').notNull().default(''),
    profileDocuments: jsonb('profile_documents').$type<Record<string, unknown>>().notNull().default({}),
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

export const priceTableSources = ['blank', 'import', 'restore'] as const;
export type PriceTableSource = (typeof priceTableSources)[number];

// Every published price table, whole and never changed: the runtime has SELECT and INSERT only
// (0009). A company's current prices are its highest sequence. content is the parsed table
// (web/src/engine/table.ts); the hash and the engine version sit beside it.
export const priceTableVersions = pgTable(
  'price_table_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    sequence: integer('sequence').notNull(),
    content: jsonb('content').$type<Record<string, unknown>>().notNull(),
    contentHash: text('content_hash').notNull(),
    engineVersion: text('engine_version').notNull(),
    reason: text('reason').notNull(),
    source: text('source', { enum: priceTableSources }).notNull(),
    publishedByActorId: uuid('published_by_actor_id').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    publishKey: text('publish_key').notNull(),
  },
  (t) => [
    unique('price_table_versions_company_id_id_key').on(t.companyId, t.id),
    unique('price_table_versions_company_sequence_key').on(t.companyId, t.sequence),
    unique('price_table_versions_company_publish_key_key').on(t.companyId, t.publishKey),
    foreignKey({
      name: 'price_table_versions_published_by_fkey',
      columns: [t.companyId, t.publishedByActorId],
      foreignColumns: [actors.companyId, actors.id],
    }),
  ],
);

// The one table a company's owner is editing, one row per company (not a job draft). revision rises
// by one with every change; baseSequence is the version it started from or was last published as.
export const priceTableWorkingCopies = pgTable(
  'price_table_working_copies',
  {
    companyId: uuid('company_id')
      .primaryKey()
      .references(() => companies.id),
    baseSequence: integer('base_sequence'),
    content: jsonb('content').$type<Record<string, unknown>>().notNull(),
    revision: integer('revision').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'price_table_working_copies_base_fkey',
      columns: [t.companyId, t.baseSequence],
      foreignColumns: [priceTableVersions.companyId, priceTableVersions.sequence],
    }),
  ],
);

export const jobStatuses = ['draft', 'submitted', 'signed', 'archived'] as const;
export type JobStatus = (typeof jobStatuses)[number];
export const evidenceKinds = ['photo', 'original', 'signature'] as const;
export type EvidenceKind = (typeof evidenceKinds)[number];

// One row per job (0010), keyed by company and a client-made id so a retried create finds its row.
// revision rises by exactly one with every change; lastChangeId is the client's id for the latest
// change, so a retry is not a conflict; requestDigest is the SHA-256 of the create request.
export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').notNull(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    createdByActorId: uuid('created_by_actor_id').notNull(),
    fieldOwnerActorId: uuid('field_owner_actor_id'),
    status: text('status', { enum: jobStatuses }).notNull().default('draft'),
    currentDraftId: uuid('current_draft_id').notNull(),
    propertyAddress: text('property_address').notNull().default(''),
    archivedAt: optionalTime('archived_at'),
    archivedByActorId: uuid('archived_by_actor_id'),
    revision: integer('revision').notNull().default(1),
    lastChangeId: uuid('last_change_id'),
    requestDigest: text('request_digest').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    unique('jobs_company_current_draft_key').on(t.companyId, t.currentDraftId),
    foreignKey({
      name: 'jobs_created_by_fkey',
      columns: [t.companyId, t.createdByActorId],
      foreignColumns: [actors.companyId, actors.id],
    }),
    foreignKey({
      name: 'jobs_field_owner_fkey',
      columns: [t.companyId, t.fieldOwnerActorId],
      foreignColumns: [actors.companyId, actors.id],
    }),
    foreignKey({
      name: 'jobs_archived_by_fkey',
      columns: [t.companyId, t.archivedByActorId],
      foreignColumns: [actors.companyId, actors.id],
    }),
  ],
);

// At most one row per job; personal data (docs/DATA.md).
export const jobCustomers = pgTable(
  'job_customers',
  {
    companyId: uuid('company_id').notNull(),
    jobId: uuid('job_id').notNull(),
    name: text('name').notNull().default(''),
    phone: text('phone').notNull().default(''),
    email: text('email').notNull().default(''),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.jobId] }),
    foreignKey({
      name: 'job_customers_job_fkey',
      columns: [t.companyId, t.jobId],
      foreignColumns: [jobs.companyId, jobs.id],
    }),
  ],
);

// At most one row per job; personal data. dateOfLoss is a calendar date as 'YYYY-MM-DD', empty when
// not known.
export const jobClaims = pgTable(
  'job_claims',
  {
    companyId: uuid('company_id').notNull(),
    jobId: uuid('job_id').notNull(),
    carrier: text('carrier').notNull().default(''),
    claimNumber: text('claim_number').notNull().default(''),
    policyNumber: text('policy_number').notNull().default(''),
    dateOfLoss: date('date_of_loss', { mode: 'string' }),
    lossCause: text('loss_cause').notNull().default(''),
    adjusterName: text('adjuster_name').notNull().default(''),
    adjusterEmail: text('adjuster_email').notNull().default(''),
    adjusterPhone: text('adjuster_phone').notNull().default(''),
    deductible: text('deductible').notNull().default(''),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.jobId] }),
    foreignKey({
      name: 'job_claims_job_fkey',
      columns: [t.companyId, t.jobId],
      foreignColumns: [jobs.companyId, jobs.id],
    }),
  ],
);

// The registry of stored bytes in the evidence bucket, inserted once and never changed: the runtime
// has SELECT and INSERT only (0010). objectName sits under the row's own company and job.
export const evidenceObjects = pgTable(
  'evidence_objects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    jobId: uuid('job_id').notNull(),
    objectId: uuid('object_id').notNull(),
    kind: text('kind', { enum: evidenceKinds }).notNull(),
    objectName: text('object_name').notNull(),
    generation: bigint('generation', { mode: 'bigint' }).notNull(),
    sha256: text('sha256').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    contentType: text('content_type').notNull(),
    createdByActorId: uuid('created_by_actor_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('evidence_objects_company_id_id_key').on(t.companyId, t.id),
    unique('evidence_objects_job_object_kind_key').on(t.companyId, t.jobId, t.objectId, t.kind),
    unique('evidence_objects_company_object_name_key').on(t.companyId, t.objectName),
    foreignKey({
      name: 'evidence_objects_job_fkey',
      columns: [t.companyId, t.jobId],
      foreignColumns: [jobs.companyId, jobs.id],
    }),
    foreignKey({
      name: 'evidence_objects_created_by_fkey',
      columns: [t.companyId, t.createdByActorId],
      foreignColumns: [actors.companyId, actors.id],
    }),
  ],
);

export const submissionKinds = ['original', 'change_order'] as const;
export type SubmissionKind = (typeof submissionKinds)[number];
export const submissionStatuses = ['pending', 'committed', 'aborted'] as const;
export type SubmissionStatus = (typeof submissionStatuses)[number];
export const submissionMarkerStates = ['pending', 'done'] as const;
export const pinReasons = ['first_price', 'owner_reprice'] as const;
export type PinReason = (typeof pinReasons)[number];
export const signerKinds = ['device', 'link'] as const;
export type SignerKind = (typeof signerKinds)[number];

// Submit's rows (0011), made `pending` first, then moved once to `committed` (with the canonical
// snapshot and its SHA-256) or `aborted`. A trigger freezes every column of a decided row except
// markerState, which goes from pending to done once; the runtime's UPDATE covers status,
// snapshotBytes, snapshotSha256 and markerState only. decidedAt is set by the trigger.
export const jobSubmissions = pgTable(
  'job_submissions',
  {
    id: uuid('id').notNull(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    jobId: uuid('job_id').notNull(),
    draftId: uuid('draft_id').notNull(),
    epoch: uuid('epoch').notNull(),
    kind: text('kind', { enum: submissionKinds }).notNull(),
    parentAgreementId: uuid('parent_agreement_id'),
    status: text('status', { enum: submissionStatuses }).notNull().default('pending'),
    requestDigest: text('request_digest').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    snapshotBytes: bytea('snapshot_bytes'),
    snapshotSha256: text('snapshot_sha256'),
    markerState: text('marker_state', { enum: submissionMarkerStates }).notNull().default('pending'),
    createdByActorId: uuid('created_by_actor_id').notNull(),
    createdAt: createdAt(),
    decidedAt: optionalTime('decided_at'),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    unique('job_submissions_company_draft_epoch_key').on(t.companyId, t.draftId, t.epoch),
    unique('job_submissions_company_job_id_key').on(t.companyId, t.jobId, t.id),
    uniqueIndex('job_submissions_one_committed_per_draft')
      .on(t.companyId, t.draftId)
      .where(sql`status = 'committed'`),
    foreignKey({
      name: 'job_submissions_job_fkey',
      columns: [t.companyId, t.jobId],
      foreignColumns: [jobs.companyId, jobs.id],
    }),
    foreignKey({
      name: 'job_submissions_created_by_fkey',
      columns: [t.companyId, t.createdByActorId],
      foreignColumns: [actors.companyId, actors.id],
    }),
    // job_submissions_parent_fkey (company, job and parent agreement to agreements) is in the migration
    // only: naming it here would make this view and agreements refer to each other.
  ],
);

// Which published price version a job is priced from (0011): sequence 1 is the first price, each
// later pin the owner's reprice; the current pin is the highest sequence. Insert-only.
export const jobPricePins = pgTable(
  'job_price_pins',
  {
    id: uuid('id').notNull().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    jobId: uuid('job_id').notNull(),
    sequence: integer('sequence').notNull(),
    versionId: uuid('version_id').notNull(),
    reason: text('reason', { enum: pinReasons }).notNull(),
    pinnedByActorId: uuid('pinned_by_actor_id').notNull(),
    pinnedAt: timestamp('pinned_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    unique('job_price_pins_company_job_sequence_key').on(t.companyId, t.jobId, t.sequence),
    unique('job_price_pins_company_job_id_key').on(t.companyId, t.jobId, t.id),
    foreignKey({
      name: 'job_price_pins_job_fkey',
      columns: [t.companyId, t.jobId],
      foreignColumns: [jobs.companyId, jobs.id],
    }),
    foreignKey({
      name: 'job_price_pins_version_fkey',
      columns: [t.companyId, t.versionId],
      foreignColumns: [priceTableVersions.companyId, priceTableVersions.id],
    }),
    foreignKey({
      name: 'job_price_pins_pinned_by_fkey',
      columns: [t.companyId, t.pinnedByActorId],
      foreignColumns: [actors.companyId, actors.id],
    }),
  ],
);

// One priced estimate per committed submission and pin (0011). Insert-only. pricedResult is the
// engine's output; proposalSha256 is the SHA-256 of proposalBytes (checked in the database).
export const jobEstimates = pgTable(
  'job_estimates',
  {
    id: uuid('id').notNull().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    jobId: uuid('job_id').notNull(),
    submissionId: uuid('submission_id').notNull(),
    pinId: uuid('pin_id').notNull(),
    tableHash: text('table_hash').notNull(),
    engineVersion: text('engine_version').notNull(),
    pricedResult: jsonb('priced_result').$type<Record<string, unknown>>().notNull(),
    proposalBytes: bytea('proposal_bytes').notNull(),
    proposalSha256: text('proposal_sha256').notNull(),
    createdByActorId: uuid('created_by_actor_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    unique('job_estimates_company_job_id_key').on(t.companyId, t.jobId, t.id),
    unique('job_estimates_company_submission_pin_key').on(t.companyId, t.submissionId, t.pinId),
    foreignKey({
      name: 'job_estimates_submission_fkey',
      columns: [t.companyId, t.jobId, t.submissionId],
      foreignColumns: [jobSubmissions.companyId, jobSubmissions.jobId, jobSubmissions.id],
    }),
    foreignKey({
      name: 'job_estimates_pin_fkey',
      columns: [t.companyId, t.jobId, t.pinId],
      foreignColumns: [jobPricePins.companyId, jobPricePins.jobId, jobPricePins.id],
    }),
    foreignKey({
      name: 'job_estimates_created_by_fkey',
      columns: [t.companyId, t.createdByActorId],
      foreignColumns: [actors.companyId, actors.id],
    }),
  ],
);

// The signed record (0011), insert-only, one original per job. It restates its estimate (a trigger
// checks it) and holds the documents as signed; a signed job is shown from this row alone.
export const agreements = pgTable(
  'agreements',
  {
    id: uuid('id').notNull(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    jobId: uuid('job_id').notNull(),
    submissionId: uuid('submission_id').notNull(),
    estimateId: uuid('estimate_id').notNull(),
    kind: text('kind', { enum: submissionKinds }).notNull(),
    parentAgreementId: uuid('parent_agreement_id'),
    signerKind: text('signer_kind', { enum: signerKinds }).notNull(),
    signerName: text('signer_name').notNull(),
    signatureEvidenceId: uuid('signature_evidence_id').notNull(),
    proposalSha256: text('proposal_sha256').notNull(),
    pricedResult: jsonb('priced_result').$type<Record<string, unknown>>().notNull(),
    versionId: uuid('version_id').notNull(),
    contentHash: text('content_hash').notNull(),
    engineVersion: text('engine_version').notNull(),
    documentsBytes: bytea('documents_bytes').notNull(),
    requestDigest: text('request_digest').notNull(),
    createdByActorId: uuid('created_by_actor_id').notNull(),
    signedAt: timestamp('signed_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    // The signing link it was signed through (0014): set exactly when signerKind is 'link'.
    signingLinkId: uuid('signing_link_id'),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    unique('agreements_company_job_id_key').on(t.companyId, t.jobId, t.id),
    unique('agreements_company_submission_key').on(t.companyId, t.submissionId),
    unique('agreements_company_estimate_key').on(t.companyId, t.estimateId),
    unique('agreements_company_signature_key').on(t.companyId, t.signatureEvidenceId),
    uniqueIndex('agreements_one_original_per_job')
      .on(t.companyId, t.jobId)
      .where(sql`kind = 'original'`),
    foreignKey({
      name: 'agreements_job_fkey',
      columns: [t.companyId, t.jobId],
      foreignColumns: [jobs.companyId, jobs.id],
    }),
    foreignKey({
      name: 'agreements_submission_fkey',
      columns: [t.companyId, t.jobId, t.submissionId],
      foreignColumns: [jobSubmissions.companyId, jobSubmissions.jobId, jobSubmissions.id],
    }),
    foreignKey({
      name: 'agreements_estimate_fkey',
      columns: [t.companyId, t.jobId, t.estimateId],
      foreignColumns: [jobEstimates.companyId, jobEstimates.jobId, jobEstimates.id],
    }),
    foreignKey({
      name: 'agreements_parent_fkey',
      columns: [t.companyId, t.jobId, t.parentAgreementId],
      foreignColumns: [t.companyId, t.jobId, t.id],
    }),
    foreignKey({
      name: 'agreements_signature_fkey',
      columns: [t.companyId, t.signatureEvidenceId],
      foreignColumns: [evidenceObjects.companyId, evidenceObjects.id],
    }),
    foreignKey({
      name: 'agreements_version_fkey',
      columns: [t.companyId, t.versionId],
      foreignColumns: [priceTableVersions.companyId, priceTableVersions.id],
    }),
    foreignKey({
      name: 'agreements_created_by_fkey',
      columns: [t.companyId, t.createdByActorId],
      foreignColumns: [actors.companyId, actors.id],
    }),
  ],
);

export const signingLinkStatuses = ['pending', 'used', 'revoked', 'voided'] as const;
export const documentLinkStatuses = ['active', 'revoked'] as const;
export const documentSets = ['homeowner', 'adjuster'] as const;

// A homeowner signing link (0014): the token's SHA-256 only, for one estimate of one job. Made
// pending, it ends once (used, revoked or voided); a trigger holds which columns may change.
export const signingLinks = pgTable(
  'signing_links',
  {
    id: uuid('id').notNull(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    jobId: uuid('job_id').notNull(),
    estimateId: uuid('estimate_id').notNull(),
    tokenSha256: text('token_sha256').notNull(),
    status: text('status', { enum: signingLinkStatuses }).notNull().default('pending'),
    requestDigest: text('request_digest').notNull(),
    createdByActorId: uuid('created_by_actor_id').notNull(),
    createdAt: createdAt(),
    tokenIssuedAt: timestamp('token_issued_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    endedAt: optionalTime('ended_at'),
    endedByActorId: uuid('ended_by_actor_id'),
    agreementId: uuid('agreement_id'),
    usedAt: optionalTime('used_at'),
    signAttempts: integer('sign_attempts').notNull().default(0),
    readWindowStart: timestamp('read_window_start', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    readCount: integer('read_count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.id] }), unique('signing_links_token_key').on(t.tokenSha256)],
);

// A read-only document link (0014) to one signed agreement's homeowner or adjuster set.
export const documentLinks = pgTable(
  'document_links',
  {
    id: uuid('id').notNull(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    jobId: uuid('job_id').notNull(),
    agreementId: uuid('agreement_id').notNull(),
    documentSet: text('document_set', { enum: documentSets }).notNull(),
    tokenSha256: text('token_sha256').notNull(),
    status: text('status', { enum: documentLinkStatuses }).notNull().default('active'),
    requestDigest: text('request_digest').notNull(),
    createdByActorId: uuid('created_by_actor_id').notNull(),
    createdAt: createdAt(),
    tokenIssuedAt: timestamp('token_issued_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    endedAt: optionalTime('ended_at'),
    endedByActorId: uuid('ended_by_actor_id'),
    readWindowStart: timestamp('read_window_start', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    readCount: integer('read_count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.id] }), unique('document_links_token_key').on(t.tokenSha256)],
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
  priceTableVersions,
  priceTableWorkingCopies,
  jobs,
  jobCustomers,
  jobClaims,
  evidenceObjects,
  jobSubmissions,
  jobPricePins,
  jobEstimates,
  agreements,
  signingLinks,
  documentLinks,
};
