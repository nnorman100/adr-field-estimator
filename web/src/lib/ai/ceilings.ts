// A company's AI spending ceilings, in whole micro-USD of Google's bill, counting every AI feature
// together per UTC day and per UTC month (docs/plans/S7.md section 3, "Budgets are reserved before
// work").
//
// Owner decision V5 B (2026-11-12): with nothing stored, $10 a day and $200 a month per company. The
// platform operator may store explicit ceilings for a company (company_ai_settings, migration 0012;
// the route is S7-4), and an explicit value replaces the default for its period only. The test
// companies' ceilings (the staff test company $5 a day and $100 a month, any other test company $1
// and $10) are such stored values, set by the owner in cloud step H; they are never code.

export type AiCeilings = { readonly dailyMicroUsd: number; readonly monthlyMicroUsd: number };

export const AI_CEILING_DEFAULTS: AiCeilings = Object.freeze({
  dailyMicroUsd: 10_000_000,
  monthlyMicroUsd: 200_000_000,
});

// The stored ceilings, as company_ai_settings holds them: null is "not set", so the default applies.
export type StoredCeilings = {
  dailyCeilingMicroUsd: number | null;
  monthlyCeilingMicroUsd: number | null;
};

export function effectiveCeilings(stored: StoredCeilings | null | undefined): AiCeilings {
  return {
    dailyMicroUsd: stored?.dailyCeilingMicroUsd ?? AI_CEILING_DEFAULTS.dailyMicroUsd,
    monthlyMicroUsd: stored?.monthlyCeilingMicroUsd ?? AI_CEILING_DEFAULTS.monthlyMicroUsd,
  };
}
