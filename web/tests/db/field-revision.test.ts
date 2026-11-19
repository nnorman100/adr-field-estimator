import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { openDatabase } from '@/db/client';
import { applyMigrations, migrationsDirectory, readMigrations } from '@/db/migrate';
import { withCompany, withOperator, type CompanyTransaction } from '@/db/tenant';
import { claimDraft } from '@/lib/jobs/access';
import { createDiscardDatabase, emptyDiscardDatabase, loginUrl, sharedRoles } from './postgres-harness';
import { unprotectedRelations } from './row-security-guard';
import { CHECK_VIOLATION, FOREIGN_KEY_VIOLATION, INSUFFICIENT_PRIVILEGE, errorCode, newJob, ownerOf, pause, seedJob } from './job-harness';
import { abortSubmission, insertSubmission, newSubmission } from './submission-harness';
import { resetTeamDatabase, startTeamServer, type Harness } from './team-harness';

// The draft life-cycle redesign, slice 1 (migration 0018): a job's field revision rises by exactly one
// on every input of its drafts' life cycle, and on nothing else; the sync's watermark; the copy
// source; and the repair worker's lookup across companies. As the app's runtime role on a server set
// up like a fresh Cloud SQL instance (team-harness.ts). No route reads or writes these columns yet.
const INVALID_PARAMETER = '22023';

let base: Awaited<ReturnType<typeof startTeamServer>>;
let h: Harness;
let pool: ReturnType<typeof openDatabase>;

beforeAll(async () => {
  base = await startTeamServer();
});

beforeEach(async () => {
  await pool?.close();
  h = await resetTeamDatabase(base, h ?? null);
  pool = openDatabase({ APP_ENV: 'test', DATABASE_URL: h.apiUrl }, { max: 4 });
});

afterAll(async () => {
  await pool?.close();
  await h?.handle.close();
  await base?.admin.end({ timeout: 5 });
  await base?.server.stop();
});

const as = <T>(company: string, run: (tx: CompanyTransaction) => Promise<T>) => withCompany(pool.db, company, run);
const exec = (company: string, text: string) => as(company, (tx) => tx.execute(sql.raw(text)));
const rows = <T>(result: unknown) => result as unknown as T[];
const jobOf = (company: string, owner: string | null = null) => seedJob(h.admin, newJob(company, ownerOf(h, company), { owner }));
const state = async (job: string) =>
  (
    await h.admin<{ field: number; synced: number; revision: number; changed: Date }[]>`
      SELECT field_revision::int AS field, field_synced_revision::int AS synced, revision, field_changed_at AS changed FROM jobs WHERE id = ${job}
    `
  )[0]!;
const field = async (job: string) => (await state(job)).field;

