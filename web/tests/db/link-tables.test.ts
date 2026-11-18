import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withCompany, withOperator, type CompanyTransaction } from '@/db/tenant';
import { sharedRoles } from './postgres-harness';
import { unprotectedRelations } from './row-security-guard';
import { CHECK_VIOLATION, FOREIGN_KEY_VIOLATION, INSUFFICIENT_PRIVILEGE, UNIQUE_VIOLATION, digestOf, errorCode } from './job-harness';
import { agreementOf, insertAgreement, seedChain, type Chain } from './submission-harness';
import { resetTeamDatabase, startTeamServer, type Harness } from './team-harness';

// S5a-11b: migration 0014's two link tables, the agreements column and the token lookups, as the
// app's runtime role on a server set up like a fresh Cloud SQL instance (team-harness.ts). The routes
// over them are in signing-links.test.ts and document-links.test.ts.
const TABLES = ['document_links', 'signing_links'];

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
const hash = (seed: string) => digestOf(`token ${seed}`);

// A pending signing link for the chain's estimate, written by the runtime in the company.
async function signingLink(c: Chain, id = randomUUID(), token = hash(id)) {
  await as(c.company, (tx) =>
    tx.execute(sql`
      INSERT INTO signing_links (id, company_id, job_id, estimate_id, token_sha256, request_digest, created_by_actor_id, expires_at)
      VALUES (${id}::uuid, ${c.company}::uuid, ${c.job.id}::uuid, ${c.estimate.id}::uuid, ${token}, ${digestOf(id)}, ${c.actor}::uuid, now() + interval '7 days')
    `),
  );
  return { id, token };
}

const linkRow = async (id: string) =>
  (await h.admin<{ status: string; token_sha256: string; token_issued_at: Date; ended_at: Date | null; used_at: Date | null; sign_attempts: number }[]>`
    SELECT status, token_sha256, token_issued_at, ended_at, used_at, sign_attempts FROM signing_links WHERE id = ${id}
  `)[0]!;

const update = (company: string, id: string, set: string) => errorCode(as(company, (tx) => tx.execute(sql.raw(`UPDATE signing_links SET ${set} WHERE id = '${id}'`))));

