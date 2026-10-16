const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  vm = require('node:vm');
const core = require('../public/core.js');
assert.deepEqual(fs.readFileSync('index.html'), fs.readFileSync('public/index.html'));
assert.equal(core.money(2049.99), '$2,049.99');
assert.equal(core.estimateLabel({ proposed_cost: 1788.9 }), '$1,788.90');
assert.equal(
  core.estimateLabel({ proposed_cost_low: 1775, proposed_cost: 1788.9 }),
  '$1,775.00–$1,788.90',
);
assert.deepEqual(core.aspect(1080, 1920, 1280), [720, 1280]);
assert.equal(core.stable({ b: 2, a: 1 }), core.stable({ a: 1, b: 2 }));
assert.equal(core.emptyData().year_built, null);
assert.equal(core.emptyData().package_price, null);
const bytes = new Uint8Array([0, 128, 0, 0, 255, 127]);
assert.deepEqual([...core.pcmToFloat(bytes)], [-1, 0, 32767 / 32768]);
assert.throws(() => core.pcmToFloat(new Uint8Array([0])));
let Processor,
  packets = [];
const context = {
  AudioWorkletProcessor: class {
    constructor() {
      this.port = { postMessage: (p) => packets.push(p) };
    }
  },
  sampleRate: 48000,
  registerProcessor: (n, p) => (Processor = p),
  ArrayBuffer,
  DataView,
  Math,
};
vm.runInNewContext(fs.readFileSync('public/audio-worklet.js', 'utf8'), context);
const processor = new Processor();
for (let i = 0; i < 48000 / 128; i++) processor.process([[new Float32Array(128).fill(0.5)]]);
assert.equal(packets.length, 10);
assert.equal(packets[0].buffer.byteLength, 3200);
assert.equal(new DataView(packets[0].buffer).getInt16(0, true), 16384);
console.log(
  'PASS: currency, empty state, portrait aspect, PCM playback, continuous 16 kHz resampling and HTML mirror',
);

const original = core.emptyData();
original.scope_confirmed = true;
original.air_movers = 6;
const filled = core.applyScopeChanges(original, [
  { field: 'finished_sf', room: 'Room 1', value: 80 },
  { field: 'category', room: 'Room 1', value: 2 },
  { field: 'is_after_hours', room: null, value: false },
  { field: 'labor_hours', room: null, value: 0 },
]);
assert.equal(filled.scope_confirmed, false);
assert.equal(filled.rooms[0].finished_sf, 80);
assert.equal(filled.air_movers, 6);
assert.equal(filled.monitoring_hours, 13.25);
assert.equal(original.rooms[0].finished_sf, 0);
assert.equal(original.scope_confirmed, true);
assert.throws(() =>
  core.applyScopeChanges(original, [{ field: 'scope_confirmed', room: null, value: true }]),
);
assert.throws(() =>
  core.applyScopeChanges(original, [{ field: 'unit_price', room: null, value: 1 }]),
);
for (const field of ['has_crawl_space', 'granite_removal', 'water_heater_loss', 'work_performed'])
  assert.throws(() => core.applyScopeChanges(original, [{ field, room: null, value: true }]));
assert.throws(() =>
  core.applyScopeChanges(original, [{ field: 'finished_sf', room: 'New room', value: 10 }]),
);
const newRoom = core.applyScopeChanges(original, [
  { field: 'category', room: 'Bathroom', value: 2 },
  { field: 'finished_sf', room: 'bathroom', value: 80 },
]);
assert.equal(newRoom.rooms.length, 2);
assert.equal(newRoom.rooms[1].name, 'Bathroom');
assert.equal(newRoom.rooms[1].category, 2);
console.log(
  'PASS: selective scope application preserves manual values and sheet defaults; resets confirmation and requires complete new-room measurements',
);

{
  const core = require('../public/core.js'),
    data = core.emptyData();
  data.capture_metadata = { capture_id: 'a'.repeat(32), status: 'recording', segments: [] };
  const chunk = (sequence, text, finished = false) => ({
    speaker: 'technician',
    connection_id: 'one',
    sequence,
    text,
    finished,
  });
  core.ingestTranscript(data, chunk(1, 'Bath'));
  core.ingestTranscript(data, chunk(2, 'room', true));
  assert.equal(data.technician_transcript, 'Bathroom');
  assert.equal(core.ingestTranscript(data, chunk(2, 'room', true)).changed, false);
  core.ingestTranscript(data, chunk(3, '80 SF', true));
  assert.equal(data.technician_transcript, 'Bathroom\n80 SF');
  data.technician_transcript = 'x'.repeat(79999);
  assert.equal(core.ingestTranscript(data, chunk(4, 'overflow', true)).limit, true);
  assert.equal(data.technician_transcript.length, 79999);
  assert.equal(data.capture_metadata.status, 'truncated');
  console.log(
    'PASS: fragmented transcript boundaries, identity deduplication and explicit storage limits',
  );
}

