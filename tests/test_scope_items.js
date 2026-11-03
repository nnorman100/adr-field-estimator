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
    setup: { quantity: '1', count: 0, days: 0 },
    desiccant: { quantity: '0', count: 3, days: 3 },
  });
});

test('count items seed their count; days stay at the job default for those days', () => {
  const t = table([
    item('fans', 'drying_equipment', 'count_days:air_movers*drying_days', {
      default_quantity: '4',
    }),
    item('dehu', 'drying_equipment', 'count_days:dehumidifiers*drying_days', {
      default_quantity: '500',
    }),
    item('floors', 'drying_equipment', 'count_days:wood_floor_systems*wood_floor_days', {
      default_quantity: '1',
    }),
    item('crew', 'labor', 'typed_count_days', { default_quantity: '2.5' }),
  ]);
  const data = ScopeItems.applyDefaults(core.emptyData({ v2: true }), t);
  assert.equal(data.air_movers, 4);
  assert.equal(data.dehumidifiers, 100, 'capped at what the input accepts');
  assert.equal(data.wood_floor_systems, 1);
  assert.equal(data.drying_days, 3);
  assert.equal(data.wood_floor_days, 7);
  assert.deepEqual(plain(data.scope_items), { crew: { quantity: '0', count: 2, days: 3 } });
});

test('seeding leaves no sheet charge the table does not list', () => {
  const t = table([
    item('service_call', 'job_charges', 'field:emergency_calls', { default_quantity: '2' }),
    item('hepa', 'job_charges', 'field:hepa_filters', { enabled: false, default_quantity: '4' }),
  ]);
  const data = ScopeItems.applyDefaults(core.emptyData(), t);
  assert.equal(data.emergency_calls, 2);
  for (const key of ['monitoring_hours', 'haul_loads', 'air_scrubbers', 'hepa_filters'])
    assert.equal(data[key], 0, key);
  assert.deepEqual(Array.from(ScopeItems.unlistedFields(data, t)), []);
  const untable = core.emptyData();
  assert.equal(
    ScopeItems.applyDefaults(untable, null).monitoring_hours,
    13.25,
    'no table, no change',
  );
});

test('room items show their quantity, own unit and unit price', () => {
  const rooms = [{ category: 1, unfinished_sf: 100, finished_sf: 20, floor_sf: 150 }];
  assert.equal(
    ScopeItems.fromRoomsText(
      item('drywall', 'demolition', 'room:demolition:unfinished', {
        name: 'Drywall removal',
        unit: 'sf',
        unit_price: '3.25',
      }),
      rooms,
      {},
    ),
    'From rooms: Drywall removal · 100 sq ft · $3.25 per sq ft',
  );
  assert.equal(
    ScopeItems.fromRoomsText(
      item('base', 'demolition', 'room:floor', { name: 'Baseboard', unit: 'lf', unit_price: '' }),
      rooms,
      {},
    ),
    'From rooms: Baseboard · 150 linear ft · Price not set',
  );
});

