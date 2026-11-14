// The UTC calendar the AI ceilings and quotas count in (docs/plans/S7.md section 3: "per UTC day and
// per UTC month"). A reservation counts against the day and month it was made in, and keeps them when
// it settles later, so a late settlement never moves spending into the next day or month.

const DAY_MS = 24 * 60 * 60 * 1000;

// YYYY-MM-DD, the ledger's utc_day.
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

// The first day of the month, YYYY-MM-01, the ledger's utc_month.
export function utcMonth(at: Date): string {
  return `${at.toISOString().slice(0, 7)}-01`;
}

// Whole seconds from `at` until the next UTC midnight, at least 1 (a Retry-After value).
export function secondsUntilNextUtcDay(at: Date): number {
  const next = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()) + DAY_MS;
  return Math.max(1, Math.ceil((next - at.getTime()) / 1000));
}

// Whole seconds from `at` until the first moment of the next UTC month, at least 1.
export function secondsUntilNextUtcMonth(at: Date): number {
  const next = Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1);
  return Math.max(1, Math.ceil((next - at.getTime()) / 1000));
}
