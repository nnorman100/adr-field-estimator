import { createHash } from 'node:crypto';
import { and, asc, count, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { auditEvents, companies, jobEstimates, jobPriceApprovals, jobSubmissions, memberships } from '@/db/schema';
import { withCompany, type CompanyTransaction, type Database } from '@/db/tenant';
import type { Table } from '@/engine/table';
import type { Capability } from '@/lib/access';
import { canonicalJson } from '@/lib/field/canonical';
import { jobAccess, JobError, type JobCaller, type JobRow } from '@/lib/jobs/access';
import { EstimateError } from '@/lib/estimates/errors';
import { readSnapshot } from '@/lib/estimates/inputs';
import {
  confirmationPredatesReprice,
  currentPin,
  currentSubmissionId,
  latestVersion,
  pinFirstPrice,
  versionById,
  versionTable,
  type PinRow,
} from '@/lib/estimates/service';
import { ENGINE_VERSION } from '@/engine/table';
import { ApprovalError } from './errors';
import { approvalSwitchesOn, hourlyTotal, roomNamesOf } from './priced';
import type { ApproveInput, ProposalInput } from './schema';

// Proposals and approvals on a job (S5b-8; spec 6.1; owner decisions D1 to D5, 2026-11-20). The
// estimator (or the owner) proposes on the job's submitted record, before its estimate is made; only
// the owner approves (`additions_approve`), and only an approval reaches a total. Every write runs in
// one transaction under the job's row lock and is bound to the record, the job revision and the
// job's pin (migration 0019's guard holds the same rules, so a write that slips past these checks is
// still refused). The first proposal on a job with no pin pins it to the company's newest published
// prices, as the first estimate would. Nothing here moves the job revision: approvals are bound to it.
//
// Every kind is priced by the estimate: a named adjustment, a custom multiplier on one priced line (B1),
// and hourly, unit and flat additions (B2, B3).

const PROPOSE: readonly Capability[] = ['scope'];
const APPROVE: readonly Capability[] = ['additions_approve'];
const READ: readonly Capability[] = ['jobs_read'];

export type ApprovalView = {
  id: string;
  kind: 'named_adjustment' | 'line_multiplier' | 'hourly' | 'unit' | 'flat';
  adjustmentId: string | null;
  // A custom multiplier: the item, the room's field id (null for a job-wide item) and the factor.
  itemId: string | null;
  roomId: string | null;
  multiplier: string | null;
  description: string | null;
  // An hourly addition's hours and saved rate.
  hours: string | null;
  rate: string | null;
  // A unit addition's quantity and unit; a unit or flat addition's price and whether it is taxable.
  quantity: string | null;
  unit: string | null;
  price: string | null;
  taxable: boolean | null;
  // The addition's line total to the cent as the estimate prices it; null for a named adjustment or a multiplier.
  total: string | null;
  jobRevision: number;
  proposedAt: string;
  approved: boolean;
  approvedAt: string | null;
  approverName: string | null;
  // The proposal was ended (edited or replaced): whatever its approval, it prices nothing.
  ended: boolean;
};

export type ApprovalsAnswer = { job: { revision: number }; approvals: ApprovalView[] };

export type ApprovalsService = {
  list(caller: JobCaller, jobId: string): Promise<ApprovalsAnswer>;
  propose(caller: JobCaller, jobId: string, input: ProposalInput): Promise<{ created: boolean; approval: ApprovalView }>;
  edit(caller: JobCaller, jobId: string, approvalId: string, input: ProposalInput): Promise<{ created: boolean; approval: ApprovalView }>;
  approve(caller: JobCaller, jobId: string, approvalId: string, input: ApproveInput): Promise<{ approval: ApprovalView }>;
};

type Row = typeof jobPriceApprovals.$inferSelect;

const digestOf = (body: unknown) => createHash('sha256').update(canonicalJson(body)).digest('hex');

function viewOf(row: Row): ApprovalView {
  return {
    id: row.id,
    kind: row.kind as ApprovalView['kind'],
    adjustmentId: row.adjustmentId,
    itemId: row.itemId,
    roomId: row.roomId,
    multiplier: row.multiplier,
    description: row.description,
    hours: row.kind === 'hourly' ? row.quantity : null,
    rate: row.kind === 'hourly' ? row.price : null,
    quantity: row.kind === 'unit' ? row.quantity : null,
    unit: row.unit,
    price: row.kind === 'unit' || row.kind === 'flat' ? row.price : null,
    taxable: row.taxable,
    total:
      row.price === null
        ? null
        : row.kind === 'hourly' || row.kind === 'unit'
          ? hourlyTotal(row.quantity!, row.price)
          : row.kind === 'flat'
            ? hourlyTotal('1', row.price)
            : null,
    jobRevision: row.jobRevision,
    proposedAt: row.proposedAt.toISOString(),
    approved: row.approvedAt !== null,
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    approverName: row.approvedByName,
    ended: row.endedAt !== null,
  };
}

async function audit(tx: CompanyTransaction, caller: JobCaller, action: string, jobId: string, details: Record<string, number | string>): Promise<void> {
  await tx.insert(auditEvents).values({ companyId: caller.companyId, actorId: caller.actorId, action, target: jobId, details });
}

// The most hourly rows, and the most unit and flat rows, a record can carry: the estimate's limits on
// additional work and on additions (web/src/engine/inspection.ts).
const MAX_HOURLY = 30;
const MAX_ADDITIONS = 30;

// A proposal of this job by id.
async function rowById(tx: CompanyTransaction, companyId: string, jobId: string, id: string): Promise<Row | null> {
  const [row] = await tx
    .select()
    .from(jobPriceApprovals)
    .where(and(eq(jobPriceApprovals.companyId, companyId), eq(jobPriceApprovals.jobId, jobId), eq(jobPriceApprovals.id, id)));
  return row ?? null;
}

// What a write is bound to: the committed record of the job's current draft, its pin and the pin's
// table. Refused when the job is not submitted, the record was repriced, or its estimate is made.
type Binding = { submissionId: string; pin: PinRow; table: Table; tableHash: string };

async function binding(tx: CompanyTransaction, caller: JobCaller, job: JobRow, pinIfMissing: boolean): Promise<Binding> {
  if (job.status === 'signed') throw new EstimateError('job_signed');
  if (job.status !== 'submitted') throw new EstimateError('not_submitted');
  const submissionId = await currentSubmissionId(tx, caller.companyId, job);
  if (!submissionId) throw new EstimateError('not_submitted');
  const [estimate] = await tx
    .select({ id: jobEstimates.id })
    .from(jobEstimates)
    .where(and(eq(jobEstimates.companyId, caller.companyId), eq(jobEstimates.submissionId, submissionId)))
    .limit(1);
  if (estimate) throw new ApprovalError('estimate_made');
  if (await confirmationPredatesReprice(tx, caller.companyId, job.id, job.currentDraftId)) throw new ApprovalError('repriced');
  let pin = await currentPin(tx, caller.companyId, job.id);
  const version = pin ? await versionById(tx, caller.companyId, pin.versionId) : await latestVersion(tx, caller.companyId);
  if (!version) throw new EstimateError('prices_not_set');
  const table = versionTable(version);
  if (version.engineVersion !== ENGINE_VERSION) throw new EstimateError('prices_unreadable');
  if (!pin) {
    if (!pinIfMissing) throw new EstimateError('not_priced');
    pin = await pinFirstPrice(tx, caller, job.id, version);
  }
  return { submissionId, pin, table, tableHash: version.contentHash };
}

// The record's rooms by field id: a custom multiplier names one of them (or none, for a job-wide item).
async function recordRoomIds(tx: CompanyTransaction, companyId: string, submissionId: string): Promise<ReadonlySet<string>> {
  const [row] = await tx
    .select({ bytes: jobSubmissions.snapshotBytes })
    .from(jobSubmissions)
    .where(and(eq(jobSubmissions.companyId, companyId), eq(jobSubmissions.id, submissionId)));
  if (!row?.bytes) return new Set();
  return new Set(roomNamesOf(readSnapshot(Buffer.from(row.bytes))).keys());
}

// The table's additional work rate: its one enabled `extras` item's price, which is per hour.
function hourlyRate(table: Table): string {
  const item = table.items.find((entry) => entry.group === 'extras' && entry.enabled);
  const rate = item?.unit_price ?? '';
  if (!/^\d+(?:\.\d{1,2})?$/.test(rate) || Number(rate) <= 0 || Number(rate) > 10000) throw new ApprovalError('no_hourly_rate');
  return rate;
}

// The caller is still an active member with the role their sign-in gave, and stays so until the
// transaction commits: a change of role or status locks the same membership row. The owner's approval
// takes the row for update, as Reprice's owner lock does.
async function lockMember(tx: CompanyTransaction, caller: JobCaller, mode: 'share' | 'update' = 'share'): Promise<void> {
  const [member] = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.companyId, caller.companyId), eq(memberships.actorId, caller.actorId), eq(memberships.role, caller.role), eq(memberships.status, 'active')))
    .for(mode);
  if (!member) throw new JobError('not_allowed');
}

