const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
let resolveLocation;
const location = new Promise((resolve) => { resolveLocation = resolve; });
const persisted = [];
const context = {
  ADRCore: { ...require('../public/core.js'), readLocation: () => location },
  document: { getElementById: () => ({ value: 'Bathroom' }), addEventListener() {} },
  navigator: {},
  location: { href: 'https://localhost/app' },
  console,
  crypto: require('node:crypto').webcrypto,
  createImageBitmap: async () => ({ width: 20, height: 20, close() {} }),
  FileReader: class {
    readAsDataURL() {
      this.result = 'data:image/png;base64,photo';
      this.onload();
    }
  },
  save: (draft) => persisted.push(structuredClone(draft)),
};
context.window = context;
vm.runInNewContext(
  fs.readFileSync('public/app.js', 'utf8') + `
    changed = () => {};
    renderPhotos = () => {};
    persist = async () => save(state.draft);
    doSync = async () => { await persist(); };
    state.draft = { inspection_id: 'original', photos: [] };
    globalThis.capture = addPhoto;
    globalThis.transition = () => {
      const next = async () => { state.draft = { inspection_id: 'next', photos: [] }; };
      return syncChain.catch(() => {}).then(next);
    };
    globalThis.current = () => state.draft;
  `,
  context,
);
(async () => {
  const capture = context.capture({ size: 10, type: 'image/png' });
  const transition = context.transition();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].inspection_id, 'original');
  assert.equal(persisted[0].photos[0].data_url, 'data:image/png;base64,photo');
  assert.equal(context.current().inspection_id, 'original');
  resolveLocation({ source: 'not_shared' });
  await capture;
  await transition;
  assert.equal(persisted[1].photos[0].location.source, 'not_shared');
  assert.equal(context.current().inspection_id, 'next');
  assert.equal(context.current().photos.length, 0);
  console.log('PASS: photo persists before location and holds the draft transition');
})().catch((error) => { console.error(error); process.exitCode = 1; });
