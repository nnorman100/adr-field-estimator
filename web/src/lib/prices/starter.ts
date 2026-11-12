import { parseTable, type Table } from '@/engine/table';

// A new company's first price table (plan decision Q13, docs/plans/pricing.md): the industry's
// usual items and units with every price BLANK, starter trade headings and room types, and neutral
// settings (no multiplier, no markup, no tax, no minimum). Items carry plain descriptions and
// DryScope's own scope codes; there are no Xactimate codes and no prices. Every item is editable, and
// a company that has not priced an item turns it off or prices it: a blank price on an item that is
// on blocks publishing ("no price, no estimate").
//
// Nothing here is a price list. Nothing is copied from the old app's starter list or from another
// company (D-017).

type Raw = Record<string, unknown>;

type Starter = {
  id: string;
  code: string;
  group: string;
  name: string;
  unit: string;
  source: string;
  description: string;
  trade: string;
  // Categories the item applies to; empty means every category, Mold included.
  categories?: Array<1 | 2 | 3 | 'mold'>;
  quantity?: string;
  extra?: Raw;
};

const TIER_BLANK = { s: '', m: '', l: '', xl: '' };

const TRADES = [
  { trade_id: 'job_charges', name: 'Job charges', minimum_charge: '0' },
  { trade_id: 'water_mitigation', name: 'Water mitigation', minimum_charge: '0' },
  { trade_id: 'demolition', name: 'Demolition', minimum_charge: '0' },
  { trade_id: 'drying', name: 'Drying equipment and monitoring', minimum_charge: '0' },
  { trade_id: 'cleaning', name: 'Cleaning and sanitizing', minimum_charge: '0' },
  { trade_id: 'mold', name: 'Mold remediation', minimum_charge: '0' },
  { trade_id: 'extras', name: 'Additional work', minimum_charge: '0' },
] as const;

