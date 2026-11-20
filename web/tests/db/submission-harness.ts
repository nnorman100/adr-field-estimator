import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type postgres from 'postgres';
import type { CompanyTransaction } from '@/db/tenant';
import { digestOf, newJob, seedJob, type JobInput } from './job-harness';

// Shared by the migration 0011 tests (S5a-7): a submission, a price version, a pin, an estimate and
// an agreement seeded or inserted the way S5a-8 to S5a-11's routes will.

export type Refusal = { code?: string; constraint?: string; message?: string };

// What the database refused with: the SQLSTATE, the constraint it named (a check or key) and the
// message (a trigger names its rule there), so a test can tell which rule fired.
export async function refusal(promise: Promise<unknown>): Promise<Refusal | undefined> {
  try {
    await promise;
  } catch (error) {
    const found = error as { code?: string; constraint_name?: string; message?: string; cause?: Refusal & { constraint_name?: string } };
    const pg = found.cause ?? found;
    return { code: pg.code, constraint: (pg as { constraint_name?: string }).constraint_name, message: pg.message };
  }
  return undefined;
}

export type Bytes = { bytes: Buffer; sha: string };
export const bytesOf = (text: string): Bytes => ({ bytes: Buffer.from(text), sha: digestOf(text) });

export type SubmissionInput = {
  id: string;
  company: string;
  job: string;
  draft: string;
  epoch: string;
  actor: string;
  kind?: 'original' | 'change_order' | 'revision';
  parent?: string | null;
  digest?: string;
  // Seconds from now the row expires; the default is a fence's 15 minutes.
  expiresIn?: number;
  // Seconds ago the row was made, to build one that has already expired.
  madeAgo?: number;
};

export const newSubmission = (company: string, job: string, actor: string, extra: Partial<SubmissionInput> = {}): SubmissionInput => ({
  id: randomUUID(),
  company,
  job,
  draft: randomUUID(),
  epoch: randomUUID(),
  actor,
  ...extra,
});

export const insertSubmission = (tx: CompanyTransaction, s: SubmissionInput) =>
  tx.execute(sql`
    INSERT INTO job_submissions (id, company_id, job_id, draft_id, epoch, kind, parent_agreement_id, request_digest, created_at, expires_at, created_by_actor_id)
    VALUES (${s.id}::uuid, ${s.company}::uuid, ${s.job}::uuid, ${s.draft}::uuid, ${s.epoch}::uuid, ${s.kind ?? 'original'}, ${s.parent ?? null}::uuid,
            ${s.digest ?? digestOf(s.id)}, now() - make_interval(secs => ${s.madeAgo ?? 0}), now() + make_interval(secs => ${s.expiresIn ?? 900}), ${s.actor}::uuid)
    RETURNING id::text, status, marker_state
  `) as unknown as Promise<{ id: string; status: string; marker_state: string }[]>;

export async function seedSubmission(admin: postgres.Sql, s: SubmissionInput): Promise<SubmissionInput> {
  await admin`
    INSERT INTO job_submissions (id, company_id, job_id, draft_id, epoch, kind, parent_agreement_id, request_digest, created_at, expires_at, created_by_actor_id)
    VALUES (${s.id}, ${s.company}, ${s.job}, ${s.draft}, ${s.epoch}, ${s.kind ?? 'original'}, ${s.parent ?? null}, ${s.digest ?? digestOf(s.id)},
            now() - make_interval(secs => ${s.madeAgo ?? 0}), now() + make_interval(secs => ${s.expiresIn ?? 900}), ${s.actor})
  `;
  return s;
}

// The conditional update Submit's commit makes: only a still pending row moves.
export const commitSubmission = (tx: CompanyTransaction, company: string, id: string, snapshot: Bytes = bytesOf(`snapshot ${id}`)) =>
  tx.execute(sql`
    UPDATE job_submissions SET status = 'committed', snapshot_bytes = ${snapshot.bytes}, snapshot_sha256 = ${snapshot.sha}
    WHERE company_id = ${company}::uuid AND id = ${id}::uuid AND status = 'pending'
    RETURNING id::text, status, decided_at
  `) as unknown as Promise<{ id: string; status: string; decided_at: string }[]>;

export const abortSubmission = (tx: CompanyTransaction, company: string, id: string) =>
  tx.execute(sql`
    UPDATE job_submissions SET status = 'aborted'
    WHERE company_id = ${company}::uuid AND id = ${id}::uuid AND status = 'pending'
    RETURNING id::text, status, decided_at
  `) as unknown as Promise<{ id: string; status: string; decided_at: string }[]>;

