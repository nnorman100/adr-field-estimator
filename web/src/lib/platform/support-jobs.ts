import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { and, asc, eq, ne, or, sql, type SQL } from 'drizzle-orm';
import { auditEvents, evidenceObjects, jobs } from '@/db/schema';
import { withOperator, type CompanyTransaction, type Database } from '@/db/tenant';
import { originalAgreementView, type AgreementView } from '@/lib/agreements/service';
import { decodeCursor, detailOf, jobPage, type ClaimView, type CustomerView, type JobListItem, type JobView } from '@/lib/jobs/service';
import { sha256Of, sniffImageType } from '@/lib/photos/image';
import type { PhotoKind } from '@/lib/photos/service';
import type { EvidenceStore } from '@/lib/photos/store';
import { PlatformError, readCompany, type CompanyView } from './service';
import { signedRowProjections } from '@/lib/drying/projection';
import type { JobCaller } from '@/lib/jobs/access';

// The platform operator's read-only support view of a company's jobs (S5b-5; owner decision J8:
// platform operator only, read-only, audited). Three views: the company's jobs, one job (its header,
// customer, claim, signed agreement and evidence list) and one photo's bytes. Each reads in a
// read-only withOperator transaction with the company set, so migrations 0010 to 0016's read
// policies apply and every write policy there refuses an operator anyway; then one audit row naming
// the operator commits before anything is answered. A refused view (an unknown company or job, a
// job of another company, a photo that is not registered) writes none. Nothing here writes a
// company's data: there is no edit control.

export type SupportJobListItem = Omit<JobListItem, 'mine'>;

// A registry row as the support view shows it: ids, hash, size and type, never the object path.
export type EvidenceView = { photoId: string; kind: PhotoKind; sha256: string; sizeBytes: number; contentType: string; createdAt: string };

export type SupportJobView = {
  company: CompanyView;
  job: JobView;
  customer: CustomerView;
  claim: ClaimView;
  agreement: AgreementView | null;
  evidence: EvidenceView[];
};

export type SupportPhoto = { bytes: Uint8Array; contentType: string };

export type SupportJobsService = {
  jobs(operatorId: string, companyId: string, page: { limit: number; cursor: string | null }): Promise<{ company: CompanyView; jobs: SupportJobListItem[]; nextCursor: string | null }>;
  job(operatorId: string, companyId: string, jobId: string): Promise<SupportJobView>;
  photo(operatorId: string, companyId: string, jobId: string, photoId: string, kind: PhotoKind): Promise<SupportPhoto>;
};

// A signature image is the support view's only when a committed agreement of the job names it: a
// signature received for an agreement that never committed stays hidden from the list and the download.
const visibleEvidence = (companyId: string, jobId: string): SQL =>
  or(
    ne(evidenceObjects.kind, 'signature'),
    sql`${evidenceObjects.id} IN (SELECT signature_evidence_id FROM agreements WHERE company_id = ${companyId}::uuid AND job_id = ${jobId}::uuid)`,
  )!;

// The operator as the drying watch's projection sees them: read-only support, holding no company key, so
// the watch's action hints are all off.
const supportViewer = (companyId: string, operatorId: string): JobCaller => ({ companyId, actorId: operatorId, uid: '', role: 'office', capabilities: [] });

