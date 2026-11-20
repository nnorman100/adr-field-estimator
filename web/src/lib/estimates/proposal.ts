import { createHash } from 'node:crypto';
import type { Estimate, EstimateEnd, ProposalEnd, ProposalLetter } from '@/engine/estimate';
import { canonicalJson } from '@/lib/field/canonical';
import type { CompanyDocuments } from '@/lib/profile/documents';

// The proposal as the customer is shown it and signs it (docs/plans/S5.md, S5a-9): one canonical
// JSON text built from the engine's priced result and the company's own document inputs. Its bytes
// and their SHA-256 are stored with the estimate (job_estimates.proposal_bytes), and signing
// (S5a-11) binds to that hash, so the review screen shows the proposal from these bytes, never from
// a copy rebuilt in the browser. Prices and the mandatory wording come only from the engine; nothing
// here writes a sentence of its own except the heading and the letterhead labels.
//
// Since S5a-11 (format v2) the proposal also holds the company's start-work authorization and payment
// terms (S5a-4b document settings), exactly as the owner entered them, so the signature binds them
// with everything else. A v1 proposal, made before, has neither and is never signable.
//
// Since S5a-9b the proposal is laid out as the company chose (its document settings): the itemized
// proposal (the default, S5a-9's), or one plain letter (`letter`, built by the engine, in place of the
// itemized findings and scope list). The company's own clauses (`company_clauses`) are added text,
// printed exactly as entered after the recommendations and before the standard clauses. Each key is
// present only when the company set it, so a company with no settings gets S5a-9's bytes exactly.
//
// Since S5b-6 (D6, 2026-11-13) a revised estimate, one made for a job that already had an estimate
// (after a reprice or Back to editing), carries `revised`: "Revised {date}", or "Revised {date}: was
// {previous price}" when the company shows the previous price. The key is absent on a first estimate,
// so every proposal made before, and every signed one, keeps its bytes.

export const PROPOSAL_FORMAT = 'dryscope-proposal-v2';
export const PROPOSAL_FORMATS = ['dryscope-proposal-v1', PROPOSAL_FORMAT] as const;

export type ProposalPrice = {
  mode: 'range' | 'single';
  // The itemized total at the company's base rates (the low end).
  itemized_total: string;
  low: ProposalEnd;
  high: ProposalEnd | null;
  explanation: string | null;
  // The price table's name for the after-hours adjustment.
  after_hours_label: string;
  // Each line's description and price, only when the price table shows the line breakdown.
  lines?: Array<{ description: string; quantity: string; unit: string; total: string }>;
  // Written only on a letter that prints its line prices (S4-4e): the proposal then also prints the
  // stored charge rows, so its lines add up to the total. A letter signed before has no such key.
  charge_rows?: true;
};

// The itemized layout's findings and scope list, or the letter's sections: never both.
type ProposalBody =
  | { findings: string[]; recommendations: string[]; letter?: never }
  | { letter: ProposalLetter; findings?: never; recommendations?: never };

export type Proposal = ProposalBody & {
  format: (typeof PROPOSAL_FORMATS)[number];
  heading: string;
  // S5b-6: the revised estimate's line under the heading (absent on a first estimate).
  revised?: string;
  letterhead: string[];
  customer_name: string;
  property_address: string;
  lead_notice_required: boolean;
  disclaimers: string[];
  // The company's own clauses, exactly as entered (only when it has any).
  company_clauses?: Array<{ title: string; text: string }>;
  price: ProposalPrice;
  // Printed above the signature, each exactly as the company entered it (absent in v1).
  authorization_text?: string;
  payment_terms_text?: string;
  // What this proposal was built from: the submitted record and the pinned price version.
  basis: { submission_id: string; snapshot_sha256: string; price_version: number; content_sha256: string; engine_version: string };
};

export type ProposalInput = {
  estimate: Estimate;
  company: CompanyDocuments;
  showLineBreakdown: boolean;
  submission: { id: string; snapshotSha256: string };
  version: { sequence: number };
  // The revised line, made once when the estimate is made; it is kept only in the proposal's bytes.
  revised?: string | null;
};

/** The heading ARCHITECTURE.md's product rules give the proposal: "[Company] · Official proposal". */
export function proposalHeading(name: string): string {
  return name.trim() ? `${name} · Official proposal` : 'Official proposal';
}

