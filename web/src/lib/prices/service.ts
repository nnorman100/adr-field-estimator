import { and, desc, eq, sql } from 'drizzle-orm';
import { auditEvents, priceTableVersions, priceTableWorkingCopies } from '@/db/schema';
import { withCompany, type CompanyTransaction, type Database } from '@/db/tenant';
import { checkTable, priceEstimate, type Estimate, type Json, type Refusal } from '@/engine/estimate';
import { ENGINE_VERSION, contentHash, effectiveTable, parseTable, zeroPriceItems, type Table } from '@/engine/table';
import { exportPriceList } from './csv';
import { applyPriceList, PriceImportError } from './import';
import { SAMPLE_JOBS } from './samples';
import { starterTable } from './starter';

// A company's price tables (S4-6): the published versions and the one working copy the owner edits
// (migration 0009). Every function runs inside withCompany for a company id taken from the verified
// sign-in, so row-level security limits it to that company; the operator's read-only view is the
// platform service's, through readPrices below. Every write puts one audit row in its own
// transaction: ids, counts and sequence numbers, never a price or a reason.
//
// The rules this follows (docs/plans/pricing.md):
//   - A new company has no stored working copy: it is shown the starter list (revision 0, blank
//     prices) and the first save creates the row at revision 1. Reading never writes.
//   - A save, restore or publish names the revision it was made from; a stale one is refused (409).
//   - Publish checks the table (no blank price on an item that is on, every zero price confirmed),
//     takes the company's next version number, and keeps the working copy as the published table.
//     The first publish needs the owner's range choice (Q14).
//   - A published version never changes; restore copies one into the working copy.

export const PRICES_ERRORS = {
  // The caller's role cannot use this route.
  not_allowed: 403,
  // No such version in this company.
  not_found: 404,
  // The working copy was changed since the caller read it (or the caller had none to publish).
  stale_revision: 409,
  // The publish key was already used for a different publish.
  publish_key_used: 409,
  // The working copy is the table that is already published.
  no_changes: 409,
  // Two changes met at the same moment; the caller may try again.
  conflict: 409,
  // The table does not pass the schema.
  invalid_table: 422,
  // The price list file cannot be applied to the working copy (a formula cell, a line that matches
  // no price, a price the table refuses); nothing is changed. The detail names the line.
  invalid_import: 422,
  // The table passes the schema but cannot be published yet (a blank price, an unconfirmed zero price).
  not_publishable: 422,
  // The first publish needs the owner to choose the estimate setting: a range or one price.
  range_choice_required: 422,
  // A stored table no longer parses, or its hash does not match; nothing is shown from it.
  table_unreadable: 500,
} as const;
export type PricesErrorCode = keyof typeof PRICES_ERRORS;

export class PricesError extends Error {
  readonly status: number;
  constructor(
    readonly code: PricesErrorCode,
    // A sentence naming what to fix (the table's own message: ids and rules, never a value we hold).
    readonly detail?: string,
    // The working copy's current revision, on a stale refusal.
    readonly revision?: number,
  ) {
    super(`Price change refused: ${code}`);
    this.name = 'PricesError';
    this.status = PRICES_ERRORS[code];
  }
}

export type RangeChoice = 'range' | 'single';
export type PriceSource = 'blank' | 'import' | 'restore';

export type VersionMeta = {
  id: string;
  sequence: number;
  contentHash: string;
  engineVersion: string;
  reason: string;
  source: PriceSource;
  publishedBy: string;
  publishedAt: string;
};

export type VersionView = VersionMeta & { table: Table };

export type WorkingCopyView = {
  // 0 for a company that has not saved yet: the table is the starter list and nothing is stored.
  revision: number;
  baseSequence: number | null;
  updatedAt: string | null;
  table: Table;
};

// What a reader without prices_manage sees of the current prices: the sequence and date, and the
// enabled items only (a switched-off item is the owner's business).
export type ReaderVersion = {
  id: string;
  sequence: number;
  contentHash: string;
  engineVersion: string;
  publishedAt: string;
  table: Table;
};

export type PricesView =
  | { view: 'owner'; current: VersionView | null; workingCopy: WorkingCopyView }
  | { view: 'reader'; current: ReaderVersion | null };

export type PreviewSample = {
  id: string;
  name: string;
  summary: string;
  result: Omit<Estimate, 'documents'> | Refusal;
};

