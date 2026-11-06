"""Record retention: the owner's per-company setting and the daily sweep that honours it."""

import hashlib
import time
from copy import deepcopy
from datetime import datetime, timezone

import pytest

import backend.retention as retention
from backend.inspection_store import Conflict
from backend.monitoring_store import WatchAction
from backend.outcomes import JobClose
from backend.retention import DAY, Retention, RetentionUpdate
from backend.workspaces import AccessDenied, ArchiveRequest
from tests.fakes import png
from tests.test_drying_watch import request, watched  # noqa: F401  (fixtures)
from tests.test_workspaces import ID, OTHER, api, data, store  # noqa: F401  (fixtures)

NOW = time.time()


def iso(days_ago):
    return datetime.fromtimestamp(NOW - days_ago * DAY, timezone.utc).isoformat()


@pytest.fixture
def on(monkeypatch):
    monkeypatch.setattr(retention, '_forced', True)


@pytest.fixture
def off(monkeypatch):
    monkeypatch.setattr(retention, '_forced', False)


def keeper(store):
    return Retention(store.workspaces, store.bucket)


def days(**changes):
    chosen = dict(invitations=90, admin_events=90, job_monitoring=90, evidence_photos=90)
    chosen.update(changes)
    return chosen


def invitation(store, identifier, company, expired_days_ago, status='accepted'):
    email = identifier + '@example.invalid'
    store.db.records['_invitations/' + identifier] = dict(
        invitation_id=identifier,
        company_id=company,
        email=email,
        role='estimator',
        status=status,
        expires_at=NOW - expired_days_ago * DAY,
        created_at=iso(expired_days_ago + 7),
    )
    key = hashlib.sha256((company + ':' + email).encode()).hexdigest()
    store.db.records['_invite_keys/' + key] = {'invitation_id': identifier}
    return key


def admin_event(store, identifier, company, days_ago, action='company_profile'):
    store.db.records['_admin_events/' + identifier] = dict(
        event_id=identifier,
        actor_uid='owner',
        action=action,
        company_id=company,
        details={},
        created_at=iso(days_ago),
    )


def monitored_job(store, job_id, company, closed_days_ago):
    store.db.records['_workspace_jobs/' + job_id] = dict(
        job_id=job_id, company_id=company, auth_exists=True, auth_id='ADR-AUTH-' + job_id[-12:]
    )
    store.db.records['_job_monitoring/' + job_id] = dict(job_id=job_id, company_id=company)
    history = store.db.records.setdefault(
        '_estimate_history/' + company, dict(company_id=company, rows={})
    )
    row = {'signed_at': iso(200)}
    if closed_days_ago is not None:
        row['closed_at'] = iso(closed_days_ago)
    history['rows'][job_id] = row


def photo(store, uid, inspection_id, photo_id, revision):
    return store.add_photo(
        uid,
        inspection_id,
        dict(
            photo_id=photo_id,
            expected_revision=revision,
            room='Bathroom',
            captured_at='2026-10-01T10:00:00Z',
            data_url=png(),
        ),
    )


def archived_draft(store, inspection_id, archived_days_ago, uid='owner'):
    store.create_inspection(uid, inspection_id, data())
    record = photo(store, uid, inspection_id, 'c' * 32, 1)
    job = store.db.records['_workspace_jobs/' + inspection_id]
    store.workspaces.archive_job(
        'owner', inspection_id, ArchiveRequest(expected_version=job['version'])
    )
    store.db.records['_workspace_jobs/' + inspection_id]['archived_at'] = iso(archived_days_ago)
    return record['photos'][0]


def objects(store):
    return set(store.bucket.objects)


def run_events(store, company='adr'):
    return [
        r
        for k, r in store.db.records.items()
        if k.startswith('_admin_events/')
        and r['action'] == 'retention_run'
        and r['company_id'] == company
    ]


# The setting


