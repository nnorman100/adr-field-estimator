import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  aiLedger,
  aiResults,
  companyAiSettings,
  memberVoiceSettings,
  voiceNotes,
} from '@/db/ai-schema';
import { openDatabase } from '@/db/client';
import { withCompany, withOperator, type CompanyTransaction } from '@/db/tenant';
import { unprotectedRelations } from './row-security-guard';
import {
  CHECK_VIOLATION,
  FOREIGN_KEY_VIOLATION,
  INSUFFICIENT_PRIVILEGE,
  READ_ONLY_TRANSACTION,
  UNIQUE_VIOLATION,
  errorCode,
  newJob,
  ownerOf,
  seedJob,
} from './job-harness';
import {
  insertLedger,
  insertResult,
  insertVoiceNote,
  newVoiceNote,
  seedLedger,
} from './ai-harness';
import { refusal } from './submission-harness';
import { everything, resetTeamDatabase, startTeamServer, type Harness } from './team-harness';

// S7-3: the AI settings, ledger, results, voice-note and voice-choice tables (migration 0012), as the
// app's runtime role on a server set up like a fresh Cloud SQL instance (see team-harness.ts). No route
// uses them yet, so these tests write and read through withCompany and withOperator as S7-4 to S7-15
// will. Who sets ceilings and voices is ai-settings.test.ts; the Live tables and the sweeper's lookup
// are live-tables.test.ts.
const AI_TABLES = [
  'ai_ledger',
  'ai_results',
  'company_ai_settings',
  'member_voice_settings',
  'voice_notes',
];

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

const as = <T>(company: string, run: (tx: CompanyTransaction) => Promise<T>) =>
  withCompany(pool.db, company, run);
const asOperator = <T>(
  run: (tx: CompanyTransaction) => Promise<T>,
  readOnly = false,
  company?: string,
) => withOperator(h.handle.db, h.seed.operator, run, { companyId: company ?? h.seed.a, readOnly });
const rows = <T>(result: unknown) => result as unknown as T[];
type Write = (tx: CompanyTransaction) => Promise<unknown>;
const sqlOf = (text: string) => sql.raw(text);
const jobOf = (company: string) => seedJob(h.admin, newJob(company, ownerOf(h, company)));

// Every AI row of one company, as the table owner sees them.
async function companyRows(company: string): Promise<string> {
  const dump: Record<string, unknown> = {};
  for (const table of AI_TABLES)
    dump[table] = await h.admin.unsafe(
      `SELECT * FROM ${table} WHERE company_id = $1 ORDER BY 1, 2`,
      [company],
    );
  return JSON.stringify(dump);
}

// One row of every AI table for a company, written as the table owner.
async function seedAll(company: string, actor: string) {
  const job = await jobOf(company);
  const ledger = await seedLedger(h.admin, { company, actor });
  const [result] = await h.admin<{ id: string }[]>`
    INSERT INTO ai_results (company_id, call_id, job_id, draft_id, actor_id, feature, input_digest, prompt_version, model, output, verdict_category)
    VALUES (${company}, ${ledger.callId}, ${job.id}, ${job.draft}, ${actor}, 'summary_draft', ${'a'.repeat(64)}, ${'b'.repeat(64)}, 'gemini-3.8-flash',
            '{"summary":"seeded"}'::jsonb, 'passed')
    RETURNING id::text
  `;
  const note = randomUUID();
  await h.admin`
    INSERT INTO voice_notes (id, company_id, job_id, draft_id, actor_id, duration_ms, audio_sha256, transcript)
    VALUES (${note}, ${company}, ${job.id}, ${job.draft}, ${actor}, 5000, ${'c'.repeat(64)}, 'seeded transcript')
  `;
  await h.admin`INSERT INTO company_ai_settings (company_id, default_voice, default_voice_set_by_actor_id) VALUES (${company}, 'Kore', ${actor})`;
  await h.admin`INSERT INTO member_voice_settings (company_id, actor_id, voice_name) VALUES (${company}, ${actor}, 'Puck')`;
  return { job, ledger, result: result!.id, note };
}

