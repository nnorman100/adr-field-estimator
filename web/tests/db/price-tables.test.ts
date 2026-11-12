import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@/db/client';
import { priceTableVersions, priceTableWorkingCopies } from '@/db/schema';
import { withCompany, withOperator, type CompanyTransaction } from '@/db/tenant';
import { unprotectedRelations } from './row-security-guard';
import { everything, resetTeamDatabase, startTeamServer, type Harness } from './team-harness';

// S4-5: the price table tables (migration 0009), as the app's runtime role on a server set up like a
// fresh Cloud SQL instance (see team-harness.ts). No route uses them yet, so these tests write and
// read through withCompany and withOperator exactly as S4-6's routes will.
const INSUFFICIENT_PRIVILEGE = '42501';
const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const READ_ONLY_TRANSACTION = '25006';
const TABLES = ['price_table_versions', 'price_table_working_copies'];

let base: Awaited<ReturnType<typeof startTeamServer>>;
let h: Harness;
// The runtime with several connections, so two transactions can overlap.
let pool: ReturnType<typeof openDatabase>;
let keyCounter = 0;

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

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    const found = error as { code?: string; cause?: { code?: string } };
    return found.code ?? found.cause?.code;
  }
  return undefined;
}

const content = { items: [], policy: {} };
const hashOf = (text: string) => createHash('sha256').update(text).digest('hex');
const nextKey = () => `publish-key-${String(++keyCounter).padStart(6, '0')}`;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Version = {
  company: string;
  sequence: number;
  actor: string;
  key: string;
  hash: string;
  engine: string;
  reason: string;
  source: string;
  content: unknown;
};
const version = (company: string, sequence: number, extra: Partial<Version> = {}): Version => ({
  company,
  sequence,
  actor: company === h.seed.a ? h.seed.ownerA.actor : h.seed.ownerB.actor,
  key: nextKey(),
  hash: hashOf(`${company}:${sequence}`),
  engine: 'dryscope-v3',
  reason: 'First prices',
  source: 'blank',
  content,
  ...extra,
});

const insertVersion = (tx: CompanyTransaction, v: Version) =>
  tx.execute(sql`
    INSERT INTO price_table_versions
      (company_id, sequence, content, content_hash, engine_version, reason, source, published_by_actor_id, publish_key)
    VALUES (${v.company}::uuid, ${v.sequence}, ${JSON.stringify(v.content)}::jsonb, ${v.hash}, ${v.engine}, ${v.reason}, ${v.source},
            ${v.actor}::uuid, ${v.key})
    RETURNING id, sequence
  `) as unknown as Promise<{ id: string; sequence: number }[]>;

const publishAs = (company: string, v: Version) => withCompany(h.handle.db, company, (tx) => insertVersion(tx, v));
const adminVersions = () =>
  h.admin<{ company_id: string; sequence: number }[]>`SELECT company_id, sequence FROM price_table_versions ORDER BY company_id, sequence`;
const adminCopies = () =>
  h.admin<{ company_id: string; base_sequence: number | null; revision: number }[]>`
    SELECT company_id, base_sequence, revision FROM price_table_working_copies ORDER BY company_id
  `;
const seedVersion = (company: string, sequence: number) =>
  h.admin`
    INSERT INTO price_table_versions (company_id, sequence, content, content_hash, engine_version, reason, source, published_by_actor_id, publish_key)
    VALUES (${company}, ${sequence}, ${h.admin.json(content)}, ${hashOf(`${company}:${sequence}`)}, 'dryscope-v3', 'Seeded', 'blank',
            ${company === h.seed.a ? h.seed.ownerA.actor : h.seed.ownerB.actor}, ${nextKey()})
  `;
const seedCopy = (company: string, baseSequence: number | null = null) =>
  h.admin`INSERT INTO price_table_working_copies (company_id, base_sequence, content) VALUES (${company}, ${baseSequence}, ${h.admin.json(content)})`;
const sqlOf = (text: string) => sql.raw(text);

