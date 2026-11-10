// One oracle case, in the order the stored fixtures were built (the Python builder is deleted). Expected answers stay in the fixtures.

import { Buffer } from 'node:buffer';

import { JInt, canonical, dict, jfloat, sha256, type JObj, type JVal } from './json';
import { checkOverrides, distinctRooms, dumpInspection, validateInspection, type Inspection } from './inspection';
import { pinAndBasis, type JobPin } from './pin';
import { linesToJ, priceScopeV1, proposalRange, v1Buckets, V1 } from './price-v1';
import { v2Buckets } from './price-v2';
import { normalizeTable, V2, type Table } from './table';
import { priceAndRange, totalsToJ } from './totals';
import { advisoryWarnings, type HistoryRow } from './warnings';
import { makeDocuments } from './documents';
import { Dec } from './decimal';
import { isObj } from './values';

export type OracleResult = {
  rejected: string | null;
  normalized: JObj | null;
  pricing: JObj | null;
  warnings: JObj | null;
  documents: JObj | null;
  proposal: { base64: string; sha256: string } | null;
};

function rejected(stage: string): OracleResult {
  return { rejected: stage, normalized: null, pricing: null, warnings: null, documents: null, proposal: null };
}

function strings(value: JVal | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item !== 'string') throw new Error('acknowledgement');
    return item;
  });
}

function ratesOf(value: JVal | undefined): Record<string, string> | null {
  if (!isObj(value)) return null;
  const rates = dict<string>();
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw new Error('rates');
    rates[key] = item;
  }
  return rates;
}

function historyOf(value: JVal | undefined): HistoryRow[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return null;
  return value.map((row) => {
    if (!isObj(row) || typeof row.sf !== 'string' || typeof row.low !== 'string' || !(row.category instanceof JInt)) {
      throw new Error('history');
    }
    return { category: row.category.value, sf: Dec.parse(row.sf), low: Dec.parse(row.low) };
  });
}

function pricingOf(version: string, lines: ReturnType<typeof linesToJ>, buckets: JObj, totals: JObj | null, low: Dec, high: Dec | null, itemized: number): JObj {
  return {
    buckets,
    calculation_version: version,
    high: high ? high.toString() : null,
    itemized_total: jfloat(itemized),
    lines,
    low: low.toString(),
    totals,
  };
}

function proposalOf(data: JObj, photos: JVal, documents: JObj, revision: JVal): { base64: string; sha256: string } {
  const text = canonical({ data, documents, photos, revision });
  return { base64: Buffer.from(text, 'utf8').toString('base64'), sha256: sha256(text) };
}

function reload(dump: JObj): Inspection {
  const data = validateInspection(dump);
  data.present = new Set(Object.keys(dump));
  return data;
}

export function evaluate(input: JVal): OracleResult {
  if (!isObj(input)) return rejected('inspection');
  const rawData = input.data;
  if (!isObj(rawData)) return rejected('inspection');
  let data: Inspection;
  try {
    data = validateInspection(rawData);
  } catch {
    return rejected('inspection');
  }
  const normalized = dumpInspection(data);
  try {
    distinctRooms(data);
    checkOverrides(data);
    data = reload(normalized);
    checkOverrides(data);
  } catch {
    return { ...rejected('save_checks'), normalized };
  }

  let table: Table | null = null;
  if (input.calculation === V2) {
    try {
      table = normalizeTable(input.table ?? null, true, strings(input.acknowledgements));
    } catch {
      return { ...rejected('table'), normalized };
    }
  }

  const pinned = input.pinned !== false && input.pinned !== null;
  let pin: JobPin | null = null;
  let basis: JObj | null = null;
  let rates = ratesOf(input.rates);
  if (pinned) {
    try {
      const booked = pinAndBasis(input, table);
      pin = booked.pin;
      basis = booked.basis;
      rates = pin.rates ?? rates;
    } catch {
      return { ...rejected('pin'), normalized };
    }
  }

  let lines;
  let low: Dec;
  let high: Dec | null;
  let itemized: number;
  let totals: JObj | null = null;
  let engine: JObj[] = [];
  let version = V1;
  let priced: ReturnType<typeof priceAndRange> | null = null;
  try {
    if (pin) {
      priced = priceAndRange(data, pin);
      lines = priced.lines;
      low = priced.low;
      high = priced.high;
      itemized = priced.itemized;
      totals = priced.totals ? totalsToJ(priced.totals) : null;
      engine = priced.warnings;
      version = priced.calculationVersion;
    } else {
      if (!rates) throw new Error('rates');
      const scoped = priceScopeV1(data, rates);
      const range = proposalRange(data, scoped.lines);
      lines = scoped.lines;
      low = range.low;
      high = range.high;
      itemized = scoped.itemized;
    }
  } catch {
    const result = rejected('pricing');
    result.normalized = normalized;
    if (pin) {
      result.pricing = null;
    }
    return { ...result, normalized };
  }

  const pricing = pricingOf(
    version,
    linesToJ(lines),
    table ? v2Buckets(lines) : v1Buckets(data, lines),
    totals,
    low,
    high,
    itemized,
  );
  let warnings: JObj;
  try {
    warnings = {
      advisory: advisoryWarnings(data, table, priced, historyOf(input.history)),
      engine,
    };
  } catch {
    return { ...rejected('pricing'), normalized, pricing: null };
  }

  const photos = Array.isArray(input.photos) ? input.photos : [];
  let documents: JObj;
  try {
    documents = makeDocuments({
      data,
      photos,
      ai: input.ai ?? null,
      identity: input.identity === undefined ? null : input.identity,
      customerName: typeof input.customer_name === 'string' ? input.customer_name : '',
      claim: input.claim === undefined ? null : input.claim,
      rates,
      basis,
      pin,
    });
  } catch {
    return { rejected: 'documents', normalized, pricing, warnings, documents: null, proposal: null };
  }
  const revision = input.revision === undefined ? null : input.revision;
  return {
    rejected: null,
    normalized,
    pricing,
    warnings,
    documents,
    proposal: proposalOf(normalized, photos, documents, revision),
  };
}