def test_every_class_starts_at_90_days_and_the_effect_is_in_plain_words(store, off):
    view = keeper(store).view('owner', 'adr')
    assert view['days'] == days() and view['version'] == 0 and view['running'] is False
    assert (view['min_days'], view['max_days'], view['default_days']) == (30, 3650, 90)
    assert view['effect']['invitations'].startswith(
        'Invitations, with the email address they were sent to, are deleted 90 days after they expire.'
    )
    assert '90 days after a signed job is closed' in view['effect']['job_monitoring']
    assert '90 days after it was archived' in view['effect']['evidence_photos']
    assert 'never deleted' in view['effect']['evidence_photos']
    assert view['templates']['admin_events'].count('{days}') == 1


@pytest.mark.parametrize('uid', ['estimator', 'office', 'other-owner', 'admin'])
def test_only_the_company_owner_reads_or_changes_the_setting(store, uid):
    keep = keeper(store)
    with pytest.raises(AccessDenied):
        keep.view(uid, 'adr')
    with pytest.raises(AccessDenied):
        keep.update(uid, 'adr', RetentionUpdate(expected_version=0, days=days(invitations=30)))
    assert '_company_retention/adr' not in store.db.records


def test_the_owner_extends_or_shortens_each_class_and_the_change_is_audited(store):
    keep = keeper(store)
    saved = keep.update(
        'owner',
        'adr',
        RetentionUpdate(expected_version=0, days=days(invitations=30, evidence_photos=365)),
    )
    assert saved['version'] == 1 and saved['days'] == days(invitations=30, evidence_photos=365)
    assert '30 days after they expire' in saved['effect']['invitations']
    assert keep.view('owner', 'adr')['days'] == saved['days']
    [entry] = [
        r
        for k, r in store.db.records.items()
        if k.startswith('_admin_events/') and r['action'] == 'retention_settings'
    ]
    assert entry['details']['days']['invitations'] == 30 and entry['details']['previous'] == days()
    with pytest.raises(Conflict):
        keep.update('owner', 'adr', RetentionUpdate(expected_version=0, days=days()))
    # The other company keeps its own defaults.
    assert keep.settings('other')[0] == days()


@pytest.mark.parametrize('value', [29, 3651, 0, -1])
def test_periods_outside_the_bounds_are_refused(value):
    with pytest.raises(ValueError):
        RetentionUpdate(expected_version=0, days=days(admin_events=value))


def test_an_unreadable_stored_period_falls_back_to_the_default(store):
    store.db.records['_company_retention/adr'] = dict(
        version=3, days=dict(invitations=5, admin_events='30', job_monitoring=True)
    )
    assert keeper(store).settings('adr')[0] == days()


# The sweep


def test_nothing_is_deleted_while_the_feature_is_off(store, off):
    invitation(store, 'i' * 32, 'adr', 200)
    admin_event(store, 'e' * 32, 'adr', 400)
    before = dict(store.db.records)
    assert keeper(store).tick('estimator', 'adr', NOW) == {'ran': False}
    assert store.db.records == before


def test_invitations_go_90_days_after_expiry_and_pending_ones_stay(store, on):
    old_key = invitation(store, 'a' * 32, 'adr', 91)
    invitation(store, 'b' * 32, 'adr', 91, status='cancelled')
    invitation(store, 'c' * 32, 'adr', 95, status='pending')  # expired and never used
    invitation(store, 'd' * 32, 'adr', 89)
    invitation(store, 'e' * 32, 'adr', -5, status='pending')  # still open
    invitation(store, 'f' * 32, 'other', 200)
    result = keeper(store).tick('office', 'adr', NOW)
    assert result['ran'] and result['deleted']['invitations'] == 3
    left = {k.split('/')[1] for k in store.db.records if k.startswith('_invitations/')}
    assert left == {'d' * 32, 'e' * 32, 'f' * 32}
    assert '_invite_keys/' + old_key not in store.db.records


