// QR tag codes and equipment placement records: the pure helpers behind Scan tag and the sheet.
const assert = require('node:assert/strict');
const core = require('../public/core.js');

const ID = 'ADR-INS-3f9a1c2bdeadbeef0123456789abcdef',
  JOB = '3f9a1c2b',
  AT = new Date('2026-10-21T14:41:00Z');
const draft = () => ({
  inspection_id: ID,
  data: {
    ...core.emptyData(),
    rooms: [
      { ...core.emptyData().rooms[0], name: 'Kitchen' },
      { ...core.emptyData().rooms[0], name: 'Hallway' },
    ],
  },
});

// The printed code is what the parser reads back, for rooms and for each equipment kind.
assert.equal(core.roomTagCode(ID, '  Master   Bath '), 'DS1-RM-' + JOB + '-Master Bath');
assert.equal(core.equipmentTagCode('dehumidifier', ' dh-0042 '), 'DS1-EQ-DH-DH-0042');
assert.deepEqual(core.parseTag(core.roomTagCode(ID, 'Kitchen')), {
  type: 'room',
  job: JOB,
  room: 'Kitchen',
  code: 'DS1-RM-' + JOB + '-Kitchen',
});
assert.deepEqual(core.parseTag(' ds1-eq-am-am-12 '), {
  type: 'equipment',
  kind: 'air_mover',
  asset_id: 'AM-12',
  code: 'DS1-EQ-AM-AM-12',
});
assert.equal(core.parseTag('DS1-EQ-AS-A/1.2').kind, 'air_scrubber');
for (const code of [
  '',
  null,
  'DS1-RM-' + JOB + '-',
  'DS1-RM-' + JOB + '-   ',
  'DS1-RM-xyz-Kitchen',
  'DS1-EQ-WF-1',
  'DS1-EQ-AM-A B',
  'DS1-EQ-AM-' + 'A'.repeat(33),
  'https://example.invalid/asset?sn=1',
  '{"type":"room","roomName":"Kitchen","lengthFt":14}',
  'DEHU-108: Phoenix',
])
  assert.equal(core.parseTag(code).type, 'unknown', String(code));

