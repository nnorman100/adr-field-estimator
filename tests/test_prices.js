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
});
