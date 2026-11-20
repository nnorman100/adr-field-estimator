import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withCompany, withOperator, type CompanyTransaction } from '@/db/tenant';
import { unprotectedRelations } from './row-security-guard';
import { CHECK_VIOLATION, FOREIGN_KEY_VIOLATION, INSUFFICIENT_PRIVILEGE, UNIQUE_VIOLATION, digestOf, errorCode, newJob, seedJob } from './job-harness';
import {
  agreementOf,
  insertAgreement,
  insertSubmission,
  newSubmission,
  refusal,
  seedChain,
  seedCommitted,
  seedEstimate,
  seedPin,
  seedSignature,
  seedVersion,
  type SeededVersion,
} from './submission-harness';
import { resetTeamDatabase, startTeamServer, type Harness } from './team-harness';

// S5b-8: migration 0019, job_price_approvals and the kind `revision`, as the app's runtime role on a
// server set up like a fresh Cloud SQL instance (team-harness.ts). No route uses the table yet; these
// tests write through withCompany as the S5b-8 server slice will. The spec.md 6.1 checks the database
// holds: a proposal and its approval are bound to the job revision and the price hash; a second
// custom multiplier on one line is refused; a multiplier at or below 1 is refused; an edit leaves no
// approval behind (what a row says never changes, so an edit is a new, unapproved row); an approved
// hourly addition keeps its saved rate.
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
const asOperator = <T>(run: (tx: CompanyTransaction) => Promise<T>, readOnly = false) =>
  withOperator(h.handle.db, h.seed.operator, run, { companyId: h.seed.a, readOnly });
const rows = <T>(result: unknown) => result as unknown as T[];

// A submitted job of company A: its committed record of the current draft, priced from its first pin,
// at revision 2 (Finish raises the revision), with no estimate yet.
type Submitted = { job: string; submission: string; pin: string; version: SeededVersion; revision: number };

async function submittedJob(): Promise<Submitted> {
  const actor = h.seed.ownerA.actor;
  const job = await seedJob(h.admin, newJob(h.seed.a, actor));
  const version = await seedVersion(h.admin, h.seed.a, actor);
  const submission = await seedCommitted(h.admin, newSubmission(h.seed.a, job.id, actor, { draft: job.draft }));
  const pin = await seedPin(h.admin, { company: h.seed.a, job: job.id, version: version.id, actor });
  await h.admin`UPDATE jobs SET status = 'submitted', revision = revision + 1 WHERE id = ${job.id}`;
  return { job: job.id, submission: submission.id, pin, version, revision: 2 };
}

type Row = {
  id: string;
  kind: string;
  adjustment_id?: string | null;
  item_id?: string | null;
  room_id?: string | null;
  multiplier?: string | null;
  description?: string | null;
  quantity?: string | null;
  unit?: string | null;
  price?: string | null;
  taxable?: boolean | null;
  revision?: number;
  hash?: string;
  pin?: string;
  submission?: string;
  actor?: string;
};

const KINDS: Record<string, Omit<Row, 'id'>> = {
  named_adjustment: { kind: 'named_adjustment', adjustment_id: 'senior_discount' },
  line_multiplier: { kind: 'line_multiplier', item_id: 'flood_cut', room_id: 'room-1', multiplier: '1.25' },
  hourly: { kind: 'hourly', description: 'Move contents to the garage', quantity: '2.5', price: '85.00' },
  unit: { kind: 'unit', description: 'Haul-away bags', quantity: '12', unit: 'bag', price: '4.50', taxable: true },
  flat: { kind: 'flat', description: 'Permit filing', price: '150.00', taxable: false },
};

const proposalOf = (kind: keyof typeof KINDS, extra: Partial<Row> = {}): Row => ({ id: randomUUID(), ...KINDS[kind]!, ...extra });

