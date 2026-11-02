const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

const context = { window: {} };
vm.createContext(context);
vm.runInContext(fs.readFileSync('public/scope-items.js', 'utf8'), context);
const { ScopeItems } = context.window;
const core = require('../public/core.js');
const plain = (value) => JSON.parse(JSON.stringify(value));

const item = (id, group, source, extra = {}) => ({
  item_id: id,
  code: id.toUpperCase(),
  group,
  name: id.replace(/_/g, ' '),
  customer_description: '',
  unit: 'each',
  quantity_source: source,
  unit_price: '10.00',
  default_quantity: '0',
  waste_percent: '0',
  categories: [],
  taxable: false,
  xactimate_code: '',
  sort_order: 0,
  enabled: true,
  ...extra,
});
const table = (items, policy = {}) => ({
  calculation_version: 'dryscope-v2',
  version_id: 'v1',
  items,
  policy: { area_basis: 'demolition', after_hours: { multiplier: '1.000' }, ...policy },
});

test('a new draft starts at the table defaults and seeds typed items', () => {
  const t = table([
    item('service_call', 'job_charges', 'field:emergency_calls', { default_quantity: '2' }),
    item('monitoring', 'job_charges', 'field:monitoring_hours', { default_quantity: '9999' }),
    item('setup', 'job_charges', 'typed', { default_quantity: '1' }),
    item('zero_typed', 'job_charges', 'typed', { default_quantity: '0' }),
    item('desiccant', 'drying_equipment', 'typed_count_days', { default_quantity: '3' }),
    item('off', 'job_charges', 'field:haul_loads', { default_quantity: '5', enabled: false }),
  ]);
  const data = ScopeItems.applyDefaults(core.emptyData({ v2: true }), t);
  assert.equal(data.emergency_calls, 2);
  // The screen's own input accepts at most 500 hours, so a larger default cannot make the form invalid.
  assert.equal(data.monitoring_hours, 500);
  assert.equal(data.haul_loads, 0, 'a disabled item contributes nothing');
  assert.deepEqual(JSON.parse(JSON.stringify(data.scope_items)), {
    setup: { quantity: 1, count: 0, days: 0 },
  });
});

test('a v2 draft never carries the sheet charge quantities', () => {
  const v1 = core.emptyData();
  assert.equal(v1.emergency_calls, 1);
  assert.equal(v1.monitoring_hours, 13.25);
  const v2 = core.emptyData({ v2: true });
  for (const key of [
    'emergency_calls',
    'monitoring_hours',
    'haul_loads',
    'air_scrubbers',
    'hepa_filters',
  ])
    assert.equal(v2[key], 0, key);
  assert.deepEqual(
    Object.keys(v2).sort(),
    Object.keys(v1).sort(),
    'the same fields, only different charge quantities',
  );
});

test('groups follow the table order and leave out disabled, unknown and extras items', () => {
  const t = table([
    item('b_labor', 'labor', 'field:labor_hours'),
    item('a_charge', 'job_charges', 'field:emergency_calls', { sort_order: 2 }),
    item('first_charge', 'job_charges', 'typed', { sort_order: 1 }),
    item('hidden', 'job_charges', 'typed', { enabled: false }),
    item('mystery', 'job_charges', 'field:nothing'),
    item('more_work', 'extras', 'typed'),
  ]);
  const groups = ScopeItems.groupsOf(t);
  assert.deepEqual(
    Array.from(groups, (g) => g.name),
    ['job_charges', 'labor'],
  );
  assert.deepEqual(
    Array.from(groups[0].items, (i) => i.item_id),
    ['first_charge', 'a_charge'],
  );
  assert.equal(ScopeItems.groupsOf(null).length, 0);
});

test('unit prices read the way the owner priced them, with no totals', () => {
  assert.equal(
    ScopeItems.unitPriceText(
      item('x', 'job_charges', 'typed', { unit: 'unit_day', unit_price: '30' }),
    ),
    '$30.00 per unit-day',
  );
  assert.equal(
    ScopeItems.unitPriceText(
      item('x', 'job_charges', 'typed', { unit: 'each', unit_price: '150.5' }),
    ),
    '$150.50 each',
  );
  assert.equal(
    ScopeItems.unitPriceText(item('x', 'job_charges', 'typed', { unit_price: '' })),
    'Price not set',
  );
});

test('room-sourced items total the matching rooms the way the server prices them', () => {
  const rooms = [
    { category: 1, unfinished_sf: 100, finished_sf: 50, floor_sf: 200, wet_floor_sf: 80 },
    { category: 2, unfinished_sf: 10, finished_sf: 5, floor_sf: 40 },
  ];
  const q = (source, categories = [], policy = {}) =>
    ScopeItems.roomQuantity(item('x', 'demolition', source, { categories }), rooms, policy);
  assert.equal(q('room:demolition:unfinished'), 110);
  assert.equal(q('room:demolition:finished', [2]), 5);
  assert.equal(q('room:wet_floor'), 120, 'a blank wet floor area falls back to the floor area');
  assert.equal(q('room:floor', [1]), 200);
  assert.equal(q('room:basis', [], { area_basis: 'demolition' }), 165);
  assert.equal(q('room:basis', [], { area_basis: 'wet_floor' }), 120);
});

