import { z } from 'zod';
import { FlagRefusal, isFlagName, type FlagName } from './known';

// Changing one company's flag: the rule. Only a platform operator changes a flag (owner decision
// D12). The operator route (POST /api/platform/companies/{companyId}/flags) calls this with the
// Postgres store in ./store.ts, which runs in withOperator (migration 0008 lets only an active
// operator write company_feature_flags). It refuses an unknown flag before anything is written,
// and writes the flag and exactly one audit row in one company transaction, so either both land
// or neither does.

export const FLAG_CHANGED_ACTION = 'feature_flag_changed';

export type FlagWrite = { flag: FlagName; enabled: boolean; updatedByOperatorId: string };

// One row for audit_events. details holds the flag's old and new value only, never an email or token.
export type FlagAuditEvent = {
  operatorActorId: string;
  action: typeof FLAG_CHANGED_ACTION;
  target: FlagName;
  details: { enabled: boolean; previous: boolean };
};

// The work done inside one company's transaction (withOperator, with that company set).
export type FlagChangeTransaction = {
  // The stored value; a missing row is off.
  stored(flag: FlagName): Promise<boolean>;
  write(row: FlagWrite): Promise<void>;
  audit(event: FlagAuditEvent): Promise<void>;
};

export type FlagChangeStore = {
  // Runs `run` in one transaction for this company only; everything in it commits together or not at all.
  inCompany<T>(companyId: string, run: (tx: FlagChangeTransaction) => Promise<T>): Promise<T>;
};

export type FlagChangeResult = { companyId: string; flag: FlagName; enabled: boolean; previous: boolean };

// The operator comes from the verified operator sign-in and the company from the route, both
// checked by the caller; this re-checks their shape so a malformed value never reaches a query.
const changeSchema = z.strictObject({
  operatorActorId: z.uuid(),
  companyId: z.uuid(),
  flag: z.string(),
  enabled: z.boolean(),
});

export async function changeCompanyFlag(store: FlagChangeStore, input: unknown): Promise<FlagChangeResult> {
  const parsed = changeSchema.safeParse(input);
  if (!parsed.success) throw new FlagRefusal('invalid_request');
  const { operatorActorId, companyId, flag, enabled } = parsed.data;
  if (!isFlagName(flag)) throw new FlagRefusal('unknown_flag');

  return store.inCompany(companyId, async (tx) => {
    const previous = await tx.stored(flag);
    await tx.write({ flag, enabled, updatedByOperatorId: operatorActorId });
    await tx.audit({
      operatorActorId,
      action: FLAG_CHANGED_ACTION,
      target: flag,
      details: { enabled, previous },
    });
    return { companyId, flag, enabled, previous };
  });
}
