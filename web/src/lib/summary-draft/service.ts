import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { withCompany, type CompanyTransaction, type Database } from '@/db/tenant';
import { capabilitiesFor } from '@/lib/access';
import { aiRefusal, type AiCallerContext, type AiOutcome, type AiRefusal, type AiRequest } from '@/lib/ai/call';
import type { JobIdentity } from '@/lib/ai/prompt-facts';
import type { Identity } from '@/lib/auth';
import type { FieldManifest } from '@/lib/field/canonical';
import { accessFlags } from '@/lib/flags';
import { jobAccess, JobError, type JobRow } from '@/lib/jobs/access';
import {
  summaryDraftRequest,
  summaryFacts,
  SummaryFactsError,
  type SummaryDraftOutput,
  type SummaryFacts,
} from './request';

// POST /api/jobs/{jobId}/ai/summary-draft (docs/plans/S7.md, step S7-6): an AI draft of the job's
// findings summary, as a proposal only. In this order:
//   1. the caller's membership as it is now (active, its role's capabilities), then the job under
//      its lock, in the caller's own company, seen by them (else 404), not archived (410), with the
//      `audit` capability (403), and its field work theirs (403): only the field owner writes the
//      draft, so only they could accept the proposal; and no Submit of its current draft started
//      (409). Submit starts and fences under the same lock, so the check sees it whole;
//   2. the company's `ai_summary` switch, exactly on; off answers the boundary's own refusal and
//      nothing is read or spent;
//   3. the phone's call id: one this person already used for this job's current draft answers the
//      stored proposal (a retry after a lost answer); one the ledger holds with no proposal, or for
//      another job, draft, person or feature, is refused, so a used id never runs a second model
//      call (the boundary's fresh reservation closes the same gap for two requests sent at once);
//   4. the job's current draft from the field database, which must be editing, read with the
//      walkthrough and voice notes under the job's lock, so a field owner transfer (made under the
//      same lock) cannot let a former owner's request read the new owner's field work;
//   5. the AI boundary (web/src/lib/ai/call.ts): quota, budget, Model Armor, model, Zod, price
//      sentences stripped, then the summary's rules (./request.ts);
//   6. step 1 again, and the same draft with no Submit attempt made on it since step 1 (one that
//      already ended counts too), then the proposal stored in ai_results as `proposed`, under the
//      boundary's call id.
// The route never writes the draft: only the technician's accept does, through the field rules
// (a later S7-6 slice). A refusal stores nothing.

export const SUMMARY_DRAFT_FEATURE = 'summary_draft';

export const SUMMARY_DRAFT_ERRORS = {
  invalid_request: 400,
  // The call id was used for another job, person or feature, or its earlier call ended without a
  // proposal: a new attempt needs a new id.
  call_reused: 409,
  // The draft is being submitted, is submitted or is archived: Check Scope is closed.
  draft_not_editing: 409,
  // The draft's field data does not match the field map.
  draft_invalid: 409,
} as const;
export type SummaryDraftErrorCode = keyof typeof SUMMARY_DRAFT_ERRORS;

export class SummaryDraftError extends Error {
  readonly status: number;
  constructor(readonly code: SummaryDraftErrorCode) {
    super(`Summary draft refused: ${code}`);
    this.name = 'SummaryDraftError';
    this.status = SUMMARY_DRAFT_ERRORS[code];
  }
}

// The AI boundary refused the call (or the switch is off): the route answers its fixed words.
export class SummaryDraftRefused extends Error {
  constructor(readonly refusal: AiRefusal) {
    super(`Summary draft refused by the AI boundary: ${refusal.code}`);
    this.name = 'SummaryDraftRefused';
  }
}

// The field database's view of a draft, read only.
export type SummaryDraftReader = {
  // The draft's state and field data now, or null when there is no such draft; `too_many_rooms` or
  // `too_many_photos` when a nested collection is over its cap.
  read(
    companyId: string,
    draftId: string,
  ): Promise<{ state: string; manifest: FieldManifest } | 'too_many_rooms' | 'too_many_photos' | null>;
};

export type SummaryDraftBoundary = {
  call<T>(context: AiCallerContext, request: AiRequest<T>): Promise<AiOutcome<T>>;
};

export type SummaryProposal = {
  id: string;
  callId: string;
  jobId: string;
  draftId: string;
  proposal: SummaryDraftOutput;
};

export type SummaryDraftService = {
  draft(caller: Identity, jobId: string, callId: string): Promise<{ created: boolean; result: SummaryProposal }>;
};

// Most walkthrough turns and voice notes one draft sends: far more than a 45-minute walkthrough or
// a day of notes holds, and a bound on what one request can read.
export const MAX_TURNS = 2_000;
export const MAX_VOICE_NOTES = 200;

type ResultRow = {
  id: string;
  call_id: string;
  job_id: string;
  draft_id: string;
  actor_id: string;
  feature: string;
  status: 'proposed' | 'accepted' | 'rejected';
  model: string;
  prompt_version: string;
  created_at: string;
  output: SummaryDraftOutput;
};

const rows = <T>(result: unknown) => result as unknown as T[];