def test_admin_events_go_after_the_period_and_the_run_is_recorded(store, on):
    admin_event(store, '1' * 32, 'adr', 91)
    admin_event(store, '2' * 32, 'adr', 91, action='support_view_company')
    admin_event(store, '3' * 32, 'adr', 10)
    admin_event(store, '4' * 32, 'other', 400)
    result = keeper(store).tick('estimator', 'adr', NOW)
    assert result['deleted']['admin_events'] == 2
    assert '_admin_events/' + '3' * 32 in store.db.records
    assert '_admin_events/' + '4' * 32 in store.db.records
    [run] = run_events(store)
    assert run['actor_uid'] == 'system:retention'
    assert run['details']['deleted'] == {
        'invitations': 0,
        'admin_events': 2,
        'job_monitoring': 0,
        'evidence_photos': 0,
    }
    assert run['details']['triggered_by_uid'] == 'estimator' and run['details']['days'] == days()


def test_drying_watch_history_goes_only_after_the_job_has_been_closed_for_the_period(store, on):
    closed_long_ago = 'ADR-INS-' + '1' * 32
    closed_recently = 'ADR-INS-' + '2' * 32
    never_closed = 'ADR-INS-' + '3' * 32
    other_company = 'ADR-INS-' + '4' * 32
    monitored_job(store, closed_long_ago, 'adr', 91)
    monitored_job(store, closed_recently, 'adr', 30)
    monitored_job(store, never_closed, 'adr', None)
    monitored_job(store, other_company, 'other', 400)
    assert keeper(store).tick('owner', 'adr', NOW)['deleted']['job_monitoring'] == 1
    left = {k.split('/')[1] for k in store.db.records if k.startswith('_job_monitoring/')}
    assert left == {closed_long_ago, closed_recently, never_closed, other_company}
    marker = store.db.records['_job_monitoring/' + closed_long_ago]
    assert set(marker) == MARKER_KEYS and marker['closed']['action'] == 'close'
    for kept in (never_closed, other_company):
        assert set(store.db.records['_job_monitoring/' + kept]) == {'job_id', 'company_id'}
    assert 'history_deleted_at' not in store.db.records['_job_monitoring/' + closed_recently]
    # The job, its history row and its signed agreement are not this class.
    assert '_workspace_jobs/' + closed_long_ago in store.db.records
    assert closed_long_ago in store.db.records['_estimate_history/adr']['rows']


def test_photos_of_a_long_archived_draft_go_and_restoring_brings_back_the_draft_without_them(
    store, on
):
    gone = archived_draft(store, ID, 91)
    before = objects(store)
    assert gone['file']['path'] in before and gone['model_file']['path'] in before
    assert keeper(store).tick('owner', 'adr', NOW)['deleted']['evidence_photos'] == 1
    assert not objects(store) & {gone['file']['path'], gone['model_file']['path']}
    record = store.db.records['inspections/' + ID]
    assert record['photos'] == [] and record['audit'] is None and record['revision'] == 3
    job = store.db.records['_workspace_jobs/' + ID]
    assert job['evidence_deleted_photos'] == 1 and job['evidence_pending_paths'] == []
    # The draft itself stays and can be restored, without its photos.
    store.workspaces.restore_job('owner', ID, ArchiveRequest(expected_version=job['version']))
    assert store.get_inspection('owner', ID)['photos'] == []


def test_recently_archived_drafts_open_drafts_and_signed_jobs_keep_their_photos(store, on):
    recent = archived_draft(store, ID, 30)
    store.create_inspection('estimator', OTHER, data())
    open_draft = photo(store, 'estimator', OTHER, 'd' * 32, 1)['photos'][0]
    # A signed job cannot be archived; mark one as archived anyway to prove the sweep refuses it.
    signed = 'ADR-INS-' + 'e' * 32
    store.create_inspection('owner', signed, data())
    signed_photo = photo(store, 'owner', signed, 'f' * 32, 1)['photos'][0]
    store.db.records['inspections/' + signed]['status'] = 'signed'
    store.db.records['_workspace_jobs/' + signed].update(
        kind='archived_inspection', archived_at=iso(400)
    )
    before = objects(store)
    assert keeper(store).tick('owner', 'adr', NOW)['deleted']['evidence_photos'] == 0
    assert objects(store) == before
    for path in (recent['file']['path'], open_draft['file']['path'], signed_photo['file']['path']):
        assert path in objects(store)
    assert len(store.db.records['inspections/' + signed]['photos']) == 1
    store.db.records['inspections/' + signed]['status'] = 'draft'
    store.db.records['_workspace_jobs/' + signed]['auth_exists'] = True
    assert keeper(store).tick('owner', 'adr', NOW + 2 * DAY)['deleted']['evidence_photos'] == 0
    assert signed_photo['file']['path'] in objects(store)


