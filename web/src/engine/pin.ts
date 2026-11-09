// The oracle's first pin: one published version, no grandfathering, priced_at frozen.

import { createHash } from 'node:crypto';

import type { JObj, JVal } from './json';
import { JInt, asString, canonical, dict, jint } from './json';
import { has, isObj } from './values';
import {
  V2,
  contentHash,
  itemToJ,
  normalizeTable,
  policyToJ,
  type Item,
  type Policy,
  type Table,
} from './table';

export const V1 = 'adr-residential-v1';
export const PRICED_AT = '2026-11-01T17:00:00Z';

export const RATE_KEYS = [
  'demo_cat1_unfinished',
  'demo_cat1_finished',
  'demo_cat2_unfinished',
  'demo_cat2_finished',
  'demo_cat3_unfinished',
  'demo_cat3_finished',
  'emergency_call',
  'monitoring_hourly',
  'haul_pickup_load',
  'air_scrubber_daily',
  'hepa_filter',
  'matterport_scan',
  'dump_truck_load',
  'equipment_decontamination',
  'power_distribution',
  'air_mover_daily',
  'dehumidifier_daily',
  'wood_floor_daily',
  'sheet_labor_hourly',
  'after_hours_job_charge',
  'additional_work_hourly',
] as const;

const ADR: Record<string, string> = {
  demo_cat1_unfinished: '1.21',
  demo_cat1_finished: '2.78',
  demo_cat2_unfinished: '1.52',
  demo_cat2_finished: '2.89',
  demo_cat3_unfinished: '2.48',
  demo_cat3_finished: '8.39',
  emergency_call: '133.95',
  monitoring_hourly: '47.46',
  haul_pickup_load: '159.53',
  air_scrubber_daily: '74.75',
  hepa_filter: '183.12',
  matterport_scan: '250.00',
  dump_truck_load: '286.78',
  equipment_decontamination: '27.72',
  power_distribution: '66.74',
  air_mover_daily: '29.25',
  dehumidifier_daily: '101.25',
  wood_floor_daily: '180.00',
  sheet_labor_hourly: '47.46',
  after_hours_job_charge: '200.00',
  additional_work_hourly: '47.46',
};

export type JobPin = {
  calculationVersion: string;
  rates: Record<string, string> | null;
  items: Item[] | null;
  policy: Policy | null;
  json: JObj;
};

function knownV1(version: JVal | undefined): version is string {
  return version === V1;
}

function foreignAdr(companyId: string, rates: Record<string, string>): boolean {
  if (companyId === 'adr') return false;
  return RATE_KEYS.filter((key) => key !== 'additional_work_hourly').every((key) => rates[key] === ADR[key]);
}

function v1Hash(rates: Record<string, string>, version: string): string {
  const body: JObj = {};
  for (const key of RATE_KEYS) {
    const value = rates[key];
    if (value === undefined) throw new Error('rate');
    body[key] = value;
  }
  const payload: JObj = {
    calculation_version: version,
    catalog_version: jint(1),
    currency: 'USD',
    rates: body,
  };
  return createHash('sha256').update(canonical(payload), 'utf8').digest('hex');
}

function readRates(raw: JVal | undefined): Record<string, string> {
  if (!isObj(raw)) throw new Error('rates');
  const rates = dict<string>();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') throw new Error('rate');
    rates[key] = value;
  }
  return rates;
}

function bracketsOf(items: Item[]): JObj | null {
  const out: JObj = {};
  let any = false;
  for (const item of items) {
    if (!item.enabled || !item.priceBrackets) continue;
    any = true;
    out[item.itemId] = item.priceBrackets.map((band) => ({
      unit_price: band.unitPrice ?? '',
      up_to_sf: band.upToSf === null ? null : jint(band.upToSf),
    }));
  }
  return any ? out : null;
}

export function pinAndBasis(input: JObj, table: Table | null): { pin: JobPin; basis: JObj } {
  const calculation = input.calculation;
  const companyId = asString(input.company_id ?? '');
  const versionId = asString(input.version_id ?? '');
  const sequence = input.sequence instanceof JInt ? input.sequence.value : table ? 1 : 0;
  let rates: Record<string, string> | null = null;
  let items: Item[] | null = null;
  let policy: Policy | null = null;
  let version = typeof calculation === 'string' ? calculation : '';
  let hash = '0'.repeat(64);
  if (table) {
    items = table.items;
    policy = table.policy;
    version = V2;
    hash = contentHash(table);
  } else if (knownV1(calculation)) {
    rates = readRates(input.rates);
    version = V1;
    hash = v1Hash(rates, V1);
    if (new Set(Object.keys(rates)).size !== RATE_KEYS.length || RATE_KEYS.some((key) => !(key in rates!))) {
      throw new Error('rates');
    }
    if (foreignAdr(companyId, rates)) throw new Error('unset');
  } else if (has(input, 'rates') && input.rates !== undefined) {
    rates = readRates(input.rates);
    if (typeof calculation === 'string' && calculation !== V1 && calculation !== V2) hash = '0'.repeat(64);
    throw new Error('book');
  } else {
    throw new Error('book');
  }
  if (table && items && policy) {
    const again = normalizeTable(
      { items: items.map((item) => itemToJ(item)), policy: policyToJ(policy) },
      true,
      items.filter((item) => item.allowZero).map((item) => item.itemId),
    );
    if (contentHash(again) !== hash) throw new Error('hash');
  }
  const pinBody: JObj = {
    calculation_version: version,
    company_id: companyId,
    content_sha256: hash,
    inspection_id: asString(input.inspection_id ?? ''),
    pin_version: jint(1),
    priced_at: PRICED_AT,
    reason: 'first_price',
    sequence: jint(sequence),
    version_id: versionId,
  };
  if (table && items && policy) {
    pinBody.items = items.map((item) => itemToJ(item));
    pinBody.policy = policyToJ(policy);
  } else if (rates) {
    const body: JObj = {};
    for (const key of RATE_KEYS) body[key] = rates[key] ?? '';
    pinBody.rates = body;
  }
  const basis: JObj = {
    calculation_version: version,
    company_id: companyId,
    content_sha256: hash,
    priced_at: PRICED_AT,
    sequence: jint(sequence),
    version_id: versionId,
  };
  if (table && policy && items) {
    basis.item_count = jint(items.length);
    basis.policy = policyToJ(policy);
    const brackets = bracketsOf(items);
    if (brackets) basis.price_brackets = brackets;
  } else if (rates) {
    const body: JObj = {};
    for (const key of RATE_KEYS) body[key] = rates[key] ?? '';
    basis.rates = body;
  }
  return {
    pin: { calculationVersion: version, rates, items, policy, json: pinBody },
    basis,
  };
}
