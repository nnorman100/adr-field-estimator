import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@/db/client';
import { companies } from '@/db/schema';
import { withCompany, withOperator, type CompanyTransaction } from '@/db/tenant';
import {
  CHECK_VIOLATION,
  INSUFFICIENT_PRIVILEGE,
  UNIQUE_VIOLATION,
  digestOf,
  errorCode,
  insertEvidence,
  newEvidence,
  newJob,
  photoName,
  seedEvidence,
  seedJob,
} from './job-harness';
import { everything, resetTeamDatabase, startTeamServer, type Harness } from './team-harness';

// S5a-2, second half of migration 0010: the evidence registry's own rules, and the company profile
// columns with the column-level UPDATE grant. Same setup as job-tables.test.ts.
let base: Awaited<ReturnType<typeof startTeamServer>>;
let h: Harness;
let pool: ReturnType<typeof openDatabase>;

beforeAll(async () => {
  base = await startTeamServer();
});

beforeEach(async () => {
  await pool?.close();
  h = await resetTeamDatabase(base, h ?? null);
  pool = openDatabase({ APP_ENV: 'test', DATABASE_URL: h.apiUrl }, { max: 6 });
});

afterAll(async () => {
  await pool?.close();
  await h?.handle.close();
  await base?.admin.end({ timeout: 5 });
  await base?.server.stop();
});

const as = <T>(company: string, run: (tx: CompanyTransaction) => Promise<T>) => withCompany(pool.db, company, run);
const asOperator = <T>(run: (tx: CompanyTransaction) => Promise<T>, companyId: string | null = h.seed.a) =>
  withOperator(h.handle.db, h.seed.operator, run, { companyId: companyId ?? undefined });
const rows = <T>(result: unknown) => result as unknown as T[];
const sqlOf = (text: string) => sql.raw(text);

