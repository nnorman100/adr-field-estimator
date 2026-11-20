import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { estimateHistory } from '@/db/drying-schema';
import { withCompany, withOperator, type CompanyTransaction } from '@/db/tenant';
import { capabilitiesFor } from '@/lib/access/can';
import { readStoredEstimate } from '@/lib/estimates/result';
import { unprotectedRelations } from './row-security-guard';
import { CHECK_VIOLATION, FOREIGN_KEY_VIOLATION, INSUFFICIENT_PRIVILEGE, UNIQUE_VIOLATION, digestOf, errorCode, newJob, ownerOf, seedJob } from './job-harness';
import { agreementOf, insertAgreement, newSubmission, refusal, seedCommitted, seedEstimate, seedPin, seedSignature, seedVersion, type Chain } from './submission-harness';
import { resetTeamDatabase, startTeamServer, type Harness } from './team-harness';

// S5b-10 slice 10A: migration 0020, the drying log (drying_readings), the job close (job_closes), the
// estimate history (estimate_history) and the drying watch's decisions (job_coordination.drying_watch),
// as the app's runtime role on a server set up like a fresh Cloud SQL instance (team-harness.ts). No
// route uses them yet; these tests write through withCompany as slice 10B will. The S5b-10 checks the
// database holds: a reading resent after a lost response is stored once; removing a reading is a void,
// set once, never a delete; a close is bound to the job's agreement; every key stays in its company.
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
const json = (value: unknown) => JSON.stringify(value);

// A signed job of a company: its chain (submission, pin, estimate, signature), its original agreement and the
// price mode and cents its stored priced result states.
type Signed = { chain: Chain; job: string; agreement: string; company: string; figures: Figures };
type Figures = { mode: 'range' | 'single'; low: number; high: number | null };

// A stored priced result in the shape the app reads back (readStoredEstimate): a range has both ends, one price has no high end.
const end = (total: string) => ({ subtotal: total, after_hours: '0.00', trade_minimums: [], minimum_charge: '0.00', overhead_profit: '0.00', tax: '0.00', total });
const storedResult = (mode: 'range' | 'single', low: string, high: string | null): Record<string, unknown> => ({
  ok: true,
  engine_version: 'dryscope-v3',
  table_sha256: 'a'.repeat(64),
  lines: [],
  totals: {
    mode,
    low: end(low),
    high: high === null ? null : end(high),
    labor_material_low: '820.00',
    labor_material_high: '820.00',
    explanation: 'Synthetic totals.',
    range_explanation: mode === 'range' ? 'Synthetic range.' : null,
    after_hours_label: 'After-hours adjustment',
  },
  warnings: { engine: [], advisory: [] },
  documents: {
    proposal: { customer_name: 'Pat Customer', property_address: '1 Synthetic Way, Testville', lead_notice_required: false, findings: [], recommendations: [], disclaimers: [] },
    letter: '',
    compliance_notes: [],
    photo_log: [],
    claim: null,
    itemized_claim: [],
    unpriced_work: [],
    signable: true,
    staff_notes: { summary: '', suggestions: [], company_setup_missing: [], quantity_notes: [] },
  },
  job_revision: null,
});

// What a history sample and a close hold of a stored result: its price mode and its ends in whole cents.
const figuresOf = (result: Record<string, unknown>): Figures => {
  const { totals } = readStoredEstimate(result);
  const cents = (money: string) => Math.round(Number(money) * 100);
  return { mode: totals.mode, low: cents(totals.low.total), high: totals.high === null ? null : cents(totals.high.total) };
};

// The stored priced result of each fixture: a range job, a one-price job, and a change order whose totals differ.
const RANGE_RESULT = storedResult('range', '1100.00', '1400.00');
const SINGLE_RESULT = storedResult('single', '1250.00', null);
const CHANGED_RESULT = storedResult('range', '1500.00', '1900.00');
const SINGLE = figuresOf(SINGLE_RESULT);
const CHANGED = figuresOf(CHANGED_RESULT);

async function signedJob(company = h.seed.a, result: Record<string, unknown> = RANGE_RESULT): Promise<Signed> {
  const actor = ownerOf(h, company);
  const job = await seedJob(h.admin, newJob(company, actor));
  const version = await seedVersion(h.admin, company, actor);
  const submission = await seedCommitted(h.admin, newSubmission(company, job.id, actor));
  const pin = await seedPin(h.admin, { company, job: job.id, version: version.id, actor });
  const estimate = await seedEstimate(h.admin, { company, job: job.id, submission: submission.id, pin, actor, hash: version.hash, result });
  const signature = await seedSignature(h.admin, company, job.id, actor);
  const chain: Chain = { company, actor, job, version, submission, pin, estimate, signature };
  const [agreement] = rows<{ id: string }>(await as(company, (tx) => insertAgreement(tx, agreementOf(chain, { result }))));
  await h.admin`UPDATE jobs SET status = 'signed', revision = revision + 1 WHERE id = ${chain.job.id}`;
  return { chain, job: chain.job.id, agreement: agreement!.id, company, figures: figuresOf(result) };
}

// A signed change order on the job: its own committed record, estimate and signature, naming the original.
async function changeOrder(s: Signed, result: Record<string, unknown> = CHANGED_RESULT): Promise<string> {
  const { chain } = s;
  const submission = await seedCommitted(h.admin, newSubmission(s.company, s.job, chain.actor, { kind: 'change_order', parent: s.agreement }));
  const estimate = await seedEstimate(h.admin, { company: s.company, job: s.job, submission: submission.id, pin: chain.pin, actor: chain.actor, hash: chain.version.hash, result });
  const signature = await seedSignature(h.admin, s.company, s.job, chain.actor);
  const [made] = rows<{ id: string }>(
    await as(s.company, (tx) =>
      insertAgreement(
        tx,
        agreementOf(chain, { submission: submission.id, estimate: estimate.id, signature, proposalSha: estimate.proposal.sha, kind: 'change_order', parent: s.agreement, result }),
      ),
    ),
  );
  return made!.id;
}

// --- Readings ------------------------------------------------------------------------------------

const PAYLOADS = {
  air: { zone: 'affected', temperature_f: 70, relative_humidity: 50, note: '' },
  material: { material: 'Drywall', moisture: 18.5, unit: '%WME', dry_standard: 12, affected: true, note: 'North wall, 12 in up' },
  thermal: { delta_t_f: -6.5, pattern: 'cold_anomaly', boundary: 'Along the baseboard', note: '' },
} as const;
// What the server works out at 70 F and 50 % RH (backend/psychrometrics.py).
const AIR_70_50 = { gpp: 54, dew: 51, depression: 19, vapor: '0.37', enthalpy: '25.3' };

type Reading = {
  id: string;
  job: string;
  kind: string;
  payload: unknown;
  company?: string;
  room?: string | null;
  label?: string | null;
  air?: { gpp: number; dew: number; depression: number; vapor: string; enthalpy: string } | null;
  actor?: string;
};

const readingOf = (job: string, kind: keyof typeof PAYLOADS, extra: Partial<Reading> = {}): Reading => ({
  id: randomUUID(),
  job,
  kind,
  payload: PAYLOADS[kind],
  room: 'room-kitchen',
  label: 'Kitchen',
  air: kind === 'air' ? AIR_70_50 : null,
  ...extra,
});

const addReading = (r: Reading, caller = r.company ?? h.seed.a) =>
  as(caller, (tx) =>
    tx.execute(sql`
      INSERT INTO drying_readings (id, company_id, job_id, kind, room_id, room_label, taken_at, payload, gpp, dew_point_f, dew_point_depression_f,
                                   vapor_pressure_inhg, enthalpy_btu_lb, request_digest, created_by_actor_id)
      VALUES (${r.id}::uuid, ${r.company ?? h.seed.a}::uuid, ${r.job}::uuid, ${r.kind}, ${r.room ?? null}, ${r.label ?? null}, '2026-11-20T16:00:00Z',
              ${json(r.payload)}::text::jsonb, ${r.air?.gpp ?? null}::integer, ${r.air?.dew ?? null}::integer, ${r.air?.depression ?? null}::integer,
              ${r.air?.vapor ?? null}::numeric, ${r.air?.enthalpy ?? null}::numeric, ${digestOf(r.id)}, ${r.actor ?? h.seed.estimatorA.actor}::uuid)
      RETURNING id::text
    `),
  );