export async function seedCommitted(admin: postgres.Sql, s: SubmissionInput, snapshot: Bytes = bytesOf(`snapshot ${s.id}`)): Promise<SubmissionInput> {
  await seedSubmission(admin, s);
  await admin`
    UPDATE job_submissions SET status = 'committed', snapshot_bytes = ${snapshot.bytes}, snapshot_sha256 = ${snapshot.sha}
    WHERE company_id = ${s.company} AND id = ${s.id}
  `;
  return s;
}

export type SeededVersion = { id: string; sequence: number; hash: string; engine: string };

// A published price version, as the table owner would have it after S4-6's publish.
export async function seedVersion(
  admin: postgres.Sql,
  company: string,
  actor: string,
  extra: { sequence?: number; hash?: string; engine?: string } = {},
): Promise<SeededVersion> {
  const sequence =
    extra.sequence ??
    (await admin<{ next: number }[]>`SELECT coalesce(max(sequence), 0)::int + 1 AS next FROM price_table_versions WHERE company_id = ${company}`)[0]!.next;
  const hash = extra.hash ?? digestOf(`table ${company} ${sequence}`);
  const engine = extra.engine ?? 'dryscope-v3';
  const [row] = await admin<{ id: string }[]>`
    INSERT INTO price_table_versions (company_id, sequence, content, content_hash, engine_version, reason, source, published_by_actor_id, publish_key)
    VALUES (${company}, ${sequence}, '{}'::jsonb, ${hash}, ${engine}, 'Published for a test', 'blank', ${actor}, ${`publish-${company}-${sequence}`})
    RETURNING id::text
  `;
  return { id: row!.id, sequence, hash, engine };
}

export type PinInput = { company: string; job: string; version: string; actor: string; sequence?: number; reason?: string };

export const insertPin = (tx: CompanyTransaction, p: PinInput) =>
  tx.execute(sql`
    INSERT INTO job_price_pins (company_id, job_id, sequence, version_id, reason, pinned_by_actor_id)
    VALUES (${p.company}::uuid, ${p.job}::uuid, ${p.sequence ?? 1}, ${p.version}::uuid, ${p.reason ?? ((p.sequence ?? 1) === 1 ? 'first_price' : 'owner_reprice')}, ${p.actor}::uuid)
    RETURNING id::text, sequence
  `) as unknown as Promise<{ id: string; sequence: number }[]>;

export async function seedPin(admin: postgres.Sql, p: PinInput): Promise<string> {
  const sequence = p.sequence ?? 1;
  const [row] = await admin<{ id: string }[]>`
    INSERT INTO job_price_pins (company_id, job_id, sequence, version_id, reason, pinned_by_actor_id)
    VALUES (${p.company}, ${p.job}, ${sequence}, ${p.version}, ${p.reason ?? (sequence === 1 ? 'first_price' : 'owner_reprice')}, ${p.actor})
    RETURNING id::text
  `;
  return row!.id;
}

export type EstimateInput = {
  company: string;
  job: string;
  submission: string;
  pin: string;
  actor: string;
  hash: string;
  engine?: string;
  result?: Record<string, unknown>;
  proposal?: Bytes;
  // Overrides the stored SHA-256 of the proposal, to test one that does not match.
  proposalSha?: string;
};

export const pricedResult = { total: '1250.00', range: { low: '1100.00', high: '1400.00' }, lines: [{ item: 'dry', price_row: 'default' }] };

export const insertEstimate = (tx: CompanyTransaction, e: EstimateInput) => {
  const proposal = e.proposal ?? bytesOf(`proposal ${e.submission} ${e.pin}`);
  return tx.execute(sql`
    INSERT INTO job_estimates (company_id, job_id, submission_id, pin_id, table_hash, engine_version, priced_result, proposal_bytes, proposal_sha256, created_by_actor_id)
    VALUES (${e.company}::uuid, ${e.job}::uuid, ${e.submission}::uuid, ${e.pin}::uuid, ${e.hash}, ${e.engine ?? 'dryscope-v3'},
            ${JSON.stringify(e.result ?? pricedResult)}::text::jsonb, ${proposal.bytes}, ${e.proposalSha ?? proposal.sha}, ${e.actor}::uuid)
    RETURNING id::text
  `) as unknown as Promise<{ id: string }[]>;
};

export async function seedEstimate(admin: postgres.Sql, e: EstimateInput): Promise<{ id: string; proposal: Bytes }> {
  const proposal = e.proposal ?? bytesOf(`proposal ${e.submission} ${e.pin}`);
  const [row] = await admin<{ id: string }[]>`
    INSERT INTO job_estimates (company_id, job_id, submission_id, pin_id, table_hash, engine_version, priced_result, proposal_bytes, proposal_sha256, created_by_actor_id)
    VALUES (${e.company}, ${e.job}, ${e.submission}, ${e.pin}, ${e.hash}, ${e.engine ?? 'dryscope-v3'},
            ${JSON.stringify(e.result ?? pricedResult)}::text::jsonb, ${proposal.bytes}, ${proposal.sha}, ${e.actor})
    RETURNING id::text
  `;
  return { id: row!.id, proposal };
}

