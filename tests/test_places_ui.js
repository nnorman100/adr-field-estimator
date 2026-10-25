const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness(endpoint, status) {
  let now = 0;
  let nextTimer = 0;
  const timers = new Map();
  const nodes = new Map();
  const events = {};
  const calls = [];
  let fail = true;
  const element = () => ({
    value: 'Test address', hidden: true, children: [],
    setAttribute() {}, removeAttribute() {}, focus() {},
    replaceChildren(...children) { this.children = children; },
    addEventListener(name, fn) { this[name] = fn; },
  });
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id);
  };
  const request = async (path) => {
    calls.push(path);
    if (fail && path.endsWith(endpoint)) {
      fail = false;
      throw Object.assign(new Error('temporary'), { status, retryAfter: 2 });
    }
    return path.endsWith('autocomplete')
      ? { suggestions: [{ place_id: 'test', text: 'Test address' }] }
      : path.endsWith('details')
        ? { address: 'Test address', latitude: 35, longitude: -119 }
        : { blob: async () => ({}) };
  };
  const context = {
    $: get, canEditDraft: () => true, navigator: { onLine: true },
    state: { draft: { inspection_id: 'job', data: { address: 'Test address' } } },
    document: { readyState: 'complete', createElement: element },
    Date: { now: () => now }, Math, URL: { createObjectURL: () => 'blob:test' },
    setTimeout(fn, delay) { timers.set(++nextTimer, { fn, at: now + delay }); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener(name, fn) { events[name] = fn; },
    jsonApi: request, api: request, collect() {}, changed() {}, say() {},
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync('public/places.js', 'utf8'), context);
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  return {
    context, get, calls, events, flush,
    async advance(ms) {
      const end = now + ms;
      while (true) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}

for (const endpoint of ['autocomplete', 'details', 'map']) {
  for (const status of [429, 502, 403, 503]) {
    test(`${endpoint} ${status} respects cooldown and permanent availability`, async () => {
      const h = harness(endpoint, status);
      h.context.PlacesUI.render();
      if (endpoint === 'map') {
        h.context.state.draft.data.coordinates = {
          address: 'Test address', latitude: 35, longitude: -119,
        };
        h.context.PlacesUI.render();
      } else {
        h.get('address').input();
        await h.advance(350);
        if (endpoint === 'details') {
          h.get('addressSuggestions').children[0].click();
        }
      }
      await h.flush();
      const before = h.calls.length;
      h.events.online();
      h.get('address').input();
      await h.advance(1999);
      assert.equal(h.calls.length, before);
      await h.advance(351);
      if ([403, 503].includes(status)) {
        assert.equal(h.calls.length, before);
      } else if (endpoint === 'map') {
        assert.equal(h.get('jobMapImage').hidden, false);
        assert.equal(h.calls.filter((path) => path.endsWith('map')).length, 2);
      } else {
        assert.equal(h.get('addressSuggestions').hidden, false);
        h.get('addressSuggestions').children[0].click();
        await h.flush();
        assert.equal(h.context.state.draft.data.coordinates.latitude, 35);
      }
    });
  }
}
