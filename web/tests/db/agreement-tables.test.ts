import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@/db/client';
import { withCompany, type CompanyTransaction } from '@/db/tenant';
import {
  CHECK_VIOLATION,
  FOREIGN_KEY_VIOLATION,
  INSUFFICIENT_PRIVILEGE,
  UNIQUE_VIOLATION,
  errorCode,
  digestOf,
  newJob,
  seedJob,
} from './job-harness';
import {
  agreementOf,
  bytesOf,
  insertAgreement,
  insertEstimate,
  insertPin,
  newSubmission,
  pricedResult,
  refusal,
  seedChain,
  seedCommitted,
  seedEstimate,
  seedPin,
  seedSignature,
  seedSubmission,
  seedVersion,
  type Chain,
} from './submission-harness';
import { everything, resetTeamDatabase, startTeamServer, type Harness } from './team-harness';

// S5a-7: the price pin, estimate and agreement tables (migration 0011), as the app's runtime role on a
// server set up like a fresh Cloud SQL instance (see team-harness.ts). No route uses them yet, so
// these tests write through withCompany exactly as S5a-9 and S5a-11 will. The submission table is in
// submission-tables.test.ts.
let base: Awaited<ReturnType<typeof startTeamServer>>;
let h: Harness;
// The runtime with several connections, so two transactions can overlap.
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
const sqlOf = (text: string) => sql.raw(text);
const rows = <T>(result: unknown) => result as unknown as T[];
const actorA = () => h.seed.ownerA.actor;
const chainA = () => seedChain(h.admin, h.seed.a, actorA());
const jobA = () => seedJob(h.admin, newJob(h.seed.a, actorA()));

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// A company A transaction that writes, then stays open for a while before it commits. `written`
// settles once the write is done (or the transaction failed), `done` once it has committed.
function heldOpen(write: (tx: CompanyTransaction) => Promise<unknown>, ms = 400) {
  let wrote!: () => void;
  const ready = new Promise<void>((resolve) => (wrote = resolve));
  const done = as(h.seed.a, async (tx) => {
    await write(tx);
    wrote();
    await pause(ms);
  });
  return { written: Promise.race([ready, done]), done };
}

async function timed<T>(run: () => Promise<T>): Promise<{ value: T; waited: number }> {
  const started = Date.now();
  const value = await run();
  return { value, waited: Date.now() - started };
}

// The job's second pin as the runtime writes it: `repriceNow` makes it when called, `heldReprice`
// writes it and holds the transaction open before it commits.
async function repriceNow(c: Chain) {
  const v2 = await seedVersion(h.admin, c.company, c.actor, { sequence: 2 });
  return () => as(h.seed.a, (tx) => insertPin(tx, { company: c.company, job: c.job.id, version: v2.id, actor: c.actor, sequence: 2 }));
}

async function heldReprice(c: Chain) {
  const v2 = await seedVersion(h.admin, c.company, c.actor, { sequence: 2 });
  return heldOpen((tx) => insertPin(tx, { company: c.company, job: c.job.id, version: v2.id, actor: c.actor, sequence: 2 }));
}

// A second committed submission on the chain's job, with its own estimate priced from the same pin.
async function secondEstimate(c: Chain, extra: Parameters<typeof newSubmission>[3] = {}) {
  const submission = await seedCommitted(h.admin, newSubmission(c.company, c.job.id, c.actor, extra));
  const estimate = await seedEstimate(h.admin, { company: c.company, job: c.job.id, submission: submission.id, pin: c.pin, actor: c.actor, hash: c.version.hash });
  const signature = await seedSignature(h.admin, c.company, c.job.id, c.actor);
  return { submission, estimate, signature };
}

