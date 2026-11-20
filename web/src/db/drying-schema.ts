import { sql } from 'drizzle-orm';
import { bigint, foreignKey, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { actors, agreements, companies, jobs } from './schema';

// Typed view of the drying log and outcomes tables (migration 0020, S5b-10 slice 10A). The SQL file
// holds every check and trigger; this module only reads and writes those tables, inside withCompany
// or withOperator (./tenant.ts). It sits beside ./schema.ts to keep each file under the length limit,
// as ./ai-schema.ts does, and is not part of the relational `schema` object (no route uses relational
// queries); `dryingSchema` below lists its tables (tests/db/identity-tables.test.ts matches them to the
// database). The drying watch's column on job_coordination is in ./schema.ts.

const time = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
// Whole cents, at most a few billion, so a JavaScript number holds them exactly.
const cents = (name: string) => bigint(name, { mode: 'number' });

export const dryingReadingKinds = ['air', 'material', 'thermal'] as const;
export type DryingReadingKind = (typeof dryingReadingKinds)[number];
export const priceModes = ['range', 'single'] as const;
export type PriceMode = (typeof priceModes)[number];
export const closeLandings = ['inside', 'above', 'below'] as const;
export const roomCategories = ['1', '2', '3', 'mold'] as const;

// A drying-log entry: made on the phone with its own id; its raw fields never change and removing it is
// a void, set once. An air reading carries the server's air values. Decimals are strings.
export const dryingReadings = pgTable(
  'drying_readings',
  {
    id: uuid('id').notNull(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    jobId: uuid('job_id').notNull(),
    kind: text('kind', { enum: dryingReadingKinds }).notNull(),
    roomId: text('room_id'),
    roomLabel: text('room_label'),
    takenAt: time('taken_at').notNull(),
    receivedAt: time('received_at').notNull().defaultNow(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    gpp: integer('gpp'),
    dewPointF: integer('dew_point_f'),
    dewPointDepressionF: integer('dew_point_depression_f'),
    vaporPressureInhg: numeric('vapor_pressure_inhg'),
    enthalpyBtuLb: numeric('enthalpy_btu_lb'),
    requestDigest: text('request_digest').notNull(),
    createdByActorId: uuid('created_by_actor_id').notNull(),
    voidedByActorId: uuid('voided_by_actor_id'),
    voidedAt: time('voided_at'),
    voidChangeId: uuid('void_change_id'),
    voidDigest: text('void_digest'),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    foreignKey({ name: 'drying_readings_job_fkey', columns: [t.companyId, t.jobId], foreignColumns: [jobs.companyId, jobs.id] }),
    foreignKey({ name: 'drying_readings_created_by_fkey', columns: [t.companyId, t.createdByActorId], foreignColumns: [actors.companyId, actors.id] }),
    foreignKey({ name: 'drying_readings_voided_by_fkey', columns: [t.companyId, t.voidedByActorId], foreignColumns: [actors.companyId, actors.id] }),
    uniqueIndex('drying_readings_void_change')
      .on(t.companyId, t.voidChangeId)
      .where(sql`void_change_id IS NOT NULL`),
  ],
);

// A signed job's close, append-only: each correction is a new row with the next close revision, and the
// newest is the job's close. It keeps the comparison it was classified by.
export const jobCloses = pgTable(
  'job_closes',
  {
    id: uuid('id').notNull(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    jobId: uuid('job_id').notNull(),
    agreementId: uuid('agreement_id').notNull(),
    revision: integer('revision').notNull(),
    requestDigest: text('request_digest').notNull(),
    finalCents: cents('final_cents').notNull(),
    actualDays: integer('actual_days'),
    note: text('note').notNull().default(''),
    baselineAgreementId: uuid('baseline_agreement_id').notNull(),
    priceMode: text('price_mode', { enum: priceModes }).notNull(),
    baselineLowCents: cents('baseline_low_cents').notNull(),
    baselineHighCents: cents('baseline_high_cents'),
    landed: text('landed', { enum: closeLandings }).notNull(),
    closedByActorId: uuid('closed_by_actor_id').notNull(),
    closedAt: time('closed_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    unique('job_closes_revision_key').on(t.companyId, t.jobId, t.revision),
    foreignKey({ name: 'job_closes_job_fkey', columns: [t.companyId, t.jobId], foreignColumns: [jobs.companyId, jobs.id] }),
    foreignKey({
      name: 'job_closes_agreement_fkey',
      columns: [t.companyId, t.jobId, t.agreementId],
      foreignColumns: [agreements.companyId, agreements.jobId, agreements.id],
    }),
    foreignKey({
      name: 'job_closes_baseline_agreement_fkey',
      columns: [t.companyId, t.jobId, t.baselineAgreementId],
      foreignColumns: [agreements.companyId, agreements.jobId, agreements.id],
    }),
    foreignKey({ name: 'job_closes_closed_by_fkey', columns: [t.companyId, t.closedByActorId], foreignColumns: [actors.companyId, actors.id] }),
  ],
);

// One insert-only sample per signed agreement: the signed priced result after any approved named
// adjustment, multipliers and additions, in cents, and the figures accuracy compares by.
export const estimateHistory = pgTable(
  'estimate_history',
  {
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    jobId: uuid('job_id').notNull(),
    agreementId: uuid('agreement_id').notNull(),
    signedAt: time('signed_at').notNull(),
    priceMode: text('price_mode', { enum: priceModes }).notNull(),
    lowCents: cents('low_cents').notNull(),
    highCents: cents('high_cents'),
    laborMaterialLowCents: cents('labor_material_low_cents'),
    roomCategories: text('room_categories', { enum: roomCategories }).array(),
    plannedDays: integer('planned_days'),
    areaSf: numeric('area_sf'),
    recordedAt: time('recorded_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.jobId, t.agreementId] }),
    foreignKey({ name: 'estimate_history_job_fkey', columns: [t.companyId, t.jobId], foreignColumns: [jobs.companyId, jobs.id] }),
    foreignKey({
      name: 'estimate_history_agreement_fkey',
      columns: [t.companyId, t.jobId, t.agreementId],
      foreignColumns: [agreements.companyId, agreements.jobId, agreements.id],
    }),
  ],
);

export const dryingSchema = {
  dryingReadings,
  jobCloses,
  estimateHistory,
};
