import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
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
} from 'drizzle-orm/pg-core';
import { actors, companies, jobs, platformAdmins } from './schema';

// Typed view of the AI and Live tables (migration 0012, S7-3, docs/plans/S7.md). The SQL file holds
// every check and trigger; this module only reads and writes those tables, inside withCompany or
// withOperator (./tenant.ts). It sits beside ./schema.ts to keep each file under the length limit, and
// is not part of the relational `schema` object (no route uses relational queries); `aiSchema` below
// lists its tables (tests/db/identity-tables.test.ts matches them to the database).

const time = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
// Whole micro-USD of Google's bill, at most 2^53 - 1 (a check), so a JavaScript number holds it exactly.
const microUsd = (name: string) => bigint(name, { mode: 'number' });

export const ledgerStates = ['reserved', 'settled', 'held'] as const;
export const resultStatuses = ['proposed', 'accepted', 'rejected'] as const;
export const turnSpeakers = ['technician', 'assistant', 'system'] as const;
export const turnVerdicts = ['passed', 'blocked', 'unscreened'] as const;
export const voiceNoteStates = ['transcribed', 'reviewed', 'rejected'] as const;

// A company's AI ceilings (the operator's) and default voice (the owner's). No row, or an empty
// column, means the code default (web/src/lib/ai/ceilings.ts).
export const companyAiSettings = pgTable(
  'company_ai_settings',
  {
    companyId: uuid('company_id')
      .primaryKey()
      .references(() => companies.id),
    dailyCeilingMicroUsd: microUsd('daily_ceiling_micro_usd'),
    monthlyCeilingMicroUsd: microUsd('monthly_ceiling_micro_usd'),
    ceilingsSetByOperatorId: uuid('ceilings_set_by_operator_id').references(
      () => platformAdmins.actorId,
    ),
    ceilingsSetAt: time('ceilings_set_at'),
    defaultVoice: text('default_voice'),
    defaultVoiceSetByActorId: uuid('default_voice_set_by_actor_id'),
    defaultVoiceSetAt: time('default_voice_set_at'),
  },
  (t) => [
    foreignKey({
      name: 'company_ai_settings_default_voice_set_by_fkey',
      columns: [t.companyId, t.defaultVoiceSetByActorId],
      foreignColumns: [actors.companyId, actors.id],
    }),
  ],
);

// Every AI reservation and its settlement, one row per call id.
export const aiLedger = pgTable(
  'ai_ledger',
  {
    id: uuid('id').notNull().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    callId: uuid('call_id').notNull(),
    actorId: uuid('actor_id').notNull(),
    feature: text('feature').notNull(),
    model: text('model').notNull(),
    reservedMicroUsd: microUsd('reserved_micro_usd').notNull(),
    settledMicroUsd: microUsd('settled_micro_usd'),
    state: text('state', { enum: ledgerStates }).notNull().default('reserved'),
    utcDay: date('utc_day', { mode: 'string' }).notNull(),
    utcMonth: date('utc_month', { mode: 'string' }).notNull(),
    createdAt: time('created_at').notNull().defaultNow(),
    settledAt: time('settled_at'),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    unique('ai_ledger_company_call_key').on(t.companyId, t.callId),
    foreignKey({
      name: 'ai_ledger_actor_fkey',
      columns: [t.companyId, t.actorId],
      foreignColumns: [actors.companyId, actors.id],
    }),
  ],
);

