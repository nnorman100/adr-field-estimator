const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
let resolveLocation;
const location = new Promise((resolve) => {
  resolveLocation = resolve;
});
const persisted = [];
let room = 'Bathroom';
let locationRequests = 0;
let saveFailure = null;
let releaseSync;
const previousSync = new Promise((resolve) => {
  releaseSync = resolve;
});
const context = {
  ADRCore: {
    ...require('../public/core.js'),
    readLocation: () => {
      locationRequests++;
      return location;
    },
  },
  document: { getElementById: () => ({ value: room }), addEventListener() {} },
  navigator: {},
  location: { href: 'https://localhost/app' },
  console,
  clearTimeout,
  crypto: require('node:crypto').webcrypto,
  createImageBitmap: async () => ({ width: 20, height: 20, close() {} }),
  FileReader: class {
    readAsDataURL() {
      this.result = 'data:image/png;base64,photo';
      this.onload();
    }
  },
  previousSync,
  save: (draft) => {
    if (saveFailure) throw saveFailure;
    persisted.push(structuredClone(draft));
  },
};
context.window = context;
vm.runInNewContext(
  require('./app_scripts')() +
    `
    changed = () => {};
    renderPhotos = () => {};
    persist = async () => save(state.draft);
    doSync = async () => { await persist(); };
    state.draft = { inspection_id: 'original', photos: [] };
    syncChain = previousSync;
    globalThis.capture = addPhoto;
    globalThis.transition = () => {
      const next = async () => { state.draft = { inspection_id: 'next', photos: [] }; };
      return syncChain.catch(() => {}).then(next);
    };
    globalThis.current = () => state.draft;
    globalThis.resetDraft = () => {
      state.draft = { inspection_id: 'retry', photos: [] };
    };
    globalThis.awaitingLocation = () => locatingPhotos.has(state.draft.photos[0]);
    globalThis.retrySave = syncDraft;
  `,
  context,
);
(async () => {
  const started = Date.now();
  const capture = context.capture({ size: 10, type: 'image/png' });
  assert.equal(locationRequests, 1);
  room = 'Kitchen';
  const transition = context.transition();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].inspection_id, 'original');
  assert.equal(persisted[0].photos[0].data_url, 'data:image/png;base64,photo');
  assert.equal(context.current().inspection_id, 'original');
  assert.equal(persisted[0].photos[0].room, 'Bathroom');
  assert.ok(Date.parse(persisted[0].photos[0].captured_at) >= started);
  assert.ok(Date.parse(persisted[0].photos[0].captured_at) <= Date.now());
  releaseSync();
  resolveLocation({ source: 'not_shared' });
  await capture;
  await transition;
  assert.equal(persisted.at(-1).photos[0].location.source, 'not_shared');
  assert.equal(context.current().inspection_id, 'next');
  assert.equal(context.current().photos.length, 0);
  context.resetDraft();
  const failure = new Error('Local storage temporarily unavailable');
  saveFailure = failure;
  const failedCapture = context.capture({ size: 10, type: 'image/png' });
  await assert.rejects(failedCapture, (error) => error === failure);
  assert.equal(context.current().photos[0].location.source, 'not_shared');
  assert.equal(context.awaitingLocation(), false);
  saveFailure = null;
  await context.retrySave();
  assert.equal(persisted.at(-1).inspection_id, 'retry');
  assert.equal(persisted.at(-1).photos[0].location.source, 'not_shared');
  console.log('PASS: capture preserves context and recovers location after a save failure');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
