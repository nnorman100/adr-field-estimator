const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

const context = { window: {} };
vm.createContext(context);
vm.runInContext(fs.readFileSync('public/prices.js', 'utf8'), context);
const { Prices } = context.window;

test('price groups and after-hours wording come from the company prices', () => {
  assert.deepEqual(Array.from(Prices.zeroKeys), ['emergency_call', 'after_hours_job_charge']);
  const groups = Prices.grouped([
    { group: 'Demolition', key: 'demo_cat1_finished' },
    { group: 'Job charges', key: 'emergency_call' },
    { group: 'Demolition', key: 'demo_cat3_finished' },
  ]);
  assert.deepEqual(
    Array.from(groups, (group) => group.name),
    ['Demolition', 'Job charges'],
  );
  assert.equal(groups[0].rows.length, 2);
  assert.equal(Prices.afterHoursSentence(), Prices.AFTER_HOURS_DEFAULT);
  assert.doesNotMatch(Prices.AFTER_HOURS_DEFAULT, /\d\.\d|\$/);
  context.state = {
    session: { price_display: { after_hours_job_charge: '200.00', sheet_labor_hourly: '47.46' } },
  };
  const adr =
    "After-hours loss: $200 job charge and 20% labor/material adjustment. Added labor uses the sheet's $47.46/hr estimate formula.";
  assert.equal(Prices.afterHoursSentence(), adr);
  assert.equal(
    Prices.afterHoursSentence({ after_hours_job_charge: '200.00', sheet_labor_hourly: '47.46' }),
    adr,
  );
  assert.equal(
    Prices.afterHoursSentence({ after_hours_job_charge: '', sheet_labor_hourly: '' }),
    Prices.AFTER_HOURS_DEFAULT,
  );
  assert.match(
    Prices.afterHoursSentence({ after_hours_job_charge: '250.00', sheet_labor_hourly: '55.00' }),
    /\$250\.00/,
  );
  context.state = {
    session: { price_display: { after_hours_job_charge: '210.00', sheet_labor_hourly: '50.00' } },
  };
  assert.equal(
    Prices.afterHoursSentence(
      { after_hours_job_charge: '200.00', sheet_labor_hourly: '47.46' },
      true,
    ),
    adr,
  );
  assert.match(
    Prices.afterHoursSentence({ after_hours_job_charge: '200.00', sheet_labor_hourly: '47.46' }),
    /\$200\.00 job charge.*the job's \$47\.46/,
  );
  context.state = {
    session: { price_display: { after_hours_job_charge: '250.50', sheet_labor_hourly: '52.50' } },
  };
  assert.match(Prices.afterHoursSentence(), /\$250\.50 job charge.*\$52\.50\/hr/);
  context.state = {
    session: { price_display: { after_hours_job_charge: '250.00', sheet_labor_hourly: '55.00' } },
  };
  assert.match(Prices.afterHoursSentence(), /\$250 job charge.*\$55\.00\/hr/);
});

test('the job-charges total comes from the shown job, then the company', async () => {
  const element = () => ({ replaceChildren() {}, append() {} });
  const elements = new Map();
  const view = { display_rates: { standard_job_charges: '1,180.20' } };
  context.$ = (id) => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  context.document = { getElementById: context.$ };
  context.navigator = { onLine: true };
  context.jsonApi = async () => view;
  context.state = {
    user: { uid: 'u' },
    draft: { inspection_id: 'job-1' },
    session: {
      company_id: 'adr',
      price_books_enabled: true,
      workspaces_enabled: true,
      price_display: { standard_job_charges: '1,196.25' },
    },
  };
  assert.equal(Prices.jobChargesTotal(), '1,196.25');
  await Prices.noteJob();
  assert.equal(Prices.jobChargesTotal(), '1,180.20');
  context.state.draft = { inspection_id: 'job-2' };
  assert.equal(Prices.jobChargesTotal(), '1,196.25');
  context.state.draft = { inspection_id: 'job-1' };
  view.display_rates = { after_hours_job_charge: '', sheet_labor_hourly: '' };
  await Prices.noteJob();
  assert.equal(Prices.jobChargesTotal(), undefined);
});