// The reading insert inside a given transaction (the operator's), with the row's company A.
const addReadingIn = (tx: CompanyTransaction, r: Reading) =>
  tx.execute(sql`
    INSERT INTO drying_readings (id, company_id, job_id, kind, taken_at, payload, request_digest, created_by_actor_id)
    VALUES (${r.id}::uuid, ${h.seed.a}::uuid, ${r.job}::uuid, ${r.kind}, now(), ${json(r.payload)}::text::jsonb, ${digestOf(r.id)}, ${h.seed.ownerA.actor}::uuid)
  `);

const voidReading = (id: string, change = randomUUID(), actor = h.seed.estimatorA.actor, caller = h.seed.a) =>
  as(caller, (tx) =>
    tx.execute(sql`
      UPDATE drying_readings SET voided_by_actor_id = ${actor}::uuid, void_change_id = ${change}::uuid, void_digest = ${digestOf(change)}
      WHERE id = ${id}::uuid RETURNING id::text
    `),
  );

// --- Closes and history ---------------------------------------------------------------------------

type Close = {
  id: string;
  job: string;
  agreement: string;
  baseline?: string;
  revision?: number;
  final: number;
  days?: number | null;
  note?: string;
  mode?: 'range' | 'single';
  low?: number;
  high?: number | null;
  landed: string;
  company?: string;
  actor?: string;
};

const closeOf = (s: Signed, extra: Partial<Close> = {}): Close => ({
  id: randomUUID(),
  job: s.job,
  agreement: s.agreement,
  final: 125000,
  days: 4,
  note: 'Paid in full',
  landed: 'inside',
  ...extra,
});

const insertClose = (tx: CompanyTransaction, c: Close) =>
  tx.execute(sql`
      INSERT INTO job_closes (id, company_id, job_id, agreement_id, revision, request_digest, final_cents, actual_days, note, baseline_agreement_id, price_mode,
                              baseline_low_cents, baseline_high_cents, landed, closed_by_actor_id)
      VALUES (${c.id}::uuid, ${c.company ?? h.seed.a}::uuid, ${c.job}::uuid, ${c.agreement}::uuid, ${c.revision ?? 1}, ${digestOf(c.id)}, ${c.final}, ${c.days ?? null}::integer,
              ${c.note ?? ''}, ${c.baseline ?? c.agreement}::uuid, ${c.mode ?? 'range'}, ${c.low ?? 110000}, ${c.high === undefined ? 140000 : c.high}::bigint, ${c.landed},
              ${c.actor ?? h.seed.ownerA.actor}::uuid)
      RETURNING id::text, revision, closed_at
    `);
const addClose = (c: Close, caller = c.company ?? h.seed.a) => as(caller, (tx) => insertClose(tx, c));

type Sample = {
  job: string;
  agreement: string;
  mode?: 'range' | 'single';
  low?: number;
  high?: number | null;
  laborMaterial?: number | null;
  categories?: string[] | null;
  days?: number | null;
  area?: string | null;
  company?: string;
};

const insertSample = (tx: CompanyTransaction, s: Sample) =>
  tx.execute(sql`
      INSERT INTO estimate_history (company_id, job_id, agreement_id, signed_at, price_mode, low_cents, high_cents, labor_material_low_cents, room_categories,
                                    planned_days, area_sf)
      VALUES (${s.company ?? h.seed.a}::uuid, ${s.job}::uuid, ${s.agreement}::uuid, '2026-11-18T18:00:00Z', ${s.mode ?? 'range'}, ${s.low ?? 110000},
              ${s.high === undefined ? 140000 : s.high}::bigint, ${s.laborMaterial === undefined ? 82000 : s.laborMaterial}::bigint,
              ${s.categories === undefined ? '{2,mold}' : s.categories === null ? null : `{${s.categories.join(',')}}`}::text[],
              ${s.days === undefined ? 4 : s.days}::integer, ${s.area === undefined ? '412.50' : s.area}::numeric)
      RETURNING agreement_id::text
    `);
const addSample = (s: Sample, caller = s.company ?? h.seed.a) => as(caller, (tx) => insertSample(tx, s));

// The signed figures of a job's original agreement, as its history sample holds them: a close is compared
// with them (the owner's Q1, option A), and a close of a job with no sample has no baseline to name.
const baselined = async (s: Signed): Promise<Signed> => {
  await addSample({ job: s.job, agreement: s.agreement, company: s.company, ...s.figures });
  return s;
};

const waitUntil = async (check: () => Promise<boolean>, what: string) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
};