test('quantities for items the table no longer lists are kept and named', () => {
  const t = table([
    item('kept', 'job_charges', 'typed'),
    item('crew', 'labor', 'typed_count_days'),
  ]);
  const data = {
    scope_items: {
      kept: { quantity: 1, count: 0, days: 0 },
      crew: { quantity: 0, count: 2, days: 3 },
      gone: { quantity: 4, count: 0, days: 0 },
      fans: { quantity: 0, count: 1, days: 1 },
    },
  };
  assert.deepEqual(Array.from(ScopeItems.unlisted(data, t)), ['fans', 'gone']);
  assert.deepEqual(Array.from(ScopeItems.unlisted({}, t)), []);
});

test('only an untouched office-created job is given the table defaults', () => {
  const sheet = {
    emergency_calls: 1,
    monitoring_hours: 13.25,
    haul_loads: 1,
    air_scrubbers: 1,
    hepa_filters: 1,
    labor_hours: 0,
    matterport_scans: 0,
    scope_confirmed: false,
  };
  assert.equal(ScopeItems.untouched(sheet), true);
  assert.equal(ScopeItems.untouched({ ...sheet, monitoring_hours: 8 }), false);
  assert.equal(ScopeItems.untouched({ ...sheet, scope_confirmed: true }), false);
  assert.equal(ScopeItems.untouched({ ...sheet, scope_items: {} }), false);
});

test('an override is recorded only with a short reason and only while the value differs', () => {
  const data = {
    air_movers: 5,
    rooms: [{ name: 'Kitchen', finished_sf: 160 }],
  };
  const measured = { air_movers: 3, 'Kitchen:finished_sf': 120 };
  assert.deepEqual(plain(ScopeItems.overridesFor(data, measured, {})), {}, 'no reason, no record');
  assert.deepEqual(plain(ScopeItems.overridesFor(data, measured, { air_movers: 'ok' })), {});
  const both = ScopeItems.overridesFor(data, measured, {
    air_movers: ' Added two fans  for the hall ',
    'Kitchen:finished_sf': 'Wet behind pantry',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(both)), {
    air_movers: { measured: 3, entered: 5, reason: 'Added two fans for the hall' },
    'Kitchen:finished_sf': {
      measured: 120,
      entered: 160,
      reason: 'Wet behind pantry',
    },
  });
  assert.deepEqual(
    plain(ScopeItems.overridesFor({ ...data, air_movers: 3 }, measured, { air_movers: 'unused' })),
    {},
    'back at the measured value, nothing to explain',
  );
  // An override saved earlier, or on another phone, is not dropped just because this phone has no measurement.
  const elsewhere = {
    ...data,
    quantity_overrides: { hepa_filters: { measured: 1, entered: 2, reason: 'Second scrubber' } },
  };
  assert.deepEqual(plain(ScopeItems.overridesFor(elsewhere, {}, {})), {
    hepa_filters: { measured: 1, entered: 2, reason: 'Second scrubber' },
  });
  // A saved reason carries over when the screen has none to read.
  const saved = { ...data, quantity_overrides: { air_movers: { reason: 'Hall corner was wet' } } };
  assert.equal(
    ScopeItems.overridesFor(saved, { air_movers: 3 }).air_movers.reason,
    'Hall corner was wet',
  );
});

test('the after-hours line names the charge and the percent from the pinned table', () => {
  const plain = table([item('x', 'job_charges', 'typed')]);
  assert.equal(
    ScopeItems.afterHoursText(plain),
    'After-hours loss (no extra charge in your price list)',
  );
  const priced = table(
    [
      item('night_call', 'job_charges', 'after_hours', {
        name: 'After-hours charge',
        unit_price: '200',
      }),
    ],
    { after_hours: { multiplier: '1.250' } },
  );
  assert.equal(
    ScopeItems.afterHoursText(priced),
    'After-hours loss: $200.00 after-hours charge and 25% on labor and materials',
  );
});

test('the group summary names what is entered', () => {
  const t = table([
    item('fans', 'drying_equipment', 'count_days:air_movers*drying_days', { name: 'Air mover' }),
    item('scrub', 'drying_equipment', 'field:air_scrubbers', { name: 'Air scrubber' }),
  ]);
  const group = ScopeItems.groupsOf(t)[0];
  assert.equal(
    ScopeItems.summaryOf(group, { air_movers: 4, drying_days: 3, air_scrubbers: 0 }),
    '· 4 air mover, 3 days',
  );
  assert.equal(ScopeItems.summaryOf(group, { air_movers: 0, air_scrubbers: 0 }), '· none entered');
});

test('device readiness mirrors the server price gaps', () => {
  const data = {
    address: 'x',
    year_built: 2000,
    rooms: [
      { name: 'Hall', loss: 'mold', category: 3, finished_sf: 5, wet_floor_sf: 0 },
      { name: 'Den', loss: 'mold', category: 3, finished_sf: 5, wet_floor_sf: 20 },
    ],
    air_movers: 1,
    scope_confirmed: true,
  };
  const codes = (pricing) =>
    core
      .readiness(data, [], {}, [], pricing)
      .gaps.filter((g) => ['prices', 'area_basis'].includes(g.code))
      .map((g) => g.code + (g.room ? ':' + g.room : ''));
  assert.deepEqual(codes(null), [], 'a v1 company has no price gaps');
  assert.deepEqual(codes({ prices_set: true, area_basis: 'demolition' }), []);
  assert.deepEqual(codes({ prices_set: true, area_basis: 'wet_floor' }), ['area_basis:Hall']);
  assert.deepEqual(codes({ prices_set: false }), ['prices']);
});