const propose = (s: Submitted, r: Row, company = h.seed.a) =>
  as(company, (tx) =>
    tx.execute(sql`
      INSERT INTO job_price_approvals (id, company_id, job_id, submission_id, pin_id, table_hash, job_revision, kind, adjustment_id, item_id, room_id,
                                       multiplier, description, quantity, unit, price, taxable, request_digest, proposed_by_actor_id)
      VALUES (${r.id}::uuid, ${h.seed.a}::uuid, ${s.job}::uuid, ${r.submission ?? s.submission}::uuid, ${r.pin ?? s.pin}::uuid, ${r.hash ?? s.version.hash},
              ${r.revision ?? s.revision}, ${r.kind}, ${r.adjustment_id ?? null}, ${r.item_id ?? null}, ${r.room_id ?? null}, ${r.multiplier ?? null}::numeric,
              ${r.description ?? null}, ${r.quantity ?? null}::numeric, ${r.unit ?? null}, ${r.price ?? null}::numeric, ${r.taxable ?? null}::boolean,
              ${digestOf(r.id)}, ${r.actor ?? h.seed.estimatorA.actor}::uuid)
      RETURNING id::text
    `),
  );

const OWNER_NAME = '  Olivia  Owner ';

const approve = (id: string, tx?: CompanyTransaction) => {
  const write = (t: CompanyTransaction) =>
    t.execute(
      sql`UPDATE job_price_approvals SET approved_by_actor_id = ${h.seed.ownerA.actor}::uuid, approved_by_name = CASE WHEN kind = 'hourly' THEN ${OWNER_NAME} END WHERE id = ${id}::uuid RETURNING id::text`,
    );
  return tx ? write(tx) : as(h.seed.a, write);
};

const end = (id: string, reason: string, tx?: CompanyTransaction) => {
  const write = (t: CompanyTransaction) =>
    t.execute(sql`UPDATE job_price_approvals SET ended_by_actor_id = ${h.seed.estimatorA.actor}::uuid, ended_reason = ${reason} WHERE id = ${id}::uuid RETURNING id::text`);
  return tx ? write(tx) : as(h.seed.a, write);
};

const stateOf = async (id: string) =>
  (
    await h.admin<{ approved: boolean; ended: string | null; price: string | null }[]>`
      SELECT approved_at IS NOT NULL AS approved, ended_reason AS ended, price::text AS price FROM job_price_approvals WHERE id = ${id}
    `
  )[0];