// PostgreSQL shows a backend waiting on the given one.
const isWaitingOn = async (pid: number) =>
  (await h.admin<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`)[0]!.n > 0;

// An office save that takes the job's row lock first, as office.ts does, and writes after the watch write has started
// and `reached` says the watch is waiting or done. The save is always released, and both writes must succeed.
async function overlapOfficeAndWatch(
  s: Signed,
  officeWrite: (tx: CompanyTransaction) => Promise<unknown>,
  startWatch: () => Promise<unknown>,
  reached: (officePid: number, watch: Promise<unknown>) => Promise<unknown>,
) {
  let locked!: (pid: number) => void;
  const hasLock = new Promise<number>((resolve) => (locked = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const office = as(s.company, async (tx) => {
    await tx.execute(sql`SELECT 1 FROM jobs WHERE company_id = ${s.company}::uuid AND id = ${s.job}::uuid FOR UPDATE`);
    locked(rows<{ pid: number }>(await tx.execute(sql`SELECT pg_backend_pid() AS pid`))[0]!.pid);
    await gate;
    await officeWrite(tx);
  });
  office.catch(() => {});
  let watch: Promise<unknown> | undefined;
  try {
    const pid = await Promise.race([hasLock, office.then(() => Promise.reject(new Error('the office save ended before it held the job lock')))]);
    watch = startWatch();
    watch.catch(() => {});
    await reached(pid, watch);
  } finally {
    release();
  }
  await Promise.all([office, watch]);
}

// --- The watch -------------------------------------------------------------------------------------

type Receipt = Record<string, unknown>;

const receiptOf = (s: Signed, action = 'extend', extra: Receipt = {}): Receipt => {
  const id = randomUUID();
  return { action, agreement_id: s.agreement, reason: 'Ceiling still wet at the north wall', actor_id: ownerOf(h, s.company), request_id: id, request_digest: digestOf(id), ...extra };
};

type Coordination = { watch: { revision: number; receipts: Receipt[] } | null; revision: number; notes: string; updated: string };

const coordinationOf = async (job: string): Promise<Coordination> =>
  (
    await h.admin<Coordination[]>`
      SELECT drying_watch AS watch, revision, office_notes AS notes, updated_at::text AS updated FROM job_coordination WHERE job_id = ${job}
    `
  )[0]!;

const fieldRevisionOf = async (job: string) => (await h.admin<{ revision: number }[]>`SELECT field_revision::int AS revision FROM jobs WHERE id = ${job}`)[0]!.revision;

// The watch as the write sets it: the first action makes the coordination row at coordination revision 0
// (no office change yet) with its other defaults, and on conflict only the watch column changes.
const writeWatch = (s: Signed, watch: unknown, caller = s.company) =>
  as(caller, (tx) =>
    tx.execute(sql`
      INSERT INTO job_coordination (company_id, job_id, revision, drying_watch) VALUES (${s.company}::uuid, ${s.job}::uuid, 0, ${json(watch)}::text::jsonb)
      ON CONFLICT (company_id, job_id) DO UPDATE SET drying_watch = EXCLUDED.drying_watch
      RETURNING job_id::text
    `),
  );

// One accepted action, as slice 10B will add it: the stored receipts, then the new one.
async function act(s: Signed, receipt: Receipt) {
  const [found] = await h.admin<{ watch: Coordination['watch'] }[]>`SELECT drying_watch AS watch FROM job_coordination WHERE job_id = ${s.job}`;
  const earlier = found?.watch?.receipts ?? [];
  return writeWatch(s, { revision: earlier.length + 1, receipts: [...earlier, receipt] });
}

describe('migration 0020: rights and row-level security', () => {
  const TABLES = ['drying_readings', 'estimate_history', 'job_closes'];

  it('forces row-level security with company policies, grants no DELETE, inserts only the creation columns, and lets the runtime change only a void and the watch', async () => {
    expect(await unprotectedRelations(h.admin)).toEqual([]);
    expect(
      await h.admin`
        SELECT c.relname AS table, c.relforcerowsecurity AS forced, array(SELECT p.polname::text FROM pg_policy p WHERE p.polrelid = c.oid ORDER BY 1) AS policies
        FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY(${TABLES}) ORDER BY 1
      `,
    ).toEqual([
      { table: 'drying_readings', forced: true, policies: ['drying_readings_insert', 'drying_readings_select', 'drying_readings_update'] },
      { table: 'estimate_history', forced: true, policies: ['estimate_history_insert', 'estimate_history_select'] },
      { table: 'job_closes', forced: true, policies: ['job_closes_insert', 'job_closes_select'] },
    ]);
    expect(
      await h.admin`
        SELECT table_name AS table, privilege_type AS privilege FROM information_schema.role_table_grants
        WHERE grantee = 'dryscope_runtime' AND table_name = ANY(${TABLES}) ORDER BY 1, 2
      `,
    ).toEqual(TABLES.map((table) => ({ table, privilege: 'SELECT' })));
    // Inserting is granted by column: not a reading's receive time or void, nor a close's time.
    const insertable = async (table: string) =>
      (
        await h.admin<{ column: string }[]>`
          SELECT column_name AS column FROM information_schema.column_privileges
          WHERE grantee = 'dryscope_runtime' AND table_name = ${table} AND privilege_type = 'INSERT'
        `
      )
        .map((row) => row.column)
        .sort();
    expect(await insertable('drying_readings')).toEqual(
      [
        'id', 'company_id', 'job_id', 'kind', 'room_id', 'room_label', 'taken_at', 'payload', 'gpp', 'dew_point_f', 'dew_point_depression_f',
        'vapor_pressure_inhg', 'enthalpy_btu_lb', 'request_digest', 'created_by_actor_id',
      ].sort(),
    );
    expect(await insertable('job_closes')).toEqual(
      [
        'id', 'company_id', 'job_id', 'agreement_id', 'revision', 'request_digest', 'final_cents', 'actual_days', 'note', 'baseline_agreement_id',
        'price_mode', 'baseline_low_cents', 'baseline_high_cents', 'landed', 'closed_by_actor_id',
      ].sort(),
    );
    expect(await insertable('estimate_history')).toEqual(
      ['company_id', 'job_id', 'agreement_id', 'signed_at', 'price_mode', 'low_cents', 'high_cents', 'labor_material_low_cents', 'room_categories', 'planned_days', 'area_sf'].sort(),
    );
    expect(
      await h.admin`
        SELECT table_name AS table, column_name AS column FROM information_schema.column_privileges
        WHERE grantee = 'dryscope_runtime' AND table_name = ANY(${[...TABLES, 'job_coordination']}) AND privilege_type = 'UPDATE' ORDER BY 1, 2
      `,
    ).toEqual([
      { table: 'drying_readings', column: 'void_change_id' },
      { table: 'drying_readings', column: 'void_digest' },
      { table: 'drying_readings', column: 'voided_by_actor_id' },
      { table: 'job_coordination', column: 'drying_watch' },
      { table: 'job_coordination', column: 'last_change_id' },
      { table: 'job_coordination', column: 'office_notes' },
      { table: 'job_coordination', column: 'revision' },
      { table: 'job_coordination', column: 'updated_at' },
    ]);
  });

  it('keeps every row in its company: the other company sees none, writes none, and an operator reads but never writes', async () => {
    const s = await signedJob();
    const reading = readingOf(s.job, 'air');
    await addReading(reading);
    await baselined(s);
    await addClose(closeOf(s));
    await act(s, receiptOf(s));

    for (const statement of ['DELETE FROM drying_readings', 'DELETE FROM job_closes', 'DELETE FROM estimate_history', 'TRUNCATE drying_readings']) {
      expect({ statement, code: await errorCode(as(h.seed.a, (tx) => tx.execute(sql.raw(statement)))) }).toEqual({ statement, code: INSUFFICIENT_PRIVILEGE });
    }
    for (const statement of ['UPDATE job_closes SET final_cents = 1', 'UPDATE estimate_history SET low_cents = 1', `UPDATE drying_readings SET payload = '{}'`, 'UPDATE drying_readings SET voided_at = now()']) {
      expect({ statement, code: await errorCode(as(h.seed.a, (tx) => tx.execute(sql.raw(statement)))) }).toEqual({ statement, code: INSUFFICIENT_PRIVILEGE });
    }

    // Company B sees none of A's rows, and cannot write one for A.
    for (const table of [...TABLES, 'job_coordination']) {
      expect({ table, seen: rows(await as(h.seed.b, (tx) => tx.execute(sql.raw(`SELECT * FROM ${table}`)))) }).toEqual({ table, seen: [] });
    }
    expect(await errorCode(addReading(readingOf(s.job, 'air'), h.seed.b))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await errorCode(addClose(closeOf(s, { revision: 2 }), h.seed.b))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await errorCode(addSample({ job: s.job, agreement: s.agreement }, h.seed.b))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(rows(await voidReading(reading.id, randomUUID(), h.seed.estimatorA.actor, h.seed.b))).toEqual([]);
    expect(rows(await as(h.seed.b, (tx) => tx.execute(sql`UPDATE job_coordination SET drying_watch = NULL RETURNING job_id`)))).toEqual([]);

    // Outside withCompany (no company set) the runtime sees nothing and writes nothing.
    const bare = postgres(h.apiUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
    try {
      for (const table of [...TABLES, 'job_coordination']) expect({ table, rows: (await bare.unsafe(`SELECT * FROM ${table}`)).length }).toEqual({ table, rows: 0 });
      expect(
        await errorCode(
          bare.unsafe(`INSERT INTO estimate_history (company_id, job_id, agreement_id, signed_at, price_mode, low_cents) VALUES ($1, $2, $3, now(), 'single', 1)`, [h.seed.a, s.job, s.agreement]),
        ),
      ).toBe(INSUFFICIENT_PRIVILEGE);
    } finally {
      await bare.end({ timeout: 5 });
    }

    // A verified operator reads company A's rows, and its writes reach none.
    for (const table of TABLES) {
      expect({ table, n: rows(await asOperator((tx) => tx.execute(sql.raw(`SELECT * FROM ${table}`)), true)).length }).toEqual({ table, n: 1 });
    }
    expect(rows(await asOperator((tx) => tx.execute(sql`SELECT drying_watch->>'revision' AS revision FROM job_coordination`), true))).toEqual([{ revision: '1' }]);
    const added = await changeOrder(s);
    expect(rows(await asOperator((tx) => tx.execute(sql`UPDATE drying_readings SET voided_by_actor_id = ${h.seed.ownerA.actor}::uuid RETURNING id`)))).toEqual([]);
    expect(rows(await asOperator((tx) => tx.execute(sql`UPDATE job_coordination SET drying_watch = NULL RETURNING job_id`)))).toEqual([]);
    expect(await errorCode(asOperator((tx) => addReadingIn(tx, readingOf(s.job, 'thermal'))))).toBe(INSUFFICIENT_PRIVILEGE);
    // A valid next close revision and a fresh history sample (a change order's, of the same job) are refused too.
    expect(await errorCode(asOperator((tx) => insertClose(tx, closeOf(s, { revision: 2, final: 151000, landed: 'above' }))))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await errorCode(asOperator((tx) => insertSample(tx, { job: s.job, agreement: added, ...CHANGED, laborMaterial: null, categories: null, days: null, area: null })))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(
      await h.admin`
        SELECT (SELECT count(*)::int FROM drying_readings) AS readings, (SELECT count(*)::int FROM job_closes) AS closes, (SELECT count(*)::int FROM estimate_history) AS history,
               (SELECT count(*)::int FROM drying_readings WHERE voided_at IS NOT NULL) AS voided
      `,
    ).toEqual([{ readings: 1, closes: 1, history: 1, voided: 0 }]);
  });
});

describe('migration 0020: drying_readings', () => {
  it('holds each kind with exactly its own fields, and an air reading with the server’s five air values', async () => {
    const s = await signedJob();
    for (const kind of ['air', 'material', 'thermal'] as const) expect(rows(await addReading(readingOf(s.job, kind)))).toHaveLength(1);
    // A whole-job reading has no room, and outside air belongs to no room.
    expect(rows(await addReading(readingOf(s.job, 'material', { room: null, label: null })))).toHaveLength(1);
    expect(rows(await addReading(readingOf(s.job, 'air', { room: null, label: null, payload: { ...PAYLOADS.air, zone: 'outside' } })))).toHaveLength(1);
    // Every field is bounded by characters, not bytes: a 300-character boundary and a 400-character note in Chinese hold.
    expect(rows(await addReading(readingOf(s.job, 'thermal', { payload: { ...PAYLOADS.thermal, boundary: '界'.repeat(300), note: '界'.repeat(400) } })))).toHaveLength(1);
    expect(rows(await addReading(readingOf(s.job, 'material', { payload: { ...PAYLOADS.material, material: '界'.repeat(100), unit: '界'.repeat(20), note: '界'.repeat(500) } })))).toHaveLength(1);
    // A material reading with no dry standard.
    expect(rows(await addReading(readingOf(s.job, 'material', { payload: { ...PAYLOADS.material, dry_standard: null } })))).toHaveLength(1);
    const [air] = await h.admin`
      SELECT gpp, dew_point_f, dew_point_depression_f, vapor_pressure_inhg::text, enthalpy_btu_lb::text FROM drying_readings WHERE kind = 'air' AND room_id IS NOT NULL
    `;
    expect(air).toEqual({ gpp: 54, dew_point_f: 51, dew_point_depression_f: 19, vapor_pressure_inhg: '0.37', enthalpy_btu_lb: '25.3' });

    const refused = async (r: Reading) => (await refusal(addReading(r)))?.constraint;
    // A derived value, a stray field or a missing one in the payload; a value out of range; a wrong type.
    expect(await refused(readingOf(s.job, 'air', { payload: { ...PAYLOADS.air, gpp: 54 } }))).toBe('drying_readings_payload_check');
    expect(await refused(readingOf(s.job, 'air', { payload: { zone: 'affected', temperature_f: 70, relative_humidity: 50 } }))).toBe('drying_readings_payload_check');
    expect(await refused(readingOf(s.job, 'air', { payload: { ...PAYLOADS.air, relative_humidity: 0 } }))).toBe('drying_readings_payload_check');
    expect(await refused(readingOf(s.job, 'air', { payload: { ...PAYLOADS.air, temperature_f: 150.5 } }))).toBe('drying_readings_payload_check');
    expect(await refused(readingOf(s.job, 'air', { payload: { ...PAYLOADS.air, temperature_f: '70' } }))).toBe('drying_readings_payload_check');
    expect(await refused(readingOf(s.job, 'air', { payload: { ...PAYLOADS.air, zone: 'attic' } }))).toBe('drying_readings_payload_check');
    expect(await refused(readingOf(s.job, 'material', { payload: { ...PAYLOADS.material, moisture: 1000.1 } }))).toBe('drying_readings_payload_check');
    expect(await refused(readingOf(s.job, 'material', { payload: { ...PAYLOADS.material, unit: ' ' } }))).toBe('drying_readings_payload_check');
    expect(await refused(readingOf(s.job, 'material', { payload: { ...PAYLOADS.material, affected: 'yes' } }))).toBe('drying_readings_payload_check');
    expect(await refused(readingOf(s.job, 'material', { payload: { ...PAYLOADS.material, note: 'n'.repeat(501) } }))).toBe('drying_readings_payload_check');
    expect(await refused(readingOf(s.job, 'thermal', { payload: { ...PAYLOADS.thermal, delta_t_f: -200.5 } }))).toBe('drying_readings_payload_check');
    expect(await refused(readingOf(s.job, 'thermal', { payload: { ...PAYLOADS.thermal, pattern: 'warm' } }))).toBe('drying_readings_payload_check');
    expect(await refused(readingOf(s.job, 'thermal', { payload: { ...PAYLOADS.thermal, boundary: '界'.repeat(301) } }))).toBe('drying_readings_payload_check');
    expect(await refused(readingOf(s.job, 'thermal', { payload: PAYLOADS.air }))).toBe('drying_readings_payload_check');
    // The air values come with an air reading only, all five or none.
    expect(await refused(readingOf(s.job, 'air', { air: null }))).toBe('drying_readings_air_values_check');
    expect(await refused(readingOf(s.job, 'material', { air: AIR_70_50 }))).toBe('drying_readings_air_values_check');
    expect(await refused(readingOf(s.job, 'air', { air: { ...AIR_70_50, vapor: '0.3701' } }))).toBe('drying_readings_vapor_pressure_inhg_check');
    // A room has its id and label together; outside air has no room; a label is 1 to 100 characters, not blank.
    expect(await refused(readingOf(s.job, 'material', { label: null }))).toBe('drying_readings_room_check');
    expect(await refused(readingOf(s.job, 'air', { payload: { ...PAYLOADS.air, zone: 'outside' } }))).toBe('drying_readings_outside_check');
    expect(await refused(readingOf(s.job, 'material', { label: 'Kitchen\u0007' }))).toBe('drying_readings_room_label_check');
    expect(await refused(readingOf(s.job, 'material', { label: ' \t ' }))).toBe('drying_readings_room_label_check');
    expect(await refused(readingOf(s.job, 'material', { label: 'k'.repeat(101) }))).toBe('drying_readings_room_label_check');
    // The label is the room's name as captured, which may hold a tab or a line break.
    expect(rows(await addReading(readingOf(s.job, 'material', { label: 'Hall\tEast' })))).toHaveLength(1);
    expect(rows(await addReading(readingOf(s.job, 'material', { label: 'Kitchen\nand hall' })))).toHaveLength(1);
    expect(await refused(readingOf(s.job, 'material', { room: 'room/1' }))).toBe('drying_readings_room_id_check');
  });

  it('stores a reading resent after a lost response once, stamps when it was received, and never changes its raw fields', async () => {
    const s = await signedJob();
    const r = readingOf(s.job, 'material');
    await addReading(r);
    expect(await refusal(addReading(r))).toMatchObject({ code: UNIQUE_VIOLATION, constraint: 'drying_readings_pkey' });
    // The same id on another job of the company is the same row too.
    const other = await signedJob();
    expect(await refusal(addReading({ ...r, job: other.job }))).toMatchObject({ code: UNIQUE_VIOLATION });
    const [saved] = await h.admin<{ received: Date; taken: Date }[]>`SELECT received_at AS received, taken_at AS taken FROM drying_readings WHERE id = ${r.id}`;
    expect(Math.abs(saved!.received.getTime() - Date.now())).toBeLessThan(60_000);
    expect(saved!.taken.toISOString()).toBe('2026-11-20T16:00:00.000Z');

    // The table owner is held by the guard too: a raw field, the receive time or the creator never change.
    for (const change of [`payload = '{"note":""}'`, `room_label = 'Hall'`, 'taken_at = now()', 'received_at = now()', `created_by_actor_id = '${h.seed.ownerA.actor}'`]) {
      expect({ change, found: await refusal(h.admin.unsafe(`UPDATE drying_readings SET ${change} WHERE id = $1`, [r.id])) }).toMatchObject({
        change,
        found: { code: CHECK_VIOLATION, message: 'a drying reading never changes' },
      });
    }
  });

  it('is voided once, with who, the void’s id and digest together and the time from the clock, and stays voided', async () => {
    const s = await signedJob();
    const [first, second] = [readingOf(s.job, 'air'), readingOf(s.job, 'thermal')];
    await addReading(first);
    await addReading(second);
    // Part of a void is refused.
    expect(await refusal(as(h.seed.a, (tx) => tx.execute(sql`UPDATE drying_readings SET voided_by_actor_id = ${h.seed.ownerA.actor}::uuid WHERE id = ${first.id}::uuid`)))).toMatchObject({
      code: CHECK_VIOLATION,
      message: expect.stringContaining('only by its void'),
    });
    const change = randomUUID();
    expect(rows(await voidReading(first.id, change))).toHaveLength(1);
    const [voided] = await h.admin<{ by: string; at: Date; change: string; digest: string; payload: unknown }[]>`
      SELECT voided_by_actor_id::text AS by, voided_at AS at, void_change_id::text AS change, void_digest AS digest, payload FROM drying_readings WHERE id = ${first.id}
    `;
    expect(voided).toMatchObject({ by: h.seed.estimatorA.actor, change, digest: digestOf(change), payload: PAYLOADS.air });
    expect(Math.abs(voided!.at.getTime() - Date.now())).toBeLessThan(60_000);
    // A second void, even a distinct one by another person, cannot overwrite the first.
    expect(await refusal(voidReading(first.id, randomUUID(), h.seed.ownerA.actor))).toMatchObject({ code: CHECK_VIOLATION, message: 'a drying reading is voided once' });
    expect(await refusal(voidReading(first.id, change))).toMatchObject({ code: CHECK_VIOLATION, message: 'a drying reading is voided once' });
    // The same void id on another reading is refused.
    expect(await refusal(voidReading(second.id, change))).toMatchObject({ code: UNIQUE_VIOLATION, constraint: 'drying_readings_void_change' });
    // A reading cannot start voided.
    const planted = readingOf(s.job, 'thermal');
    expect(
      await refusal(
        h.admin`
          INSERT INTO drying_readings (id, company_id, job_id, kind, taken_at, payload, request_digest, created_by_actor_id, voided_by_actor_id, voided_at, void_change_id, void_digest)
          VALUES (${planted.id}, ${h.seed.a}, ${s.job}, 'thermal', now(), ${h.admin.json(PAYLOADS.thermal)}, ${digestOf(planted.id)}, ${h.seed.ownerA.actor},
                  ${h.seed.ownerA.actor}, now(), ${randomUUID()}, ${digestOf('void')})
        `,
      ),
    ).toMatchObject({ code: CHECK_VIOLATION, message: 'a drying reading starts active' });
    // The job's active readings are the second one only.
    expect(await h.admin`SELECT id::text FROM drying_readings WHERE voided_at IS NULL ORDER BY taken_at, id`).toEqual([{ id: second.id }]);
  });

  it('refuses a reading of another company’s job or person, and a void by another company’s person', async () => {
    const s = await signedJob();
    const b = await signedJob(h.seed.b);
    expect(await refusal(addReading(readingOf(b.job, 'air')))).toMatchObject({ code: FOREIGN_KEY_VIOLATION, constraint: 'drying_readings_job_fkey' });
    expect(await refusal(addReading(readingOf(s.job, 'air', { actor: h.seed.ownerB.actor })))).toMatchObject({ code: FOREIGN_KEY_VIOLATION, constraint: 'drying_readings_created_by_fkey' });
    const r = readingOf(s.job, 'air');
    await addReading(r);
    expect(await refusal(voidReading(r.id, randomUUID(), h.seed.ownerB.actor))).toMatchObject({ code: FOREIGN_KEY_VIOLATION, constraint: 'drying_readings_voided_by_fkey' });
  });
});

describe('migration 0020: job_closes', () => {
  it('is append-only: each correction takes the next revision, and every earlier receipt stays readable by its request id', async () => {
    const s = await baselined(await signedJob());
    const first = closeOf(s);
    const [made] = rows<{ revision: number; closed_at: Date }>(await addClose(first));
    expect(made!.revision).toBe(1);
    expect(Math.abs(new Date(made!.closed_at).getTime() - Date.now())).toBeLessThan(60_000);
    // A replay of the same request is the same row; a new request at a taken or skipped revision is refused.
    expect(await refusal(addClose(first))).toMatchObject({ code: UNIQUE_VIOLATION, constraint: 'job_closes_pkey' });
    expect(await refusal(addClose(closeOf(s)))).toMatchObject({ code: CHECK_VIOLATION, message: 'a job close takes the next close revision of its job' });
    expect(await refusal(addClose(closeOf(s, { revision: 3 })))).toMatchObject({ code: CHECK_VIOLATION });
    const correction = closeOf(s, { revision: 2, final: 151000, landed: 'above', days: null, note: '' });
    await addClose(correction);
    // Two corrections that both read revision 2 as the latest: the job lock orders them, and the second is refused.
    await expect(Promise.all([addClose(closeOf(s, { revision: 3 })), addClose(closeOf(s, { revision: 3 }))])).rejects.toBeDefined();
    expect(await h.admin`SELECT id::text, revision, final_cents::int AS final, actual_days AS days, landed FROM job_closes WHERE job_id = ${s.job} ORDER BY revision`).toEqual([
      { id: first.id, revision: 1, final: 125000, days: 4, landed: 'inside' },
      { id: correction.id, revision: 2, final: 151000, days: null, landed: 'above' },
      expect.objectContaining({ revision: 3 }),
    ]);
    // Another job's revisions are its own.
    const other = await baselined(await signedJob());
    expect(rows(await addClose(closeOf(other)))).toHaveLength(1);
    // A close never changes: the runtime has no UPDATE (and no DELETE).
    expect(await errorCode(as(h.seed.a, (tx) => tx.execute(sql`UPDATE job_closes SET note = 'changed'`)))).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('holds the amount, day and note bounds and the classification it was saved with', async () => {
    const s = await signedJob();
    const refused = async (extra: Partial<Close>) => (await refusal(addClose(closeOf(s, extra))))?.constraint;
    expect(await refused({ final: 0, landed: 'below' })).toBe('job_closes_final_cents_check');
    expect(await refused({ final: 200000001, landed: 'above' })).toBe('job_closes_final_cents_check');
    expect(await refused({ days: -1 })).toBe('job_closes_actual_days_check');
    expect(await refused({ days: 366 })).toBe('job_closes_actual_days_check');
    expect(await refused({ note: 'n'.repeat(301) })).toBe('job_closes_note_check');
    expect(await refused({ note: 'bell\u0007' })).toBe('job_closes_note_check');
    // A range is inside from low to high, both included, below under the low and above over the high.
    expect(await refused({ final: 109999, landed: 'inside' })).toBe('job_closes_classification_check');
    expect(await refused({ final: 140001, landed: 'inside' })).toBe('job_closes_classification_check');
    expect(await refused({ final: 120000, landed: 'above' })).toBe('job_closes_classification_check');
    // One price has no high end: inside at or under it, above over it, never below.
    expect(await refused({ mode: 'single', high: null, final: 100, landed: 'below' })).toBe('job_closes_classification_check');
    expect(await refused({ mode: 'single', high: 140000, final: 100000, landed: 'inside' })).toBe('job_closes_mode_check');
    expect(await refused({ mode: 'range', high: null })).toBe('job_closes_mode_check');
    expect(await refused({ low: 150000, high: 140000 })).toBe('job_closes_baseline_high_cents_check');
    // A baseline above 2^53 - 1 cents is refused, so a number holds every baseline exactly.
    expect(await refused({ low: 9007199254740992, high: 9007199254740992, landed: 'below' })).toBe('job_closes_baseline_high_cents_check');
    expect(await refused({ mode: 'single', high: null, low: 9007199254740992, final: 125000, landed: 'inside' })).toBe('job_closes_baseline_low_cents_check');

    // The bounds themselves are accepted, each as its own correction: the inclusive range ends, one
    // price exactly, the largest invoice, zero days and 365 days, a 300-character note over lines. A
    // range job and a one-price job have each their own signed figures.
    const ranged = await baselined(await signedJob());
    const accepted: Partial<Close>[] = [
      { final: 110000, landed: 'inside', days: 0 },
      { final: 140000, landed: 'inside', days: 365 },
      { final: 109999, landed: 'below', note: `${'n'.repeat(298)}\r\n` },
      { final: 1, landed: 'below', days: null },
    ];
    for (const [index, extra] of accepted.entries()) expect(rows(await addClose(closeOf(ranged, { revision: index + 1, ...extra })))).toHaveLength(1);
    const priced = await baselined(await signedJob(h.seed.a, SINGLE_RESULT));
    const single: Partial<Close>[] = [
      { ...SINGLE, final: 125000, landed: 'inside' },
      { ...SINGLE, final: 200000000, landed: 'above' },
    ];
    for (const [index, extra] of single.entries()) expect(rows(await addClose(closeOf(priced, { revision: index + 1, ...extra })))).toHaveLength(1);
  });

  it('is bound to an agreement of its own job, and keeps its baseline agreement as its own reference', async () => {
    const s = await baselined(await signedJob());
    const added = await changeOrder(s);
    // Confirmed against the change order in force, compared with the original (the owner's Q1, option A).
    expect(rows(await addClose(closeOf(s, { agreement: added, baseline: s.agreement })))).toHaveLength(1);
    expect(await h.admin`SELECT agreement_id::text AS confirmed, baseline_agreement_id::text AS baseline FROM job_closes`).toEqual([{ confirmed: added, baseline: s.agreement }]);

    const other = await signedJob();
    const b = await signedJob(h.seed.b);
    // Another job's agreement, as the one confirmed or as the baseline, and another company's.
    expect(await refusal(addClose(closeOf(s, { revision: 2, agreement: other.agreement })))).toMatchObject({ code: FOREIGN_KEY_VIOLATION, constraint: 'job_closes_agreement_fkey' });
    expect(await refusal(addClose(closeOf(s, { revision: 2, baseline: other.agreement })))).toMatchObject({ code: FOREIGN_KEY_VIOLATION, constraint: 'job_closes_baseline_agreement_fkey' });
    expect(await refusal(addClose(closeOf(s, { revision: 2, agreement: b.agreement, baseline: b.agreement })))).toMatchObject({ code: FOREIGN_KEY_VIOLATION });
    expect(await refusal(addClose(closeOf(s, { revision: 2, actor: h.seed.ownerB.actor })))).toMatchObject({ code: FOREIGN_KEY_VIOLATION, constraint: 'job_closes_closed_by_fkey' });
    // A job with no agreement (not signed) cannot close: there is nothing to confirm it against.
    const unsigned = await seedJob(h.admin, newJob(h.seed.a, h.seed.ownerA.actor));
    expect(await refusal(addClose(closeOf(s, { job: unsigned.id })))).toMatchObject({ code: FOREIGN_KEY_VIOLATION });
    // A signed job whose original has no history sample has no baseline to name.
    const unsampled = await signedJob();
    expect(await refusal(addClose(closeOf(unsampled)))).toMatchObject({ code: FOREIGN_KEY_VIOLATION, constraint: 'job_closes_baseline_agreement_fkey' });
  });

  it('is compared with the job’s original agreement, by that sample’s price mode and cents, never a change order’s', async () => {
    // A range job and a one-price job, each with its own signed figures.
    const ranged = await baselined(await signedJob());
    const priced = await baselined(await signedJob(h.seed.a, SINGLE_RESULT));
    const message = async (c: Close) => (await refusal(addClose(c)))?.message;
    const mismatch = 'a job close keeps the price mode and baseline cents of its baseline sample';

    // The change order has its own sample with different totals; it cannot be the baseline, even by its own figures.
    const added = await changeOrder(ranged);
    await addSample({ job: ranged.job, agreement: added, ...CHANGED, laborMaterial: null, categories: null, days: null, area: null });
    expect(await message(closeOf(ranged, { agreement: added, baseline: added, ...CHANGED, final: 160000, landed: 'inside' }))).toBe(
      "a job close is compared with the job's original agreement",
    );
    // A close that states another mode, low end or high end than the original's sample is refused, however it classifies.
    expect(await message(closeOf(ranged, { mode: 'single', low: 110000, high: null, final: 100000, landed: 'inside' }))).toBe(mismatch);
    expect(await message(closeOf(ranged, { low: 125000, high: 140000, final: 130000, landed: 'inside' }))).toBe(mismatch);
    expect(await message(closeOf(ranged, { low: 110000, high: 150000, final: 145000, landed: 'inside' }))).toBe(mismatch);
    expect(await message(closeOf(priced, { mode: 'range', low: 125000, high: 150000, final: 130000, landed: 'inside' }))).toBe(mismatch);
    expect(await message(closeOf(priced, { ...SINGLE, low: 130000, final: 130000, landed: 'inside' }))).toBe(mismatch);
    expect(await h.admin`SELECT count(*)::int AS n FROM job_closes`).toEqual([{ n: 0 }]);

    // The original's own figures are accepted: the invoice that is inside a range stays inside while a change order moves the total.
    expect(rows(await addClose(closeOf(ranged, { agreement: added, baseline: ranged.agreement, final: 130000, landed: 'inside' })))).toHaveLength(1);
    expect(rows(await addClose(closeOf(priced, { ...SINGLE, final: 130000, landed: 'above' })))).toHaveLength(1);
    expect(await h.admin`SELECT job_id::text AS job, price_mode AS mode, baseline_low_cents::int AS low, baseline_high_cents::int AS high, landed FROM job_closes ORDER BY price_mode`).toEqual([
      { job: ranged.job, mode: 'range', low: 110000, high: 140000, landed: 'inside' },
      { job: priced.job, mode: 'single', low: 125000, high: null, landed: 'above' },
    ]);
  });
});

describe('migration 0020: estimate_history', () => {
  it('keeps one insert-only sample per agreement of its own job, with its optional figures when the record has them', async () => {
    const s = await signedJob();
    expect(rows(await addSample({ job: s.job, agreement: s.agreement }))).toHaveLength(1);
    expect(await refusal(addSample({ job: s.job, agreement: s.agreement, low: 1 }))).toMatchObject({ code: UNIQUE_VIOLATION, constraint: 'estimate_history_pkey' });
    // A change order's sample sits beside the original's; an older record with no optional figures is kept.
    const added = await changeOrder(s);
    expect(rows(await addSample({ job: s.job, agreement: added, ...CHANGED, laborMaterial: null, categories: null, days: null, area: null }))).toHaveLength(1);
    expect(await h.admin`SELECT agreement_id::text AS agreement, room_categories AS categories, area_sf::text AS area FROM estimate_history ORDER BY low_cents, agreement_id`).toEqual(
      expect.arrayContaining([
        { agreement: s.agreement, categories: ['2', 'mold'], area: '412.50' },
        { agreement: added, categories: null, area: null },
      ]),
    );
    expect(await errorCode(as(h.seed.a, (tx) => tx.execute(sql`UPDATE estimate_history SET low_cents = 1`)))).toBe(INSUFFICIENT_PRIVILEGE);

    const other = await signedJob();
    const b = await signedJob(h.seed.b);
    expect(await refusal(addSample({ job: s.job, agreement: other.agreement }))).toMatchObject({ code: FOREIGN_KEY_VIOLATION, constraint: 'estimate_history_agreement_fkey' });
    expect(await refusal(addSample({ job: b.job, agreement: b.agreement }))).toMatchObject({ code: FOREIGN_KEY_VIOLATION });

    const refused = async (extra: Partial<Sample>) => (await refusal(addSample({ job: other.job, agreement: other.agreement, ...extra })))?.constraint;
    expect(await refused({ mode: 'single' })).toBe('estimate_history_mode_check');
    expect(await refused({ low: 150000, high: 140000 })).toBe('estimate_history_high_cents_check');
    expect(await refused({ low: -1 })).toBe('estimate_history_low_cents_check');
    expect(await refused({ categories: ['mold', '2'] })).toBe('estimate_history_room_categories_check');
    expect(await refused({ categories: ['2', '2'] })).toBe('estimate_history_room_categories_check');
    expect(await refused({ categories: ['4'] })).toBe('estimate_history_room_categories_check');
    expect(await refused({ categories: [] })).toBe('estimate_history_room_categories_check');
    expect(await refused({ days: 0 })).toBe('estimate_history_planned_days_check');
    expect(await refused({ area: '-1' })).toBe('estimate_history_area_sf_check');
    // A cents figure above 2^53 - 1 is refused, in each of the three cents columns.
    expect(await refused({ low: 9007199254740992, high: null, mode: 'single' })).toBe('estimate_history_low_cents_check');
    expect(await refused({ low: 1, high: 9007199254740992 })).toBe('estimate_history_high_cents_check');
    expect(await refused({ laborMaterial: 9007199254740992 })).toBe('estimate_history_labor_material_low_cents_check');
  });

  it('keeps the signed area at the precision the field form took it, and every cents figure up to 2^53 - 1 exactly, as the typed schema reads them', async () => {
    const precise = await signedJob();
    const largest = await signedJob();
    expect(rows(await addSample({ job: precise.job, agreement: precise.agreement, area: '125.125' }))).toHaveLength(1);
    expect(rows(await addSample({ job: largest.job, agreement: largest.agreement, low: 9007199254740991, high: 9007199254740991, laborMaterial: 9007199254740991, area: '1.005' }))).toHaveLength(1);
    expect(await h.admin`SELECT area_sf::text AS area FROM estimate_history WHERE job_id = ${precise.job}`).toEqual([{ area: '125.125' }]);

    // The typed view reads the figure back exactly, and db.query sees the three tables.
    const [typed] = await as(h.seed.a, (tx) => tx.select().from(estimateHistory).where(eq(estimateHistory.jobId, largest.job)));
    expect(typed).toMatchObject({ lowCents: Number.MAX_SAFE_INTEGER, highCents: Number.MAX_SAFE_INTEGER, laborMaterialLowCents: Number.MAX_SAFE_INTEGER, areaSf: '1.005' });
    expect(Number.isSafeInteger(typed!.lowCents)).toBe(true);
    const [queried] = await as(h.seed.a, (tx) => tx.query.estimateHistory.findMany({ where: eq(estimateHistory.jobId, largest.job) }));
    expect(queried).toEqual(typed);
    expect(await as(h.seed.a, (tx) => tx.query.dryingReadings.findMany())).toEqual([]);
    expect(await as(h.seed.a, (tx) => tx.query.jobCloses.findMany())).toEqual([]);
  });
});

describe('migration 0020: the drying watch on job_coordination', () => {
  it('makes the coordination row at revision 0 on the first action, stamps each receipt’s time, and keeps the office versions and the field revision apart', async () => {
    const s = await signedJob();
    const field = await fieldRevisionOf(s.job);
    await act(s, receiptOf(s));
    const made = await coordinationOf(s.job);
    expect(made).toMatchObject({ revision: 0, notes: '', watch: { revision: 1 } });
    expect(await fieldRevisionOf(s.job)).toBe(field);
    expect(made.watch!.receipts[0]!.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);

    // An office change leaves the watch; a watch change leaves the notes, the coordination revision and its time.
    await as(h.seed.a, (tx) => tx.execute(sql`UPDATE job_coordination SET office_notes = 'Gate code 4411', revision = revision + 1, updated_at = now() WHERE job_id = ${s.job}::uuid`));
    const office = await coordinationOf(s.job);
    expect(office).toMatchObject({ revision: 1, notes: 'Gate code 4411', watch: made.watch });
    const afterOffice = await fieldRevisionOf(s.job);
    expect(afterOffice).toBeGreaterThan(field);
    await act(s, receiptOf(s, 'extend'));
    const watched = await coordinationOf(s.job);
    expect(watched).toMatchObject({ revision: 1, notes: 'Gate code 4411', updated: office.updated, watch: { revision: 2 } });
    expect(await fieldRevisionOf(s.job)).toBe(afterOffice);
    expect(watched.watch!.receipts[0]).toEqual(made.watch!.receipts[0]);

    // A watch on a job that already has office notes: the row is kept and only the watch is set.
    const noted = await signedJob();
    await as(h.seed.a, (tx) => tx.execute(sql`INSERT INTO job_coordination (company_id, job_id, office_notes) VALUES (${h.seed.a}::uuid, ${noted.job}::uuid, 'Call first')`));
    await act(noted, receiptOf(noted, 'mark_dry'));
    expect(await coordinationOf(noted.job)).toMatchObject({ revision: 1, notes: 'Call first', watch: { revision: 1, receipts: [expect.objectContaining({ action: 'mark_dry' })] } });
  });

  it('leaves an office save opened before the first watch action standing: it still succeeds, moves the revision to 1 and raises the field revision', async () => {
    const s = await signedJob();
    const owner = { companyId: s.company, actorId: h.seed.ownerA.actor, uid: 'owner-a', role: 'owner' as const, capabilities: capabilitiesFor('owner', { priceBooks: false }) };
    // The office screen opens with no coordination row: revision 0.
    expect((await h.jobs.coordination(owner, s.job)).revision).toBe(0);
    const field = await fieldRevisionOf(s.job);
    // The first watch action lands before the office saves.
    await act(s, receiptOf(s));
    expect(await fieldRevisionOf(s.job)).toBe(field);
    expect((await h.jobs.coordination(owner, s.job)).revision).toBe(0);
    // The save, still expecting revision 0, is not stale.
    const saved = await h.jobs.saveCoordination(owner, s.job, { changeId: randomUUID(), revision: 0, notes: 'Gate code 4411' });
    expect(saved).toMatchObject({ revision: 1, notes: 'Gate code 4411' });
    expect(await coordinationOf(s.job)).toMatchObject({ revision: 1, notes: 'Gate code 4411', watch: { revision: 1 } });
    expect(await fieldRevisionOf(s.job)).toBeGreaterThan(field);
  });

  it('lets the first office save and the first watch action of a job overlap with no deadlock', async () => {
    const s = await signedJob();
    const field = await fieldRevisionOf(s.job);
    // The watch waits for the job lock rather than claiming the coordination key first.
    await overlapOfficeAndWatch(
      s,
      (tx) => tx.execute(sql`INSERT INTO job_coordination (company_id, job_id, office_notes, revision) VALUES (${s.company}::uuid, ${s.job}::uuid, 'Gate code 4411', 1)`),
      () => act(s, receiptOf(s)),
      (pid) => waitUntil(() => isWaitingOn(pid), 'the watch waiting for the office save'),
    );
    expect(await coordinationOf(s.job)).toMatchObject({ revision: 1, notes: 'Gate code 4411', watch: { revision: 1, receipts: [expect.objectContaining({ action: 'extend' })] } });
    expect(await fieldRevisionOf(s.job)).toBeGreaterThan(field);
  });

  it('lets an office save that holds the job lock and a watch update of the existing coordination row overlap with no deadlock', async () => {
    const s = await signedJob();
    await act(s, receiptOf(s));
    const field = await fieldRevisionOf(s.job);
    const next = { revision: 2, receipts: [...(await coordinationOf(s.job)).watch!.receipts, receiptOf(s, 'extend')] };
    // The watch's direct update locks the coordination row first; it must not wait for the job lock the office save holds
    // while the save waits for that row. It either finishes or waits, and the save then goes on.
    let settled = false;
    await overlapOfficeAndWatch(
      s,
      (tx) => tx.execute(sql`UPDATE job_coordination SET office_notes = 'Gate code 4411', revision = revision + 1, updated_at = now() WHERE company_id = ${s.company}::uuid AND job_id = ${s.job}::uuid`),
      () =>
        as(s.company, (tx) =>
          tx.execute(sql`UPDATE job_coordination SET drying_watch = ${json(next)}::text::jsonb WHERE company_id = ${s.company}::uuid AND job_id = ${s.job}::uuid RETURNING job_id::text`),
        ),
      (pid, watch) => {
        void watch.then(
          () => (settled = true),
          () => (settled = true),
        );
        return waitUntil(async () => settled || (await isWaitingOn(pid)), 'the watch update to finish or wait');
      },
    );
    expect(await coordinationOf(s.job)).toMatchObject({ revision: 1, notes: 'Gate code 4411', watch: { revision: 2 } });
    expect(await fieldRevisionOf(s.job)).toBeGreaterThan(field);
  });

  it('adds exactly one receipt per change, keeps the earlier ones, and takes nothing after a closing action', async () => {
    const s = await signedJob();
    const first = receiptOf(s);
    await act(s, first);
    const [stored] = (await coordinationOf(s.job)).watch!.receipts;
    // The guard's own refusals, on an update of the row (an insert's conflict runs the row's checks first).
    const message = async (watch: unknown) =>
      (await refusal(as(h.seed.a, (tx) => tx.execute(sql`UPDATE job_coordination SET drying_watch = ${json(watch)}::text::jsonb WHERE job_id = ${s.job}::uuid`))))?.message;
    expect(await refusal(writeWatch(s, { revision: 3, receipts: [stored, receiptOf(s), receiptOf(s)] }))).toMatchObject({ code: CHECK_VIOLATION });
    // Two receipts at once, an earlier receipt changed or dropped, the watch removed.
    expect(await message({ revision: 3, receipts: [stored, receiptOf(s), receiptOf(s)] })).toBe('a drying watch change adds one receipt and keeps every earlier one');
    expect(await message({ revision: 2, receipts: [{ ...stored, reason: 'Rewritten' }, receiptOf(s)] })).toBe('a drying watch change adds one receipt and keeps every earlier one');
    expect(await message({ revision: 1, receipts: [receiptOf(s)] })).toBe('a drying watch change adds one receipt and keeps every earlier one');
    const removed = await refusal(as(h.seed.a, (tx) => tx.execute(sql`UPDATE job_coordination SET drying_watch = NULL WHERE job_id = ${s.job}::uuid`)));
    expect(removed?.message).toBe('a drying watch is never removed');
    expect(await message(null)).toBe('a drying watch holds its receipts');
    // The document's own checks: the revision is the number of receipts, the fields and their forms.
    const check = async (receipt: Receipt, revision = 2) => (await refusal(writeWatch(s, { revision, receipts: [stored, receipt] })))?.constraint;
    expect(await check(receiptOf(s), 3)).toBe('job_coordination_drying_watch_check');
    expect(await check(receiptOf(s, 'remind'))).toBe('job_coordination_drying_watch_check');
    expect(await check(receiptOf(s, 'extend', { reason: ' \t ' }))).toBe('job_coordination_drying_watch_check');
    expect(await check(receiptOf(s, 'extend', { reason: 'r'.repeat(501) }))).toBe('job_coordination_drying_watch_check');
    expect(await check(receiptOf(s, 'extend', { request_id: stored!.request_id }))).toBe('job_coordination_drying_watch_check');
    expect(await check(receiptOf(s, 'extend', { request_digest: 'not-a-digest' }))).toBe('job_coordination_drying_watch_check');
    expect(await check(receiptOf(s, 'extend', { facts: 'extra' }))).toBe('job_coordination_drying_watch_check');
    expect(await check(receiptOf(s, 'extend', { request_id: 'NOT-A-UUID' }))).toBe('job_coordination_drying_watch_check');

    // A time the writer sends is replaced by the database's.
    await act(s, receiptOf(s, 'extend', { at: '2020-01-01T00:00:00.000000Z' }));
    const sent = (await coordinationOf(s.job)).watch!.receipts[1]!;
    expect(Number(new Date(sent.at as string)) - Date.now()).toBeGreaterThan(-60_000);
    // A closing action ends it: nothing after Close monitoring (or Mark dry) is accepted.
    await act(s, receiptOf(s, 'close', { reason: 'Customer asked to stop monitoring' }));
    expect(await refusal(act(s, receiptOf(s)))).toMatchObject({ code: CHECK_VIOLATION });
    const closed = (await coordinationOf(s.job)).watch!;
    expect(await message({ revision: closed.revision + 1, receipts: [...closed.receipts, receiptOf(s)] })).toBe('the drying watch is closed');
    const dried = await signedJob();
    await act(dried, receiptOf(dried, 'mark_dry'));
    expect(await refusal(act(dried, receiptOf(dried, 'close')))).toMatchObject({ code: CHECK_VIOLATION });
    expect((await coordinationOf(s.job)).watch).toMatchObject({
      revision: 3,
      receipts: [expect.objectContaining({ action: 'extend' }), expect.objectContaining({ action: 'extend' }), expect.objectContaining({ action: 'close' })],
    });
  });

  it('takes a reason over several lines, and refuses a blank one', async () => {
    const s = await signedJob();
    await act(s, receiptOf(s, 'extend', { reason: 'Ceiling still wet\nRecheck Friday' }));
    await act(s, receiptOf(s, 'mark_dry', { reason: 'Dry at every point\r\n\tReadings logged' }));
    expect((await coordinationOf(s.job)).watch!.receipts.map((receipt) => receipt.reason)).toEqual(['Ceiling still wet\nRecheck Friday', 'Dry at every point\r\n\tReadings logged']);
    const blank = await signedJob();
    for (const reason of ['', ' \t ', '\n\n', ' \r\n \u00a0\u3000 ', 'bell\u0007']) {
      expect({ reason, found: (await refusal(act(blank, receiptOf(blank, 'extend', { reason }))))?.constraint }).toEqual({ reason, found: 'job_coordination_drying_watch_check' });
    }
  });

  it('holds up to 100 extensions and then one closing action', async () => {
    const s = await signedJob();
    for (let n = 0; n < 100; n += 1) await act(s, receiptOf(s));
    expect(await refusal(act(s, receiptOf(s)))).toMatchObject({ code: CHECK_VIOLATION, constraint: 'job_coordination_drying_watch_check' });
    await act(s, receiptOf(s, 'close'));
    expect((await coordinationOf(s.job)).watch!.revision).toBe(101);
  });

  it('names an agreement of its own job and an actor of its own company', async () => {
    const s = await signedJob();
    const other = await signedJob();
    const b = await signedJob(h.seed.b);
    const named = (field: string, value: string) => refusal(act(s, receiptOf(s, 'extend', { [field]: value })));
    expect(await named('agreement_id', other.agreement)).toMatchObject({ code: CHECK_VIOLATION, message: 'a drying watch receipt names an agreement of its job' });
    expect(await named('agreement_id', b.agreement)).toMatchObject({ code: CHECK_VIOLATION, message: 'a drying watch receipt names an agreement of its job' });
    expect(await named('agreement_id', 'not-an-id')).toMatchObject({ code: CHECK_VIOLATION, message: 'a drying watch receipt names an agreement of its job' });
    expect(await named('actor_id', h.seed.ownerB.actor)).toMatchObject({ code: CHECK_VIOLATION, message: 'a drying watch receipt names an actor of its company' });
    // A job that is not signed has no agreement to name.
    const unsigned = await seedJob(h.admin, newJob(h.seed.a, h.seed.ownerA.actor));
    expect(await refusal(act({ ...s, job: unsigned.id }, receiptOf(s)))).toMatchObject({ code: CHECK_VIOLATION, message: 'a drying watch receipt names an agreement of its job' });
    expect(await h.admin`SELECT count(*)::int AS n FROM job_coordination WHERE drying_watch IS NOT NULL`).toEqual([{ n: 0 }]);
  });
});
