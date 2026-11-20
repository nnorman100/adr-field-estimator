import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { applyMigrations, migrationsDirectory, readMigrations } from '@/db/migrate';
import { withCompany, withOperator, type CompanyTransaction } from '@/db/tenant';
import { claimDraft, holdDraft } from '@/lib/jobs/access';
import { FOREIGN_KEY_VIOLATION, INSUFFICIENT_PRIVILEGE, errorCode, newJob, pause, seedJob } from './job-harness';
import { createDiscardDatabase, emptyDiscardDatabase, loginUrl } from './postgres-harness';
import { unprotectedRelations } from './row-security-guard';
import { resetTeamDatabase, startTeamServer, type Harness } from './team-harness';

// Security audit F1: migration 0016's job_drafts, which claims each field draft id once per company
// for one job, as the app's runtime role on a server set up like a fresh Cloud SQL instance
// (team-harness.ts), and its fill of the rows already there, run as the migrator that owns the
// tables (not a superuser, so forced row-level security binds it). The routes that claim a draft are
// in jobs-api, next-draft-api, archive-api, office-jobs-api and office-jobs-field-owner.test.ts.

let base: Awaited<ReturnType<typeof startTeamServer>>;
let h: Harness;

beforeAll(async () => {
  base = await startTeamServer();
});

beforeEach(async () => {
  h = await resetTeamDatabase(base, h ?? null);
});

afterAll(async () => {
  await h?.handle.close();
  await base?.admin.end({ timeout: 5 });
  await base?.server.stop();
});

const as = <T>(company: string, run: (tx: CompanyTransaction) => Promise<T>) => withCompany(h.handle.db, company, run);
const rows = <T>(result: unknown) => result as unknown as T[];
const run = (company: string, text: string) => errorCode(as(company, (tx) => tx.execute(sql.raw(text))));
const jobOf = (company = h.seed.a) => seedJob(h.admin, newJob(company, company === h.seed.a ? h.seed.ownerA.actor : h.seed.ownerB.actor));