describe('migration 0009: the two tables', () => {
  it('passes the row-level security guard: both tables are forced, have policies, and nothing else changed', async () => {
    expect(await unprotectedRelations(h.admin)).toEqual([]);
    const rows = await h.admin<{ name: string; enabled: boolean; forced: boolean; policies: number }[]>`
      SELECT c.relname AS name, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY(${TABLES}) ORDER BY 1
    `;
    expect(rows).toEqual([
      { name: 'price_table_versions', enabled: true, forced: true, policies: 2 },
      { name: 'price_table_working_copies', enabled: true, forced: true, policies: 3 },
    ]);
  });

  it('gives the runtime SELECT and INSERT on versions, and on working copies SELECT, INSERT and UPDATE of four columns', async () => {
    const tableLevel = await h.admin<{ table: string; privilege: string }[]>`
      SELECT table_name AS table, privilege_type AS privilege FROM information_schema.role_table_grants
      WHERE grantee = 'dryscope_runtime' AND table_name = ANY(${TABLES}) ORDER BY 1, 2
    `;
    expect(tableLevel).toEqual([
      { table: 'price_table_versions', privilege: 'INSERT' },
      { table: 'price_table_versions', privilege: 'SELECT' },
      { table: 'price_table_working_copies', privilege: 'INSERT' },
      { table: 'price_table_working_copies', privilege: 'SELECT' },
    ]);
    const updates = await h.admin<{ table: string; column: string }[]>`
      SELECT table_name AS table, column_name AS column FROM information_schema.column_privileges
      WHERE grantee = 'dryscope_runtime' AND table_name = ANY(${TABLES}) AND privilege_type = 'UPDATE' ORDER BY 1, 2
    `;
    expect(updates).toEqual(
      ['base_sequence', 'content', 'revision', 'updated_at'].map((column) => ({ table: 'price_table_working_copies', column })),
    );
  });

  it('works through the Drizzle view the routes will use', async () => {
    await withCompany(pool.db, h.seed.a, async (tx) => {
      const [created] = await tx
        .insert(priceTableVersions)
        .values({
          companyId: h.seed.a,
          sequence: 1,
          content,
          contentHash: hashOf('one'),
          engineVersion: 'dryscope-v3',
          reason: 'First prices',
          source: 'blank',
          publishedByActorId: h.seed.ownerA.actor,
          publishKey: nextKey(),
        })
        .returning();
      expect(created?.publishedAt).toBeInstanceOf(Date);
      await tx.insert(priceTableWorkingCopies).values({ companyId: h.seed.a, baseSequence: 1, content });
    });
    const [copy] = await withCompany(pool.db, h.seed.a, (tx) => tx.select().from(priceTableWorkingCopies));
    expect(copy).toMatchObject({ companyId: h.seed.a, baseSequence: 1, revision: 1, content });
    expect(await withCompany(pool.db, h.seed.b, (tx) => tx.select().from(priceTableVersions))).toEqual([]);
  });
});