// The AI proposals: one per call, decided once by a person.
export const aiResults = pgTable(
  'ai_results',
  {
    id: uuid('id').notNull().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    callId: uuid('call_id').notNull(),
    jobId: uuid('job_id').notNull(),
    draftId: uuid('draft_id').notNull(),
    actorId: uuid('actor_id').notNull(),
    feature: text('feature').notNull(),
    inputDigest: text('input_digest').notNull(),
    promptVersion: text('prompt_version').notNull(),
    model: text('model').notNull(),
    output: jsonb('output').$type<Record<string, unknown>>().notNull(),
    verdictCategory: text('verdict_category').notNull(),
    status: text('status', { enum: resultStatuses }).notNull().default('proposed'),
    decidedByActorId: uuid('decided_by_actor_id'),
    decidedAt: time('decided_at'),
    createdAt: time('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    unique('ai_results_company_call_key').on(t.companyId, t.callId),
    foreignKey({
      name: 'ai_results_call_fkey',
      columns: [t.companyId, t.callId],
      foreignColumns: [aiLedger.companyId, aiLedger.callId],
    }),
    foreignKey({
      name: 'ai_results_job_fkey',
      columns: [t.companyId, t.jobId],
      foreignColumns: [jobs.companyId, jobs.id],
    }),
    foreignKey({
      name: 'ai_results_actor_fkey',
      columns: [t.companyId, t.actorId],
      foreignColumns: [actors.companyId, actors.id],
    }),
    foreignKey({
      name: 'ai_results_decided_by_fkey',
      columns: [t.companyId, t.decidedByActorId],
      foreignColumns: [actors.companyId, actors.id],
    }),
  ],
);

// One walkthrough's state outside the relay (docs/plans/S7.md section 4). resumptionHandle is
// server-only and never logged.
export const liveSessions = pgTable(
  'live_sessions',
  {
    id: uuid('id').notNull(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    jobId: uuid('job_id').notNull(),
    draftId: uuid('draft_id').notNull(),
    actorId: uuid('actor_id').notNull(),
    voice: text('voice').notNull(),
    language: text('language').notNull(),
    startedAt: time('started_at').notNull().defaultNow(),
    endedAt: time('ended_at'),
    endReason: text('end_reason'),
    epoch: integer('epoch').notNull().default(1),
    leaseExpiresAt: time('lease_expires_at'),
    capabilitySha256: text('capability_sha256').notNull(),
    resumptionHandle: text('resumption_handle'),
    handleCounter: bigint('handle_counter', { mode: 'number' }).notNull().default(0),
    coveredSeq: bigint('covered_seq', { mode: 'number' }).notNull().default(0),
    nextTurnSeq: integer('next_turn_seq').notNull().default(1),
    restarts: integer('restarts').notNull().default(0),
    signedInAt: time('signed_in_at').notNull(),
    scopeFingerprint: text('scope_fingerprint').notNull(),
    reservationId: uuid('reservation_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    unique('live_sessions_company_reservation_key').on(t.companyId, t.reservationId),
    uniqueIndex('live_sessions_one_open_per_person')
      .on(t.companyId, t.actorId)
      .where(sql`ended_at IS NULL`),
    foreignKey({
      name: 'live_sessions_job_fkey',
      columns: [t.companyId, t.jobId],
      foreignColumns: [jobs.companyId, jobs.id],
    }),
    foreignKey({
      name: 'live_sessions_actor_fkey',
      columns: [t.companyId, t.actorId],
      foreignColumns: [actors.companyId, actors.id],
    }),
    foreignKey({
      name: 'live_sessions_reservation_fkey',
      columns: [t.companyId, t.reservationId],
      foreignColumns: [aiLedger.companyId, aiLedger.id],
    }),
  ],
);

// The highest cumulative cost posted per upstream connection; the session's cost is their sum.
export const liveUsage = pgTable(
  'live_usage',
  {
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    sessionId: uuid('session_id').notNull(),
    epoch: integer('epoch').notNull(),
    connection: integer('connection').notNull(),
    maxCumulativeMicroUsd: microUsd('max_cumulative_micro_usd').notNull(),
    lastPostedAt: time('last_posted_at').notNull().defaultNow(),
    closed: boolean('closed').notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.sessionId, t.epoch, t.connection] }),
    foreignKey({
      name: 'live_usage_session_fkey',
      columns: [t.companyId, t.sessionId],
      foreignColumns: [liveSessions.companyId, liveSessions.id],
    }),
  ],
);

// The screened transcript, insert-only. Only a passed turn keeps its words.
export const liveTurns = pgTable(
  'live_turns',
  {
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    sessionId: uuid('session_id').notNull(),
    seq: integer('seq').notNull(),
    epoch: integer('epoch').notNull(),
    connection: integer('connection').notNull(),
    speaker: text('speaker', { enum: turnSpeakers }).notNull(),
    text: text('text').notNull(),
    verdict: text('verdict', { enum: turnVerdicts }).notNull(),
    verdictCategory: text('verdict_category').notNull(),
    createdAt: time('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.sessionId, t.seq] }),
    foreignKey({
      name: 'live_turns_session_fkey',
      columns: [t.companyId, t.sessionId],
      foreignColumns: [liveSessions.companyId, liveSessions.id],
    }),
  ],
);

// A voice note's transcript; the audio is never stored (V8).
export const voiceNotes = pgTable(
  'voice_notes',
  {
    id: uuid('id').notNull(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    jobId: uuid('job_id').notNull(),
    draftId: uuid('draft_id').notNull(),
    actorId: uuid('actor_id').notNull(),
    durationMs: integer('duration_ms').notNull(),
    audioSha256: text('audio_sha256').notNull(),
    transcript: text('transcript').notNull(),
    state: text('state', { enum: voiceNoteStates }).notNull().default('transcribed'),
    reviewedByActorId: uuid('reviewed_by_actor_id'),
    reviewedAt: time('reviewed_at'),
    createdAt: time('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.id] }),
    foreignKey({
      name: 'voice_notes_job_fkey',
      columns: [t.companyId, t.jobId],
      foreignColumns: [jobs.companyId, jobs.id],
    }),
    foreignKey({
      name: 'voice_notes_actor_fkey',
      columns: [t.companyId, t.actorId],
      foreignColumns: [actors.companyId, actors.id],
    }),
    foreignKey({
      name: 'voice_notes_reviewed_by_fkey',
      columns: [t.companyId, t.reviewedByActorId],
      foreignColumns: [actors.companyId, actors.id],
    }),
  ],
);

// A person's own Live voice (V6 C).
export const memberVoiceSettings = pgTable(
  'member_voice_settings',
  {
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    actorId: uuid('actor_id').notNull(),
    voiceName: text('voice_name').notNull(),
    updatedAt: time('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.actorId] }),
    foreignKey({
      name: 'member_voice_settings_actor_fkey',
      columns: [t.companyId, t.actorId],
      foreignColumns: [actors.companyId, actors.id],
    }),
  ],
);

export const aiSchema = {
  companyAiSettings,
  aiLedger,
  aiResults,
  liveSessions,
  liveUsage,
  liveTurns,
  voiceNotes,
  memberVoiceSettings,
};
