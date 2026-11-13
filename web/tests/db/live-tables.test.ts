import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { liveSessions, liveTurns, liveUsage } from '@/db/ai-schema';
import { openDatabase } from '@/db/client';
import { withCompany, withOperator, type CompanyTransaction } from '@/db/tenant';
import { sharedRoles } from './postgres-harness';
import { unprotectedRelations } from './row-security-guard';
import {
  CHECK_VIOLATION,
  FOREIGN_KEY_VIOLATION,
  INSUFFICIENT_PRIVILEGE,
  READ_ONLY_TRANSACTION,
  UNIQUE_VIOLATION,
  digestOf,
  errorCode,
  newJob,
  ownerOf,
  pause,
  seedJob,
} from './job-harness';
import {
  endSession,
  insertSession,
  insertTurn,
  newSession,
  postUsage,
  seedLedger,
  seedSession,
} from './ai-harness';
import { refusal } from './submission-harness';
import { everything, resetTeamDatabase, startTeamServer, type Harness } from './team-harness';

// S7-3: the Live tables and the sweeper's lookup across companies (migration 0012), as the app's
// runtime role on a server set up like a fresh Cloud SQL instance (see team-harness.ts). No route uses
// them yet; these tests write and read through withCompany and withOperator as S7-11 to S7-13's
// internal live routes will (docs/plans/S7.md section 4).
const LIVE_TABLES = ['live_sessions', 'live_turns', 'live_usage'];
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
  pool = openDatabase({ APP_ENV: 'test', DATABASE_URL: h.apiUrl }, { max: 6 });
});

afterAll(async () => {
  await pool?.close();
  await h?.handle.close();
  await base?.admin.end({ timeout: 5 });
  await base?.server.stop();
});

const as = <T>(company: string, run: (tx: CompanyTransaction) => Promise<T>) =>
  withCompany(pool.db, company, run);
const asOperator = <T>(run: (tx: CompanyTransaction) => Promise<T>, readOnly = false) =>
  withOperator(h.handle.db, h.seed.operator, run, { companyId: h.seed.a, readOnly });
const rows = <T>(result: unknown) => result as unknown as T[];
const sqlOf = (text: string) => sql.raw(text);
const loginAsOther = () => {
  const url = new URL(base.server.databaseUrl);
  url.username = sharedRoles().other.name;
  url.password = sharedRoles().other.password;
  return postgres(url.toString(), { max: 1, connect_timeout: 10, onnotice: () => {} });
};

const jobOf = (company: string) => seedJob(h.admin, newJob(company, ownerOf(h, company)));
// A reservation for a walkthrough, as admission makes it before the session row.
const reservationOf = async (company: string, actor: string) =>
  (
    await seedLedger(h.admin, {
      company,
      actor,
      feature: 'live',
      model: 'gemini-3.8-live',
      reserved: 2_900_000,
    })
  ).id;
// An open session for a person, seeded as the table owner.
async function sessionOf(
  company: string,
  actor: string,
  extra: Parameters<typeof newSession>[4] = {},
) {
  const job = await jobOf(company);
  return seedSession(
    h.admin,
    newSession(company, job.id, actor, await reservationOf(company, actor), {
      draft: job.draft,
      ...extra,
    }),
  );
}
const sessionRow = async (id: string) =>
  (
    await h.admin<
      {
        epoch: number;
        ended: boolean;
        reason: string | null;
        lease: boolean;
        handle: string | null;
        counter: string;
      }[]
    >`
    SELECT epoch, ended_at IS NOT NULL AS ended, end_reason AS reason, lease_expires_at IS NOT NULL AS lease, resumption_handle AS handle, handle_counter::text AS counter
    FROM live_sessions WHERE id = ${id}
  `
  )[0];

