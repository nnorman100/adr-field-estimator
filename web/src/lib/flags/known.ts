import type { AccessFlags } from '@/lib/access';

// Per-company feature switches (S3-11). The names the app knows are fixed here; a company's
// switches are rows in company_feature_flags (migration 0002), read inside withCompany. Every
// flag is off unless that company has a row with enabled = true, so a new company, a missing row
// and a name not on this list all mean off. Only a platform operator changes a flag (owner
// decision D12); the route is POST /api/platform/companies/{companyId}/flags (S3-11b).

// The six AI feature switches (docs/plans/S7.md section 3, step S7-4). The operator turns one on for
// a company only after that feature's eval passes on `test`; the AI boundary (web/src/lib/ai/call.ts)
// refuses a feature whose switch is not exactly on.
export const AI_FLAG_NAMES = Object.freeze([
  'live_voice',
  'ai_summary',
  'ai_scope_fill',
  'ai_meter_reading',
  'ai_voice_notes',
  'ai_job_summary',
] as const);
export type AiFlagName = (typeof AI_FLAG_NAMES)[number];

// priced_extras (S5b-8): an estimator's proposals and the owner's approvals on a job (today named adjustments
// and hourly additions; see docs/access/approvals.md). Off: every propose and approve route answers 404 and
// the estimate ignores approvals.
export const FLAG_NAMES = Object.freeze(['price_books', 'priced_extras', ...AI_FLAG_NAMES] as const);
export type FlagName = (typeof FLAG_NAMES)[number];

// Every AI switch's owner, purpose and removal date (the Standard's feature-switch rule). The owner
// is a role, never a person's name. A switch is removed, with its row, once its feature is on for
// every company; the date is when that review is due, not an automatic switch-off.
export type FlagDetails = { readonly owner: string; readonly purpose: string; readonly removeBy: string };

const AI_FLAG_OWNER = 'DryScope product owner';
const AI_FLAG_REMOVE_BY = '2027-06-30';

export const AI_FLAG_DETAILS: Readonly<Record<AiFlagName, FlagDetails>> = Object.freeze({
  live_voice: {
    owner: AI_FLAG_OWNER,
    purpose: 'The live voice walkthrough (S7-11 to S7-13): the technician talks the loss through with the AI.',
    removeBy: AI_FLAG_REMOVE_BY,
  },
  ai_summary: {
    owner: AI_FLAG_OWNER,
    purpose: 'The AI draft of the inspection summary (S7-6), which the technician reviews before it is used.',
    removeBy: AI_FLAG_REMOVE_BY,
  },
  ai_scope_fill: {
    owner: AI_FLAG_OWNER,
    purpose: 'AI scope fill from notes (S7-7): proposed room and scope changes, each backed by an exact quote.',
    removeBy: AI_FLAG_REMOVE_BY,
  },
  ai_meter_reading: {
    owner: AI_FLAG_OWNER,
    purpose: 'Reading a moisture meter from its photo (S7-8), proposed to the technician.',
    removeBy: AI_FLAG_REMOVE_BY,
  },
  ai_voice_notes: {
    owner: AI_FLAG_OWNER,
    purpose: 'Transcribing recorded voice notes (S7-9); the audio is not kept.',
    removeBy: AI_FLAG_REMOVE_BY,
  },
  ai_job_summary: {
    owner: AI_FLAG_OWNER,
    purpose: 'The AI job summary for the office (S7-10).',
    removeBy: AI_FLAG_REMOVE_BY,
  },
});

export type CompanyFlags = Readonly<Record<FlagName, boolean>>;

// A stored row as read from company_feature_flags.
export type FlagRow = { flag: string; enabled: boolean };

// Why a flag name or change was refused. Fixed codes only: a refused value is never repeated
// back or logged. company_not_found: the operator named a company that does not exist.
export type FlagRefusalCode = 'unknown_flag' | 'invalid_request' | 'company_not_found';

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