describe('migration 0018: the field revision rises by one on every life-cycle input', () => {
  it('starts every job, new or existing, at 0 and synced at 0', async () => {
    const job = await jobOf(h.seed.a);
    expect(await state(job.id)).toMatchObject({ field: 0, synced: 0, revision: 1 });
  });

  it('rises on the job’s status, current draft and field owner, keeping the job revision rules', async () => {
    const job = await jobOf(h.seed.a);
    await exec(h.seed.a, `UPDATE jobs SET current_draft_id = gen_random_uuid(), revision = revision + 1 WHERE id = '${job.id}'`);
    expect(await state(job.id)).toMatchObject({ field: 1, revision: 2 });
    await exec(h.seed.a, `UPDATE jobs SET status = 'submitted', revision = revision + 1 WHERE id = '${job.id}'`);
    expect(await state(job.id)).toMatchObject({ field: 2, revision: 3 });
    // The field owner alone keeps the job revision (0015).
    await exec(h.seed.a, `UPDATE jobs SET field_owner_actor_id = '${h.seed.estimatorA.actor}' WHERE id = '${job.id}'`);
    expect(await state(job.id)).toMatchObject({ field: 3, revision: 3 });
    await exec(h.seed.a, `UPDATE jobs SET field_owner_actor_id = NULL WHERE id = '${job.id}'`);
    expect(await state(job.id)).toMatchObject({ field: 4, revision: 3 });
    // Two inputs in one statement are one change.
    await exec(
      h.seed.a,
      `UPDATE jobs SET status = 'archived', archived_at = now(), archived_by_actor_id = '${h.seed.ownerA.actor}', field_owner_actor_id = '${h.seed.ownerA.actor}', revision = revision + 1 WHERE id = '${job.id}'`,
    );
    expect(await state(job.id)).toMatchObject({ field: 5, revision: 4 });
  });

  it('rises when the job’s coordination row is made or its revision moves, a submission is made or its status moves, or a draft id is claimed', async () => {
    const job = await jobOf(h.seed.a);
    await exec(h.seed.a, `INSERT INTO job_coordination (company_id, job_id) VALUES ('${h.seed.a}', '${job.id}')`);
    expect(await field(job.id)).toBe(1);
    await exec(h.seed.a, `UPDATE job_coordination SET revision = revision + 1, office_notes = 'Gate code at the office' WHERE job_id = '${job.id}'`);
    expect(await field(job.id)).toBe(2);

    const submission = newSubmission(h.seed.a, job.id, ownerOf(h, h.seed.a));
    await as(h.seed.a, (tx) => insertSubmission(tx, submission));
    expect(await field(job.id)).toBe(3);
    await as(h.seed.a, (tx) => abortSubmission(tx, h.seed.a, submission.id));
    expect(await field(job.id)).toBe(4);

    expect(await as(h.seed.a, (tx) => claimDraft(tx, h.seed.a, job.id, randomUUID()))).toBe(true);
    expect(await field(job.id)).toBe(5);
    // None of these is a change of the document the estimate is bound to.
    expect((await state(job.id)).revision).toBe(1);
  });

  it('rises on every job whose field work a person owns when that person’s sign-in uid changes', async () => {
    const owned = [await jobOf(h.seed.a, h.seed.estimatorA.actor), await jobOf(h.seed.a, h.seed.estimatorA.actor)];
    const others = [await jobOf(h.seed.a, h.seed.ownerA.actor), await jobOf(h.seed.a)];
    await exec(h.seed.a, `UPDATE actors SET uid = 'estimator-a-renamed' WHERE id = '${h.seed.estimatorA.actor}'`);
    expect(await Promise.all(owned.map((job) => field(job.id)))).toEqual([1, 1]);
    expect(await Promise.all(others.map((job) => field(job.id)))).toEqual([0, 0]);
  });

  it('records when it last rose', async () => {
    const job = await jobOf(h.seed.a);
    const before = (await state(job.id)).changed;
    await pause(20);
    await exec(h.seed.a, `UPDATE jobs SET field_owner_actor_id = '${h.seed.estimatorA.actor}' WHERE id = '${job.id}'`);
    const after = (await state(job.id)).changed;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
    await pause(20);
    await exec(h.seed.a, `UPDATE jobs SET property_address = '1 Synthetic Way', revision = revision + 1 WHERE id = '${job.id}'`);
    expect((await state(job.id)).changed).toEqual(after);
  });
});