describe('the evidence registry', () => {
  let jobId: string;
  const evidence = (extra: Parameters<typeof newEvidence>[3] = {}) => newEvidence(h.seed.a, jobId, h.seed.estimatorA.actor, extra);
  const register = (extra: Parameters<typeof newEvidence>[3] = {}) => as(h.seed.a, (tx) => insertEvidence(tx, evidence(extra)));

  beforeEach(async () => {
    jobId = (await seedJob(h.admin, newJob(h.seed.a, h.seed.ownerA.actor))).id;
  });

  it('registers a photo, its full-size original and a signature, and stores each as given', async () => {
    const photo = evidence({ sha: 'a'.repeat(64), size: 123456, generation: '1731400000123456', type: 'image/jpeg' });
    await as(h.seed.a, (tx) => insertEvidence(tx, photo));
    // The original shares the photo's object id and differs in kind and name.
    await register({ objectId: photo.objectId, kind: 'original', name: photoName(h.seed.a, jobId, photo.objectId, 'originals'), type: 'image/heic' });
    await register({ kind: 'signature', type: 'image/png' });
    const stored = await h.admin`
      SELECT kind, object_name, generation::text AS generation, sha256, size_bytes::int AS size_bytes, content_type, created_by_actor_id FROM evidence_objects WHERE kind = 'photo'
    `;
    expect(stored).toEqual([
      {
        kind: 'photo',
        object_name: photoName(h.seed.a, jobId, photo.objectId),
        generation: '1731400000123456',
        sha256: 'a'.repeat(64),
        size_bytes: 123456,
        content_type: 'image/jpeg',
        created_by_actor_id: h.seed.estimatorA.actor,
      },
    ]);
    expect(await h.admin`SELECT kind FROM evidence_objects ORDER BY kind`).toEqual([{ kind: 'original' }, { kind: 'photo' }, { kind: 'signature' }]);
  });

  it('holds one row per object and kind for a job, and one row per object name, so a retried receipt finds its row', async () => {
    const photo = evidence();
    await as(h.seed.a, (tx) => insertEvidence(tx, photo));
    expect(await errorCode(as(h.seed.a, (tx) => insertEvidence(tx, { ...photo, name: photoName(h.seed.a, jobId, photo.objectId, 'again') })))).toBe(UNIQUE_VIOLATION);
    expect(await errorCode(register({ name: photoName(h.seed.a, jobId, photo.objectId) }))).toBe(UNIQUE_VIOLATION);
    expect(await errorCode(register({ objectId: photo.objectId, kind: 'original', name: photoName(h.seed.a, jobId, photo.objectId) }))).toBe(UNIQUE_VIOLATION);
    expect(await h.admin`SELECT count(*)::int AS n FROM evidence_objects`).toEqual([{ n: 1 }]);
  });

  it('lets a later row name an object by company and id, and refuses another company’s pair (the agreement’s signature key)', async () => {
    const [mine] = await as(h.seed.a, (tx) => insertEvidence(tx, evidence({ kind: 'signature' })));
    await h.admin`CREATE TABLE probe_signature (company_id uuid, evidence_id uuid, FOREIGN KEY (company_id, evidence_id) REFERENCES evidence_objects (company_id, id))`;
    await h.admin`INSERT INTO probe_signature VALUES (${h.seed.a}, ${mine!.id})`;
    expect(await errorCode(h.admin`INSERT INTO probe_signature VALUES (${h.seed.b}, ${mine!.id})`)).toBe('23503');
  });

  it('holds an object name to the row’s own company and job, and to letters, digits and . _ - /', async () => {
    const otherJob = (await seedJob(h.admin, newJob(h.seed.b, h.seed.ownerB.actor))).id;
    const id = randomUUID();
    const good = `companies/${h.seed.a}/jobs/${jobId}/photos/${id}`;
    const bad = [
      `companies/${h.seed.b}/jobs/${jobId}/photos/${id}`,
      `companies/${h.seed.a}/jobs/${otherJob}/photos/${id}`,
      `companies/${h.seed.a}/jobs/${jobId.toUpperCase()}/photos/${id}`,
      `companies/${h.seed.a}/jobs/${jobId}`,
      `companies/${h.seed.a}/jobs/${jobId}/`,
      `companies/${h.seed.a}/jobs/${jobId}/photos/`,
      `/companies/${h.seed.a}/jobs/${jobId}/photos/${id}`,
      `photos/${id}`,
      `companies/${h.seed.a}/jobs/${jobId}/../${otherJob}/photos/${id}`,
      `companies/${h.seed.a}/jobs/${jobId}/./photos/${id}`,
      `companies/${h.seed.a}/jobs/${jobId}/photos/..`,
      `companies/${h.seed.a}/jobs/${jobId}/photos/pat@example.test`,
      `companies/${h.seed.a}/jobs/${jobId}/photos/Pat Customer.jpg`,
      `companies/${h.seed.a}/jobs/${jobId}/photos/${id}\n`,
      `companies/${h.seed.a}/jobs/${jobId}/photos/${'x'.repeat(1024)}`,
      '',
    ];
    for (const name of bad) {
      expect({ name, code: await errorCode(register({ objectId: id, name })) }).toEqual({ name, code: CHECK_VIOLATION });
    }
    // Company B's job under company B's own path is fine for B, and not for A.
    expect(await errorCode(as(h.seed.b, (tx) => insertEvidence(tx, newEvidence(h.seed.b, otherJob, h.seed.estimatorB.actor))))).toBeUndefined();
    await register({ objectId: id, name: good });
    await register({ name: `companies/${h.seed.a}/jobs/${jobId}/photos/${'x'.repeat(900)}.v2_final-1.jpg` });
  });

  it('holds the kind, generation, hash, size and media type to their shapes', async () => {
    const refused = async (extra: Parameters<typeof newEvidence>[3]) => expect({ extra, code: await errorCode(register(extra)) }).toEqual({ extra, code: CHECK_VIOLATION });
    for (const kind of ['', 'Photo', 'video', 'thumbnail']) await refused({ kind });
    for (const generation of [0, -1]) await refused({ generation });
    for (const sha of ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), `${'a'.repeat(63)}g`]) await refused({ sha });
    for (const size of [0, -1, 1073741825]) await refused({ size });
    for (const type of ['', 'jpeg', 'image/', '/jpeg', 'Image/JPEG', 'image/jpeg; charset=binary', 'image jpeg', 'image/jpeg\n']) await refused({ type });
    await register({ size: 1 });
    await register({ size: 1073741824 });
    await register({ type: 'image/svg+xml' });
    await register({ type: 'application/vnd.example-v1.0+json' });
  });

  it('refuses a row with any field missing', async () => {
    const e = evidence();
    const values: Record<string, string> = {
      company_id: `'${e.company}'::uuid`,
      job_id: `'${e.job}'::uuid`,
      object_id: `'${e.objectId}'::uuid`,
      kind: "'photo'",
      object_name: `'${photoName(e.company, e.job, e.objectId)}'`,
      generation: '1731400000000000',
      sha256: `'${digestOf(e.objectId)}'`,
      size_bytes: '2048',
      content_type: "'image/jpeg'",
      created_by_actor_id: `'${e.actor}'::uuid`,
    };
    for (const column of Object.keys(values)) {
      const columns = Object.keys(values).filter((name) => name !== column);
      const statement = `INSERT INTO evidence_objects (${columns.join(', ')}) VALUES (${columns.map((name) => values[name]).join(', ')})`;
      expect({ column, code: await errorCode(h.admin.unsafe(statement)) }).toEqual({ column, code: '23502' });
    }
  });

  it('can be read by company A and by an operator naming it, and changed by no one', async () => {
    const photo = evidence();
    await seedEvidence(h.admin, photo);
    const count = (tx: CompanyTransaction) => tx.execute(sql`SELECT count(*)::int AS n FROM evidence_objects`);
    expect(await as(h.seed.a, count)).toEqual([{ n: 1 }]);
    expect(await as(h.seed.b, count)).toEqual([{ n: 0 }]);
    expect(await asOperator(count)).toEqual([{ n: 1 }]);
    expect(await asOperator(count, h.seed.b)).toEqual([{ n: 0 }]);
    // The owner's repair path is not a runtime one: the registry stays as it was, whoever asks.
    const before = await everything(h.admin);
    expect(await errorCode(as(h.seed.a, (tx) => tx.execute(sql`UPDATE evidence_objects SET size_bytes = 1 WHERE object_id = ${photo.objectId}::uuid`)))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await everything(h.admin)).toBe(before);
  });
});

