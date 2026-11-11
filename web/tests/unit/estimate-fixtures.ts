// Small builders for the priceEstimate tests: plain JSON tables and jobs, nothing taken from the old oracle.

import { expect } from 'vitest';

import {
  priceEstimate,
  type Estimate,
  type EstimateJob,
  type Json,
} from '../../src/engine/estimate';

export type Obj = { [key: string]: Json };

/** A neutral policy: single price, every multiplier 1, no minimum, no overhead, no tax. */
export function policy(changes: Obj = {}): Obj {
  return {
    estimate_mode: 'single',
    range: { first_sf: 1000, first_percent: '0', beyond_percent: '0' },
    after_hours: { multiplier: '1' },
    category_multipliers: { '1': '1', '2': '1', '3': '1' },
    cabinetry: { multiplier: '1', scope: 'finished_only' },
    minimum_job_charge: '0',
    overhead_profit_percent: '0',
    sales_tax: { enabled: false, percent: '0' },
    ...changes,
  };
}

/** One priced item. The default is unfinished-area demolition at $2.00 per sq ft. */
export function item(id: string, changes: Obj = {}): Obj {
  return {
    item_id: id,
    group: 'demolition',
    name: id.replaceAll('_', ' '),
    unit: 'sf',
    quantity_source: 'room:demolition:unfinished',
    unit_price: '2.00',
    ...changes,
  };
}

export function table(items: Obj[], changes: Obj = {}): Obj {
  return { items, policy: policy(changes) };
}

export function room(name: string, changes: Obj = {}): Obj {
  return { name, category: 1, ...changes };
}

/** A saved draft. Job quantities that default above zero start at zero so only what a test sets is priced. */
export function inspection(rooms: Obj[], changes: Obj = {}): Obj {
  return {
    address: '1 Example Street, Testville',
    year_built: 1990,
    rooms,
    emergency_calls: 0,
    haul_loads: 0,
    air_scrubbers: 0,
    hepa_filters: 0,
    monitoring_hours: 0,
    scope_confirmed: true,
    ...changes,
  };
}

export function job(rooms: Obj[], changes: Obj = {}): EstimateJob {
  return { inspection: inspection(rooms, changes) };
}

/** Price a job and fail the test with the refusal if the engine refuses it. */
export function priced(tableJson: Json, estimateJob: EstimateJob): Estimate {
  const result = priceEstimate(tableJson, estimateJob);
  if (!result.ok) expect.fail(`refused at ${result.stage}: ${result.error}`);
  return result;
}

/** Each line as "description = total", in engine order. */
export function lineTotals(estimate: Estimate): string[] {
  return estimate.lines.map((line) => `${line.description} = ${line.total}`);
}

export const COMPANY: Obj = {
  company_id: 'example-co',
  version: 1,
  name: 'Example Restoration',
  address: '1 Synthetic Way, Testville',
  phone: '555-0100',
  email: 'office@example.invalid',
  license: '000001',
  signoff: 'Pat Example',
};

export const AI: Obj = { summary: 'Reviewed the inspection.', suggestions: [], unpriced_work: [] };

/** A job with the inputs the four documents need. */
export function documentJob(rooms: Obj[], changes: Obj = {}, documents: Obj = {}): EstimateJob {
  return {
    inspection: inspection(rooms, changes),
    documents: {
      company: COMPANY,
      ai: AI,
      customer_name: 'Casey Customer',
      photos: [],
      ...documents,
    },
  };
}
