const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  vm = require('node:vm');
const core = require('../public/core.js');
assert.deepEqual(fs.readFileSync('index.html'), fs.readFileSync('public/index.html'));
{
  const manifest = JSON.parse(fs.readFileSync('public/manifest.webmanifest', 'utf8'));
  assert.equal(manifest.name, 'DryScope');
  assert.equal(manifest.short_name, 'DryScope');
  assert.equal(manifest.theme_color, '#0B2545');
  assert.equal(manifest.background_color, '#F6F8FA');
  const css = fs.readFileSync('public/app.css', 'utf8');
  assert.doesNotMatch(css, /#d42b32|#b9232a|--green|--adr\b/i);

  const listeners = {},
    deleted = [];
  let precached;
  const worker = vm.runInNewContext(
    fs.readFileSync('public/sw.js', 'utf8') + '\n({ version: VERSION, cache: CACHE });',
    {
      self: {
        addEventListener: (event, listener) => (listeners[event] = listener),
        clients: { claim: async () => {} },
      },
      caches: {
        open: async (name) => {
          assert.equal(name, 'dryscope-' + worker.version);
          return { addAll: async (assets) => (precached = Array.from(assets)) };
        },
        keys: async () => ['alert-disaster-old', 'dryscope-old', worker.cache, 'unrelated'],
        delete: async (name) => deleted.push(name),
      },
    },
  );
  (async () => {
    let work;
    const event = { waitUntil: (promise) => (work = promise) };
    listeners.install(event);
    await work;
    // The field shell must cold-load offline; signing links remain an online-only page.
    const html = fs.readFileSync('public/index.html', 'utf8');
    const assets = [...html.matchAll(/<(?:script|link|img)\b[^>]*\b(?:src|href)="([^"]+)"/g)];
    assert.ok(assets.length > 0);
    for (const [, asset] of assets) {
      assert.ok(precached.includes(asset), `HTML asset missing from precache: ${asset}`);
    }
    listeners.activate(event);
    await work;
    assert.deepEqual(deleted, ['alert-disaster-old', 'dryscope-old']);
    console.log(
      'PASS: DryScope install identity, palette, complete shell precache and cache rotation',
    );
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
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
{
  // A historical agreement with no saved rooms shows no default room or water tag.
  for (const record of [
    { address: '1 Old St' },
    { address: '1 Old St', inspection: {} },
    { address: '1 Old St', inspection: { rooms: [] } },
  ]) {
    const data = core.signedDraftData(record);
    assert.deepEqual(data.rooms, [], JSON.stringify(record));
    assert.equal(data.address, '1 Old St');
  }
  const saved = { name: 'Kitchen', category: 3, unfinished_sf: 0, finished_sf: 9 };
  const kept = core.signedDraftData({ address: 'x', inspection: { rooms: [saved] } });
  assert.deepEqual(kept.rooms, [saved]);
  assert.equal(core.emptyData().rooms.length, 1, 'new jobs keep the default room');
}
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
assert.equal(newRoom.rooms.length, 1);
assert.equal(newRoom.rooms[0].name, 'Bathroom');
assert.equal(newRoom.rooms[0].category, 2);
// The loss type is a label beside the category: new rooms start as water, the walkthrough answer
// sets it, and a category-3 room may stay water.
assert.equal(original.rooms[0].loss, 'water');
assert.equal(newRoom.rooms[0].loss, 'water');
const labelled = core.applyScopeChanges(original, [
  { field: 'category', room: 'Room 1', value: 3 },
  { field: 'loss', room: 'Room 1', value: 'both' },
]);
assert.deepEqual([labelled.rooms[0].category, labelled.rooms[0].loss], [3, 'both']);
assert.equal(core.scopeRoomLabels.loss, 'Loss type');
// A room saved before the label existed reads as the tag it showed then; an explicit label wins.
assert.equal(core.roomLoss({ category: 1 }), 'water');
assert.equal(core.roomLoss({ category: 3 }), 'mold');
assert.equal(core.roomLoss({ category: 3, loss: 'water' }), 'water');
console.log(
  'PASS: selective scope application preserves manual values and sheet defaults; resets confirmation and requires complete new-room measurements',
);

{
  const fresh = core.emptyData(),
    changes = [
      { room: 'Kitchen', field: 'category', value: 2 },
      { room: 'Kitchen', field: 'finished_sf', value: 80 },
    ],
    kitchen = core.applyScopeChanges(fresh, changes);
  assert.equal(kitchen.rooms.length, 1);
  assert.deepEqual(kitchen.rooms[0], {
    ...fresh.rooms[0],
    name: 'Kitchen',
    category: 2,
    finished_sf: 80,
  });
  assert.deepEqual(core.defaultPhotoRename(fresh, kitchen), { from: 'Room 1', to: 'Kitchen' });
  assert.deepEqual(core.defaultPhotoRename(kitchen, fresh), { from: 'Kitchen', to: 'Room 1' });
  for (const patch of [{ name: 'Office' }, { finished_sf: 5 }, { custom_cabinetry: true }]) {
    const manual = core.emptyData();
    Object.assign(manual.rooms[0], patch);
    const applied = core.applyScopeChanges(manual, changes);
    assert.equal(applied.rooms.length, 2);
    assert.deepEqual(applied.rooms[0], manual.rooms[0]);
    assert.equal(core.defaultPhotoRename(manual, applied), null);
  }
  const withWaste = core.emptyData();
  withWaste.rooms[0].waste_percent = 15;
  withWaste.rooms[0].category = 3;
  const preserved = core.applyScopeChanges(withWaste, changes);
  assert.equal(preserved.rooms.length, 1);
  assert.equal(preserved.rooms[0].waste_percent, 15);
  assert.equal(preserved.rooms[0].category, 2);
  const both = core.applyScopeChanges(fresh, [
    ...changes,
    { room: 'Room 1', field: 'finished_sf', value: 5 },
  ]);
  assert.equal(both.rooms.length, 2);
  assert.equal(both.rooms[0].name, 'Room 1');
  assert.equal(core.defaultPhotoRename(fresh, both), null);
  const multiple = core.applyScopeChanges(fresh, [
    ...changes,
    { room: 'Hall', field: 'category', value: 1 },
    { room: 'Hall', field: 'unfinished_sf', value: 20 },
  ]);
  assert.deepEqual(
    multiple.rooms.map((room) => room.name),
    ['Kitchen', 'Hall'],
  );
  assert.throws(() => core.applyScopeChanges(fresh, changes.slice(1)));
  assert.deepEqual(core.defaultPhotoRename(multiple, fresh), { from: 'Kitchen', to: 'Room 1' });
  assert.equal(core.defaultPhotoRename({ rooms: [kitchen.rooms[0], fresh.rooms[0]] }, fresh), null);
}

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
  // gemini-3.8-live never sends finished, so turn events must separate the saved utterances.
  const core = require('../public/core.js'),
    data = core.emptyData();
  data.capture_metadata = { capture_id: 'c'.repeat(32), status: 'recording', segments: [] };
  let sequence = 0;
  const say = (speaker, text, connection_id = 'live') =>
    core.ingestTranscript(data, {
      speaker,
      connection_id,
      sequence: ++sequence,
      text,
      finished: null,
    });
  say('technician', 'This is ');
  say('technician', 'the kitchen.');
  say('assistant', 'Which wall?');
  assert.equal(core.closeTranscript(data, 'live', ['technician', 'assistant']), true);
  say('technician', 'The east wall.');
  say('assistant', 'Got it.');
  assert.equal(data.technician_transcript, 'This is the kitchen.\nThe east wall.');
  assert.equal(data.assistant_transcript, 'Which wall?\nGot it.');
  // An interruption closes only the assistant's cut-off reply.
  assert.equal(core.closeTranscript(data, 'live', ['assistant']), true);
  assert.equal(core.closeTranscript(data, 'live', ['assistant']), false);
  say('assistant', 'Go ahead.');
  say('technician', ' Two feet up.');
  assert.equal(data.assistant_transcript, 'Which wall?\nGot it.\nGo ahead.');
  assert.equal(data.technician_transcript, 'This is the kitchen.\nThe east wall. Two feet up.');
  // A stale connection's turn event never touches the current connection's open segment.
  assert.equal(core.closeTranscript(data, 'earlier', ['technician']), false);
  assert.equal(core.closeTranscript(core.emptyData(), 'live', ['assistant']), false);
  console.log('PASS: Live turn and interruption events close transcript segments');
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
  // Safari opened the app at web.app. (trailing dot), where Google sign-in and Live are refused.
  assert.equal(
    core.canonicalUrl('https://alert-disaster-field-2026.web.app./'),
    'https://alert-disaster-field-2026.web.app/',
  );
  assert.equal(
    core.canonicalUrl('https://alert-disaster-field-2026.web.app../sign?x=1#link-token'),
    'https://alert-disaster-field-2026.web.app/sign?x=1#link-token',
  );
  assert.equal(core.canonicalUrl('https://localhost.:8765/?a=b'), 'https://localhost:8765/?a=b');
  for (const href of [
    'https://alert-disaster-field-2026.web.app/',
    'https://alert-disaster-field-2026.web.app/sign#token.',
    'https://alert-disaster-field-2026.web.app/path./?q=.',
    'https://localhost:8765/',
  ])
    assert.equal(core.canonicalUrl(href), null, href);
  console.log(
    'PASS: auth stage derivation, non-enumerating sign-in error messages with diagnosable codes, same-origin live authDomain and canonical trailing-dot host',
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
{
  // Offline notes list what a technician can still fill on site before leaving.
  const data = core.emptyData();
  assert.deepEqual(core.missingItems(data), [
    'No property address',
    'No year built',
    'No measured demolition area for Room 1',
    'No photo of Room 1',
    'No drying equipment counts',
  ]);
  Object.assign(data, { address: '1 Test Way', year_built: 1990, air_movers: 3 });
  data.rooms = [
    { ...data.rooms[0], name: 'Bedroom 2', finished_sf: 120 },
    { ...data.rooms[0], name: 'Hall', unfinished_sf: 0 },
  ];
  assert.deepEqual(core.missingItems(data, [{ room: ' bedroom  2 ' }]), [
    'No measured demolition area for Hall',
    'No photo of Hall',
  ]);
  data.rooms = [];
  assert.deepEqual(core.missingItems(data), ['No affected rooms']);
  // iPhone Safari records MP4; Chrome falls back to WebM Opus; nothing supported means typing only.
  assert.deepEqual(
    core.noteFormat((type) => type === 'audio/mp4'),
    { recorder: 'audio/mp4', upload: 'audio/mp4' },
  );
  assert.deepEqual(
    core.noteFormat((type) => type.startsWith('audio/webm')),
    { recorder: 'audio/webm;codecs=opus', upload: 'audio/webm' },
  );
  assert.equal(
    core.noteFormat(() => false),
    null,
  );
  console.log('PASS: offline notes list missing scope and pick a recordable audio format');
}
{
  // The audit-block banner names only the causes the audit actually lists.
  const core = require('../public/core.js'),
    photo = (room, ocr_status) => ({ id: room + ocr_status, room, ocr_status }),
    dehumidifier =
      'Office: One dehumidifier rental for 3 days requested by technician is omitted from the priced scope.';
  // The 1234 Acme St test job: one unpriced item, both photos read as no_meter.
  const unpriced = core.auditBlockMessage({
    unpriced_work: [dehumidifier],
    company_setup_missing: [],
    photo_audit_log: [photo('Office', 'no_meter'), photo('Office', 'no_meter')],
  });
  assert.equal(
    unpriced,
    "Can't sign yet: 1 item to fix. Unpriced work: " +
      dehumidifier +
      ' Add it on 2. Check Scope (Rooms & demolition or Equipment & additional labor), or tap Fill scope from walkthrough, then Finish & review again.',
  );
  assert.doesNotMatch(unpriced, /evidence|Photo recognition/);
  assert.equal(
    core.auditBlockMessage({
      unpriced_work: [],
      photo_audit_log: [photo('Office', 'verified'), photo('Office', 'pending')],
    }),
    "Can't sign yet: 1 item to fix. Photo recognition is still running for Photo 2 (Office). Wait a moment, then Finish & review again.",
  );
  const setupGap = {
    company_setup_missing: ['CSLB license', 'Document sign-off'],
    unpriced_work: [],
    photo_audit_log: [],
  };
  assert.equal(
    core.auditBlockMessage(setupGap, true),
    "Can't sign yet: 2 items to fix. Company settings are missing the CSLB license and Document sign-off. Complete them in Company settings, then Finish & review again.",
  );
  // Estimators cannot open Company settings, so they are sent to the owner instead.
  assert.equal(
    core.auditBlockMessage(setupGap, false),
    "Can't sign yet: 2 items to fix. Company settings are missing the CSLB license and Document sign-off. Ask your company owner to complete them in Company settings, then Finish & review again.",
  );
  assert.equal(
    core.auditBlockMessage({
      unpriced_work: ['Kitchen: Plumbing reset lacks an ADR rate.', 'Hall: Baseboard removal.'],
      photo_audit_log: [
        photo('Kitchen', 'pending'),
        photo('Hall', 'no_meter'),
        photo('Hall', 'pending'),
        photo('Bath', 'pending'),
      ],
    }),
    "Can't sign yet: 5 items to fix. Unpriced work: Kitchen: Plumbing reset lacks an ADR rate. Unpriced work: Hall: Baseboard removal. Add them on 2. Check Scope (Rooms & demolition or Equipment & additional labor), or tap Fill scope from walkthrough, then Finish & review again. Photo recognition is still running for Photo 1 (Kitchen), Photo 3 (Hall) and Photo 4 (Bath). Wait a moment, then Finish & review again.",
  );
  // Only job charges, with no measured work, equipment or labor: the server lists nothing else.
  assert.equal(
    core.auditBlockMessage({ unpriced_work: [], company_setup_missing: [], photo_audit_log: [] }),
    "Can't sign yet: no measured demolition, drying equipment or labor is entered. Add the work on 2. Check Scope, then Finish & review again.",
  );
  console.log('PASS: the audit-block banner lists each unpriced item, setup gap and pending photo');
}
{
  // Drying-log psychrometrics: the browser shows the same values the server stores.
  const psychro = require('../public/psychrometrics.js');
  for (const [tempF, rh, gpp, dewPoint] of [
    [70, 50, 54, 51],
    [75, 50, 65, 55],
    [80, 40, 61, 54],
    [32, 100, 26, 32],
    [74, 72, 91, 64],
    [86, 36, 67, 56],
    [68, 45, 46, 46],
  ]) {
    const result = psychro.psychrometrics(tempF, rh);
    assert.equal(result.gpp, gpp, tempF + '°F / ' + rh + '% GPP');
    assert.equal(result.dew_point_f, dewPoint, tempF + '°F / ' + rh + '% dew point');
  }
  assert.deepEqual(psychro.psychrometrics(70, 50), {
    gpp: 54,
    dew_point_f: 51,
    dew_point_depression_f: 19,
    vapor_pressure_inhg: 0.37,
    enthalpy_btu_lb: 25.3,
  });
  // Blank or unreadable input calculates nothing rather than treating it as zero degrees.
  for (const [t, rh] of [
    ['', 50],
    [70, ''],
    [null, 50],
    ['abc', 50],
  ])
    assert.equal(psychro.psychrometrics(t, rh), null);
  // Drying-day summaries against IICRC S500 field guidance: dehumidifier grain depression
  // (inlet GPP − outlet GPP) is acceptable from 12 and optimal from 20 grains; chamber-to-exhaust
  // vapor pressure differential is moderate from 0.12 and high from 0.25 inHg (vapor pressures
  // from the ASHRAE/Magnus equations above); outside air more than 20 GPP drier than the
  // chamber permits a controlled open system.
  for (const [inlet, outlet, delta, status, efficiency] of [
    [91, 67, 24, 'optimal', 26],
    [70, 50, 20, 'optimal', 29],
    [70, 52, 18, 'acceptable', 26],
    [51, 39, 12, 'acceptable', 24],
    [51, 40, 11, 'low', 22],
    [89, 84, 5, 'low', 6],
    [50, 50, 0, 'none', 0],
    [50, 60, -10, 'none', 0],
  ])
    assert.deepEqual(psychro.grainDepression(inlet, outlet), {
      delta_gpp: delta,
      status,
      efficiency_percent: efficiency,
    });
  for (const [affected, outlet, delta, potential] of [
    [0.7, 0.4, 0.3, 'high'],
    [0.609, 0.451, 0.158, 'moderate'],
    [0.5, 0.45, 0.05, 'low'],
    [0.45, 0.45, 0, 'stagnant'],
    [0.4, 0.45, -0.05, 'stagnant'],
  ])
    assert.deepEqual(psychro.vaporPressureDifferential(affected, outlet), {
      delta_inhg: delta,
      potential,
    });
  // DryScope's Day 1 preset: 74 °F / 72 % chamber air over 86 °F / 36 % dehumidifier exhaust.
  const chamber = psychro.psychrometrics(74, 72),
    exhaust = psychro.psychrometrics(86, 36);
  assert.equal(psychro.grainDepression(chamber.gpp, exhaust.gpp).status, 'optimal');
  assert.equal(
    psychro.vaporPressureDifferential(chamber.vapor_pressure_inhg, exhaust.vapor_pressure_inhg)
      .potential,
    'moderate',
  );
  assert.equal(psychro.dryingSystem(61, 91), 'open');
  assert.equal(psychro.dryingSystem(70, 91), 'open');
  assert.equal(psychro.dryingSystem(71, 91), 'closed');
  assert.equal(psychro.dryingSystem(54, 51), 'closed');

  // Three monitoring days in one wet room, with a dry reference room, outside air and a
  // dehumidifier outlet reading on day 1; one reading for a room that was since renamed.
  let n = 0;
  const entry = (taken, fields) => ({
    id: String(++n).padStart(32, '0'),
    recorded_at: taken,
    recorded_by: 'tech@example.invalid',
    note: '',
    taken_at: taken,
    ...fields,
  });
  const air = (taken, room, zone, t, rh) =>
    entry(taken, {
      kind: 'air',
      room,
      zone,
      temperature_f: t,
      relative_humidity: rh,
      ...psychro.psychrometrics(t, rh),
    });
  const readings = [
    air('2026-10-23T15:00:00Z', 'Bathroom', 'affected', 73, 42),
    air('2026-10-21T15:00:00Z', 'Bathroom', 'affected', 74, 72),
    air('2026-10-21T15:10:00Z', 'Hall', 'unaffected', 68, 45),
    air('2026-10-21T15:20:00Z', '', 'outside', 62, 74),
    air('2026-10-21T15:30:00Z', 'Bathroom', 'dehu_outlet', 86, 36),
    entry('2026-10-21T15:40:00Z', {
      kind: 'material',
      room: 'Bathroom',
      material: 'Drywall',
      moisture: 28,
      unit: '%MC',
      dry_standard: 12,
      affected: true,
    }),
    air('2026-10-22T15:00:00Z', 'Bathroom', 'affected', 76, 52),
    entry('2026-10-23T15:05:00Z', {
      kind: 'thermal',
      room: 'Old room',
      delta_t_f: -6.4,
      pattern: 'cold_anomaly',
      boundary: '',
    }),
  ];
  const utcDay = (iso) => iso.slice(0, 10);
  const summary = psychro.summarizeLog(
    readings,
    [{ name: 'Bathroom' }, { name: 'Kitchen' }, { name: 'Hall' }],
    utcDay,
  );
  assert.deepEqual(summary.days, ['2026-10-21', '2026-10-22', '2026-10-23']);
  // Current rooms first in Check Scope order, then names no room carries, then outside/whole job.
  assert.deepEqual(
    summary.groups.map((g) => [g.room, g.known, g.count]),
    [
      ['Bathroom', true, 5],
      ['Kitchen', true, 0],
      ['Hall', true, 1],
      ['Old room', false, 1],
      ['', false, 1],
    ],
  );
  const bathroom = summary.groups[0];
  assert.deepEqual(
    bathroom.days.map((d) => [d.number, d.readings.length, d.above_standard, d.system]),
    [
      [1, 3, 45, 'open'],
      [2, 1, 24, 'closed'],
      [3, 1, 5, 'closed'],
    ],
  );
  // Readings inside a day keep time order even when they were saved out of order.
  assert.deepEqual(
    bathroom.days[0].readings.map((r) => r.taken_at.slice(11, 16)),
    ['15:00', '15:30', '15:40'],
  );
  assert.deepEqual(bathroom.days[0].depression, {
    delta_gpp: 24,
    status: 'optimal',
    efficiency_percent: 26,
  });
  assert.equal(bathroom.days[0].vapor.potential, 'moderate');
  assert.equal(bathroom.days[1].depression, null);
  // The day-1 dry reference (46 GPP) still anchors later days until a newer one is taken.
  assert.deepEqual(bathroom.progress, {
    first_gpp: 91,
    latest_gpp: 51,
    reference_gpp: 46,
    percent: 89,
    days: 3,
  });
  assert.equal(summary.groups[1].progress, null);
  assert.equal(summary.groups[2].days[0].above_standard, null);
  // No readings, no days and no invented rooms beyond the job's own.
  assert.deepEqual(psychro.summarizeLog([], [{ name: 'Room 1' }], utcDay), {
    days: [],
    groups: [{ room: 'Room 1', known: true, days: [], progress: null, count: 0 }],
  });
  console.log('PASS: psychrometric values and per-room drying-log summary');
}
