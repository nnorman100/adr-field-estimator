import type { EstimateEnd } from '@/engine/estimate';
import type { EstimateView } from './result';

// What the Review before signing screen decides in the browser, as pure functions so they are
// unit-tested. Everything here is presentation: every amount and every sentence of the documents
// comes from the server's stored estimate (src/lib/estimates/service.ts), and the browser never
// computes a price. Words come from fixed codes only; nothing the person typed goes into a message.

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

// GET /api/me's answer: whether the role may price the job (`audit`: owner, estimator) and may
// sign it (`sign`), which is who confirms the documents. null for an answer of an unexpected shape.
export type Reviewer = { canPrice: boolean; canSign: boolean };

export function reviewerOf(body: unknown): Reviewer | null {
  const capabilities = field(body, 'capabilities');
  if (!Array.isArray(capabilities)) return null;
  return { canPrice: capabilities.includes('audit'), canSign: capabilities.includes('sign') };
}

export type ReviewJob = { id: string; status: string; currentDraftId: string };

export type ReviewAnswer = { job: ReviewJob; estimate: EstimateView | null };

// The estimate routes' answer. The estimate's own shape is the server's (checked there against the
// stored schema); here only enough is checked to know it is an answer of these routes.
export function reviewAnswerOf(body: unknown): ReviewAnswer | null {
  const job = field(body, 'job');
  const id = field(job, 'id');
  const status = field(job, 'status');
  const currentDraftId = field(job, 'currentDraftId');
  if (typeof id !== 'string' || typeof status !== 'string' || typeof currentDraftId !== 'string') return null;
  const estimate = field(body, 'estimate');
  if (estimate === null) return { job: { id, status, currentDraftId }, estimate: null };
  if (typeof field(estimate, 'id') !== 'string' || !Array.isArray(field(estimate, 'lines')) || typeof field(estimate, 'proposal') !== 'object') return null;
  return { job: { id, status, currentDraftId }, estimate: estimate as EstimateView };
}

/** A money string from the server ("1234.50") as the documents print it ("$1,234.50"). No arithmetic. */
export function dollars(amount: string): string {
  const match = /^(-?)(\d+)\.(\d{2})$/.exec(amount);
  if (!match) return amount;
  const [, sign, whole, cents] = match;
  return `${sign}$${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${cents}`;
}

/** The customer price, and the itemized total beside it (ARCHITECTURE.md, Product rules §2). */
export function priceLines(totals: EstimateView['totals']): { customer: string; itemized: string } {
  const itemized = `Itemized total: ${dollars(totals.low.total)}`;
  if (totals.mode === 'single' || !totals.high) return { customer: `Price: ${dollars(totals.low.total)}`, itemized };
  return { customer: `Customer estimate range: ${dollars(totals.low.total)} to ${dollars(totals.high.total)}`, itemized };
}

/** One end's charges in the order the engine adds them into its total: the subtotal, then each adjustment it charged. */
export function chargeRows(end: EstimateEnd, afterHoursLabel: string): Array<{ label: string; amount: string }> {
  const adjustments = [
    { label: afterHoursLabel, amount: end.after_hours },
    ...end.trade_minimums.map((row) => ({ label: `${row.name} trade minimum`, amount: row.amount })),
    { label: 'Minimum job charge', amount: end.minimum_charge },
    { label: 'Overhead and profit', amount: end.overhead_profit },
    { label: 'Sales tax', amount: end.tax },
  ];
  return [{ label: 'Subtotal', amount: end.subtotal }, ...adjustments.filter((row) => row.amount !== '0.00')];
}

// The engine's pricing warnings by code (src/engine/price-v2.ts), in plain words. The advisory
// checks carry their own sentence (`text`).
const WARNINGS: Record<string, string> = {
  missing_mold_condition: 'A mold room has no mold condition, so an item that needs one has no line',
  missing_affected_area: 'A mold room has no affected area, so an item that needs one has no line',
  missing_size: 'A room has no size, so a per-room item has no line',
  missing_area: 'A room has no area for an item, so that item has no line',
  unknown_scope_item: 'A quantity names an item the prices do not have',
  unknown_quantity_override: 'A quantity change names a value the job does not have',
  unpriced_extras_quantity: 'Additional work has no price for its quantity',
  blank_price_item: 'An item has no price',
};