{
  const core = require('../public/core.js'),
    data = core.emptyData();
  data.technician_transcript = '語'.repeat(60000);
  data.assistant_transcript = '文'.repeat(60000);
  data.capture_metadata = {
    capture_id: 'b'.repeat(32),
    status: 'recording',
    segments: [
      {
        speaker: 'technician',
        connection_id: 'old',
        sequence: 1,
        text: '語'.repeat(40000),
        finished: true,
      },
      {
        speaker: 'assistant',
        connection_id: 'old',
        sequence: 2,
        text: '文'.repeat(40000),
        finished: true,
      },
    ],
  };
  assert.equal(
    core.ingestTranscript(data, {
      speaker: 'technician',
      connection_id: 'new',
      sequence: 3,
      text: 'x',
      finished: true,
    }).limit,
    true,
  );
  assert.equal(data.technician_transcript.length, 60000);
  assert.equal(data.capture_metadata.segments.length, 2);
  console.log(
    'PASS: UTF-8 capture budget preserves earlier text and leaves room for saved evidence/audit metadata',
  );
}

{
  const password = (emailVerified) => ({
    emailVerified,
    providerData: [{ providerId: 'password' }],
  });
  assert.equal(core.authStage(null), 'signedOut');
  assert.equal(core.authStage(password(false)), 'unverified');
  assert.equal(core.authStage(password(true)), 'ready');
  assert.equal(
    core.authStage({ emailVerified: true, providerData: [{ providerId: 'google.com' }] }),
    'ready',
  );
  const message = (code) => core.authMessage({ code });
  assert.equal(
    new Set(
      [
        'auth/wrong-password',
        'auth/user-not-found',
        'auth/invalid-credential',
        'auth/invalid-login-credentials',
      ].map(message),
    ).size,
    1,
  );
  for (const code of [
    'auth/admin-restricted-operation',
    'auth/too-many-requests',
    'auth/network-request-failed',
    'auth/account-exists-with-different-credential',
  ])
    assert.notEqual(message(code), message('auth/wrong-password'));
  assert.equal(
    message('auth/account-exists-with-different-credential'),
    'This email already uses a different sign-in method. Use that method.',
  );
  assert.equal(
    message('auth/admin-restricted-operation'),
    'Ask your company owner for an invitation.',
  );
  assert.equal(
    core.authMessage(Error('raw provider detail')),
    'Sign-in could not be completed. Try again.',
  );
  // Unmapped Firebase codes are shown so an iPhone screenshot names the failure; other text is not.
  assert.equal(
    message('auth/popup-blocked'),
    'Sign-in could not be completed (auth/popup-blocked). Try again.',
  );
  assert.equal(
    message('auth/internal-error'),
    'Sign-in could not be completed (auth/internal-error). Try again.',
  );
  assert.equal(
    message('auth/popup-closed-by-user'),
    'Google sign-in was closed before it finished.',
  );
  for (const code of [undefined, null, 42, 'storage/unknown', 'auth/<b>x</b>', 'auth/x y'])
    assert.equal(message(code), 'Sign-in could not be completed. Try again.');
  const firebaseConfig = {
    projectId: 'alert-disaster-field-2026',
    authDomain: 'alert-disaster-field-2026.firebaseapp.com',
  };
  assert.equal(
    core.authDomainFor(firebaseConfig, 'alert-disaster-field-2026.web.app'),
    'alert-disaster-field-2026.web.app',
  );
  for (const host of [
    'alert-disaster-field-2026.firebaseapp.com',
    'alert-disaster-field-2026--loginpage-20261015b-rgxf1x24.web.app',
    'localhost:8765',
    'other-project.web.app',
    'alert-disaster-field-2026.web.app.example.com',
  ])
    assert.equal(
      core.authDomainFor(firebaseConfig, host),
      'alert-disaster-field-2026.firebaseapp.com',
      host,
    );
  console.log(
    'PASS: auth stage derivation, non-enumerating sign-in error messages with diagnosable codes and same-origin live authDomain',
  );
}

{
  const draft = {
    inspection_id: 'x',
    data: core.emptyData(),
    photos: [
      { id: 'a', room: 'Room 1', data_url: 'data:image/png;base64,AAAA', uploaded: false },
      { id: 'b', room: 'Room 1', uploaded: true },
    ],
  };
  const { draft: row, bytes } = core.splitPhotos(draft);
  assert.deepEqual(row.photos, [
    { id: 'a', room: 'Room 1', uploaded: false },
    { id: 'b', room: 'Room 1', uploaded: true },
  ]);
  assert.equal(row.data, draft.data);
  assert.deepEqual(bytes, [{ id: 'a', data_url: 'data:image/png;base64,AAAA' }]);
  assert.equal(draft.photos[0].data_url, 'data:image/png;base64,AAAA');
  console.log(
    'PASS: draft rows keep photo metadata while photo bytes split out without mutating the open draft',
  );
}
