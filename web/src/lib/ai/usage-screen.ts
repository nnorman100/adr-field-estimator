// What the Company settings screen decides about the AI use lines in the browser (S7-4), as pure
// functions so they are unit-tested. Everything here is convenience: the server checks the sign-in,
// the company and ai_usage_read again on every call (web/src/lib/ai/http.ts), so a wrong answer
// here shows the wrong lines but never grants anything. This module imports nothing from the server.

export type AiUsagePeriodView = {
  period: string;
  ceilingMicroUsd: number;
  ceilingSet: boolean;
  usedMicroUsd: number;
  heldMicroUsd: number;
  resetsAt: string;
};
export type AiUsageView = { today: AiUsagePeriodView; thisMonth: AiUsagePeriodView };

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

const amount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function periodView(value: unknown): AiUsagePeriodView | null {
  const [period, ceilingMicroUsd, ceilingSet, usedMicroUsd, heldMicroUsd, resetsAt] = [
    'period',
    'ceilingMicroUsd',
    'ceilingSet',
    'usedMicroUsd',
    'heldMicroUsd',
    'resetsAt',
  ].map((key) => field(value, key));
  if (typeof period !== 'string' || typeof resetsAt !== 'string' || typeof ceilingSet !== 'boolean') return null;
  if (!amount(ceilingMicroUsd) || !amount(usedMicroUsd) || !amount(heldMicroUsd) || heldMicroUsd > usedMicroUsd) return null;
  return { period, ceilingMicroUsd, ceilingSet, usedMicroUsd, heldMicroUsd, resetsAt };
}

// GET /api/companies/{id}/ai-usage's answer, or null when it is not the shape the server sends.
export function aiUsageView(body: unknown): AiUsageView | null {
  const today = periodView(field(body, 'today'));
  const thisMonth = periodView(field(body, 'thisMonth'));
  return today && thisMonth ? { today, thisMonth } : null;
}

// Whether GET /api/me's answer holds ai_usage_read, so the screen asks for the usage at all.
export function canReadAiUsage(meBody: unknown): boolean {
  const capabilities = field(meBody, 'capabilities');
  return Array.isArray(capabilities) && capabilities.includes('ai_usage_read');
}

const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Micro-USD as dollars and cents. What was used is rounded up to the next cent, so the screen never
// shows less than the ledger counts; a ceiling is shown as set.
export function formatMicroUsd(microUsd: number, round: 'up' | 'down' = 'up'): string {
  const cents = round === 'up' ? Math.ceil(microUsd / 10_000) : Math.floor(microUsd / 10_000);
  return dollars.format(cents / 100);
}

// "$0.06 of $10.00"
export function usedOf(period: AiUsagePeriodView): string {
  return `${formatMicroUsd(period.usedMicroUsd)} of ${formatMicroUsd(period.ceilingMicroUsd, 'down')}`;
}