describe('migration 0014: the link tables', () => {
  it('forces row-level security with company policies, and gives the runtime no DELETE', async () => {
    expect(await unprotectedRelations(h.admin)).toEqual([]);
    const found = await h.admin<{ name: string; forced: boolean; policies: string[] }[]>`
      SELECT c.relname AS name, c.relforcerowsecurity AS forced, array(SELECT p.polname::text FROM pg_policy p WHERE p.polrelid = c.oid ORDER BY 1) AS policies
      FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY(${TABLES}) ORDER BY 1
    `;
    expect(found).toEqual(
      TABLES.map((name) => ({ name, forced: true, policies: [`${name}_insert`, `${name}_owner_lookup`, `${name}_select`, `${name}_update`] })),
    );
    const updates = await h.admin<{ table: string; column: string }[]>`
      SELECT table_name AS table, column_name AS column FROM information_schema.column_privileges
      WHERE grantee = 'dryscope_runtime' AND table_name = ANY(${TABLES}) AND privilege_type = 'UPDATE' ORDER BY 1, 2
    `;
    expect(updates).toEqual([
      ...['ended_at', 'ended_by_actor_id', 'read_count', 'read_window_start', 'status', 'token_sha256'].map((column) => ({ table: 'document_links', column })),
      ...['agreement_id', 'ended_at', 'ended_by_actor_id', 'read_count', 'read_window_start', 'sign_attempts', 'status', 'token_sha256', 'used_at'].map((column) => ({
        table: 'signing_links',
        column,
      })),
    ]);
    const c = await seedChain(h.admin, h.seed.a, h.seed.ownerA.actor);
    const { id } = await signingLink(c);
    expect(await errorCode(as(h.seed.a, (tx) => tx.execute(sql`DELETE FROM signing_links WHERE id = ${id}::uuid`)))).toBe(INSUFFICIENT_PRIVILEGE);
    // The other company sees and changes nothing; an operator reads but never writes.
    expect(rows(await as(h.seed.b, (tx) => tx.execute(sql`SELECT id FROM signing_links`)))).toEqual([]);
    expect(rows(await as(h.seed.b, (tx) => tx.execute(sql`UPDATE signing_links SET status = 'revoked' WHERE id = ${id}::uuid RETURNING id`)))).toEqual([]);
    const seen = await withOperator(h.handle.db, h.seed.operator, (tx) => tx.execute(sql`SELECT id::text FROM signing_links`), { companyId: h.seed.a, readOnly: true });
    expect(rows(seen)).toEqual([{ id }]);
    const written = await withOperator(h.handle.db, h.seed.operator, (tx) => tx.execute(sql`UPDATE signing_links SET status = 'revoked' WHERE id = ${id}::uuid RETURNING id`), { companyId: h.seed.a });
    expect(rows(written)).toEqual([]);
    expect((await linkRow(id)).status).toBe('pending');
  });

  it('finds a token’s company only through its lookup, never by setting the lookup’s switch', async () => {
    const c = await seedChain(h.admin, h.seed.a, h.seed.ownerA.actor);
    const { token } = await signingLink(c);
    const runtime = postgres(h.apiUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
    try {
      expect(await runtime`SELECT signing_link_company(${token})::text AS id`).toEqual([{ id: h.seed.a }]);
      expect(await runtime`SELECT signing_link_company(${hash('unknown')})::text AS id`).toEqual([{ id: null }]);
      expect(await runtime`SELECT document_link_company(${token})::text AS id`).toEqual([{ id: null }]);
      await runtime`SELECT set_config('app.link_lookup', 'on', false)`;
      expect(await runtime`SELECT id FROM signing_links`).toEqual([]);
    } finally {
      await runtime.end({ timeout: 5 });
    }
    // Only the runtime may call the lookups.
    const url = new URL(base.server.databaseUrl);
    url.username = sharedRoles().other.name;
    url.password = sharedRoles().other.password;
    const other = postgres(url.toString(), { max: 1, connect_timeout: 10, onnotice: () => {} });
    try {
      expect(await errorCode(other`SELECT signing_link_company(${token})`)).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await errorCode(other`SELECT document_link_company(${token})`)).toBe(INSUFFICIENT_PRIVILEGE);
    } finally {
      await other.end({ timeout: 5 });
    }
    const [fn] = await h.admin<{ definer: boolean; config: string[] }[]>`SELECT prosecdef AS definer, proconfig AS config FROM pg_proc WHERE proname = 'signing_link_company'`;
    expect(fn).toEqual({ definer: true, config: ['search_path=pg_catalog, pg_temp'] });
  });

  it('keeps one pending link per job, a unique token, and seven days from creation', async () => {
    const c = await seedChain(h.admin, h.seed.a, h.seed.ownerA.actor);
    const first = await signingLink(c);
    expect(await errorCode(signingLink(c))).toBe(UNIQUE_VIOLATION);
    expect(await update(h.seed.a, first.id, "status = 'revoked'")).toBeUndefined();
    expect(await errorCode(signingLink(c, randomUUID(), first.token))).toBe(UNIQUE_VIOLATION);
    await signingLink(c);
    const id = randomUUID();
    expect(
      await errorCode(
        as(c.company, (tx) =>
          tx.execute(sql`
            INSERT INTO signing_links (id, company_id, job_id, estimate_id, token_sha256, request_digest, created_by_actor_id, expires_at)
            VALUES (${id}::uuid, ${c.company}::uuid, ${c.job.id}::uuid, ${c.estimate.id}::uuid, ${hash(id)}, ${digestOf(id)}, ${c.actor}::uuid, now() + interval '30 days')
          `),
        ),
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it('lets a pending link change its token and counters or end once; its identity and an ended link never change', async () => {
    const c = await seedChain(h.admin, h.seed.a, h.seed.ownerA.actor);
    const { id } = await signingLink(c);
    const before = await linkRow(id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await update(h.seed.a, id, `token_sha256 = '${hash('second')}', sign_attempts = 1`)).toBeUndefined();
    const rotated = await linkRow(id);
    expect(rotated.token_issued_at.getTime()).toBeGreaterThan(before.token_issued_at.getTime());
    expect(await update(h.seed.a, id, 'sign_attempts = 0')).toBe(CHECK_VIOLATION);
    expect(await update(h.seed.a, id, `ended_at = now()`)).toBe(CHECK_VIOLATION);
    expect(await errorCode(as(h.seed.a, (tx) => tx.execute(sql.raw(`UPDATE signing_links SET request_digest = '${'f'.repeat(64)}' WHERE id = '${id}'`))))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await update(h.seed.a, id, "status = 'voided'")).toBeUndefined();
    const ended = await linkRow(id);
    expect(ended.status).toBe('voided');
    expect(ended.ended_at).toBeInstanceOf(Date);
    for (const change of ["status = 'pending'", "status = 'revoked'", `token_sha256 = '${hash('third')}'`, 'sign_attempts = 2']) {
      expect({ change, code: await update(h.seed.a, id, change) }).toEqual({ change, code: CHECK_VIOLATION });
    }
    // Only the read counters still move.
    expect(await update(h.seed.a, id, 'read_count = read_count + 1')).toBeUndefined();
  });

  it('agreements name their link exactly when signed through one, only a link for that estimate, and the signer’s role with it', async () => {
    const c = await seedChain(h.admin, h.seed.a, h.seed.ownerA.actor);
    const { id: linkId } = await signingLink(c);
    // Signed through a link, naming none.
    expect(await errorCode(as(c.company, (tx) => insertAgreement(tx, agreementOf(c, { signerKind: 'link' }))))).toBe(CHECK_VIOLATION);
    const withLink = (signerKind: string, link: string, role: string | null = 'homeowner') =>
      errorCode(
        as(c.company, (tx) =>
          tx.execute(sql`
            INSERT INTO agreements (id, company_id, job_id, submission_id, estimate_id, kind, signer_kind, signer_name, signer_role, signature_evidence_id, proposal_sha256, priced_result,
                                    version_id, content_hash, engine_version, documents_bytes, request_digest, created_by_actor_id, signing_link_id)
            SELECT ${randomUUID()}::uuid, company_id, job_id, submission_id, id, 'original', ${signerKind}, 'Pat Customer', ${role}, ${c.signature}::uuid, proposal_sha256, priced_result,
                   ${c.version.id}::uuid, table_hash, engine_version, '\\x7b7d'::bytea, ${digestOf(link)}, ${c.actor}::uuid, ${link}::uuid
            FROM job_estimates WHERE id = ${c.estimate.id}::uuid
          `),
        ),
      );
    expect(await withLink('device', linkId)).toBe(CHECK_VIOLATION);
    expect(await withLink('link', randomUUID())).toBe(FOREIGN_KEY_VIOLATION);
    // A link signature always says who signed, as one of the three roles.
    expect(await withLink('link', linkId, null)).toBe(CHECK_VIOLATION);
    expect(await withLink('link', linkId, 'landlord')).toBe(CHECK_VIOLATION);
    expect(await withLink('link', linkId)).toBeUndefined();
    const [row] = await h.admin<{ signer_kind: string; signer_role: string; signing_link_id: string }[]>`
      SELECT signer_kind, signer_role, signing_link_id::text FROM agreements WHERE job_id = ${c.job.id}
    `;
    expect(row).toEqual({ signer_kind: 'link', signer_role: 'homeowner', signing_link_id: linkId });
    // A device agreement keeps both columns empty.
    const other = await seedChain(h.admin, h.seed.a, h.seed.ownerA.actor);
    await as(other.company, (tx) => insertAgreement(tx, agreementOf(other)));
    expect(await h.admin`SELECT signing_link_id, signer_role FROM agreements WHERE job_id = ${other.job.id}`).toEqual([{ signing_link_id: null, signer_role: null }]);
  });
});
