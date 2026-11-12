import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type postgres from 'postgres';
import type { CompanyTransaction } from '@/db/tenant';
import type { Harness } from './team-harness';

// Shared by the migration 0010 tests (S5a-2): error codes, a job seeded or inserted the way S5a-3's
// routes will, and the evidence rows S5a-5 will register.
export const INSUFFICIENT_PRIVILEGE = '42501';
export const CHECK_VIOLATION = '23514';
export const UNIQUE_VIOLATION = '23505';
export const FOREIGN_KEY_VIOLATION = '23503';
export const READ_ONLY_TRANSACTION = '25006';

export async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    const found = error as { code?: string; cause?: { code?: string } };
    return found.code ?? found.cause?.code;
  }
  return undefined;
}

export const digestOf = (text: string) => createHash('sha256').update(text).digest('hex');
export const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type JobInput = {
  id: string;
  company: string;
  actor: string;
  draft: string;
  digest: string;
  address?: string;
  status?: string;
  revision?: number;
  owner?: string | null;
};

export const newJob = (company: string, actor: string, extra: Partial<JobInput> = {}): JobInput => ({
  id: randomUUID(),
  company,
  actor,
  draft: randomUUID(),
  digest: digestOf(randomUUID()),
  ...extra,
});

// The company's own owner, for a job it creates.
export const ownerOf = (h: Harness, company: string) => (company === h.seed.a ? h.seed.ownerA.actor : h.seed.ownerB.actor);

export const insertJob = (tx: CompanyTransaction, j: JobInput) =>
  tx.execute(sql`
    INSERT INTO jobs (id, company_id, created_by_actor_id, field_owner_actor_id, status, current_draft_id, property_address, revision, request_digest)
    VALUES (${j.id}::uuid, ${j.company}::uuid, ${j.actor}::uuid, ${j.owner ?? null}::uuid, ${j.status ?? 'draft'}, ${j.draft}::uuid,
            ${j.address ?? ''}, ${j.revision ?? 1}, ${j.digest})
    RETURNING id::text, revision
  `) as unknown as Promise<{ id: string; revision: number }[]>;

export async function seedJob(admin: postgres.Sql, j: JobInput): Promise<JobInput> {
  await admin`
    INSERT INTO jobs (id, company_id, created_by_actor_id, field_owner_actor_id, status, current_draft_id, property_address, revision, request_digest)
    VALUES (${j.id}, ${j.company}, ${j.actor}, ${j.owner ?? null}, ${j.status ?? 'draft'}, ${j.draft}, ${j.address ?? ''}, ${j.revision ?? 1}, ${j.digest})
  `;
  return j;
}

export type EvidenceInput = {
  company: string;
  job: string;
  actor: string;
  objectId: string;
  kind?: string;
  name?: string;
  generation?: number | string;
  sha?: string;
  size?: number;
  type?: string;
};

export const photoName = (company: string, job: string, objectId: string, folder = 'photos') =>
  `companies/${company}/jobs/${job}/${folder}/${objectId}`;

export const newEvidence = (company: string, job: string, actor: string, extra: Partial<EvidenceInput> = {}): EvidenceInput => ({
  company,
  job,
  actor,
  objectId: randomUUID(),
  ...extra,
});

export const insertEvidence = (tx: CompanyTransaction, e: EvidenceInput) =>
  tx.execute(sql`
    INSERT INTO evidence_objects (company_id, job_id, object_id, kind, object_name, generation, sha256, size_bytes, content_type, created_by_actor_id)
    VALUES (${e.company}::uuid, ${e.job}::uuid, ${e.objectId}::uuid, ${e.kind ?? 'photo'},
            ${e.name ?? photoName(e.company, e.job, e.objectId)}, ${String(e.generation ?? 1731400000000000)}::bigint,
            ${e.sha ?? digestOf(e.objectId)}, ${e.size ?? 2048}, ${e.type ?? 'image/jpeg'}, ${e.actor}::uuid)
    RETURNING id::text
  `) as unknown as Promise<{ id: string }[]>;

export async function seedEvidence(admin: postgres.Sql, e: EvidenceInput): Promise<void> {
  await admin`
    INSERT INTO evidence_objects (company_id, job_id, object_id, kind, object_name, generation, sha256, size_bytes, content_type, created_by_actor_id)
    VALUES (${e.company}, ${e.job}, ${e.objectId}, ${e.kind ?? 'photo'}, ${e.name ?? photoName(e.company, e.job, e.objectId)},
            ${String(e.generation ?? 1731400000000000)}, ${e.sha ?? digestOf(e.objectId)}, ${e.size ?? 2048}, ${e.type ?? 'image/jpeg'}, ${e.actor})
  `;
}