const ITEMS: readonly Starter[] = [
  // Job charges
  {
    id: 'service_call',
    code: 'SERVICE-CALL',
    group: 'job_charges',
    name: 'Emergency service call',
    unit: 'each',
    source: 'field:emergency_calls',
    description: 'Emergency response and initial assessment of the loss.',
    trade: 'job_charges',
    quantity: '1',
  },
  {
    id: 'setup_documentation',
    code: 'SETUP-DOC',
    group: 'job_charges',
    name: 'Project setup and moisture documentation',
    unit: 'each',
    source: 'typed',
    description: 'Job setup, moisture mapping and drying documentation.',
    trade: 'job_charges',
    quantity: '1',
  },
  {
    id: 'debris_haul',
    code: 'DEBRIS-HAUL',
    group: 'job_charges',
    name: 'Debris haul and disposal',
    unit: 'load',
    source: 'field:haul_loads',
    description: 'Haul and disposal of removed materials, per load.',
    trade: 'job_charges',
  },
  {
    id: 'after_hours_response',
    code: 'AFTER-HOURS',
    group: 'job_charges',
    name: 'After-hours response charge',
    unit: 'each',
    source: 'after_hours',
    description: 'Response outside normal business hours.',
    trade: 'job_charges',
  },
  {
    id: 'dump_truck_load',
    code: 'DUMP-TRUCK',
    group: 'job_charges',
    name: 'Dump truck load',
    unit: 'load',
    source: 'field:dump_truck_loads',
    description: 'Dump truck haul of larger debris volumes, per load.',
    trade: 'job_charges',
  },
  // Water mitigation
  {
    id: 'water_extraction',
    code: 'EXTRACT',
    group: 'treatment',
    name: 'Water extraction',
    unit: 'sf',
    source: 'room:wet_floor',
    description: 'Extraction of standing water from the wet floor area.',
    trade: 'water_mitigation',
    categories: [1, 2, 3],
  },
  {
    id: 'antimicrobial_application',
    code: 'ANTIMICROBIAL',
    group: 'treatment',
    name: 'Antimicrobial application',
    unit: 'sf',
    source: 'room:wet_floor',
    description: 'Antimicrobial treatment of affected surfaces.',
    trade: 'water_mitigation',
    categories: [2, 3],
  },
  {
    id: 'contents_manipulation',
    code: 'CONTENTS',
    group: 'treatment',
    name: 'Contents manipulation',
    unit: 'room',
    source: 'room:each',
    description: 'Moving and protecting contents in the room, priced by room size.',
    trade: 'water_mitigation',
    extra: { tier_prices: TIER_BLANK },
  },
  // Demolition
  {
    id: 'demo_drywall',
    code: 'DEMO-DRYWALL',
    group: 'demolition',
    name: 'Drywall removal',
    unit: 'sf',
    source: 'room:demolition:finished',
    description: 'Removal and disposal of wet drywall and insulation.',
    trade: 'demolition',
    categories: [1, 2, 3],
  },
  {
    id: 'demo_flooring',
    code: 'DEMO-FLOORING',
    group: 'demolition',
    name: 'Flooring and subfloor removal',
    unit: 'sf',
    source: 'room:demolition:unfinished',
    description: 'Removal and disposal of wet flooring, pad and subfloor.',
    trade: 'demolition',
    categories: [1, 2, 3],
  },
  {
    id: 'demo_baseboard',
    code: 'DEMO-BASE',
    group: 'demolition',
    name: 'Baseboard removal',
    unit: 'lf',
    source: 'typed',
    description: 'Removal of baseboard and trim, per linear foot.',
    trade: 'demolition',
  },
  // Drying equipment and monitoring (equipment per unit per 24 hours; monitoring by the hour)
  {
    id: 'air_mover',
    code: 'AIR-MOVER',
    group: 'drying_equipment',
    name: 'Air mover',
    unit: 'unit_day',
    source: 'count_days:air_movers*drying_days',
    description: 'Air mover, per unit per 24 hours.',
    trade: 'drying',
  },
  {
    id: 'dehumidifier',
    code: 'DEHUMIDIFIER',
    group: 'drying_equipment',
    name: 'Dehumidifier',
    unit: 'unit_day',
    source: 'count_days:dehumidifiers*drying_days',
    description: 'Dehumidifier, per unit per 24 hours.',
    trade: 'drying',
  },
  {
    id: 'air_scrubber',
    code: 'AIR-SCRUBBER',
    group: 'drying_equipment',
    name: 'Air scrubber',
    unit: 'each',
    source: 'field:air_scrubbers',
    description: 'HEPA air scrubber for the job.',
    trade: 'drying',
  },
  {
    id: 'hepa_filter',
    code: 'HEPA-FILTER',
    group: 'drying_equipment',
    name: 'HEPA filter',
    unit: 'each',
    source: 'field:hepa_filters',
    description: 'Replacement HEPA filter.',
    trade: 'drying',
  },
  {
    id: 'wood_floor_drying',
    code: 'WOOD-FLOOR',
    group: 'drying_equipment',
    name: 'Wood floor drying system',
    unit: 'unit_day',
    source: 'count_days:wood_floor_systems*wood_floor_days',
    description: 'Hardwood floor drying system, per unit per 24 hours.',
    trade: 'drying',
  },
  {
    id: 'power_distribution',
    code: 'POWER-DIST',
    group: 'drying_equipment',
    name: 'Power distribution',
    unit: 'each',
    source: 'field:power_distribution',
    description: 'Temporary power distribution for drying equipment.',
    trade: 'drying',
  },
  {
    id: 'equipment_decontamination',
    code: 'EQUIP-DECON',
    group: 'drying_equipment',
    name: 'Equipment decontamination',
    unit: 'each',
    source: 'field:equipment_decon',
    description: 'Decontamination of equipment after use on a contaminated loss.',
    trade: 'drying',
  },
  {
    id: 'monitoring',
    code: 'MONITORING',
    group: 'labor',
    name: 'Setup, takedown and monitoring',
    unit: 'hour',
    source: 'field:monitoring_hours',
    description: 'Equipment setup and takedown and daily drying monitoring, per hour.',
    trade: 'drying',
  },
  {
    id: 'technician_labor',
    code: 'TECH-LABOR',
    group: 'labor',
    name: 'Technician labor',
    unit: 'hour',
    source: 'field:labor_hours',
    description: 'Technician labor not covered by another item, per hour.',
    trade: 'water_mitigation',
  },
  // Cleaning and optional services
  {
    id: 'cleaning_sanitizing',
    code: 'CLEANING',
    group: 'treatment',
    name: 'Cleaning and sanitizing',
    unit: 'sf',
    source: 'room:wet_floor',
    description: 'Cleaning and sanitizing of affected surfaces.',
    trade: 'cleaning',
    categories: [1, 2, 3],
  },
  {
    id: 'moisture_scan',
    code: 'SCAN-3D',
    group: 'optional_services',
    name: '3D scan of the property',
    unit: 'each',
    source: 'field:matterport_scans',
    description: 'A 3D scan of the property for the job record.',
    trade: 'job_charges',
  },
  // Mold (rooms marked Mold only; the owner prices each condition and containment band)
  {
    id: 'mold_removal',
    code: 'MOLD-REMOVAL',
    group: 'treatment',
    name: 'Mold removal',
    unit: 'sf',
    source: 'room:demolition:unfinished',
    description: 'Removal of mold-affected material (S520 Condition 3).',
    trade: 'mold',
    categories: ['mold'],
    extra: { mold_conditions: [3] },
  },
  {
    id: 'mold_cleaning',
    code: 'MOLD-CLEAN',
    group: 'treatment',
    name: 'Mold cleaning',
    unit: 'sf',
    source: 'room:demolition:finished',
    description: 'HEPA vacuuming and cleaning of mold-affected surfaces (S520 Conditions 2 and 3).',
    trade: 'mold',
    categories: ['mold'],
    extra: { mold_conditions: [2, 3] },
  },
  {
    id: 'mold_containment_small',
    code: 'MOLD-CONT-S',
    group: 'treatment',
    name: 'Mold containment, up to 10 sq ft affected',
    unit: 'room',
    source: 'room:each',
    description: 'Containment for an affected area of up to 10 square feet.',
    trade: 'mold',
    categories: ['mold'],
    extra: { affected_bands: ['up_to_10'], tier_prices: TIER_BLANK },
  },
  {
    id: 'mold_containment_medium',
    code: 'MOLD-CONT-M',
    group: 'treatment',
    name: 'Mold containment, over 10 to 100 sq ft affected',
    unit: 'room',
    source: 'room:each',
    description: 'Containment for an affected area of more than 10 and up to 100 square feet.',
    trade: 'mold',
    categories: ['mold'],
    extra: { affected_bands: ['over_10_to_100'], tier_prices: TIER_BLANK },
  },
  {
    id: 'mold_containment_large',
    code: 'MOLD-CONT-L',
    group: 'treatment',
    name: 'Mold containment, over 100 sq ft affected',
    unit: 'room',
    source: 'room:each',
    description: 'Containment for an affected area of more than 100 square feet.',
    trade: 'mold',
    categories: ['mold'],
    extra: { affected_bands: ['over_100'], tier_prices: TIER_BLANK },
  },
  {
    id: 'mold_clearance_testing',
    code: 'MOLD-CLEAR',
    group: 'optional_services',
    name: 'Mold clearance testing',
    unit: 'each',
    source: 'typed',
    description: 'Post-remediation clearance testing, priced separately from the removal.',
    trade: 'mold',
    categories: ['mold'],
  },
  // Additional work approved after signing, by the hour (at most one such item may be on)
  {
    id: 'additional_work',
    code: 'ADDL-WORK',
    group: 'extras',
    name: 'Additional work, per hour',
    unit: 'hour',
    source: 'typed',
    description: 'Additional work the customer approves after signing, per hour.',
    trade: 'extras',
  },
];

