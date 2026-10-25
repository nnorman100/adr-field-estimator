const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const elements = new Map();
const element = (id) => {
  if (!elements.has(id)) elements.set(id, { value: '', textContent: '', hidden: false });
  return elements.get(id);
};
const context = {
  ADRCore: require('../public/core.js'),
  document: { getElementById: element, addEventListener() {} },
  navigator: { onLine: true },
  location: { href: 'https://localhost/app' },
  console,
  crypto: { randomUUID: () => 'a'.repeat(32) },
  setInterval: () => 1,
  clearInterval() {},
  clearTimeout() {},
  structuredClone,
};
context.window = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync('public/app.js', 'utf8'), context);
(async () => {
  await vm.runInContext(`(async () => {
    globalThis.events = [];
    globalThis.localRows = [];
    state.draft = { inspection_id: 'job', data: { scope_confirmed: true } };
    state.user = {};
    state.record = { voice_notes: [{ id: 'remote', status: 'transcribed', reviewed: false }] };
    draftNotes = async () => localRows;
    saveNote = async (note) => { events.push('save'); };
    renderNotes = () => {};
    renderControls = () => {};
    say = () => {};
    absorb = (record) => { state.record = record; };
    jsonApi = async (url) => {
      events.push(url);
      return { voice_notes: [{ id: 'remote', status: 'transcribed', reviewed: true }] };
    };
    await reviewVoiceNotes();
  })()`, context);
  assert.equal(context.events.length, 1);
  assert.equal(context.events[0], '/api/inspections/job/voice-notes/remote/review');
  assert.equal(vm.runInContext('unreviewedVoiceNotes([]).length', context), 0);
  await vm.runInContext(`(async () => {
    events.length = 0;
    navigator.onLine = false;
    dbAction = async () => { events.push('delete'); };
    globalThis.failed = { id: 'failed', draft_key: 'job', status: 'failed', reserved: true };
  })()`, context);
  await assert.rejects(vm.runInContext('removeNote(failed)', context), /requires a connection/);
  assert.equal(context.events.length, 0);
  await vm.runInContext(`(async () => {
    navigator.onLine = true;
    jsonApi = async () => { throw Error('server refused'); };
  })()`, context);
  await assert.rejects(vm.runInContext('removeNote(failed)', context), /server refused/);
  assert.equal(context.events.length, 0);
  await vm.runInContext(`(async () => {
    jsonApi = async () => { events.push('resolve'); return {}; };
    await removeNote(failed);
  })()`, context);
  assert.deepEqual(Array.from(context.events), ['resolve', 'delete']);
  await vm.runInContext(`(async () => {
    events.length = 0;
    state.documents = {};
    navigator.mediaDevices = { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) };
    MediaRecorder = class {
      static isTypeSupported() { return true; }
      start() { events.push('capture'); }
    };
    doSync = async () => { events.push('sync'); };
    reserveNote = async () => { events.push('reserve'); };
    invalidate = () => { events.push('invalidate'); state.documents = null; };
    await recordNote();
  })()`, context);
  assert.deepEqual(Array.from(context.events), ['save', 'sync', 'reserve', 'invalidate', 'capture']);
  console.log('PASS: recording reservation, failed-note retention and server transcript review');
})().catch((error) => { console.error(error); process.exitCode = 1; });