describe('migration 0012: the Live tables', () => {
  it('passes the row-level security guard: every table is forced and has policies', async () => {
    expect(await unprotectedRelations(h.admin)).toEqual([]);
    const found = await h.admin<
      { name: string; enabled: boolean; forced: boolean; policies: number }[]
    >`
      SELECT c.relname AS name, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY(${LIVE_TABLES}) ORDER BY 1
    `;
    // live_sessions has a fourth policy: the sweeper lookup's owner scan. live_turns is insert-only.
    expect(found).toEqual([
      { name: 'live_sessions', enabled: true, forced: true, policies: 4 },
      { name: 'live_turns', enabled: true, forced: true, policies: 2 },
      { name: 'live_usage', enabled: true, forced: true, policies: 3 },
    ]);
  });

  it('gives the runtime SELECT and INSERT, and UPDATE of named session and usage columns only', async () => {
    const tableLevel = await h.admin<{ table: string; privilege: string }[]>`
      SELECT table_name AS table, privilege_type AS privilege FROM information_schema.role_table_grants
      WHERE grantee = 'dryscope_runtime' AND table_name = ANY(${LIVE_TABLES}) ORDER BY 1, 2
    `;
    expect(tableLevel).toEqual(
      LIVE_TABLES.flatMap((table) =>
        ['INSERT', 'SELECT'].map((privilege) => ({ table, privilege })),
      ),
    );
    const updates = await h.admin<{ table: string; column: string }[]>`
      SELECT table_name AS table, column_name AS column FROM information_schema.column_privileges
      WHERE grantee = 'dryscope_runtime' AND table_name = ANY(${LIVE_TABLES}) AND privilege_type = 'UPDATE' ORDER BY 1, 2
    `;
    expect(updates).toEqual([
      ...[
        'capability_sha256',
        'covered_seq',
        'end_reason',
        'ended_at',
        'epoch',
        'handle_counter',
        'lease_expires_at',
        'next_turn_seq',
        'restarts',
        'resumption_handle',
        'signed_in_at',
      ].map((column) => ({ table: 'live_sessions', column })),
      { table: 'live_usage', column: 'closed' },
      { table: 'live_usage', column: 'max_cumulative_micro_usd' },
    ]);
  });

  it('works through the Drizzle view the routes will use', async () => {
    const s = await sessionOf(h.seed.a, h.seed.estimatorA.actor);
    await as(h.seed.a, async (tx) => {
      await insertTurn(tx, { company: h.seed.a, session: s.id, seq: 1 });
      await postUsage(tx, h.seed.a, s.id, 1, 1, 12_345);
    });
    const read = await as(h.seed.a, async (tx) => ({
      session: (await tx.select().from(liveSessions))[0],
      turn: (await tx.select().from(liveTurns))[0],
      usage: (await tx.select().from(liveUsage))[0],
    }));
    expect(read.session).toMatchObject({
      id: s.id,
      actorId: h.seed.estimatorA.actor,
      voice: 'Charon',
      language: 'en-US',
      epoch: 1,
      handleCounter: 0,
      coveredSeq: 0,
      nextTurnSeq: 1,
      restarts: 0,
      endedAt: null,
    });
    expect(read.session?.leaseExpiresAt).toBeInstanceOf(Date);
    expect(read.turn).toMatchObject({
      seq: 1,
      speaker: 'technician',
      verdict: 'passed',
      verdictCategory: 'passed',
    });
    expect(read.usage).toMatchObject({
      epoch: 1,
      connection: 1,
      maxCumulativeMicroUsd: 12_345,
      closed: false,
    });
  });
});

