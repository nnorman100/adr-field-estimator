// The stable engine entry: plain JSON in, plain JSON out, money as Decimal strings.
// Routes and tests call only priceEstimate and checkTable; the files behind them change in S4-4.

import { Dec, money } from './decimal';
import { isObj, type JObj, type Json } from './json';
import { checkOverrides, distinctRooms, validateInspection, type Inspection } from './inspection';
import { checkPublishable, contentHash, parseTable, type Table } from './table';
import { priceAndRange, type End, type Priced } from './totals';
import { advisoryWarnings } from './warnings';
import { makeDocuments } from './documents';
import type { PriceLine } from './values';

export type { Json };

/** A saved draft to price. `documents` is optional: without it only lines and totals are built. */
export type EstimateJob = {
  inspection: Json;
  documents?: {
    company?: Json;
    claim?: Json;
    photos?: Json[];
    ai: Json;
    customer_name?: string;
  };
};

export type EstimateLine = {
  item_id: string | null;
  code: string;
  description: string;
  room: string | null;
  group: string;
  bucket: string;
  unit: string;
  quantity: string;
  unit_price: string;
  waste_percent: string;
  total: string;
  taxable: boolean;
  price_bracket: { up_to_sf: number | null; unit_price: string } | null;
};

export type EstimateEnd = {
  subtotal: string;
  after_hours: string;
  minimum_charge: string;
  overhead_profit: string;
  tax: string;
  total: string;
};

export type EstimateDocuments = {
  proposal: {
    customer_name: string;
    property_address: string;
    lead_notice_required: boolean;
    findings: string[];
    recommendations: string[];
    disclaimers: string[];
  };
  letter: string;
  compliance_notes: string[];
  photo_log: Json[];
  claim: Json;
  unpriced_work: string[];
  signable: boolean;
};

export type Estimate = {
  ok: true;
  engine_version: string;
  table_sha256: string;
  lines: EstimateLine[];
  totals: {
    mode: 'range' | 'single';
    low: EstimateEnd;
    high: EstimateEnd | null;
    labor_material_low: string;
    labor_material_high: string;
    explanation: string;
    range_explanation: string | null;
  };
  warnings: { engine: Json[]; advisory: Json[] };
  documents: EstimateDocuments | null;
};

export type Refusal = {
  ok: false;
  stage: 'table' | 'inspection' | 'pricing' | 'documents';
  error: string;
};

function text(value: Dec): string {
  return value.normalize().format('f');
}

function cents(value: Dec): string {
  return money(value).toString();
}

function lineOf(line: PriceLine): EstimateLine {
  return {
    item_id: line.itemId,
    code: line.code,
    description: line.description,
    room: line.room,
    group: line.group,
    bucket: line.bucket,
    unit: line.unit,
    quantity: text(line.quantity),
    unit_price: text(line.unitPrice),
    waste_percent: text(line.waste),
    total: cents(line.total),
    taxable: line.taxable,
    price_bracket: line.priceBracket
      ? { up_to_sf: line.priceBracket.upToSf, unit_price: line.priceBracket.unitPrice }
      : null,
  };
}

function endOf(end: End): EstimateEnd {
  return {
    subtotal: cents(end.subtotal),
    after_hours: cents(end.afterHours),
    minimum_charge: cents(end.minimumCharge),
    overhead_profit: cents(end.overheadProfit),
    tax: cents(end.tax),
    total: cents(end.total),
  };
}

function strings(value: Json | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function documentsOf(documents: JObj): EstimateDocuments {
  const proposal = isObj(documents.adr_estimate) ? documents.adr_estimate : {};
  const photos = documents.photo_audit_log ?? [];
  return {
    proposal: {
      customer_name: typeof proposal.customer_name === 'string' ? proposal.customer_name : '',
      property_address:
        typeof proposal.property_address === 'string' ? proposal.property_address : '',
      lead_notice_required: proposal.lead_notice_required === true,
      findings: strings(proposal.findings),
      recommendations: strings(proposal.recommendations),
      disclaimers: strings(proposal.disclaimers),
    },
    letter:
      typeof documents.iicrc_defense_letter === 'string' ? documents.iicrc_defense_letter : '',
    compliance_notes: strings(documents.compliance_notes),
    photo_log: Array.isArray(photos) ? photos : [],
    claim: documents.claim ?? null,
    unpriced_work: strings(documents.unpriced_work),
    signable: documents.signable === true,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The items whose zero price the owner confirmed when the table was published. */
function confirmedZeros(table: Table): string[] {
  return table.items.filter((item) => item.allow_zero).map((item) => item.item_id);
}

/** The publish check: a blank price blocks publishing; a zero price needs its item listed in `acknowledgements`. */
export function checkTable(
  table: Json,
  acknowledgements: string[] = [],
): { ok: true; table_sha256: string } | { ok: false; error: string } {
  try {
    const parsed = parseTable(table);
    checkPublishable(parsed, acknowledgements);
    return { ok: true, table_sha256: contentHash(parsed) };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

/** Load a saved draft as the server does: validate it, then check room names and overrides. */
function savedInspection(raw: Json): Inspection {
  const data = validateInspection(raw);
  distinctRooms(data);
  checkOverrides(data);
  return data;
}

/** Price a saved draft from a published table. The table's zero prices were confirmed when it was published. */
export function priceEstimate(table: Json, job: EstimateJob): Estimate | Refusal {
  let parsed: Table;
  try {
    parsed = parseTable(table);
    checkPublishable(parsed, confirmedZeros(parsed));
  } catch (error) {
    return { ok: false, stage: 'table', error: message(error) };
  }
  let data: Inspection;
  try {
    data = savedInspection(job.inspection);
  } catch (error) {
    return { ok: false, stage: 'inspection', error: message(error) };
  }
  let priced: Priced;
  let advisory: JObj[];
  try {
    priced = priceAndRange(data, parsed);
    advisory = advisoryWarnings(data, parsed, priced, null);
  } catch (error) {
    return { ok: false, stage: 'pricing', error: message(error) };
  }
  const totals = priced.totals;
  let documents: EstimateDocuments | null = null;
  if (job.documents) {
    const input = job.documents;
    try {
      documents = documentsOf(
        makeDocuments({
          data,
          photos: input.photos ?? [],
          ai: input.ai,
          identity: input.company ?? null,
          customerName: input.customer_name ?? '',
          claim: input.claim ?? null,
          table: parsed,
        }),
      );
    } catch (error) {
      return { ok: false, stage: 'documents', error: message(error) };
    }
  }
  return {
    ok: true,
    engine_version: priced.calculationVersion,
    table_sha256: contentHash(parsed),
    lines: priced.lines.map((line) => lineOf(line)),
    totals: {
      mode: totals.mode,
      low: endOf(totals.low),
      high: totals.high ? endOf(totals.high) : null,
      labor_material_low: cents(totals.laborMaterialLow),
      labor_material_high: cents(totals.laborMaterialHigh),
      explanation: totals.explanation,
      range_explanation: totals.rangeExplanation,
    },
    warnings: { engine: priced.warnings, advisory },
    documents,
  };
}