function itemOf(starter: Starter, index: number): Raw {
  const item: Raw = {
    item_id: starter.id,
    code: starter.code,
    group: starter.group,
    name: starter.name,
    customer_description: starter.description,
    unit: starter.unit,
    quantity_source: starter.source,
    unit_price: '',
    default_quantity: starter.quantity ?? '0',
    categories: starter.categories ?? [],
    trade: starter.trade,
    enabled: true,
    sort_order: (index + 1) * 10,
    ...starter.extra,
  };
  // A per-room item holds its four size-tier prices, not a unit price.
  if (starter.unit === 'room') delete item.unit_price;
  return item;
}

// The room types a company starts with. Other always exists; each type suggests the items an
// estimator usually confirms there, and changes no price while "Price varies by room type" is off.
const WATER_ROOM = ['water_extraction', 'demo_flooring', 'demo_baseboard', 'air_mover', 'dehumidifier'];
const ROOM_TYPES = [
  { id: 'kitchen', name: 'Kitchen', suggested_items: [...WATER_ROOM, 'demo_drywall', 'contents_manipulation'] },
  { id: 'bathroom', name: 'Bathroom', suggested_items: [...WATER_ROOM, 'demo_drywall', 'antimicrobial_application'] },
  { id: 'bedroom', name: 'Bedroom', suggested_items: [...WATER_ROOM, 'contents_manipulation'] },
  { id: 'living_room', name: 'Living room', suggested_items: [...WATER_ROOM, 'contents_manipulation'] },
  { id: 'hallway', name: 'Hallway', suggested_items: WATER_ROOM },
  { id: 'laundry', name: 'Laundry', suggested_items: [...WATER_ROOM, 'demo_drywall'] },
  { id: 'garage', name: 'Garage', suggested_items: ['water_extraction', 'air_mover', 'dehumidifier'] },
  { id: 'other', name: 'Other', suggested_items: [] },
];

// Neutral settings: nothing is marked up, taxed or held to a minimum, so no setting decides a
// company's totals until its owner sets it. The range choice is the owner's to make at first publish
// (plan Q14), so the value kept here is a placeholder that the first publish replaces. The room-size
// limits are blank until the owner sets them (a table with an enabled per-room item cannot publish
// without them), and room-type pricing is off.
function neutralPolicy(): Raw {
  return {
    estimate_mode: 'single',
    area_basis: 'demolition',
    range: { first_sf: 1000, first_percent: '0', beyond_percent: '0' },
    after_hours: { multiplier: '1' },
    category_multipliers: { '1': '1', '2': '1', '3': '1' },
    cabinetry: { multiplier: '1', scope: 'finished_only' },
    minimum_job_charge: '0',
    overhead_profit_percent: '0',
    sales_tax: { enabled: false, percent: '0' },
    show_line_breakdown: false,
    bracket_mode: 'tiered',
    room_type_pricing: false,
    size_tiers: { s_up_to_sf: null, m_up_to_sf: null, l_up_to_sf: null },
    room_types: ROOM_TYPES,
  };
}

// The starter list as the parsed, canonical table a working copy stores. Built fresh on each call so
// no caller can change the next caller's copy. A table that no longer parses is a bug in this file,
// caught by tests/unit/price-starter.test.ts, never by a company.
export function starterTable(): Table {
  return parseTable({ items: ITEMS.map(itemOf), trades: TRADES.map((trade) => ({ ...trade })), policy: neutralPolicy() });
}