// A signature object in the evidence registry, returning the registry id an agreement names.
export async function seedSignature(admin: postgres.Sql, company: string, job: string, actor: string, kind = 'signature'): Promise<string> {
  const objectId = randomUUID();
  const [row] = await admin<{ id: string }[]>`
    INSERT INTO evidence_objects (company_id, job_id, object_id, kind, object_name, generation, sha256, size_bytes, content_type, created_by_actor_id)
    VALUES (${company}, ${job}, ${objectId}, ${kind}, ${`companies/${company}/jobs/${job}/${kind}s/${objectId}`}, 1731400000000000, ${digestOf(objectId)}, 4096, 'image/png', ${actor})
    RETURNING id::text
  `;
  return row!.id;
}

export type AgreementInput = {
  id: string;
  company: string;
  job: string;
  submission: string;
  estimate: string;
  signature: string;
  actor: string;
  version: string;
  hash: string;
  proposalSha: string;
  kind?: 'original' | 'change_order' | 'revision';
  parent?: string | null;
  signerKind?: string;
  signerName?: string;
  engine?: string;
  result?: Record<string, unknown>;
  documents?: Buffer;
  digest?: string;
  // The signing link a `link` agreement was signed through (0014, S5a-11b).
  signingLink?: string | null;
  // The signer's role (0014): a link agreement's is `homeowner` unless given; a device one's is empty.
  signerRole?: string | null;
};

export const insertAgreement = (tx: CompanyTransaction, a: AgreementInput) =>
  tx.execute(sql`
    INSERT INTO agreements (id, company_id, job_id, submission_id, estimate_id, kind, parent_agreement_id, signer_kind, signer_name, signature_evidence_id,
                            proposal_sha256, priced_result, version_id, content_hash, engine_version, documents_bytes, request_digest, created_by_actor_id, signing_link_id,
                            signer_role)
    VALUES (${a.id}::uuid, ${a.company}::uuid, ${a.job}::uuid, ${a.submission}::uuid, ${a.estimate}::uuid, ${a.kind ?? 'original'}, ${a.parent ?? null}::uuid,
            ${a.signerKind ?? 'device'}, ${a.signerName ?? 'Pat Customer'}, ${a.signature}::uuid, ${a.proposalSha}, ${JSON.stringify(a.result ?? pricedResult)}::text::jsonb,
            ${a.version}::uuid, ${a.hash}, ${a.engine ?? 'dryscope-v3'}, ${a.documents ?? Buffer.from('{"documents":"as signed"}')}, ${a.digest ?? digestOf(a.id)}, ${a.actor}::uuid, ${a.signingLink ?? null}::uuid,
            ${a.signerRole !== undefined ? a.signerRole : a.signerKind === 'link' ? 'homeowner' : null})
    RETURNING id::text, signed_at
  `) as unknown as Promise<{ id: string; signed_at: string }[]>;

export type Chain = {
  company: string;
  actor: string;
  job: JobInput;
  version: SeededVersion;
  submission: SubmissionInput;
  pin: string;
  estimate: { id: string; proposal: Bytes };
  signature: string;
};

// A job with a committed submission, a version, its first pin, an estimate priced from that pin and a
// signature object: everything an agreement needs, written as the table owner. The submission is
// committed with the draft a later change order would not reuse.
export async function seedChain(admin: postgres.Sql, company: string, actor: string, job?: JobInput): Promise<Chain> {
  const seededJob = await seedJob(admin, job ?? newJob(company, actor));
  const version = await seedVersion(admin, company, actor);
  const submission = await seedCommitted(admin, newSubmission(company, seededJob.id, actor));
  const pin = await seedPin(admin, { company, job: seededJob.id, version: version.id, actor });
  const estimate = await seedEstimate(admin, { company, job: seededJob.id, submission: submission.id, pin, actor, hash: version.hash });
  const signature = await seedSignature(admin, company, seededJob.id, actor);
  return { company, actor, job: seededJob, version, submission, pin, estimate, signature };
}

export const agreementOf = (c: Chain, extra: Partial<AgreementInput> = {}): AgreementInput => ({
  id: randomUUID(),
  company: c.company,
  job: c.job.id,
  submission: c.submission.id,
  estimate: c.estimate.id,
  signature: c.signature,
  actor: c.actor,
  version: c.version.id,
  hash: c.version.hash,
  proposalSha: c.estimate.proposal.sha,
  ...extra,
});
