import { createHash } from 'node:crypto';
import type { Estimate, EstimateEnd } from '@/engine/estimate';
import { canonicalJson } from '@/lib/field/canonical';
import type { CompanyDocuments } from '@/lib/profile/documents';

// The proposal as the customer is shown it and signs it (docs/plans/S5.md, S5a-9): one canonical
// JSON text built from the engine's priced result and the company's own document inputs. Its bytes
// and their SHA-256 are stored with the estimate (job_estimates.proposal_bytes), and signing
// (S5a-11) binds to that hash, so the review screen shows the proposal from these bytes, never from
// a copy rebuilt in the browser. Prices and the mandatory wording come only from the engine; nothing
// here writes a sentence of its own except the heading and the letterhead labels.

export const PROPOSAL_FORMAT = 'dryscope-proposal-v1';

export type ProposalPrice = {
  mode: 'range' | 'single';
  // The itemized total at the company's base rates (the low end).
  itemized_total: string;
  low: EstimateEnd;
  high: EstimateEnd | null;
  explanation: string | null;
  // The price table's name for the after-hours adjustment.
  after_hours_label: string;
  // Each line's description and price, only when the price table shows the line breakdown.
  lines?: Array<{ description: string; quantity: string; unit: string; total: string }>;
};

export type Proposal = {
  format: typeof PROPOSAL_FORMAT;
  heading: string;
  letterhead: string[];
  customer_name: string;
  property_address: string;
  lead_notice_required: boolean;
  findings: string[];
  recommendations: string[];
  disclaimers: string[];
  price: ProposalPrice;
  // What this proposal was built from: the submitted record and the pinned price version.
  basis: { submission_id: string; snapshot_sha256: string; price_version: number; content_sha256: string; engine_version: string };
};

export type ProposalInput = {
  estimate: Estimate;
  company: CompanyDocuments;
  showLineBreakdown: boolean;
  submission: { id: string; snapshotSha256: string };
  version: { sequence: number };
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

export function proposalOf(input: ProposalInput): Proposal {
  const { estimate, company } = input;
  const documents = estimate.documents;
  if (!documents) throw new Error('a proposal needs the priced documents');
  const totals = estimate.totals;
  const price: ProposalPrice = {
    mode: totals.mode,
    itemized_total: totals.low.total,
    low: totals.low,
    high: totals.mode === 'range' ? totals.high : null,
    explanation: totals.mode === 'range' ? totals.range_explanation : totals.explanation,
    after_hours_label: totals.after_hours_label,
  };
  if (input.showLineBreakdown) {
    price.lines = estimate.lines.map((line) => ({ description: line.description, quantity: line.quantity, unit: line.unit, total: line.total }));
  }
  const proposal = documents.proposal;
  return {
    format: PROPOSAL_FORMAT,
    heading: proposalHeading(company.identity.name),
    letterhead: letterheadLines(company),
    customer_name: proposal.customer_name,
    property_address: proposal.property_address,
    lead_notice_required: proposal.lead_notice_required,
    findings: proposal.findings,
    recommendations: proposal.recommendations,
    disclaimers: proposal.disclaimers,
    price,
    basis: {
      submission_id: input.submission.id,
      snapshot_sha256: input.submission.snapshotSha256,
      price_version: input.version.sequence,
      content_sha256: estimate.table_sha256,
      engine_version: estimate.engine_version,
    },
  };
}

/** The stored bytes of a proposal (canonical JSON, UTF-8) and their SHA-256. */
export function proposalBytes(proposal: Proposal): { bytes: Buffer; sha256: string } {
  const bytes = Buffer.from(canonicalJson(proposal), 'utf8');
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}