describe('migration 0012: the AI tables', () => {
  it('passes the row-level security guard: every table is forced and has policies', async () => {
    expect(await unprotectedRelations(h.admin)).toEqual([]);
    const found = await h.admin<{ name: string; enabled: boolean; forced: boolean }[]>`
      SELECT c.relname AS name, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
      FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY(${AI_TABLES}) ORDER BY 1
    `;
    expect(found).toEqual(AI_TABLES.map((name) => ({ name, enabled: true, forced: true })));
  });

  it('gives the runtime no DELETE or TRUNCATE, and UPDATE of named columns only', async () => {
    const tableLevel = await h.admin<{ table: string; privilege: string }[]>`
      SELECT table_name AS table, privilege_type AS privilege FROM information_schema.role_table_grants
      WHERE grantee = 'dryscope_runtime' AND table_name = ANY(${AI_TABLES}) ORDER BY 1, 2
    `;
    // The ledger, results and voice notes take a whole-row INSERT; the two settings tables only a
    // column-level one (below), so no table-level INSERT shows for them.
    expect(tableLevel).toEqual([
      { table: 'ai_ledger', privilege: 'INSERT' },
      { table: 'ai_ledger', privilege: 'SELECT' },
      { table: 'ai_results', privilege: 'INSERT' },
      { table: 'ai_results', privilege: 'SELECT' },
      { table: 'company_ai_settings', privilege: 'SELECT' },
      { table: 'member_voice_settings', privilege: 'SELECT' },
      { table: 'voice_notes', privilege: 'INSERT' },
      { table: 'voice_notes', privilege: 'SELECT' },
    ]);
    const updates = await h.admin<{ table: string; column: string }[]>`
      SELECT table_name AS table, column_name AS column FROM information_schema.column_privileges
      WHERE grantee = 'dryscope_runtime' AND table_name = ANY(${AI_TABLES}) AND privilege_type = 'UPDATE' ORDER BY 1, 2
    `;
    expect(updates).toEqual([
      { table: 'ai_ledger', column: 'settled_micro_usd' },
      { table: 'ai_ledger', column: 'state' },
      { table: 'ai_results', column: 'decided_by_actor_id' },
      { table: 'ai_results', column: 'status' },
      { table: 'company_ai_settings', column: 'ceilings_set_by_operator_id' },
      { table: 'company_ai_settings', column: 'daily_ceiling_micro_usd' },
      { table: 'company_ai_settings', column: 'default_voice' },
      { table: 'company_ai_settings', column: 'default_voice_set_by_actor_id' },
      { table: 'company_ai_settings', column: 'monthly_ceiling_micro_usd' },
      { table: 'member_voice_settings', column: 'voice_name' },
      { table: 'voice_notes', column: 'reviewed_by_actor_id' },
      { table: 'voice_notes', column: 'state' },
      { table: 'voice_notes', column: 'transcript' },
    ]);
  });

  it('works through the Drizzle view the routes will use', async () => {
    const seeded = await seedAll(h.seed.a, h.seed.ownerA.actor);
    const read = await as(h.seed.a, async (tx) => ({
      ledger: (await tx.select().from(aiLedger))[0],
      result: (await tx.select().from(aiResults))[0],
      note: (await tx.select().from(voiceNotes))[0],
      settings: (await tx.select().from(companyAiSettings))[0],
      voice: (await tx.select().from(memberVoiceSettings))[0],
    }));
    expect(read.ledger).toMatchObject({
      id: seeded.ledger.id,
      callId: seeded.ledger.callId,
      state: 'reserved',
      reservedMicroUsd: 20_000,
      settledMicroUsd: null,
    });
    expect(typeof read.ledger?.utcDay).toBe('string');
    expect(read.result).toMatchObject({
      id: seeded.result,
      status: 'proposed',
      output: { summary: 'seeded' },
      decidedAt: null,
    });
    expect(read.note).toMatchObject({
      id: seeded.note,
      state: 'transcribed',
      durationMs: 5000,
      transcript: 'seeded transcript',
    });
    expect(read.settings).toMatchObject({
      companyId: h.seed.a,
      dailyCeilingMicroUsd: null,
      monthlyCeilingMicroUsd: null,
      defaultVoice: 'Kore',
    });
    expect(read.voice).toMatchObject({ actorId: h.seed.ownerA.actor, voiceName: 'Puck' });
  });
});