describe('migration 0019: job_price_approvals', () => {
  it('forces row-level security with company policies, and gives the runtime no DELETE and only who approved or ended a row', async () => {
    expect(await unprotectedRelations(h.admin)).toEqual([]);
    expect(
      await h.admin`
        SELECT c.relforcerowsecurity AS forced, array(SELECT p.polname::text FROM pg_policy p WHERE p.polrelid = c.oid ORDER BY 1) AS policies
        FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname = 'job_price_approvals'
      `,
    ).toEqual([{ forced: true, policies: ['job_price_approvals_insert', 'job_price_approvals_select', 'job_price_approvals_update'] }]);
    expect(
      await h.admin`
        SELECT privilege_type AS privilege FROM information_schema.role_table_grants
        WHERE grantee = 'dryscope_runtime' AND table_name = 'job_price_approvals' ORDER BY 1
      `,
    ).toEqual([{ privilege: 'INSERT' }, { privilege: 'SELECT' }]);
    expect(
      await h.admin`
        SELECT column_name AS column FROM information_schema.column_privileges
        WHERE grantee = 'dryscope_runtime' AND table_name = 'job_price_approvals' AND privilege_type = 'UPDATE' ORDER BY 1
      `,
    ).toEqual([{ column: 'approved_by_actor_id' }, { column: 'approved_by_name' }, { column: 'ended_by_actor_id' }, { column: 'ended_reason' }]);

    const s = await submittedJob();
    const r = proposalOf('flat');
    await propose(s, r);
    expect(await errorCode(as(h.seed.a, (tx) => tx.execute(sql`DELETE FROM job_price_approvals`)))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await errorCode(as(h.seed.a, (tx) => tx.execute(sql`UPDATE job_price_approvals SET price = 1`)))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await errorCode(as(h.seed.a, (tx) => tx.execute(sql`UPDATE job_price_approvals SET approved_at = now()`)))).toBe(INSUFFICIENT_PRIVILEGE);
    // Company B sees none of A's rows and cannot write one for A.
    expect(rows(await as(h.seed.b, (tx) => tx.execute(sql`SELECT id FROM job_price_approvals`)))).toEqual([]);
    expect(await errorCode(propose(s, proposalOf('flat'), h.seed.b))).toBe(INSUFFICIENT_PRIVILEGE);
    // An operator reads them, and never writes.
    expect(rows(await asOperator((tx) => tx.execute(sql`SELECT id::text FROM job_price_approvals`), true))).toEqual([{ id: r.id }]);
    expect(rows(await asOperator((tx) => tx.execute(sql`UPDATE job_price_approvals SET ended_reason = 'edited' RETURNING id`)))).toEqual([]);
  });

  it('holds each kind of proposal with exactly its own fields', async () => {
    const s = await submittedJob();
    for (const kind of Object.keys(KINDS)) {
      expect({ kind, rows: rows(await propose(s, proposalOf(kind, { item_id: kind === 'line_multiplier' ? `item_${kind.length}` : undefined }))) }).toMatchObject({
        rows: [{ id: expect.any(String) }],
      });
    }
    // A job-wide line has no room.
    expect(rows(await propose(s, proposalOf('line_multiplier', { item_id: 'dehumidifier', room_id: null })))).toHaveLength(1);
    const wrong: Array<[string, Partial<Row> & { kind: string }]> = [
      ['a named adjustment without its id', { kind: 'named_adjustment', adjustment_id: null }],
      ['a named adjustment with a price', { kind: 'named_adjustment', adjustment_id: 'x_1', price: '1.00' }],
      ['a multiplier without its item', { kind: 'line_multiplier', item_id: null, multiplier: '1.5' }],
      ['a multiplier without a value', { kind: 'line_multiplier', item_id: 'other_item', multiplier: null }],
      ['an hourly addition with a unit', { kind: 'hourly', description: 'x', quantity: '1', price: '1.00', unit: 'h' }],
      ['an hourly addition with its own tax treatment', { kind: 'hourly', description: 'x', quantity: '1', price: '1.00', taxable: true }],
      ['an hourly addition without its hours', { kind: 'hourly', description: 'x', price: '1.00' }],
      ['an hourly addition under a quarter hour', { kind: 'hourly', description: 'x', quantity: '0.2', price: '1.00' }],
      ['a unit addition without its unit', { kind: 'unit', description: 'x', quantity: '1', price: '1.00', taxable: true }],
      ['a unit addition without its tax treatment', { kind: 'unit', description: 'x', quantity: '1', unit: 'bag', price: '1.00' }],
      ['a flat addition with a quantity', { kind: 'flat', description: 'x', quantity: '1', price: '1.00', taxable: true }],
      ['a flat addition without a price', { kind: 'flat', description: 'x', taxable: true }],
      ['another kind', { kind: 'discount' }],
    ];
    for (const [name, row] of wrong) {
      expect({ name, code: await errorCode(propose(s, { id: randomUUID(), ...row })) }).toEqual({ name, code: CHECK_VIOLATION });
    }
  });

  it('takes a custom multiplier above 1 and at most 3, with at most two decimal places, and refuses rather than rounds', async () => {
    const s = await submittedJob();
    const line = (multiplier: string, item = 'flood_cut') => propose(s, proposalOf('line_multiplier', { item_id: item, multiplier }));
    for (const multiplier of ['1', '1.00', '0.99', '0.5', '3.01', '4', '1.234', '1.250', '-1.5']) {
      expect({ multiplier, code: await errorCode(line(multiplier)) }).toEqual({ multiplier, code: CHECK_VIOLATION });
    }
    expect(rows(await line('1.01', 'item_a'))).toHaveLength(1);
    expect(rows(await line('3', 'item_b'))).toHaveLength(1);
    expect(await h.admin`SELECT multiplier::text AS m FROM job_price_approvals ORDER BY item_id`).toEqual([{ m: '1.01' }, { m: '3' }]);
    expect(rows(await line('1.25', 'item_c'))).toHaveLength(1);
    // An hourly rate is capped as the engine caps an approved rate.
    expect(rows(await propose(s, proposalOf('hourly', { price: '10000.00' })))).toHaveLength(1);
    expect(await errorCode(propose(s, proposalOf('hourly', { price: '10000.01' })))).toBe(CHECK_VIOLATION);
    // Prices and quantities are exact to the cent too, and never zero.
    for (const extra of [{ price: '1.005' }, { price: '4.500' }, { price: '0' }, { quantity: '0' }, { quantity: '2.001' }, { quantity: '2.500' }, { price: '100000.01' }]) {
      expect({ extra, code: await errorCode(propose(s, proposalOf('unit', extra))) }).toEqual({ extra, code: CHECK_VIOLATION });
    }
    for (const description of ['', '   ', 'two\nlines', 'x'.repeat(301)]) {
      expect({ description, code: await errorCode(propose(s, proposalOf('flat', { description }))) }).toEqual({ description, code: CHECK_VIOLATION });
    }
    // Text is kept exactly as entered, padding included.
    const padded = proposalOf('flat', { description: '  Permit filing ' });
    await propose(s, padded);
    expect(await h.admin`SELECT description FROM job_price_approvals WHERE id = ${padded.id}`).toEqual([{ description: '  Permit filing ' }]);
  });

  it('binds a proposal to the job’s committed record of its current draft, its revision, its current pin and that pin’s content hash', async () => {
    const s = await submittedJob();
    const refused = async (extra: Partial<Row>) => (await refusal(propose(s, proposalOf('flat', extra))))?.message;
    expect(await refused({ revision: 1 })).toContain('the job has changed since the proposal');
    expect(await refused({ revision: 3 })).toContain('the job has changed since the proposal');
    expect(await refused({ hash: digestOf('another table') })).toContain('content hash of its pinned version');
    // A committed record of another draft of the job is not the one being priced.
    const older = await seedCommitted(h.admin, newSubmission(h.seed.a, s.job, h.seed.ownerA.actor));
    expect(await refused({ submission: older.id })).toContain('committed record of the job\'s current draft');
    // Another job's pin or record is refused by the keys.
    const other = await submittedJob();
    expect(await errorCode(propose(s, proposalOf('flat', { pin: other.pin })))).toBe(FOREIGN_KEY_VIOLATION);
    expect(await errorCode(propose(s, proposalOf('flat', { submission: other.submission })))).toBe(FOREIGN_KEY_VIOLATION);
    // A pin that is no longer the job's newest.
    const v2 = await seedVersion(h.admin, h.seed.a, h.seed.ownerA.actor);
    await seedPin(h.admin, { company: h.seed.a, job: s.job, version: v2.id, actor: h.seed.ownerA.actor, sequence: 2 });
    expect(await refused({})).toContain('price pin has moved');
    expect(rows(await propose(s, proposalOf('flat', { pin: (await h.admin<{ id: string }[]>`SELECT id::text FROM job_price_pins WHERE sequence = 2`)[0]!.id, hash: v2.hash })))).toHaveLength(1);
  });

  it('is made only on a submitted job, and never once its estimate is made', async () => {
    const s = await submittedJob();
    await h.admin`UPDATE jobs SET status = 'draft', revision = revision + 1 WHERE id = ${s.job}`;
    expect((await refusal(propose(s, proposalOf('flat', { revision: 3 }))))?.message).toContain('made on a submitted job');

    const t = await submittedJob();
    const early = proposalOf('flat');
    await propose(t, early);
    await seedEstimate(h.admin, { company: h.seed.a, job: t.job, submission: t.submission, pin: t.pin, actor: h.seed.ownerA.actor, hash: t.version.hash });
    const message = 'the estimate is already made: go back to editing';
    expect((await refusal(propose(t, proposalOf('flat'))))?.message).toContain(message);
    expect((await refusal(approve(early.id)))?.message).toContain(message);
    expect((await refusal(end(early.id, 'edited')))?.message).toContain(message);
    expect(await stateOf(early.id)).toEqual({ approved: false, ended: null, price: '150.00' });

    // Repriced onto a newer pin after the estimate: the submission is still the estimated one.
    const v2 = await seedVersion(h.admin, h.seed.a, h.seed.ownerA.actor);
    const pin2 = await seedPin(h.admin, { company: h.seed.a, job: t.job, version: v2.id, actor: h.seed.ownerA.actor, sequence: 2 });
    const moved = { pin: pin2, hash: v2.hash };
    expect((await refusal(propose(t, proposalOf('flat', moved))))?.message).toContain(message);
    expect((await refusal(approve(early.id)))?.message).toContain('price pin has moved');
  });

  it('keeps the approver’s name as entered, on an approved hourly row and on no other', async () => {
    const s = await submittedJob();
    const hourly = proposalOf('hourly');
    await propose(s, hourly);
    const set = (id: string, name: string | null) =>
      as(h.seed.a, (tx) =>
        tx.execute(sql`UPDATE job_price_approvals SET approved_by_actor_id = ${h.seed.ownerA.actor}::uuid, approved_by_name = ${name} WHERE id = ${id}::uuid`),
      );
    expect(await errorCode(set(hourly.id, null))).toBe(CHECK_VIOLATION);
    for (const name of ['', '   ', 'Olivia\nOwner', 'x'.repeat(151)]) {
      expect({ name, code: await errorCode(set(hourly.id, name)) }).toEqual({ name, code: CHECK_VIOLATION });
    }
    expect(await stateOf(hourly.id)).toMatchObject({ approved: false });
    await approve(hourly.id);
    expect(await h.admin`SELECT approved_by_name AS name FROM job_price_approvals WHERE id = ${hourly.id}`).toEqual([{ name: OWNER_NAME }]);
    // Frozen after approval.
    expect(await errorCode(as(h.seed.a, (tx) => tx.execute(sql`UPDATE job_price_approvals SET approved_by_name = 'Another' WHERE id = ${hourly.id}::uuid`)))).toBe(CHECK_VIOLATION);

    const flat = proposalOf('flat');
    await propose(s, flat);
    expect(await errorCode(set(flat.id, 'Olivia Owner'))).toBe(CHECK_VIOLATION);
    expect(await errorCode(as(h.seed.a, (tx) => tx.execute(sql`UPDATE job_price_approvals SET approved_by_name = 'Olivia Owner' WHERE id = ${flat.id}::uuid`)))).toBe(CHECK_VIOLATION);
    await approve(flat.id);
    expect(await h.admin`SELECT approved_by_name AS name FROM job_price_approvals WHERE id = ${flat.id}`).toEqual([{ name: null }]);
  });

  it('is approved once, by the database’s clock, and only while the job is at the proposal’s revision', async () => {
    const s = await submittedJob();
    const r = proposalOf('hourly');
    await propose(s, r);
    expect(rows(await approve(r.id))).toEqual([{ id: r.id }]);
    const [stamped] = await h.admin<{ ok: boolean }[]>`SELECT approved_at BETWEEN proposed_at AND now() AS ok FROM job_price_approvals WHERE id = ${r.id}`;
    expect(stamped).toEqual({ ok: true });
    expect((await refusal(approve(r.id)))?.message).toContain('approved once');
    expect((await refusal(as(h.seed.a, (tx) => tx.execute(sql`UPDATE job_price_approvals SET approved_by_actor_id = NULL WHERE id = ${r.id}::uuid`))))?.message).toContain('approved once');

    // A customer save (or any change of the job) after the proposal: the approval is refused.
    const late = proposalOf('flat');
    await propose(s, late);
    await h.admin`UPDATE jobs SET revision = revision + 1 WHERE id = ${s.job}`;
    expect((await refusal(approve(late.id)))?.message).toContain('the job has changed since the proposal');
    expect(await stateOf(late.id)).toEqual({ approved: false, ended: null, price: '150.00' });
  });

  it('never changes what a row says: an edit ends it and proposes a new, unapproved one, and an approved rate stays saved', async () => {
    const s = await submittedJob();
    const r = proposalOf('hourly');
    await propose(s, r);
    await approve(r.id);
    const changes: Record<string, string> = {
      id: `'${randomUUID()}'`,
      company_id: `'${h.seed.b}'`,
      job_id: `'${randomUUID()}'`,
      submission_id: `'${randomUUID()}'`,
      pin_id: `'${randomUUID()}'`,
      table_hash: `'${'e'.repeat(64)}'`,
      job_revision: `job_revision + 1`,
      kind: `'flat'`,
      adjustment_id: `'other_one'`,
      item_id: `'other_item'`,
      room_id: `'room-9'`,
      multiplier: `1.5`,
      description: `'Something else'`,
      quantity: `9`,
      unit: `'box'`,
      price: `99`,
      taxable: `true`,
      request_digest: `'${'0'.repeat(64)}'`,
      proposed_by_actor_id: `'${h.seed.ownerA.actor}'`,
      proposed_at: `proposed_at - interval '1 hour'`,
      approved_by_actor_id: `'${h.seed.estimatorA.actor}'`,
      approved_at: `now() + interval '1 day'`,
      approved_by_name: `'Someone Else'`,
      ended_by_actor_id: `'${h.seed.estimatorA.actor}'`,
      ended_at: `now() + interval '1 day'`,
      ended_reason: `'edited'`,
    };
    const columns = (
      await h.admin<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns WHERE table_name = 'job_price_approvals' AND table_schema = 'public' ORDER BY column_name
      `
    ).map((row) => row.column_name);
    // A column added to the table later must be named here, and in the trigger, before this passes.
    expect(Object.keys(changes).sort()).toEqual(columns);
    for (const [column, value] of Object.entries(changes)) {
      if (column.startsWith('ended_')) continue;
      const found = await refusal(h.admin.unsafe(`UPDATE job_price_approvals SET ${column} = ${value} WHERE id = '${r.id}'`));
      expect({ column, code: found?.code }).toEqual({ column, code: CHECK_VIOLATION });
    }
    expect(await stateOf(r.id)).toEqual({ approved: true, ended: null, price: '85.00' });

    // The edit: the old row ends (approval and all), and the new hours are a new proposal with no approval.
    const edited = proposalOf('hourly', { quantity: '4' });
    await end(r.id, 'edited');
    await propose(s, edited);
    expect(await stateOf(r.id)).toEqual({ approved: true, ended: 'edited', price: '85.00' });
    expect(await stateOf(edited.id)).toEqual({ approved: false, ended: null, price: '85.00' });
    // An ended row changes no more, and ends by someone for a reason.
    expect((await refusal(end(r.id, 'edited')))?.message).toContain('an ended price approval cannot change');
    expect((await refusal(as(h.seed.a, (tx) => tx.execute(sql`UPDATE job_price_approvals SET ended_reason = 'edited' WHERE id = ${edited.id}::uuid`))))?.message).toContain(
      'ends by someone, for a reason',
    );
    expect(await errorCode(end(edited.id, 'withdrawn'))).toBe(CHECK_VIOLATION);
    // Approving and ending are separate changes.
    expect(
      (await refusal(
        as(h.seed.a, (tx) =>
          tx.execute(sql`UPDATE job_price_approvals SET approved_by_actor_id = ${h.seed.ownerA.actor}::uuid, ended_by_actor_id = ${h.seed.ownerA.actor}::uuid, ended_reason = 'edited' WHERE id = ${edited.id}::uuid`),
        ),
      ))?.message,
    ).toContain('separate changes');
  });

  it('refuses a second custom multiplier on the same line until the first is ended', async () => {
    const s = await submittedJob();
    const first = proposalOf('line_multiplier', { item_id: 'flood_cut', room_id: 'room-1', multiplier: '1.25' });
    await propose(s, first);
    const second = () => propose(s, proposalOf('line_multiplier', { item_id: 'flood_cut', room_id: 'room-1', multiplier: '1.5' }));
    expect((await refusal(second()))).toMatchObject({ code: UNIQUE_VIOLATION, constraint: 'job_price_approvals_one_multiplier_per_line' });
    await approve(first.id);
    expect((await refusal(second()))).toMatchObject({ code: UNIQUE_VIOLATION });
    // Another room, the job-wide line of the item, and another item are other lines.
    expect(rows(await propose(s, proposalOf('line_multiplier', { item_id: 'flood_cut', room_id: 'room-2', multiplier: '1.5' })))).toHaveLength(1);
    expect(rows(await propose(s, proposalOf('line_multiplier', { item_id: 'flood_cut', room_id: null, multiplier: '1.5' })))).toHaveLength(1);
    expect(rows(await propose(s, proposalOf('line_multiplier', { item_id: 'antimicrobial', room_id: 'room-1', multiplier: '1.5' })))).toHaveLength(1);
    await end(first.id, 'edited');
    expect(rows(await second())).toHaveLength(1);
    // A row left open at an older revision does not block the line at the job's new revision.
    await h.admin`UPDATE jobs SET revision = revision + 1 WHERE id = ${s.job}`;
    expect(rows(await propose(s, proposalOf('line_multiplier', { item_id: 'flood_cut', room_id: 'room-1', multiplier: '2', revision: 3 })))).toHaveLength(1);
  });

  it('keeps at most one approved named adjustment, which a newly approved one replaces in the same transaction', async () => {
    const s = await submittedJob();
    const first = proposalOf('named_adjustment', { adjustment_id: 'senior_discount' });
    const next = proposalOf('named_adjustment', { adjustment_id: 'rush_charge' });
    await propose(s, first);
    await propose(s, next);
    await approve(first.id);
    expect(await refusal(approve(next.id))).toMatchObject({ code: UNIQUE_VIOLATION, constraint: 'job_price_approvals_one_named_adjustment' });
    // Only an approved named adjustment is replaced.
    expect(await refusal(end(next.id, 'replaced'))).toMatchObject({ code: CHECK_VIOLATION, constraint: 'job_price_approvals_replaced_check' });
    await as(h.seed.a, async (tx) => {
      await end(first.id, 'replaced', tx);
      await approve(next.id, tx);
    });
    expect(await stateOf(first.id)).toMatchObject({ approved: true, ended: 'replaced' });
    expect(await stateOf(next.id)).toMatchObject({ approved: true, ended: null });
    const flat = proposalOf('flat');
    await propose(s, flat);
    await approve(flat.id);
    expect(await refusal(end(flat.id, 'replaced'))).toMatchObject({ code: CHECK_VIOLATION, constraint: 'job_price_approvals_replaced_check' });
  });

  it('starts as a proposal: a row cannot be written already approved or ended', async () => {
    const s = await submittedJob();
    const id = randomUUID();
    const found = await refusal(
      h.admin`
        INSERT INTO job_price_approvals (id, company_id, job_id, submission_id, pin_id, table_hash, job_revision, kind, description, price, taxable,
                                         request_digest, proposed_by_actor_id, approved_by_actor_id, approved_at)
        VALUES (${id}, ${h.seed.a}, ${s.job}, ${s.submission}, ${s.pin}, ${s.version.hash}, 2, 'flat', 'Permit', 10, false, ${digestOf(id)},
                ${h.seed.estimatorA.actor}, ${h.seed.ownerA.actor}, now())
      `,
    );
    expect(found).toMatchObject({ code: CHECK_VIOLATION, message: 'a price approval starts as a proposal' });
  });
});

describe('migration 0019: the kind `revision`', () => {
  it('names its parent agreement, on a submission and on an agreement, beside an original and a change order', async () => {
    const chain = await seedChain(h.admin, h.seed.a, h.seed.ownerA.actor);
    const [original] = rows<{ id: string }>(await as(h.seed.a, (tx) => insertAgreement(tx, agreementOf(chain))));
    const make = (extra: Parameters<typeof newSubmission>[3]) => as(h.seed.a, (tx) => insertSubmission(tx, newSubmission(h.seed.a, chain.job.id, chain.actor, extra)));
    expect(await refusal(make({ kind: 'revision', parent: null }))).toMatchObject({ code: CHECK_VIOLATION, constraint: 'job_submissions_parent_check' });
    expect(await refusal(make({ kind: 'revision', parent: randomUUID() }))).toMatchObject({ code: FOREIGN_KEY_VIOLATION, constraint: 'job_submissions_parent_fkey' });
    expect(await refusal(make({ kind: 'original', parent: original!.id }))).toMatchObject({ code: CHECK_VIOLATION, constraint: 'job_submissions_parent_check' });
    expect(await refusal(make({ kind: 'bogus' as 'original' }))).toMatchObject({ code: CHECK_VIOLATION, constraint: 'job_submissions_kind_check' });
    expect(await make({ kind: 'revision', parent: original!.id })).toHaveLength(1);
    expect(await make({ kind: 'change_order', parent: original!.id })).toHaveLength(1);

    // A signed revision: its own committed record and estimate, naming the agreement it supersedes.
    const revision = await seedCommitted(h.admin, newSubmission(h.seed.a, chain.job.id, chain.actor, { kind: 'revision', parent: original!.id }));
    const estimate = await seedEstimate(h.admin, { company: h.seed.a, job: chain.job.id, submission: revision.id, pin: chain.pin, actor: chain.actor, hash: chain.version.hash });
    const signature = await seedSignature(h.admin, h.seed.a, chain.job.id, chain.actor);
    const sign = (extra: Parameters<typeof agreementOf>[1]) =>
      as(h.seed.a, (tx) =>
        insertAgreement(tx, agreementOf(chain, { submission: revision.id, estimate: estimate.id, signature, proposalSha: estimate.proposal.sha, ...extra })),
      );
    // The agreement's own checks, behind its guard (which refuses both first, as unlike its submission).
    await h.admin`ALTER TABLE agreements DISABLE TRIGGER agreements_guard`;
    try {
      expect(await refusal(sign({ kind: 'revision', parent: null }))).toMatchObject({ code: CHECK_VIOLATION, constraint: 'agreements_parent_check' });
      expect(await refusal(sign({ kind: 'bogus' as 'original', parent: original!.id }))).toMatchObject({ code: CHECK_VIOLATION, constraint: 'agreements_kind_check' });
    } finally {
      await h.admin`ALTER TABLE agreements ENABLE TRIGGER agreements_guard`;
    }
    // The agreement has its submission's kind.
    expect(await refusal(sign({ kind: 'change_order', parent: original!.id }))).toMatchObject({ code: CHECK_VIOLATION, message: expect.stringContaining('kind and parent') });
    expect(rows(await sign({ kind: 'revision', parent: original!.id }))).toHaveLength(1);
    expect(await h.admin`SELECT kind, parent_agreement_id::text AS parent FROM agreements ORDER BY signed_at`).toEqual([
      { kind: 'original', parent: null },
      { kind: 'revision', parent: original!.id },
    ]);
  });
});
