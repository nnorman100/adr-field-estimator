import { randomUUID } from 'node:crypto';
import { checkTable, type Json } from '@/engine/estimate';
import { ENGINE_VERSION, contentHash, parseTable, type Table } from '@/engine/table';
import { readFixtureSync, updateFixture, type LocalFixtureData } from '@/lib/sign-in/local-directory';
import { exportPriceList } from './csv';
import { applyPriceList, PriceImportError } from './import';
import {
  PricesError,
  VERSION_LIST_LIMIT,
  previewTable,
  readerTable,
  type PriceSource,
  type PricesService,
  type PricesView,
  type VersionMeta,
  type VersionView,
  type WorkingCopyView,
} from './service';
import { starterTable } from './starter';

// A stand-in for a company's price tables in Postgres (migration 0009), kept in the same JSON file
// as the sign-in stand-in (LOCAL_SIGN_IN_FIXTURE), so the Prices screens can be driven end to end
// against the Auth emulator with no database (tests/e2e/prices.spec.ts). It follows pricesService
// (service.ts) rule for rule, through the same table, check, preview, import and export functions;
// only the storage differs, and it writes no audit row. The configuration allows it only on a
// developer machine (src/lib/config.ts). tests/db/prices-api.test.ts holds the database rules.

type Company = LocalFixtureData['companies'][number];
type Stored = NonNullable<Company['prices']>;
type StoredVersion = Stored['versions'][number];

function companyOf(data: LocalFixtureData, companyId: string): Company {
  const company = data.companies.find((candidate) => candidate.id === companyId);
  if (!company) throw new PricesError('not_found');
  return company;
}

function storedOf(company: Company): Stored {
  company.prices ??= { workingCopy: null, versions: [] };
  return company.prices;
}

function storedTable(content: unknown): Table {
  try {
    return parseTable(content);
  } catch {
    throw new PricesError('table_unreadable');
  }
}

function parseInput(raw: unknown): Table {
  try {
    return parseTable(raw);
  } catch (error) {
    throw new PricesError('invalid_table', error instanceof Error ? error.message : 'invalid price table');
  }
}

function meta(row: StoredVersion): VersionMeta {
  const { id, sequence, contentHash: hash, engineVersion, reason, source, publishedBy, publishedAt } = row;
  return { id, sequence, contentHash: hash, engineVersion, reason, source, publishedBy, publishedAt };
}

function versionOf(row: StoredVersion): VersionView {
  const table = storedTable(row.content);
  if (contentHash(table) !== row.contentHash) throw new PricesError('table_unreadable');
  return { ...meta(row), table };
}

function workingView(stored: Stored | undefined): WorkingCopyView {
  const row = stored?.workingCopy;
  if (!row) return { revision: 0, baseSequence: null, updatedAt: null, table: starterTable() };
  return { revision: row.revision, baseSequence: row.baseSequence, updatedAt: row.updatedAt, table: storedTable(row.content) };
}

const latest = (stored: Stored | undefined) =>
  [...(stored?.versions ?? [])].sort((left, right) => right.sequence - left.sequence)[0] ?? null;

// Replaces the working copy from `expected` to the next revision, or creates it from revision 0.
function replaceWorking(stored: Stored, expected: number, table: Table, baseSequence: number | null | undefined): WorkingCopyView {
  const revision = stored.workingCopy?.revision ?? 0;
  if (revision !== expected) throw new PricesError('stale_revision', undefined, revision);
  stored.workingCopy = {
    revision: revision + 1,
    baseSequence: baseSequence === undefined ? (stored.workingCopy?.baseSequence ?? null) : baseSequence,
    updatedAt: new Date().toISOString(),
    content: table,
    importedRevision: stored.workingCopy?.importedRevision ?? null,
  };
  return workingView(stored);
}