describe('isolation between companies (AI tables)', () => {
  it('shows company B none of company A’s rows, and B’s writes reach none of them', async () => {
    await seedAll(h.seed.a, h.seed.ownerA.actor);
    const mine = await seedAll(h.seed.b, h.seed.ownerB.actor);
    const before = await companyRows(h.seed.a);
    // The database context holds the company only, never the person or role, so this one check is
    // what every role of company B sees; which role may call what is the routes' (S7-4 onward).
    const seen = await as(h.seed.b, async (tx) => {
      const counts: Record<string, string[]> = {};
      for (const table of AI_TABLES)
        counts[table] = rows<{ c: string }>(
          await tx.execute(sqlOf(`SELECT DISTINCT company_id::text AS c FROM ${table}`)),
        ).map((row) => row.c);
      return counts;
    });
    expect(seen).toEqual(Object.fromEntries(AI_TABLES.map((table) => [table, [h.seed.b]])));
    const changed = await as(h.seed.b, async (tx) => [
      rows(
        await tx.execute(sql`UPDATE ai_ledger SET state = 'held' RETURNING company_id::text AS c`),
      ),
      rows(
        await tx.execute(
          sql`UPDATE ai_results SET status = 'rejected', decided_by_actor_id = ${h.seed.ownerB.actor}::uuid RETURNING company_id::text AS c`,
        ),
      ),
      rows(
        await tx.execute(
          sql`UPDATE voice_notes SET state = 'rejected' RETURNING company_id::text AS c`,
        ),
      ),
      rows(
        await tx.execute(
          sql`UPDATE company_ai_settings SET default_voice = 'Puck' RETURNING company_id::text AS c`,
        ),
      ),
      rows(
        await tx.execute(
          sql`UPDATE member_voice_settings SET voice_name = 'Kore' RETURNING company_id::text AS c`,
        ),
      ),
    ]);
    for (const reached of changed) expect(reached).toEqual([{ c: h.seed.b }]);
    expect(await companyRows(h.seed.a)).toBe(before);
    expect(mine.ledger.id).toBeTruthy();
    expect(await pool.db.execute(sql`SELECT * FROM ai_ledger`)).toHaveLength(0);
  });

  it('refuses a row written for another company, or naming another company’s job, person or call', async () => {
    const jobA = await jobOf(h.seed.a);
    const jobB = await jobOf(h.seed.b);
    const ledgerA = await seedLedger(h.admin, { company: h.seed.a, actor: h.seed.ownerA.actor });
    // For company A, from company B: the policy refuses.
    const forA: Write[] = [
      (tx: CompanyTransaction) =>
        insertLedger(tx, { company: h.seed.a, actor: h.seed.ownerA.actor }),
      (tx: CompanyTransaction) =>
        insertResult(tx, {
          company: h.seed.a,
          job: jobA.id,
          actor: h.seed.ownerA.actor,
          callId: ledgerA.callId,
        }),
      (tx: CompanyTransaction) =>
        insertVoiceNote(tx, newVoiceNote(h.seed.a, jobA.id, h.seed.ownerA.actor)),
      (tx: CompanyTransaction) =>
        tx.execute(
          sql`INSERT INTO member_voice_settings (company_id, actor_id, voice_name) VALUES (${h.seed.a}::uuid, ${h.seed.ownerA.actor}::uuid, 'Puck')`,
        ),
      (tx: CompanyTransaction) =>
        tx.execute(
          sql`INSERT INTO company_ai_settings (company_id, default_voice, default_voice_set_by_actor_id) VALUES (${h.seed.a}::uuid, 'Puck', ${h.seed.ownerA.actor}::uuid)`,
        ),
    ];
    for (const write of forA)
      expect(await errorCode(as(h.seed.b, write))).toBe(INSUFFICIENT_PRIVILEGE);
    // In company B's own name but pointing at company A's records: the composite keys refuse.
    const ledgerB = await seedLedger(h.admin, { company: h.seed.b, actor: h.seed.ownerB.actor });
    for (const [name, write] of [
      [
        'ledger person',
        (tx: CompanyTransaction) =>
          insertLedger(tx, { company: h.seed.b, actor: h.seed.ownerA.actor }),
      ],
      [
        'result job',
        (tx: CompanyTransaction) =>
          insertResult(tx, {
            company: h.seed.b,
            job: jobA.id,
            actor: h.seed.ownerB.actor,
            callId: ledgerB.callId,
          }),
      ],
      [
        'result call',
        (tx: CompanyTransaction) =>
          insertResult(tx, {
            company: h.seed.b,
            job: jobB.id,
            actor: h.seed.ownerB.actor,
            callId: ledgerA.callId,
          }),
      ],
      [
        'note job',
        (tx: CompanyTransaction) =>
          insertVoiceNote(tx, newVoiceNote(h.seed.b, jobA.id, h.seed.ownerB.actor)),
      ],
      [
        'note person',
        (tx: CompanyTransaction) =>
          insertVoiceNote(tx, newVoiceNote(h.seed.b, jobB.id, h.seed.ownerA.actor)),
      ],
      [
        'voice person',
        (tx: CompanyTransaction) =>
          tx.execute(
            sql`INSERT INTO member_voice_settings (company_id, actor_id, voice_name) VALUES (${h.seed.b}::uuid, ${h.seed.ownerA.actor}::uuid, 'Puck')`,
          ),
      ],
    ] as [string, Write][]) {
      expect({ name, code: await errorCode(as(h.seed.b, write)) }).toEqual({
        name,
        code: FOREIGN_KEY_VIOLATION,
      });
    }
    expect(
      await as(h.seed.b, (tx) =>
        insertResult(tx, {
          company: h.seed.b,
          job: jobB.id,
          actor: h.seed.ownerB.actor,
          callId: ledgerB.callId,
        }),
      ),
    ).toHaveLength(1);
  });

  it('lets two companies use the same call id and voice-note id', async () => {
    const callId = randomUUID();
    await as(h.seed.a, (tx) =>
      insertLedger(tx, { company: h.seed.a, actor: h.seed.ownerA.actor, callId }),
    );
    expect(
      await as(h.seed.b, (tx) =>
        insertLedger(tx, { company: h.seed.b, actor: h.seed.ownerB.actor, callId }),
      ),
    ).toHaveLength(1);
    const id = randomUUID();
    await as(h.seed.a, async (tx) =>
      insertVoiceNote(
        tx,
        newVoiceNote(h.seed.a, (await jobOf(h.seed.a)).id, h.seed.ownerA.actor, { id }),
      ),
    );
    const jobB = await jobOf(h.seed.b);
    expect(
      await as(h.seed.b, (tx) =>
        insertVoiceNote(tx, newVoiceNote(h.seed.b, jobB.id, h.seed.ownerB.actor, { id })),
      ),
    ).toHaveLength(1);
  });
});

