// Company roles and the capability table, ported from CAPABILITIES in backend/workspaces.py. The
// matrix in docs/ACCESS.md is the approved intent; tests/unit/access.test.ts reads that document
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

// The company switches that decide which keys exist. The flag is passed in, not read from the
// environment here, so a caller cannot forget it; the company's switches supply it (web/src/lib/flags/).
export type AccessFlags = { priceBooks: boolean };

export class AccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccessError';
  }
}
