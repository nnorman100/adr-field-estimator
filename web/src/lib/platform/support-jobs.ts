import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { and, asc, desc, eq, or, sql, type SQL } from 'drizzle-orm';
import { auditEvents, evidenceObjects, jobCustomers, jobs } from '@/db/schema';
import { withOperator, type CompanyTransaction, type Database } from '@/db/tenant';
import { originalAgreementView, type AgreementView } from '@/lib/agreements/service';
import { decodeCursor, detailOf, encodeCursor, type ClaimView, type CustomerView, type JobListItem, type JobView } from '@/lib/jobs/service';
import type { PhotoKind } from '@/lib/photos/service';
import type { EvidenceStore } from '@/lib/photos/store';
import { PlatformError, type CompanyStatus, type CompanyView } from './service';

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

export type SupportPhoto = { body: WebReadableStream<Uint8Array>; contentType: string; sizeBytes: number };

export type SupportJobsService = {
  jobs(operatorId: string, companyId: string, page: { limit: number; cursor: string | null }): Promise<{ company: CompanyView; jobs: SupportJobListItem[]; nextCursor: string | null }>;
  job(operatorId: string, companyId: string, jobId: string): Promise<SupportJobView>;
  photo(operatorId: string, companyId: string, jobId: string, photoId: string, kind: PhotoKind): Promise<SupportPhoto>;
};

type CompanyRow = { id: string; name: string; sign_in_slug: string | null; status: CompanyStatus; auth_tenant_id: string | null; created_at: string };

async function companyOf(tx: CompanyTransaction, companyId: string): Promise<CompanyView> {
  const [row] = (await tx.execute(sql`
    SELECT id::text, name, sign_in_slug, status, auth_tenant_id, created_at FROM companies WHERE id = ${companyId}::uuid
  `)) as unknown as CompanyRow[];
  if (!row) throw new PlatformError('not_found');
  return {
    id: row.id,
    name: row.name,
    signInSlug: row.sign_in_slug,
    status: row.status,
    tenantBound: row.auth_tenant_id !== null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export function supportJobsService(db: Database, store: EvidenceStore): SupportJobsService {
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
    const seen = await withOperator(db, operatorId, read, { companyId, readOnly: true });
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
          const company = await companyOf(tx, companyId);
          const where: SQL[] = [eq(jobs.companyId, companyId)];
          if (after) {
            where.push(
              or(
                sql`${jobs.createdAt} < ${after.time}::timestamptz`,
                and(sql`${jobs.createdAt} = ${after.time}::timestamptz`, sql`${jobs.id} > ${after.id}::uuid`),
              )!,
            );
          }
          const rows = await tx
            .select({ job: jobs, createdKey: sql<string>`${jobs.createdAt}::text`, customerName: jobCustomers.name })
            .from(jobs)
            .leftJoin(jobCustomers, and(eq(jobCustomers.companyId, jobs.companyId), eq(jobCustomers.jobId, jobs.id)))
            .where(and(...where))
            .orderBy(desc(jobs.createdAt), asc(jobs.id))
            .limit(page.limit + 1);
          const shown = rows.slice(0, page.limit);
          const last = shown[shown.length - 1];
          return {
            company,
            jobs: shown.map(({ job, customerName }) => ({
              id: job.id,
              status: job.status,
              propertyAddress: job.propertyAddress,
              revision: job.revision,
              createdAt: job.createdAt.toISOString(),
              updatedAt: job.updatedAt.toISOString(),
              customerName: customerName ?? '',
            })),
            nextCursor: rows.length > page.limit && last ? encodeCursor(last.createdKey, last.job.id) : null,
          };
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
          const company = await companyOf(tx, companyId);
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
            .where(and(eq(evidenceObjects.companyId, companyId), eq(evidenceObjects.jobId, jobId)))
            .orderBy(asc(evidenceObjects.createdAt), asc(evidenceObjects.id));
          return {
            company,
            ...detail,
            agreement: await originalAgreementView(tx, companyId, jobId),
            evidence: evidence.map((found) => ({ ...found, createdAt: found.createdAt.toISOString() })),
          };
        },
        'support_job_viewed',
        jobId,
      );
    },

    // One registered object's bytes. The bucket is opened before the audit row is written, so a
    // missing object writes none; the bytes are answered only once the row committed.
    async photo(operatorId, companyId, jobId, photoId, kind) {
      const row = await withOperator(
        db,
        operatorId,
        async (tx) => {
          await companyOf(tx, companyId);
          const [found] = await tx
            .select({ objectName: evidenceObjects.objectName, generation: evidenceObjects.generation, contentType: evidenceObjects.contentType, sizeBytes: evidenceObjects.sizeBytes })
            .from(evidenceObjects)
            .where(and(eq(evidenceObjects.companyId, companyId), eq(evidenceObjects.jobId, jobId), eq(evidenceObjects.objectId, photoId), eq(evidenceObjects.kind, kind)));
          return found;
        },
        { companyId, readOnly: true },
      );
      if (!row) throw new PlatformError('not_found');
      const body = await store.open(row.objectName, row.generation);
      // A registered object that is not in the bucket is a fault, not a missing photo.
      if (!body) throw new SupportUnavailable();
      try {
        await audit(operatorId, companyId, 'support_photo_viewed', jobId, { photoId, kind });
      } catch (error) {
        await body.cancel().catch(() => {});
        throw error;
      }
      return { body, contentType: row.contentType, sizeBytes: row.sizeBytes };
    },
  };
}

export class SupportUnavailable extends Error {
  constructor() {
    super('support view unavailable');
    this.name = 'SupportUnavailable';
  }
}