test('a default quantity follows the type its job field stores', () => {
  const t = table([
    item('hauling', 'job_charges', 'field:haul_loads', { default_quantity: '1.5' }),
    item('monitoring', 'job_charges', 'field:monitoring_hours', { default_quantity: '13.25' }),
    item('labor', 'labor', 'field:labor_hours', { default_quantity: '1.5' }),
    item('setup', 'job_charges', 'typed', { default_quantity: '2.50' }),
  ]);
  const data = ScopeItems.applyDefaults(core.emptyData({ v2: true }), t);
  assert.equal(data.haul_loads, 1, 'a table published earlier cannot break a new draft');
  assert.equal(data.monitoring_hours, 13.25);
  assert.equal(data.labor_hours, 1.5);
  assert.equal(data.scope_items.setup.quantity, '2.5', "the server's canonical text");
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

test('a room needs a wet floor input only when an enabled item prices its category from it', () => {
  const wet = (extra) => item('antimicrobial', 'treatment', 'room:wet_floor', extra);
  const mold = { category: 3 },
    water = { category: 1 };
  assert.equal(ScopeItems.pricesFromWetFloor(table([wet()]), mold), true, 'every category');
  const firstOnly = table([wet({ categories: [1] })]);
  assert.equal(ScopeItems.pricesFromWetFloor(firstOnly, water), true);
  assert.equal(ScopeItems.pricesFromWetFloor(firstOnly, mold), false);
  assert.equal(ScopeItems.pricesFromWetFloor(table([wet({ enabled: false })]), mold), false);
  const others = table([item('hepa', 'treatment', 'room:floor')]);
  assert.equal(ScopeItems.pricesFromWetFloor(others, mold), false);
  assert.equal(ScopeItems.pricesFromWetFloor(null, mold), false);
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

test('field quantities whose item is gone are named; day counts and zeros are not', () => {
  const t = table([
    item('crew', 'labor', 'field:labor_hours'),
    item('fans', 'drying_equipment', 'count_days:air_movers*drying_days'),
  ]);
  const data = {
    labor_hours: 4,
    air_movers: 2,
    air_scrubbers: 1,
    monitoring_hours: 13.25,
    haul_loads: 0,
    drying_days: 3,
    wood_floor_days: 7,
  };
  assert.deepEqual(Array.from(ScopeItems.unlistedFields(data, t)), [
    'air_scrubbers',
    'monitoring_hours',
  ]);
  // With no table to compare against, nothing can be called removed.
  assert.deepEqual(Array.from(ScopeItems.unlistedFields(data, null)), []);
  assert.deepEqual(
    Array.from(ScopeItems.unlisted({ scope_items: { kept: { quantity: '1' } } }, null)),
    [],
  );
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
  // A count the walkthrough filled is never overwritten by a default.
  assert.equal(ScopeItems.untouched({ ...sheet, air_movers: 3 }), false);
  // Every quantity a default would overwrite counts as work once it is entered.
  for (const key of [
    'labor_hours',
    'matterport_scans',
    'dump_truck_loads',
    'equipment_decon',
    'power_distribution',
    'air_movers',
    'dehumidifiers',
    'wood_floor_systems',
  ]) {
    assert.equal(ScopeItems.untouched({ ...sheet, [key]: 2 }), false, key);
    assert.equal(ScopeItems.untouched({ ...core.emptyData({ v2: true }), [key]: 2 }, true), false);
  }
  // Zero charges are a starting point only for a job begun before the phone had a table.
  const zero = core.emptyData({ v2: true });
  assert.equal(ScopeItems.untouched(zero, true), true);
  assert.equal(ScopeItems.untouched(zero), false, 'otherwise the zeros were chosen');
  assert.equal(ScopeItems.untouched({ ...zero, haul_loads: 1 }, true), false, 'neither start');
});

test('an override keeps its entered value current and a reason only while the value differs', () => {
  const data = {
    air_movers: 5,
    rooms: [{ name: 'Kitchen', finished_sf: 160 }],
    quantity_overrides: {
      air_movers: { measured: '3', entered: '3' },
      'Kitchen:finished_sf': { measured: '120', entered: '120' },
    },
  };
  assert.deepEqual(
    plain(ScopeItems.overridesFor(data, {})),
    {
      air_movers: { measured: '3', entered: '5' },
      'Kitchen:finished_sf': { measured: '120', entered: '160' },
    },
    'no reason yet: measured and entered are kept, no reason is invented',
  );
  assert.equal(ScopeItems.missingReason(data), false, 'entered is still at the measured value');
  assert.equal(
    ScopeItems.missingReason({ quantity_overrides: ScopeItems.overridesFor(data, {}) }),
    true,
  );
  assert.equal(ScopeItems.overridesFor(data, { air_movers: 'ok' }).air_movers.reason, undefined);
  assert.equal(ScopeItems.overridesFor(data, { air_movers: '     ' }).air_movers.reason, undefined);
  const both = ScopeItems.overridesFor(data, {
    air_movers: ' Added two fans  for the hall ',
    'Kitchen:finished_sf': 'Wet behind pantry',
  });
  assert.deepEqual(plain(both), {
    air_movers: { measured: '3', entered: '5', reason: 'Added two fans for the hall' },
    'Kitchen:finished_sf': { measured: '120', entered: '160', reason: 'Wet behind pantry' },
  });
  assert.equal(ScopeItems.missingReason({ quantity_overrides: both }), false);
  assert.deepEqual(
    plain(ScopeItems.overridesFor({ ...data, air_movers: 3 }, { air_movers: 'unused' })).air_movers,
    { measured: '3', entered: '3' },
    'back at the measured value, nothing to explain',
  );
  // A measured value saved on another phone asks for a reason here too, with no local row at all.
  const again = { ...data, air_movers: 7, quantity_overrides: both };
  assert.deepEqual(plain(ScopeItems.overridesFor(again)).air_movers, {
    measured: '3',
    entered: '7',
    reason: 'Added two fans for the hall',
  });
  // A removed room takes its values with it; clearing a value reads as 0.
  assert.deepEqual(Object.keys(ScopeItems.overridesFor({ ...data, rooms: [] }, {})), [
    'air_movers',
  ]);
  assert.equal(
    ScopeItems.overridesFor({ ...data, rooms: [{ name: 'Kitchen' }] }, {})['Kitchen:finished_sf']
      .entered,
    '0',
  );
});

test('the reason rule is the one the server applies', () => {
  for (const good of ['abc', ' a  b ', 'é'.repeat(3), 'Two fans 🙂'])
    assert.equal(ScopeItems.reasonOk(good), true, good);
  for (const bad of ['', '   ', 'ab', ' a ', 'x'.repeat(301), 'bad\u200bvalue', 'bad\u0001value'])
    assert.equal(ScopeItems.reasonOk(bad), false, bad);
});

test('a room rename carries its measured values and leaves other rooms alone', () => {
  const data = {
    quantity_overrides: {
      air_movers: { measured: '3', entered: '3' },
      'Kitchen:finished_sf': { measured: '80', entered: '95', reason: 'Wet behind pantry' },
      'Kitchen east:finished_sf': { measured: '10', entered: '10' },
    },
  };
  ScopeItems.renameRoom('Kitchen', 'Galley', data);
  assert.deepEqual(Object.keys(data.quantity_overrides).sort(), [
    'Galley:finished_sf',
    'Kitchen east:finished_sf',
    'air_movers',
  ]);
  assert.equal(data.quantity_overrides['Galley:finished_sf'].reason, 'Wet behind pantry');
});

test('a walkthrough fill records what it measured, and Undo restores what came before', () => {
  context.state = { draft: { inspection_id: 'job' }, session: { pricing_version: 'dryscope-v2' } };
  const room = { name: 'Kitchen', finished_sf: 80 };
  const data = { air_movers: 3, rooms: [room] };
  const fans = { target: data, field: 'air_movers', before: 0, after: 3 };
  const area = { target: room, field: 'finished_sf', before: 0, after: 80.5 };
  ScopeItems.noteMeasured([fans, area, { target: room, field: 'name', after: 'Kitchen' }], data);
  assert.deepEqual(plain(data.quantity_overrides), {
    air_movers: { measured: '3', entered: '3' },
    'Kitchen:finished_sf': { measured: '80.5', entered: '80.5' },
  });
  ScopeItems.undoMeasured(fans, data);
  assert.deepEqual(Object.keys(data.quantity_overrides), ['Kitchen:finished_sf']);
  // A second fill measures again; undoing it returns to the first measurement.
  const second = { target: room, field: 'finished_sf', before: 80.5, after: 90 };
  ScopeItems.noteMeasured([second], data);
  assert.equal(data.quantity_overrides['Kitchen:finished_sf'].measured, '90');
  ScopeItems.undoMeasured(second, data);
  assert.equal(data.quantity_overrides['Kitchen:finished_sf'].measured, '80.5');
  delete context.state;
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
      { name: 'Hall', loss: 'mold', category: 3, finished_sf: 5 },
      { name: 'Den', loss: 'mold', category: 3, finished_sf: 5, wet_floor_sf: 20 },
      { name: 'Bath', loss: 'mold', category: 3, finished_sf: 5, wet_floor_sf: 0 },
      { name: 'Attic', loss: 'mold', category: 3, finished_sf: 5, floor_sf: 30 },
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