describe('job price pins', () => {
  it('takes the job’s next number: 1, then 2, and refuses a gap, a repeat or a rewind', async () => {
    const job = await jobA();
    const v1 = await seedVersion(h.admin, h.seed.a, actorA(), { sequence: 1 });
    const v2 = await seedVersion(h.admin, h.seed.a, actorA(), { sequence: 2 });
    const pin = (sequence: number, version = v1.id) => as(h.seed.a, (tx) => insertPin(tx, { company: h.seed.a, job: job.id, version, actor: actorA(), sequence }));
    expect(await refusal(pin(2))).toMatchObject({ code: CHECK_VIOLATION, message: expect.stringContaining('next sequence number') });
    expect(await refusal(pin(0))).toMatchObject({ code: CHECK_VIOLATION });
    expect(await pin(1)).toEqual([{ id: expect.any(String), sequence: 1 }]);
    for (const sequence of [1, 3, 0]) {
      expect({ sequence, found: await refusal(pin(sequence, v2.id)) }).toMatchObject({ found: { code: CHECK_VIOLATION, message: expect.stringContaining('next sequence number') } });
    }
    expect(await pin(2, v2.id)).toHaveLength(1);
    expect(await h.admin`SELECT sequence, reason FROM job_price_pins WHERE job_id = ${job.id} ORDER BY sequence`).toEqual([
      { sequence: 1, reason: 'first_price' },
      { sequence: 2, reason: 'owner_reprice' },
    ]);
    // Another job of the same company starts at 1 again.
    const other = await jobA();
    expect(await as(h.seed.a, (tx) => insertPin(tx, { company: h.seed.a, job: other.id, version: v2.id, actor: actorA() }))).toHaveLength(1);
  });

  it('makes the first pin the first price and every later one the owner’s reprice, and nothing else', async () => {
    const job = await jobA();
    const v = await seedVersion(h.admin, h.seed.a, actorA());
    const pin = (sequence: number, reason: string) => as(h.seed.a, (tx) => insertPin(tx, { company: h.seed.a, job: job.id, version: v.id, actor: actorA(), sequence, reason }));
    expect(await refusal(pin(1, 'owner_reprice'))).toMatchObject({ code: CHECK_VIOLATION, constraint: 'job_price_pins_first_pin_check' });
    expect(await refusal(pin(1, 'whenever'))).toMatchObject({ code: CHECK_VIOLATION });
    expect(await pin(1, 'first_price')).toHaveLength(1);
    expect(await refusal(pin(2, 'first_price'))).toMatchObject({ code: CHECK_VIOLATION, constraint: 'job_price_pins_first_pin_check' });
    expect(await pin(2, 'owner_reprice')).toHaveLength(1);
  });

  it('gives two first pins at once for one job one success, never two with the same number', async () => {
    const job = await jobA();
    const v = await seedVersion(h.admin, h.seed.a, actorA());
    // The first pin is written and held uncommitted, so the second starts while it is open (it sees no
    // pin yet, waits on the job, and is refused on the number once the first commits). Started
    // together, the second could begin after the first committed and be refused by the sequence check.
    const first = heldOpen((tx) => insertPin(tx, { company: h.seed.a, job: job.id, version: v.id, actor: actorA() }));
    await first.written;
    const results = await Promise.all([errorCode(first.done), errorCode(as(h.seed.a, (tx) => insertPin(tx, { company: h.seed.a, job: job.id, version: v.id, actor: actorA() })))]);
    expect(results.filter((code) => code === undefined)).toHaveLength(1);
    expect(results.filter((code) => code === UNIQUE_VIOLATION)).toHaveLength(1);
    expect(await h.admin`SELECT count(*)::int AS n FROM job_price_pins`).toEqual([{ n: 1 }]);
  });

  it('cannot name another company’s version, job or person, and a company writes only its own pins', async () => {
    const versionA = await seedVersion(h.admin, h.seed.a, actorA());
    const versionB = await seedVersion(h.admin, h.seed.b, h.seed.ownerB.actor);
    const jobB = await seedJob(h.admin, newJob(h.seed.b, h.seed.ownerB.actor));
    const pinB = (extra: Partial<Parameters<typeof insertPin>[1]>) =>
      as(h.seed.b, (tx) => insertPin(tx, { company: h.seed.b, job: jobB.id, version: versionB.id, actor: h.seed.ownerB.actor, ...extra }));
    // Company B naming company A's version passes the policy, and the composite key refuses it.
    expect(await refusal(pinB({ version: versionA.id }))).toMatchObject({ code: FOREIGN_KEY_VIOLATION, constraint: 'job_price_pins_version_fkey' });
    expect(await refusal(pinB({ version: randomUUID() }))).toMatchObject({ code: FOREIGN_KEY_VIOLATION, constraint: 'job_price_pins_version_fkey' });
    expect(await refusal(pinB({ job: (await jobA()).id }))).toMatchObject({ code: FOREIGN_KEY_VIOLATION, constraint: 'job_price_pins_job_fkey' });
    expect(await refusal(pinB({ actor: actorA() }))).toMatchObject({ code: FOREIGN_KEY_VIOLATION, constraint: 'job_price_pins_pinned_by_fkey' });
    // Even the table owner's superuser cannot write a pin that names another company's version.
    const jobA2 = await jobA();
    expect(await refusal(seedPin(h.admin, { company: h.seed.a, job: jobA2.id, version: versionB.id, actor: actorA() }))).toMatchObject({ code: FOREIGN_KEY_VIOLATION, constraint: 'job_price_pins_version_fkey' });
    // A row for another company is refused by the policy.
    expect(await errorCode(as(h.seed.b, (tx) => insertPin(tx, { company: h.seed.a, job: jobA2.id, version: versionA.id, actor: actorA() })))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await pinB({})).toHaveLength(1);
    expect(await as(h.seed.a, async (tx) => rows(await tx.execute(sql`SELECT 1 FROM job_price_pins`)))).toEqual([]);
  });

  it('is never changed or removed by the runtime, whatever the column', async () => {
    await chainA();
    const before = await everything(h.admin);
    for (const column of ['company_id', 'id', 'job_id', 'sequence', 'version_id', 'reason', 'pinned_by_actor_id', 'pinned_at']) {
      const statement = `UPDATE job_price_pins SET ${column} = ${column}`;
      expect({ statement, code: await errorCode(as(h.seed.a, (tx) => tx.execute(sqlOf(statement)))) }).toEqual({ statement, code: INSUFFICIENT_PRIVILEGE });
    }
    for (const statement of ['DELETE FROM job_price_pins', 'TRUNCATE job_price_pins']) {
      expect({ statement, code: await errorCode(as(h.seed.a, (tx) => tx.execute(sqlOf(statement)))) }).toEqual({ statement, code: INSUFFICIENT_PRIVILEGE });
    }
    expect(await everything(h.admin)).toBe(before);
  });
});