describe('migration 0018: nothing else moves the field revision', () => {
  it('stays on the address, the change id, office notes without a coordination revision, a submission’s marker, another uid, an email and the watermark', async () => {
    const job = await jobOf(h.seed.a, h.seed.estimatorA.actor);
    await exec(h.seed.a, `INSERT INTO job_coordination (company_id, job_id) VALUES ('${h.seed.a}', '${job.id}')`);
    const submission = newSubmission(h.seed.a, job.id, ownerOf(h, h.seed.a));
    await as(h.seed.a, (tx) => insertSubmission(tx, submission));
    await as(h.seed.a, (tx) => abortSubmission(tx, h.seed.a, submission.id));
    const start = await field(job.id);
    expect(start).toBe(3);

    await exec(h.seed.a, `UPDATE jobs SET property_address = '1 Synthetic Way', revision = revision + 1 WHERE id = '${job.id}'`);
    await exec(h.seed.a, `UPDATE jobs SET last_change_id = gen_random_uuid(), revision = revision + 1, updated_at = now() WHERE id = '${job.id}'`);
    await exec(h.seed.a, `UPDATE job_coordination SET office_notes = 'Call first', updated_at = now() WHERE job_id = '${job.id}'`);
    await exec(h.seed.a, `UPDATE job_submissions SET marker_state = 'done' WHERE id = '${submission.id}'`);
    await exec(h.seed.a, `UPDATE actors SET uid = 'owner-a-renamed' WHERE id = '${h.seed.ownerA.actor}'`);
    await exec(h.seed.a, `UPDATE actors SET email = 'estimator-a-new@example.test' WHERE id = '${h.seed.estimatorA.actor}'`);
    await exec(h.seed.a, `UPDATE jobs SET field_synced_revision = field_revision WHERE id = '${job.id}'`);
    expect(await state(job.id)).toMatchObject({ field: start, synced: start, revision: 3 });

    // A claim that is refused (the id is taken) changes nothing either.
    const [taken, holder] = [randomUUID(), await jobOf(h.seed.a)];
    await as(h.seed.a, (tx) => claimDraft(tx, h.seed.a, holder.id, taken));
    expect(await as(h.seed.a, (tx) => claimDraft(tx, h.seed.a, job.id, taken))).toBe(false);
    expect(await field(job.id)).toBe(start);
  });
});

describe('migration 0018: the sync’s watermark and the change time', () => {
  it('takes a newer watermark only, so a repeated or late acknowledgement changes nothing, and refuses an update that changes nothing', async () => {
    const job = await jobOf(h.seed.a);
    await exec(h.seed.a, `UPDATE jobs SET field_revision = field_revision + 1 WHERE id = '${job.id}'`);
    await exec(h.seed.a, `UPDATE jobs SET field_revision = field_revision + 1 WHERE id = '${job.id}'`);
    // The sync's acknowledgement: only a watermark newer than the stored one is written.
    const ack = async (v: number) =>
      rows<{ id: string }>(
        await exec(h.seed.a, `UPDATE jobs SET field_synced_revision = ${v} WHERE id = '${job.id}' AND field_synced_revision < ${v} RETURNING id`),
      ).length;
    expect(await ack(2)).toBe(1);
    for (const v of [2, 1]) expect({ v, written: await ack(v) }).toEqual({ v, written: 0 });
    expect(await state(job.id)).toMatchObject({ field: 2, synced: 2, revision: 1 });
    // An update that changes nothing, or anything else, without a new job revision is still refused (0010).
    expect(await errorCode(exec(h.seed.a, `UPDATE jobs SET field_synced_revision = greatest(field_synced_revision, 1) WHERE id = '${job.id}'`))).toBe(
      CHECK_VIOLATION,
    );
    expect(await errorCode(exec(h.seed.a, `UPDATE jobs SET property_address = 'Blind' WHERE id = '${job.id}'`))).toBe(CHECK_VIOLATION);
  });

  it('stamps the change time with the clock at the bump, not the transaction’s start', async () => {
    const job = await jobOf(h.seed.a);
    const start = await as(h.seed.a, async (tx) => {
      const [found] = rows<{ start: Date }>(await tx.execute(sql`SELECT now() AS start`));
      await tx.execute(sql`SELECT pg_sleep(0.3)`);
      await tx.execute(sql.raw(`UPDATE jobs SET field_revision = field_revision + 1 WHERE id = '${job.id}'`));
      return new Date(found!.start);
    });
    expect((await state(job.id)).changed.getTime() - start.getTime()).toBeGreaterThanOrEqual(300);
  });
});

