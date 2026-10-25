import json
import subprocess
from pathlib import Path
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi import HTTPException

from backend import ai_features, main as bm, monitoring_store
from backend.drying_watch import day_groups, instant, watch_state, facts_hash
from backend.drying_summary import DryingSummary, validate_summary
from backend.monitoring_store import ReminderRequest, WatchAction
from backend.inspection_store import Conflict, Limited, DAILY_LIMITS
from backend.workspaces import CoordinationUpdate, UnconfirmedDelivery, AccessDenied
from tests.test_workspaces import store, api, ID, signed_job

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / 'tests/fixtures/drying-watch'
STATES = json.loads((FIXTURES / 'states.json').read_text())
SUMMARIES = json.loads((FIXTURES / 'summaries.json').read_text())


@pytest.mark.parametrize('case', STATES, ids=lambda c: c['name'])
def test_deterministic_status_and_browser_parity(case):
    result = watch_state(
        case['data'], case['log'], case['setup_at'], case['previous'], instant(case['at'])
    )
    assert {k: result[k] for k in case['expected']} == case['expected']
    js = "const p=require(process.argv[1]); const c=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(JSON.stringify(p.summarizeLog(c.log.readings,c.data.rooms,iso=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(iso)))));"
    run = subprocess.run(
        ['node', '-e', js, str(ROOT / 'public/psychrometrics.js')],
        input=json.dumps(case),
        text=True,
        capture_output=True,
        check=True,
    )
    assert day_groups(case['log']['readings'], case['data']['rooms']) == json.loads(run.stdout)


@pytest.mark.parametrize('case', SUMMARIES, ids=lambda c: c['name'])
def test_summary_fact_packs(case):
    assert (
        validate_summary(DryingSummary.model_validate(case['valid']), case['facts'])
        == case['expected']
    )
    for text in case.get('invalid', []):
        with pytest.raises(ValueError):
            validate_summary(text, case['facts'])


@pytest.mark.parametrize(
    'text',
    [
        'Day 999.',
        '$12.',
        'The room is dry.',
        'The job is complete.',
        'Remove the drywall.',
        'You should extend the plan.',
        'Charge 12 dollars.',
        'Use two fans.',
        'Status ' * 61,
    ],
)
def test_ungrounded_or_actionable_summary_is_rejected(text):
    with pytest.raises(ValueError):
        validate_summary({'text': text}, SUMMARIES[1]['facts'])


@pytest.fixture
def watched(api, monkeypatch):
    client, current, store = api
    monkeypatch.setattr(ai_features, 'AI_FEATURES', frozenset({'drying_watch'}))
    signed_job(client, current, store)
    store.db.records['_companies/adr']['profile'].update(
        drying_reminders=True,
        email='office@example.invalid',
        crew_lead_email='crew@example.invalid',
    )
    job = store.db.records['_workspace_jobs/' + ID]
    job['assigned_estimator_uid'] = 'estimator'
    watch = store.workspaces.monitoring
    return client, current, store, watch


def request(watch, recipient='estimator', key='a' * 32):
    return ReminderRequest(
        reminder_id=key,
        recipient=recipient,
        recipient_hash=watch.view('office', ID)['recipient_hashes'][recipient],
        approved=True,
        facts_hash=watch.view('office', ID)['facts_hash'],
    )


@pytest.mark.parametrize(
    'uid,expected',
    [
        ('owner', 200),
        ('office', 200),
        ('estimator', 200),
        ('estimator2', 404),
        ('other-owner', 404),
        ('admin', 403),
    ],
)
def test_read_roles_and_feature_gate(watched, monkeypatch, uid, expected):
    client, actor, store, watch = watched
    actor['uid'] = uid
    assert client.get(f'/api/jobs/{ID}/drying-watch').status_code == expected
    monkeypatch.setattr(ai_features, 'AI_FEATURES', frozenset())
    assert client.get(f'/api/jobs/{ID}/drying-watch').status_code == 404
    assert client.get('/api/session').json().get('ai_features') == [] if uid != 'admin' else True


