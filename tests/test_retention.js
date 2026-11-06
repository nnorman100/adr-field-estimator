const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

const SOURCE = fs.readFileSync('public/retention.js', 'utf8');
function load(extra = {}) {
  const context = { window: {}, navigator: { onLine: true }, ...extra };
  vm.createContext(context);
  vm.runInContext(SOURCE, context);
  return { context, Retention: context.window.Retention };
}

const VIEW = {
  version: 2,
  min_days: 90,
  max_days: 3650,
  default_days: 90,
  days: { invitations: 90, admin_events: 180, job_monitoring: 90, evidence_photos: 90 },
  templates: {
    invitations: 'Invitations are deleted {days} after they expire.',
    admin_events: 'The activity log keeps each entry for {days}.',
    job_monitoring: 'History is deleted {days} after a job is closed.',
    evidence_photos: 'Photos are deleted {days} after archiving.',
  },
  running: false,
};

test('the effect sentence follows the days typed and refuses an out-of-range number', () => {
  const { Retention } = load();
  assert.equal(
    Retention.sentence(VIEW, 'invitations', '120'),
    'Invitations are deleted 120 days after they expire.',
  );
  assert.equal(
    Retention.sentence(VIEW, 'admin_events', '3650'),
    'The activity log keeps each entry for 3650 days.',
  );
  for (const bad of ['89', '30', '3651', '', '90.5', 'abc'])
    assert.equal(Retention.sentence(VIEW, 'invitations', bad), 'Enter 90 to 3650 days.');
});

test('saving sends whole days for every class and names a class that is out of range', () => {
  const { Retention } = load();
  const values = {
    invitations: '90',
    admin_events: '365',
    job_monitoring: '90',
    evidence_photos: '120',
  };
  assert.deepEqual(JSON.parse(JSON.stringify(Retention.chosen(VIEW, values))), {
    invitations: 90,
    admin_events: 365,
    job_monitoring: 90,
    evidence_photos: 120,
  });
  assert.throws(
    () => Retention.chosen(VIEW, { ...values, job_monitoring: '7' }),
    /Drying-watch history: enter 90 to 3650 days\./,
  );
});

test('only periods shorter than the saved ones ask for confirmation', () => {
  const { Retention } = load();
  // 90 is the floor: an owner can only shorten a period they lengthened, back down to 90.
  const days = { invitations: 90, admin_events: 90, job_monitoring: 120, evidence_photos: 90 };
  assert.deepEqual([...Retention.shortened(VIEW, days)], ['admin_events']);
  assert.deepEqual([...Retention.shortened(VIEW, VIEW.days)], []);
});

test('the run line says plainly whether anything is being deleted', () => {
  const { Retention } = load();
  assert.match(
    Retention.runLine(VIEW),
    /^Automatic deletion is not switched on yet, so nothing is deleted\./,
  );
  assert.match(Retention.runLine({ ...VIEW, running: true }), /once a day, when someone/);
  const ran = Retention.runLine({
    ...VIEW,
    running: true,
    last_run_at: '2026-11-05T10:00:00+00:00',
    last_deleted: { invitations: 2, admin_events: 0, job_monitoring: 1, evidence_photos: 0 },
  });
  assert.match(ran, /3 records deleted\.$/);
});

test('a member app asks for the daily sweep once per company and only when it is on', async () => {
  const calls = [];
  const session = { retention_enabled: false, role: 'estimator', company_id: 'adr' };
  const { Retention } = load({
    state: { session },
    jsonApi: async (path, method) => {
      calls.push([path, method]);
      return { ran: false };
    },
  });
  Retention.ready();
  assert.deepEqual(calls, []);
  session.retention_enabled = true;
  Retention.ready();
  Retention.ready();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ['/api/companies/adr/retention/run', 'POST'],
  ]);
  session.role = null;
  session.company_id = 'other';
  Retention.ready();
  assert.equal(calls.length, 1);
});
