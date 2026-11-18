import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, gt, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { agreements, auditEvents, evidenceObjects, jobSubmissions } from '@/db/schema';
import { withOperator, type CompanyTransaction, type Database } from '@/db/tenant';
import { objectIdsOf, type PhotoKind } from '@/lib/photos/service';
import type { DraftMarks, EvidenceObjects, ObjectStat } from './stores';

// The records check after a restore (S8-3, docs/plans/S8/S8-3.md). For one company, read-only, it
// compares the stores that must agree and says where they do not; it repairs nothing, because after
// a restore a person decides. Only the platform operator runs it (operatorRoute, fresh sign-in).
//
// A run is a series of pages, each bounded. The first page (no run id) starts the run: once the
// operator and the company are admitted, and before anything is compared, it writes the run's one
// audit row, which carries the new run id. Every later page names that run and its cursor, and is
// answered only while the operator's audit row for that run is under RUN_HOURS old. Each page
// covers one part, in this order:
//
//   committed   committed submissions whose draft does not carry the `submitted` mark of that
//               submission and its epoch (`archived` keeps the fence, so an archived draft counts as marked)
//   marks       drafts that carry a mark (`submitted`, or `archived` with a fence) with no committed
//               submission of that draft and epoch behind it, as after Postgres is restored to an earlier time
//   pending     `pending` submissions past their expiry
//   evidence    registry rows against the generation of the object they registered, which is the
//               one the photo routes read: missing, another size or another stored SHA-256
//   objects     names under the company's folder that the bucket holds a readable generation of,
//               live or kept, with no registry row, each counted once; an id is given only when the
//               name is the app's shape (objectIdsOf)
//   signatures  signed agreements whose signature object is missing or differs from its row
//
// The answer holds counts and ids only: never a name, an address or an object path. Postgres is read
// in read-only operator transactions with the company set (the 0003 policies; no write policy lets
// an operator change these tables), and no transaction is held across a Firestore or bucket call.

export const PARTS = [
  'committed',
  'marks',
  'pending',
  'evidence',
  'objects',
  'signatures',
] as const;
export type Part = (typeof PARTS)[number];

export const FINDINGS = [
  'committedWithoutMark',
  'markWithoutCommitted',
  'pendingPastExpiry',
  'rowWithoutObject',
  'sizeDiffers',
  'checksumDiffers',
  'objectWithoutRow',
  'agreementWithoutSignature',
] as const;
export type FindingKind = (typeof FINDINGS)[number];

export type ObjectKey = { jobId: string; kind: PhotoKind; objectId: string };
export type Finding = { count: number; ids: (string | ObjectKey)[] };

// Where the next page starts: after this id in that part, or for the objects part after the last
// object name listed, sealed (sealName) so the answer never holds a path.
export type Sealed = { sealed: string };
export type Cursor = { part: Part; after: string | Sealed | null };

export type CheckPage = {
  runId: string;
  part: Part;
  // How many rows, drafts or objects this page looked at.
  checked: number;
  found: Record<FindingKind, Finding>;
  // The cursor for the next page, or null when the run is complete.
  next: Cursor | null;
};

// How long a run's pages may follow its first one.
export const RUN_HOURS = 1;

export const PAGE_SIZES = { rows: 100, stats: 50, objects: 200 };
const STAT_CONCURRENCY = 8;

export const RECORDS_CHECK_ERRORS = {
  not_found: 404,
  // No run of this operator for this company with that id, or it is over RUN_HOURS old.
  run_not_found: 404,
  // A sealed objects cursor that this run did not seal, or that was changed.
  bad_cursor: 400,
} as const;
export type RecordsCheckErrorCode = keyof typeof RECORDS_CHECK_ERRORS;

export class RecordsCheckError extends Error {
  readonly status: number;
  constructor(readonly code: RecordsCheckErrorCode) {
    super(`Records check refused: ${code}`);
    this.name = 'RecordsCheckError';
    this.status = RECORDS_CHECK_ERRORS[code];
  }
}

const IS_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The objects part continues from exactly the last name it listed, whatever its shape, so a page
// never counts an object twice or skips one written meanwhile. That name may be a path, so the cursor
// holds it sealed (AES-256-GCM) with the run's own random key, kept in the run's audit row and read
// back by the server only; the sealed value is bound to the run and the company.
function sealName(key: Buffer, bound: string, name: string): Sealed {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(bound));
  const body = Buffer.concat([cipher.update(name, 'utf8'), cipher.final()]);
  return { sealed: Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64url') };
}

