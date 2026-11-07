const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  vm = require('node:vm');
const core = require('../public/core.js');

{
  // The sizing check's words come from the server result; empty states say what is missing.
  assert.equal(core.roomSizingNote({ status: 'not_applicable' }), 'mold only · no drying check');
  assert.equal(
    core.roomSizingNote({ status: 'not_available', missing: ['ceiling height', 'water class'] }),
    'check not available · add ceiling height and water class',
  );
  assert.equal(
    core.roomSizingNote({
      status: 'not_available',
      missing: [],
      problem: 'the wet floor area is larger than the floor area',
    }),
    'check not available · the wet floor area is larger than the floor area',
  );
  assert.equal(
    core.roomSizingNote({
      status: 'available',
      air_movers_min: 3,
      air_movers_max: 4,
      dehumidifier_ppd: 23,
    }),
    '3–4 air movers · 23 pints/day',
  );
  assert.equal(
    core.roomSizingNote({
      status: 'available',
      air_movers_min: null,
      air_movers_max: null,
      dehumidifier_ppd: 96,
    }),
    'air movers not sized: no wet floor · 96 pints/day',
  );
  assert.deepEqual(core.sizingSummary({ status: 'not_applicable', rooms: [] }), {
    empty: 'No water rooms. The drying check applies to rooms with water.',
  });
  assert.deepEqual(
    core.sizingSummary({
      status: 'not_available',
      rooms: [
        { name: 'Kitchen', status: 'available' },
        { name: 'Hall', status: 'not_available' },
        { name: ' ', status: 'not_available' },
      ],
    }),
    {
      empty:
        'Check not available. Add the floor area, ceiling height and water class under More room options for Hall and Unnamed room.',
    },
  );
  assert.deepEqual(
    core.sizingSummary({
      status: 'not_available',
      rooms: [
        { name: 'Hall', status: 'not_available', missing: ['water class'] },
        { name: 'Den', status: 'not_available', missing: [], problem: 'larger' },
      ],
    }),
    {
      empty:
        'Check not available. Add the floor area, ceiling height and water class under More room options for Hall. The wet floor area is larger than the floor area for Den.',
    },
  );
  const sizing = {
    status: 'available',
    rooms: [],
    air_movers: { entered: 6, min: 3, max: 4, flag: 'above', reason: 'More.' },
    dehumidifiers: {
      entered: 1,
      recommended_ppd: 23,
      unit_ppd: null,
      recommended_units: null,
      flag: null,
      reason: 'Rate it.',
    },
  };
  assert.deepEqual(core.sizingSummary(sizing).rows, [
    { label: 'Air movers', recommended: '3–4', entered: '6', flag: 'above', reason: 'More.' },
    {
      label: 'Dehumidification',
      recommended: '23 pints/day',
      entered: '1 LGR dehumidifier',
      flag: null,
      reason: 'Rate it.',
    },
  ]);
  Object.assign(sizing.dehumidifiers, {
    entered: 2,
    unit_ppd: 70,
    recommended_units: 1,
    flag: 'above',
  });
  assert.equal(core.sizingSummary(sizing).rows[1].recommended, '23 pints/day · 1 unit at 70');
  assert.equal(core.sizingSummary(sizing).rows[1].entered, '2 LGR dehumidifiers');
  assert.equal(core.sizingNote(sizing), '· Air movers above · Dehumidification above');
  sizing.air_movers.flag = 'within';
  sizing.dehumidifiers.flag = null;
  assert.equal(core.sizingNote(sizing), '· Air movers within range');
  sizing.air_movers.flag = null;
  assert.equal(core.sizingNote(sizing), '· sizing: add the dehumidifier rating');
  Object.assign(sizing.air_movers, { min: null, max: null, reason: 'No wet floor.' });
  assert.deepEqual(core.sizingSummary(sizing).rows[0], {
    label: 'Air movers',
    recommended: 'not sized',
    entered: '6',
    flag: null,
    reason: 'No wet floor.',
  });
  assert.equal(core.sizingNote(sizing), '· air movers not sized');
  sizing.dehumidifiers.flag = 'below';
  assert.equal(core.sizingNote(sizing), '· air movers not sized · Dehumidification below');
  assert.equal(
    core.sizingNote({ status: 'not_available', rooms: [] }),
    '· sizing check not available',
  );
  assert.equal(
    core.sizingNote({ status: 'not_applicable', rooms: [] }),
    '· no water rooms to size',
  );
  assert.equal(core.scopeRoomLabels.water_class, 'Water class');
  assert.equal(core.scopeRoomLabels.wet_floor_sf, 'Wet floor area SF');
  // A Room 1 holding any confirmed sizing input is kept when scope fills a named room.
  for (const [key, value] of [
    ['floor_sf', 140],
    ['wet_floor_sf', 0],
    ['ceiling_height_ft', 8],
    ['water_class', 2],
  ]) {
    const measured = core.emptyData();
    measured.rooms[0][key] = value;
    const applied = core.applyScopeChanges(measured, [
      { room: 'Kitchen', field: 'category', value: 2 },
      { room: 'Kitchen', field: 'finished_sf', value: 80 },
    ]);
    assert.deepEqual(
      applied.rooms.map((room) => room.name),
      ['Room 1', 'Kitchen'],
    );
    assert.equal(applied.rooms[0][key], value);
    assert.equal(applied.rooms[1][key], undefined);
    assert.equal(core.defaultPhotoRename(measured, applied), null);
  }
  console.log('PASS: the sizing check shows recommended beside entered counts with a worded flag');
}
{
  // Documents print only the recorded claim details, with the date as the proposal prints dates.
  assert.deepEqual(core.claimLines(undefined), []);
  assert.deepEqual(
    core.claimLines({
      carrier: 'Synthetic Mutual',
      claim_number: 'CLM-1',
      policy_number: '',
      date_of_loss: '2026-10-12',
      loss_cause: 'Supply line under kitchen sink',
      adjuster_name: 'Avery Quinn',
      adjuster_email: '',
      adjuster_phone: '555-0100',
      deductible: '$1,000',
    }),
    [
      'Insurance carrier: Synthetic Mutual',
      'Claim number: CLM-1',
      'Date of loss: 10-12-2026',
      'Cause and source of loss: Supply line under kitchen sink',
      'Adjuster: Avery Quinn · 555-0100',
      'Deductible: $1,000',
    ],
  );
  assert.deepEqual(core.claimLines({ carrier: '', claim_number: '', date_of_loss: '' }), []);
  assert.deepEqual(Object.keys(core.claimLabels), [
    'carrier',
    'claim_number',
    'policy_number',
    'date_of_loss',
    'loss_cause',
    'adjuster_name',
    'adjuster_email',
    'adjuster_phone',
    'deductible',
  ]);
  console.log('PASS: claim details print only recorded values in document headers');
}
{
  const row = (id, kind, address, customer = '', claim = '') => ({
    id,
    kind,
    address,
    customer,
    claim,
  });
  const rows = [
    row('d1', 'draft', '12 Oak Street', 'Jordan Lee', 'CLM-0042-77'),
    row('d2', 'draft', '', 'Priya Shah'),
    row('s1', 'signed', '9 Elm Avenue', 'Sam Ortiz', 'clm-9001'),
    row('l1', 'local', 'Oak Ridge Court'),
  ];
  const ids = (options) => core.filterJobs(rows, options).map((r) => r.id);
  assert.deepEqual(ids({ tab: 'all', query: '' }), ['d1', 'd2', 's1', 'l1']);
  assert.deepEqual(ids({ tab: 'drafts', query: '' }), ['d1', 'd2', 'l1']);
  assert.deepEqual(ids({ tab: 'signed', query: '' }), ['s1']);
  assert.deepEqual(ids({ tab: 'all', query: '  oak ' }), ['d1', 'l1']);
  assert.deepEqual(ids({ tab: 'all', query: 'PRIYA' }), ['d2']);
  assert.deepEqual(ids({ tab: 'all', query: 'CLM-9' }), ['s1']);
  assert.deepEqual(ids({ tab: 'signed', query: 'oak' }), []);
  assert.deepEqual(ids({ tab: 'drafts', query: '0042' }), ['d1']);
  const labels = (more) => core.jobTabs(rows, more).map((t) => t.tab + ' ' + t.label);
  assert.deepEqual(labels(), ['all All (4)', 'drafts Drafts (3)', 'signed Signed (1)']);
  // Counts ignore the search box and never read as complete while older pages remain.
  assert.deepEqual(labels({ drafts: true }), [
    'all All (4+)',
    'drafts Drafts (3+)',
    'signed Signed (1)',
  ]);
  assert.deepEqual(labels({ signed: true }), [
    'all All (4+)',
    'drafts Drafts (3)',
    'signed Signed (1+)',
  ]);
  console.log('PASS: jobs list tabs, counts and search cover drafts, local drafts and signed jobs');
}
{
  const fix = { source: 'device', latitude: 35.373292, longitude: -119.018712, accuracy_m: 12.5 };
  assert.equal(
    core.locationLabel(fix),
    'Location: 35.373292, -119.018712 (±13 m) · source: device',
  );
  assert.equal(
    core.locationUrl(fix),
    'https://www.google.com/maps/search/?api=1&query=35.373292,-119.018712',
  );
  // Missing fixes are shown as missing, with no link; photos from before location stamps say so.
  assert.equal(core.locationLabel({ source: 'not_shared' }), 'Location not shared');
  assert.equal(core.locationLabel({ source: 'not_available' }), 'Location not available');
  assert.equal(core.locationLabel(undefined), 'No location recorded');
  assert.equal(core.locationLabel(null), 'No location recorded');
  for (const none of [{ source: 'not_shared' }, { source: 'not_available' }, undefined])
    assert.equal(core.locationUrl(none), '');

  const asking = (answer, options = []) => ({
    getCurrentPosition: (ok, fail, opts) => (options.push(opts), answer(ok, fail)),
  });
  (async () => {
    const seen = [];
    assert.deepEqual(
      await core.readLocation(
        asking(
          (ok) =>
            ok({ coords: { latitude: 35.37329249, longitude: -119.0187124, accuracy: 12.46 } }),
          seen,
        ),
      ),
      { source: 'device', latitude: 35.373292, longitude: -119.018712, accuracy_m: 12.5 },
    );
    assert.equal(seen[0].enableHighAccuracy, true);
    assert.deepEqual(await core.readLocation(asking((ok, fail) => fail({ code: 1 }))), {
      source: 'not_shared',
    });
    for (const code of [2, 3, undefined])
      assert.deepEqual(await core.readLocation(asking((ok, fail) => fail({ code }))), {
        source: 'not_available',
      });
    assert.deepEqual(await core.readLocation(undefined), { source: 'not_available' });
    assert.deepEqual(
      await core.readLocation(
        asking(() => {
          throw Error('blocked by policy');
        }),
      ),
      { source: 'not_available' },
    );
    assert.deepEqual(
      await core.readLocation(asking((ok) => ok({ coords: { latitude: NaN, longitude: 0 } }))),
      { source: 'not_available' },
    );
    // A prompt nobody answers cannot hold the photo forever.
    assert.deepEqual(
      await core.readLocation(
        asking(() => {}),
        10,
      ),
      { source: 'not_available' },
    );
    console.log('PASS: photo locations are read, labeled and linked without guessing');
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

{
  // Documents: the proposal heading, summary block and itemized-claim columns follow the saved estimate.
  const element = (tag) => ({
    tag,
    children: [],
    hidden: false,
    className: '',
    textContent: '',
    get childElementCount() {
      return this.children.length;
    },
    append(...kids) {
      this.children.push(...kids);
    },
    replaceChildren(...kids) {
      this.children = kids;
    },
  });
  const flat = (el) =>
    el.children.length ? el.children.map(flat).join(' | ') : String(el.textContent);
  const ids = [
    'estimateHeading',
    'estimateRange',
    'itemizedHeading',
    'itemizedTotal',
    'proposalBody',
    'claimParty',
    'claimHint',
    'claimXactimateHead',
    'claimItems',
    'claimCards',
    'claimAdjustments',
    'claimTotal',
    'defenseBody',
    'photoParty',
    'photoAuditLog',
    'auditWarnings',
  ];
  const page = (extra = []) => {
    const els = Object.fromEntries([...ids, ...extra].map((id) => [id, element('div')]));
    const context = {
      ADRCore: core,
      document: {
        getElementById: (id) => els[id] || null,
        createElement: element,
        querySelectorAll: () => [],
      },
    };
    context.window = context;
    vm.runInNewContext(fs.readFileSync('public/documents.js', 'utf8'), context);
    return { els, render: (docs) => context.ADRDocuments.render(docs, [], () => '') };
  };
  const end = (total, extras = {}) => ({
    subtotal: 6640,
    after_hours: 0,
    minimum_charge: 0,
    overhead_profit: 0,
    tax: 0,
    total,
    ...extras,
  });
  const line = (code, extras = {}) => ({
    code,
    description: code + ' work',
    quantity: 2,
    unit: 'each',
    unit_price: 10,
    waste_percent: 0,
    total: 20,
    ...extras,
  });
  const documents = (mode, extras = {}) => ({
    adr_estimate: {
      property_address: '12 Test Lane',
      date: '11-02-2026',
      proposed_cost: 11896,
      proposed_cost_low: mode === 'single' ? undefined : 8489.8,
      estimate_mode: mode,
      findings: [],
      recommendations: [],
      disclaimers: [],
    },
    xactimate_total: 8489.8,
    xactimate_scope: [line('FAN', { xactimate_code: 'WTR DMO' }), line('LAB')],
    iicrc_defense_letter: '',
    photo_audit_log: [],
    price_basis: { sequence: 4 },
    estimate: {
      mode,
      low: end(8489.8, { after_hours: 1030, overhead_profit: 767, tax: 52.8 }),
      high:
        mode === 'single'
          ? undefined
          : end(11896, { subtotal: 9215, after_hours: 1545, overhead_profit: 1076, tax: 60 }),
      after_hours_label: 'Night work',
      after_hours_percent: '20',
      overhead_profit_percent: '10',
      sales_tax_percent: '8',
      explanation: 'The low amount is the itemized total.',
      show_line_breakdown: false,
    },
    ...extras,
  });

  assert.equal(core.estimateHeading('single'), 'Price');
  assert.equal(core.estimateHeading('range'), 'Customer estimate range');
  assert.equal(core.estimateHeading(undefined), 'Customer estimate range');

  const ranged = page();
  ranged.render(documents('range'));
  assert.equal(ranged.els.estimateHeading.textContent, 'Customer estimate range');
  assert.equal(ranged.els.estimateRange.textContent, '$8,489.80–$11,896.00');
  assert.equal(ranged.els.itemizedHeading.textContent, 'Itemized total');
  const body = flat(ranged.els.proposalBody);
  assert.match(body, /Customer estimate range: \$8,489\.80–\$11,896\.00/);
  assert.match(body, /Low \| High/);
  assert.match(body, /Subtotal of itemized work \| \$6,640\.00 \| \$9,215\.00/);
  assert.match(body, /Night work \(20%\) \| \$1,030\.00 \| \$1,545\.00/);
  assert.match(body, /Overhead and profit \(10%\) \| \$767\.00 \| \$1,076\.00/);
  assert.match(body, /Sales tax \(8%\) \| \$52\.80 \| \$60\.00/);
  assert.match(body, /Total \| \$8,489\.80 \| \$11,896\.00/);
  assert.doesNotMatch(body, /Minimum job charge/);
  assert.match(body, /The low amount is the itemized total\./);
  assert.match(body, /Priced from Prices v4\./);
  assert.doesNotMatch(body, /Itemized scope total/);
  // Lines are not repeated on the proposal unless the owner asks.
  assert.doesNotMatch(body, /FAN work · 2 each/);
  // The Xactimate column appears because one line has a code; only that row carries a value.
  assert.equal(ranged.els.claimXactimateHead.hidden, false);
  assert.match(flat(ranged.els.claimItems.children[0]), /\$20\.00 \| WTR DMO$/);
  assert.match(flat(ranged.els.claimItems.children[1]), /\$20\.00 \| $/);
  assert.equal(
    flat(ranged.els.claimAdjustments),
    'Subtotal of itemized work: $6,640.00 | Night work (20%): $1,030.00 | Overhead and profit (10%): $767.00 | Sales tax (8%): $52.80',
  );
  assert.equal(ranged.els.claimAdjustments.className, 'claim-summary');
  assert.equal(ranged.els.claimTotal.textContent, 'Itemized claim total: $8,489.80');
  assert.equal(
    ranged.els.claimHint.textContent,
    'Xactimate codes shown where the company entered them. This is not an Xactimate (ESX) file.',
  );

  const single = page();
  single.render(documents('single'));
  assert.equal(single.els.estimateHeading.textContent, 'Price');
  assert.equal(single.els.estimateRange.textContent, '$11,896.00');
  assert.match(flat(single.els.proposalBody), /Price: \$11,896\.00/);
  assert.match(
    flat(single.els.proposalBody),
    /Price \| Subtotal of itemized work \| \$6,640\.00 \|/,
  );
  assert.doesNotMatch(flat(single.els.proposalBody), /High/);

  const breakdown = page();
  const withLines = documents('range');
  withLines.estimate.show_line_breakdown = true;
  breakdown.render(withLines);
  assert.match(flat(breakdown.els.proposalBody), /FAN work · 2 each · \$20\.00/);

  // A homeowner's document link has no claim lines: the proposal prints the lines delivered with it.
  const homeownerLink = page();
  const copy = documents('range', { xactimate_scope: [] });
  copy.estimate.show_line_breakdown = true;
  copy.estimate.lines = [{ description: 'FAN work', quantity: 2, unit: 'each', total: 20 }];
  homeownerLink.render(copy);
  assert.match(flat(homeownerLink.els.proposalBody), /FAN work · 2 each · \$20\.00/);
  const aliased = page();
  const legacyLine = documents('range', {
    xactimate_scope: [{ desc: 'Old name', qty: 9, unit: 'hour', total: 0 }],
  });
  legacyLine.estimate.show_line_breakdown = true;
  aliased.render(legacyLine);
  assert.doesNotMatch(flat(aliased.els.proposalBody), /Old name · 9 hour/);
  assert.equal(homeownerLink.els.claimItems.children.length, 0);

  // An adjuster's link holds the low end's amounts and an emptied proposal: its claim adds up.
  const adjusterLink = page();
  adjusterLink.render({
    ...documents('range'),
    adr_estimate: { property_address: '12 Test Lane' },
    estimate: {
      low: end(8489.8, { after_hours: 1030, overhead_profit: 767, tax: 52.8 }),
      after_hours_label: 'Night work',
      after_hours_percent: '20',
      overhead_profit_percent: '10',
      sales_tax_percent: '8',
    },
  });
  assert.equal(
    flat(adjusterLink.els.claimAdjustments),
    'Subtotal of itemized work: $6,640.00 | Night work (20%): $1,030.00 | Overhead and profit (10%): $767.00 | Sales tax (8%): $52.80',
  );
  assert.equal(adjusterLink.els.claimTotal.textContent, 'Itemized claim total: $8,489.80');
  assert.doesNotMatch(flat(adjusterLink.els.proposalBody), /undefined/);

  // No cushion sentence in range mode when the first tier is 0%: nothing prints in its place.
  const noCushion = page();
  const zeroTier = documents('range');
  delete zeroTier.estimate.explanation;
  noCushion.render(zeroTier);
  assert.match(
    flat(noCushion.els.proposalBody),
    /Total \| \$8,489\.80 \| \$11,896\.00 \| Priced from/,
  );

  const minimum = page();
  const floor = documents('range');
  floor.estimate.low.minimum_charge = 510.2;
  minimum.render(floor);
  assert.match(flat(minimum.els.proposalBody), /Minimum job charge \| \$510\.20 \| \$0\.00/);

  // Estimator-only quantity notes appear where the page has a place for them, never on the signing page.
  const withNotes = page(['quantityNotes', 'quantityNotesBody']);
  withNotes.render(
    documents('range', {
      quantity_notes: [
        {
          label: 'Finished area',
          room: 'Hall',
          measured: 650,
          entered: 400,
          reason: 'Carpet already out',
        },
      ],
    }),
  );
  assert.equal(
    flat(withNotes.els.quantityNotesBody),
    'Finished area (Hall) · measured 650, entered 400 · Reason: Carpet already out',
  );
  assert.equal(withNotes.els.quantityNotes.hidden, false);

  // A document audited before price tables renders exactly as before.
  const legacy = page();
  const old = documents('range');
  delete old.estimate;
  delete old.adr_estimate.estimate_mode;
  old.xactimate_scope = [line('ADR-FAN')];
  old.adr_estimate.proposed_cost_low = 8489.8;
  legacy.render(old);
  assert.equal(legacy.els.estimateHeading.textContent, 'Customer estimate range');
  assert.equal(legacy.els.itemizedHeading.textContent, 'Itemized scope total');
  assert.equal(
    flat(legacy.els.proposalBody),
    [
      '12 Test Lane',
      '11-02-2026',
      'Customer estimate range: $8,489.80–$11,896.00',
      'Itemized scope total: $8,489.80',
      'Priced from Prices v4.',
      'Findings',
      'Proposed scope',
    ].join(' | '),
  );
  assert.equal(legacy.els.claimXactimateHead.hidden, true);
  assert.equal(
    legacy.els.claimHint.textContent,
    'Internal scope codes (not Xactimate codes). JSON export does not guarantee Xactimate import compatibility.',
  );
  assert.equal(legacy.els.claimAdjustments.children.length, 0);
  assert.doesNotMatch(flat(legacy.els.claimItems), /\| $/);
  console.log('PASS: v2 documents print the summary block, mode heading and Xactimate column');
}