def test_lists_are_company_scoped_and_support_is_read_only(watched):
    client, actor, store, watch = watched
    actor['uid'] = 'estimator'
    assert len(client.get('/api/jobs/drying-watch').json()['jobs']) == 1
    assert client.get('/api/companies/adr/drying-watch').status_code == 403
    actor['uid'] = 'estimator2'
    assert client.get('/api/jobs/drying-watch').json()['jobs'] == []
    actor['uid'] = 'other-owner'
    assert client.get('/api/jobs/drying-watch').json()['jobs'] == []
    actor['uid'] = 'admin'
    before = deepcopy(store.db.records.get('_job_monitoring/' + ID))
    assert client.get('/api/admin/companies/adr/drying-watch').status_code == 200
    assert store.db.records.get('_job_monitoring/' + ID) == before
    assert any(
        v.get('action') == 'support_view_drying_watch'
        for k, v in store.db.records.items()
        if k.startswith('_admin_events/')
    )


def test_summary_is_cached_failure_is_retryable_and_never_changes_signed_sources(
    watched, monkeypatch
):
    client, actor, store, watch = watched
    actor['uid'] = 'office'
    before = deepcopy(
        {
            k: v
            for k, v in store.db.records.items()
            if k.startswith(('inspections/', 'authorizations/', '_job_deliveries/'))
        }
    )
    calls = []

    async def fail(*args, **kwargs):
        raise HTTPException(502, 'Provider unavailable. Retry.')

    monkeypatch.setattr(bm, 'generate', fail)
    assert client.post(f'/api/jobs/{ID}/drying-watch/summary').status_code == 502
    assert not watch.view('office', ID).get('summary')

    async def generate(schema, contents, *args, **kwargs):
        calls.append(contents)
        return DryingSummary(rooms=[dict(room_index=0, trend='no_new_reading', mention='status')])

    monkeypatch.setattr(bm, 'generate', generate)
    for _ in range(2):
        result = client.post(f'/api/jobs/{ID}/drying-watch/summary')
        assert result.status_code == 200, result.text
    assert len(calls) == 1
    assert 'Synthetic Customer' not in calls[0]
    assert before == {k: v for k, v in store.db.records.items() if k in before}
    assert DAILY_LIMITS['drying_summary'] == 60


def test_summary_rechecks_access_and_facts_after_provider(watched, monkeypatch):
    client, actor, store, watch = watched
    actor['uid'] = 'estimator'

    async def generate(*args, **kwargs):
        store.db.records['_memberships/estimator']['status'] = 'disabled'
        return DryingSummary(rooms=[dict(room_index=0, trend='no_new_reading', mention='status')])

    monkeypatch.setattr(bm, 'generate', generate)
    assert client.post(f'/api/jobs/{ID}/drying-watch/summary').status_code == 403
    assert not store.db.records['_job_monitoring/' + ID].get('summary')


def test_summary_daily_and_minute_caps(watched):
    client, actor, store, watch = watched
    actor['uid'] = 'office'
    for _ in range(6):
        store.quota('office', 'drying_summary', 6)
    result = client.post(f'/api/jobs/{ID}/drying-watch/summary')
    assert result.status_code == 429 and int(result.headers['Retry-After']) > 0
    store.db.records['_limits/office'].pop('drying_summary')
    import time

    store.db.records['_limits/office']['drying_summary_day'] = {'start': time.time(), 'count': 60}
    assert client.post(f'/api/jobs/{ID}/drying-watch/summary').status_code == 429