describe('migration 0016: the draft claims', () => {
  it('forces row-level security with company policies, and gives the runtime only SELECT and INSERT', async () => {
    expect(await unprotectedRelations(h.admin)).toEqual([]);
    expect(
      await h.admin`
        SELECT c.relname AS name, c.relforcerowsecurity AS forced, array(SELECT p.polname::text FROM pg_policy p WHERE p.polrelid = c.oid ORDER BY 1) AS policies
        FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('job_drafts', 'jobs', 'job_submissions') ORDER BY 1
      `,
    ).toEqual([
      { name: 'job_drafts', forced: true, policies: ['job_drafts_insert', 'job_drafts_select'] },
      expect.objectContaining({ name: 'job_submissions', forced: true }),
      expect.objectContaining({ name: 'jobs', forced: true }),
    ]);
    expect(
      await h.admin`
        SELECT privilege_type AS privilege FROM information_schema.role_table_grants
        WHERE grantee = 'dryscope_runtime' AND table_name = 'job_drafts' ORDER BY 1
      `,
    ).toEqual([{ privilege: 'INSERT' }, { privilege: 'SELECT' }]);

    const job = await jobOf();
    const draft = randomUUID();
    expect(await as(h.seed.a, (tx) => claimDraft(tx, h.seed.a, job.id, draft))).toBe(true);
    // A claim never moves to another job and is never removed.
    expect(await run(h.seed.a, `UPDATE job_drafts SET job_id = '${(await jobOf()).id}' WHERE draft_id = '${draft}'`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await run(h.seed.a, `DELETE FROM job_drafts WHERE draft_id = '${draft}'`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await run(h.seed.a, 'TRUNCATE job_drafts')).toBe(INSUFFICIENT_PRIVILEGE);
    // Company B sees nothing of A's claims, cannot write one into A, nor claim A's job.
    expect(rows(await as(h.seed.b, (tx) => tx.execute(sql`SELECT draft_id FROM job_drafts`)))).toEqual([]);
    expect(await errorCode(as(h.seed.b, (tx) => claimDraft(tx, h.seed.a, job.id, randomUUID())))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await errorCode(as(h.seed.b, (tx) => claimDraft(tx, h.seed.b, job.id, randomUUID())))).toBe(FOREIGN_KEY_VIOLATION);
    // The same draft id is company B's own to claim: ids are per company.
    expect(await as(h.seed.b, async (tx) => claimDraft(tx, h.seed.b, (await jobOf(h.seed.b)).id, draft))).toBe(true);
    // An operator reads them and never writes.
    const seen = await withOperator(h.handle.db, h.seed.operator, (tx) => tx.execute(sql`SELECT draft_id::text FROM job_drafts`), { companyId: h.seed.a, readOnly: true });
    expect(rows(seen)).toEqual([{ draft_id: draft }]);
    expect(await errorCode(withOperator(h.handle.db, h.seed.operator, (tx) => claimDraft(tx, h.seed.a, job.id, randomUUID()), { companyId: h.seed.a }))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it('claims a draft id once: again for the same job, for another job, or by two jobs at once, it is refused', async () => {
    const [first, second] = [await jobOf(), await jobOf()];
    const draft = randomUUID();
    expect(await as(h.seed.a, (tx) => claimDraft(tx, h.seed.a, first.id, draft))).toBe(true);
    expect(await as(h.seed.a, (tx) => claimDraft(tx, h.seed.a, first.id, draft))).toBe(false);
    expect(await as(h.seed.a, (tx) => claimDraft(tx, h.seed.a, second.id, draft))).toBe(false);

    // Two jobs claim one new id at once: the second waits for the first's commit, then is refused.
    const raced = randomUUID();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let claimed!: () => void;
    const firstClaimed = new Promise<void>((resolve) => (claimed = resolve));
    const one = as(h.seed.a, async (tx) => {
      const won = await claimDraft(tx, h.seed.a, first.id, raced);
      claimed();
      await held;
      return won;
    });
    await firstClaimed;
    const two = as(h.seed.a, (tx) => claimDraft(tx, h.seed.a, second.id, raced));
    await pause(300);
    release();
    expect([await one, await two]).toEqual([true, false]);
    expect(await h.admin`SELECT job_id::text AS job FROM job_drafts WHERE draft_id = ${raced}`).toEqual([{ job: first.id }]);
  });
});

// A draft id a job already names, which the previous version (still serving while a release migrates)
// put it on or submitted without a claim, is held for that job in Postgres before the field database
// is touched for it (holdDraft, security audit F1); a draft id another job claimed or submitted never is.
describe('holding a draft id a job already names', () => {
  const submit = (company: string, job: string, actor: string, draft: string) => h.admin`
    INSERT INTO job_submissions (id, company_id, job_id, draft_id, epoch, kind, request_digest, expires_at, created_by_actor_id)
    VALUES (${randomUUID()}, ${company}, ${job}, ${draft}, ${randomUUID()}, 'original', ${'c'.repeat(64)}, now() + interval '1 hour', ${actor})
  `;
  const claims = (draft: string) => h.admin`SELECT company_id::text AS company, job_id::text AS job FROM job_drafts WHERE draft_id = ${draft} ORDER BY 1`;

  it('claims an unclaimed draft id for its job, keeps it the job’s, and refuses it to every other job and company', async () => {
    const [first, second] = [await jobOf(), await jobOf()];
    const own = randomUUID();
    await submit(h.seed.a, first.id, h.seed.ownerA.actor, own);
    expect(await as(h.seed.a, (tx) => holdDraft(tx, h.seed.a, first.id, own))).toBe(true);
    expect(await as(h.seed.a, (tx) => holdDraft(tx, h.seed.a, first.id, own))).toBe(true);
    expect(await claims(own)).toEqual([{ company: h.seed.a, job: first.id }]);
    expect(await as(h.seed.a, (tx) => holdDraft(tx, h.seed.a, second.id, own))).toBe(false);

    // Unclaimed, but another job's submission names it: never this job's, and nothing is claimed.
    const theirs = randomUUID();
    await submit(h.seed.a, second.id, h.seed.ownerA.actor, theirs);
    expect(await as(h.seed.a, (tx) => holdDraft(tx, h.seed.a, first.id, theirs))).toBe(false);
    expect(await claims(theirs)).toEqual([]);

    // Company B neither reads A's claims nor claims into A; the same id is B's own to hold.
    expect(await errorCode(as(h.seed.b, (tx) => holdDraft(tx, h.seed.a, first.id, randomUUID())))).toBe(INSUFFICIENT_PRIVILEGE);
    const inB = await jobOf(h.seed.b);
    expect(await as(h.seed.b, (tx) => holdDraft(tx, h.seed.b, inB.id, own))).toBe(true);
    expect(await claims(own)).toEqual(
      [
        { company: h.seed.a, job: first.id },
        { company: h.seed.b, job: inB.id },
      ].sort((x, y) => x.company.localeCompare(y.company)),
    );
  });
});

// The fill, on a database of the roles server built up to 0015 by the migrator, holding rows.
describe('migration 0016: the fill of existing jobs', () => {
  const shared = () => inject('dryscopeDatabases');
  let database: Awaited<ReturnType<typeof createDiscardDatabase>> | null = null;

  afterAll(async () => {
    await database?.drop();
  });

  async function upTo0015(): Promise<{ admin: postgres.Sql; migratorUrl: string }> {
    await database?.drop();
    database = await createDiscardDatabase(shared().rolesUrl);
    await emptyDiscardDatabase(database.databaseUrl);
    const admin = postgres(database.databaseUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
    await admin.unsafe('GRANT USAGE ON SCHEMA public TO PUBLIC');
    await admin.unsafe(`GRANT CREATE ON SCHEMA public TO ${shared().roles.migrator.name}`);
    const migratorUrl = loginUrl(database.databaseUrl, shared().roles.migrator);
    const dir = await mkdtemp(join(tmpdir(), 'dryscope-mig-'));
    try {
      const earlier = (await readMigrations(migrationsDirectory)).filter((file) => file.id < '0016');
      await Promise.all(earlier.map((file) => writeFile(join(dir, `${file.id}.sql`), file.sql)));
      await applyMigrations(migratorUrl, dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    return { admin, migratorUrl };
  }

  // A company with one person, and a job on `draft` that submitted each of `submitted` before.
  async function seedCompany(admin: postgres.Sql) {
    const tenant = `tenant-${randomUUID().slice(0, 8)}`;
    await admin`INSERT INTO auth_tenants (id, kind) VALUES (${tenant}, 'company')`;
    const [company] = await admin<{ id: string }[]>`INSERT INTO companies (name, sign_in_slug, auth_tenant_id) VALUES ('Existing', ${tenant}, ${tenant}) RETURNING id`;
    const [actor] = await admin<{ id: string }[]>`
      INSERT INTO actors (company_id, auth_tenant_id, uid, email) VALUES (${company!.id}, ${tenant}, 'u1', 'u1@example.test') RETURNING id
    `;
    const job = async (draft: string, submitted: string[] = []) => {
      const id = randomUUID();
      await admin`
        INSERT INTO jobs (id, company_id, created_by_actor_id, current_draft_id, request_digest)
        VALUES (${id}, ${company!.id}, ${actor!.id}, ${draft}, ${'b'.repeat(64)})
      `;
      for (const earlier of submitted) {
        await admin`
          INSERT INTO job_submissions (id, company_id, job_id, draft_id, epoch, kind, request_digest, expires_at, created_by_actor_id)
          VALUES (${randomUUID()}, ${company!.id}, ${id}, ${earlier}, ${randomUUID()}, 'original', ${'c'.repeat(64)}, now() + interval '1 hour', ${actor!.id})
        `;
      }
      return id;
    };
    // Commits the job's submission of `draft`, as Submit does: pending first, then committed.
    const commit = async (jobId: string, draft: string) => {
      const id = randomUUID();
      await admin`
        INSERT INTO job_submissions (id, company_id, job_id, draft_id, epoch, kind, request_digest, expires_at, created_by_actor_id)
        VALUES (${id}, ${company!.id}, ${jobId}, ${draft}, ${randomUUID()}, 'original', ${'c'.repeat(64)}, now() + interval '1 hour', ${actor!.id})
      `;
      await admin`
        UPDATE job_submissions SET status = 'committed', snapshot_bytes = '\x7b7d'::bytea, snapshot_sha256 = encode(sha256('\x7b7d'::bytea), 'hex')
        WHERE id = ${id}
      `;
    };
    return { company: company!.id, job, commit };
  }

  it('claims every current and submitted draft of each job for that job, and keeps row-level security forced', async () => {
    const { admin, migratorUrl } = await upTo0015();
    try {
      const { company, job } = await seedCompany(admin);
      const [first, earlier, other] = [randomUUID(), randomUUID(), randomUUID()];
      // A job that went Back to editing (its first draft is in its submissions and it is on a new
      // one, which it also tried to submit once), and a job on its first draft.
      const moved = await job(first, [earlier, first]);
      const fresh = await job(other);
      const jobs = await admin`SELECT * FROM jobs ORDER BY id`;

      expect((await applyMigrations(migratorUrl, migrationsDirectory)).applied).toEqual(['0016_job_drafts', '0017_definer_search_path', '0018_field_revision', '0019_price_approvals']);
      expect(await admin`SELECT company_id::text AS company, draft_id::text AS draft, job_id::text AS job FROM job_drafts ORDER BY job_id, draft_id`).toEqual(
        [
          ...[earlier, first].sort().map((draft) => ({ company, draft, job: moved })),
          { company, draft: other, job: fresh },
        ].sort((x, y) => x.job.localeCompare(y.job) || x.draft.localeCompare(y.draft)),
      );
      // 0018 adds the field columns at their starting values; nothing else of a job changes.
      expect(await admin`SELECT * FROM jobs ORDER BY id`).toEqual(
        jobs.map((row) => ({ ...row, field_revision: '0', field_synced_revision: '0', field_changed_at: expect.any(Date), copied_from_job_id: null })),
      );
      expect(await admin`SELECT relname AS name, relforcerowsecurity AS forced FROM pg_class WHERE relname IN ('jobs', 'job_submissions', 'job_drafts') ORDER BY 1`).toEqual([
        { name: 'job_drafts', forced: true },
        { name: 'job_submissions', forced: true },
        { name: 'jobs', forced: true },
      ]);
    } finally {
      await admin.end({ timeout: 5 });
    }
  });

  it('stops, changing nothing, when two jobs already name one draft id, so the owner decides which keeps it', async () => {
    const { admin, migratorUrl } = await upTo0015();
    try {
      const { company, job } = await seedCompany(admin);
      const shared = randomUUID();
      // A job that moved on from `shared`, and a job put on it before the refusal of such an id.
      const movedOn = await job(randomUUID(), [shared]);
      const putOn = await job(shared);
      const failed = await applyMigrations(migratorUrl, migrationsDirectory).then(
        () => null,
        (error: unknown) => String(error),
      );
      expect(failed).toMatch(/named by more than one job/);
      // Both jobs are named, by company and job id, and no stuck job is.
      for (const id of [movedOn, putOn]) expect(failed).toContain(`${company}/${id}`);
      expect(failed).toMatch(/on a submitted draft: none/);
      expect(await admin`SELECT to_regclass('public.job_drafts')::text AS table`).toEqual([{ table: null }]);
      expect(await admin`SELECT count(*)::int AS n FROM migration_ledger WHERE id = '0016_job_drafts'`).toEqual([{ n: 0 }]);
      expect(await admin`SELECT relforcerowsecurity AS forced FROM pg_class WHERE relname = 'jobs'`).toEqual([{ forced: true }]);
    } finally {
      await admin.end({ timeout: 5 });
    }
  });

  // Security audit F1, step 5: a job in status draft whose current draft was already submitted cannot
  // be finished through the API; the owner settles it before the fill.
  it('stops, changing nothing, when a job in status draft is on a draft already submitted, and names that job', async () => {
    const { admin, migratorUrl } = await upTo0015();
    try {
      const { company, job, commit } = await seedCompany(admin);
      const draft = randomUUID();
      const stuck = await job(draft);
      await commit(stuck, draft);
      // A job that submitted its draft and moved on, and one still editing, are not stuck.
      const earlier = randomUUID();
      const fine = await job(randomUUID(), [earlier]);
      await commit(fine, earlier);
      const editing = await job(randomUUID());
      expect(await admin`SELECT status FROM jobs WHERE id = ${stuck}`).toEqual([{ status: 'draft' }]);

      const failed = await applyMigrations(migratorUrl, migrationsDirectory).then(
        () => null,
        (error: unknown) => String(error),
      );
      expect(failed).toMatch(new RegExp(`on a submitted draft: ${company}/${stuck}\\.`));
      expect(failed).toMatch(/named by more than one job: none/);
      for (const id of [fine, editing]) expect(failed).not.toContain(id);
      expect(await admin`SELECT to_regclass('public.job_drafts')::text AS table`).toEqual([{ table: null }]);
      expect(await admin`SELECT count(*)::int AS n FROM migration_ledger WHERE id = '0016_job_drafts'`).toEqual([{ n: 0 }]);
    } finally {
      await admin.end({ timeout: 5 });
    }
  });
});
