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