@pytest.mark.parametrize(
    'uid,action,expected',
    [
        ('owner', 'extend', 200),
        ('office', 'close', 200),
        ('estimator', 'mark_dry', 200),
        ('estimator', 'extend', 403),
        ('estimator', 'close', 403),
        ('admin', 'mark_dry', 403),
        ('estimator2', 'mark_dry', 404),
        ('other-owner', 'close', 404),
    ],
)
def test_state_requires_capability_and_human_approval(watched, uid, action, expected):
    client, actor, store, watch = watched
    before = deepcopy(
        store.db.records['authorizations/' + store.db.records['_workspace_jobs/' + ID]['auth_id']]
    )
    body = dict(
        action=action,
        reason='Equipment visit reviewed',
        facts_hash=watch.view('office', ID)['facts_hash'],
        request_id='b' * 32,
        approved=True,
    )
    actor['uid'] = uid
    response = client.post(f'/api/jobs/{ID}/drying-watch/state', json=body)
    assert response.status_code == expected, response.text
    if expected == 200:
        assert client.post(f'/api/jobs/{ID}/drying-watch/state', json=body).status_code == 200
        record = response.json()
        accepted = record['extensions'][0] if action == 'extend' else record['closed']
        assert accepted['accepted_by_uid'] == uid and accepted['origin'] == 'manual'
    assert store.db.records['authorizations/' + before['auth_id']] == before


def test_no_action_without_approval_or_reason(watched):
    client, actor, store, watch = watched
    actor['uid'] = 'office'
    req = request(watch).model_dump()
    req['approved'] = False
    assert client.post(f'/api/jobs/{ID}/drying-watch/remind', json=req).status_code == 400
    body = dict(
        action='close', reason=' ', approved=True, request_id='c' * 32, facts_hash=req['facts_hash']
    )
    assert client.post(f'/api/jobs/{ID}/drying-watch/state', json=body).status_code == 400


def test_reminder_reservation_retry_switch_reply_to_and_counter(watched, monkeypatch):
    client, actor, store, watch = watched
    sent = []
    monkeypatch.setattr(monitoring_store, 'mail_settings', lambda: {})

    def send(settings, message, *args, **kwargs):
        sent.append((message, args, kwargs))

    monkeypatch.setattr(monitoring_store, 'send_email', send)
    req = request(watch)
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda _: watch.remind('office', ID, req), range(2)))
    assert len(sent) == 1
    message, args, kwargs = sent[0]
    assert message['to'] == ['estimator@example.invalid']
    assert message['reply_to'] == 'office@example.invalid'
    assert kwargs['prevent_duplicates'] is True
    assert args[1] == 'monitoring/' + ID + '/' + req.reminder_id
    assert 'Synthetic Customer' not in str(message) and '$' not in str(message)
    assert store.db.records['_email_counts/daily']['sent']['count'] == 1

    def fail(*args, **kwargs):
        raise RuntimeError('synthetic failure')

    monkeypatch.setattr(monitoring_store, 'send_email', fail)
    req = request(watch, key='d' * 32)
    assert watch.remind('owner', ID, req)['reminders'][-1]['retryable']
    monkeypatch.setattr(monitoring_store, 'send_email', send)
    assert watch.remind('owner', ID, req)['reminders'][-1]['status'] == 'sent'
    store.db.records['_companies/adr']['profile']['drying_reminders'] = False
    with pytest.raises(AccessDenied):
        watch.remind('office', ID, request(watch, key='e' * 32))
    with pytest.raises(AccessDenied):
        watch.remind('estimator', ID, request(watch, key='f' * 32))