def test_a_photo_object_that_fails_to_delete_is_retried_on_the_next_run(store, on, monkeypatch):
    gone = archived_draft(store, ID, 91)
    blob_class = type(store.bucket.blob('x'))
    real_delete = blob_class.delete

    def failing(self, **kwargs):
        raise RuntimeError('storage unavailable')

    monkeypatch.setattr(blob_class, 'delete', failing)
    assert keeper(store).tick('owner', 'adr', NOW)['deleted']['evidence_photos'] == 0
    job = store.db.records['_workspace_jobs/' + ID]
    assert gone['file']['path'] in job['evidence_pending_paths']
    assert store.db.records['inspections/' + ID]['photos'] == []
    monkeypatch.setattr(blob_class, 'delete', real_delete)
    assert keeper(store).tick('owner', 'adr', NOW + DAY + 1)['deleted']['evidence_photos'] == 1
    assert gone['file']['path'] not in objects(store)
    assert store.db.records['_workspace_jobs/' + ID]['evidence_pending_paths'] == []


def test_the_owners_longer_setting_keeps_what_the_default_would_delete(store, on):
    keeper(store).update(
        'owner',
        'adr',
        RetentionUpdate(
            expected_version=0,
            days=days(invitations=365, admin_events=365, job_monitoring=365, evidence_photos=365),
        ),
    )
    invitation(store, 'a' * 32, 'adr', 200)
    admin_event(store, '1' * 32, 'adr', 200)
    monitored_job(store, 'ADR-INS-' + '1' * 32, 'adr', 200)
    archived_draft(store, ID, 200)
    result = keeper(store).tick('owner', 'adr', NOW)
    assert result['deleted'] == dict(
        invitations=0, admin_events=0, job_monitoring=0, evidence_photos=0
    )
    keeper(store).update(
        'owner', 'adr', RetentionUpdate(expected_version=1, days=days(invitations=30))
    )
    invitation(store, 'b' * 32, 'adr', 31)
    assert keeper(store).tick('owner', 'adr', NOW + DAY + 1)['deleted']['invitations'] == 2


def test_a_setting_lengthened_during_a_sweep_wins_over_the_list_it_read(store, on, monkeypatch):
    invitation(store, 'a' * 32, 'adr', 100)
    keep = keeper(store)
    real_run = store.workspaces._run
    calls = []

    def run(callback):
        calls.append(callback)
        if len(calls) == 2:  # the first per-record transaction, after the lease
            store.db.records['_company_retention/adr'] = dict(version=1, days=days(invitations=365))
        return real_run(callback)

    monkeypatch.setattr(store.workspaces, '_run', run)
    assert keep.tick('owner', 'adr', NOW)['deleted']['invitations'] == 0
    assert '_invitations/' + 'a' * 32 in store.db.records


def test_the_sweep_runs_once_a_day_per_company_and_a_held_lease_is_respected(store, on):
    keep = keeper(store)
    assert keep.tick('owner', 'adr', NOW)['ran']
    assert keep.tick('estimator', 'adr', NOW + 3600) == {'ran': False}
    # The other company has its own day.
    assert keep.tick('other-owner', 'other', NOW + 3600)['ran']
    store.db.records['_retention_state/adr']['lease_until'] = NOW + DAY + 300
    assert keep.tick('owner', 'adr', NOW + DAY + 1) == {'ran': False}
    assert keep.tick('owner', 'adr', NOW + DAY + 301)['ran']
    assert len(run_events(store)) == 2
    state = store.db.records['_retention_state/adr']
    assert state['last_outcome'] == 'completed' and state['lease_until'] == 0