// What the phone gets: the ids and the proposal only (docs/plans/S7.md, S7-6 corrections). The status,
// model, prompt version and time stay in ai_results.
const view = (row: ResultRow): SummaryProposal => ({
  id: row.id,
  callId: row.call_id,
  jobId: row.job_id,
  draftId: row.draft_id,
  proposal: row.output,
});

const RESULT_COLUMNS = sql`r.id::text, r.call_id::text, r.job_id::text, r.draft_id::text, r.actor_id::text, r.feature, r.status,
  r.model, r.prompt_version, r.created_at::text, r.output`;

// The ledger row of a call id and its proposal, if either exists.
async function priorCall(
  tx: CompanyTransaction,
  companyId: string,
  callId: string,
): Promise<{ ledger: boolean; result: ResultRow | null }> {
  const [row] = rows<{ ledger: boolean } & Partial<ResultRow> & { id: string | null }>(
    await tx.execute(sql`
      SELECT true AS ledger, ${RESULT_COLUMNS}
      FROM ai_ledger l LEFT JOIN ai_results r ON r.company_id = l.company_id AND r.call_id = l.call_id
      WHERE l.company_id = ${companyId}::uuid AND l.call_id = ${callId}::uuid
    `),
  );
  if (!row) return { ledger: false, result: null };
  return { ledger: true, result: row.id ? (row as ResultRow) : null };
}

// A stored proposal answers a retry only when it is this person's summary draft of this job's
// current draft.
function replay(result: ResultRow | null, caller: Identity, job: JobRow): SummaryProposal {
  if (
    !result ||
    result.job_id !== job.id ||
    result.draft_id !== job.currentDraftId ||
    result.actor_id !== caller.actorId ||
    result.feature !== SUMMARY_DRAFT_FEATURE
  ) {
    throw new SummaryDraftError('call_reused');
  }
  return view(result);
}

// The walkthrough turns that passed screening and the reviewed voice-note transcripts of a draft,
// in the order they were said or recorded. Blocked and unscreened turns hold no words (0012).
async function spoken(
  tx: CompanyTransaction,
  companyId: string,
  jobId: string,
  draftId: string,
): Promise<Pick<SummaryFacts, 'walkthrough' | 'voiceNotes'>> {
  const turns = rows<{ speaker: string; text: string }>(
    await tx.execute(sql`
      SELECT t.speaker, t.text
      FROM live_turns t JOIN live_sessions s ON s.company_id = t.company_id AND s.id = t.session_id
      WHERE t.company_id = ${companyId}::uuid AND s.job_id = ${jobId}::uuid AND s.draft_id = ${draftId}::uuid
        AND t.verdict = 'passed' AND t.speaker IN ('technician', 'assistant')
      ORDER BY s.started_at, s.id, t.seq
      LIMIT ${MAX_TURNS}
    `),
  );
  const notes = rows<{ transcript: string }>(
    await tx.execute(sql`
      SELECT transcript FROM voice_notes
      WHERE company_id = ${companyId}::uuid AND job_id = ${jobId}::uuid AND draft_id = ${draftId}::uuid AND state = 'reviewed'
      ORDER BY created_at, id
      LIMIT ${MAX_VOICE_NOTES}
    `),
  );
  return {
    walkthrough: turns.map((turn) => ({
      speaker: turn.speaker as 'technician' | 'assistant',
      text: turn.text,
    })),
    voiceNotes: notes.map((note) => note.transcript),
  };
}

// The caller as they are now: their membership is read again and held (FOR SHARE) until the
// transaction ends, so a role change or a disable made while the model ran is seen here, and one made
// after this check waits for the answer to be stored.
async function currentCaller(tx: CompanyTransaction, caller: Identity): Promise<Identity> {
  const [membership] = rows<{ role: string }>(
    await tx.execute(sql`
      SELECT role FROM memberships
      WHERE company_id = ${caller.companyId}::uuid AND actor_id = ${caller.actorId}::uuid AND status = 'active'
      LIMIT 1
      FOR SHARE
    `),
  );
  if (!membership) throw new JobError('not_allowed');
  return {
    ...caller,
    role: membership.role as Identity['role'],
    capabilities: capabilitiesFor(membership.role, accessFlags(caller.flags)),
  };
}

// The one check the first read, both replays and the store go through, under the job's lock (Submit
// makes its row under it before it closes its fence on the draft): the caller now, the job and its
// field work, and no Submit pending or committed on its current draft. `attempts` counts every
// Submit made on the draft, ended ones too, so a Submit that started and aborted in between is seen.
async function editableJob(
  tx: CompanyTransaction,
  caller: Identity,
  jobId: string,
): Promise<{ current: Identity; job: JobRow; attempts: number }> {
  const current = await currentCaller(tx, caller);
  const job = await jobAccess(tx, current, jobId, ['audit'], { fieldWork: true, lock: true });
  const [row] = rows<{ attempts: number; open: boolean }>(
    await tx.execute(sql`
      SELECT count(*)::int AS attempts, coalesce(bool_or(status IN ('pending', 'committed')), false) AS open
      FROM job_submissions
      WHERE company_id = ${caller.companyId}::uuid AND draft_id = ${job.currentDraftId}::uuid
    `),
  );
  if (row!.open) throw new SummaryDraftError('draft_not_editing');
  return { current, job, attempts: row!.attempts };
}