def test_readings_and_assignment_update_watch_without_touching_agreement(watched):
    client, actor, store, watch = watched
    before = deepcopy(
        store.db.records['authorizations/' + store.db.records['_workspace_jobs/' + ID]['auth_id']]
    )
    reading = dict(
        kind='material',
        room='Bathroom',
        taken_at='2026-10-21T10:00:00Z',
        material='Drywall',
        unit='%WME',
        moisture=12,
        dry_standard=12,
        affected=True,
    )
    log = store.add_reading('estimator', 'estimator@example.invalid', ID, reading)
    record = store.db.records['_job_monitoring/' + ID]
    assert record['status'] == 'dry_standard_met' and record['next_due_at'] is None
    store.remove_reading('estimator', ID, log['readings'][0]['id'])
    assert store.db.records['_job_monitoring/' + ID]['status'] == 'active'
    store.workspaces.coordination(
        'office',
        ID,
        CoordinationUpdate(
            expected_version=store.db.records['_workspace_jobs/' + ID]['version'],
            assigned_estimator_uid='estimator2',
        ),
    )
    assert 'estimator2' in store.db.records['_job_monitoring/' + ID]['accessible_estimator_uids']
    assert before == store.db.records['authorizations/' + before['auth_id']]


def test_uncertain_reminder_never_retries_and_stale_approval_never_sends(watched, monkeypatch):
    client, actor, store, watch = watched
    calls = []
    monkeypatch.setattr(monitoring_store, 'mail_settings', lambda: {})

    def uncertain(*args, **kwargs):
        calls.append(1)
        raise UnconfirmedDelivery('Synthetic uncertain outcome')

    monkeypatch.setattr(monitoring_store, 'send_email', uncertain)
    req = request(watch)
    result = watch.remind('office', ID, req)
    assert result['reminders'][0]['status'] == 'failed'
    assert result['reminders'][0]['retryable'] is False
    watch.remind('office', ID, req)
    assert calls == [1]
    req = request(watch, key='f' * 32)
    store.add_reading(
        'estimator',
        'estimator@example.invalid',
        ID,
        dict(
            kind='material',
            room='Bathroom',
            material='Drywall',
            unit='%WME',
            moisture=22,
            dry_standard=12,
            affected=True,
            taken_at='2026-10-21T10:00:00Z',
        ),
    )
    with pytest.raises(Conflict):
        watch.remind('office', ID, req)
    with pytest.raises(Conflict):
        watch.save_summary('office', ID, req.facts_hash, 'Monitoring is active.')
    assert calls == [1]


def test_monitoring_logs_allow_ids_and_statuses_but_never_text(capsys):
    from backend.cloud_log import event, LOG_FIELDS

    assert {'reminder_id', 'watch_status'} <= LOG_FIELDS
    capsys.readouterr()
    event(
        'Drying reminder',
        operation='reminder',
        reminder_id='a' * 32,
        watch_status='active',
        status='failed',
        address='Private address',
        text='Private summary',
        reason='Private reason',
        email='private@example.invalid',
    )
    logged = json.loads(capsys.readouterr().out)
    assert logged == dict(
        severity='INFO',
        message='Drying reminder',
        operation='reminder',
        reminder_id='a' * 32,
        watch_status='active',
        status='failed',
    )


def test_old_agreement_without_saved_plan_does_not_break_list(watched):
    client, actor, store, watch = watched
    auth_id = store.db.records['_workspace_jobs/' + ID]['auth_id']
    store.db.records['authorizations/' + auth_id].pop('inspection')
    result = watch.listing('owner', 'adr')
    assert result['jobs'] == [] and result['unavailable'] == 1
    with pytest.raises(LookupError, match='no saved drying plan'):
        watch.view('owner', ID)


@pytest.mark.parametrize(
    'count,expected', [(0, 'dry_standard_met'), (None, 'active'), (1, 'active')]
)
def test_reference_room_material_count(count, expected):
    case = deepcopy(STATES[0])
    case['data']['rooms'].append(dict(name='Reference', wet_materials=count))
    result = watch_state(case['data'], case['log'], case['setup_at'], at=instant(case['at']))
    assert result['status'] == expected
    assert ('missing_dry_standard' in result['flags']) == (count != 0)
    assert ('Reference' in result['missing_rooms']) == (count != 0)