test('one notice, in the server words, for a draft with no prices', async () => {
  const elements = new Map();
  context.$ = (id) => {
    if (!elements.has(id)) elements.set(id, { replaceChildren() {}, append() {} });
    return elements.get(id);
  };
  context.document = { getElementById: context.$ };
  context.navigator = { onLine: true };
  const notice = 'Words from the server.';
  let view = {
    pinned: null,
    pending_note: notice,
    display_rates: { after_hours_job_charge: '', sheet_labor_hourly: '' },
  };
  context.jsonApi = async () => view;
  context.state = {
    user: { uid: 'u' },
    draft: { inspection_id: 'job-1' },
    session: {
      company_id: 'other',
      role: 'estimator',
      price_books_enabled: true,
      workspaces_enabled: true,
      prices_set: false,
      prices_not_set_message: notice,
    },
  };
  await Prices.noteJob();
  assert.equal(context.$('pricesNotSet').hidden, false);
  assert.equal(context.$('pricesNotSetText').textContent, notice);
  assert.equal(context.$('jobPricing').hidden, true);

  view = { ...view, pinned: { label: 'Prices v1' }, pending_note: null };
  await Prices.noteJob();
  assert.equal(context.$('jobPricing').hidden, false);
  assert.equal(context.$('jobPricingStatus').textContent, 'This job is priced from Prices v1.');

  context.state.session = {
    ...context.state.session,
    prices_set: true,
    prices_not_set_message: null,
  };
  Prices.syncNotice();
  assert.equal(context.$('pricesNotSet').hidden, true);
});

test('the job reprice review says not set for a row with no earlier price', async () => {
  const elements = new Map();
  context.$ = (id) => {
    if (!elements.has(id))
      elements.set(id, {
        children: [],
        replaceChildren() {
          this.children = [];
        },
        append(...added) {
          this.children.push(...added);
        },
      });
    return elements.get(id);
  };
  context.document = { getElementById: context.$ };
  context.navigator = { onLine: true };
  context.node = (tag, text) => ({ tag, text });
  context.button = (text, fn) => ({ text, fn });
  const totals = { itemized: '1.00', low: '1.00', high: '2.00' };
  context.jsonApi = async (path) =>
    path.endsWith('/reprice-preview')
      ? {
          diff: [
            { description: 'Additional work', before: '', after: '60.00' },
            { description: 'Trip charge', before: '133.95', after: '200.00' },
          ],
          before: totals,
          after: totals,
          to_label: 'Prices v2',
        }
      : {
          pinned: { label: 'Prices v1' },
          can_reprice: true,
          display_rates: { after_hours_job_charge: '', sheet_labor_hourly: '' },
        };
  context.state = {
    user: { uid: 'u' },
    draft: { inspection_id: 'job-1' },
    session: {
      company_id: 'other',
      role: 'owner',
      price_books_enabled: true,
      workspaces_enabled: true,
      prices_set: true,
    },
  };
  await Prices.noteJob();
  await context.$('jobPricingActions').children[0].fn();
  const lines = context.$('jobPricingActions').children.map((child) => child.text);
  assert.equal(lines[0], 'Additional work: not set to 60.00');
  assert.equal(lines[1], 'Trip charge: 133.95 to 200.00');
});

test('the proposal names ADR starting prices for ADR only', () => {
  const documents = { window: { ADRCore: {} } };
  vm.createContext(documents);
  vm.runInContext(fs.readFileSync('public/documents.js', 'utf8'), documents);
  const { pricedFrom } = documents.window.ADRDocuments;
  assert.equal(pricedFrom({ company_id: 'adr', sequence: 0 }), 'Priced from ADR starting prices.');
  assert.equal(pricedFrom({ company_id: 'other', sequence: 0 }), '');
  assert.equal(pricedFrom({ company_id: 'adr', sequence: 2 }), 'Priced from Prices v2.');
  assert.equal(pricedFrom({ company_id: 'other', sequence: 1 }), 'Priced from Prices v1.');
  assert.equal(pricedFrom(undefined), '');
});

test('v2 items group in table order with plain labels', () => {
  const rows = [
    { item_id: 'b', group: 'labor', sort_order: 0 },
    { item_id: 'c', group: 'job_charges', sort_order: 20 },
    { item_id: 'a', group: 'job_charges', sort_order: 10 },
    { item_id: 'd', group: 'extras', sort_order: 0 },
  ];
  const groups = Prices.groupOrder(rows);
  assert.deepEqual(
    Array.from(groups, (group) => group.name),
    ['job_charges', 'labor', 'extras'],
  );
  assert.deepEqual(
    Array.from(groups[0].rows, (row) => row.item_id),
    ['a', 'c'],
  );
  assert.equal(Prices.groupLabel('drying_equipment'), 'Drying equipment');
  assert.equal(Prices.groupLabel('extras'), 'Additional work');
  assert.equal(Prices.unitLabel('unit_day'), 'unit per day');
});

