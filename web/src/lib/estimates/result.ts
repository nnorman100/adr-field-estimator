import { z } from 'zod';
import type { Estimate, EstimateDocuments, EstimateEnd, EstimateLine, Json } from '@/engine/estimate';
import type { Capability } from '@/lib/access';
import { PROPOSAL_FORMAT, type Proposal } from './proposal';

// The stored estimate (job_estimates, migration 0011) read back through one schema, and what a
// caller is shown of it. The priced result is the engine's output as stored at the estimate; the
// proposal is the stored bytes. Neither is ever recomputed to show an estimate: a later publish, a
// profile change or an engine release changes nothing already stored.

const money = z.string().regex(/^-?\d+\.\d{2}$/);
const decimal = z.string().regex(/^-?\d+(\.\d+)?$/);
const SHA256 = /^[0-9a-f]{64}$/;

const json: z.ZodType<Json> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(json), z.record(z.string(), json)]),
);
const jsonObject = z.record(z.string(), json);

const endSchema = z.strictObject({
  subtotal: money,
  after_hours: money,
  trade_minimums: z.array(z.strictObject({ trade_id: z.string(), name: z.string(), amount: money })),
  minimum_charge: money,
  overhead_profit: money,
  tax: money,
  total: money,
}) satisfies z.ZodType<EstimateEnd>;

const lineSchema = z.strictObject({
  item_id: z.string().nullable(),
  code: z.string(),
  description: z.string(),
  room: z.string().nullable(),
  group: z.string(),
  bucket: z.string(),
  unit: z.string(),
  quantity: decimal,
  unit_price: decimal,
  waste_percent: decimal,
  total: money,
  taxable: z.boolean(),
  price_bracket: z.strictObject({ up_to_sf: z.number().nullable(), unit_price: z.string() }).nullable(),
}) satisfies z.ZodType<EstimateLine>;

const strings = z.array(z.string());

const documentsSchema = z.strictObject({
  proposal: z.strictObject({
    customer_name: z.string(),
    property_address: z.string(),
    lead_notice_required: z.boolean(),
    findings: strings,
    recommendations: strings,
    disclaimers: strings,
  }),
  letter: z.string(),
  compliance_notes: strings,
  photo_log: z.array(json),
  claim: json,
  itemized_claim: z.array(json),
  unpriced_work: strings,
  signable: z.boolean(),
  staff_notes: z.strictObject({
    summary: z.string(),
    suggestions: strings,
    company_setup_missing: strings,
    quantity_notes: z.array(json),
  }),
}) satisfies z.ZodType<EstimateDocuments>;

export const storedEstimateSchema = z.strictObject({
  ok: z.literal(true),
  engine_version: z.string().regex(/^dryscope-v\d{1,3}$/),
  table_sha256: z.string().regex(SHA256),
  lines: z.array(lineSchema),
  totals: z.strictObject({
    mode: z.enum(['range', 'single']),
    low: endSchema,
    high: endSchema.nullable(),
    labor_material_low: money,
    labor_material_high: money,
    explanation: z.string(),
    range_explanation: z.string().nullable(),
    after_hours_label: z.string(),
  }),
  warnings: z.strictObject({ engine: z.array(jsonObject), advisory: z.array(jsonObject) }),
  // An estimate is always stored with its documents.
  documents: documentsSchema,
  // The job revision whose customer, claim and property address the documents state; null when
  // they had changed between Finish and the first price (src/lib/estimates/service.ts).
  job_revision: z.int().min(1).nullable(),
}) satisfies z.ZodType<Estimate>;

export type StoredEstimate = z.infer<typeof storedEstimateSchema>;

const proposalSchema = z
  .looseObject({ format: z.literal(PROPOSAL_FORMAT), heading: z.string(), basis: z.looseObject({ submission_id: z.string() }) })
  .transform((value) => value as unknown as Proposal);

export class StoredEstimateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoredEstimateError';
  }
}