@pytest.mark.parametrize(
    'recipient,change',
    [
        ('estimator', 'assignment'),
        ('estimator', 'email'),
        ('crew_lead', 'email'),
    ],
)
@pytest.mark.parametrize('retry', [False, True])
def test_reminder_recipient_approval(watched, monkeypatch, recipient, change, retry):
    _, _, store, watch = watched
    monkeypatch.setattr(monitoring_store, 'mail_settings', lambda: {})
    calls = []

    def fail(*args, **kwargs):
        calls.append(1)
        raise RuntimeError('Synthetic failure')

    monkeypatch.setattr(monitoring_store, 'send_email', fail)
    req = request(watch, recipient)
    if retry:
        watch.remind('office', ID, req)
    if change == 'assignment':
        store.db.records['_workspace_jobs/' + ID]['assigned_estimator_uid'] = 'estimator2'
    elif recipient == 'estimator':
        store.db.records['_memberships/estimator']['email'] = 'changed@example.invalid'
    else:
        store.db.records['_companies/adr']['profile']['crew_lead_email'] = 'changed@example.invalid'
    with pytest.raises(Conflict, match='Recipient changed'):
        watch.remind('office', ID, req)
    assert len(calls) == int(retry)
    watch.remind('office', ID, request(watch, recipient))
    assert len(calls) == int(retry) + 1


@pytest.mark.parametrize('route', ['/api/jobs/drying-watch', '/api/companies/adr/drying-watch'])
def test_list_rechecks_each_job_after_role_downgrade(watched, monkeypatch, route):
    client, actor, store, watch = watched
    actor['uid'] = 'office'
    original = watch.view

    def view(*args, **kwargs):
        result = original(*args, **kwargs)
        store.db.records['_memberships/office']['role'] = 'estimator'
        return result

    monkeypatch.setattr(watch, 'view', view)
    response = client.get(route)
    assert response.status_code == 404
    assert 'Synthetic' not in response.text


@pytest.mark.parametrize(
    'text',
    [
        'Continue drying for 3 more days.',
        'Drying for 3 more days is advised.',
        '€22.',
    ],
)
def test_free_text_summary_never_reaches_cache_or_response(watched, monkeypatch, text):
    client, actor, store, watch = watched
    actor['uid'] = 'office'

    async def generate(*args, **kwargs):
        return {'text': text}

    monkeypatch.setattr(bm, 'generate', generate)
    response = client.post(f'/api/jobs/{ID}/drying-watch/summary')
    assert response.status_code == 502
    assert text not in response.text
    assert not watch.view('office', ID).get('summary')


def test_legacy_text_cache_is_not_displayed(watched):
    _, _, store, watch = watched
    current = watch.view('office', ID)
    store.db.records['_job_monitoring/' + ID]['summary'] = dict(
        text='€22.',
        facts_hash=current['facts_hash'],
        generated_at='old',
    )
    assert not watch.view('office', ID).get('summary')


def test_structured_summary_mentions_air_and_progress():
    pack = deepcopy(SUMMARIES[1]['facts'])
    pack['air'] = [dict(room='Kitchen', latest_gpp=71, reference_gpp=53, percent=40)]
    for mention, expected in [
        ('air', 'affected air 71 GPP, reference 53 GPP'),
        ('progress', 'progress 40%'),
    ]:
        selection = dict(rooms=[dict(room_index=0, trend='recorded', mention=mention)])
        assert expected in validate_summary(selection, pack)
    with pytest.raises(ValueError):
        validate_summary(
            dict(
                rooms=[
                    dict(room_index=0, trend='recorded', mention='status'),
                    dict(room_index=0, trend='recorded', mention='status'),
                ]
            ),
            pack,
        )


