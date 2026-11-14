import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { auditEvents } from '@/db/schema';
import { withOperator, type Database } from '@/db/tenant';

// The platform operator sets one company's AI ceilings (S7-4; the S3-9 pattern of
// web/src/lib/flags/store.ts). It runs in withOperator with that company set, so migration 0012's
// operator policies and trigger let exactly this write through: the two ceilings, stamped with the
// operator's own id, and never the company's voice. The company row is locked first, so two changes
// to one company run one after the other and each audit row's "previous" is what the other left.
// The ceilings and exactly one audit row commit together or not at all; a refused change writes
// nothing. A ceiling of null clears it back to the code default (ceilings.ts, V5 B).

export const AI_CEILINGS_SET_ACTION = 'ai_ceilings_set';

const MAX_MICRO_USD = Number.MAX_SAFE_INTEGER;
const ceiling = z.number().int().min(0).max(MAX_MICRO_USD).nullable();

// The request body: both ceilings, each a whole number of micro-USD or null for the default. A daily
// ceiling above the monthly one is refused, as migration 0012's check would.
export const aiSettingsInput = z
  .strictObject({ dailyCeilingMicroUsd: ceiling, monthlyCeilingMicroUsd: ceiling })
  .refine(
    (v) => v.dailyCeilingMicroUsd === null || v.monthlyCeilingMicroUsd === null || v.dailyCeilingMicroUsd <= v.monthlyCeilingMicroUsd,
  );
export type AiSettingsInput = z.infer<typeof aiSettingsInput>;

export type StoredAiCeilings = { dailyCeilingMicroUsd: number | null; monthlyCeilingMicroUsd: number | null };

export type AiSettingsResult = StoredAiCeilings & { companyId: string; previous: StoredAiCeilings };

export class AiSettingsError extends Error {
  constructor(readonly code: 'not_found') {
    super(`AI settings refused: ${code}`);
    this.name = 'AiSettingsError';
  }
}

const rows = <T>(result: unknown) => result as unknown as T[];
const asNumber = (value: string | null) => (value === null ? null : Number(value));

export async function setCompanyAiCeilings(
  db: Database,
  operatorId: string,
  companyId: string,
  input: AiSettingsInput,
): Promise<AiSettingsResult> {
  return withOperator(
    db,
    operatorId,
    async (tx) => {
      const found = rows(await tx.execute(sql`SELECT id FROM companies WHERE id = ${companyId}::uuid FOR UPDATE`));
      if (found.length === 0) throw new AiSettingsError('not_found');
      const [stored] = rows<{ daily: string | null; monthly: string | null }>(
        await tx.execute(sql`
          SELECT daily_ceiling_micro_usd::text AS daily, monthly_ceiling_micro_usd::text AS monthly
          FROM company_ai_settings WHERE company_id = ${companyId}::uuid
        `),
      );
      const previous = { dailyCeilingMicroUsd: asNumber(stored?.daily ?? null), monthlyCeilingMicroUsd: asNumber(stored?.monthly ?? null) };
      const { dailyCeilingMicroUsd: daily, monthlyCeilingMicroUsd: monthly } = input;
      await tx.execute(sql`
        INSERT INTO company_ai_settings (company_id, daily_ceiling_micro_usd, monthly_ceiling_micro_usd, ceilings_set_by_operator_id)
        VALUES (${companyId}::uuid, ${daily}, ${monthly}, ${operatorId}::uuid)
        ON CONFLICT (company_id) DO UPDATE SET
          daily_ceiling_micro_usd = EXCLUDED.daily_ceiling_micro_usd,
          monthly_ceiling_micro_usd = EXCLUDED.monthly_ceiling_micro_usd,
          ceilings_set_by_operator_id = EXCLUDED.ceilings_set_by_operator_id
      `);
      // Amounts of the AI allowance only: no email, token or price of the company's work.
      await tx.insert(auditEvents).values({
        companyId,
        actorId: null,
        operatorActorId: operatorId,
        action: AI_CEILINGS_SET_ACTION,
        target: companyId,
        details: {
          daily_ceiling_micro_usd: daily,
          monthly_ceiling_micro_usd: monthly,
          previous_daily_ceiling_micro_usd: previous.dailyCeilingMicroUsd,
          previous_monthly_ceiling_micro_usd: previous.monthlyCeilingMicroUsd,
        },
      });
      return { companyId, dailyCeilingMicroUsd: daily, monthlyCeilingMicroUsd: monthly, previous };
    },
    { companyId },
  );
}
