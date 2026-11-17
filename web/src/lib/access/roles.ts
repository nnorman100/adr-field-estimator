// Company roles and the capability table, ported from CAPABILITIES in backend/workspaces.py. The
// matrix in docs/access/roles.md is the approved intent; tests/unit/access.test.ts reads that document
// and fails when this table drifts from it. Superadmin is not a company role and is not listed.
export const ROLES = Object.freeze(['owner', 'estimator', 'office'] as const);
export type Role = (typeof ROLES)[number];

// Keys every company has, whatever its switches.
export const BASE_CAPABILITIES = Object.freeze({
  owner: [
    'jobs_read',
    'jobs_create',
    'jobs_copy',
    'coordination',
    'assignment',
    'field_owner_transfer',
    'scope',
    'places',
    'photos',
    'ocr',
    'audit',
    'sign',
    'live',
    'jobs_archive',
    'team_manage',
    'profile_manage',
    'delivery_manage',
    'delivery_resend',
    'quantity_notes_read',
    'retention_manage',
    'ai_usage_read',
  ],
  estimator: [
    'jobs_read',
    'jobs_create',
    'jobs_copy',
    'scope',
    'places',
    'photos',
    'ocr',
    'audit',
    'sign',
    'live',
  ],
  office: [
    'jobs_read',
    'jobs_create',
    'jobs_copy',
    'coordination',
    'assignment',
    'delivery_resend',
  ],
} as const);

// These two exist only while price books are switched on (PRICE_BOOKS_ENABLED today). Everyone may
// read prices; only the owner manages them.
export const PRICE_CAPABILITIES = Object.freeze({
  owner: ['prices_read', 'prices_manage'],
  estimator: ['prices_read'],
  office: ['prices_read'],
} as const);

type BaseCapability = (typeof BASE_CAPABILITIES)[Role][number];
type PriceCapability = (typeof PRICE_CAPABILITIES)[Role][number];
export type Capability = BaseCapability | PriceCapability;

// Every key that can exist: the owner holds all of them.
export const CAPABILITIES: readonly Capability[] = Object.freeze([
  ...BASE_CAPABILITIES.owner,
  ...PRICE_CAPABILITIES.owner,
]);

// Actions only the platform operator takes, each through an operatorRoute under /api/platform/. No
// company role holds them, an owner included, so none is a capability key. The table under
// "Operator-only actions" in docs/access/superadmin.md lists the same names
// (tests/unit/operator-actions.test.ts).
export const OPERATOR_ACTIONS = Object.freeze([
  // S8-3: the records check after a restore, read-only, one audit row per run.
  'records_check',
] as const);
export type OperatorAction = (typeof OPERATOR_ACTIONS)[number];

// The company switches that decide which keys exist. The flag is passed in, not read from the
// environment here, so a caller cannot forget it; the company's switches supply it (web/src/lib/flags/).
export type AccessFlags = { priceBooks: boolean };

export class AccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccessError';
  }
}