// The job's saved customer name and property address: read only so the shared prompt builder can
// remove them wherever a technician typed them (web/src/lib/ai/prompt-facts.ts), never sent.
async function identityOf(tx: CompanyTransaction, companyId: string, job: JobRow): Promise<JobIdentity> {
  const [customer] = rows<{ name: string }>(
    await tx.execute(sql`SELECT name FROM job_customers WHERE company_id = ${companyId}::uuid AND job_id = ${job.id}::uuid`),
  );
  return { customerName: customer?.name ?? '', propertyAddress: job.propertyAddress };
}

export function summaryDraftService(db: Database, reader: SummaryDraftReader, boundary: () => SummaryDraftBoundary): SummaryDraftService {
  return {
    async draft(caller, jobId, callIdInput) {
      const callId = callIdInput.toLowerCase();
      const companyId = caller.companyId;
      type Before =
        | { replayed: SummaryProposal }
        | {
            replayed: null;
            current: Identity;
            job: JobRow;
            attempts: number;
            identity: JobIdentity;
            said: Pick<SummaryFacts, 'walkthrough' | 'voiceNotes'>;
            manifest: FieldManifest;
          };
      const before = await withCompany(db, companyId, async (tx): Promise<Before> => {
        const { current, job, attempts } = await editableJob(tx, caller, jobId);
        if (caller.flags?.ai_summary !== true) throw new SummaryDraftRefused(aiRefusal('feature_off'));
        const prior = await priorCall(tx, companyId, callId);
        if (prior.ledger) return { replayed: replay(prior.result, caller, job) };
        const read = await reader.read(companyId, job.currentDraftId);
        if (read === null) throw new JobError('draft_unavailable');
        if (read === 'too_many_rooms' || read === 'too_many_photos') throw new SummaryDraftError('draft_invalid');
        if (read.state !== 'editing') throw new SummaryDraftError('draft_not_editing');
        return {
          replayed: null,
          current,
          job,
          attempts,
          identity: await identityOf(tx, companyId, job),
          said: await spoken(tx, companyId, job.id, job.currentDraftId),
          manifest: read.manifest,
        };
      });
      if (before.replayed) return { created: false, result: before.replayed };
      const { current, job, attempts, identity, said, manifest } = before;
      const draftId = job.currentDraftId;

      let facts: SummaryFacts;
      try {
        // Accepted meter readings arrive with field map v3 (S7-8); the draft holds none yet.
        facts = summaryFacts(manifest, { ...said, meterReadings: [] });
      } catch (error) {
        if (error instanceof SummaryFactsError) throw new SummaryDraftError('draft_invalid');
        throw error;
      }

      const request = summaryDraftRequest(facts, { callId, identity });
      const context: AiCallerContext = {
        companyId,
        actorId: caller.actorId,
        jobId: job.id,
        capabilities: current.capabilities,
        flags: caller.flags,
      };
      const outcome = await boundary().call(context, request);
      if (!outcome.ok && outcome.refusal.code !== 'call_reused') throw new SummaryDraftRefused(outcome.refusal);
      if (outcome.ok && outcome.promptVersion === null) throw new Error('summary draft prompt has no version');

      return withCompany(db, companyId, async (tx) => {
        // The same check again: a role change, disable, transfer, archive, Back to editing or any
        // Submit attempt while the model ran leaves the answer unstored and unsent.
        const now = await editableJob(tx, caller, jobId);
        if (now.job.currentDraftId !== draftId || now.attempts !== attempts) throw new SummaryDraftError('draft_not_editing');
        if (!outcome.ok) {
          // The same id sent twice at once: the ledger let only the first reach the model; this one
          // answers its proposal once stored.
          const prior = await priorCall(tx, companyId, callId);
          return { created: false, result: replay(prior.result, caller, now.job) };
        }
        // The digest of exactly the text sent (after the shared prompt builder cleaned it).
        const inputDigest = createHash('sha256').update(request.facts ?? '', 'utf8').digest('hex');
        // Model Armor passed the output (a blocked one is a refusal above), so its verdict is `passed`.
        const [inserted] = rows<ResultRow>(
          await tx.execute(sql`
            INSERT INTO ai_results AS r (company_id, call_id, job_id, draft_id, actor_id, feature, input_digest, prompt_version, model, output, verdict_category)
            VALUES (${companyId}::uuid, ${outcome.callId}::uuid, ${job.id}::uuid, ${draftId}::uuid, ${caller.actorId}::uuid, ${SUMMARY_DRAFT_FEATURE},
                    ${inputDigest}, ${outcome.promptVersion}, ${outcome.model}, ${JSON.stringify(outcome.output)}::text::jsonb, 'passed')
            RETURNING ${RESULT_COLUMNS}
          `),
        );
        return { created: true, result: view(inserted!) };
      });
    },
  };
}