describe('migration 0018: what the runtime may write', () => {
  it('raises the field revision only by one, never sets the change time or the copy source after insert, and starts a job at 0', async () => {
    const job = await jobOf(h.seed.a);
    for (const set of ['field_revision = field_revision + 2', 'field_revision = 7']) {
      expect({ set, code: await errorCode(exec(h.seed.a, `UPDATE jobs SET ${set} WHERE id = '${job.id}'`)) }).toEqual({ set, code: CHECK_VIOLATION });
    }
    await exec(h.seed.a, `UPDATE jobs SET field_revision = field_revision + 1 WHERE id = '${job.id}'`);
    expect(await state(job.id)).toMatchObject({ field: 1, revision: 1 });
    expect(await errorCode(exec(h.seed.a, `UPDATE jobs SET field_revision = 0 WHERE id = '${job.id}'`))).toBe(CHECK_VIOLATION);
    for (const set of ['field_changed_at = now()', `copied_from_job_id = '${job.id}'`]) {
      expect({ set, code: await errorCode(exec(h.seed.a, `UPDATE jobs SET ${set} WHERE id = '${job.id}'`)) }).toEqual({ set, code: INSUFFICIENT_PRIVILEGE });
    }

    const insert = (extra: string, values: string) =>
      exec(
        h.seed.a,
        `INSERT INTO jobs (id, company_id, created_by_actor_id, current_draft_id, request_digest${extra}) VALUES (gen_random_uuid(), '${h.seed.a}', '${ownerOf(h, h.seed.a)}', gen_random_uuid(), '${'a'.repeat(64)}'${values})`,
      );
    expect(await errorCode(insert(', field_revision', ', 3'))).toBe(CHECK_VIOLATION);
    expect(await errorCode(insert(', field_synced_revision', ', 3'))).toBe(CHECK_VIOLATION);
    // A copy names a job of its own company.
    expect(await errorCode(insert(', copied_from_job_id', `, '${job.id}'`))).toBeUndefined();
    const elsewhere = await jobOf(h.seed.b);
    expect(await errorCode(insert(', copied_from_job_id', `, '${elsewhere.id}'`))).toBe(FOREIGN_KEY_VIOLATION);
    expect(
      await h.admin`SELECT field_revision::int AS field, field_synced_revision::int AS synced FROM jobs WHERE copied_from_job_id = ${job.id}`,
    ).toEqual([{ field: 0, synced: 0 }]);
  });

  it('refuses a change whose bump the caller cannot make, so no input is committed without one', async () => {
    const job = await jobOf(h.seed.a, h.seed.estimatorA.actor);
    // A platform operator may not change a job, so a uid change that would move this one is refused.
    expect(
      await errorCode(
        withOperator(h.handle.db, h.seed.operator, (tx) => tx.execute(sql`UPDATE actors SET uid = 'estimator-a-op' WHERE id = ${h.seed.estimatorA.actor}::uuid`), {
          companyId: h.seed.a,
        }),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await h.admin`SELECT uid FROM actors WHERE id = ${h.seed.estimatorA.actor}`).toEqual([{ uid: 'estimator-a' }]);
    expect(await field(job.id)).toBe(0);
    expect(await unprotectedRelations(h.admin)).toEqual([]);
  });
});

describe('migration 0018: the repair worker’s lookup across companies', () => {
  const due = (max = 10, grace = 0) => pool.db.execute(sql`SELECT job_field_sync_due_companies(${max}::int, ${grace}::int)::text AS id`);
  const ids = async (max?: number, grace?: number) => rows<{ id: string }>(await due(max, grace)).map((row) => row.id);
  const bump = (company: string, job: string) => exec(company, `UPDATE jobs SET field_revision = field_revision + 1 WHERE id = '${job}'`);
  const sync = (company: string, job: string) => exec(company, `UPDATE jobs SET field_synced_revision = field_revision WHERE id = '${job}'`);

  it('finds a company with a job behind its sync once the grace has passed, each company once, oldest change first, up to the limit', async () => {
    const [a, b, synced] = [await jobOf(h.seed.a), await jobOf(h.seed.b), await jobOf(h.seed.a)];
    expect(await ids()).toEqual([]);
    await bump(h.seed.b, b.id);
    await pause(20);
    await bump(h.seed.a, a.id);
    await bump(h.seed.a, a.id);
    await bump(h.seed.a, synced.id);
    await sync(h.seed.a, synced.id);
    expect(await ids()).toEqual([h.seed.b, h.seed.a]);
    expect(await ids(1)).toEqual([h.seed.b]);
    // Inside the grace the request that made the change is not raced by the worker.
    expect(await ids(10, 3600)).toEqual([]);
    await sync(h.seed.b, b.id);
    expect(await ids()).toEqual([h.seed.a]);
  });

  it('lets the runtime find which companies have work, and nothing else, even with the setting turned on', async () => {
    const job = await jobOf(h.seed.a);
    await bump(h.seed.a, job.id);
    const api = postgres(h.apiUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
    try {
      expect(await api`SELECT * FROM jobs`).toHaveLength(0);
      await api.begin(async (tx) => {
        await tx`SELECT set_config('app.field_sync_scan', 'on', true)`;
        expect(await tx`SELECT * FROM jobs`).toHaveLength(0);
      });
      expect(await api`SELECT job_field_sync_due_companies(10, 0)::text AS id`).toEqual([{ id: h.seed.a }]);
      expect(await api`SELECT current_setting('app.field_sync_scan', true) AS v`).toEqual([{ v: '' }]);
    } finally {
      await api.end({ timeout: 5 });
    }
  });

  it('refuses everyone but the runtime, and the owner reads nothing through it', async () => {
    const job = await jobOf(h.seed.a);
    await bump(h.seed.a, job.id);
    const url = new URL(base.server.databaseUrl);
    url.username = sharedRoles().other.name;
    url.password = sharedRoles().other.password;
    const other = postgres(url.toString(), { max: 1, connect_timeout: 10, onnotice: () => {} });
    const migrator = postgres(h.migratorUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
    try {
      expect(await errorCode(other`SELECT job_field_sync_due_companies(10, 0)`)).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await migrator`SELECT job_field_sync_due_companies(10, 0)`).toEqual([]);
      await migrator.begin(async (tx) => {
        await tx`SELECT set_config('app.field_sync_scan', 'on', true)`;
        expect(await tx`SELECT * FROM jobs`).toHaveLength(0);
      });
      expect(await migrator`UPDATE jobs SET field_synced_revision = field_revision RETURNING id`).toHaveLength(0);
    } finally {
      await other.end({ timeout: 5 });
      await migrator.end({ timeout: 5 });
    }
  });

  it('refuses a size outside 1 to 100 and a grace outside 0 to 86,400 seconds, and answers nothing for a null', async () => {
    for (const [max, grace] of [[0, 0], [101, 0], [1, -1], [1, 86401]] as const) {
      expect({ max, grace, code: await errorCode(due(max, grace)) }).toEqual({ max, grace, code: INVALID_PARAMETER });
    }
    expect(await errorCode(due(100, 86400))).toBeUndefined();
    expect(rows(await pool.db.execute(sql`SELECT job_field_sync_due_companies(NULL, 0)`))).toEqual([]);
  });
});

// The fill of existing copies, on a database of the roles server built up to 0017 by the migrator (not a
// superuser, so forced row-level security binds it), holding rows.
describe('migration 0018: the copy source of existing copies', () => {
  let database: Awaited<ReturnType<typeof createDiscardDatabase>> | null = null;

  afterAll(async () => {
    await database?.drop();
  });

  it('fills each copy’s source from its job_copied audit row, only for a job of the same company, and changes nothing else', async () => {
    const shared = inject('dryscopeDatabases');
    database = await createDiscardDatabase(shared.rolesUrl);
    await emptyDiscardDatabase(database.databaseUrl);
    const admin = postgres(database.databaseUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
    const dir = await mkdtemp(join(tmpdir(), 'dryscope-mig-'));
    try {
      await admin.unsafe('GRANT USAGE ON SCHEMA public TO PUBLIC');
      await admin.unsafe(`GRANT CREATE ON SCHEMA public TO ${shared.roles.migrator.name}`);
      const migratorUrl = loginUrl(database.databaseUrl, shared.roles.migrator);
      const earlier = (await readMigrations(migrationsDirectory)).filter((file) => file.id < '0018');
      await Promise.all(earlier.map((file) => writeFile(join(dir, `${file.id}.sql`), file.sql)));
      await applyMigrations(migratorUrl, dir);

      const company = async (slug: string) => {
        await admin`INSERT INTO auth_tenants (id, kind) VALUES (${slug}, 'company')`;
        const [made] = await admin<{ id: string }[]>`INSERT INTO companies (name, sign_in_slug, auth_tenant_id) VALUES ('Existing', ${slug}, ${slug}) RETURNING id`;
        const [actor] = await admin<{ id: string }[]>`
          INSERT INTO actors (company_id, auth_tenant_id, uid, email) VALUES (${made!.id}, ${slug}, 'u1', 'u1@example.test') RETURNING id
        `;
        const job = async () => {
          const id = randomUUID();
          await admin`
            INSERT INTO jobs (id, company_id, created_by_actor_id, current_draft_id, request_digest)
            VALUES (${id}, ${made!.id}, ${actor!.id}, ${randomUUID()}, ${'b'.repeat(64)})
          `;
          return id;
        };
        const copied = (copy: string, from: unknown) =>
          admin`INSERT INTO audit_events (company_id, actor_id, action, target, details) VALUES (${made!.id}, ${actor!.id}, 'job_copied', ${copy}, ${admin.json({ revision: 1, copiedFrom: from } as never)})`;
        return { id: made!.id, job, copied };
      };
      const a = await company('tenant-fill-a');
      const b = await company('tenant-fill-b');
      const [source, copy, elsewhere, malformed, plain] = [await a.job(), await a.job(), await a.job(), await a.job(), await a.job()];
      const other = await b.job();
      await a.copied(copy, source);
      // A source that is not a job of this company, and one that is not an id, fill nothing.
      await a.copied(elsewhere, other);
      await a.copied(malformed, 'not-a-job');
      const before = await admin`SELECT id, revision, status, updated_at FROM jobs ORDER BY id`;

      expect((await applyMigrations(migratorUrl, migrationsDirectory)).applied).toEqual(['0018_field_revision']);
      const filled = await admin<{ id: string; source: string | null; field: number }[]>`
        SELECT id::text, copied_from_job_id::text AS source, field_revision::int AS field FROM jobs ORDER BY id
      `;
      expect(Object.fromEntries(filled.map((row) => [row.id, row.source]))).toEqual({
        [source]: null,
        [copy]: source,
        [elsewhere]: null,
        [malformed]: null,
        [plain]: null,
        [other]: null,
      });
      expect(filled.every((row) => row.field === 0)).toBe(true);
      expect(await admin`SELECT id, revision, status, updated_at FROM jobs ORDER BY id`).toEqual(before);
      expect(await admin`SELECT relname AS name, relforcerowsecurity AS forced FROM pg_class WHERE relname IN ('audit_events', 'jobs') ORDER BY 1`).toEqual([
        { name: 'audit_events', forced: true },
        { name: 'jobs', forced: true },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await admin.end({ timeout: 5 });
    }
  });
});