{
  // A room tag for this job picks the room by its normalised name; other jobs and unknown rooms
  // are refused, and nothing invents a room or a measurement.
  const open = draft();
  const picked = core.applyTag(core.parseTag('DS1-RM-' + JOB + '-  kitchen'), open, 'Hallway', AT);
  assert.equal(picked.ok, true);
  assert.equal(picked.room, open.data.rooms[0]);
  assert.equal(picked.message, 'Current room: Kitchen.');
  const other = core.applyTag(core.parseTag('DS1-RM-00000000-Kitchen'), open, 'Hallway', AT);
  assert.equal(other.ok, false);
  assert.match(other.message, /different job/);
  const missing = core.applyTag(core.parseTag('DS1-RM-' + JOB + '-Pantry'), open, 'Hallway', AT);
  assert.equal(missing.ok, false);
  assert.match(missing.message, /No room named "Pantry"/);
  assert.equal(open.data.rooms.length, 2);
  assert.equal('equipment_scans' in open.data, false);
  const unknown = core.applyTag(core.parseTag('DEHU-108: Phoenix'), open, 'Hallway', AT);
  assert.equal(unknown.ok, false);
  assert.match(unknown.message, /Not a DryScope tag: "DEHU-108: Phoenix"/);
  assert.match(core.applyTag(core.parseTag(''), open, 'Hallway', AT).message, /No code was read/);
}
{
  // An equipment tag is recorded once per asset in the current room with the scan time; a later
  // scan elsewhere moves it. The priced counts are untouched and the key disappears when empty.
  const open = draft();
  const noRoom = core.applyTag(core.parseTag('DS1-EQ-DH-DH-0042'), open, '', AT);
  assert.equal(noRoom.ok, false);
  assert.match(noRoom.message, /Choose the current room first/);
  assert.equal('equipment_scans' in open.data, false);
  const placed = core.applyTag(
    core.parseTag('DS1-EQ-DH-DH-0042'),
    open,
    'Kitchen',
    AT,
    'a'.repeat(32),
  );
  assert.equal(placed.ok, true);
  assert.deepEqual(placed.scan, {
    id: 'a'.repeat(32),
    kind: 'dehumidifier',
    asset_id: 'DH-0042',
    room: 'Kitchen',
    scanned_at: '2026-10-21T14:41:00Z',
  });
  assert.equal(placed.moved_from, null);
  assert.match(placed.message, /^LGR dehumidifier DH-0042 placed in Kitchen · /);
  core.applyTag(core.parseTag('DS1-EQ-AM-AM-1'), open, 'Kitchen', AT, 'b'.repeat(32));
  core.applyTag(core.parseTag('DS1-EQ-AM-AM-2'), open, 'Hallway', AT, 'c'.repeat(32));
  const later = new Date('2026-10-21T15:05:00Z');
  const moved = core.applyTag(core.parseTag('ds1-eq-dh-dh-0042'), open, 'Hallway', later);
  assert.equal(moved.ok, true);
  assert.equal(moved.moved_from, 'Kitchen');
  assert.match(moved.message, /^LGR dehumidifier DH-0042 moved from Kitchen to Hallway · /);
  assert.equal(moved.scan.id, 'a'.repeat(32));
  assert.equal(open.data.equipment_scans.length, 3);
  assert.equal(open.data.air_movers, 0);
  assert.equal(open.data.dehumidifiers, 0);
  assert.deepEqual(
    core
      .placementsByRoom(open.data)
      .map((group) => [group.room, group.scans.map((s) => s.asset_id)]),
    [
      ['Kitchen', ['AM-1']],
      ['Hallway', ['AM-2', 'DH-0042']],
    ],
  );
  assert.equal(
    core.equipmentSummary(core.roomScans(open.data, 'hallway')),
    '1 air mover, 1 LGR dehumidifier',
  );
  assert.equal(core.equipmentSummary([]), '');
  // A scan whose room was removed stays listed under its stored name, after the job's rooms.
  open.data.rooms.splice(1, 1);
  const groups = core.placementsByRoom(open.data);
  assert.deepEqual(
    groups.map((group) => [group.room, !!group.removed]),
    [
      ['Kitchen', false],
      ['Hallway', true],
    ],
  );
  assert.equal(core.removeScan(open.data, open.data.equipment_scans[0]), 2);
  assert.equal(core.removeScan(open.data, open.data.equipment_scans[0]), 1);
  assert.equal(core.removeScan(open.data, open.data.equipment_scans[0]), 0);
  assert.equal('equipment_scans' in open.data, false);
}
{
  const open = draft();
  open.data.equipment_scans = Array.from({ length: 200 }, (_, i) => ({
    id: i.toString(16).padStart(32, '0'),
    kind: 'air_mover',
    asset_id: 'AM-' + i,
    room: 'Kitchen',
    scanned_at: AT.toISOString(),
  }));
  const full = core.applyTag(core.parseTag('DS1-EQ-AM-AM-NEW'), open, 'Kitchen', AT);
  assert.equal(full.ok, false);
  assert.match(full.message, /At most 200/);
  // Rescanning a recorded asset is still a move, not a new entry.
  assert.equal(core.applyTag(core.parseTag('DS1-EQ-AM-AM-7'), open, 'Kitchen', AT).ok, true);
  assert.equal(open.data.equipment_scans.length, 200);
}
assert.equal(core.equipmentLabel('air_scrubber'), 'Air scrubber');
assert.equal(core.equipmentLabel('air_scrubber', 2), 'Air scrubbers');
console.log('PASS: QR tag codes, room picks, equipment placement records and their limits');
