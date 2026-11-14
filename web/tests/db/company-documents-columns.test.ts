import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@/db/client';
import { withCompany, withOperator, type CompanyTransaction } from '@/db/tenant';
import { CHECK_VIOLATION, errorCode } from './job-harness';
import { everything, resetTeamDatabase, startTeamServer, type Harness } from './team-harness';

// S5a-4b, migration 0013: the letterhead columns and the document settings on companies, the
// column-level UPDATE grant and 0010's trigger split extended to them (the guard test). Same setup as
// evidence-profile.test.ts, which covers 0010's five profile columns.
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
const sqlOf = (text: string) => sql.raw(text);

const LINES = {
  profile_emergency_phone: ['(555) 010-0199', 80],
  profile_fax: ['(555) 010-0102', 80],
  profile_website: ['www.example.com', 200],
  profile_tagline: ['Water damage and mold remediation', 150],
  profile_mailing_address: ['PO Box 100, Testville, CA 90000', 500],
} as const;
const COLUMNS = [...Object.keys(LINES), 'profile_documents'] as const;
const DOCUMENTS = { proposal_layout: 'letter', prep_tasks: ['The homeowner clears the closet.'], authorization_text: 'I authorize the work.' };
const EMPTY = { profile_emergency_phone: '', profile_fax: '', profile_website: '', profile_tagline: '', profile_mailing_address: '', profile_documents: {} };

const columnsOf = (company: string) =>
  h.admin`SELECT profile_emergency_phone, profile_fax, profile_website, profile_tagline, profile_mailing_address, profile_documents FROM companies WHERE id = ${company}`;
const setAll = (tx: CompanyTransaction, company: string) =>
  tx.execute(sql`
    UPDATE companies SET profile_emergency_phone = ${LINES.profile_emergency_phone[0]}, profile_fax = ${LINES.profile_fax[0]},
      profile_website = ${LINES.profile_website[0]}, profile_tagline = ${LINES.profile_tagline[0]},
      profile_mailing_address = ${LINES.profile_mailing_address[0]}, profile_documents = ${JSON.stringify(DOCUMENTS)}::jsonb, updated_at = now()
    WHERE id = ${company}::uuid RETURNING id::text
  `);
const SET = {
  ...Object.fromEntries(Object.entries(LINES).map(([column, [value]]) => [column, value])),
  profile_documents: DOCUMENTS,
};