def test_worker_update_fixture_preserves_offline_asset_urls():
    import sys

    served = subprocess.run(
        [
            sys.executable,
            '-c',
            """
import json
from tests import browser_server as server
before = server.worker().body.decode()
server.worker_suffix = 'test-owner-update'
after = server.worker().body.decode()
print(json.dumps([before, after]))
""",
        ],
        text=True,
        capture_output=True,
        check=True,
    )
    consumer = """
const vm = require('node:vm');
const sources = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
(async () => {
  const results = [];
  for (const source of sources) {
    const handlers = {}, result = {};
    const sandbox = {
      URL,
      self: {
        location: {origin: 'https://localhost'},
        addEventListener: (type, handler) => { handlers[type] = handler; },
      },
      caches: {
        open: async (name) => {
          result.cache = name;
          return {addAll: async (assets) => { result.assets = assets; }};
        },
        match: async () => 'cached asset',
      },
    };
    vm.runInNewContext(source, sandbox);
    await new Promise((resolve, reject) => handlers.install({
      waitUntil: (promise) => promise.then(resolve, reject),
    }));
    let response;
    handlers.fetch({
      request: {url: 'https://localhost/drying-watch.js?v=unstamped', method: 'GET', mode: 'cors'},
      respondWith: (promise) => { response = promise; },
    });
    result.offline = await response;
    results.push(result);
  }
  process.stdout.write(JSON.stringify(results));
})().catch(() => process.exit(1));
"""
    run = subprocess.run(
        ['node', '-e', consumer],
        input=served.stdout,
        text=True,
        capture_output=True,
        check=True,
    )
    before, after = json.loads(run.stdout)
    assert before['cache'] != after['cache']
    assert before['assets'] == after['assets']
    assert before['offline'] == after['offline'] == 'cached asset'


@pytest.mark.parametrize('stalled_room,improving_room', [('Kitchen', 'Bath'), ('Bath', 'Kitchen')])
def test_room_trends_use_own_readings(watched, monkeypatch, stalled_room, improving_room):
    _, _, store, watch = watched
    rooms = [stalled_room, improving_room]
    data = dict(
        address='Synthetic property',
        drying_days=3,
        rooms=[dict(name=room, wet_materials=1) for room in rooms],
    )
    readings = []
    for room, values in [(stalled_room, [70, 70, 70]), (improving_room, [90, 70, 50])]:
        for day, gpp in zip([21, 22, 23], values):
            readings.append(
                dict(
                    kind='air',
                    room=room,
                    zone='affected',
                    gpp=gpp,
                    vapor_pressure_inhg=0.4,
                    taken_at=f'2026-10-{day}T16:00:00Z',
                )
            )
        readings.append(
            dict(
                kind='material',
                room=room,
                material='Drywall',
                unit='%WME',
                moisture=22,
                dry_standard=12,
                affected=True,
                taken_at='2026-10-23T16:00:00Z',
            )
        )
    log = dict(readings=readings, updated_at='2026-10-23T17:00:00Z')
    at = instant('2026-10-23T17:00:00Z')
    state = watch_state(data, log, '2026-10-21T16:00:00Z', at=at)
    assert state['air_trends'] == {stalled_room: 'stalled', improving_room: 'improving'}
    assert 'stalled' in state['flags']

    job = store.db.records['_workspace_jobs/' + ID]
    store.db.records['authorizations/' + job['auth_id']]['inspection'] = data
    store.db.records['drying_logs/' + ID] = log
    monkeypatch.setattr(
        monitoring_store,
        'watch_state',
        lambda data, log, setup, previous: watch_state(data, log, setup, previous, at=at),
    )
    current = watch.view('office', ID)
    selection = dict(
        rooms=[
            dict(room_index=0, trend='stalled', mention='status'),
            dict(room_index=1, trend='improving', mention='status'),
        ]
    )
    watch.save_summary('office', ID, current['facts_hash'], selection)
    cached = watch.view('office', ID)['summary']['text']
    assert cached.endswith('Room 1: stalled; Room 2: improving.')

    wrong = deepcopy(selection)
    wrong['rooms'][1]['trend'] = 'stalled'
    with pytest.raises(ValueError, match='does not match'):
        watch.save_summary('office', ID, current['facts_hash'], wrong)
    assert watch.view('office', ID)['summary']['text'] == cached

    improving_only = dict(log, readings=[r for r in readings if r['room'] == improving_room])
    state = watch_state(data, improving_only, '2026-10-21T16:00:00Z', at=at)
    assert state['air_trends'][improving_room] == 'improving'
    assert 'stalled' not in state['flags']


