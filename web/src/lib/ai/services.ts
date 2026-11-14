import type { Database } from '@/db/tenant';
import { serverDatabase } from '@/lib/auth/services';
import { parseLocalSignInFixture } from '@/lib/config';
import { postgresAiBudget, type AiUsage } from './budget';
import { AI_CEILING_DEFAULTS } from './ceilings';
import { setCompanyAiCeilings, type AiSettingsInput, type AiSettingsResult } from './settings';
import { secondsUntilNextUtcDay, secondsUntilNextUtcMonth, utcDay } from './utc';

// What the AI usage and AI settings routes need (web/src/lib/ai/http.ts).
export type AiBudgetServices = {
  usage(companyId: string, at: Date): Promise<AiUsage>;
  setCeilings(operatorId: string, companyId: string, input: AiSettingsInput): Promise<AiSettingsResult>;
};

export function aiBudgetService(db: Database): AiBudgetServices {
  const budget = postgresAiBudget(db);
  return {
    usage: (companyId, at) => budget.usage(companyId, at),
    setCeilings: (operatorId, companyId, input) => setCompanyAiCeilings(db, operatorId, companyId, input),
  };
}

// On a developer machine beside the Auth emulator (LOCAL_SIGN_IN_FIXTURE, which the configuration
// refuses anywhere else) there is no database and so no AI call: every company has spent nothing
// against the default ceilings. tests/e2e/company.spec.ts drives the Company settings screen with it.
// No operator route works there.
function localAiBudgetService(): AiBudgetServices {
  const period = (period: string, ceilingMicroUsd: number, at: Date, seconds: number) => ({
    period,
    ceilingMicroUsd,
    ceilingSet: false,
    usedMicroUsd: 0,
    heldMicroUsd: 0,
    resetsAt: new Date(Math.floor(at.getTime() / 1000) * 1000 + seconds * 1000).toISOString(),
  });
  return {
    async usage(_companyId, at) {
      return {
        today: period(utcDay(at), AI_CEILING_DEFAULTS.dailyMicroUsd, at, secondsUntilNextUtcDay(at)),
        thisMonth: period(utcDay(at).slice(0, 7), AI_CEILING_DEFAULTS.monthlyMicroUsd, at, secondsUntilNextUtcMonth(at)),
      };
    },
    async setCeilings() {
      throw new Error('AI settings need the database');
    },
  };
}

let service: AiBudgetServices | null = null;

// Built on the first request from the checked server configuration, then reused. A missing or
// invalid setting throws, and that request fails closed.
export function aiBudgetServices(): AiBudgetServices {
  service ??= parseLocalSignInFixture(process.env) ? localAiBudgetService() : aiBudgetService(serverDatabase());
  return service;
}