def test_a_failed_sweep_is_recorded_and_frees_the_lease_for_tomorrow(store, on, monkeypatch):
    keep = keeper(store)

    real_sweep = keep.sweep

    def broken(company_id, moment, deleted):
        keep._invitations = lambda *args: 1
        keep._admin_events = lambda *args: (_ for _ in ()).throw(RuntimeError('unavailable'))
        return real_sweep(company_id, moment, deleted)

    monkeypatch.setattr(keep, 'sweep', broken)
    with pytest.raises(RuntimeError):
        keep.tick('owner', 'adr', NOW)
    [run] = run_events(store)
    assert run['details']['outcome'] == 'RuntimeError'
    # What the run deleted before it failed is still on the record.
    assert run['details']['deleted']['invitations'] == 1
    assert store.db.records['_retention_state/adr']['next_run_at'] == NOW + DAY


@pytest.mark.parametrize('uid', ['other-owner', 'admin', 'nobody'])
def test_only_a_member_of_the_company_starts_its_sweep(store, on, uid):
    with pytest.raises((AccessDenied, LookupError)):
        keeper(store).tick(uid, 'adr', NOW)
    assert '_retention_state/adr' not in store.db.records


# The API


def test_the_api_serves_the_owner_and_refuses_the_rest(api, off):
    client, current, store = api
    view = client.get('/api/companies/adr/retention')
    assert view.status_code == 200 and view.json()['days'] == days()
    saved = client.put(
        '/api/companies/adr/retention',
        json={'expected_version': 0, 'days': days(admin_events=180)},
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()['days']['admin_events'] == 180
    assert (
        client.put(
            '/api/companies/adr/retention',
            json={'expected_version': 1, 'days': days(admin_events=10)},
        ).status_code
        == 422
    )
    assert (
        client.put(
            '/api/companies/adr/retention',
            json={'expected_version': 0, 'days': days()},
        ).status_code
        == 409
    )
    for uid in ('estimator', 'office', 'other-owner'):
        current['uid'] = uid
        assert client.get('/api/companies/adr/retention').status_code == 403
        assert (
            client.put(
                '/api/companies/adr/retention', json={'expected_version': 1, 'days': days()}
            ).status_code
            == 403
        )
    assert store.db.records['_company_retention/adr']['days']['admin_events'] == 180


def test_the_run_route_and_the_session_follow_the_feature_switch(api, monkeypatch):
    client, current, store = api
    invitation(store, 'a' * 32, 'adr', 200)
    monkeypatch.setattr(retention, '_forced', False)
    current['uid'] = 'estimator'
    assert client.get('/api/session').json()['retention_enabled'] is False
    assert client.get('/api/access').json()['retention_enabled'] is False
    assert client.post('/api/companies/adr/retention/run').json() == {'ran': False}
    assert '_invitations/' + 'a' * 32 in store.db.records
    monkeypatch.setattr(retention, '_forced', True)
    assert client.get('/api/session').json()['retention_enabled'] is True
    ran = client.post('/api/companies/adr/retention/run')
    assert ran.status_code == 200 and ran.json()['deleted']['invitations'] == 1
    assert client.post('/api/companies/adr/retention/run').json() == {'ran': False}
    current['uid'] = 'other-owner'
    assert client.post('/api/companies/adr/retention/run').status_code == 403


def test_only_owners_hold_the_retention_capability(api):
    client, current, store = api
    for uid, allowed in (('owner', True), ('estimator', False), ('office', False)):
        current['uid'] = uid
        assert ('retention_manage' in client.get('/api/session').json()['capabilities']) is allowed


def failing_photo_deletes(store, monkeypatch):
    blob_class = type(store.bucket.blob('x'))
    real_delete = blob_class.delete

    def failing(self, **kwargs):
        raise RuntimeError('storage unavailable')

    monkeypatch.setattr(blob_class, 'delete', failing)
    return lambda: monkeypatch.setattr(blob_class, 'delete', real_delete)


def restore_with_a_new_photo(store):
    job = store.db.records['_workspace_jobs/' + ID]
    store.workspaces.restore_job('owner', ID, ArchiveRequest(expected_version=job['version']))
    revision = store.db.records['inspections/' + ID]['revision']
    return photo(store, 'owner', ID, 'e' * 32, revision)['photos'][0]


def test_a_failed_photo_delete_is_retried_after_the_draft_is_restored(store, on, monkeypatch):
    gone = archived_draft(store, ID, 91)
    heal = failing_photo_deletes(store, monkeypatch)
    assert keeper(store).tick('owner', 'adr', NOW)['deleted']['evidence_photos'] == 0
    kept = restore_with_a_new_photo(store)
    heal()
    assert keeper(store).tick('owner', 'adr', NOW + DAY + 1)['deleted']['evidence_photos'] == 1
    assert gone['file']['path'] not in objects(store)
    assert kept['file']['path'] in objects(store)
    assert store.get_inspection('owner', ID)['photos'] == [kept]
    assert store.db.records['_workspace_jobs/' + ID]['evidence_pending_paths'] == []


def test_photos_added_after_a_restore_wait_for_their_own_archiving_period(store, on, monkeypatch):
    gone = archived_draft(store, ID, 91)
    heal = failing_photo_deletes(store, monkeypatch)
    assert keeper(store).tick('owner', 'adr', NOW)['deleted']['evidence_photos'] == 0
    kept = restore_with_a_new_photo(store)
    job = store.db.records['_workspace_jobs/' + ID]
    store.workspaces.archive_job('owner', ID, ArchiveRequest(expected_version=job['version']))
    heal()
    assert keeper(store).tick('owner', 'adr', NOW + DAY + 1)['deleted']['evidence_photos'] == 1
    assert gone['file']['path'] not in objects(store)
    assert kept['file']['path'] in objects(store)
    assert len(store.db.records['inspections/' + ID]['photos']) == 1
    assert keeper(store).tick('owner', 'adr', NOW + 89 * DAY)['deleted']['evidence_photos'] == 0
    assert keeper(store).tick('owner', 'adr', NOW + 92 * DAY)['deleted']['evidence_photos'] == 1
    assert kept['file']['path'] not in objects(store)


def test_a_sweep_that_fails_midway_still_reports_what_it_deleted(store, on, monkeypatch):
    invitation(store, 'a' * 32, 'adr', 91)
    invitation(store, 'b' * 32, 'adr', 91)
    real_run = store.workspaces._run
    calls = []

    def run(callback):
        calls.append(callback)
        if len(calls) == 3:  # the second invitation, after the lease and the first
            raise RuntimeError('unavailable')
        return real_run(callback)

    monkeypatch.setattr(store.workspaces, '_run', run)
    with pytest.raises(RuntimeError):
        keeper(store).tick('owner', 'adr', NOW)
    assert sum(k.startswith('_invitations/') for k in store.db.records) == 1
    [entry] = run_events(store)
    assert entry['details']['deleted']['invitations'] == 1
    assert store.db.records['_retention_state/adr']['last_deleted']['invitations'] == 1


MARKER_KEYS = {'job_id', 'company_id', 'job_closed_at', 'history_deleted_at', 'closed'}


def stays_the_marker(store, watch):
    marker = deepcopy(store.db.records['_job_monitoring/' + ID])
    assert set(marker) == MARKER_KEYS
    assert watch.view('office', ID)['status'] == 'closed'
    store.workspaces._run(lambda tx: watch.sync(ID, tx))
    assert store.db.records['_job_monitoring/' + ID] == marker
    return marker


def close_job(store, uid='office'):
    job = store.db.records['_workspace_jobs/' + ID]
    store.outcomes.close(
        uid,
        ID,
        JobClose(final_amount='3310.00', actual_days=4, expected_signed_at=job['signed_at']),
    )


def test_a_closed_drying_watch_stays_closed_once_its_history_is_deleted(watched, on):
    client, current, store, watch = watched
    watch.change(
        'office',
        ID,
        WatchAction(
            action='close',
            reason='Synthetic private close reason',
            facts_hash=watch.view('office', ID)['facts_hash'],
            request_id='b' * 32,
            approved=True,
        ),
    )
    close_job(store)
    later = time.time() + 91 * DAY
    assert keeper(store).tick('owner', 'adr', later)['deleted']['job_monitoring'] == 1
    marker = store.db.records['_job_monitoring/' + ID]
    assert set(marker) == MARKER_KEYS
    assert set(marker['closed']) == {'action', 'at'} and marker['closed']['action'] == 'close'
    assert 'Synthetic private close reason' not in str(marker)
    shown = watch.view('office', ID)
    assert shown['status'] == 'closed' and shown['flags'] == [] and shown['next_due_at'] is None
    with pytest.raises(Conflict):
        watch.remind('office', ID, request(watch))
    with pytest.raises(Conflict):
        watch.change(
            'office',
            ID,
            WatchAction(
                action='extend',
                reason='Synthetic extension',
                facts_hash=shown['facts_hash'],
                request_id='c' * 32,
                approved=True,
            ),
        )
    # Opening the watch and a reading update or reassignment store only the marker again.
    marker = stays_the_marker(store, watch)
    assert 'address' not in marker and 'accessible_estimator_uids' not in marker
    assert keeper(store).tick('owner', 'adr', later + DAY + 1)['deleted']['job_monitoring'] == 0


def test_the_close_time_kept_on_the_drying_watch_outlives_a_trimmed_history_row(watched, on):
    client, current, store, watch = watched
    watch.view('office', ID)
    close_job(store)
    assert store.db.records['_job_monitoring/' + ID]['job_closed_at']
    del store.db.records['_estimate_history/adr']['rows'][ID]
    soon = time.time() + 89 * DAY
    assert keeper(store).tick('owner', 'adr', soon)['deleted']['job_monitoring'] == 0
    assert keeper(store).tick('owner', 'adr', soon + 2 * DAY)['deleted']['job_monitoring'] == 1
    # A watch never closed by hand ends at the job's close, and the close time stays with it.
    marker = stays_the_marker(store, watch)
    assert marker['job_closed_at'] and marker['closed']['action'] == 'close'
    assert keeper(store).tick('owner', 'adr', soon + 4 * DAY)['deleted']['job_monitoring'] == 0


def test_a_sidecar_from_before_close_times_were_stored_counts_from_its_last_write(store, on):
    job_id = 'ADR-INS-' + '5' * 32
    monitored_job(store, job_id, 'adr', 200)
    store.db.records['_job_monitoring/' + job_id]['updated_at'] = iso(10)
    assert keeper(store).tick('owner', 'adr', NOW)['deleted']['job_monitoring'] == 0
    stamped = store.db.records['_job_monitoring/' + job_id]['job_closed_at']
    assert retention._epoch(stamped) == pytest.approx(NOW - 10 * DAY)
    del store.db.records['_estimate_history/adr']['rows'][job_id]
    assert keeper(store).tick('owner', 'adr', NOW + 79 * DAY)['deleted']['job_monitoring'] == 0
    assert keeper(store).tick('owner', 'adr', NOW + 81 * DAY)['deleted']['job_monitoring'] == 1


def test_a_sidecar_from_before_close_times_whose_history_row_was_trimmed_still_expires(store, on):
    job_id = 'ADR-INS-' + '6' * 32
    monitored_job(store, job_id, 'adr', 200)
    del store.db.records['_estimate_history/adr']['rows'][job_id]
    store.db.records['_job_monitoring/' + job_id]['updated_at'] = iso(89)
    assert keeper(store).tick('owner', 'adr', NOW)['deleted']['job_monitoring'] == 0
    assert keeper(store).tick('owner', 'adr', NOW + 2 * DAY)['deleted']['job_monitoring'] == 1
    assert set(store.db.records['_job_monitoring/' + job_id]) == MARKER_KEYS
