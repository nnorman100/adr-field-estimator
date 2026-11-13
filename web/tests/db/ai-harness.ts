import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type postgres from 'postgres';
import type { CompanyTransaction } from '@/db/tenant';
import { digestOf } from './job-harness';

// Shared by the migration 0012 tests (S7-3): ledger rows, AI results, live sessions, usage, turns and
// voice notes, seeded as the table owner or inserted through withCompany the way S7-4 to S7-15's
// routes will.

export const MICRO = 1_000_000;

export type LedgerInput = {
  company: string;
  actor: string;
  callId?: string;
  feature?: string;
  model?: string;
  reserved?: number;
  // UTC day as YYYY-MM-DD; the month is its first day.
  day?: string;
  month?: string;
};

const today = () => new Date().toISOString().slice(0, 10);
const monthOf = (day: string) => `${day.slice(0, 7)}-01`;

export const insertLedger = (tx: CompanyTransaction, l: LedgerInput) => {
  const day = l.day ?? today();
  return tx.execute(sql`
    INSERT INTO ai_ledger (company_id, call_id, actor_id, feature, model, reserved_micro_usd, utc_day, utc_month)
    VALUES (${l.company}::uuid, ${l.callId ?? randomUUID()}::uuid, ${l.actor}::uuid, ${l.feature ?? 'summary_draft'}, ${l.model ?? 'gemini-3.8-flash'},
            ${l.reserved ?? 20_000}, ${day}::date, ${l.month ?? monthOf(day)}::date)
    RETURNING id::text, call_id::text, state
  `) as unknown as Promise<{ id: string; call_id: string; state: string }[]>;
};

export async function seedLedger(
  admin: postgres.Sql,
  l: LedgerInput,
): Promise<{ id: string; callId: string }> {
  const day = l.day ?? today();
  const callId = l.callId ?? randomUUID();
  const [row] = await admin<{ id: string }[]>`
    INSERT INTO ai_ledger (company_id, call_id, actor_id, feature, model, reserved_micro_usd, utc_day, utc_month)
    VALUES (${l.company}, ${callId}, ${l.actor}, ${l.feature ?? 'summary_draft'}, ${l.model ?? 'gemini-3.8-flash'}, ${l.reserved ?? 20_000},
            ${day}, ${l.month ?? monthOf(day)})
    RETURNING id::text
  `;
  return { id: row!.id, callId };
}

export type ResultInput = {
  company: string;
  job: string;
  actor: string;
  callId: string;
  draft?: string;
  feature?: string;
  model?: string;
  output?: Record<string, unknown>;
  verdict?: string;
};

export const insertResult = (tx: CompanyTransaction, r: ResultInput) =>
  tx.execute(sql`
    INSERT INTO ai_results (company_id, call_id, job_id, draft_id, actor_id, feature, input_digest, prompt_version, model, output, verdict_category)
    VALUES (${r.company}::uuid, ${r.callId}::uuid, ${r.job}::uuid, ${r.draft ?? randomUUID()}::uuid, ${r.actor}::uuid, ${r.feature ?? 'summary_draft'},
            ${digestOf(`input ${r.callId}`)}, ${digestOf('prompt text')}, ${r.model ?? 'gemini-3.8-flash'},
            ${JSON.stringify(r.output ?? { summary: 'Water stain on the hallway ceiling.' })}::text::jsonb, ${r.verdict ?? 'passed'})
    RETURNING id::text, status
  `) as unknown as Promise<{ id: string; status: string }[]>;

export type SessionInput = {
  id: string;
  company: string;
  job: string;
  draft: string;
  actor: string;
  reservation: string;
  voice?: string;
  language?: string;
  capability?: string;
  fingerprint?: string;
  // Seconds from now the lease ends; negative for one already lapsed.
  leaseIn?: number;
};

export const newSession = (
  company: string,
  job: string,
  actor: string,
  reservation: string,
  extra: Partial<SessionInput> = {},
): SessionInput => ({
  id: randomUUID(),
  company,
  job,
  draft: randomUUID(),
  actor,
  reservation,
  ...extra,
});

export const insertSession = (tx: CompanyTransaction, s: SessionInput) =>
  tx.execute(sql`
    INSERT INTO live_sessions (id, company_id, job_id, draft_id, actor_id, voice, language, lease_expires_at, capability_sha256, signed_in_at, scope_fingerprint, reservation_id)
    VALUES (${s.id}::uuid, ${s.company}::uuid, ${s.job}::uuid, ${s.draft}::uuid, ${s.actor}::uuid, ${s.voice ?? 'Charon'}, ${s.language ?? 'en-US'},
            now() + make_interval(secs => ${s.leaseIn ?? 60}), ${s.capability ?? digestOf(`capability ${s.id}`)}, now() - interval '1 hour',
            ${s.fingerprint ?? digestOf(`scope ${s.draft}`)}, ${s.reservation}::uuid)
    RETURNING id::text, epoch, handle_counter, next_turn_seq, restarts
  `) as unknown as Promise<
    { id: string; epoch: number; handle_counter: string; next_turn_seq: number; restarts: number }[]
  >;