function openName(key: Buffer, bound: string, sealed: Sealed): string {
  try {
    const bytes = Buffer.from(sealed.sealed, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(bound));
    decipher.setAuthTag(bytes.subarray(bytes.length - 16));
    return Buffer.concat([decipher.update(bytes.subarray(12, bytes.length - 16)), decipher.final()]).toString('utf8');
  } catch {
    throw new RecordsCheckError('bad_cursor');
  }
}

const MARKED_STATES = new Set(['submitted', 'archived']);

type Registered = { objectName: string; generation: bigint; sha256: string; sizeBytes: number };

// What differs between a registry row and the generation it registered; empty when they agree.
function differences(row: Registered, live: ObjectStat | null): FindingKind[] {
  if (live === null) return ['rowWithoutObject'];
  const found: FindingKind[] = [];
  if (live.sizeBytes !== row.sizeBytes) found.push('sizeDiffers');
  if (live.sha256 !== row.sha256) found.push('checksumDiffers');
  return found;
}

async function mapLimited<T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function emptyFindings(): Record<FindingKind, Finding> {
  return Object.fromEntries(
    FINDINGS.map((kind) => [kind, { count: 0, ids: [] }]),
  ) as unknown as Record<FindingKind, Finding>;
}

const firstOf = (part: Part): Cursor => ({ part, after: null });
const partAfter = (part: Part): Cursor | null => {
  const following = PARTS[PARTS.indexOf(part) + 1];
  return following === undefined ? null : firstOf(following);
};

// A part read row by row in id order: the next page starts after the last id, or the next part
// starts when this one is done.
function nextById(part: Part, ids: string[], more: boolean): Cursor | null {
  return more ? { part, after: ids[ids.length - 1]! } : partAfter(part);
}

const afterId = (cursor: Cursor): string | null =>
  typeof cursor.after === 'string' ? cursor.after : null;

type PartResult = {
  checked: number;
  found: Partial<Record<FindingKind, (string | ObjectKey)[]>>;
  next: Cursor | null;
  // Objects with no row whose name gives no safe id: counted, never named.
  unnamedOrphans?: number;
};

// A run's first page, or a later page of that run from the cursor the previous page answered.
export type RecordsCheckInput = Record<string, never> | { runId: string; next: Cursor };