// The caller's company is active, and stays so until the transaction commits: a suspension or an owner
// replacement locks the same company row. Every approval transaction takes it first, then the
// member's row, then the job's, the order the owner replacement takes them in. The owner's approval
// takes the stronger lock the owner lock takes, so two of them never wait on each other's upgrade.
async function lockCompany(tx: CompanyTransaction, caller: JobCaller, mode: 'share' | 'no key update'): Promise<void> {
  const [company] = await tx.select({ status: companies.status }).from(companies).where(eq(companies.id, caller.companyId)).for(mode);
  if (company?.status !== 'active') throw new JobError('not_allowed');
}

// The company's `priced_extras` switch is on under the job's lock; off, every route answers 404 (D5).
async function lockedFlagOn(tx: CompanyTransaction, caller: JobCaller): Promise<void> {
  if (!(await approvalSwitchesOn(tx, caller.companyId))) throw new JobError('not_found');
}

export function approvalsService(db: Database): ApprovalsService {
  // Inserts a proposal, or finds the one already made with this id: the same body is the same
  // proposal (200), another body or another job is refused.
  async function insertProposal(tx: CompanyTransaction, caller: JobCaller, job: JobRow, input: ProposalInput, request: unknown, checked?: Binding) {
    const digest = digestOf(request);
    const existing = await tx
      .select()
      .from(jobPriceApprovals)
      .where(and(eq(jobPriceApprovals.companyId, caller.companyId), eq(jobPriceApprovals.id, input.id)));
    if (existing[0]) {
      if (existing[0].jobId !== job.id || existing[0].requestDigest !== digest) throw new JobError('conflict');
      return { created: false, row: existing[0] };
    }
    if (job.revision !== input.revision) throw new JobError('stale_revision', { revision: job.revision });
    const bound = checked ?? (await binding(tx, caller, job, true));
    const values = {
      id: input.id,
      companyId: caller.companyId,
      jobId: job.id,
      submissionId: bound.submissionId,
      pinId: bound.pin.id,
      tableHash: bound.tableHash,
      jobRevision: job.revision,
      kind: input.kind,
      requestDigest: digest,
      proposedByActorId: caller.actorId,
    } as const;
    let row: Row | undefined;
    // Open rows of these kinds on this record at this revision, for the limits below.
    const openCount = async (kinds: Array<Row['kind']>) => {
      const [open] = await tx
        .select({ n: count() })
        .from(jobPriceApprovals)
        .where(
          and(
            eq(jobPriceApprovals.companyId, caller.companyId),
            eq(jobPriceApprovals.submissionId, bound.submissionId),
            eq(jobPriceApprovals.jobRevision, job.revision),
            inArray(jobPriceApprovals.kind, kinds),
            isNull(jobPriceApprovals.endedAt),
          ),
        );
      return open?.n ?? 0;
    };
    if (input.kind === 'line_multiplier') {
      // The item is one of the pinned prices' items that is on; the room is one of the record's rooms.
      if (!bound.table.items.some((entry) => entry.item_id === input.itemId && entry.enabled)) throw new ApprovalError('unknown_item');
      if (input.roomId !== null && !(await recordRoomIds(tx, caller.companyId, bound.submissionId)).has(input.roomId)) {
        throw new ApprovalError('unknown_room');
      }
      // One open multiplier per line (D2): a second proposal for the same line is refused.
      const [same] = await tx
        .select({ id: jobPriceApprovals.id })
        .from(jobPriceApprovals)
        .where(
          and(
            eq(jobPriceApprovals.companyId, caller.companyId),
            eq(jobPriceApprovals.submissionId, bound.submissionId),
            eq(jobPriceApprovals.jobRevision, job.revision),
            eq(jobPriceApprovals.kind, 'line_multiplier'),
            eq(jobPriceApprovals.itemId, input.itemId),
            input.roomId === null ? isNull(jobPriceApprovals.roomId) : eq(jobPriceApprovals.roomId, input.roomId),
            isNull(jobPriceApprovals.endedAt),
          ),
        )
        .limit(1);
      if (same) throw new ApprovalError('line_already_proposed');
      [row] = await tx
        .insert(jobPriceApprovals)
        .values({ ...values, itemId: input.itemId, roomId: input.roomId, multiplier: input.multiplier })
        .returning();
    } else if (input.kind === 'unit' || input.kind === 'flat') {
      // Never added to the company's price table (spec 6.1): the row holds the addition itself.
      if ((await openCount(['unit', 'flat'])) >= MAX_ADDITIONS) throw new ApprovalError('too_many_additions');
      [row] = await tx
        .insert(jobPriceApprovals)
        .values({
          ...values,
          description: input.description,
          ...(input.kind === 'unit' ? { quantity: input.quantity, unit: input.unit } : {}),
          price: input.price,
          taxable: input.taxable,
        })
        .returning();
    } else if (input.kind === 'named_adjustment') {
      if (!(bound.table.adjustments ?? []).some((entry) => entry.adjustment_id === input.adjustmentId)) throw new ApprovalError('unknown_adjustment');
      [row] = await tx.insert(jobPriceApprovals).values({ ...values, adjustmentId: input.adjustmentId }).returning();
    } else {
      // The rate is the pinned table's additional work rate now; it stays saved on the row (D3).
      const rate = hourlyRate(bound.table);
      if ((await openCount(['hourly'])) >= MAX_HOURLY) throw new ApprovalError('too_many_additions');
      [row] = await tx.insert(jobPriceApprovals).values({ ...values, description: input.description, quantity: input.hours, price: rate }).returning();
    }
    await audit(tx, caller, 'price_proposed', job.id, { approval: row!.id });
    return { created: true, row: row! };
  }

  return {
    async list(caller, jobId) {
      return withCompany(db, caller.companyId, async (tx) => {
        await lockCompany(tx, caller, 'share');
        await lockMember(tx, caller);
        const job = await jobAccess(tx, caller, jobId, READ, { lock: true });
        await lockedFlagOn(tx, caller);
        const submissionId = job.status === 'submitted' ? await currentSubmissionId(tx, caller.companyId, job) : null;
        if (!submissionId) return { job: { revision: job.revision }, approvals: [] };
        // The record's open rows at the job's current revision: what the next estimate prices.
        const rows = await tx
          .select()
          .from(jobPriceApprovals)
          .where(
            and(
              eq(jobPriceApprovals.companyId, caller.companyId),
              eq(jobPriceApprovals.submissionId, submissionId),
              eq(jobPriceApprovals.jobRevision, job.revision),
              isNull(jobPriceApprovals.endedAt),
            ),
          )
          .orderBy(asc(jobPriceApprovals.proposedAt), asc(jobPriceApprovals.id));
        return { job: { revision: job.revision }, approvals: rows.map(viewOf) };
      });
    },

    async propose(caller, jobId, input) {
      return withCompany(db, caller.companyId, async (tx) => {
        await lockCompany(tx, caller, 'share');
        await lockMember(tx, caller);
        const job = await jobAccess(tx, caller, jobId, PROPOSE, { lock: true });
        await lockedFlagOn(tx, caller);
        const { created, row } = await insertProposal(tx, caller, job, input, { action: 'propose', ...input });
        return { created, approval: viewOf(row) };
      });
    },

    // An edit ends the proposal named (`edited`, its approval with it) and proposes the new one, in
    // one transaction; the same new id and body again is the same edit.
    async edit(caller, jobId, approvalId, input) {
      return withCompany(db, caller.companyId, async (tx) => {
        await lockCompany(tx, caller, 'share');
        await lockMember(tx, caller);
        const job = await jobAccess(tx, caller, jobId, PROPOSE, { lock: true });
        await lockedFlagOn(tx, caller);
        const request = { action: 'edit', replaces: approvalId, ...input };
        const [already] = await tx
          .select({ id: jobPriceApprovals.id })
          .from(jobPriceApprovals)
          .where(and(eq(jobPriceApprovals.companyId, caller.companyId), eq(jobPriceApprovals.id, input.id)));
        if (already) {
          const { row } = await insertProposal(tx, caller, job, input, request);
          return { created: false, approval: viewOf(row) };
        }
        const old = await rowById(tx, caller.companyId, jobId, approvalId);
        if (!old) throw new ApprovalError('approval_not_found');
        if (old.endedAt) throw new ApprovalError('approval_closed');
        if (old.kind !== input.kind) throw new JobError('conflict');
        // A row left at an older revision (a customer save since) is no longer bound to the job: propose anew.
        if (job.revision !== input.revision || old.jobRevision !== job.revision) throw new JobError('stale_revision', { revision: job.revision });
        const bound = await binding(tx, caller, job, false);
        await tx
          .update(jobPriceApprovals)
          .set({ endedByActorId: caller.actorId, endedReason: 'edited' })
          .where(and(eq(jobPriceApprovals.companyId, caller.companyId), eq(jobPriceApprovals.id, old.id)));
        const { row } = await insertProposal(tx, caller, job, input, request, bound);
        await audit(tx, caller, 'price_edited', job.id, { approval: old.id, replaced_by: row.id });
        return { created: true, approval: viewOf(row) };
      });
    },

    // The owner approves one proposal, exactly as proposed. A named adjustment approved while another
    // is approved ends that one (`replaced`, D4) in the same transaction. Approving again with the
    // same name is answered as the first time.
    async approve(caller, jobId, approvalId, input) {
      return withCompany(db, caller.companyId, async (tx) => {
        // Company row, then the caller's membership (for update when the owner), before the job lock;
        // the job access then answers archived 410 and not found, and a caller without the key is 403.
        await lockCompany(tx, caller, 'no key update');
        await lockMember(tx, caller, caller.role === 'owner' ? 'update' : 'share');
        const job = await jobAccess(tx, caller, jobId, APPROVE, { lock: true });
        await lockedFlagOn(tx, caller);
        const row = await rowById(tx, caller.companyId, jobId, approvalId);
        if (!row) throw new ApprovalError('approval_not_found');
        const name = row.kind === 'hourly' ? (input.approverName ?? null) : null;
        if (row.kind === 'hourly' && name === null) throw new ApprovalError('approver_name_required');
        if (row.kind !== 'hourly' && input.approverName !== undefined) throw new ApprovalError('invalid_request');
        if (row.endedAt) throw new ApprovalError('approval_closed');
        if (row.approvedAt && (row.approvedByActorId !== caller.actorId || row.approvedByName !== name)) throw new ApprovalError('approval_closed');
        if (job.revision !== input.revision || row.jobRevision !== job.revision) throw new JobError('stale_revision', { revision: job.revision });
        if (row.approvedAt) return { approval: viewOf(row) };
        await binding(tx, caller, job, false);
        if (row.kind === 'named_adjustment') {
          const approved = await tx
            .select({ id: jobPriceApprovals.id })
            .from(jobPriceApprovals)
            .where(
              and(
                eq(jobPriceApprovals.companyId, caller.companyId),
                eq(jobPriceApprovals.submissionId, row.submissionId),
                eq(jobPriceApprovals.jobRevision, row.jobRevision),
                eq(jobPriceApprovals.kind, 'named_adjustment'),
                isNotNull(jobPriceApprovals.approvedAt),
                isNull(jobPriceApprovals.endedAt),
              ),
            );
          for (const other of approved) {
            if (other.id === row.id) continue;
            await tx
              .update(jobPriceApprovals)
              .set({ endedByActorId: caller.actorId, endedReason: 'replaced' })
              .where(
                and(eq(jobPriceApprovals.companyId, caller.companyId), eq(jobPriceApprovals.id, other.id), isNull(jobPriceApprovals.endedAt)),
              );
          }
        }
        const [done] = await tx
          .update(jobPriceApprovals)
          .set({ approvedByActorId: caller.actorId, approvedByName: name })
          .where(and(eq(jobPriceApprovals.companyId, caller.companyId), eq(jobPriceApprovals.id, row.id)))
          .returning();
        await audit(tx, caller, 'price_approved', job.id, { approval: row.id });
        return { approval: viewOf(done!) };
      });
    },
  };
}
