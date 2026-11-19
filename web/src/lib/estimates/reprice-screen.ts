import type { RepricePreview } from './service';

// What the owner's Reprice banner on Review before signing decides in the browser (S5b-6), as pure
// functions so they are unit-tested. Every price comes from the server's preview; the browser never
// computes one, and every message is fixed text chosen by a code.

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

/** Whether the signed-in person may reprice (the owner's `job_reprice`). */
export function canRepriceOf(me: unknown): boolean {
  const capabilities = field(me, 'capabilities');
  return Array.isArray(capabilities) && capabilities.includes('job_reprice');
}

const priceOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string';

/** The preview answer, checked enough to show it; null for anything else. */
export function repricePreviewOf(body: unknown): RepricePreview | null {
  const job = field(body, 'job');
  if (typeof field(job, 'id') !== 'string' || typeof field(job, 'revision') !== 'number') return null;
  const reprice = field(body, 'reprice');
  if (reprice === null) return body as RepricePreview;
  const pinned = field(reprice, 'pinned');
  const newest = field(reprice, 'newest');
  if (typeof field(pinned, 'version') !== 'number' || !priceOrNull(field(pinned, 'price'))) return null;
  if (typeof field(newest, 'versionId') !== 'string' || typeof field(newest, 'version') !== 'number' || !priceOrNull(field(newest, 'price'))) return null;
  return body as RepricePreview;
}

/** The before and after lines of the preview, in plain words. */
export function repriceLines(preview: NonNullable<RepricePreview['reprice']>): {
  before: string;
  after: string;
} {
  const before = preview.pinned.price
    ? `Now, at prices version ${preview.pinned.version}: ${preview.pinned.price}`
    : `Now priced from prices version ${preview.pinned.version}.`;
  if (preview.newest.refused) {
    return {
      before,
      after: `Prices version ${preview.newest.version} cannot price this job's record as it is. Check the Prices page before repricing.`,
    };
  }
  const after = preview.newest.price
    ? `At prices version ${preview.newest.version}: ${preview.newest.price}`
    : `Would be priced from prices version ${preview.newest.version}.`;
  return { before, after };
}

const OUTCOMES: Record<string, string> = {
  prices_superseded: 'Newer prices were published while you were looking. The preview shows them now; check it again.',
  prices_unchanged: 'This job already uses the newest prices.',
  stale_revision: 'This job changed while you were looking. The preview shows it as it is now; check it again.',
  conflict: 'This reprice was already sent with different details. Reload the job.',
  job_signed: 'This job is signed. A signed job keeps its prices.',
  not_priced: 'This job has not been priced yet, so it has no prices to change.',
  prices_unreadable: 'The newest prices cannot be read. Check the Prices page.',
  not_allowed: 'Only the owner can reprice a job.',
  not_found: 'This job could not be found.',
  archived: 'This job is archived.',
};

/** The message for a refused reprice, by the server's code. */
export function repriceOutcomeOf(status: number, body: unknown): string {
  const code = field(body, 'error');
  const known = typeof code === 'string' ? OUTCOMES[code] : undefined;
  if (known) return known;
  return status === 0 || status >= 500 ? 'We could not reach DryScope. Check your connection, then try again.' : 'Something went wrong. Reload the job.';
}