describe('job estimates', () => {
  let c: Chain;

  beforeEach(async () => {
    c = await chainA();
  });

  const estimate = (extra: Partial<Parameters<typeof insertEstimate>[1]> = {}) =>
    as(h.seed.a, (tx) => insertEstimate(tx, { company: c.company, job: c.job.id, submission: c.submission.id, pin: c.pin, actor: c.actor, hash: c.version.hash, ...extra }));

  it('is made once for a committed submission and a pin, and a retried insert finds the same row', async () => {
    const second = await seedCommitted(h.admin, newSubmission(c.company, c.job.id, c.actor));
    const made = await as(h.seed.a, (tx) => insertEstimate(tx, { company: c.company, job: c.job.id, submission: second.id, pin: c.pin, actor: c.actor, hash: c.version.hash }));
    expect(made).toHaveLength(1);
    expect(await refusal(as(h.seed.a, (tx) => insertEstimate(tx, { company: c.company, job: c.job.id, submission: second.id, pin: c.pin, actor: c.actor, hash: c.version.hash })))).toMatchObject({
      code: UNIQUE_VIOLATION,
      constraint: 'job_estimates_company_submission_pin_key',
    });
    // The chain's own estimate for the first submission and pin is the same pair.
    expect(await refusal(estimate())).toMatchObject({ code: UNIQUE_VIOLATION, constraint: 'job_estimates_company_submission_pin_key' });
    expect(await h.admin`SELECT count(*)::int AS n FROM job_estimates`).toEqual([{ n: 2 }]);
  });

  it('needs a committed submission: a pending or aborted one is refused', async () => {
    const pending = await seedSubmission(h.admin, newSubmission(c.company, c.job.id, c.actor));
    const aborted = await seedSubmission(h.admin, newSubmission(c.company, c.job.id, c.actor));
    await h.admin`UPDATE job_submissions SET status = 'aborted' WHERE id = ${aborted.id}`;
    for (const submission of [pending.id, aborted.id]) {
      expect(await refusal(estimate({ submission }))).toMatchObject({ code: CHECK_VIOLATION, message: 'an estimate is made from a committed submission' });
    }
    expect(await h.admin`SELECT count(*)::int AS n FROM job_estimates`).toEqual([{ n: 1 }]);
  });

  it('states the hash and engine version of its pinned version', async () => {
    const second = await seedCommitted(h.admin, newSubmission(c.company, c.job.id, c.actor));
    for (const extra of [{ hash: digestOfOther() }, { engine: 'dryscope-v4' }, { hash: digestOfOther(), engine: 'dryscope-v4' }]) {
      expect({ extra, found: await refusal(estimate({ submission: second.id, ...extra })) }).toMatchObject({
        found: { code: CHECK_VIOLATION, message: 'an estimate states the hash and engine version of its pinned version' },
      });
    }
    expect(await estimate({ submission: second.id })).toHaveLength(1);
  });

  it('is priced from the job’s current pin: after a reprice an estimate on the old pin is refused', async () => {
    const second = await seedCommitted(h.admin, newSubmission(c.company, c.job.id, c.actor));
    const v2 = await seedVersion(h.admin, c.company, c.actor, { sequence: 2 });
    const pin2 = await seedPin(h.admin, { company: c.company, job: c.job.id, version: v2.id, actor: c.actor, sequence: 2 });
    expect(await refusal(estimate({ submission: second.id }))).toMatchObject({ code: CHECK_VIOLATION, message: 'an estimate uses the job\'s current pin' });
    // The new pin gives a new estimate for the same submission; the old estimate stays as history.
    expect(await estimate({ submission: c.submission.id, pin: pin2, hash: v2.hash })).toHaveLength(1);
    expect(await h.admin`SELECT count(*)::int AS n FROM job_estimates WHERE submission_id = ${c.submission.id}`).toEqual([{ n: 2 }]);
  });

  it('waits for a reprice in progress, then is refused on the old pin', async () => {
    const second = await seedCommitted(h.admin, newSubmission(c.company, c.job.id, c.actor));
    const reprice = await heldReprice(c);
    await reprice.written;
    const found = await refusal(estimate({ submission: second.id }));
    await reprice.done;
    expect(found).toMatchObject({ code: CHECK_VIOLATION, message: 'an estimate uses the job\'s current pin' });
    expect(await h.admin`SELECT count(*)::int AS n FROM job_estimates WHERE submission_id = ${second.id}`).toEqual([{ n: 0 }]);
  });

  it('holds a reprice until an estimate in progress on the current pin has committed', async () => {
    const second = await seedCommitted(h.admin, newSubmission(c.company, c.job.id, c.actor));
    const reprice = await repriceNow(c);
    const pricing = heldOpen((tx) => insertEstimate(tx, { company: c.company, job: c.job.id, submission: second.id, pin: c.pin, actor: c.actor, hash: c.version.hash }));
    await pricing.written;
    const pinned = await timed(reprice);
    await pricing.done;
    expect(pinned.value).toEqual([{ id: expect.any(String), sequence: 2 }]);
    expect(pinned.waited).toBeGreaterThanOrEqual(250);
  });

  it('holds the proposal’s hash to the proposal’s bytes, and the result to an object', async () => {
    const second = await seedCommitted(h.admin, newSubmission(c.company, c.job.id, c.actor));
    const checked = async (extra: Partial<Parameters<typeof insertEstimate>[1]>, constraint: string) =>
      expect({ extra: Object.keys(extra), found: await refusal(estimate({ submission: second.id, ...extra })) }).toMatchObject({ found: { code: CHECK_VIOLATION, constraint } });
    await checked({ proposalSha: digestOfOther() }, 'job_estimates_proposal_check');
    await checked({ proposal: bytesOf('') }, 'job_estimates_proposal_bytes_check');
    await checked({ proposal: bytesOf('a'.repeat(8388609)) }, 'job_estimates_proposal_bytes_check');
    await checked({ result: [] as unknown as Record<string, unknown> }, 'job_estimates_priced_result_check');
    expect(await estimate({ submission: second.id, proposal: bytesOf('a'.repeat(8388608)) })).toHaveLength(1);
  });

  it('names a submission and a pin of its own job, and of its own company', async () => {
    const other = await chainA();
    const second = await seedCommitted(h.admin, newSubmission(c.company, c.job.id, c.actor));
    // Another job's committed submission, or another job's pin, with this job named.
    expect(await refusal(estimate({ submission: other.submission.id }))).toMatchObject({ code: FOREIGN_KEY_VIOLATION, constraint: 'job_estimates_submission_fkey' });
    expect(await refusal(estimate({ submission: second.id, pin: other.pin, hash: other.version.hash }))).toMatchObject({ code: FOREIGN_KEY_VIOLATION, constraint: 'job_estimates_pin_fkey' });
    // Company B naming company A's submission and pin.
    const jobB = await seedJob(h.admin, newJob(h.seed.b, h.seed.ownerB.actor));
    const found = await refusal(
      as(h.seed.b, (tx) => insertEstimate(tx, { company: h.seed.b, job: jobB.id, submission: c.submission.id, pin: c.pin, actor: h.seed.ownerB.actor, hash: c.version.hash })),
    );
    expect(found).toMatchObject({ code: FOREIGN_KEY_VIOLATION });
    expect(await errorCode(as(h.seed.b, (tx) => insertEstimate(tx, { company: c.company, job: c.job.id, submission: second.id, pin: c.pin, actor: c.actor, hash: c.version.hash })))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it('is never changed or removed by the runtime, whatever the column, and company B reads none of it', async () => {
    const before = await everything(h.admin);
    for (const column of ['company_id', 'id', 'job_id', 'submission_id', 'pin_id', 'table_hash', 'engine_version', 'priced_result', 'proposal_bytes', 'proposal_sha256', 'created_by_actor_id', 'created_at']) {
      const statement = `UPDATE job_estimates SET ${column} = ${column}`;
      expect({ statement, code: await errorCode(as(h.seed.a, (tx) => tx.execute(sqlOf(statement)))) }).toEqual({ statement, code: INSUFFICIENT_PRIVILEGE });
    }
    for (const statement of ['DELETE FROM job_estimates', 'TRUNCATE job_estimates']) {
      expect({ statement, code: await errorCode(as(h.seed.a, (tx) => tx.execute(sqlOf(statement)))) }).toEqual({ statement, code: INSUFFICIENT_PRIVILEGE });
    }
    expect(await everything(h.admin)).toBe(before);
    expect(await as(h.seed.b, async (tx) => rows(await tx.execute(sql`SELECT 1 FROM job_estimates`)))).toEqual([]);
    expect(await as(h.seed.a, async (tx) => rows(await tx.execute(sql`SELECT proposal_sha256 FROM job_estimates`)))).toEqual([{ proposal_sha256: c.estimate.proposal.sha }]);
  });
});

function digestOfOther(): string {
  return bytesOf(`other ${randomUUID()}`).sha;
}

describe('agreements', () => {
  let c: Chain;

  beforeEach(async () => {
    c = await chainA();
  });

  const sign = (extra: Partial<Parameters<typeof agreementOf>[1]> = {}, chain = c) => as(h.seed.a, (tx) => insertAgreement(tx, agreementOf(chain, extra)));

  it('is signed once for a committed submission and its estimate, and stores what the documents print', async () => {
    const documents = Buffer.from('{"proposal":"signed"}');
    const id = randomUUID();
    // Signed through a link, which the agreement names (0014, S5a-11b: set exactly for a link).
    const link = randomUUID();
    await h.admin`
      INSERT INTO signing_links (id, company_id, job_id, estimate_id, token_sha256, request_digest, created_by_actor_id, expires_at)
      VALUES (${link}, ${c.company}, ${c.job.id}, ${c.estimate.id}, ${digestOf(`token ${link}`)}, ${digestOf(link)}, ${c.actor}, now() + interval '7 days')
    `;
    const [made] = await sign({ id, documents, signerKind: 'link', signerName: 'Pat Customer', signingLink: link });
    expect(made).toMatchObject({ id, signed_at: expect.anything() });
    const [row] = await h.admin`
      SELECT kind, parent_agreement_id, signer_kind, signer_name, signature_evidence_id::text AS signature, proposal_sha256, priced_result, version_id::text AS version,
             content_hash, engine_version, documents_bytes, created_by_actor_id::text AS actor, signing_link_id::text AS link
      FROM agreements WHERE id = ${id}
    `;
    expect(row).toEqual({
      kind: 'original',
      parent_agreement_id: null,
      signer_kind: 'link',
      signer_name: 'Pat Customer',
      signature: c.signature,
      proposal_sha256: c.estimate.proposal.sha,
      priced_result: pricedResult,
      version: c.version.id,
      content_hash: c.version.hash,
      engine_version: 'dryscope-v3',
      documents_bytes: documents,
      actor: c.actor,
      link,
    });
  });

  it('holds one original agreement per job, counts no change order, and lets another job sign its own', async () => {
    await sign();
    const second = await secondEstimate(c);
    // A second original on the same job is refused, even with its own submission, estimate and signature.
    expect(await refusal(sign({ submission: second.submission.id, estimate: second.estimate.id, signature: second.signature, proposalSha: second.estimate.proposal.sha }))).toMatchObject({
      code: UNIQUE_VIOLATION,
      constraint: 'agreements_one_original_per_job',
    });
    const other = await chainA();
    expect(await sign({}, other)).toHaveLength(1);
    // A change order is not an original: it builds on the original agreement and is allowed.
    const [original] = await h.admin<{ id: string }[]>`SELECT id::text FROM agreements WHERE job_id = ${c.job.id}`;
    const change = await secondEstimate(c, { kind: 'change_order', parent: original!.id });
    expect(
      await sign({ kind: 'change_order', parent: original!.id, submission: change.submission.id, estimate: change.estimate.id, signature: change.signature, proposalSha: change.estimate.proposal.sha }),
    ).toHaveLength(1);
    expect(await h.admin`SELECT kind, count(*)::int AS n FROM agreements WHERE job_id = ${c.job.id} GROUP BY kind ORDER BY kind`).toEqual([
      { kind: 'change_order', n: 1 },
      { kind: 'original', n: 1 },
    ]);
  });

  it('signs a submission, an estimate and a signature object at most once', async () => {
    await sign();
    const [original] = await h.admin<{ id: string }[]>`SELECT id::text FROM agreements WHERE job_id = ${c.job.id}`;
    // A change order reusing the original's signature object is refused by the signature key alone.
    const change = await secondEstimate(c, { kind: 'change_order', parent: original!.id });
    expect(
      await refusal(sign({ kind: 'change_order', parent: original!.id, submission: change.submission.id, estimate: change.estimate.id, signature: c.signature, proposalSha: change.estimate.proposal.sha })),
    ).toMatchObject({ code: UNIQUE_VIOLATION, constraint: 'agreements_company_signature_key' });
    // The same submission or estimate again is refused too (with the original-per-job key, or its own).
    for (const extra of [{ signature: change.signature }, {}]) {
      const found = await refusal(sign(extra));
      expect(found).toMatchObject({ code: UNIQUE_VIOLATION });
      expect(['agreements_one_original_per_job', 'agreements_company_submission_key', 'agreements_company_estimate_key', 'agreements_company_signature_key']).toContain(found?.constraint);
    }
    const unique = await h.admin<{ name: string; columns: string[] }[]>`
      SELECT c.conname AS name, array_agg(a.attname ORDER BY a.attname) AS columns
      FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
      WHERE c.conrelid = 'agreements'::regclass AND c.contype = 'u' GROUP BY c.conname ORDER BY c.conname
    `;
    expect(unique).toEqual([
      { name: 'agreements_company_estimate_key', columns: ['company_id', 'estimate_id'] },
      { name: 'agreements_company_job_id_key', columns: ['company_id', 'id', 'job_id'] },
      { name: 'agreements_company_signature_key', columns: ['company_id', 'signature_evidence_id'] },
      // 0014 (S5a-11b): a signing link signs at most one agreement.
      { name: 'agreements_company_signing_link_key', columns: ['company_id', 'signing_link_id'] },
      { name: 'agreements_company_submission_key', columns: ['company_id', 'submission_id'] },
    ]);
  });

  it('restates its estimate exactly: proposal hash, priced result, content hash, engine and price version', async () => {
    const v2 = await seedVersion(h.admin, c.company, c.actor, { sequence: 2 });
    const cases: [string, Partial<Parameters<typeof agreementOf>[1]>, string][] = [
      ['another proposal hash', { proposalSha: digestOfOther() }, 'an agreement restates its estimate'],
      ['another priced result', { result: { ...pricedResult, total: '1.00' } }, 'an agreement restates its estimate'],
      ['another content hash', { hash: digestOfOther() }, 'an agreement restates its estimate'],
      ['another engine version', { engine: 'dryscope-v4' }, 'an agreement restates its estimate'],
      ['another price version', { version: v2.id }, 'an agreement names its estimate'],
    ];
    for (const [name, extra, message] of cases) {
      expect({ name, found: await refusal(sign(extra)) }).toMatchObject({ found: { code: CHECK_VIOLATION, message: expect.stringContaining(message) } });
    }
    expect(await h.admin`SELECT count(*)::int AS n FROM agreements`).toEqual([{ n: 0 }]);
  });

  it('is signed for its estimate’s submission, which is committed, with that submission’s kind and parent', async () => {
    const other = await seedCommitted(h.admin, newSubmission(c.company, c.job.id, c.actor));
    expect(await refusal(sign({ submission: other.id }))).toMatchObject({ code: CHECK_VIOLATION, message: expect.stringContaining('its estimate\'s submission') });
    expect(await refusal(sign({ kind: 'change_order', parent: randomUUID() }))).toMatchObject({ code: CHECK_VIOLATION });
    expect(await refusal(sign({ kind: 'change_order' }))).toMatchObject({ code: CHECK_VIOLATION });
    // A submission that is no longer committed cannot be signed (it cannot become uncommitted, so write one that never was).
    const pending = await seedSubmission(h.admin, newSubmission(c.company, c.job.id, c.actor));
    await h.admin`ALTER TABLE job_estimates DISABLE TRIGGER job_estimates_guard`;
    const rogue = await seedEstimate(h.admin, { company: c.company, job: c.job.id, submission: pending.id, pin: c.pin, actor: c.actor, hash: c.version.hash });
    await h.admin`ALTER TABLE job_estimates ENABLE TRIGGER job_estimates_guard`;
    expect(await refusal(sign({ submission: pending.id, estimate: rogue.id, proposalSha: rogue.proposal.sha }))).toMatchObject({
      code: CHECK_VIOLATION,
      message: 'an agreement is signed for a committed submission',
    });
    // Another job's submission or estimate, with this job named, is refused by the composite keys.
    const elsewhere = await chainA();
    const found = await refusal(
      sign({
        submission: elsewhere.submission.id,
        estimate: elsewhere.estimate.id,
        proposalSha: elsewhere.estimate.proposal.sha,
        hash: elsewhere.version.hash,
        version: elsewhere.version.id,
        signature: await seedSignature(h.admin, c.company, c.job.id, c.actor),
      }),
    );
    expect(found).toMatchObject({ code: FOREIGN_KEY_VIOLATION });
    expect(['agreements_submission_fkey', 'agreements_estimate_fkey', 'agreements_signature_fkey']).toContain(found?.constraint);
    // Naming only one of them is a mismatch with its estimate's submission.
    expect(await refusal(sign({ submission: elsewhere.submission.id }))).toMatchObject({ code: CHECK_VIOLATION });
    expect(await sign()).toHaveLength(1);
  });

  it('is refused if the job’s price pin moved after the estimate', async () => {
    const v2 = await seedVersion(h.admin, c.company, c.actor, { sequence: 2 });
    await seedPin(h.admin, { company: c.company, job: c.job.id, version: v2.id, actor: c.actor, sequence: 2 });
    expect(await refusal(sign())).toMatchObject({ code: CHECK_VIOLATION, message: 'the job\'s price pin has moved since the estimate' });
    expect(await h.admin`SELECT count(*)::int AS n FROM agreements`).toEqual([{ n: 0 }]);
  });

  it('waits for a reprice in progress, then is refused because the pin moved', async () => {
    const reprice = await heldReprice(c);
    await reprice.written;
    const found = await refusal(sign());
    await reprice.done;
    expect(found).toMatchObject({ code: CHECK_VIOLATION, message: 'the job\'s price pin has moved since the estimate' });
    expect(await h.admin`SELECT count(*)::int AS n FROM agreements`).toEqual([{ n: 0 }]);
  });

  it('holds a reprice until a signing in progress has committed', async () => {
    const reprice = await repriceNow(c);
    const signing = heldOpen((tx) => insertAgreement(tx, agreementOf(c)));
    await signing.written;
    const pinned = await timed(reprice);
    await signing.done;
    expect(pinned.value).toEqual([{ id: expect.any(String), sequence: 2 }]);
    expect(pinned.waited).toBeGreaterThanOrEqual(250);
    expect(await h.admin`SELECT count(*)::int AS n FROM agreements`).toEqual([{ n: 1 }]);
  });

  it('names a signature object of its own job and company, and one of kind signature', async () => {
    const photo = await seedSignature(h.admin, c.company, c.job.id, c.actor, 'photo');
    const elsewhere = await jobA();
    const otherJobSignature = await seedSignature(h.admin, c.company, elsewhere.id, c.actor);
    const jobB = await seedJob(h.admin, newJob(h.seed.b, h.seed.ownerB.actor));
    const signatureB = await seedSignature(h.admin, h.seed.b, jobB.id, h.seed.ownerB.actor);
    for (const signature of [photo, otherJobSignature]) {
      expect({ signature, found: await refusal(sign({ signature })) }).toMatchObject({
        found: { code: CHECK_VIOLATION, message: 'an agreement\'s signature is a signature object of its own job' },
      });
    }
    expect(await refusal(sign({ signature: signatureB }))).toMatchObject({ code: FOREIGN_KEY_VIOLATION, constraint: 'agreements_signature_fkey' });
    expect(await refusal(sign({ signature: randomUUID() }))).toMatchObject({ code: FOREIGN_KEY_VIOLATION, constraint: 'agreements_signature_fkey' });
    expect(await sign()).toHaveLength(1);
  });

  it('holds the signer to a kind and a one-line name of 1 to 150 characters', async () => {
    for (const signerKind of ['email', '', 'DEVICE']) {
      expect({ signerKind, found: await refusal(sign({ signerKind })) }).toMatchObject({ found: { code: CHECK_VIOLATION, constraint: 'agreements_signer_kind_check' } });
    }
    for (const signerName of ['', ' Pat', 'Pat ', 'Pa\nt', 'Pa\tt', 'x'.repeat(151)]) {
      expect({ signerName, found: await refusal(sign({ signerName })) }).toMatchObject({ found: { code: CHECK_VIOLATION, constraint: 'agreements_signer_name_check' } });
    }
    expect(await sign({ signerName: 'x'.repeat(150) })).toHaveLength(1);
  });

  it('holds the documents to 2 bytes up to 16 MiB, and the sign request’s digest to 64 lowercase hex characters', async () => {
    for (const documents of [Buffer.from('x'), Buffer.alloc(16777217, 1)]) {
      expect({ size: documents.length, found: await refusal(sign({ documents })) }).toMatchObject({ found: { code: CHECK_VIOLATION, constraint: 'agreements_documents_bytes_check' } });
    }
    for (const digest of ['', 'a'.repeat(63), 'A'.repeat(64)]) {
      expect({ digest, found: await refusal(sign({ digest })) }).toMatchObject({ found: { code: CHECK_VIOLATION, constraint: 'agreements_request_digest_check' } });
    }
    expect(await sign({ documents: Buffer.alloc(16777216, 1), digest: 'f'.repeat(64) })).toHaveLength(1);
  });

  it('gives two signatures with the same id at once one agreement, and the same id twice one row', async () => {
    const id = randomUUID();
    const results = await Promise.all([1, 2].map(() => errorCode(sign({ id }))));
    expect(results.filter((code) => code === undefined)).toHaveLength(1);
    expect(results.filter((code) => code === UNIQUE_VIOLATION)).toHaveLength(1);
    expect(await h.admin`SELECT count(*)::int AS n FROM agreements`).toEqual([{ n: 1 }]);
  });

  it('is never changed or removed by the runtime, whatever the column, and the owner’s migrator is bound too', async () => {
    await sign();
    const before = await everything(h.admin);
    const columns = [
      'company_id', 'id', 'job_id', 'submission_id', 'estimate_id', 'kind', 'parent_agreement_id', 'signer_kind', 'signer_name', 'signature_evidence_id', 'proposal_sha256',
      'priced_result', 'version_id', 'content_hash', 'engine_version', 'documents_bytes', 'request_digest', 'created_by_actor_id', 'signed_at',
    ];
    for (const column of columns) {
      const statement = `UPDATE agreements SET ${column} = ${column}`;
      expect({ statement, code: await errorCode(as(h.seed.a, (tx) => tx.execute(sqlOf(statement)))) }).toEqual({ statement, code: INSUFFICIENT_PRIVILEGE });
    }
    for (const statement of ['DELETE FROM agreements', 'TRUNCATE agreements']) {
      expect({ statement, code: await errorCode(as(h.seed.a, (tx) => tx.execute(sqlOf(statement)))) }).toEqual({ statement, code: INSUFFICIENT_PRIVILEGE });
    }
    const owner = postgres(h.migratorUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
    try {
      for (const table of ['agreements', 'job_estimates', 'job_price_pins']) {
        expect(await owner.unsafe(`SELECT count(*)::int AS n FROM ${table}`)).toEqual([{ n: 0 }]);
        expect((await owner.unsafe(`DELETE FROM ${table}`)).count).toBe(0);
      }
      expect((await owner`UPDATE agreements SET signer_name = 'Someone Else'`).count).toBe(0);
    } finally {
      await owner.end({ timeout: 5 });
    }
    expect(await everything(h.admin)).toBe(before);
  });

  it('shows company B none of company A’s agreements, and refuses B’s agreement naming A’s records', async () => {
    await sign();
    expect(await as(h.seed.b, async (tx) => rows(await tx.execute(sql`SELECT 1 FROM agreements`)))).toEqual([]);
    const jobB = await seedJob(h.admin, newJob(h.seed.b, h.seed.ownerB.actor));
    const asB = (extra: Partial<Parameters<typeof agreementOf>[1]>) =>
      as(h.seed.b, (tx) => insertAgreement(tx, { ...agreementOf(c, { company: h.seed.b, job: jobB.id, actor: h.seed.ownerB.actor }), ...extra }));
    // Everything it names belongs to company A: the keys refuse each piece, so nothing is written.
    expect(await refusal(asB({}))).toMatchObject({ code: FOREIGN_KEY_VIOLATION });
    expect(await refusal(asB({ job: c.job.id }))).toMatchObject({ code: FOREIGN_KEY_VIOLATION });
    // A row written for company A is refused by the policy when signed in as company B.
    expect(await errorCode(as(h.seed.b, (tx) => insertAgreement(tx, agreementOf(c))))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await h.admin`SELECT count(*)::int AS n FROM agreements`).toEqual([{ n: 1 }]);
  });
});