export type Preview = {
  // The publish check on the table as it stands, and the items whose zero price still needs confirming.
  publishCheck: { ok: true } | { ok: false; error: string };
  zeroPrices: string[];
  samples: PreviewSample[];
};

export type Imported = {
  // How many prices the file changed; 0 means the working copy was left as it was.
  changed: number;
  workingCopy: WorkingCopyView;
};

export type Published = { version: VersionMeta; workingCopy: WorkingCopyView; replayed: boolean };

// The most versions one listing returns, newest first.
export const VERSION_LIST_LIMIT = 100;

const versionColumns = {
  id: priceTableVersions.id,
  sequence: priceTableVersions.sequence,
  content: priceTableVersions.content,
  contentHash: priceTableVersions.contentHash,
  engineVersion: priceTableVersions.engineVersion,
  reason: priceTableVersions.reason,
  source: priceTableVersions.source,
  publishedBy: priceTableVersions.publishedByActorId,
  publishedAt: priceTableVersions.publishedAt,
};

type VersionRow = {
  id: string;
  sequence: number;
  content: Record<string, unknown>;
  contentHash: string;
  engineVersion: string;
  reason: string;
  source: PriceSource;
  publishedBy: string;
  publishedAt: Date;
};

function meta(row: VersionRow): VersionMeta {
  return {
    id: row.id,
    sequence: row.sequence,
    contentHash: row.contentHash,
    engineVersion: row.engineVersion,
    reason: row.reason,
    source: row.source,
    publishedBy: row.publishedBy,
    publishedAt: row.publishedAt.toISOString(),
  };
}

// The stored table, read through the one schema. A table that does not parse, or whose hash is not
// the one stored beside it, is never shown or priced from.
function storedTable(content: unknown): Table {
  try {
    return parseTable(content);
  } catch {
    throw new PricesError('table_unreadable');
  }
}

function versionOf(row: VersionRow): VersionView {
  const table = storedTable(row.content);
  if (contentHash(table) !== row.contentHash) throw new PricesError('table_unreadable');
  return { ...meta(row), table };
}

// A reader's copy of a table: the enabled items, and the room types' suggested lists without the
// items that were left out, so it is still a table the schema accepts.
export function readerTable(table: Table): Table {
  const kept = table.items.filter((item) => item.enabled);
  const ids = new Set(kept.map((item) => item.item_id));
  return parseTable({
    ...table,
    items: kept,
    policy: {
      ...table.policy,
      room_types: table.policy.room_types.map((type) => ({
        ...type,
        suggested_items: type.suggested_items.filter((id) => ids.has(id)),
      })),
    },
  });
}

function parseInput(raw: unknown): Table {
  try {
    return parseTable(raw);
  } catch (error) {
    throw new PricesError('invalid_table', error instanceof Error ? error.message : 'invalid price table');
  }
}

const asRecord = (table: Table) => table as unknown as Record<string, unknown>;
const asJson = (table: Table) => table as unknown as Json;

function isUniqueViolation(error: unknown): boolean {
  const found = error as { code?: unknown; cause?: { code?: unknown } } | null;
  return found?.code === '23505' || found?.cause?.code === '23505';
}

function isCheckViolation(error: unknown): boolean {
  const found = error as { code?: unknown; cause?: { code?: unknown } } | null;
  return found?.code === '23514' || found?.cause?.code === '23514';
}

// One audit row per write: ids and counts only.
async function audit(
  tx: CompanyTransaction,
  companyId: string,
  actorId: string,
  action: string,
  target: string,
  details: Record<string, string | number | boolean>,
): Promise<void> {
  await tx.insert(auditEvents).values({ companyId, actorId, operatorActorId: null, action, target, details });
}

type WorkingRow = { revision: number; baseSequence: number | null; content: Record<string, unknown>; updatedAt: Date };

async function workingRow(tx: CompanyTransaction, companyId: string, lock = false): Promise<WorkingRow | null> {
  const query = tx
    .select({
      revision: priceTableWorkingCopies.revision,
      baseSequence: priceTableWorkingCopies.baseSequence,
      content: priceTableWorkingCopies.content,
      updatedAt: priceTableWorkingCopies.updatedAt,
    })
    .from(priceTableWorkingCopies)
    .where(eq(priceTableWorkingCopies.companyId, companyId));
  const [row] = await (lock ? query.for('update') : query);
  return row ?? null;
}