describe('isolation between companies (Live tables)', () => {
  it('shows company B none of company A’s sessions, usage or turns, and B’s writes reach none of them', async () => {
    const a = await sessionOf(h.seed.a, h.seed.estimatorA.actor);
    const b = await sessionOf(h.seed.b, h.seed.estimatorB.actor);
    for (const [company, s] of [
      [h.seed.a, a],
      [h.seed.b, b],
    ] as const) {
      await as(company, async (tx) => {
        await insertTurn(tx, { company, session: s.id, seq: 1 });
        await postUsage(tx, company, s.id, 1, 1, 100);
      });
    }
    const aRows = async () =>
      JSON.stringify(
        await Promise.all(
          LIVE_TABLES.map((table) =>
            h.admin.unsafe(`SELECT * FROM ${table} WHERE company_id = $1 ORDER BY 1, 2`, [
              h.seed.a,
            ]),
          ),
        ),
      );
    const before = await aRows();
    // The database context holds the company only, never the person or role, so this is what every
    // role of company B sees.
    const seen = await as(h.seed.b, async (tx) => {
      const counts: Record<string, string[]> = {};
      for (const table of LIVE_TABLES)
        counts[table] = rows<{ c: string }>(
          await tx.execute(sqlOf(`SELECT DISTINCT company_id::text AS c FROM ${table}`)),
        ).map((row) => row.c);
      return counts;
    });
    expect(seen).toEqual(Object.fromEntries(LIVE_TABLES.map((table) => [table, [h.seed.b]])));
    expect(
      await as(h.seed.b, async (tx) =>
        rows(await tx.execute(sql`SELECT 1 FROM live_sessions WHERE id = ${a.id}::uuid`)),
      ),
    ).toEqual([]);
    const changed = await as(h.seed.b, async (tx) => [
      rows(
        await tx.execute(
          sql`UPDATE live_sessions SET epoch = epoch + 1 RETURNING company_id::text AS c`,
        ),
      ),
      rows(
        await tx.execute(
          sql`UPDATE live_usage SET max_cumulative_micro_usd = max_cumulative_micro_usd + 1 RETURNING company_id::text AS c`,
        ),
      ),
    ]);
    for (const reached of changed) expect(reached).toEqual([{ c: h.seed.b }]);
    expect(await aRows()).toBe(before);
  });

  it('refuses a session, turn or usage row for another company, or one pointing at another company’s job, person, reservation or session', async () => {
    const jobA = await jobOf(h.seed.a);
    const jobB = await jobOf(h.seed.b);
    const resA = await reservationOf(h.seed.a, h.seed.estimatorA.actor);
    const resB = await reservationOf(h.seed.b, h.seed.estimatorB.actor);
    const a = await sessionOf(h.seed.a, h.seed.ownerA.actor);
    expect(
      await errorCode(
        as(h.seed.b, (tx) =>
          insertSession(tx, newSession(h.seed.a, jobA.id, h.seed.estimatorA.actor, resA)),
        ),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(
      await errorCode(
        as(h.seed.b, (tx) => insertTurn(tx, { company: h.seed.a, session: a.id, seq: 9 })),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await errorCode(as(h.seed.b, (tx) => postUsage(tx, h.seed.a, a.id, 1, 1, 1)))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    for (const [name, session] of [
      ['job', newSession(h.seed.b, jobA.id, h.seed.estimatorB.actor, resB)],
      ['person', newSession(h.seed.b, jobB.id, h.seed.estimatorA.actor, resB)],
      ['reservation', newSession(h.seed.b, jobB.id, h.seed.estimatorB.actor, resA)],
    ] as const) {
      expect({
        name,
        code: await errorCode(as(h.seed.b, (tx) => insertSession(tx, session))),
      }).toEqual({ name, code: FOREIGN_KEY_VIOLATION });
    }
    // A turn or usage row in company B's own name that names company A's session.
    expect(
      await refusal(
        as(h.seed.b, (tx) => insertTurn(tx, { company: h.seed.b, session: a.id, seq: 1 })),
      ),
    ).toMatchObject({ code: FOREIGN_KEY_VIOLATION, constraint: 'live_turns_session_fkey' });
    expect(
      await refusal(as(h.seed.b, (tx) => postUsage(tx, h.seed.b, a.id, 1, 1, 1))),
    ).toMatchObject({ code: FOREIGN_KEY_VIOLATION, constraint: 'live_usage_session_fkey' });
    expect(
      await as(h.seed.b, (tx) =>
        insertSession(tx, newSession(h.seed.b, jobB.id, h.seed.estimatorB.actor, resB)),
      ),
    ).toHaveLength(1);
  });
});

describe('nothing is removed from the Live tables', () => {
  it('refuses every delete and truncate as the runtime, and the owner reads and removes nothing', async () => {
    const s = await sessionOf(h.seed.a, h.seed.estimatorA.actor);
    await as(h.seed.a, async (tx) => {
      await insertTurn(tx, { company: h.seed.a, session: s.id, seq: 1 });
      await postUsage(tx, h.seed.a, s.id, 1, 1, 10);
    });
    const before = await everything(h.admin);
    for (const table of LIVE_TABLES) {
      for (const statement of [`DELETE FROM ${table}`, `TRUNCATE ${table}`]) {
        expect({
          statement,
          code: await errorCode(as(h.seed.a, (tx) => tx.execute(sqlOf(statement)))),
        }).toEqual({ statement, code: INSUFFICIENT_PRIVILEGE });
      }
    }
    const owner = postgres(h.migratorUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
    try {
      for (const table of LIVE_TABLES) {
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

  it('never lets the runtime change what makes a session, usage row or turn who it is', async () => {
    const s = await sessionOf(h.seed.a, h.seed.estimatorA.actor);
    await as(h.seed.a, async (tx) => {
      await insertTurn(tx, { company: h.seed.a, session: s.id, seq: 1 });
      await postUsage(tx, h.seed.a, s.id, 1, 1, 10);
    });
    const before = await everything(h.admin);
    const frozen: Record<string, string[]> = {
      live_sessions: [
        'id',
        'company_id',
        'job_id',
        'draft_id',
        'actor_id',
        'voice',
        'language',
        'started_at',
        'scope_fingerprint',
        'reservation_id',
      ],
      live_usage: ['company_id', 'session_id', 'epoch', 'connection', 'last_posted_at'],
      live_turns: [
        'company_id',
        'session_id',
        'seq',
        'epoch',
        'connection',
        'speaker',
        'text',
        'verdict',
        'verdict_category',
        'created_at',
      ],
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
});

describe('a live session', () => {
  it('starts open with a lease, epoch 1, no handle, turn 1 next and no restarts', async () => {
    const s = await sessionOf(h.seed.a, h.seed.estimatorA.actor);
    expect(
      await h.admin`
      SELECT epoch, handle_counter::text AS counter, covered_seq::text AS covered, next_turn_seq AS next, restarts, resumption_handle AS handle,
             ended_at, end_reason, lease_expires_at > now() AS leased
      FROM live_sessions WHERE id = ${s.id}
    `,
    ).toEqual([
      {
        epoch: 1,
        counter: '0',
        covered: '0',
        next: 1,
        restarts: 0,
        handle: null,
        ended_at: null,
        end_reason: null,
        leased: true,
      },
    ]);
  });

  it('allows one open session per person: a second is refused until the first ends', async () => {
    const job = await jobOf(h.seed.a);
    const actor = h.seed.estimatorA.actor;
    const first = newSession(h.seed.a, job.id, actor, await reservationOf(h.seed.a, actor), {
      draft: job.draft,
    });
    await as(h.seed.a, (tx) => insertSession(tx, first));
    const second = newSession(h.seed.a, job.id, actor, await reservationOf(h.seed.a, actor), {
      draft: job.draft,
    });
    expect(await refusal(as(h.seed.a, (tx) => insertSession(tx, second)))).toMatchObject({
      code: UNIQUE_VIOLATION,
      constraint: 'live_sessions_one_open_per_person',
    });
    // Another person of the same company has their own.
    expect(
      await as(h.seed.a, async (tx) =>
        insertSession(
          tx,
          newSession(
            h.seed.a,
            job.id,
            h.seed.ownerA.actor,
            await reservationOf(h.seed.a, h.seed.ownerA.actor),
          ),
        ),
      ),
    ).toHaveLength(1);
    // The admit path: end the open session, then insert, in one transaction.
    const third = newSession(h.seed.a, job.id, actor, await reservationOf(h.seed.a, actor), {
      draft: job.draft,
    });
    await as(h.seed.a, async (tx) => {
      expect(await endSession(tx, h.seed.a, first.id, 'new_admit')).toHaveLength(1);
      expect(await insertSession(tx, third)).toHaveLength(1);
    });
    expect(
      await h.admin`SELECT count(*)::int AS open FROM live_sessions WHERE actor_id = ${actor} AND ended_at IS NULL`,
    ).toEqual([{ open: 1 }]);
    expect(await sessionRow(first.id)).toMatchObject({
      ended: true,
      reason: 'new_admit',
      lease: false,
      epoch: 2,
    });
  });

  it('gives two admits by one person at once one open session, and the loser keeps nothing', async () => {
    const job = await jobOf(h.seed.a);
    const actor = h.seed.estimatorA.actor;
    const tries = await Promise.all(
      [1, 2].map(() =>
        errorCode(
          as(h.seed.a, async (tx) => {
            // The reservation and the session in one transaction, as admission makes them.
            const [hold] = rows<{ id: string }>(
              await tx.execute(sql`
              INSERT INTO ai_ledger (company_id, call_id, actor_id, feature, model, reserved_micro_usd, utc_day, utc_month)
              VALUES (${h.seed.a}::uuid, ${randomUUID()}::uuid, ${actor}::uuid, 'live', 'gemini-3.8-live', 2900000, current_date, date_trunc('month', current_date)::date)
              RETURNING id::text
            `),
            );
            await pause(100);
            return insertSession(
              tx,
              newSession(h.seed.a, job.id, actor, hold!.id, { draft: job.draft }),
            );
          }),
        ),
      ),
    );
    expect(tries.filter((code) => code === undefined)).toHaveLength(1);
    expect(tries.filter((code) => code === UNIQUE_VIOLATION)).toHaveLength(1);
    expect(
      await h.admin`SELECT (SELECT count(*)::int FROM live_sessions) AS sessions, (SELECT count(*)::int FROM ai_ledger) AS holds`,
    ).toEqual([{ sessions: 1, holds: 1 }]);
  });

  it('holds one session per reservation, and one per client session id in a company', async () => {
    const s = await sessionOf(h.seed.a, h.seed.estimatorA.actor);
    const job = await jobOf(h.seed.a);
    expect(
      await refusal(
        as(h.seed.a, (tx) =>
          insertSession(tx, newSession(h.seed.a, job.id, h.seed.ownerA.actor, s.reservation)),
        ),
      ),
    ).toMatchObject({
      code: UNIQUE_VIOLATION,
      constraint: 'live_sessions_company_reservation_key',
    });
    expect(
      await refusal(
        as(h.seed.a, async (tx) =>
          insertSession(
            tx,
            newSession(
              h.seed.a,
              job.id,
              h.seed.ownerA.actor,
              await reservationOf(h.seed.a, h.seed.ownerA.actor),
              { id: s.id },
            ),
          ),
        ),
      ),
    ).toMatchObject({
      code: UNIQUE_VIOLATION,
      constraint: 'live_sessions_pkey',
    });
  });

  it('checks its hashes, language, voice and counters', async () => {
    const job = await jobOf(h.seed.a);
    const actor = h.seed.estimatorA.actor;
    for (const extra of [
      { capability: 'A'.repeat(64) },
      { fingerprint: 'abc' },
      { language: 'english' },
      { voice: 'charon' },
    ] as const) {
      const s = newSession(h.seed.a, job.id, actor, await reservationOf(h.seed.a, actor), extra);
      expect({ extra, code: await errorCode(as(h.seed.a, (tx) => insertSession(tx, s))) }).toEqual({
        extra,
        code: CHECK_VIOLATION,
      });
    }
    const s = await sessionOf(h.seed.a, actor);
    const set = (change: string) =>
      errorCode(
        as(h.seed.a, (tx) =>
          tx.execute(sqlOf(`UPDATE live_sessions SET ${change} WHERE id = '${s.id}'`)),
        ),
      );
    for (const change of [
      'epoch = 0',
      'handle_counter = -1',
      'covered_seq = -1',
      'next_turn_seq = 0',
      'restarts = 4',
      'restarts = -1',
      `resumption_handle = ''`,
      `resumption_handle = '${'h'.repeat(4097)}'`,
      'lease_expires_at = NULL',
    ]) {
      expect({ change, code: await set(change) }).toEqual({ change, code: CHECK_VIOLATION });
    }
    for (const change of [
      'restarts = 3',
      `resumption_handle = 'handle-1', handle_counter = 1, covered_seq = 480`,
      'next_turn_seq = 7',
      `epoch = epoch + 1, capability_sha256 = '${digestOf('new capability')}'`,
      `lease_expires_at = now() + interval '60 seconds'`,
      'signed_in_at = now()',
    ]) {
      expect({ change, code: await set(change) }).toEqual({ change, code: undefined });
    }
  });

  it('ends once, releasing its lease and handle and bumping its epoch, and is frozen after', async () => {
    const s = await sessionOf(h.seed.a, h.seed.estimatorA.actor);
    await as(h.seed.a, (tx) =>
      tx.execute(
        sql`UPDATE live_sessions SET resumption_handle = 'handle-1', handle_counter = 3 WHERE id = ${s.id}::uuid`,
      ),
    );
    // An end needs its reason, releases the lease and clears the handle.
    for (const change of [
      `ended_at = now(), lease_expires_at = NULL, resumption_handle = NULL`,
      `end_reason = 'finish'`,
      `ended_at = now(), end_reason = 'finish', resumption_handle = NULL`,
      `ended_at = now(), end_reason = 'finish', lease_expires_at = NULL`,
      `ended_at = now(), end_reason = 'Not A Reason', lease_expires_at = NULL, resumption_handle = NULL`,
    ]) {
      expect({
        change,
        code: await errorCode(
          as(h.seed.a, (tx) =>
            tx.execute(sqlOf(`UPDATE live_sessions SET ${change} WHERE id = '${s.id}'`)),
          ),
        ),
      }).toEqual({ change, code: CHECK_VIOLATION });
    }
    expect(await as(h.seed.a, (tx) => endSession(tx, h.seed.a, s.id, 'lease_expired'))).toEqual([
      { id: s.id, epoch: 2 },
    ]);
    expect(await as(h.seed.a, (tx) => endSession(tx, h.seed.a, s.id, 'finish'))).toEqual([]);
    expect(await sessionRow(s.id)).toEqual({
      epoch: 2,
      ended: true,
      reason: 'lease_expired',
      lease: false,
      handle: null,
      counter: '3',
    });
    const before = await everything(h.admin);
    for (const change of [
      `ended_at = NULL, end_reason = NULL, lease_expires_at = now() + interval '1 minute'`,
      'epoch = epoch + 1',
      `end_reason = 'finish'`,
      'handle_counter = 4',
      `capability_sha256 = '${digestOf('again')}'`,
      'restarts = 1',
    ]) {
      // As the superuser, whom no policy or column right binds: only the trigger and the checks do.
      expect({
        change,
        found: await refusal(
          h.admin.unsafe(`UPDATE live_sessions SET ${change} WHERE id = '${s.id}'`),
        ),
      }).toMatchObject({ found: { code: CHECK_VIOLATION } });
    }
    expect(
      await refusal(
        h.admin.unsafe(`UPDATE live_sessions SET epoch = epoch + 1 WHERE id = '${s.id}'`),
      ),
    ).toMatchObject({ message: 'an ended live session cannot change' });
    expect(await everything(h.admin)).toBe(before);
  });
});

describe('live usage', () => {
  let s: Awaited<ReturnType<typeof sessionOf>>;
  beforeEach(async () => {
    s = await sessionOf(h.seed.a, h.seed.estimatorA.actor);
  });
  const usage = async () =>
    h.admin<{ epoch: number; connection: number; max: string; closed: boolean }[]>`
      SELECT epoch, connection, max_cumulative_micro_usd::text AS max, closed FROM live_usage WHERE session_id = ${s.id} ORDER BY epoch, connection
    `;
  const post = (epoch: number, connection: number, cumulative: number) =>
    as(h.seed.a, (tx) => postUsage(tx, h.seed.a, s.id, epoch, connection, cumulative));

  it('keeps the highest cumulative per connection, so a retried or late post never lowers it', async () => {
    expect(await post(1, 1, 100)).toEqual([{ max: '100', closed: false }]);
    expect(await post(1, 1, 250)).toEqual([{ max: '250', closed: false }]);
    expect(await post(1, 1, 120)).toEqual([{ max: '250', closed: false }]);
    expect(await usage()).toEqual([{ epoch: 1, connection: 1, max: '250', closed: false }]);
    // A direct write that lowers it is refused, even as the superuser.
    expect(
      await refusal(
        as(h.seed.a, (tx) =>
          tx.execute(
            sql`UPDATE live_usage SET max_cumulative_micro_usd = 10 WHERE session_id = ${s.id}::uuid`,
          ),
        ),
      ),
    ).toMatchObject({
      code: CHECK_VIOLATION,
      message: "a live connection's cumulative cost only goes up",
    });
    expect(
      await refusal(
        h.admin`UPDATE live_usage SET max_cumulative_micro_usd = 10 WHERE session_id = ${s.id}`,
      ),
    ).toMatchObject({ code: CHECK_VIOLATION });
    for (const [epoch, connection, cumulative] of [
      [0, 1, 1],
      [1, 0, 1],
      [1, 2, -1],
    ] as const) {
      expect({
        epoch,
        connection,
        code: await errorCode(post(epoch, connection, cumulative)),
      }).toEqual({ epoch, connection, code: CHECK_VIOLATION });
    }
  });

  it('stamps each post with the database clock', async () => {
    await post(1, 1, 100);
    const [first] = await h.admin<
      { at: Date }[]
    >`SELECT last_posted_at AS at FROM live_usage WHERE session_id = ${s.id}`;
    await pause(20);
    await post(1, 1, 200);
    const [second] = await h.admin<
      { at: Date; now: Date }[]
    >`SELECT last_posted_at AS at, now() AS now FROM live_usage WHERE session_id = ${s.id}`;
    expect(second!.at.getTime()).toBeGreaterThan(first!.at.getTime());
    expect(second!.at.getTime()).toBeLessThanOrEqual(second!.now.getTime());
  });

  it('sums a GoAway’s two connections in one epoch, and a resume’s new epoch, as the session’s cost', async () => {
    await post(1, 1, 400);
    await post(1, 2, 150);
    await post(2, 1, 75);
    const [total] = await as(h.seed.a, async (tx) =>
      rows<{ total: string }>(
        await tx.execute(
          sql`SELECT sum(max_cumulative_micro_usd)::text AS total FROM live_usage WHERE session_id = ${s.id}::uuid`,
        ),
      ),
    );
    expect(total).toEqual({ total: '625' });
  });

  it('closes a connection once, at its final cumulative, and nothing moves it after', async () => {
    await post(1, 1, 100);
    const close = (cumulative: number) =>
      as(h.seed.a, async (tx) =>
        rows<{ max: string }>(
          await tx.execute(sql`
        UPDATE live_usage SET max_cumulative_micro_usd = GREATEST(max_cumulative_micro_usd, ${cumulative}), closed = true
        WHERE session_id = ${s.id}::uuid AND epoch = 1 AND connection = 1 AND closed = false RETURNING max_cumulative_micro_usd::text AS max
      `),
        ),
      );
    expect(await close(180)).toEqual([{ max: '180' }]);
    expect(await close(500)).toEqual([]);
    // A post after the close changes nothing.
    expect(await post(1, 1, 900)).toEqual([]);
    for (const change of ['closed = false', 'max_cumulative_micro_usd = 999']) {
      expect({
        change,
        found: await refusal(
          h.admin.unsafe(`UPDATE live_usage SET ${change} WHERE session_id = '${s.id}'`),
        ),
      }).toMatchObject({
        found: { code: CHECK_VIOLATION, message: 'a closed live connection cannot change' },
      });
    }
    expect(await usage()).toEqual([{ epoch: 1, connection: 1, max: '180', closed: true }]);
  });
});

describe('live turns', () => {
  let s: Awaited<ReturnType<typeof sessionOf>>;
  beforeEach(async () => {
    s = await sessionOf(h.seed.a, h.seed.estimatorA.actor);
  });
  const turn = (extra: Partial<Parameters<typeof insertTurn>[1]> & { seq: number }) =>
    as(h.seed.a, (tx) => insertTurn(tx, { company: h.seed.a, session: s.id, ...extra }));

  it('holds one turn per session and sequence number, and another session has its own', async () => {
    expect(await turn({ seq: 1 })).toEqual([{ seq: 1 }]);
    expect(await refusal(turn({ seq: 1, speaker: 'assistant' }))).toMatchObject({
      code: UNIQUE_VIOLATION,
      constraint: 'live_turns_pkey',
    });
    const other = await sessionOf(h.seed.a, h.seed.ownerA.actor);
    expect(
      await as(h.seed.a, (tx) => insertTurn(tx, { company: h.seed.a, session: other.id, seq: 1 })),
    ).toHaveLength(1);
  });

  it('keeps text only for a passed turn: a blocked or unscreened one holds its verdict category and no words', async () => {
    expect(
      await turn({ seq: 1, speaker: 'assistant', text: 'How high does the stain go?' }),
    ).toHaveLength(1);
    expect(
      await turn({ seq: 2, verdict: 'blocked', category: 'blocked_pi_jailbreak', text: '' }),
    ).toHaveLength(1);
    expect(
      await turn({ seq: 3, verdict: 'unscreened', category: 'unavailable_timeout', text: '' }),
    ).toHaveLength(1);
    expect(await turn({ seq: 4, speaker: 'system', text: '' })).toHaveLength(1);
    for (const extra of [
      { seq: 10, verdict: 'blocked', category: 'blocked_rai', text: 'the words that were blocked' },
      { seq: 11, verdict: 'unscreened', category: 'unavailable_error', text: 'unscreened words' },
      { seq: 12, verdict: 'passed', category: 'blocked_rai' },
      { seq: 13, verdict: 'blocked', category: 'passed', text: '' },
      { seq: 14, verdict: 'allowed', category: 'passed' },
      { seq: 15, speaker: 'customer' },
      { seq: 16, text: 'x'.repeat(20_001) },
      { seq: 17, category: 'Passed Through' },
      { seq: 0 },
    ]) {
      expect({ extra, code: await errorCode(turn(extra)) }).toEqual({
        extra,
        code: CHECK_VIOLATION,
      });
    }
  });

  it('is insert-only: no turn’s text or verdict ever changes, not even as the superuser', async () => {
    await turn({ seq: 1 });
    const before = await everything(h.admin);
    expect(
      await errorCode(
        as(h.seed.a, (tx) =>
          tx.execute(
            sql`UPDATE live_turns SET text = 'rewritten' WHERE session_id = ${s.id}::uuid`,
          ),
        ),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    for (const change of [
      `text = 'rewritten'`,
      `verdict = 'blocked', verdict_category = 'blocked_rai', text = ''`,
      'seq = 2',
    ]) {
      expect({
        change,
        found: await refusal(
          h.admin.unsafe(`UPDATE live_turns SET ${change} WHERE session_id = '${s.id}'`),
        ),
      }).toMatchObject({ found: { code: CHECK_VIOLATION, message: 'a live turn cannot change' } });
    }
    expect(await everything(h.admin)).toBe(before);
  });
});

describe('the platform operator (Live tables)', () => {
  it('reads one company’s Live rows in a read-only context, and cannot write', async () => {
    const s = await sessionOf(h.seed.a, h.seed.estimatorA.actor);
    await sessionOf(h.seed.b, h.seed.estimatorB.actor);
    await as(h.seed.a, (tx) => insertTurn(tx, { company: h.seed.a, session: s.id, seq: 1 }));
    expect(
      await asOperator(
        (tx) =>
          tx.execute(
            sql`SELECT (SELECT count(*)::int FROM live_sessions) AS sessions, (SELECT count(*)::int FROM live_turns) AS turns`,
          ),
        true,
      ),
    ).toEqual([{ sessions: 1, turns: 1 }]);
    const before = await everything(h.admin);
    const writes: ((tx: CompanyTransaction) => Promise<unknown>)[] = [
      (tx) => insertTurn(tx, { company: h.seed.a, session: s.id, seq: 2 }),
      (tx) => postUsage(tx, h.seed.a, s.id, 1, 1, 1),
    ];
    for (const write of writes) {
      expect(await errorCode(asOperator(write))).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await errorCode(asOperator(write, true))).toBe(READ_ONLY_TRANSACTION);
    }
    expect(
      await asOperator((tx) =>
        tx.execute(sql`UPDATE live_sessions SET epoch = epoch + 1 RETURNING 1`),
      ),
    ).toEqual([]);
    expect(await everything(h.admin)).toBe(before);
  });
});

describe('migration 0012: the sweeper’s lookup across companies', () => {
  const due = (max = 10) =>
    pool.db.execute(sql`SELECT live_session_due_companies(${max}::int)::text AS id`);
  const ids = async (max?: number) => rows<{ id: string }>(await due(max)).map((row) => row.id);

  it('finds a company with an open session whose lease has lapsed, oldest first, and not an ended or leased one', async () => {
    await sessionOf(h.seed.a, h.seed.estimatorA.actor, { leaseIn: 60 });
    expect(await ids()).toEqual([]);
    await sessionOf(h.seed.a, h.seed.ownerA.actor, { leaseIn: -30 });
    await sessionOf(h.seed.b, h.seed.estimatorB.actor, { leaseIn: -90 });
    expect(await ids()).toEqual([h.seed.b, h.seed.a]);
    expect(await ids(1)).toEqual([h.seed.b]);
    const lapsed = await h.admin<
      { id: string }[]
    >`SELECT id::text FROM live_sessions WHERE company_id = ${h.seed.b}`;
    await as(h.seed.b, (tx) => endSession(tx, h.seed.b, lapsed[0]!.id, 'lease_expired'));
    expect(await ids()).toEqual([h.seed.a]);
  });

  it('lets the runtime find which companies have work, and nothing else, even with the setting turned on', async () => {
    await sessionOf(h.seed.a, h.seed.estimatorA.actor, { leaseIn: -30 });
    const api = postgres(h.apiUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
    try {
      await api.begin(async (tx) => {
        await tx`SELECT set_config('app.live_session_scan', 'on', true)`;
        expect(await tx`SELECT * FROM live_sessions`).toHaveLength(0);
      });
      expect(await api`SELECT live_session_due_companies(10)::text AS id`).toEqual([
        { id: h.seed.a },
      ]);
      expect(await api`SELECT current_setting('app.live_session_scan', true) AS v`).toEqual([
        { v: '' },
      ]);
      expect(await api`SELECT * FROM live_sessions`).toHaveLength(0);
    } finally {
      await api.end({ timeout: 5 });
    }
  });

  it('refuses everyone but the runtime, and the owner reads nothing through it', async () => {
    await sessionOf(h.seed.a, h.seed.estimatorA.actor, { leaseIn: -30 });
    const other = loginAsOther();
    const migrator = postgres(h.migratorUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
    try {
      expect(await errorCode(other`SELECT live_session_due_companies(10)`)).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
      expect(await errorCode(other`SELECT * FROM live_sessions`)).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await migrator`SELECT live_session_due_companies(10)`).toEqual([]);
      await migrator.begin(async (tx) => {
        await tx`SELECT set_config('app.live_session_scan', 'on', true)`;
        expect(await tx`SELECT * FROM live_sessions`).toHaveLength(0);
      });
      expect(await migrator`UPDATE live_sessions SET restarts = 1 RETURNING id`).toHaveLength(0);
    } finally {
      await other.end({ timeout: 5 });
      await migrator.end({ timeout: 5 });
    }
  });

  it('refuses a size outside 1 to 100, and answers nothing for a null', async () => {
    for (const max of [0, 101])
      expect({ max, code: await errorCode(due(max)) }).toEqual({ max, code: INVALID_PARAMETER });
    expect(await errorCode(due(100))).toBeUndefined();
    expect(rows(await pool.db.execute(sql`SELECT live_session_due_companies(NULL)`))).toEqual([]);
  });

  it('leaves every table protected', async () => {
    expect(await unprotectedRelations(h.admin)).toEqual([]);
  });
});
