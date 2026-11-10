// The stable engine entry: plain JSON in, plain JSON out, money as Decimal strings.
// Routes and tests call only priceEstimate and checkTable; the files behind them change in S4-3 and S4-4.

import { Dec, money } from './decimal';
import { JFloat, JInt, jfloat, jint, type JObj, type JVal } from './json';
import {
  checkOverrides,
  distinctRooms,
  dumpInspection,
  validateInspection,
  type Inspection,
} from './inspection';
import type { JobPin } from './pin';
import { contentHash, normalizeTable, V2, type Table } from './table';
import { priceAndRange, type End, type Priced } from './totals';
import { advisoryWarnings } from './warnings';
import { makeDocuments } from './documents';
import { decFloat, isObj, type PriceLine } from './values';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

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

/** Plain JSON to the engine's typed values: a whole number is an integer, any other number a float. */
function toJ(value: Json | undefined): JVal {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('number');
    return Number.isInteger(value) ? jint(value) : jfloat(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => toJ(item));
  const out: JObj = Object.create(null) as JObj;
  for (const [key, item] of Object.entries(value)) out[key] = toJ(item);
  return out;
}

function toPlain(value: JVal): Json {
  if (value instanceof JInt || value instanceof JFloat) return value.value;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => toPlain(item));
  const out: { [key: string]: Json } = {};
  for (const [key, item] of Object.entries(value)) out[key] = toPlain(item);
  return out;
}

function text(value: Dec): string {
  return value.normalize().format('f');
}

function cents(value: Dec): string {
  return money(value).toString();
}

function lineOf(line: PriceLine): EstimateLine {
  return {
    item_id: line.itemId ?? null,
    code: line.code,
    description: line.description,
    room: line.room ?? null,
    group: line.group ?? '',
    bucket: line.bucket ?? '',
    unit: line.unit,
    quantity: text(decFloat(line.quantity)),
    unit_price: text(decFloat(line.unitPrice)),
    waste_percent: text(decFloat(line.waste)),
    total: cents(decFloat(line.total)),
    taxable: line.taxable === true,
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

function strings(value: JVal | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function documentsOf(documents: JObj): EstimateDocuments {
  const proposal = isObj(documents.adr_estimate) ? documents.adr_estimate : {};
  const photos = toPlain(documents.photo_audit_log ?? []);
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
    claim: toPlain(documents.claim ?? null),
    unpriced_work: strings(documents.unpriced_work),
    signable: documents.signable === true,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function acknowledged(raw: JVal): string[] {
  if (!isObj(raw) || !Array.isArray(raw.items)) return [];
  return raw.items.flatMap((item) =>
    isObj(item) && item.allow_zero === true && typeof item.item_id === 'string'
      ? [item.item_id]
      : [],
  );
}

/** The publish check: a blank price blocks publishing; a zero price needs its item listed in `acknowledgements`. */
export function checkTable(
  table: Json,
  acknowledgements: string[] = [],
): { ok: true; table_sha256: string } | { ok: false; error: string } {
  try {
    return {
      ok: true,
      table_sha256: contentHash(normalizeTable(toJ(table), true, acknowledgements)),
    };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

/** Load a saved draft as the server does: validate, check, save, and read the saved copy back. */
function savedInspection(raw: Json): Inspection {
  const first = validateInspection(toJ(raw));
  distinctRooms(first);
  checkOverrides(first);
  const dump = dumpInspection(first);
  const data = validateInspection(dump);
  data.present = new Set(Object.keys(dump));
  checkOverrides(data);
  return data;
}

/** Price a saved draft from a published table. The table's zero prices were confirmed when it was published. */
export function priceEstimate(table: Json, job: EstimateJob): Estimate | Refusal {
  let parsed: Table;
  try {
    const raw = toJ(table);
    parsed = normalizeTable(raw, true, acknowledged(raw));
  } catch (error) {
    return { ok: false, stage: 'table', error: message(error) };
  }
  let data: Inspection;
  try {
    data = savedInspection(job.inspection);
  } catch (error) {
    return { ok: false, stage: 'inspection', error: message(error) };
  }
  const pin: JobPin = {
    calculationVersion: V2,
    rates: null,
    items: parsed.items,
    policy: parsed.policy,
    json: {},
  };
  let priced: Priced;
  let advisory: JObj[];
  try {
    priced = priceAndRange(data, pin);
    advisory = advisoryWarnings(data, parsed, priced, null);
  } catch (error) {
    return { ok: false, stage: 'pricing', error: message(error) };
  }
  const totals = priced.totals;
  if (!totals) return { ok: false, stage: 'pricing', error: 'no totals' };
  let documents: EstimateDocuments | null = null;
  if (job.documents) {
    const input = job.documents;
    try {
      documents = documentsOf(
        makeDocuments({
          data,
          photos: (input.photos ?? []).map((photo) => toJ(photo)),
          ai: toJ(input.ai),
          identity: input.company === undefined ? null : toJ(input.company),
          customerName: input.customer_name ?? '',
          claim: input.claim === undefined ? null : toJ(input.claim),
          rates: null,
          basis: null,
          pin,
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
    warnings: {
      engine: priced.warnings.map((row) => toPlain(row)),
      advisory: advisory.map((row) => toPlain(row)),
    },
    documents,
  };
}