function workingView(row: WorkingRow | null): WorkingCopyView {
  if (!row) return { revision: 0, baseSequence: null, updatedAt: null, table: starterTable() };
  return {
    revision: row.revision,
    baseSequence: row.baseSequence,
    updatedAt: row.updatedAt.toISOString(),
    table: storedTable(row.content),
  };
}

async function currentVersion(tx: CompanyTransaction, companyId: string): Promise<VersionRow | null> {
  const [row] = await tx
    .select(versionColumns)
    .from(priceTableVersions)
    .where(eq(priceTableVersions.companyId, companyId))
    .orderBy(desc(priceTableVersions.sequence))
    .limit(1);
  return (row as VersionRow | undefined) ?? null;
}

// The company's prices as the caller may see them, read in the caller's transaction for that
// company: the prices route, and the platform operator's read-only support view (S3-9).
export async function readCompanyPrices(tx: CompanyTransaction, companyId: string, view: 'owner' | 'reader'): Promise<PricesView> {
  const current = await currentVersion(tx, companyId);
  if (view === 'reader') {
    if (!current) return { view, current: null };
    const full = versionOf(current);
    return {
      view,
      current: {
        id: full.id,
        sequence: full.sequence,
        contentHash: full.contentHash,
        engineVersion: full.engineVersion,
        publishedAt: full.publishedAt,
        table: readerTable(full.table),
      },
    };
  }
  return {
    view,
    current: current ? versionOf(current) : null,
    workingCopy: workingView(await workingRow(tx, companyId)),
  };
}

export async function readVersionList(tx: CompanyTransaction, companyId: string): Promise<{ versions: VersionMeta[]; more: boolean }> {
  const rows = await tx
    .select(versionColumns)
    .from(priceTableVersions)
    .where(eq(priceTableVersions.companyId, companyId))
    .orderBy(desc(priceTableVersions.sequence))
    .limit(VERSION_LIST_LIMIT + 1);
  return { versions: (rows as VersionRow[]).slice(0, VERSION_LIST_LIMIT).map(meta), more: rows.length > VERSION_LIST_LIMIT };
}

async function readOnly<T>(db: Database, companyId: string, run: (tx: CompanyTransaction) => Promise<T>): Promise<T> {
  return withCompany(db, companyId, async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    return run(tx);
  });
}

// Prices a table on the built-in sample jobs. Writes nothing.
export function previewTable(table: Table): Preview {
  const content = asJson(table);
  const check = checkTable(content, []);
  const samples = SAMPLE_JOBS.map((sample): PreviewSample => {
    const result = priceEstimate(content, sample.job);
    if (!result.ok) return { id: sample.id, name: sample.name, summary: sample.summary, result };
    const { documents, ...estimate } = result;
    void documents;
    return { id: sample.id, name: sample.name, summary: sample.summary, result: estimate };
  });
  return {
    publishCheck: check.ok ? { ok: true } : { ok: false, error: check.error },
    zeroPrices: zeroPriceItems(effectiveTable(table)),
    samples,
  };
}

export type PublishInput = {
  expectedRevision: number;
  reason: string;
  publishKey: string;
  // The id or code of every item whose zero price the owner confirms.
  confirmZeroPrices: string[];
  rangeChoice?: RangeChoice;
};