test('quantity sources read in plain language and demolition only offers room sources', () => {
  assert.equal(
    Prices.sourceLabel('room:demolition:finished'),
    'Rooms: finished, drywall and trim demolition sq ft',
  );
  assert.equal(
    Prices.sourceLabel('count_days:air_movers*drying_days'),
    'Air movers entered on the job times drying days',
  );
  assert.equal(Prices.sourceLabel('field:monitoring_hours'), 'Monitoring hours entered on the job');
  assert.equal(Prices.sourceLabel('typed'), 'Quantity typed on the job');
  assert.equal(Prices.sourceLabel('after_hours'), 'One when the job is after hours');
  assert.deepEqual(Array.from(Prices.sourceOptions('extras')), ['typed']);
  const demolition = Array.from(Prices.sourceOptions('demolition'));
  assert.ok(demolition.every((source) => source.startsWith('room:') || source === 'typed'));
  for (const source of Prices.sourceOptions('treatment'))
    assert.notEqual(Prices.sourceLabel(source), source, source + ' has a plain label');
});

test('a new item gets a unique id and code and lands last in its group', () => {
  const items = [
    { item_id: 'wall_repair', code: 'WALL-REPAIR', group: 'treatment', sort_order: 10 },
  ];
  const added = Prices.newItem('treatment', 'Wall repair', 'sf', 'typed', items);
  assert.equal(added.item_id, 'wall_repair_2');
  assert.match(added.item_id, /^[a-z][a-z0-9_]{1,39}$/);
  assert.match(added.code, /^[A-Z0-9][A-Z0-9-]{0,15}$/);
  assert.notEqual(added.code, 'WALL-REPAIR');
  assert.equal(added.sort_order, 20);
  assert.equal(added.unit_price, '');
  assert.equal(added.enabled, true);
  assert.equal(Prices.slugId('3D scan!!', new Set()), 'item_3d_scan');
  assert.match(Prices.slugId('x'.repeat(90), new Set()), /^[a-z][a-z0-9_]{1,39}$/);
});

test('moving an item swaps it with its neighbour inside the group only', () => {
  const items = [
    { item_id: 'a', group: 'labor', sort_order: 0 },
    { item_id: 'b', group: 'labor', sort_order: 10 },
    { item_id: 'x', group: 'extras', sort_order: 0 },
  ];
  Prices.moveItem(items, 'b', -1);
  const order = (group) =>
    items
      .filter((row) => row.group === group)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((row) => row.item_id);
  assert.deepEqual(order('labor'), ['b', 'a']);
  Prices.moveItem(items, 'b', -1);
  assert.deepEqual(order('labor'), ['b', 'a']);
  assert.deepEqual(order('extras'), ['x']);
});

test('the unpublished-changes comparison ignores item order but sees every setting', () => {
  const table = {
    items: [
      { item_id: 'a', unit_price: '1.00' },
      { item_id: 'b', unit_price: '2.00' },
    ],
    policy: { range: { first_sf: 1000, first_percent: '50' }, minimum_job_charge: '0' },
  };
  const reordered = {
    items: [...table.items].reverse(),
    policy: { minimum_job_charge: '0', range: { first_percent: '50', first_sf: 1000 } },
  };
  assert.equal(Prices.canon(table), Prices.canon(reordered));
  const changed = JSON.parse(JSON.stringify(table));
  changed.policy.minimum_job_charge = '250.00';
  assert.notEqual(Prices.canon(table), Prices.canon(changed));
  const priced = JSON.parse(JSON.stringify(table));
  priced.items[0].unit_price = '1.01';
  assert.notEqual(Prices.canon(table), Prices.canon(priced));
});

test('the after-hours sentence comes from the pinned policy and charge item', () => {
  const table = (multiplier, price) => ({
    policy: { after_hours: { multiplier } },
    items: price === undefined ? [] : [{ quantity_source: 'after_hours', unit_price: price }],
  });
  assert.equal(
    Prices.afterHoursSentenceFor(table('1.200', '200.00')),
    'After-hours loss: $200.00 job charge and 20% on labor and materials.',
  );
  assert.equal(
    Prices.afterHoursSentenceFor(table('1.250')),
    'After-hours loss: 25% on labor and materials.',
  );
  assert.equal(
    Prices.afterHoursSentenceFor(table('1.000', '75.5')),
    'After-hours loss: $75.50 job charge.',
  );
  assert.equal(Prices.afterHoursSentenceFor(table('1.000')), 'After-hours loss: no extra charge.');
  assert.equal(
    Prices.afterHoursSentenceFor({
      policy: { after_hours: { multiplier: '1.100' } },
      items: [{ quantity_source: 'after_hours', unit_price: '' }],
    }),
    'After-hours loss: 10% on labor and materials.',
  );
});