describe('nothing is removed from the AI tables', () => {
  it('refuses every delete and truncate as the runtime', async () => {
    await seedAll(h.seed.a, h.seed.ownerA.actor);
    const before = await everything(h.admin);
    for (const table of AI_TABLES) {
      for (const statement of [`DELETE FROM ${table}`, `TRUNCATE ${table}`]) {
        expect({
          statement,
          code: await errorCode(as(h.seed.a, (tx) => tx.execute(sqlOf(statement)))),
        }).toEqual({ statement, code: INSUFFICIENT_PRIVILEGE });
      }
    }
    expect(await everything(h.admin)).toBe(before);
  });

  it('never lets the runtime change a row’s identity, a result’s output or a ledger row’s reservation', async () => {
    await seedAll(h.seed.a, h.seed.ownerA.actor);
    const before = await everything(h.admin);
    const frozen: Record<string, string[]> = {
      ai_ledger: [
        'id',
        'company_id',
        'call_id',
        'actor_id',
        'feature',
        'model',
        'reserved_micro_usd',
        'utc_day',
        'utc_month',
        'created_at',
        'settled_at',
      ],
      ai_results: [
        'id',
        'company_id',
        'call_id',
        'job_id',
        'draft_id',
        'actor_id',
        'feature',
        'input_digest',
        'prompt_version',
        'model',
        'output',
        'verdict_category',
        'created_at',
        'decided_at',
      ],
      voice_notes: [
        'id',
        'company_id',
        'job_id',
        'draft_id',
        'actor_id',
        'duration_ms',
        'audio_sha256',
        'created_at',
        'reviewed_at',
      ],
      company_ai_settings: ['company_id', 'ceilings_set_at', 'default_voice_set_at'],
      member_voice_settings: ['company_id', 'actor_id', 'updated_at'],
    };
    for (const [table, columns] of Object.entries(frozen)) {
      for (const column of columns) {
        const statement = `UPDATE ${table} SET ${column} = ${column}`;
        expect({
          statement,
          code: await errorCode(as(h.seed.a, (tx) => tx.execute(sqlOf(statement)))),
        }).toEqual({ statement, code: INSUFFICIENT_PRIVILEGE });
      }
    }
    expect(await everything(h.admin)).toBe(before);
  });

  it('binds the migrator that owns the tables by forced row-level security', async () => {
    await seedAll(h.seed.a, h.seed.ownerA.actor);
    const before = await everything(h.admin);
    const owner = postgres(h.migratorUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
    try {
      for (const table of AI_TABLES) {
        expect({ table, rows: await owner.unsafe(`SELECT * FROM ${table}`) }).toEqual({
          table,
          rows: [],
        });
        expect({ table, count: (await owner.unsafe(`DELETE FROM ${table}`)).count }).toEqual({
          table,
          count: 0,
        });
      }
    } finally {
      await owner.end({ timeout: 5 });
    }
    expect(await everything(h.admin)).toBe(before);
  });
});

describe('the spend ledger', () => {
  const state = async (id: string) =>
    (
      await h.admin<{ state: string; settled: string | null; at: boolean }[]>`
      SELECT state, settled_micro_usd::text AS settled, settled_at IS NOT NULL AS at FROM ai_ledger WHERE id = ${id}
    `
    )[0];
  const set = (company: string, id: string, change: ReturnType<typeof sql>) =>
    as(company, async (tx) =>
      rows<{ state: string }>(
        await tx.execute(
          sql`UPDATE ai_ledger SET ${change} WHERE id = ${id}::uuid RETURNING state`,
        ),
      ),
    );

  it('starts reserved, with no settled amount, and only as reserved', async () => {
    const [row] = await as(h.seed.a, (tx) =>
      insertLedger(tx, { company: h.seed.a, actor: h.seed.ownerA.actor }),
    );
    expect(row).toMatchObject({ state: 'reserved' });
    expect(await state(row!.id)).toEqual({ state: 'reserved', settled: null, at: false });
    for (const start of [`'settled'`, `'held'`]) {
      const found = await refusal(
        h.admin
          .unsafe(`INSERT INTO ai_ledger (company_id, call_id, actor_id, feature, model, reserved_micro_usd, utc_day, utc_month, state)
          VALUES ('${h.seed.a}', '${randomUUID()}', '${h.seed.ownerA.actor}', 'summary_draft', 'gemini-3.8-flash', 10, '2026-11-13', '2026-11-01', ${start})`),
      );
      expect({ start, found }).toMatchObject({
        found: { code: CHECK_VIOLATION, message: 'a ledger row starts reserved' },
      });
    }
  });

  it('holds one row per call id in a company, so a retried reservation finds its row', async () => {
    const callId = randomUUID();
    await as(h.seed.a, (tx) =>
      insertLedger(tx, { company: h.seed.a, actor: h.seed.ownerA.actor, callId }),
    );
    expect(
      await refusal(
        as(h.seed.a, (tx) =>
          insertLedger(tx, { company: h.seed.a, actor: h.seed.ownerA.actor, callId }),
        ),
      ),
    ).toMatchObject({
      code: UNIQUE_VIOLATION,
      constraint: 'ai_ledger_company_call_key',
    });
  });

  it('keeps amounts whole and non-negative, and the month the first day of the row’s UTC day', async () => {
    const make = (extra: Parameters<typeof insertLedger>[1]) =>
      errorCode(as(h.seed.a, (tx) => insertLedger(tx, extra)));
    const actor = h.seed.ownerA.actor;
    expect(await make({ company: h.seed.a, actor, reserved: -1 })).toBe(CHECK_VIOLATION);
    expect(await make({ company: h.seed.a, actor, reserved: Number.MAX_SAFE_INTEGER + 1 })).toBe(
      CHECK_VIOLATION,
    );
    expect(await make({ company: h.seed.a, actor, day: '2026-11-13', month: '2026-12-01' })).toBe(
      CHECK_VIOLATION,
    );
    expect(await make({ company: h.seed.a, actor, day: '2026-11-13', month: '2026-11-13' })).toBe(
      CHECK_VIOLATION,
    );
    expect(await make({ company: h.seed.a, actor, feature: 'Not A Feature' })).toBe(
      CHECK_VIOLATION,
    );
    expect(await make({ company: h.seed.a, actor, model: '' })).toBe(CHECK_VIOLATION);
    expect(
      await make({ company: h.seed.a, actor, reserved: 0, day: '2026-12-31', month: '2026-12-01' }),
    ).toBeUndefined();
    expect(
      await make({
        company: h.seed.a,
        actor,
        reserved: Number.MAX_SAFE_INTEGER,
        feature: 'live',
        model: 'gemini-3.8-live',
      }),
    ).toBeUndefined();
  });

  it('settles a reservation once with its real cost, taking the time from the clock, and a second settle finds no row', async () => {
    const { id } = await seedLedger(h.admin, {
      company: h.seed.a,
      actor: h.seed.ownerA.actor,
      reserved: 50_000,
    });
    // The real cost may be below or above what was reserved.
    expect(await set(h.seed.a, id, sql`state = 'settled', settled_micro_usd = 61000`)).toEqual([
      { state: 'settled' },
    ]);
    expect(await state(id)).toEqual({ state: 'settled', settled: '61000', at: true });
    const again = await as(h.seed.a, async (tx) =>
      rows(
        await tx.execute(
          sql`UPDATE ai_ledger SET state = 'settled', settled_micro_usd = 1 WHERE id = ${id}::uuid AND state <> 'settled' RETURNING 1`,
        ),
      ),
    );
    expect(again).toEqual([]);
    expect(await state(id)).toEqual({ state: 'settled', settled: '61000', at: true });
  });

  it('holds a reservation whose outcome is unknown, and settles it later', async () => {
    const { id } = await seedLedger(h.admin, { company: h.seed.a, actor: h.seed.ownerA.actor });
    expect(await set(h.seed.a, id, sql`state = 'held'`)).toEqual([{ state: 'held' }]);
    expect(await state(id)).toEqual({ state: 'held', settled: null, at: false });
    expect(await set(h.seed.a, id, sql`state = 'settled', settled_micro_usd = 0`)).toEqual([
      { state: 'settled' },
    ]);
    expect(await state(id)).toMatchObject({ state: 'settled', settled: '0' });
  });

  it('refuses a settlement without an amount, an amount before settling, and any change once settled', async () => {
    const { id } = await seedLedger(h.admin, { company: h.seed.a, actor: h.seed.ownerA.actor });
    expect(await errorCode(set(h.seed.a, id, sql`state = 'settled'`))).toBe(CHECK_VIOLATION);
    expect(await errorCode(set(h.seed.a, id, sql`settled_micro_usd = 5`))).toBe(CHECK_VIOLATION);
    expect(await errorCode(set(h.seed.a, id, sql`state = 'settled', settled_micro_usd = -5`))).toBe(
      CHECK_VIOLATION,
    );
    await set(h.seed.a, id, sql`state = 'held'`);
    expect(await refusal(set(h.seed.a, id, sql`state = 'reserved'`))).toMatchObject({
      code: CHECK_VIOLATION,
      message: 'a held ledger row can only be settled',
    });
    await set(h.seed.a, id, sql`state = 'settled', settled_micro_usd = 7`);
    for (const change of [
      sql`state = 'held'`,
      sql`state = 'reserved', settled_micro_usd = NULL`,
      sql`settled_micro_usd = 8`,
    ]) {
      expect(await refusal(set(h.seed.a, id, change))).toMatchObject({
        code: CHECK_VIOLATION,
        message: 'a settled ledger row cannot change',
      });
    }
    // Not even the superuser, whom no policy or column right binds, changes a settled row.
    for (const change of [
      `reserved_micro_usd = 1`,
      `settled_at = now() + interval '1 day'`,
      `utc_day = '2026-01-01', utc_month = '2026-01-01'`,
    ]) {
      expect(
        await refusal(h.admin.unsafe(`UPDATE ai_ledger SET ${change} WHERE id = '${id}'`)),
      ).toMatchObject({ code: CHECK_VIOLATION });
    }
    expect(await state(id)).toEqual({ state: 'settled', settled: '7', at: true });
  });
});

describe('AI results', () => {
  let job: Awaited<ReturnType<typeof jobOf>>;
  let callId: string;

  beforeEach(async () => {
    job = await jobOf(h.seed.a);
    callId = (await seedLedger(h.admin, { company: h.seed.a, actor: h.seed.estimatorA.actor }))
      .callId;
  });

  const decide = (id: string, status: string, by: string | null = h.seed.estimatorA.actor) =>
    as(h.seed.a, async (tx) =>
      rows<{ status: string; decided_at: string }>(
        await tx.execute(sql`
      UPDATE ai_results SET status = ${status}, decided_by_actor_id = ${by}::uuid WHERE id = ${id}::uuid AND status = 'proposed' RETURNING status, decided_at
    `),
      ),
    );

  it('stores a proposal for a budgeted call, one per call id, and never for a call the ledger does not hold', async () => {
    const [row] = await as(h.seed.a, (tx) =>
      insertResult(tx, { company: h.seed.a, job: job.id, actor: h.seed.estimatorA.actor, callId }),
    );
    expect(row).toMatchObject({ status: 'proposed' });
    expect(
      await refusal(
        as(h.seed.a, (tx) =>
          insertResult(tx, {
            company: h.seed.a,
            job: job.id,
            actor: h.seed.estimatorA.actor,
            callId,
          }),
        ),
      ),
    ).toMatchObject({
      code: UNIQUE_VIOLATION,
      constraint: 'ai_results_company_call_key',
    });
    expect(
      await refusal(
        as(h.seed.a, (tx) =>
          insertResult(tx, {
            company: h.seed.a,
            job: job.id,
            actor: h.seed.estimatorA.actor,
            callId: randomUUID(),
          }),
        ),
      ),
    ).toMatchObject({
      code: FOREIGN_KEY_VIOLATION,
      constraint: 'ai_results_call_fkey',
    });
  });

  it('is made only as a proposal, with its output a JSON object', async () => {
    const statement = (
      status: string,
    ) => `INSERT INTO ai_results (company_id, call_id, job_id, draft_id, actor_id, feature, input_digest, prompt_version, model, output, verdict_category, status, decided_by_actor_id)
      VALUES ('${h.seed.a}', '${callId}', '${job.id}', '${job.draft}', '${h.seed.estimatorA.actor}', 'summary_draft', '${'a'.repeat(64)}', '${'b'.repeat(64)}', 'gemini-3.8-flash', '{}', 'passed', '${status}', '${h.seed.estimatorA.actor}')`;
    for (const status of ['accepted', 'rejected']) {
      expect({ status, found: await refusal(h.admin.unsafe(statement(status))) }).toMatchObject({
        found: { code: CHECK_VIOLATION, message: 'an AI result starts proposed' },
      });
    }
    for (const output of [[1, 2], 'text', 3]) {
      expect(
        await errorCode(
          as(h.seed.a, (tx) =>
            insertResult(tx, {
              company: h.seed.a,
              job: job.id,
              actor: h.seed.estimatorA.actor,
              callId,
              output: output as unknown as Record<string, unknown>,
            }),
          ),
        ),
      ).toBe(CHECK_VIOLATION);
    }
  });

  it('is accepted or rejected once by a person, taking the time from the clock, and is frozen after', async () => {
    const [row] = await as(h.seed.a, (tx) =>
      insertResult(tx, { company: h.seed.a, job: job.id, actor: h.seed.estimatorA.actor, callId }),
    );
    expect(await errorCode(decide(row!.id, 'accepted', null))).toBe(CHECK_VIOLATION);
    const [done] = await decide(row!.id, 'accepted');
    expect(done).toMatchObject({ status: 'accepted' });
    expect(done!.decided_at).toBeTruthy();
    expect(await decide(row!.id, 'rejected')).toEqual([]);
    for (const change of [
      `status = 'rejected'`,
      `status = 'proposed', decided_by_actor_id = NULL`,
      `decided_by_actor_id = '${h.seed.ownerA.actor}'`,
      `output = '{"summary":"changed"}'`,
      `decided_at = now() + interval '1 day'`,
    ]) {
      expect({
        change,
        found: await refusal(
          h.admin.unsafe(`UPDATE ai_results SET ${change} WHERE id = '${row!.id}'`),
        ),
      }).toMatchObject({ found: { code: CHECK_VIOLATION } });
    }
    expect(await h.admin`SELECT status, output FROM ai_results WHERE id = ${row!.id}`).toEqual([
      { status: 'accepted', output: { summary: 'Water stain on the hallway ceiling.' } },
    ]);
  });

  it('never lets the output text change, even on a proposal and even as the superuser', async () => {
    const [row] = await as(h.seed.a, (tx) =>
      insertResult(tx, { company: h.seed.a, job: job.id, actor: h.seed.estimatorA.actor, callId }),
    );
    expect(
      await errorCode(
        as(h.seed.a, (tx) =>
          tx.execute(
            sql`UPDATE ai_results SET output = '{"summary":"edited"}'::jsonb WHERE id = ${row!.id}::uuid`,
          ),
        ),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(
      await refusal(
        h.admin.unsafe(
          `UPDATE ai_results SET output = '{"summary":"edited"}' WHERE id = '${row!.id}'`,
        ),
      ),
    ).toMatchObject({
      code: CHECK_VIOLATION,
      message: "an AI result's proposal cannot change",
    });
  });
});

describe('voice notes', () => {
  let job: Awaited<ReturnType<typeof jobOf>>;
  beforeEach(async () => {
    job = await jobOf(h.seed.a);
  });

  const review = (id: string, change: ReturnType<typeof sql>) =>
    as(h.seed.a, async (tx) =>
      rows<{ state: string; transcript: string }>(
        await tx.execute(
          sql`UPDATE voice_notes SET ${change} WHERE id = ${id}::uuid AND state = 'transcribed' RETURNING state, transcript`,
        ),
      ),
    );

  it('stores a transcript once per note id, at most ten minutes long', async () => {
    const note = newVoiceNote(h.seed.a, job.id, h.seed.estimatorA.actor);
    expect(await as(h.seed.a, (tx) => insertVoiceNote(tx, note))).toEqual([
      { id: note.id, state: 'transcribed' },
    ]);
    expect(await refusal(as(h.seed.a, (tx) => insertVoiceNote(tx, note)))).toMatchObject({
      code: UNIQUE_VIOLATION,
      constraint: 'voice_notes_pkey',
    });
    for (const extra of [
      { duration: 0 },
      { duration: 600_001 },
      { sha: 'A'.repeat(64) },
      { transcript: 'x'.repeat(20_001) },
    ]) {
      expect({
        extra,
        code: await errorCode(
          as(h.seed.a, (tx) =>
            insertVoiceNote(tx, newVoiceNote(h.seed.a, job.id, h.seed.estimatorA.actor, extra)),
          ),
        ),
      }).toEqual({ extra, code: CHECK_VIOLATION });
    }
    expect(
      await as(h.seed.a, (tx) =>
        insertVoiceNote(
          tx,
          newVoiceNote(h.seed.a, job.id, h.seed.estimatorA.actor, {
            duration: 600_000,
            transcript: '',
          }),
        ),
      ),
    ).toHaveLength(1);
  });

  it('is reviewed once, with the technician’s edit, and is frozen after; a rejection needs no person', async () => {
    const note = newVoiceNote(h.seed.a, job.id, h.seed.estimatorA.actor);
    await as(h.seed.a, (tx) => insertVoiceNote(tx, note));
    expect(await errorCode(review(note.id, sql`state = 'reviewed'`))).toBe(CHECK_VIOLATION);
    expect(await refusal(review(note.id, sql`transcript = 'edited before review'`))).toMatchObject({
      code: CHECK_VIOLATION,
      message: "a voice note's transcript changes only at its review",
    });
    expect(
      await review(
        note.id,
        sql`state = 'reviewed', transcript = 'Meter reads 28 percent.', reviewed_by_actor_id = ${h.seed.estimatorA.actor}::uuid`,
      ),
    ).toEqual([{ state: 'reviewed', transcript: 'Meter reads 28 percent.' }]);
    expect(
      await h.admin`SELECT reviewed_at IS NOT NULL AS at FROM voice_notes WHERE id = ${note.id}`,
    ).toEqual([{ at: true }]);
    for (const change of [
      `state = 'rejected'`,
      `transcript = 'changed later'`,
      `reviewed_by_actor_id = '${h.seed.ownerA.actor}'`,
    ]) {
      expect({
        change,
        found: await refusal(
          h.admin.unsafe(`UPDATE voice_notes SET ${change} WHERE id = '${note.id}'`),
        ),
      }).toMatchObject({
        found: {
          code: CHECK_VIOLATION,
          message: 'a reviewed or rejected voice note cannot change',
        },
      });
    }
    const screened = newVoiceNote(h.seed.a, job.id, h.seed.estimatorA.actor, { transcript: '' });
    await as(h.seed.a, (tx) => insertVoiceNote(tx, screened));
    expect(await review(screened.id, sql`state = 'rejected'`)).toEqual([
      { state: 'rejected', transcript: '' },
    ]);
  });

  it('is made only as transcribed', async () => {
    const found = await refusal(
      h.admin
        .unsafe(`INSERT INTO voice_notes (id, company_id, job_id, draft_id, actor_id, duration_ms, audio_sha256, transcript, state, reviewed_by_actor_id)
        VALUES ('${randomUUID()}', '${h.seed.a}', '${job.id}', '${job.draft}', '${h.seed.estimatorA.actor}', 1000, '${'a'.repeat(64)}', 'x', 'reviewed', '${h.seed.estimatorA.actor}')`),
    );
    expect(found).toMatchObject({
      code: CHECK_VIOLATION,
      message: 'a voice note starts transcribed',
    });
  });
});

describe('the platform operator (AI tables)', () => {
  it('reads one company’s AI rows in a context that names it, and writes nothing but ceilings', async () => {
    const a = await seedAll(h.seed.a, h.seed.ownerA.actor);
    await seedAll(h.seed.b, h.seed.ownerB.actor);
    const counts = (tx: CompanyTransaction) =>
      tx.execute(
        sqlOf(
          `SELECT ${AI_TABLES.map((table) => `(SELECT count(*)::int FROM ${table}) AS ${table}`).join(', ')}`,
        ),
      );
    expect(await asOperator(counts, true)).toEqual([
      Object.fromEntries(AI_TABLES.map((table) => [table, 1])),
    ]);
    const before = await everything(h.admin);
    const writes: ((tx: CompanyTransaction) => Promise<unknown>)[] = [
      (tx) => insertLedger(tx, { company: h.seed.a, actor: h.seed.ownerA.actor }),
      (tx) =>
        insertResult(tx, {
          company: h.seed.a,
          job: a.job.id,
          actor: h.seed.ownerA.actor,
          callId: a.ledger.callId,
        }),
      (tx) => insertVoiceNote(tx, newVoiceNote(h.seed.a, a.job.id, h.seed.ownerA.actor)),
    ];
    for (const write of writes) {
      expect(await errorCode(asOperator(write))).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await errorCode(asOperator(write, true))).toBe(READ_ONLY_TRANSACTION);
    }
    for (const update of [
      sql`UPDATE ai_ledger SET state = 'held' RETURNING 1`,
      sql`UPDATE ai_results SET status = 'rejected', decided_by_actor_id = ${h.seed.ownerA.actor}::uuid RETURNING 1`,
      sql`UPDATE voice_notes SET state = 'rejected' RETURNING 1`,
      sql`UPDATE member_voice_settings SET voice_name = 'Kore' RETURNING 1`,
    ]) {
      expect(await asOperator((tx) => tx.execute(update))).toEqual([]);
    }
    expect(await everything(h.admin)).toBe(before);
  });
});