/** The letterhead lines that are set, in print order, each exactly as the company entered it. */
export function letterheadLines(company: CompanyDocuments): string[] {
  const { identity, letterhead } = company;
  const lines = [
    identity.name,
    letterhead.tagline,
    identity.address,
    letterhead.mailingAddress ? `Mailing address: ${letterhead.mailingAddress}` : '',
    identity.phone,
    letterhead.emergencyPhone ? `Emergency: ${letterhead.emergencyPhone}` : '',
    letterhead.fax ? `Fax: ${letterhead.fax}` : '',
    identity.email,
    letterhead.website,
    // The engine's licence label (docs/ARCHITECTURE.md, Product rules §4C item 2 holds it for review).
    identity.license.trim() ? `CSLB #${identity.license}` : '',
  ];
  return lines.filter((line) => line.trim() !== '');
}

// The proposal prints the adjustment's name and amounts only: the table's catalog id stays in the stored estimate.
function proposalEnd(end: EstimateEnd): ProposalEnd {
  const { adjustment, ...rest } = end;
  if (!adjustment) return rest;
  return { ...rest, adjustment: { name: adjustment.name, direction: adjustment.direction, before: adjustment.before, amount: adjustment.amount, after: adjustment.after } };
}

export function proposalOf(input: ProposalInput): Proposal {
  const { estimate, company } = input;
  const documents = estimate.documents;
  if (!documents) throw new Error('a proposal needs the priced documents');
  const totals = estimate.totals;
  const price: ProposalPrice = {
    mode: totals.mode,
    itemized_total: totals.low.total,
    low: proposalEnd(totals.low),
    high: totals.mode === 'range' && totals.high ? proposalEnd(totals.high) : null,
    explanation: totals.mode === 'range' ? totals.range_explanation : totals.explanation,
    after_hours_label: totals.after_hours_label,
  };
  const proposal = documents.proposal;
  // The letter's own lines carry their prices, so its price is the one price line.
  if (input.showLineBreakdown && !proposal.letter) {
    price.lines = estimate.lines.map((line) => ({ description: line.description, quantity: line.quantity, unit: line.unit, total: line.total }));
  }
  if (proposal.letter && [...proposal.letter.job_work, ...proposal.letter.room_work.flatMap((room) => room.lines)].some((line) => line.total !== undefined)) {
    price.charge_rows = true;
  }
  const body: ProposalBody = proposal.letter ? { letter: proposal.letter } : { findings: proposal.findings, recommendations: proposal.recommendations };
  return {
    format: PROPOSAL_FORMAT,
    heading: proposalHeading(company.identity.name),
    ...(input.revised ? { revised: input.revised } : {}),
    letterhead: letterheadLines(company),
    customer_name: proposal.customer_name,
    property_address: proposal.property_address,
    lead_notice_required: proposal.lead_notice_required,
    ...body,
    disclaimers: proposal.disclaimers,
    ...(proposal.company_clauses ? { company_clauses: proposal.company_clauses } : {}),
    price,
    authorization_text: company.signing.authorizationText,
    payment_terms_text: company.signing.paymentTermsText,
    basis: {
      submission_id: input.submission.id,
      snapshot_sha256: input.submission.snapshotSha256,
      price_version: input.version.sequence,
      content_sha256: estimate.table_sha256,
      engine_version: estimate.engine_version,
    },
  };
}

/**
 * The revised estimate's line (S5b-6, D6): "Revised {date}", with the price it replaces added as "was
 * {price}". A revision of a signed agreement always names the signed price, whatever the setting;
 * before signing the previous estimate's price is named only when the company shows it. The date is
 * the day the estimate is made (UTC), written out.
 */
export function revisedLine(made: Date, prices: { previous: string | null; signed: string | null; showPrevious: boolean }): string {
  const day = new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' }).format(made);
  const was = prices.signed ?? (prices.showPrevious ? prices.previous : null);
  return was ? `Revised ${day}: was ${was}` : `Revised ${day}`;
}

/** The stored bytes of a proposal (canonical JSON, UTF-8) and their SHA-256. */
/** Whether a proposal holds both texts the signed page needs, so it may be signed. */
export function hasSigningTexts(proposal: Proposal): boolean {
  return proposal.format === PROPOSAL_FORMAT && !!proposal.authorization_text?.trim() && !!proposal.payment_terms_text?.trim();
}

export function proposalBytes(proposal: Proposal): { bytes: Buffer; sha256: string } {
  const bytes = Buffer.from(canonicalJson(proposal), 'utf8');
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}
