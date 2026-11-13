import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@/db/client';
import { withCompany, withOperator, type CompanyTransaction } from '@/db/tenant';
import {
  CHECK_VIOLATION,
  INSUFFICIENT_PRIVILEGE,
  READ_ONLY_TRANSACTION,
  errorCode,
} from './job-harness';
import { MICRO } from './ai-harness';
import { refusal } from './submission-harness';
import { resetTeamDatabase, startTeamServer, type Harness } from './team-harness';

// S7-3: who sets a company's AI ceilings and Live voices (company_ai_settings and
// member_voice_settings, migration 0012). Only the platform operator sets ceilings (S7-4); a
// company member sets voices only (S7-15). The other AI tables are in ai-tables.test.ts.

let base: Awaited<ReturnType<typeof startTeamServer>>;
let h: Harness;
let pool: ReturnType<typeof openDatabase>;

beforeAll(async () => {
  base = await startTeamServer();
});

beforeEach(async () => {
  await pool?.close();
  h = await resetTeamDatabase(base, h ?? null);
  pool = openDatabase({ APP_ENV: 'test', DATABASE_URL: h.apiUrl }, { max: 2 });
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

describe('AI settings and voice choice', () => {
  const settings = async () =>
    (
      await h.admin<
        {
          daily: string | null;
          monthly: string | null;
          operator: string | null;
          voice: string | null;
          by: string | null;
          ceilingsAt: boolean;
          voiceAt: boolean;
        }[]
      >`
      SELECT daily_ceiling_micro_usd::text AS daily, monthly_ceiling_micro_usd::text AS monthly, ceilings_set_by_operator_id::text AS operator,
             default_voice AS voice, default_voice_set_by_actor_id::text AS by, ceilings_set_at IS NOT NULL AS "ceilingsAt", default_voice_set_at IS NOT NULL AS "voiceAt"
      FROM company_ai_settings WHERE company_id = ${h.seed.a}
    `
    )[0];
  const setCeilings =
    (daily: number | null, monthly: number | null, company = h.seed.a) =>
    (tx: CompanyTransaction) =>
      tx.execute(sql`
      INSERT INTO company_ai_settings (company_id, daily_ceiling_micro_usd, monthly_ceiling_micro_usd, ceilings_set_by_operator_id)
      VALUES (${company}::uuid, ${daily}, ${monthly}, ${h.seed.operator}::uuid)
      ON CONFLICT (company_id) DO UPDATE SET daily_ceiling_micro_usd = EXCLUDED.daily_ceiling_micro_usd,
        monthly_ceiling_micro_usd = EXCLUDED.monthly_ceiling_micro_usd, ceilings_set_by_operator_id = EXCLUDED.ceilings_set_by_operator_id
      RETURNING company_id::text
    `);
  const setDefaultVoice =
    (voice: string, by = h.seed.ownerA.actor, company = h.seed.a) =>
    (tx: CompanyTransaction) =>
      tx.execute(sql`
      INSERT INTO company_ai_settings (company_id, default_voice, default_voice_set_by_actor_id) VALUES (${company}::uuid, ${voice}, ${by}::uuid)
      ON CONFLICT (company_id) DO UPDATE SET default_voice = EXCLUDED.default_voice, default_voice_set_by_actor_id = EXCLUDED.default_voice_set_by_actor_id
      RETURNING company_id::text
    `);

  it('has no row for a company until someone sets something: empty means the code defaults', async () => {
    expect(await h.admin`SELECT count(*)::int AS n FROM company_ai_settings`).toEqual([{ n: 0 }]);
  });

  it('lets the platform operator set a company’s ceilings, stamped with its own id, and nothing else', async () => {
    // The staff test company's explicit ceilings (step H): $5 a day and $100 a month.
    expect(await asOperator(setCeilings(5 * MICRO, 100 * MICRO))).toHaveLength(1);
    expect(await settings()).toMatchObject({
      daily: '5000000',
      monthly: '100000000',
      operator: h.seed.operator,
      voice: null,
      ceilingsAt: true,
      voiceAt: false,
    });
    expect(await asOperator(setCeilings(1 * MICRO, 10 * MICRO))).toHaveLength(1);
    expect(await settings()).toMatchObject({ daily: '1000000', monthly: '10000000' });
    // Back to the code defaults.
    expect(await asOperator(setCeilings(null, null))).toHaveLength(1);
    expect(await settings()).toMatchObject({
      daily: null,
      monthly: null,
      operator: h.seed.operator,
      ceilingsAt: true,
    });
    // The operator cannot pick the company's voice, nor stamp another operator's id.
    expect(await refusal(asOperator(setDefaultVoice('Puck')))).toMatchObject({
      code: CHECK_VIOLATION,
      message: 'the platform operator sets a company’s AI ceilings only',
    });
    const stampedOther = (tx: CompanyTransaction) =>
      tx.execute(
        sql`UPDATE company_ai_settings SET daily_ceiling_micro_usd = 1, ceilings_set_by_operator_id = NULL`,
      );
    expect(await errorCode(asOperator(stampedOther))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await errorCode(asOperator(setCeilings(1, 1), true))).toBe(READ_ONLY_TRANSACTION);
  });

  it('never lets a company member set its own ceilings, an owner included', async () => {
    expect(await refusal(as(h.seed.a, setCeilings(50 * MICRO, 1000 * MICRO)))).toMatchObject({
      code: CHECK_VIOLATION,
      message: 'only the platform operator sets a company’s AI ceilings',
    });
    await as(h.seed.a, setDefaultVoice('Kore'));
    const raise = (tx: CompanyTransaction) =>
      tx.execute(sql`UPDATE company_ai_settings SET daily_ceiling_micro_usd = 99000000`);
    expect(await refusal(as(h.seed.a, raise))).toMatchObject({
      code: CHECK_VIOLATION,
      message: 'only the platform operator sets a company’s AI ceilings',
    });
    expect(await settings()).toMatchObject({
      daily: null,
      monthly: null,
      operator: null,
      voice: 'Kore',
      by: h.seed.ownerA.actor,
      voiceAt: true,
    });
  });

  it('keeps a daily ceiling within the monthly one, and both whole and non-negative', async () => {
    for (const [daily, monthly] of [
      [200 * MICRO, 10 * MICRO],
      [-1, null],
      [null, -1],
      [Number.MAX_SAFE_INTEGER + 1, null],
    ] as const) {
      expect({
        daily,
        monthly,
        code: await errorCode(asOperator(setCeilings(daily, monthly))),
      }).toEqual({ daily, monthly, code: CHECK_VIOLATION });
    }
    expect(await errorCode(asOperator(setCeilings(0, 0)))).toBeUndefined();
  });

  it('takes a voice name of one capitalised word, and keeps each person’s choice in their own company', async () => {
    for (const voice of ['', 'charon', 'Charon Two', 'Ch4ron', 'X']) {
      expect({ voice, code: await errorCode(as(h.seed.a, setDefaultVoice(voice))) }).toEqual({
        voice,
        code: CHECK_VIOLATION,
      });
    }
    const choose = (company: string, actor: string, voice: string) => (tx: CompanyTransaction) =>
      tx.execute(sql`
        INSERT INTO member_voice_settings (company_id, actor_id, voice_name) VALUES (${company}::uuid, ${actor}::uuid, ${voice})
        ON CONFLICT (company_id, actor_id) DO UPDATE SET voice_name = EXCLUDED.voice_name RETURNING voice_name
      `);
    expect(
      rows(await as(h.seed.a, choose(h.seed.a, h.seed.estimatorA.actor, 'Zubenelgenubi'))),
    ).toEqual([{ voice_name: 'Zubenelgenubi' }]);
    expect(rows(await as(h.seed.a, choose(h.seed.a, h.seed.estimatorA.actor, 'Charon')))).toEqual([
      { voice_name: 'Charon' },
    ]);
    expect(
      await errorCode(as(h.seed.a, choose(h.seed.a, h.seed.estimatorA.actor, 'not a voice'))),
    ).toBe(CHECK_VIOLATION);
    // B cannot set A's default or A's person's choice.
    expect(
      await errorCode(as(h.seed.b, setDefaultVoice('Puck', h.seed.ownerB.actor, h.seed.a))),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await errorCode(as(h.seed.b, choose(h.seed.a, h.seed.estimatorA.actor, 'Puck')))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await errorCode(asOperator(choose(h.seed.a, h.seed.estimatorA.actor, 'Puck')))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(
      await h.admin`SELECT voice_name FROM member_voice_settings WHERE actor_id = ${h.seed.estimatorA.actor}`,
    ).toEqual([{ voice_name: 'Charon' }]);
  });
});