describe('isolation between companies', () => {
  beforeEach(async () => {
    await seedVersion(h.seed.a, 1);
    await seedCopy(h.seed.a, 1);
    await seedVersion(h.seed.b, 1);
    await seedCopy(h.seed.b);
  });

  it('shows company B none of company A’s versions or working copies, and each only its own', async () => {
    for (const company of [h.seed.a, h.seed.b]) {
      const seen = await withCompany(pool.db, company, async (tx) => ({
        versions: (await tx.execute(sql`SELECT DISTINCT company_id::text AS c FROM price_table_versions`)) as unknown as { c: string }[],
        copies: (await tx.execute(sql`SELECT DISTINCT company_id::text AS c FROM price_table_working_copies`)) as unknown as { c: string }[],
      }));
      expect(seen).toEqual({ versions: [{ c: company }], copies: [{ c: company }] });
    }
    // Outside withCompany nothing is visible at all.
    expect(await pool.db.select().from(priceTableVersions)).toEqual([]);
    expect(await pool.db.select().from(priceTableWorkingCopies)).toEqual([]);
  });

  it('refuses a write for another company, and an update that cannot see the row changes nothing', async () => {
    const before = await everything(h.admin);
    expect(await errorCode(withCompany(pool.db, h.seed.b, (tx) => insertVersion(tx, version(h.seed.a, 1))))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(
      await errorCode(
        withCompany(pool.db, h.seed.b, (tx) =>
          tx.execute(sql`INSERT INTO price_table_working_copies (company_id, content) VALUES (${h.seed.a}::uuid, '{}'::jsonb)`),
        ),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    const changed = await withCompany(pool.db, h.seed.b, (tx) =>
      tx.execute(sql`UPDATE price_table_working_copies SET revision = 2, content = '{"items":[1]}'::jsonb WHERE company_id = ${h.seed.a}::uuid RETURNING company_id`),
    );
    expect(changed).toHaveLength(0);
    expect(await everything(h.admin)).toBe(before);
  });

  it('refuses a version published by, or a working copy based on, another company’s row (composite keys)', async () => {
    const before = await everything(h.admin);
    // Company B publishing as company A's owner.
    expect(
      await errorCode(withCompany(pool.db, h.seed.b, (tx) => insertVersion(tx, version(h.seed.b, 2, { actor: h.seed.ownerA.actor })))),
    ).toBe(FOREIGN_KEY_VIOLATION);
    // Company A has a version 1 and so does B, but a company with only version 1 has no version 2.
    expect(
      await errorCode(withCompany(pool.db, h.seed.b, (tx) => tx.execute(sql`UPDATE price_table_working_copies SET base_sequence = 2, revision = 2`))),
    ).toBe(FOREIGN_KEY_VIOLATION);
    // Even as the superuser: B's copy cannot name a version only A has.
    await seedVersion(h.seed.a, 2);
    expect(await errorCode(h.admin`UPDATE price_table_working_copies SET base_sequence = 2, revision = 2 WHERE company_id = ${h.seed.b}`)).toBe(
      FOREIGN_KEY_VIOLATION,
    );
    expect(await adminVersions()).toHaveLength(3);
    expect(before).toContain(h.seed.a);
  });

  it('refuses another company’s version id as a key for a later row (the pin’s composite key)', async () => {
    // S5a-1's pins name (company, version id). Prove the key exists and refuses a cross-company pair.
    const [a1] = await h.admin<{ id: string }[]>`SELECT id FROM price_table_versions WHERE company_id = ${h.seed.a} AND sequence = 1`;
    await h.admin`CREATE TABLE probe_pin (company_id uuid, version_id uuid, FOREIGN KEY (company_id, version_id) REFERENCES price_table_versions (company_id, id))`;
    await h.admin`INSERT INTO probe_pin VALUES (${h.seed.a}, ${a1!.id})`;
    expect(await errorCode(h.admin`INSERT INTO probe_pin VALUES (${h.seed.b}, ${a1!.id})`)).toBe(FOREIGN_KEY_VIOLATION);
  });
});

describe('a version cannot be changed or removed', () => {
  beforeEach(async () => {
    await seedVersion(h.seed.a, 1);
  });

  it('refuses every update, delete and truncate as the runtime, and the table owner reads and writes nothing', async () => {
    const before = await everything(h.admin);
    for (const statement of [
      'UPDATE price_table_versions SET reason = \'Changed afterwards\'',
      'UPDATE price_table_versions SET content = \'{"items":[1]}\'::jsonb',
      'UPDATE price_table_versions SET sequence = 9',
      'DELETE FROM price_table_versions',
      'TRUNCATE price_table_versions',
    ]) {
      expect({ statement, code: await errorCode(withCompany(pool.db, h.seed.a, (tx) => tx.execute(sqlOf(statement)))) }).toEqual({
        statement,
        code: INSUFFICIENT_PRIVILEGE,
      });
    }
    expect(await everything(h.admin)).toBe(before);
    // The migrator that owns the tables is bound by forced row-level security: no policy names it.
    const owner = postgres(h.migratorUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
    try {
      expect(await owner`SELECT count(*)::int AS n FROM price_table_versions`).toEqual([{ n: 0 }]);
      expect((await owner`UPDATE price_table_versions SET reason = 'Changed afterwards'`).count).toBe(0);
      expect((await owner`DELETE FROM price_table_versions`).count).toBe(0);
    } finally {
      await owner.end({ timeout: 5 });
    }
    expect(await everything(h.admin)).toBe(before);
  });
});

describe('what a version must hold', () => {
  const refused = async (extra: Partial<Version>, code = CHECK_VIOLATION) =>
    expect(await errorCode(publishAs(h.seed.a, version(h.seed.a, 1, extra)))).toBe(code);

  it('accepts a well-formed first version and stores it as given', async () => {
    const [row] = await publishAs(h.seed.a, version(h.seed.a, 1, { reason: 'First prices' }));
    expect(row?.sequence).toBe(1);
    expect(await adminVersions()).toEqual([{ company_id: h.seed.a, sequence: 1 }]);
  });

  it('refuses a content hash that is not 64 lowercase hex characters', async () => {
    for (const hash of ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), `${'a'.repeat(63)}g`, ` ${'a'.repeat(63)}`]) {
      await refused({ hash });
    }
    await publishAs(h.seed.a, version(h.seed.a, 1, { hash: 'f'.repeat(64) }));
  });

  it('refuses a reason under 3 or over 500 characters, or padded with spaces', async () => {
    for (const reason of ['', 'ab', '  ab  ', ' Price update', 'Price update ', 'x'.repeat(501)]) {
      await refused({ reason });
    }
    await publishAs(h.seed.a, version(h.seed.a, 1, { reason: 'abc' }));
    await publishAs(h.seed.a, version(h.seed.a, 2, { reason: 'x'.repeat(500) }));
  });

  it('refuses an engine version that is not named dryscope-v and a number', async () => {
    for (const engine of ['', 'v3', 'dryscope-v', 'dryscope-3', 'dryscope-v1234', 'DRYSCOPE-V3', 'dryscope-v3 ', 'dryscope-v3-beta']) {
      await refused({ engine });
    }
    await publishAs(h.seed.a, version(h.seed.a, 1, { engine: 'dryscope-v2' }));
  });

  it('refuses a source other than blank, import or restore, content that is not an object, and a sequence below 1', async () => {
    for (const source of ['', 'Blank', 'starter', 'publish']) await refused({ source });
    for (const bad of [[], 'text', 3, null]) await refused({ content: bad });
    await refused({ sequence: 0 });
    await refused({ sequence: -1 });
    for (const source of ['blank', 'import', 'restore']) {
      await publishAs(h.seed.a, version(h.seed.a, source === 'blank' ? 1 : source === 'import' ? 2 : 3, { source }));
    }
  });

  it('refuses a publish key that is too short, too long or has characters outside letters, digits and . _ : -', async () => {
    for (const key of ['', 'short', 'k'.repeat(129), 'has space 1234', 'semi;colon1', 'new\nline123']) await refused({ key });
    await publishAs(h.seed.a, version(h.seed.a, 1, { key: 'k'.repeat(128) }));
  });

  it('refuses a version with any field missing', async () => {
    const values: Record<string, string> = {
      company_id: `'${h.seed.a}'::uuid`,
      sequence: '1',
      content: "'{}'::jsonb",
      content_hash: `'${'a'.repeat(64)}'`,
      engine_version: "'dryscope-v3'",
      reason: "'First prices'",
      source: "'blank'",
      published_by_actor_id: `'${h.seed.ownerA.actor}'::uuid`,
      publish_key: `'${nextKey()}'`,
    };
    for (const column of Object.keys(values)) {
      const columns = Object.keys(values).filter((name) => name !== column);
      const insert = `INSERT INTO price_table_versions (${columns.join(', ')}) VALUES (${columns.map((name) => values[name]).join(', ')})`;
      // Without a sequence the numbering trigger, which runs first, refuses; every other column is NOT NULL.
      const code = column === 'sequence' ? CHECK_VIOLATION : '23502';
      expect({ column, code: await errorCode(h.admin.unsafe(insert)) }).toEqual({ column, code });
    }
  });
});

describe('numbering and retries', () => {
  it('numbers versions 1, 2, 3 for each company on its own, and refuses a gap, a repeat or a number out of order', async () => {
    await publishAs(h.seed.a, version(h.seed.a, 1));
    await publishAs(h.seed.a, version(h.seed.a, 2));
    // B starts at its own 1, not after A's.
    await publishAs(h.seed.b, version(h.seed.b, 1));
    expect(await errorCode(publishAs(h.seed.a, version(h.seed.a, 4)))).toBe(CHECK_VIOLATION);
    expect(await errorCode(publishAs(h.seed.b, version(h.seed.b, 2, { key: 'k'.repeat(8) })))).toBeUndefined();
    expect(await errorCode(publishAs(h.seed.b, version(h.seed.b, 1)))).toBe(CHECK_VIOLATION);
    expect(await errorCode(publishAs(h.seed.a, version(h.seed.a, 1)))).toBe(CHECK_VIOLATION);
    expect(await errorCode(publishAs(h.seed.a, version(h.seed.a, 5)))).toBe(CHECK_VIOLATION);
    await publishAs(h.seed.a, version(h.seed.a, 3));
    expect(await adminVersions()).toEqual(
      [
        { company_id: h.seed.a, sequence: 1 },
        { company_id: h.seed.a, sequence: 2 },
        { company_id: h.seed.a, sequence: 3 },
        { company_id: h.seed.b, sequence: 1 },
        { company_id: h.seed.b, sequence: 2 },
      ].sort((x, y) => (x.company_id === y.company_id ? x.sequence - y.sequence : x.company_id < y.company_id ? -1 : 1)),
    );
  });

  it('answers a retried publish with the same key from the stored version, and refuses to store it twice', async () => {
    const first = version(h.seed.a, 1, { key: 'retry-key-0001' });
    const [stored] = await publishAs(h.seed.a, first);
    // The retry: the second insert is refused by the key, and a read by key finds the first version.
    expect(await errorCode(publishAs(h.seed.a, { ...first, sequence: 2 }))).toBe(UNIQUE_VIOLATION);
    const found = await withCompany(h.handle.db, h.seed.a, (tx) =>
      tx.execute(sql`SELECT id, sequence FROM price_table_versions WHERE publish_key = 'retry-key-0001'`),
    );
    expect(found).toEqual([{ id: stored!.id, sequence: 1 }]);
    expect(await adminVersions()).toHaveLength(1);
    // Another company may use the same key: keys are unique per company.
    await publishAs(h.seed.b, version(h.seed.b, 1, { key: 'retry-key-0001' }));
    // And B never finds A's version by it.
    const crossed = await withCompany(h.handle.db, h.seed.b, (tx) =>
      tx.execute(sql`SELECT id FROM price_table_versions WHERE company_id = ${h.seed.a}::uuid`),
    );
    expect(crossed).toHaveLength(0);
  });

  it('gives two publishes at once n and n+1 or one refusal, never two version n', async () => {
    // Both race for number 1 of a company with no version.
    let inserted!: () => void;
    const first = new Promise<void>((resolve) => (inserted = resolve));
    const slow = withCompany(pool.db, h.seed.a, async (tx) => {
      await insertVersion(tx, version(h.seed.a, 1));
      inserted();
      await pause(400);
    });
    const racing = (async () => {
      await first;
      const started = Date.now();
      const code = await errorCode(withCompany(pool.db, h.seed.a, (tx) => insertVersion(tx, version(h.seed.a, 1))));
      return { code, waited: Date.now() - started };
    })();
    await slow;
    const second = await racing;
    expect(second.code).toBe(UNIQUE_VIOLATION);
    // It really waited for the first to commit instead of failing at once.
    expect(second.waited).toBeGreaterThanOrEqual(250);
    expect(await adminVersions()).toEqual([{ company_id: h.seed.a, sequence: 1 }]);
  });

  it('refuses the second of two overlapping publishes whichever number it took', async () => {
    await seedVersion(h.seed.a, 1);
    for (const secondNumber of [2, 3]) {
      let inserted!: () => void;
      const first = new Promise<void>((resolve) => (inserted = resolve));
      const current = (await adminVersions()).length;
      const slow = withCompany(pool.db, h.seed.a, async (tx) => {
        await insertVersion(tx, version(h.seed.a, current + 1));
        inserted();
        await pause(300);
      });
      const racing = (async () => {
        await first;
        // Number current + 1 repeats the first's number; current + 2 skips ahead of what it can see.
        return errorCode(withCompany(pool.db, h.seed.a, (tx) => insertVersion(tx, version(h.seed.a, current + secondNumber - 1))));
      })();
      await slow;
      expect(await racing).toBe(secondNumber === 2 ? UNIQUE_VIOLATION : CHECK_VIOLATION);
    }
    expect(await adminVersions()).toEqual([
      { company_id: h.seed.a, sequence: 1 },
      { company_id: h.seed.a, sequence: 2 },
      { company_id: h.seed.a, sequence: 3 },
    ]);
  });
});

describe('working copies', () => {
  const update = (tx: CompanyTransaction, statement: string) => tx.execute(sqlOf(statement));
  const insertCopy = (company: string, extra = '') =>
    withCompany(h.handle.db, company, (tx) =>
      tx.execute(sql`INSERT INTO price_table_working_copies (company_id, content) VALUES (${company}::uuid, '{"items":[]}'::jsonb) ${sql.raw(extra)}`),
    );

  it('keeps one row per company, starting at revision 1 with no base version', async () => {
    await insertCopy(h.seed.a);
    expect(await errorCode(insertCopy(h.seed.a))).toBe(UNIQUE_VIOLATION);
    expect(await adminCopies()).toEqual([{ company_id: h.seed.a, base_sequence: null, revision: 1 }]);
    // A row that starts anywhere but revision 1, or with content that is not an object, is refused.
    expect(await errorCode(withCompany(h.handle.db, h.seed.b, (tx) => update(tx, `INSERT INTO price_table_working_copies (company_id, content, revision) VALUES ('${h.seed.b}', '{}', 2)`)))).toBe(CHECK_VIOLATION);
    expect(await errorCode(withCompany(h.handle.db, h.seed.b, (tx) => update(tx, `INSERT INTO price_table_working_copies (company_id, content) VALUES ('${h.seed.b}', '[]')`)))).toBe(CHECK_VIOLATION);
    expect(await errorCode(withCompany(h.handle.db, h.seed.b, (tx) => update(tx, `INSERT INTO price_table_working_copies (company_id, content, revision) VALUES ('${h.seed.b}', '{}', 0)`)))).toBe(CHECK_VIOLATION);
    expect(await adminCopies()).toHaveLength(1);
  });

  it('raises the revision by exactly one with each change and refuses a skip, a repeat or a rewind', async () => {
    await insertCopy(h.seed.a);
    const save = (revision: number) =>
      withCompany(h.handle.db, h.seed.a, (tx) => update(tx, `UPDATE price_table_working_copies SET revision = ${revision}, content = '{"items":[${revision}]}'::jsonb, updated_at = now()`));
    await save(2);
    for (const revision of [2, 4, 1, 0]) expect({ revision, code: await errorCode(save(revision)) }).toEqual({ revision, code: CHECK_VIOLATION });
    // An update that leaves the revision alone is a stale save too.
    expect(await errorCode(withCompany(h.handle.db, h.seed.a, (tx) => update(tx, `UPDATE price_table_working_copies SET content = '{}'::jsonb`)))).toBe(CHECK_VIOLATION);
    await save(3);
    expect(await adminCopies()).toEqual([{ company_id: h.seed.a, base_sequence: null, revision: 3 }]);
  });

  it('gives two saves of the same revision at once one success and one stale refusal', async () => {
    await insertCopy(h.seed.a);
    let updated!: () => void;
    const first = new Promise<void>((resolve) => (updated = resolve));
    const save = (tx: CompanyTransaction, content: string) =>
      tx.execute(sql`UPDATE price_table_working_copies SET revision = 2, content = ${content}::jsonb WHERE company_id = ${h.seed.a}::uuid AND revision = 1 RETURNING revision`);
    const slow = withCompany(pool.db, h.seed.a, async (tx) => {
      const rows = await save(tx, '{"items":["first"]}');
      updated();
      await pause(300);
      return rows;
    });
    const stale = (async () => {
      await first;
      return withCompany(pool.db, h.seed.a, (tx) => save(tx, '{"items":["second"]}'));
    })();
    expect(await slow).toHaveLength(1);
    // The expected-revision test no longer matches once the first commits, so nothing is written.
    expect(await stale).toHaveLength(0);
    const [row] = await h.admin<{ content: unknown; revision: number }[]>`SELECT content, revision FROM price_table_working_copies`;
    expect(row).toEqual({ content: { items: ['first'] }, revision: 2 });
    // A blind save made from the stale copy, with no revision test, is refused by the database.
    expect(
      await errorCode(withCompany(pool.db, h.seed.a, (tx) => tx.execute(sql`UPDATE price_table_working_copies SET revision = 2, content = '{}'::jsonb`))),
    ).toBe(CHECK_VIOLATION);
  });

  it('may start from, and move to, a version of its own company, and refuses one that does not exist', async () => {
    await seedVersion(h.seed.a, 1);
    await insertCopy(h.seed.a);
    const rebase = (sequence: number, revision: number) =>
      withCompany(h.handle.db, h.seed.a, (tx) => update(tx, `UPDATE price_table_working_copies SET base_sequence = ${sequence}, revision = ${revision}`));
    await rebase(1, 2);
    expect(await errorCode(rebase(2, 3))).toBe(FOREIGN_KEY_VIOLATION);
    expect(await errorCode(rebase(0, 3))).toBe(CHECK_VIOLATION);
    expect(await adminCopies()).toEqual([{ company_id: h.seed.a, base_sequence: 1, revision: 2 }]);
  });

  it('never changes a copy’s company, and the runtime cannot delete or truncate one', async () => {
    await insertCopy(h.seed.a);
    const before = await everything(h.admin);
    for (const statement of [
      `UPDATE price_table_working_copies SET company_id = '${h.seed.b}', revision = 2`,
      `UPDATE price_table_working_copies SET created_at = now() - interval '1 day', revision = 2`,
      'DELETE FROM price_table_working_copies',
      'TRUNCATE price_table_working_copies',
    ]) {
      expect({ statement, code: await errorCode(withCompany(h.handle.db, h.seed.a, (tx) => update(tx, statement))) }).toEqual({
        statement,
        code: INSUFFICIENT_PRIVILEGE,
      });
    }
    expect(await everything(h.admin)).toBe(before);
  });
});

describe('the platform operator', () => {
  beforeEach(async () => {
    await seedVersion(h.seed.a, 1);
    await seedCopy(h.seed.a, 1);
  });

  const asOperator = <T>(run: (tx: CompanyTransaction) => Promise<T>, readOnly = false, companyId: string | null = h.seed.a) =>
    withOperator(h.handle.db, h.seed.operator, run, { companyId: companyId ?? undefined, readOnly });

  it('reads one company’s prices in a read-only context that names it, and nothing without one', async () => {
    const read = await asOperator(
      (tx) => tx.execute(sql`SELECT (SELECT count(*)::int FROM price_table_versions) AS versions, (SELECT count(*)::int FROM price_table_working_copies) AS copies`),
      true,
    );
    expect(read).toEqual([{ versions: 1, copies: 1 }]);
    const none = await asOperator(
      (tx) => tx.execute(sql`SELECT (SELECT count(*)::int FROM price_table_versions) AS versions, (SELECT count(*)::int FROM price_table_working_copies) AS copies`),
      true,
      null,
    );
    expect(none).toEqual([{ versions: 0, copies: 0 }]);
  });

  it('cannot write a version or a working copy, in a read-only context or not', async () => {
    const before = await everything(h.admin);
    const writes: ((tx: CompanyTransaction) => Promise<unknown>)[] = [
      (tx) => insertVersion(tx, version(h.seed.a, 2)),
      (tx) => tx.execute(sql`INSERT INTO price_table_working_copies (company_id, content) VALUES (${h.seed.b}::uuid, '{}'::jsonb)`),
    ];
    for (const write of writes) {
      expect(await errorCode(asOperator(write))).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await errorCode(asOperator(write, true))).toBe(READ_ONLY_TRANSACTION);
    }
    // An update finds no row it may change, and in a read-only context it is refused outright.
    const save = (tx: CompanyTransaction) =>
      tx.execute(sql`UPDATE price_table_working_copies SET revision = 2, content = '{"items":[1]}'::jsonb RETURNING revision`);
    expect(await asOperator(save)).toHaveLength(0);
    expect(await errorCode(asOperator(save, true))).toBe(READ_ONLY_TRANSACTION);
    expect(await everything(h.admin)).toBe(before);
  });
});
