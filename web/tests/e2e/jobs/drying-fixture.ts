import { createHash } from 'node:crypto';
import { SNAPSHOT_FORMAT, snapshotBytes } from '@/lib/submissions/snapshot';
import {
  agreementOf,
  newSubmission,
  pricedResult,
  seedCommitted,
  seedEstimate,
  seedPin,
  seedSignature,
  seedVersion,
} from '../../db/submission-harness';
import { adminSql, type Company } from './seed';

// A pre-existing agreement with one signed room and a three-day drying plan, following archive-jobs.spec.ts.
export async function seedDryingAgreement(
  company: Company,
  jobId: string,
  draft: string,
  address: string,
) {
  const db = adminSql();
  const [person] = await db<
    { id: string }[]
  >`SELECT id::text FROM actors WHERE company_id = ${company.id} AND uid = ${company.people.owner!.uid}`;
  const actor = person!.id;
  const pending = newSubmission(company.id, jobId, actor, { draft });
  const { bytes, sha256 } = snapshotBytes({
    format: SNAPSHOT_FORMAT,
    submissionId: pending.id,
    jobId,
    draftId: draft,
    fieldSha256: 'a'.repeat(64),
    field: {
      draft: { dryingDays: 3, roomOrder: ['kitchen'] },
      rooms: [{ id: 'kitchen', field: { name: 'Kitchen' } }],
      photos: [],
    },
    photos: [],
    job: { propertyAddress: address },
    customer: { name: '', phone: '', email: '' },
    claim: {},
  });
  const submission = await seedCommitted(db, pending, { bytes, sha: sha256 });
  const version = await seedVersion(db, company.id, actor);
  const pin = await seedPin(db, { company: company.id, job: jobId, version: version.id, actor });
  const estimate = await seedEstimate(db, {
    company: company.id,
    job: jobId,
    submission: submission.id,
    pin,
    actor,
    hash: version.hash,
  });
  const signature = await seedSignature(db, company.id, jobId, actor);
  const a = agreementOf({
    company: company.id,
    actor,
    job: { id: jobId } as never,
    version,
    submission,
    pin,
    estimate,
    signature,
  });
  await db`
    INSERT INTO agreements (id, company_id, job_id, submission_id, estimate_id, kind, signer_kind, signer_name, signature_evidence_id, proposal_sha256,
                            priced_result, version_id, content_hash, engine_version, documents_bytes, request_digest, created_by_actor_id)
    VALUES (${a.id}, ${a.company}, ${a.job}, ${a.submission}, ${a.estimate}, 'original', 'device', 'Pat Customer', ${a.signature}, ${a.proposalSha},
            ${JSON.stringify(pricedResult)}::text::jsonb, ${a.version}, ${a.hash}, 'dryscope-v3', ${Buffer.from('{"documents":"as signed"}')},
            ${createHash('sha256').update(a.id).digest('hex')}, ${a.actor})
  `;
  await db`UPDATE jobs SET status = 'signed', revision = revision + 1 WHERE id = ${jobId}`;
  await db`INSERT INTO company_feature_flags (company_id, flag, enabled) VALUES (${company.id}, 'drying_watch', true)`;
}
