import type { AccessFlags } from '@/lib/access';

// Per-company feature switches (S3-11). The names the app knows are fixed here; a company's
// switches are rows in company_feature_flags (migration 0002), read inside withCompany. Every
// flag is off unless that company has a row with enabled = true, so a new company, a missing row
// and a name not on this list all mean off. Only a platform operator changes a flag (owner
// decision D12); that route and its database write path come with S3-11b.

export const FLAG_NAMES = Object.freeze(['price_books'] as const);
export type FlagName = (typeof FLAG_NAMES)[number];

export type CompanyFlags = Readonly<Record<FlagName, boolean>>;

// A stored row as read from company_feature_flags.
export type FlagRow = { flag: string; enabled: boolean };

// Why a flag name or change was refused. Fixed codes only: a refused value is never repeated
// back or logged.
export type FlagRefusalCode = 'unknown_flag' | 'invalid_request';

export class FlagRefusal extends Error {
  constructor(readonly code: FlagRefusalCode) {
    super(`Feature flag refused: ${code}`);
    this.name = 'FlagRefusal';
  }
}

// Set.has, never property access, so "constructor" or "__proto__" is an unknown name like any other.
const NAMES: ReadonlySet<unknown> = new Set(FLAG_NAMES);

export function isFlagName(value: unknown): value is FlagName {
  return NAMES.has(value);
}

export function parseFlagName(value: unknown): FlagName {
  if (!isFlagName(value)) throw new FlagRefusal('unknown_flag');
  return value;
}

// Every known flag off.
export const ALL_OFF: CompanyFlags = Object.freeze(
  Object.fromEntries(FLAG_NAMES.map((name) => [name, false])) as Record<FlagName, boolean>,
);

// A company's switches from its stored rows. Only a known name with enabled exactly true is on;
// an unknown stored name is ignored rather than trusted.
export function flagsFromRows(rows: readonly FlagRow[] | null | undefined): CompanyFlags {
  const flags: Record<FlagName, boolean> = { ...ALL_OFF };
  for (const row of rows ?? []) {
    if (isFlagName(row?.flag) && row.enabled === true) flags[row.flag] = true;
  }
  return Object.freeze(flags);
}

// The switches the capability table reads (web/src/lib/access/).
export function accessFlags(flags: CompanyFlags): AccessFlags {
  return { priceBooks: flags.price_books === true };
}