describe('the company profile (columns on companies)', () => {
  const PROFILE = { address: '100 Main Street, Pasadena, CA 91101', phone: '(626) 555-0100', email: 'office@example.test', license: '123456', signoff: 'Pat Estimator' };
  const setProfile = (tx: CompanyTransaction, company: string, p: Partial<typeof PROFILE> = PROFILE) =>
    tx.execute(sql`
      UPDATE companies SET profile_address = coalesce(${p.address ?? null}, profile_address), profile_phone = coalesce(${p.phone ?? null}, profile_phone),
        profile_email = coalesce(${p.email ?? null}, profile_email), profile_license = coalesce(${p.license ?? null}, profile_license),
        profile_signoff = coalesce(${p.signoff ?? null}, profile_signoff), updated_at = now()
      WHERE id = ${company}::uuid RETURNING id::text
    `);
  const profileOf = (company: string) =>
    h.admin`SELECT profile_address AS address, profile_phone AS phone, profile_email AS email, profile_license AS license, profile_signoff AS signoff FROM companies WHERE id = ${company}`;
  const EMPTY = { address: '', phone: '', email: '', license: '', signoff: '' };

  it('starts empty for every company, so a missing licence or sign-off can be listed before documents', async () => {
    for (const company of [h.seed.a, h.seed.b, h.seed.suspended]) expect(await profileOf(company)).toEqual([EMPTY]);
  });

  it('lets a company’s own transaction set its profile and read it back, and touches no other company', async () => {
    expect(await as(h.seed.a, (tx) => setProfile(tx, h.seed.a))).toHaveLength(1);
    expect(await profileOf(h.seed.a)).toEqual([PROFILE]);
    expect(await profileOf(h.seed.b)).toEqual([EMPTY]);
    const [read] = await as(h.seed.a, (tx) => tx.select({ address: companies.profileAddress, license: companies.profileLicense, signoff: companies.profileSignoff }).from(companies));
    expect(read).toEqual({ address: PROFILE.address, license: '123456', signoff: 'Pat Estimator' });
    // Through the Drizzle view the owner's route will use.
    await as(h.seed.a, (tx) => tx.update(companies).set({ profilePhone: '(626) 555-0199', updatedAt: new Date() }).where(eq(companies.id, h.seed.a)));
    expect(await h.admin`SELECT profile_phone FROM companies WHERE id = ${h.seed.a}`).toEqual([{ profile_phone: '(626) 555-0199' }]);
  });

  it('finds no row to change when company B tries company A’s profile, and none outside a company transaction', async () => {
    expect(await as(h.seed.b, (tx) => setProfile(tx, h.seed.a))).toHaveLength(0);
    // An update with no WHERE changes only the caller's own company.
    expect(await as(h.seed.b, (tx) => tx.execute(sql`UPDATE companies SET profile_license = '999999' RETURNING id`))).toHaveLength(1);
    expect(await profileOf(h.seed.a)).toEqual([EMPTY]);
    expect(await pool.db.execute(sql`UPDATE companies SET profile_license = '111111' RETURNING id`)).toHaveLength(0);
    expect(await profileOf(h.seed.a)).toEqual([EMPTY]);
    expect(await profileOf(h.seed.b)).toEqual([{ ...EMPTY, license: '999999' }]);
  });

  it('lets a company change nothing else about itself: status, sign-in tenant, name and sign-in address stay put', async () => {
    const before = await everything(h.admin);
    for (const set of ["status = 'suspended'", "status = 'archived'", "auth_tenant_id = 'tenant-z'", "auth_tenant_id = NULL"]) {
      expect({ set, code: await errorCode(as(h.seed.a, (tx) => tx.execute(sqlOf(`UPDATE companies SET ${set} WHERE id = '${h.seed.a}'`)))) }).toEqual({ set, code: CHECK_VIOLATION });
    }
    // A profile change that carries a status change is refused whole.
    expect(await errorCode(as(h.seed.a, (tx) => tx.execute(sqlOf(`UPDATE companies SET profile_license = '123456', status = 'suspended' WHERE id = '${h.seed.a}'`))))).toBe(CHECK_VIOLATION);
    for (const set of ["name = 'Renamed'", "sign_in_slug = 'renamed'", `id = '${randomUUID()}'`, "created_at = now()"]) {
      expect({ set, code: await errorCode(as(h.seed.a, (tx) => tx.execute(sqlOf(`UPDATE companies SET ${set} WHERE id = '${h.seed.a}'`)))) }).toEqual({ set, code: INSUFFICIENT_PRIVILEGE });
    }
    for (const statement of ['DELETE FROM companies', 'TRUNCATE companies']) {
      expect({ statement, code: await errorCode(as(h.seed.a, (tx) => tx.execute(sqlOf(statement)))) }).toEqual({ statement, code: INSUFFICIENT_PRIVILEGE });
    }
    expect(await everything(h.admin)).toBe(before);
  });

  it('gives the runtime UPDATE on exactly the profile columns (0010’s five and 0013’s six), beside the operator’s status, tenant and time', async () => {
    const columns = await h.admin<{ column: string }[]>`
      SELECT column_name AS column FROM information_schema.column_privileges
      WHERE grantee = 'dryscope_runtime' AND table_name = 'companies' AND privilege_type = 'UPDATE' ORDER BY 1
    `;
    expect(columns.map((row) => row.column)).toEqual([
      'auth_tenant_id', 'profile_address', 'profile_documents', 'profile_email', 'profile_emergency_phone', 'profile_fax', 'profile_license',
      'profile_mailing_address', 'profile_phone', 'profile_signoff', 'profile_tagline', 'profile_website', 'status', 'updated_at',
    ]);
  });

  it('holds each profile field to one line within its limit, and the email to lowercase with an @', async () => {
    const refused = async (p: Partial<typeof PROFILE>) =>
      expect({ p, code: await errorCode(as(h.seed.a, (tx) => setProfile(tx, h.seed.a, p))) }).toEqual({ p, code: CHECK_VIOLATION });
    for (const [key, max] of [['address', 500], ['phone', 80], ['license', 80], ['signoff', 150]] as const) {
      for (const value of [' x', 'x ', 'a\nb', 'a\tb', 'x'.repeat(max + 1)]) await refused({ [key]: value });
    }
    for (const email of ['Office@Example.test', 'office example.test', 'office@', '@example.test', 'office@example', ' office@example.test', `${'x'.repeat(250)}@e.co`]) {
      await refused({ email });
    }
    await as(h.seed.a, (tx) => setProfile(tx, h.seed.a, { address: 'x'.repeat(500), phone: 'x'.repeat(80), license: 'x'.repeat(80), signoff: 'x'.repeat(150), email: 'office.q+x@example.test' }));
    // Clearing a field back to empty is allowed.
    await as(h.seed.a, (tx) => tx.execute(sql`UPDATE companies SET profile_license = '', profile_email = '' WHERE id = ${h.seed.a}::uuid`));
  });

  it('shows a platform operator the profile but lets it change only status and sign-in tenant, never the profile', async () => {
    await as(h.seed.a, (tx) => setProfile(tx, h.seed.a));
    const [seen] = await asOperator(async (tx) => rows<{ license: string }>(await tx.execute(sql`SELECT profile_license AS license FROM companies WHERE id = ${h.seed.a}::uuid`)));
    expect(seen).toEqual({ license: '123456' });
    for (const set of ["profile_address = 'Support edit'", "profile_phone = '(000) 000-0000'", "profile_email = 'x@example.test'", "profile_license = '000000'", "profile_signoff = 'Support'"]) {
      expect({ set, code: await errorCode(asOperator((tx) => tx.execute(sqlOf(`UPDATE companies SET ${set} WHERE id = '${h.seed.a}'`)))) }).toEqual({ set, code: CHECK_VIOLATION });
      // With no company named too: the operator's own policy sees every company row.
      expect(await errorCode(asOperator((tx) => tx.execute(sqlOf(`UPDATE companies SET ${set} WHERE id = '${h.seed.b}'`)), null))).toBe(CHECK_VIOLATION);
    }
    expect(await profileOf(h.seed.a)).toEqual([PROFILE]);
    // The operator's status change (0006) still works and leaves the profile as it was.
    expect(await asOperator((tx) => tx.execute(sql`UPDATE companies SET status = 'suspended' WHERE id = ${h.seed.b}::uuid RETURNING id`))).toHaveLength(1);
    expect(await h.admin`SELECT status FROM companies WHERE id = ${h.seed.b}`).toEqual([{ status: 'suspended' }]);
    expect(await profileOf(h.seed.b)).toEqual([EMPTY]);
  });
});