export function pricesService(db: Database) {
  // A unique key or the revision rule caught two changes racing; nothing was written.
  async function inCompany<T>(companyId: string, run: (tx: CompanyTransaction) => Promise<T>): Promise<T> {
    try {
      return await withCompany(db, companyId, run);
    } catch (error) {
      if (isUniqueViolation(error) || isCheckViolation(error)) throw new PricesError('conflict');
      throw error;
    }
  }

  // Replaces the working copy's content, from `revision` to the next, or creates it from revision 0.
  async function replaceWorking(
    tx: CompanyTransaction,
    companyId: string,
    expectedRevision: number,
    table: Table,
    baseSequence: number | null | undefined,
    now: Date,
  ): Promise<WorkingCopyView> {
    if (expectedRevision === 0) {
      const created = await tx
        .insert(priceTableWorkingCopies)
        .values({ companyId, baseSequence: baseSequence ?? null, content: asRecord(table), revision: 1 })
        .onConflictDoNothing()
        .returning({ revision: priceTableWorkingCopies.revision, updatedAt: priceTableWorkingCopies.updatedAt });
      const row = created[0];
      if (!row) throw new PricesError('stale_revision', undefined, (await workingRow(tx, companyId))?.revision);
      return { revision: row.revision, baseSequence: baseSequence ?? null, updatedAt: row.updatedAt.toISOString(), table };
    }
    const updated = await tx
      .update(priceTableWorkingCopies)
      .set({
        content: asRecord(table),
        revision: expectedRevision + 1,
        updatedAt: now,
        ...(baseSequence === undefined ? {} : { baseSequence }),
      })
      .where(and(eq(priceTableWorkingCopies.companyId, companyId), eq(priceTableWorkingCopies.revision, expectedRevision)))
      .returning({
        revision: priceTableWorkingCopies.revision,
        baseSequence: priceTableWorkingCopies.baseSequence,
        updatedAt: priceTableWorkingCopies.updatedAt,
      });
    const row = updated[0];
    if (!row) throw new PricesError('stale_revision', undefined, (await workingRow(tx, companyId))?.revision ?? 0);
    return { revision: row.revision, baseSequence: row.baseSequence, updatedAt: row.updatedAt.toISOString(), table };
  }

  return {
    // The company's current prices and, for the owner, the working copy. A read: no audit row.
    async read(companyId: string, view: 'owner' | 'reader'): Promise<PricesView> {
      return readOnly(db, companyId, (tx) => readCompanyPrices(tx, companyId, view));
    },

    // The working copy as the file the owner downloads: every price, one line each.
    async exportPriceList(companyId: string): Promise<string> {
      return readOnly(db, companyId, async (tx) => exportPriceList(workingView(await workingRow(tx, companyId)).table));
    },

    // The built-in sample jobs priced from the working copy, or from `table` when the editor sends
    // the copy it has open. Writes nothing, not even an audit row.
    async preview(companyId: string, table?: unknown): Promise<Preview> {
      if (table !== undefined) return previewTable(parseInput(table));
      return readOnly(db, companyId, async (tx) => previewTable(workingView(await workingRow(tx, companyId)).table));
    },

    // Saves the whole table as the working copy. `expectedRevision` is the revision the owner's
    // screen was loaded at (0 before the first save); any other is stale.
    async saveWorkingCopy(
      companyId: string,
      actorId: string,
      input: { expectedRevision: number; table: unknown },
      now: Date,
    ): Promise<WorkingCopyView> {
      const table = parseInput(input.table);
      return inCompany(companyId, async (tx) => {
        const saved = await replaceWorking(tx, companyId, input.expectedRevision, table, undefined, now);
        await audit(tx, companyId, actorId, 'price_working_copy_saved', companyId, {
          revision: saved.revision,
          items: table.items.length,
        });
        return saved;
      });
    },

    // Applies a CSV price list (import.ts) to the working copy and writes nothing else. A stale
    // revision is refused before the file is read; a file that changes no price leaves the working
    // copy and its revision as they were, with no audit row.
    async importPriceList(
      companyId: string,
      actorId: string,
      input: { expectedRevision: number; csv: string },
      now: Date,
    ): Promise<Imported> {
      return inCompany(companyId, async (tx) => {
        const working = await workingRow(tx, companyId, true);
        const revision = working?.revision ?? 0;
        if (revision !== input.expectedRevision) throw new PricesError('stale_revision', undefined, revision);
        const current = workingView(working);
        let applied: ReturnType<typeof applyPriceList>;
        try {
          applied = applyPriceList(current.table, input.csv);
        } catch (error) {
          if (error instanceof PriceImportError) throw new PricesError('invalid_import', error.detail);
          throw error;
        }
        if (applied.changed === 0) return { changed: 0, workingCopy: current };
        const saved = await replaceWorking(tx, companyId, revision, applied.table, undefined, now);
        await audit(tx, companyId, actorId, 'price_working_copy_imported', companyId, {
          revision: saved.revision,
          prices: applied.changed,
        });
        return { changed: applied.changed, workingCopy: saved };
      });
    },

    async listVersions(companyId: string): Promise<{ versions: VersionMeta[]; more: boolean }> {
      return readOnly(db, companyId, (tx) => readVersionList(tx, companyId));
    },

    async readVersion(companyId: string, versionId: string): Promise<VersionView> {
      return readOnly(db, companyId, async (tx) => {
        const [row] = await tx
          .select(versionColumns)
          .from(priceTableVersions)
          .where(and(eq(priceTableVersions.companyId, companyId), eq(priceTableVersions.id, versionId)));
        if (!row) throw new PricesError('not_found');
        return versionOf(row as VersionRow);
      });
    },

    // Copies a published version into the working copy. Nothing is published by it.
    async restore(
      companyId: string,
      actorId: string,
      versionId: string,
      expectedRevision: number,
      now: Date,
    ): Promise<WorkingCopyView> {
      return inCompany(companyId, async (tx) => {
        const [row] = await tx
          .select(versionColumns)
          .from(priceTableVersions)
          .where(and(eq(priceTableVersions.companyId, companyId), eq(priceTableVersions.id, versionId)));
        if (!row) throw new PricesError('not_found');
        const version = versionOf(row as VersionRow);
        const restored = await replaceWorking(tx, companyId, expectedRevision, version.table, version.sequence, now);
        await audit(tx, companyId, actorId, 'price_version_restored', version.id, {
          sequence: version.sequence,
          revision: restored.revision,
        });
        return restored;
      });
    },

    // Publishes the working copy as the company's next version. One transaction: the working
    // copy's row is locked first, so two publishes (or a publish and a save) cannot interleave.
    async publish(companyId: string, actorId: string, input: PublishInput, now: Date): Promise<Published> {
      return inCompany(companyId, async (tx) => {
        const working = await workingRow(tx, companyId, true);
        // A retried publish finds its version instead of making another.
        const [earlier] = await tx
          .select(versionColumns)
          .from(priceTableVersions)
          .where(and(eq(priceTableVersions.companyId, companyId), eq(priceTableVersions.publishKey, input.publishKey)));
        if (earlier) {
          if (earlier.reason !== input.reason) throw new PricesError('publish_key_used');
          return { version: meta(earlier as VersionRow), workingCopy: workingView(working), replayed: true };
        }
        if (!working || working.revision !== input.expectedRevision) {
          throw new PricesError('stale_revision', undefined, working?.revision ?? 0);
        }
        const latest = await currentVersion(tx, companyId);
        if (!latest && input.rangeChoice === undefined) throw new PricesError('range_choice_required');
        const stored = storedTable(working.content);
        // The owner's choice is part of what is published, and of the working copy afterwards.
        const table =
          input.rangeChoice === undefined
            ? stored
            : parseInput({ ...stored, policy: { ...stored.policy, estimate_mode: input.rangeChoice } });
        const check = checkTable(asJson(table), input.confirmZeroPrices);
        if (!check.ok) throw new PricesError('not_publishable', check.error);
        const hash = contentHash(table);
        if (latest && latest.contentHash === hash) throw new PricesError('no_changes');
        // 'restore' when nothing was changed after a version was copied into the working copy;
        // 'import' when the working copy is as the last import left it (every other change bumps
        // the revision, and the import's audit row names the revision it wrote); 'blank' for a
        // table the owner built or edited from the starter list.
        let source: PriceSource = 'blank';
        if (working.baseSequence !== null) {
          const [base] = await tx
            .select({ hash: priceTableVersions.contentHash })
            .from(priceTableVersions)
            .where(and(eq(priceTableVersions.companyId, companyId), eq(priceTableVersions.sequence, working.baseSequence)));
          if (base?.hash === hash) source = 'restore';
        }
        if (source === 'blank') {
          const [imported] = await tx
            .select({ id: auditEvents.id })
            .from(auditEvents)
            .where(
              and(
                eq(auditEvents.companyId, companyId),
                eq(auditEvents.action, 'price_working_copy_imported'),
                sql`${auditEvents.details}->>'revision' = ${String(working.revision)}`,
              ),
            )
            .limit(1);
          if (imported) source = 'import';
        }
        const sequence = (latest?.sequence ?? 0) + 1;
        const [inserted] = await tx
          .insert(priceTableVersions)
          .values({
            companyId,
            sequence,
            content: asRecord(table),
            contentHash: hash,
            engineVersion: ENGINE_VERSION,
            reason: input.reason,
            source,
            publishedByActorId: actorId,
            publishedAt: now,
            publishKey: input.publishKey,
          })
          .returning(versionColumns);
        const saved = await replaceWorking(tx, companyId, working.revision, table, sequence, now);
        await audit(tx, companyId, actorId, 'price_table_published', inserted!.id, {
          sequence,
          source,
          items: table.items.length,
          zeroPricesConfirmed: input.confirmZeroPrices.length,
        });
        return { version: meta(inserted as VersionRow), workingCopy: saved, replayed: false };
      });
    },
  };
}

export type PricesService = ReturnType<typeof pricesService>;