export async function seedSession(admin: postgres.Sql, s: SessionInput): Promise<SessionInput> {
  await admin`
    INSERT INTO live_sessions (id, company_id, job_id, draft_id, actor_id, voice, language, lease_expires_at, capability_sha256, signed_in_at, scope_fingerprint, reservation_id)
    VALUES (${s.id}, ${s.company}, ${s.job}, ${s.draft}, ${s.actor}, ${s.voice ?? 'Charon'}, ${s.language ?? 'en-US'},
            now() + make_interval(secs => ${s.leaseIn ?? 60}), ${s.capability ?? digestOf(`capability ${s.id}`)}, now() - interval '1 hour',
            ${s.fingerprint ?? digestOf(`scope ${s.draft}`)}, ${s.reservation})
  `;
  return s;
}

// The end path's session half (docs/plans/S7.md section 4.12): mark it ended, release the lease, clear
// the handle and bump the epoch, only while it is still open.
export const endSession = (
  tx: CompanyTransaction,
  company: string,
  id: string,
  reason = 'finish',
) =>
  tx.execute(sql`
    UPDATE live_sessions SET ended_at = now(), end_reason = ${reason}, lease_expires_at = NULL, resumption_handle = NULL, epoch = epoch + 1
    WHERE company_id = ${company}::uuid AND id = ${id}::uuid AND ended_at IS NULL
    RETURNING id::text, epoch
  `) as unknown as Promise<{ id: string; epoch: number }[]>;

export type TurnInput = {
  company: string;
  session: string;
  seq: number;
  speaker?: string;
  text?: string;
  verdict?: string;
  category?: string;
  epoch?: number;
  connection?: number;
};

export const insertTurn = (tx: CompanyTransaction, t: TurnInput) =>
  tx.execute(sql`
    INSERT INTO live_turns (company_id, session_id, seq, epoch, connection, speaker, text, verdict, verdict_category)
    VALUES (${t.company}::uuid, ${t.session}::uuid, ${t.seq}, ${t.epoch ?? 1}, ${t.connection ?? 1}, ${t.speaker ?? 'technician'},
            ${t.text ?? 'Wet drywall in the hallway, about two feet up.'}, ${t.verdict ?? 'passed'}, ${t.category ?? 'passed'})
    RETURNING seq
  `) as unknown as Promise<{ seq: number }[]>;

// A usage post: the first post of a connection inserts it, a later one raises the maximum and never
// lowers it (the route's upsert, docs/plans/S7.md section 4.6).
export const postUsage = (
  tx: CompanyTransaction,
  company: string,
  session: string,
  epoch: number,
  connection: number,
  cumulative: number,
) =>
  tx.execute(sql`
    INSERT INTO live_usage (company_id, session_id, epoch, connection, max_cumulative_micro_usd)
    VALUES (${company}::uuid, ${session}::uuid, ${epoch}, ${connection}, ${cumulative})
    ON CONFLICT (company_id, session_id, epoch, connection) DO UPDATE
      SET max_cumulative_micro_usd = GREATEST(live_usage.max_cumulative_micro_usd, EXCLUDED.max_cumulative_micro_usd)
      WHERE live_usage.closed = false
    RETURNING max_cumulative_micro_usd::text AS max, closed
  `) as unknown as Promise<{ max: string; closed: boolean }[]>;

export type VoiceNoteInput = {
  id: string;
  company: string;
  job: string;
  actor: string;
  draft?: string;
  duration?: number;
  sha?: string;
  transcript?: string;
};

export const newVoiceNote = (
  company: string,
  job: string,
  actor: string,
  extra: Partial<VoiceNoteInput> = {},
): VoiceNoteInput => ({
  id: randomUUID(),
  company,
  job,
  actor,
  ...extra,
});

export const insertVoiceNote = (tx: CompanyTransaction, v: VoiceNoteInput) =>
  tx.execute(sql`
    INSERT INTO voice_notes (id, company_id, job_id, draft_id, actor_id, duration_ms, audio_sha256, transcript)
    VALUES (${v.id}::uuid, ${v.company}::uuid, ${v.job}::uuid, ${v.draft ?? randomUUID()}::uuid, ${v.actor}::uuid, ${v.duration ?? 42_000},
            ${v.sha ?? digestOf(`audio ${v.id}`)}, ${v.transcript ?? 'Moisture meter reads 28 percent at the base of the wall.'})
    RETURNING id::text, state
  `) as unknown as Promise<{ id: string; state: string }[]>;