export function localPricesService(path: string): PricesService {
  const read = (companyId: string) => companyOf(readFixtureSync(path), companyId).prices;

  return {
    async read(companyId, view): Promise<PricesView> {
      const stored = read(companyId);
      const current = latest(stored);
      if (view === 'reader') {
        if (!current) return { view, current: null };
        const full = versionOf(current);
        const { id, sequence, contentHash: hash, engineVersion, publishedAt } = full;
        return { view, current: { id, sequence, contentHash: hash, engineVersion, publishedAt, table: readerTable(full.table) } };
      }
      return { view, current: current ? versionOf(current) : null, workingCopy: workingView(stored) };
    },

    async exportPriceList(companyId) {
      return exportPriceList(workingView(read(companyId)).table);
    },

    async preview(companyId, table) {
      if (table !== undefined) return previewTable(parseInput(table));
      return previewTable(workingView(read(companyId)).table);
    },

    async saveWorkingCopy(companyId, _actorId, input) {
      const table = parseInput(input.table);
      return updateFixture(path, (data) => replaceWorking(storedOf(companyOf(data, companyId)), input.expectedRevision, table, undefined));
    },

    async importPriceList(companyId, _actorId, input) {
      return updateFixture(path, (data) => {
        const stored = storedOf(companyOf(data, companyId));
        const revision = stored.workingCopy?.revision ?? 0;
        if (revision !== input.expectedRevision) throw new PricesError('stale_revision', undefined, revision);
        const current = workingView(stored);
        let applied: ReturnType<typeof applyPriceList>;
        try {
          applied = applyPriceList(current.table, input.csv);
        } catch (error) {
          if (error instanceof PriceImportError) throw new PricesError('invalid_import', error.detail);
          throw error;
        }
        if (applied.changed === 0) return { changed: 0, workingCopy: current };
        const saved = replaceWorking(stored, revision, applied.table, undefined);
        stored.workingCopy!.importedRevision = saved.revision;
        return { changed: applied.changed, workingCopy: saved };
      });
    },

    async listVersions(companyId) {
      const versions = [...(read(companyId)?.versions ?? [])].sort((left, right) => right.sequence - left.sequence);
      return { versions: versions.slice(0, VERSION_LIST_LIMIT).map(meta), more: versions.length > VERSION_LIST_LIMIT };
    },

    async readVersion(companyId, versionId) {
      const row = read(companyId)?.versions.find((version) => version.id === versionId);
      if (!row) throw new PricesError('not_found');
      return versionOf(row);
    },

    async restore(companyId, _actorId, versionId, expectedRevision) {
      return updateFixture(path, (data) => {
        const stored = storedOf(companyOf(data, companyId));
        const row = stored.versions.find((version) => version.id === versionId);
        if (!row) throw new PricesError('not_found');
        const version = versionOf(row);
        return replaceWorking(stored, expectedRevision, version.table, version.sequence);
      });
    },

    async publish(companyId, actorId, input, now) {
      return updateFixture(path, (data) => {
        const stored = storedOf(companyOf(data, companyId));
        const earlier = stored.versions.find((version) => version.publishKey === input.publishKey);
        if (earlier) {
          if (earlier.reason !== input.reason) throw new PricesError('publish_key_used');
          return { version: meta(earlier), workingCopy: workingView(stored), replayed: true };
        }
        const working = stored.workingCopy;
        if (!working || working.revision !== input.expectedRevision) {
          throw new PricesError('stale_revision', undefined, working?.revision ?? 0);
        }
        const last = latest(stored);
        if (!last && input.rangeChoice === undefined) throw new PricesError('range_choice_required');
        const kept = storedTable(working.content);
        const table =
          input.rangeChoice === undefined ? kept : parseInput({ ...kept, policy: { ...kept.policy, estimate_mode: input.rangeChoice } });
        const check = checkTable(table as unknown as Json, input.confirmZeroPrices);
        if (!check.ok) throw new PricesError('not_publishable', check.error);
        const hash = contentHash(table);
        if (last && last.contentHash === hash) throw new PricesError('no_changes');
        let source: PriceSource = 'blank';
        const base = stored.versions.find((version) => version.sequence === working.baseSequence);
        if (base?.contentHash === hash) source = 'restore';
        else if (working.importedRevision === working.revision) source = 'import';
        const row: StoredVersion = {
          id: randomUUID(),
          sequence: (last?.sequence ?? 0) + 1,
          content: table,
          contentHash: hash,
          engineVersion: ENGINE_VERSION,
          reason: input.reason,
          source,
          publishedBy: actorId,
          publishedAt: now.toISOString(),
          publishKey: input.publishKey,
        };
        stored.versions.push(row);
        const saved = replaceWorking(stored, working.revision, table, row.sequence);
        return { version: meta(row), workingCopy: saved, replayed: false };
      });
    },
  };
}