export function warningText(warning: unknown): string {
  const text = field(warning, 'text');
  if (typeof text === 'string' && text.trim()) return text;
  const code = field(warning, 'code');
  const room = field(warning, 'room');
  const known = typeof code === 'string' ? WARNINGS[code] : undefined;
  const sentence = known ?? 'A pricing check needs a look';
  return typeof room === 'string' && room ? `${sentence} (${room}).` : `${sentence}.`;
}

/** One photo of the audit log as a line: its number, room, shot tag and the start of its stored hash. */
export function photoLine(photo: unknown, index: number): string {
  const room = field(photo, 'room');
  const tag = field(photo, 'shot_tag');
  const sha = field(photo, 'sha256');
  return [
    `Photo ${index + 1}`,
    typeof room === 'string' ? room : '',
    typeof tag === 'string' ? `shot: ${tag}` : '',
    typeof sha === 'string' ? `SHA-256 ${sha.slice(0, 12)}…` : '',
  ]
    .filter((part) => part)
    .join(' · ');
}

/** One quantity-override note, as the owner reads it. */
export function quantityNoteLine(note: unknown): string {
  const label = String(field(note, 'label') ?? '');
  const room = field(note, 'room');
  return [`${label}${typeof room === 'string' && room ? ` (${room})` : ''}`, `measured ${String(field(note, 'measured') ?? '')}, entered ${String(field(note, 'entered') ?? '')}`, `Reason: ${String(field(note, 'reason') ?? '')}`].join(' · ');
}

/** Why these documents cannot be signed yet, in the order to fix them; empty when they can. */
export function notReadyReasons(estimate: EstimateView): string[] {
  if (estimate.documents.signable) return [];
  const reasons: string[] = [];
  for (const missing of estimate.staffNotes.companySetupMissing) reasons.push(`Company settings: ${missing} is not filled in. The owner adds it on Company settings.`);
  if (estimate.documents.unpricedWork.length) reasons.push('Some work has no price. Go back to editing and change the scope.');
  if (reasons.length === 0) reasons.push('The scope has no priced work yet. Go back to editing and add the work.');
  return reasons;
}

export type Next = 'retry' | 'reload' | 'done';

const OUTCOMES: Record<string, { message: string; next: Next }> = {
  estimates_unavailable: { message: 'We could not reach DryScope. Check your connection, then try again.', next: 'retry' },
  prices_not_set: { message: 'Your company has no published prices yet. The owner publishes them on the Prices page; then price this job.', next: 'done' },
  scope_not_confirmed: { message: 'The scope was not confirmed when this job was finished. Go back to editing, confirm the scope, then finish again.', next: 'done' },
  summary_missing: { message: 'This job was finished without a summary of findings. Go back to editing, write it, then finish again.', next: 'done' },
  not_submitted: { message: 'This job is still being edited. Finish and review it first.', next: 'reload' },
  job_signed: { message: 'This job is signed. Its signed documents do not change.', next: 'reload' },
  details_changed: {
    message: 'The customer, claim or property address changed after this job was finished. Go back to editing, then finish again so the documents show it.',
    next: 'done',
  },
  record_unreadable: { message: 'This record cannot be priced as it is. Go back to editing, then finish again.', next: 'done' },
  prices_unreadable: { message: 'The prices this job is pinned to cannot be read. Ask the owner to check the Prices page.', next: 'done' },
  not_allowed: { message: 'Only the owner or the estimator on this job can price it.', next: 'done' },
  not_found: { message: 'This job could not be found.', next: 'done' },
  archived: { message: 'This job is archived.', next: 'done' },
};

// The engine's own refusals (estimate_refused) by stage.
const REFUSED: Record<string, string> = {
  inspection: 'The record has a value the prices cannot use. Go back to editing, check the rooms and quantities, then finish again.',
  pricing: 'The record could not be priced. Go back to editing, check the rooms and quantities, then finish again.',
  documents: 'The documents need the property address, the year built and at least one room. Add them, then finish again.',
};

export function outcomeOf(status: number, body: unknown): { message: string; next: Next } {
  const code = field(body, 'error');
  if (code === 'estimate_refused') {
    const stage = field(body, 'stage');
    return { message: (typeof stage === 'string' ? REFUSED[stage] : undefined) ?? REFUSED.pricing!, next: 'done' };
  }
  const known = typeof code === 'string' ? OUTCOMES[code] : undefined;
  if (known) return known;
  return status === 0 || status >= 500 ? OUTCOMES.estimates_unavailable! : { message: 'Something went wrong. Reload the job.', next: 'reload' };
}