/** A stored priced result, checked; throws StoredEstimateError on one that does not match the schema. */
export function readStoredEstimate(raw: unknown): StoredEstimate {
  const parsed = storedEstimateSchema.safeParse(raw);
  if (!parsed.success) throw new StoredEstimateError('a stored estimate does not match its schema');
  return parsed.data;
}

/** Stored proposal bytes as the proposal they hold. */
export function readStoredProposal(bytes: Uint8Array): Proposal {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new StoredEstimateError('a stored proposal is not JSON');
  }
  const parsed = proposalSchema.safeParse(raw);
  if (!parsed.success) throw new StoredEstimateError('a stored proposal does not match its format');
  return parsed.data;
}

export type StaffNotesView = {
  summary: string;
  suggestions: string[];
  companySetupMissing: string[];
  // The engine's pricing warnings and its advisory checks, as stored.
  warnings: { engine: Json[]; advisory: Json[] };
  // Only for a caller holding `quantity_notes_read` (docs/ACCESS.md): the key is absent otherwise.
  quantityNotes?: Json[];
};

export type EstimateRecord = {
  id: string;
  jobId: string;
  submissionId: string;
  pinSequence: number;
  versionSequence: number;
  tableHash: string;
  engineVersion: string;
  pricedResult: unknown;
  proposalBytes: Uint8Array;
  proposalSha256: string;
  createdAt: Date;
};

export type EstimateView = {
  id: string;
  jobId: string;
  submissionId: string;
  createdAt: string;
  price: { pinSequence: number; versionSequence: number; tableHash: string; engineVersion: string };
  proposalSha256: string;
  // The proposal exactly as stored and hashed: what the customer is shown and signs.
  proposal: Proposal;
  lines: EstimateLine[];
  totals: StoredEstimate['totals'];
  documents: {
    itemizedClaim: Json[];
    letter: string;
    photoLog: Json[];
    claim: Json;
    complianceNotes: string[];
    unpricedWork: string[];
    signable: boolean;
  };
  staffNotes: StaffNotesView;
  // The customer, claim or property address was saved after the estimate: the documents are
  // rebuilt from the current details at the stored prices, and they cannot be signed.
  needsReview: boolean;
};

/** Documents rebuilt from the record with the job's current details, for an estimate that needs review. */
export type RebuiltDocuments = { documents: EstimateDocuments; proposal: Proposal; proposalSha256: string };

/** What a caller is shown of a stored estimate. The quantity-override note goes only to `quantity_notes_read`. */
export function estimateView(record: EstimateRecord, capabilities: readonly Capability[], rebuilt?: RebuiltDocuments): EstimateView {
  const stored = readStoredEstimate(record.pricedResult);
  const documents = rebuilt?.documents ?? stored.documents;
  const notes = documents.staff_notes;
  const staffNotes: StaffNotesView = {
    summary: notes.summary,
    suggestions: notes.suggestions,
    companySetupMissing: notes.company_setup_missing,
    warnings: { engine: stored.warnings.engine, advisory: stored.warnings.advisory },
  };
  if (capabilities.includes('quantity_notes_read')) staffNotes.quantityNotes = notes.quantity_notes;
  return {
    id: record.id,
    jobId: record.jobId,
    submissionId: record.submissionId,
    createdAt: record.createdAt.toISOString(),
    price: { pinSequence: record.pinSequence, versionSequence: record.versionSequence, tableHash: record.tableHash, engineVersion: record.engineVersion },
    proposalSha256: rebuilt?.proposalSha256 ?? record.proposalSha256,
    proposal: rebuilt?.proposal ?? readStoredProposal(record.proposalBytes),
    lines: stored.lines,
    totals: stored.totals,
    documents: {
      itemizedClaim: documents.itemized_claim,
      letter: documents.letter,
      photoLog: documents.photo_log,
      claim: documents.claim,
      complianceNotes: documents.compliance_notes,
      unpricedWork: documents.unpriced_work,
      signable: documents.signable && !rebuilt,
    },
    staffNotes,
    needsReview: rebuilt !== undefined,
  };
}
