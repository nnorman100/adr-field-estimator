const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

const context = { window: {} };
vm.createContext(context);
vm.runInContext(fs.readFileSync('public/prices.js', 'utf8'), context);
const { Prices } = context.window;

test('price labels and groups follow the published sequence', () => {
  assert.equal(Prices.labelFor(0), 'Workbook seed');
  assert.equal(Prices.labelFor('2'), 'Prices v2');
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
  assert.equal(
    Prices.afterHoursSentence({ after_hours_job_charge: '200.00', sheet_labor_hourly: '47.46' }),
    Prices.AFTER_HOURS_DEFAULT,
  );
  assert.match(
    Prices.afterHoursSentence({ after_hours_job_charge: '250.00', sheet_labor_hourly: '55.00' }),
    /\$250\.00/,
  );
});