// `openStore` is called only when a photo's bytes are opened, so the views that read the database
// alone need no evidence bucket.
export function supportJobsService(db: Database, openStore: () => EvidenceStore): SupportJobsService {
  // One audit row naming the operator, ids only, in its own transaction.
  async function audit(operatorId: string, companyId: string, action: string, target: string, details: Record<string, string> = {}): Promise<void> {
    await withOperator(
      db,
      operatorId,
      async (tx) => {
        await tx.insert(auditEvents).values({ companyId, actorId: null, operatorActorId: operatorId, action, target, details });
      },
      { companyId },
    );
  }

  // Reads the view in a read-only transaction, then writes its one audit row; the view is answered
  // only once that row committed.
  async function viewed<T>(operatorId: string, companyId: string, read: (tx: CompanyTransaction) => Promise<T>, action: string, target: string): Promise<T> {
    const seen = await withOperator(db, operatorId, read, { companyId, readOnly: true, snapshot: true });
    await audit(operatorId, companyId, action, target);
    return seen;
  }

  return {
    // Every job of the company, archived ones included, newest first, in pages as the jobs list pages.
    async jobs(operatorId, companyId, page) {
      const after = page.cursor === null ? null : decodeCursor(page.cursor);
      return viewed(
        operatorId,
        companyId,
        async (tx) => {
          const company = await readCompany(tx, companyId);
          const { entries, nextCursor } = await jobPage(tx, [eq(jobs.companyId, companyId)], after, page.limit);
          // A signed row's close status and drying watch status, under the company's switches (S5b-10).
          const outcomes = await signedRowProjections(tx, companyId, entries.map(({ job }) => job), supportViewer(companyId, operatorId));
          return { company, jobs: entries.map(({ job, item }) => ({ ...item, ...outcomes.get(job.id) })), nextCursor };
        },
        'support_jobs_viewed',
        companyId,
      );
    },

    // One job as it stands, archived or not: header, customer, claim, its signed agreement as stored
    // and the evidence registry (photos, originals and signatures).
    async job(operatorId, companyId, jobId) {
      return viewed(
        operatorId,
        companyId,
        async (tx) => {
          const company = await readCompany(tx, companyId);
          const [row] = await tx.select().from(jobs).where(and(eq(jobs.companyId, companyId), eq(jobs.id, jobId)));
          if (!row) throw new PlatformError('not_found');
          const detail = await detailOf(tx, row);
          const evidence = await tx
            .select({
              photoId: evidenceObjects.objectId,
              kind: evidenceObjects.kind,
              sha256: evidenceObjects.sha256,
              sizeBytes: evidenceObjects.sizeBytes,
              contentType: evidenceObjects.contentType,
              createdAt: evidenceObjects.createdAt,
            })
            .from(evidenceObjects)
            .where(and(eq(evidenceObjects.companyId, companyId), eq(evidenceObjects.jobId, jobId), visibleEvidence(companyId, jobId)))
            .orderBy(asc(evidenceObjects.createdAt), asc(evidenceObjects.id));
          const outcome = (await signedRowProjections(tx, companyId, [row], supportViewer(companyId, operatorId))).get(row.id);
          return {
            company,
            ...detail,
            ...outcome,
            agreement: await originalAgreementView(tx, companyId, jobId),
            evidence: evidence.map((found) => ({ ...found, createdAt: found.createdAt.toISOString() })),
          };
        },
        'support_job_viewed',
        jobId,
      );
    },

    // One registered object's bytes. The bucket is read, within the registered size, and the bytes
    // checked against the registry's size, SHA-256 and image type before the audit row is written, so
    // a missing, unreadable or altered object writes none; the bytes are answered only once the row
    // committed.
    async photo(operatorId, companyId, jobId, photoId, kind) {
      const row = await withOperator(
        db,
        operatorId,
        async (tx) => {
          const [found] = await tx
            .select({
              objectName: evidenceObjects.objectName,
              generation: evidenceObjects.generation,
              contentType: evidenceObjects.contentType,
              sha256: evidenceObjects.sha256,
              sizeBytes: evidenceObjects.sizeBytes,
            })
            .from(evidenceObjects)
            .where(and(eq(evidenceObjects.companyId, companyId), eq(evidenceObjects.jobId, jobId), eq(evidenceObjects.objectId, photoId), eq(evidenceObjects.kind, kind), visibleEvidence(companyId, jobId)));
          return found;
        },
        { companyId, readOnly: true },
      );
      if (!row) throw new PlatformError('not_found');
      const body = await openStore().open(row.objectName, row.generation);
      // A registered object that is not in the bucket is a fault, not a missing photo.
      if (!body) throw new SupportUnavailable();
      const bytes = await readUpTo(body, row.sizeBytes);
      if (bytes.length !== row.sizeBytes || sha256Of(bytes) !== row.sha256 || sniffImageType(bytes) !== row.contentType) throw new SupportUnavailable();
      await audit(operatorId, companyId, 'support_photo_viewed', jobId, { photoId, kind });
      return { bytes, contentType: row.contentType };
    },
  };
}

// The stream's bytes, stopping at one byte past `limit` so an object larger than registered is never
// read whole.
async function readUpTo(body: WebReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total <= limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks, total);
}

export class SupportUnavailable extends Error {
  constructor() {
    super('support view unavailable');
    this.name = 'SupportUnavailable';
  }
}
