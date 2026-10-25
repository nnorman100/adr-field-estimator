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
    assert validate_summary(DryingSummary(text=case['valid']), case['facts']) == case['valid']


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
        validate_summary(DryingSummary(text=text), SUMMARIES[1]['facts'])


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
        return DryingSummary(text='Monitoring is active.')

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
        return DryingSummary(text='Monitoring is active.')

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
