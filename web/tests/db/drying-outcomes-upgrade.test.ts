import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { openDatabase } from '@/db/client';
import { applyMigrations, migrationsDirectory, readMigrations } from '@/db/migrate';
import { capabilitiesFor } from '@/lib/access/can';
import { signedRecordBytes, SIGNED_FORMAT, type SignedRecord } from '@/lib/agreements/record';
import { agreementsService } from '@/lib/agreements/service';
import { PROPOSAL_FORMAT, type Proposal } from '@/lib/estimates/proposal';
import { canonicalJson } from '@/lib/field/canonical';
import { jobsService } from '@/lib/jobs/service';
import { fakeDrafts } from './draft-fake';
import { digestOf, newJob, seedJob } from './job-harness';
import { createDiscardDatabase, emptyDiscardDatabase, loginUrl } from './postgres-harness';
import { agreementOf, bytesOf, newSubmission, seedCommitted, seedEstimate, seedPin, seedSignature, seedVersion } from './submission-harness';
import { fakeField, memoryBacking } from '../submissions/field-fake';

// S5b-10 slice 10A: migration 0020 applied to a database that already holds a signed job and a draft
// (beside drying-outcomes-tables.test.ts, which holds the tables' own checks; split for the file-length limit).
// The migration on a database of the roles server built up to 0019 by the migrator (not a superuser,
// so forced row-level security binds it), holding a signed job and a draft from before the change.
describe('migration 0020: applied to an existing database', () => {
  let database: Awaited<ReturnType<typeof createDiscardDatabase>> | null = null;

  afterAll(async () => {
    await database?.drop();
  });

  it('leaves an earlier signed job and draft as they were, with no sidecar rows and no watch', async () => {
    const shared = inject('dryscopeDatabases');
    database = await createDiscardDatabase(shared.rolesUrl);
    await emptyDiscardDatabase(database.databaseUrl);
    const admin = postgres(database.databaseUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
    const dir = await mkdtemp(join(tmpdir(), 'dryscope-mig-'));
    try {
      await admin.unsafe('GRANT USAGE ON SCHEMA public TO PUBLIC');
      await admin.unsafe(`GRANT CREATE ON SCHEMA public TO ${shared.roles.migrator.name}`);
      const migratorUrl = loginUrl(database.databaseUrl, shared.roles.migrator);
      const earlier = (await readMigrations(migrationsDirectory)).filter((file) => file.id < '0020');
      await Promise.all(earlier.map((file) => writeFile(join(dir, `${file.id}.sql`), file.sql)));
      await applyMigrations(migratorUrl, dir);

      await admin`INSERT INTO auth_tenants (id, kind) VALUES ('tenant-existing', 'company')`;
      const [company] = await admin<{ id: string }[]>`INSERT INTO companies (name, sign_in_slug, auth_tenant_id) VALUES ('Existing', 'existing', 'tenant-existing') RETURNING id`;
      const [actor] = await admin<{ id: string }[]>`
        INSERT INTO actors (company_id, auth_tenant_id, uid, email) VALUES (${company!.id}, 'tenant-existing', 'u1', 'u1@example.test') RETURNING id
      `;
      // A signed job (its whole chain and its original agreement, its documents bytes a signed record the app
      // reads), with office notes, and a draft job.
      const proposal = { format: PROPOSAL_FORMAT, heading: 'Existing proposal' } as unknown as Proposal;
      const seededJob = await seedJob(admin, newJob(company!.id, actor!.id));
      const version = await seedVersion(admin, company!.id, actor!.id);
      const submission = await seedCommitted(admin, newSubmission(company!.id, seededJob.id, actor!.id));
      const pin = await seedPin(admin, { company: company!.id, job: seededJob.id, version: version.id, actor: actor!.id });
      const proposalBytes = bytesOf(canonicalJson(proposal));
      const estimate = await seedEstimate(admin, { company: company!.id, job: seededJob.id, submission: submission.id, pin, actor: actor!.id, hash: version.hash, proposal: proposalBytes });
      const signature = await seedSignature(admin, company!.id, seededJob.id, actor!.id);
      const chain = { company: company!.id, actor: actor!.id, job: seededJob, version, submission, pin, estimate, signature };
      const agreementId = randomUUID();
      const record: SignedRecord = {
        format: SIGNED_FORMAT,
        agreement_id: agreementId,
        job_id: seededJob.id,
        kind: 'original',
        signed_at: '2026-11-18T18:00:00.000Z',
        signer: { name: 'Pat Customer' },
        signed_with: { kind: 'device', presented_by: { actor_id: actor!.id, name: 'Owner' } },
        signature: { id: signature, sha256: digestOf('signature'), content_type: 'image/png' },
        proposal_sha256: proposalBytes.sha,
        proposal,
        documents: { itemized_claim: [], letter: 'Synthetic letter.', photo_log: [], claim: {}, compliance_notes: [] },
        basis: { estimate_id: estimate.id, submission_id: submission.id },
      };
      const a = agreementOf(chain, { id: agreementId });
      await admin`
        INSERT INTO agreements (id, company_id, job_id, submission_id, estimate_id, kind, signer_kind, signer_name, signature_evidence_id, proposal_sha256, priced_result,
                                version_id, content_hash, engine_version, documents_bytes, request_digest, created_by_actor_id)
        SELECT ${a.id}, ${a.company}, ${a.job}, ${a.submission}, ${a.estimate}, 'original', 'device', 'Pat Customer', ${a.signature}, ${a.proposalSha}, e.priced_result,
               ${a.version}, ${a.hash}, e.engine_version, ${signedRecordBytes(record)}, ${digestOf(a.id)}, ${a.actor}
        FROM job_estimates e WHERE e.id = ${a.estimate}
      `;
      await admin`UPDATE jobs SET status = 'signed', revision = revision + 1 WHERE id = ${chain.job.id}`;
      await admin`INSERT INTO job_coordination (company_id, job_id, office_notes) VALUES (${company!.id}, ${chain.job.id}, 'Gate code 4411')`;
      const draft = await seedJob(admin, newJob(company!.id, actor!.id));
      const snapshot = () =>
        Promise.all([
          admin`SELECT id, status, revision, current_draft_id, updated_at FROM jobs ORDER BY id`,
          admin`SELECT id, priced_result, documents_bytes, proposal_sha256, signed_at FROM agreements`,
          admin`SELECT company_id, job_id, office_notes, revision, updated_at FROM job_coordination`,
        ]);
      const before = await snapshot();

      expect((await applyMigrations(migratorUrl, migrationsDirectory)).applied).toEqual(['0020_drying_outcomes']);
      expect(await snapshot()).toEqual(before);
      expect(await admin`SELECT drying_watch FROM job_coordination`).toEqual([{ drying_watch: null }]);
      expect(
        await admin`SELECT (SELECT count(*)::int FROM drying_readings) AS readings, (SELECT count(*)::int FROM job_closes) AS closes, (SELECT count(*)::int FROM estimate_history) AS history`,
      ).toEqual([{ readings: 0, closes: 0, history: 0 }]);
      // Both jobs still open: each reads as before through the app's own services, as the runtime role.
      const handle = openDatabase({ APP_ENV: 'test', DATABASE_URL: loginUrl(database.databaseUrl, shared.roles.api) });
      try {
        const caller = { companyId: company!.id, actorId: actor!.id, uid: 'u1', role: 'owner' as const, capabilities: capabilitiesFor('owner', { priceBooks: false }) };
        const backing = memoryBacking();
        const jobs = jobsService(handle.db, fakeDrafts(backing), fakeField(backing));
        expect((await jobs.read(caller, chain.job.id)).job).toMatchObject({ id: chain.job.id, status: 'signed' });
        expect((await jobs.read(caller, draft.id)).job).toMatchObject({ id: draft.id, status: 'draft' });
        const signed = await agreementsService(handle.db).read(caller, chain.job.id);
        expect(signed.job).toMatchObject({ id: chain.job.id, status: 'signed' });
        expect(signed.agreement?.id).toBe(agreementId);
        expect(signed.agreement?.record).toEqual(record);
        expect((await jobs.list(caller, { scope: null, limit: 50, cursor: null })).jobs.map((job) => job.id).sort()).toEqual([chain.job.id, draft.id].sort());
      } finally {
        await handle.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
      await admin.end({ timeout: 5 });
    }
  });
});