describe('the letterhead and document settings columns (0013)', () => {
  it('start empty, with the settings an empty object, for every company: no company’s values are seeded', async () => {
    for (const company of [h.seed.a, h.seed.b, h.seed.suspended]) expect(await columnsOf(company)).toEqual([EMPTY]);
  });

  it('let a company’s own transaction set them and read them back, and touch no other company', async () => {
    expect(await as(h.seed.a, (tx) => setAll(tx, h.seed.a))).toHaveLength(1);
    expect(await columnsOf(h.seed.a)).toEqual([SET]);
    expect(await columnsOf(h.seed.b)).toEqual([EMPTY]);
    // Clearing a line and the settings again is allowed.
    await as(h.seed.a, (tx) => tx.execute(sql`UPDATE companies SET profile_fax = '', profile_documents = '{}'::jsonb WHERE id = ${h.seed.a}::uuid`));
    expect(await columnsOf(h.seed.a)).toEqual([{ ...SET, profile_fax: '', profile_documents: {} }]);
  });

  it('find no row to change when company B tries company A’s, and none outside a company transaction', async () => {
    expect(await as(h.seed.b, (tx) => setAll(tx, h.seed.a))).toHaveLength(0);
    expect(await pool.db.execute(sql`UPDATE companies SET profile_tagline = 'Outside' RETURNING id`)).toHaveLength(0);
    expect(await columnsOf(h.seed.a)).toEqual([EMPTY]);
    // An update with no WHERE changes only the caller's own company.
    expect(await as(h.seed.b, (tx) => tx.execute(sql`UPDATE companies SET profile_documents = '{"show_previous_price": true}'::jsonb RETURNING id`))).toHaveLength(1);
    expect(await columnsOf(h.seed.a)).toEqual([EMPTY]);
    expect(await columnsOf(h.seed.b)).toEqual([{ ...EMPTY, profile_documents: { show_previous_price: true } }]);
  });

  it('let a change to them carry no status or sign-in tenant change: the whole update is refused', async () => {
    const before = await everything(h.admin);
    for (const column of COLUMNS) {
      const value = column === 'profile_documents' ? `'{}'::jsonb` : `'x'`;
      for (const also of ["status = 'suspended'", "auth_tenant_id = 'tenant-z'"]) {
        const statement = `UPDATE companies SET ${column} = ${value}, ${also} WHERE id = '${h.seed.a}'`;
        expect({ statement, code: await errorCode(as(h.seed.a, (tx) => tx.execute(sqlOf(statement)))) }).toEqual({ statement, code: CHECK_VIOLATION });
      }
    }
    expect(await everything(h.admin)).toBe(before);
  });

  it('hold each letterhead line to one line within its limit, with no padding', async () => {
    for (const [column, [, max]] of Object.entries(LINES)) {
      for (const value of [' x', 'x ', 'a\nb', 'a\tb', 'x'.repeat(max + 1)]) {
        const code = await errorCode(as(h.seed.a, (tx) => tx.execute(sql`UPDATE companies SET ${sql.identifier(column)} = ${value} WHERE id = ${h.seed.a}::uuid`)));
        expect({ column, value: value.slice(0, 5), code }).toEqual({ column, value: value.slice(0, 5), code: CHECK_VIOLATION });
      }
      await as(h.seed.a, (tx) => tx.execute(sql`UPDATE companies SET ${sql.identifier(column)} = ${'x'.repeat(max)} WHERE id = ${h.seed.a}::uuid`));
    }
  });

  it('hold the settings to a JSON object under 64 KiB', async () => {
    const set = (value: string) => as(h.seed.a, (tx) => tx.execute(sql`UPDATE companies SET profile_documents = ${value}::jsonb WHERE id = ${h.seed.a}::uuid`));
    for (const value of ['[]', '"letter"', '1', 'null', 'true']) expect({ value, code: await errorCode(set(value)) }).toEqual({ value, code: CHECK_VIOLATION });
    // jsonb's text form of {"a": "..."} is 9 bytes plus the string: 65,535 bytes passes, 65,536 does not.
    expect(await errorCode(set(JSON.stringify({ a: 'x'.repeat(65_536 - 9) })))).toBe(CHECK_VIOLATION);
    await set(JSON.stringify({ a: 'x'.repeat(65_535 - 9) }));
    expect((await h.admin`SELECT octet_length(profile_documents::text) AS n FROM companies WHERE id = ${h.seed.a}`)[0]).toEqual({ n: 65_535 });
    // A missing value is not "no settings": the column is NOT NULL.
    expect(await errorCode(as(h.seed.a, (tx) => tx.execute(sql`UPDATE companies SET profile_documents = NULL WHERE id = ${h.seed.a}::uuid`)))).toBe('23502');
  });

  it('show a platform operator the settings but let it change none of the six columns, only status and sign-in tenant', async () => {
    await as(h.seed.a, (tx) => setAll(tx, h.seed.a));
    const seen = await asOperator(async (tx) => tx.execute(sql`SELECT profile_tagline AS tagline, profile_documents AS documents FROM companies WHERE id = ${h.seed.a}::uuid`));
    expect([...seen]).toEqual([{ tagline: LINES.profile_tagline[0], documents: DOCUMENTS }]);
    for (const column of COLUMNS) {
      // A value that differs from both companies' (an unchanged value is not a change to refuse).
      const value = column === 'profile_documents' ? `'{"show_previous_price": true}'::jsonb` : `'Support edit'`;
      const statement = (company: string) => `UPDATE companies SET ${column} = ${value} WHERE id = '${company}'`;
      expect({ column, code: await errorCode(asOperator((tx) => tx.execute(sqlOf(statement(h.seed.a))))) }).toEqual({ column, code: CHECK_VIOLATION });
      // With no company named too: the operator's own policy sees every company row.
      expect({ column, code: await errorCode(asOperator((tx) => tx.execute(sqlOf(statement(h.seed.b))), null)) }).toEqual({ column, code: CHECK_VIOLATION });
    }
    expect(await columnsOf(h.seed.a)).toEqual([SET]);
    // The operator's status change (0006) still works and leaves the settings as they were.
    expect(await asOperator((tx) => tx.execute(sql`UPDATE companies SET status = 'suspended' WHERE id = ${h.seed.a}::uuid RETURNING id`))).toHaveLength(1);
    expect(await columnsOf(h.seed.a)).toEqual([SET]);
  });

  it('are never set by a new company’s insert beyond the defaults the table owner gives it', async () => {
    const id = randomUUID();
    await h.admin`INSERT INTO auth_tenants (id, kind) VALUES ('tenant-n', 'company')`;
    await h.admin`INSERT INTO companies (id, name, sign_in_slug, auth_tenant_id) VALUES (${id}, 'New Co', 'new-co', 'tenant-n')`;
    expect(await columnsOf(id)).toEqual([EMPTY]);
  });
});