export function recordsCheckService(
  db: Database,
  marks: DraftMarks,
  objects: EvidenceObjects,
  sizes = PAGE_SIZES,
) {
  const read = <T>(
    operatorId: string,
    companyId: string,
    run: (tx: CompanyTransaction) => Promise<T>,
  ) => withOperator(db, operatorId, run, { companyId, readOnly: true });

  // The company exists and, for a later page, the run is this operator's and still open; answers
  // the run's cursor key.
  async function admitted(
    tx: CompanyTransaction,
    operatorId: string,
    companyId: string,
    runId: string | undefined,
  ): Promise<Buffer | null> {
    const [company] = (await tx.execute(
      sql`SELECT 1 AS one FROM companies WHERE id = ${companyId}::uuid`,
    )) as unknown as unknown[];
    if (!company) throw new RecordsCheckError('not_found');
    if (runId === undefined) return null;
    const [run] = await tx
      .select({ cursorKey: sql<string | null>`${auditEvents.details} ->> 'cursorKey'` })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.companyId, companyId),
          eq(auditEvents.operatorActorId, operatorId),
          eq(auditEvents.action, 'records_check_run'),
          sql`${auditEvents.details} ->> 'runId' = ${runId}`,
          sql`${auditEvents.createdAt} > now() - make_interval(hours => ${RUN_HOURS})`,
        ),
      )
      .limit(1);
    if (!run || run.cursorKey === null) throw new RecordsCheckError('run_not_found');
    return Buffer.from(run.cursorKey, 'base64url');
  }

  async function registryRows(tx: CompanyTransaction, companyId: string, after: string | null) {
    const conditions: (SQL | undefined)[] = [
      eq(evidenceObjects.companyId, companyId),
      after === null ? undefined : gt(evidenceObjects.id, after),
    ];
    return tx
      .select({
        id: evidenceObjects.id,
        objectName: evidenceObjects.objectName,
        generation: evidenceObjects.generation,
        sha256: evidenceObjects.sha256,
        sizeBytes: evidenceObjects.sizeBytes,
      })
      .from(evidenceObjects)
      .where(and(...conditions))
      .orderBy(evidenceObjects.id)
      .limit(sizes.stats + 1);
  }

  async function part(
    operatorId: string,
    companyId: string,
    runId: string | undefined,
    cursor: Cursor,
  ): Promise<PartResult> {
    const after = afterId(cursor);
    switch (cursor.part) {
      case 'committed': {
        const rows = await read(operatorId, companyId, async (tx) => {
          await admitted(tx, operatorId, companyId, runId);
          return tx
            .select({
              id: jobSubmissions.id,
              draftId: jobSubmissions.draftId,
              epoch: jobSubmissions.epoch,
            })
            .from(jobSubmissions)
            .where(
              and(
                eq(jobSubmissions.companyId, companyId),
                eq(jobSubmissions.status, 'committed'),
                after === null ? undefined : gt(jobSubmissions.id, after),
              ),
            )
            .orderBy(jobSubmissions.id)
            .limit(sizes.rows + 1);
        });
        const page = rows.slice(0, sizes.rows);
        const seen = await marks.marksOf(companyId, [...new Set(page.map((row) => row.draftId))]);
        const unmarked = page.filter((row) => {
          const mark = seen.get(row.draftId);
          return !(
            mark &&
            mark.submissionId === row.id &&
            mark.epoch === row.epoch &&
            mark.state !== null &&
            MARKED_STATES.has(mark.state)
          );
        });
        return {
          checked: page.length,
          found: { committedWithoutMark: unmarked.map((row) => row.id) },
          next: nextById(
            'committed',
            page.map((row) => row.id),
            rows.length > sizes.rows,
          ),
        };
      }

      case 'marks': {
        await read(operatorId, companyId, (tx) => admitted(tx, operatorId, companyId, runId));
        const { drafts, more } = await marks.page(companyId, after, sizes.rows);
        const marked = drafts.filter(
          (draft) =>
            draft.state === 'submitted' ||
            (draft.state === 'archived' && draft.submissionId !== null),
        );
        const named = marked
          .map((draft) => draft.submissionId)
          .filter((id): id is string => id !== null && IS_UUID.test(id));
        const committed =
          named.length === 0
            ? []
            : await read(operatorId, companyId, (tx) =>
                tx
                  .select({
                    id: jobSubmissions.id,
                    draftId: jobSubmissions.draftId,
                    epoch: jobSubmissions.epoch,
                  })
                  .from(jobSubmissions)
                  .where(
                    and(
                      eq(jobSubmissions.companyId, companyId),
                      eq(jobSubmissions.status, 'committed'),
                      inArray(jobSubmissions.id, named),
                    ),
                  ),
              );
        const behind = new Set(committed.map((row) => `${row.draftId}/${row.id}/${row.epoch}`));
        const unbacked = marked.filter(
          (draft) => !behind.has(`${draft.id}/${draft.submissionId}/${draft.epoch}`),
        );
        return {
          checked: drafts.length,
          found: { markWithoutCommitted: unbacked.map((draft) => draft.id) },
          next: nextById(
            'marks',
            drafts.map((draft) => draft.id),
            more,
          ),
        };
      }

      case 'pending': {
        const rows = await read(operatorId, companyId, async (tx) => {
          await admitted(tx, operatorId, companyId, runId);
          return tx
            .select({ id: jobSubmissions.id })
            .from(jobSubmissions)
            .where(
              and(
                eq(jobSubmissions.companyId, companyId),
                eq(jobSubmissions.status, 'pending'),
                lte(jobSubmissions.expiresAt, sql`now()`),
                after === null ? undefined : gt(jobSubmissions.id, after),
              ),
            )
            .orderBy(jobSubmissions.id)
            .limit(sizes.rows + 1);
        });
        const page = rows.slice(0, sizes.rows);
        const ids = page.map((row) => row.id);
        return {
          checked: page.length,
          found: { pendingPastExpiry: ids },
          next: nextById('pending', ids, rows.length > sizes.rows),
        };
      }

      case 'evidence': {
        const rows = await read(operatorId, companyId, async (tx) => {
          await admitted(tx, operatorId, companyId, runId);
          return registryRows(tx, companyId, after);
        });
        const page = rows.slice(0, sizes.stats);
        const live = await mapLimited(page, STAT_CONCURRENCY, (row) =>
          objects.stat(row.objectName, row.generation),
        );
        const found: Partial<Record<FindingKind, string[]>> = {};
        page.forEach((row, index) => {
          for (const kind of differences(row, live[index]!)) (found[kind] ??= []).push(row.id);
        });
        return {
          checked: page.length,
          found,
          next: nextById(
            'evidence',
            page.map((row) => row.id),
            rows.length > sizes.stats,
          ),
        };
      }

      case 'objects': {
        const key = await read(operatorId, companyId, (tx) =>
          admitted(tx, operatorId, companyId, runId),
        );
        const bound = `${runId}/${companyId}`;
        const prefix = `companies/${companyId}/`;
        const sealed = cursor.after !== null && typeof cursor.after === 'object' ? cursor.after : null;
        const after = sealed === null ? null : openName(key!, bound, sealed);
        if (after !== null && !after.startsWith(prefix)) throw new RecordsCheckError('bad_cursor');
        const { names: page, more } = await objects.list(prefix, after, sizes.objects);
        const keys = page.map((name) => objectIdsOf(companyId, name));
        const registered =
          page.length === 0
            ? []
            : await read(operatorId, companyId, (tx) =>
                tx
                  .select({ objectName: evidenceObjects.objectName })
                  .from(evidenceObjects)
                  .where(
                    and(
                      eq(evidenceObjects.companyId, companyId),
                      inArray(evidenceObjects.objectName, page),
                    ),
                  ),
              );
        const known = new Set(registered.map((row) => row.objectName));
        const orphans = page.flatMap((name, index) =>
          keys[index] !== null && !known.has(name) ? [keys[index]!] : [],
        );
        const unnamedOrphans = page.filter(
          (name, index) => keys[index] === null && !known.has(name),
        ).length;

        const next: Cursor | null =
          more && page.length > 0
            ? { part: 'objects', after: sealName(key!, bound, page[page.length - 1]!) }
            : partAfter('objects');
        return {
          checked: page.length,
          found: { objectWithoutRow: orphans },
          unnamedOrphans,
          next,
        };
      }

      case 'signatures': {
        const rows = await read(operatorId, companyId, async (tx) => {
          await admitted(tx, operatorId, companyId, runId);
          return tx
            .select({
              id: agreements.id,
              objectName: evidenceObjects.objectName,
              generation: evidenceObjects.generation,
              sha256: evidenceObjects.sha256,
              sizeBytes: evidenceObjects.sizeBytes,
            })
            .from(agreements)
            .innerJoin(
              evidenceObjects,
              and(
                eq(evidenceObjects.companyId, agreements.companyId),
                eq(evidenceObjects.id, agreements.signatureEvidenceId),
              ),
            )
            .where(
              and(
                eq(agreements.companyId, companyId),
                after === null ? undefined : gt(agreements.id, after),
              ),
            )
            .orderBy(agreements.id)
            .limit(sizes.stats + 1);
        });
        const page = rows.slice(0, sizes.stats);
        const live = await mapLimited(page, STAT_CONCURRENCY, (row) =>
          objects.stat(row.objectName, row.generation),
        );
        const broken = page.filter((row, index) => differences(row, live[index]!).length > 0);
        return {
          checked: page.length,
          found: { agreementWithoutSignature: broken.map((row) => row.id) },
          next: nextById(
            'signatures',
            page.map((row) => row.id),
            rows.length > sizes.stats,
          ),
        };
      }
    }
  }

  return {
    // One page of a run. Without a run id it starts a run at the first part: once the operator and
    // the company are admitted, it writes the run's one audit row before anything is compared, so a
    // run whose first page fails is still audited.
    async check(
      operatorId: string,
      companyId: string,
      input: RecordsCheckInput,
    ): Promise<CheckPage> {
      let runId: string;
      let cursor: Cursor;
      if ('runId' in input) {
        runId = input.runId;
        cursor = input.next;
      } else {
        runId = randomUUID();
        // The run's own key for sealing the objects cursor; never in an answer or a log.
        const cursorKey = randomBytes(32).toString('base64url');
        cursor = firstOf(PARTS[0]);
        await withOperator(
          db,
          operatorId,
          async (tx) => {
            await admitted(tx, operatorId, companyId, undefined);
            await tx.insert(auditEvents).values({
              companyId,
              actorId: null,
              operatorActorId: operatorId,
              action: 'records_check_run',
              target: companyId,
              details: { runId, cursorKey },
            });
          },
          { companyId },
        );
      }
      const result = await part(operatorId, companyId, runId, cursor);
      const found = emptyFindings();
      for (const [kind, ids] of Object.entries(result.found) as [
        FindingKind,
        (string | ObjectKey)[],
      ][])
        found[kind] = { count: ids.length, ids };
      if (result.unnamedOrphans) found.objectWithoutRow.count += result.unnamedOrphans;
      return { runId, part: cursor.part, checked: result.checked, found, next: result.next };
    },
  };
}

export type RecordsCheckService = ReturnType<typeof recordsCheckService>;
