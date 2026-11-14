import { describe, expect, it } from 'vitest';
import { priceEstimate, type EstimateJob, type Json } from '@/engine/estimate';
import { parseTable, type Item, type Table } from '@/engine/table';
import { itemFields, type ItemField } from '@/lib/prices/screen';
import { starterTable } from '@/lib/prices/starter';
import { AI, COMPANY } from './estimate-fixtures';

// S4-8: an item's card shows a field only where the engine uses it. For every starter item and
// every field its card shows, a different value changes what the real engine returns for a job
// that prices the item: its lines, totals, warnings or documents.

// Every price set, a typed quantity on every typed item, a minimum charge under the Mold heading,
// and settings under which tax, overhead and profit and the after-hours rate apply.
function base(): Table {
  const table = starterTable();
  return parseTable({
    ...table,
    trades: table.trades!.map((trade) => (trade.trade_id === 'mold' ? { ...trade, minimum_charge: '5000' } : trade)),
    policy: {
      ...table.policy,
      size_tiers: { s_up_to_sf: 100, m_up_to_sf: 250, l_up_to_sf: 500 },
      overhead_profit_percent: '10',
      sales_tax: { enabled: true, percent: '8' },
      after_hours: { ...table.policy.after_hours, multiplier: '1.5' },
    },
    items: table.items.map((item) => {
      const quantity = item.quantity_source === 'typed' && item.group !== 'extras' && item.default_quantity === '0' ? { default_quantity: '1' } : {};
      return item.unit === 'room'
        ? { ...item, ...quantity, tier_prices: { s: '10.00', m: '20.00', l: '30.00', xl: '40.00' } }
        : { ...item, ...quantity, unit_price: '2.00' };
    }),
  });
}

const APPROVAL = {
  accepted_by_uid: 'uid-1',
  accepted_by_name: 'Casey Customer',
  accepted_at: '2026-11-01T10:00:00.000Z',
  rate: '75.00',
  total: '150.00',
  company_id: 'example-co',
  company_version: 1,
};

// A job with every input the starter items read, at night, with documents. A typed item takes its
// default quantity: the job types none.
function job(table: Table): EstimateJob {
  const scope: Record<string, Json> = {};
  for (const item of table.items) {
    if (item.quantity_source === 'typed_count_days') scope[item.item_id] = { count: 2, days: 3 };
  }
  const water = (name: string, category: 1 | 2 | 3) => ({
    name,
    category,
    water_class: 2,
    floor_sf: 150,
    wet_floor_sf: 150,
    unfinished_sf: 120,
    finished_sf: 40,
    ceiling_height_ft: 8,
  });
  // One mold room in each affected-area band, so every containment size is priced.
  const mold = (name: string, affected: number) => ({
    name,
    category: 'mold',
    loss: 'mold',
    floor_sf: 200,
    unfinished_sf: 60,
    finished_sf: 60,
    mold_condition: 3,
    affected_sf: affected,
    ceiling_height_ft: 8,
  });
  return {
    inspection: {
      address: '1 Example Street, Testville',
      year_built: 1995,
      rooms: [
        water('Kitchen', 1),
        water('Bedroom', 2),
        water('Bathroom', 3),
        mold('Closet', 60),
        mold('Attic', 5),
        mold('Basement', 150),
      ],
      emergency_calls: 1,
      haul_loads: 1,
      dump_truck_loads: 1,
      air_scrubbers: 1,
      hepa_filters: 1,
      monitoring_hours: 8,
      labor_hours: 4,
      air_movers: 4,
      dehumidifiers: 1,
      drying_days: 3,
      wood_floor_systems: 1,
      wood_floor_days: 3,
      power_distribution: 1,
      equipment_decon: 1,
      matterport_scans: 1,
      is_after_hours: true,
      scope_confirmed: true,
      scope_items: scope,
      extras: [{ id: 'a1b2c3d4e5f60718a1b2c3d4e5f60718', description: 'Move a piano', hours: '2', approval: APPROVAL }],
    },
    documents: { company: COMPANY, ai: AI, customer_name: 'Casey Customer', photos: [] },
  };
}

// What the engine says about a job, without the table's own fingerprint. The table goes to the
// engine as it would be saved, unparsed, so a table the engine refuses is an outcome too.
function outcome(table: Table): string {
  const result = priceEstimate(table as unknown as Json, job(base()));
  if (!result.ok) return JSON.stringify(result);
  const { table_sha256: _sha, ...rest } = result;
  void _sha;
  return JSON.stringify(rest);
}

function zeroPrice(item: Item): Item {
  if (item.tier_prices) return { ...item, tier_prices: { s: '0', m: '0', l: '0', xl: '0' } };
  return { ...item, unit_price: '0' };
}

// Two versions of an item that differ only in one field (the second is what an owner would set).
const CHANGE: Record<ItemField, (item: Item) => [Item, Item]> = {
  // The name is the line's text when there is no customer wording.
  name: (item) => [
    { ...item, customer_description: '' },
    { ...item, customer_description: '', name: `${item.name} (changed)` },
  ],
  customer_description: (item) => [item, { ...item, customer_description: 'Changed wording.' }],
  trade: (item) => [{ ...item, trade: 'job_charges' }, { ...item, trade: 'mold' }],
  allow_zero: (item) => [{ ...zeroPrice(item), allow_zero: false }, { ...zeroPrice(item), allow_zero: true }],
  waste_percent: (item) => [{ ...item, waste_percent: '0' }, { ...item, waste_percent: '10' }],
  default_quantity: (item) => [{ ...item, default_quantity: '1' }, { ...item, default_quantity: '2' }],
  taxable: (item) => [{ ...item, taxable: false, materials_share_percent: undefined }, { ...item, taxable: true }],
  materials_share_percent: (item) => [
    { ...item, taxable: true, materials_share_percent: '100' },
    { ...item, taxable: true, materials_share_percent: '50' },
  ],
  after_hours: (item) => [{ ...item, after_hours: undefined }, { ...item, after_hours: true }],
  no_overhead_profit: (item) => [{ ...item, no_overhead_profit: undefined }, { ...item, no_overhead_profit: true }],
  xactimate_code: (item) => [{ ...item, xactimate_code: '' }, { ...item, xactimate_code: 'WTR EXT' }],
};

function withItem(table: Table, item: Item): Table {
  return { ...table, items: table.items.map((other) => (other.item_id === item.item_id ? item : other)) };
}

describe('the fields an item card shows', () => {
  const table = base();

  it('prices the job these tests use, and an unrelated change leaves the outcome as it was', () => {
    const result = priceEstimate(table as unknown as Json, job(table));
    expect(result.ok ? null : `${result.stage}: ${result.error}`).toBeNull();
    const off = parseTable({ ...table, items: table.items.map((item, index) => (index === 0 ? { ...item, enabled: false } : item)) });
    const offRenamed = parseTable({ ...off, items: off.items.map((item, index) => (index === 0 ? { ...item, name: 'Renamed' } : item)) });
    expect(outcome(offRenamed)).toBe(outcome(off));
  });

  for (const starter of starterTable().items) {
    for (const field of itemFields({ ...starter, taxable: true })) {
      it(`${starter.item_id}: ${field} changes what the engine returns`, () => {
        const item = table.items.find((candidate) => candidate.item_id === starter.item_id)!;
        const [before, after] = CHANGE[field](item);
        expect(itemFields(after)).toContain(field);
        expect(outcome(withItem(table, after))).not.toBe(outcome(withItem(table, before)));
      });
    }
  }
});
