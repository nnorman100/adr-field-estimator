import { refusedText } from './screen';
import type { PricedSide, RepricePreview } from './service';

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

// A priced side: a price, or the engine's refusal stage, never both and never neither.
function sideOf(value: unknown): boolean {
  const price = field(value, 'price');
  const refused = field(value, 'refused');
  if (typeof price === 'string') return refused === null;
  return price === null && typeof field(refused, 'stage') === 'string';
}

/** The preview answer, checked enough to show it; null for anything else. */
export function repricePreviewOf(body: unknown): RepricePreview | null {
  if (typeof field(field(body, 'job'), 'revision') !== 'number') return null;
  const reprice = field(body, 'reprice');
  if (reprice === null) return body as RepricePreview;
  const pinned = field(reprice, 'pinned');
  const newest = field(reprice, 'newest');
  if (typeof field(pinned, 'version') !== 'number' || !sideOf(pinned)) return null;
  if (typeof field(newest, 'versionId') !== 'string' || typeof field(newest, 'version') !== 'number' || !sideOf(newest)) return null;
  return body as RepricePreview;
}

const side = (version: number, priced: PricedSide): string =>
  `Last submitted scope at prices version ${version}: ${priced.refused ? `cannot be priced. ${refusedText(priced.refused.stage)}` : priced.price}`;

/**
 * The before and after lines of the preview, in plain words. Both amounts are the job's last
 * submitted scope; a draft being edited is not in them.
 */
export function repriceLines(preview: NonNullable<RepricePreview['reprice']>): {
  before: string;
  after: string;
} {
  return { before: side(preview.pinned.version, preview.pinned), after: side(preview.newest.version, preview.newest) };
}

/**
 * Whether a refusal says the screen is out of date or the person's access to the job is gone: the
 * job was signed or changed elsewhere, the sign-in is no longer accepted, or the job is no longer
 * theirs to see. Review then reads the job and
 * its estimate again instead of keeping what it shows.
 */
export function screenOutOfDate(status: number, body: unknown): boolean {
  const code = field(body, 'error');
  return code === 'stale_revision' || code === 'job_signed' || status === 401 || status === 403 || status === 404 || status === 410;
}

const OUTCOMES: Record<string, string> = {
  prices_superseded: 'Newer prices were published while you were looking. The preview shows them now; check it again.',
  prices_unreadable: 'The newest prices cannot be read. Check the Prices page.',
};

/** The message for a refused reprice, by the server's code. */
export function repriceOutcomeOf(body: unknown): string {
  const code = field(body, 'error');
  const known = typeof code === 'string' ? OUTCOMES[code] : undefined;
  if (known) return known;
  return 'Something went wrong. Reload the job.';
}