@pytest.mark.parametrize(
    'case',
    json.loads((FIXTURES / 'reading-presence.json').read_text()),
    ids=lambda c: c['name'],
)
def test_reading_presence_is_independent_of_coverage_and_reference(watched, monkeypatch, case):
    from backend.drying_summary import room_names, summary_options

    _, _, store, watch = watched
    data = dict(
        address='Synthetic property',
        drying_days=3,
        rooms=[
            dict(name='Kitchen', wet_materials=0),
            dict(name='Bath', wet_materials=2),
        ],
    )
    readings = []
    for room, values in [('Kitchen', [70, 70, 70]), ('Bath', case['air'])]:
        for day, gpp in zip([21, 22, 23], values):
            readings.append(
                dict(
                    kind='air',
                    room=room,
                    zone='affected',
                    gpp=gpp,
                    vapor_pressure_inhg=0.4,
                    taken_at=f'2026-10-{day}T16:00:00Z',
                )
            )
    for index in range(case['materials']):
        readings.append(
            dict(
                kind='material',
                room='Bath',
                material=f'Material {index}',
                unit='%WME',
                moisture=22,
                dry_standard=12,
                affected=True,
                taken_at='2026-10-23T16:00:00Z',
            )
        )
    if case['reference']:
        readings.append(
            dict(
                kind='air',
                room='Bath',
                zone='unaffected',
                gpp=40,
                vapor_pressure_inhg=0.3,
                taken_at='2026-10-21T15:00:00Z',
            )
        )
    log = dict(readings=readings, updated_at='2026-10-23T17:00:00Z')
    job = store.db.records['_workspace_jobs/' + ID]
    store.db.records['authorizations/' + job['auth_id']]['inspection'] = data
    store.db.records['drying_logs/' + ID] = log
    monkeypatch.setattr(
        monitoring_store,
        'watch_state',
        lambda data, log, setup, previous: watch_state(
            data, log, setup, previous, at=instant(case['at'])
        ),
    )
    current = watch.view('office', ID)
    assert current['status'] == 'active'
    assert ('Bath' in current['missing_rooms']) == case['expected_missing']
    assert current['room_readings']['Bath']['overdue'] == case['expected_overdue']
    assert bool(current['room_readings']['Bath']['last_reading_at']) == bool(
        case['air'] or case['materials'] or case['reference']
    )
    assert current['air_trends']['Kitchen'] == 'stalled'
    assert 'stalled' in current['flags']
    if case['air']:
        assert current['air_trends']['Bath'] == 'improving'
    else:
        assert 'Bath' not in current['air_trends']
    names = room_names(current)
    index = names.index('Bath')
    option = summary_options(current)[index]
    assert option['trend'] == case['expected_trend']
    assert ('air' in option['mentions']) == case['reference']
    assert ('progress' in option['mentions']) == case['reference']
    selected = dict(
        rooms=[
            dict(
                room_index=index,
                trend=case['expected_trend'],
                mention='status',
            )
        ]
    )
    watch.save_summary('office', ID, current['facts_hash'], selected)
    text = watch.view('office', ID)['summary']['text']
    label = {'recorded': 'readings recorded', 'no_new_reading': 'no new reading'}.get(
        case['expected_trend'],
        case['expected_trend'],
    )
    assert text.endswith(f'Room {index + 1}: {label}.')
    wrong = deepcopy(selected)
    wrong['rooms'][0]['trend'] = (
        'recorded' if case['expected_trend'] == 'no_new_reading' else 'no_new_reading'
    )
    with pytest.raises(ValueError, match='does not match'):
        watch.save_summary('office', ID, current['facts_hash'], wrong)
