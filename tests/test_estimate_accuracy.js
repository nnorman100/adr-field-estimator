const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

const context = { window: {} };
vm.createContext(context);
vm.runInContext(fs.readFileSync('public/estimate-accuracy.js', 'utf8'), context);
const { EstimateAccuracy } = context.window;
const plain = (value) => JSON.parse(JSON.stringify(value));

const STATS = {
  suggestions: {
    hidden_damage_percent: {
      1: { value: null, jobs: 3 },
      2: { value: '20', jobs: 6 },
      3: { value: '45', jobs: 5 },
    },
    extra_drying_days: { value: 2, jobs: 8 },
  },
};
const policy = () => ({
  range: { first_percent: '50' },
  assist: {
    drying_days: 3,
    range_method: 'uncertainty',
    extra_drying_days: 1,
    hidden_damage_percent: { 1: '10', 2: '15', 3: '45' },
  },
});

test('only suggestions with a number become rows', () => {
  assert.deepEqual(plain(EstimateAccuracy.suggestionRows(STATS)), [
    {
      path: 'assist.hidden_damage_percent.2',
      label: 'Hidden damage in category 2 rooms',
      kind: 'percent',
      value: '20',
      jobs: 6,
    },
    {
      path: 'assist.hidden_damage_percent.3',
      label: 'Hidden damage in category 3 or mold rooms',
      kind: 'percent',
      value: '45',
      jobs: 5,
    },
    {
      path: 'assist.extra_drying_days',
      label: 'Extra drying days on the high end',
      kind: 'days',
      value: 2,
      jobs: 8,
    },
  ]);
});

test('no suggestions means no rows', () => {
  assert.deepEqual(plain(EstimateAccuracy.suggestionRows({ suggestions: null })), []);
  assert.deepEqual(plain(EstimateAccuracy.suggestionRows(undefined)), []);
});

test('the cushion method suggests the first percent', () => {
  const rows = EstimateAccuracy.suggestionRows({
    suggestions: { first_percent: { value: '60', jobs: 12 } },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].path, 'range.first_percent');
  assert.equal(EstimateAccuracy.suggestionText(rows[0], policy()), 'Suggested: 60% (now 50%)');
});

test('the sentence names the suggestion and the working copy value', () => {
  const [hidden, same, days] = EstimateAccuracy.suggestionRows(STATS);
  assert.equal(EstimateAccuracy.suggestionText(hidden, policy()), 'Suggested: 20% (now 15%)');
  assert.equal(EstimateAccuracy.suggestionText(days, policy()), 'Suggested: 2 days (now 1 day)');
  assert.equal(EstimateAccuracy.matches(hidden, policy()), false);
  assert.equal(EstimateAccuracy.matches(same, policy()), true);
});

test('Use suggestion writes the value into the working copy object and nothing else', () => {
  const copy = policy();
  const [hidden, , days] = EstimateAccuracy.suggestionRows(STATS);
  EstimateAccuracy.applySuggestion(copy, hidden);
  EstimateAccuracy.applySuggestion(copy, days);
  const expected = policy();
  expected.assist.hidden_damage_percent[2] = '20';
  expected.assist.extra_drying_days = 2;
  assert.deepEqual(copy, expected);
  assert.equal(typeof copy.assist.extra_drying_days, 'number');
  assert.equal(typeof copy.assist.hidden_damage_percent[2], 'string');
});

test('a cushion suggestion is held at the cushion beyond in the working copy', () => {
  const [row] = EstimateAccuracy.suggestionRows({
    suggestions: { first_percent: { value: '20', jobs: 6 } },
  });
  const copy = { range: { first_percent: '50', beyond_percent: '30' } };
  assert.equal(EstimateAccuracy.suggestionText(row, copy), 'Suggested: 30% (now 50%)');
  assert.equal(EstimateAccuracy.matches(row, copy), false);
  EstimateAccuracy.applySuggestion(copy, row);
  assert.deepEqual(copy, { range: { first_percent: '30', beyond_percent: '30' } });
  assert.equal(EstimateAccuracy.matches(row, copy), true);
});

test('a cushion suggestion above the cushion beyond is used as it is', () => {
  const [row] = EstimateAccuracy.suggestionRows({
    suggestions: { first_percent: { value: '60', jobs: 6 } },
  });
  const copy = { range: { first_percent: '50', beyond_percent: '30' } };
  assert.equal(EstimateAccuracy.suggestionText(row, copy), 'Suggested: 60% (now 50%)');
  EstimateAccuracy.applySuggestion(copy, row);
  assert.deepEqual(copy, { range: { first_percent: '60', beyond_percent: '30' } });
});
