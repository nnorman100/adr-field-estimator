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
  await vm.runInContext(
    `(async () => {
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
  })()`,
    context,
  );
  assert.equal(context.events.length, 1);
  assert.equal(context.events[0], '/api/inspections/job/voice-notes/remote/review');
  assert.equal(vm.runInContext('unreviewedVoiceNotes([]).length', context), 0);
  await vm.runInContext(
    `(async () => {
    events.length = 0;
    navigator.onLine = false;
    dbAction = async () => { events.push('delete'); };
    globalThis.failed = { id: 'failed', draft_key: 'job', status: 'failed', reserved: true };
  })()`,
    context,
  );
  await assert.rejects(vm.runInContext('removeNote(failed)', context), /requires a connection/);
  assert.equal(context.events.length, 0);
  await vm.runInContext(
    `(async () => {
    navigator.onLine = true;
    jsonApi = async () => { throw Error('server refused'); };
  })()`,
    context,
  );
  await assert.rejects(vm.runInContext('removeNote(failed)', context), /server refused/);
  assert.equal(context.events.length, 0);
  await vm.runInContext(
    `(async () => {
    jsonApi = async () => { events.push('resolve'); return {}; };
    await removeNote(failed);
  })()`,
    context,
  );
  assert.deepEqual(Array.from(context.events), ['resolve', 'delete']);
  await vm.runInContext(
    `(async () => {
    events.length = 0;
    state.documents = {};
    navigator.mediaDevices = { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) };
    MediaRecorder = class {
      static isTypeSupported() { return true; }
      start() { events.push('capture'); }
    };
    doSync = async () => { events.push('sync'); };
    reserveNote = async () => { events.push('reserve'); };
    changed = () => { events.push('invalidate'); state.documents = null; state.draft.data.scope_confirmed = false; };
    persist = async () => {};
    await recordNote();
  })()`,
    context,
  );
  assert.deepEqual(Array.from(context.events), [
    'save',
    'sync',
    'reserve',
    'invalidate',
    'capture',
  ]);
  assert.equal(vm.runInContext('state.draft.data.scope_confirmed', context), false);
  await vm.runInContext(
    'notes.recorder = null; notes.note = null; navigator.onLine = false; state.draft.homeowner_link_pending = true; events.length = 0;',
    context,
  );
  await assert.rejects(vm.runInContext('recordNote()', context), /Connect to cancel it/);
  assert.equal(context.events.length, 0);
  await vm.runInContext(
    `(async () => {
    globalThis.recoveryBase = {
      technician_transcript: '', scope_confirmed: true, labor_hours: 1,
    };
    globalThis.recoveryRemote = {
      ...recoveryBase,
      technician_transcript: '[Offline voice note abcdef01 · Room]\\n80 SF drywall.\\n',
      scope_confirmed: false,
    };
    globalThis.recoveryLocal = { ...recoveryBase, labor_hours: 5 };
    localRows = [{ id: 'abcdef01' + 'a'.repeat(24), status: 'saved', error: 'lost response' }];
    globalThis.recoveredNotes = [];
    globalThis.recovered = await takeLostNotes(
      'job', stable(recoveryBase), recoveryLocal, recoveryRemote,
      async (note) => recoveredNotes.push(note),
    );
  })()`,
    context,
  );
  assert.equal(context.recovered, true);
  assert.equal(context.recoveryLocal.scope_confirmed, false);
  assert.equal(context.recoveryLocal.labor_hours, 5);
  assert.equal(
    context.recoveryLocal.technician_transcript,
    context.recoveryRemote.technician_transcript,
  );
  assert.equal(context.recoveredNotes[0].status, 'done');
  await vm.runInContext(
    `(async () => {
    state.draft.data = { ...recoveryBase, labor_hours: 7 };
    state.ack = stable(recoveryBase);
    $('scopeConfirmed').checked = true;
    await absorbNotes({ data: recoveryRemote });
  })()`,
    context,
  );
  assert.equal(element('scopeConfirmed').checked, false);
  assert.equal(vm.runInContext('state.draft.data.labor_hours', context), 7);
  assert.equal(vm.runInContext('state.ack === stable(recoveryRemote)', context), true);
  await vm.runInContext(
    `(async () => {
    globalThis.conflictingLocal = { ...recoveryBase, labor_hours: 9 };
    globalThis.refused = await takeLostNotes(
      'job', stable(recoveryBase), conflictingLocal,
      { ...recoveryRemote, labor_hours: 2 },
    );
  })()`,
    context,
  );
  assert.equal(context.refused, false);
  assert.equal(context.conflictingLocal.scope_confirmed, true);
  assert.equal(context.conflictingLocal.technician_transcript, '');
  for (const confirmed of [false, true]) {
    context.confirmed = confirmed;
    await vm.runInContext(
      `(async () => {
      const base = { ...recoveryBase, scope_confirmed: confirmed };
      globalThis.withLocalText = {
        ...base, scope_confirmed: true, technician_transcript: 'Additional local observation.',
      };
      globalThis.merged = await takeLostNotes(
        'job', stable(base), withLocalText, recoveryRemote, async () => {},
      );
    })()`,
      context,
    );
    assert.equal(context.merged, true);
    assert.equal(context.withLocalText.scope_confirmed, false);
    assert.equal(
      context.withLocalText.technician_transcript,
      context.recoveryRemote.technician_transcript + 'Additional local observation.',
    );
  }
  await vm.runInContext(
    `(async () => {
    globalThis.ordinary = { ...recoveryBase, labor_hours: 3 };
    globalThis.ordinaryMerged = await takeLostNotes(
      'job', stable(recoveryBase), ordinary,
      { ...recoveryRemote, scope_confirmed: true }, async () => {},
    );
  })()`,
    context,
  );
  assert.equal(context.ordinaryMerged, true);
  assert.equal(context.ordinary.scope_confirmed, true);
  assert.equal(context.ordinary.labor_hours, 3);
  await vm.runInContext(
    `(async () => {
    globalThis.reservationRemote = { ...recoveryBase, scope_confirmed: false };
    globalThis.reservationLocal = {
      ...recoveryBase, labor_hours: 6, technician_transcript: 'Edited local observations.',
    };
    globalThis.reservationSaves = [];
    globalThis.reservationRecovered = await takeLostNotes(
      'background-job', stable(recoveryBase), reservationLocal, reservationRemote,
      async (note) => reservationSaves.push(note),
    );
  })()`,
    context,
  );
  assert.equal(context.reservationRecovered, true);
  assert.equal(context.reservationLocal.scope_confirmed, false);
  assert.equal(context.reservationLocal.labor_hours, 6);
  assert.equal(context.reservationLocal.technician_transcript, 'Edited local observations.');
  assert.equal(context.reservationSaves.length, 0);
  assert.equal(context.localRows[0].status, 'saved');
  await vm.runInContext(
    `(async () => {
    state.draft.data = { ...recoveryBase, labor_hours: 8 };
    state.ack = stable(recoveryBase);
    $('scopeConfirmed').checked = true;
    await absorbNotes({ data: reservationRemote });
  })()`,
    context,
  );
  assert.equal(element('scopeConfirmed').checked, false);
  assert.equal(vm.runInContext('state.draft.data.labor_hours', context), 8);
  assert.equal(vm.runInContext('state.ack === stable(reservationRemote)', context), true);
  await vm.runInContext(
    `(async () => {
    globalThis.reservationConflict = { ...recoveryBase, labor_hours: 4 };
    globalThis.reservationRefused = await takeLostNotes(
      'background-job', stable(recoveryBase), reservationConflict,
      { ...reservationRemote, labor_hours: 2 },
    );
  })()`,
    context,
  );
  assert.equal(context.reservationRefused, false);
  assert.equal(context.reservationConflict.scope_confirmed, true);
  assert.equal(context.reservationConflict.labor_hours, 4);
  await vm.runInContext(
    `(async () => {
    navigator.onLine = true;
    state.record = { revision: 10, audit: {} };
    state.draft.homeowner_link_pending = false;
    globalThis.linkStatusRequests = [];
    jsonApi = async (url) => { linkStatusRequests.push(url); return { status: 'pending' }; };
    await loadHomeownerLinkStatus();
    navigator.onLine = false;
  })()`,
    context,
  );
  assert.deepEqual(Array.from(context.linkStatusRequests), ['/api/inspections/job/signing-links']);
  await assert.rejects(vm.runInContext('recordNote()', context), /Connect to cancel it/);
  await vm.runInContext('delete state.draft.homeowner_link_pending;', context);
  await assert.rejects(vm.runInContext('recordNote()', context), /Connect to cancel it/);
  await vm.runInContext(
    `(async () => {
    navigator.onLine = true;
    jsonApi = async () => ({ status: 'revoked' });
    await loadHomeownerLinkStatus();
    navigator.onLine = false;
  })()`,
    context,
  );
  assert.equal(vm.runInContext('voiceNoteNeedsLinkCancellation(state.draft)', context), false);
  await vm.runInContext('delete state.draft.homeowner_link_pending; state.record.audit = null;', context);
  assert.equal(vm.runInContext('voiceNoteNeedsLinkCancellation(state.draft)', context), false);
  console.log('PASS: voice-note lifecycle and lost-response confirmation recovery');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
