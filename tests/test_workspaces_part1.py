import backend.main as bm
import json
import pytest
import smtplib
import time
from backend.contracts import AIResult
from backend.contracts import InspectionData
from backend.inspection_store import Conflict
from backend.workspace_migration import migrate
from backend.workspaces import AccessDenied
from backend.workspaces import CompanyProfile
from backend.workspaces import CoordinationUpdate
from backend.workspaces import MemberUpdate
from backend.workspaces import ProfileUpdate
from backend.workspaces import StatusUpdate
from copy import deepcopy
from fastapi.testclient import TestClient
from tests.adr_pricing import make_documents
from tests.fakes import ADR_PROFILE
from tests.fakes import FakeCompanyStore
from tests.fakes import FakeStore
from tests.fakes import png
from tests.test_voice_notes import note as voice_note
from tests.test_workspaces import (
    ID,
    OTHER,
    data,
    identity,
    seed_jobs,
)
from tests.test_workspaces import (  # noqa: F401  (pytest fixtures)
    store,
    api,
)


def test_roles_and_cross_company_scoped_jobs(store):
    record = store.create_inspection('estimator', ID, data())
    store.create_inspection('other-owner', OTHER, data())
    for uid in ('owner', 'office', 'estimator'):
        assert store.get_inspection(uid, ID)['inspection_id'] == ID
    for uid in ('admin', 'other-owner', 'estimator2'):
        with pytest.raises((AccessDenied, LookupError)):
            store.get_inspection(uid, ID)
    assert not store.list_inspections('estimator2')
    assert len(store.list_inspections('owner')) == 1
    with pytest.raises(LookupError):
        store.inspection_page('owner', OTHER)
    with pytest.raises(AccessDenied):
        store.update_inspection('office', ID, 1, data('Changed'))
    with pytest.raises(AccessDenied):
        store.add_photo(
            'office',
            ID,
            dict(
                photo_id='c' * 32,
                expected_revision=1,
                room='Bathroom',
                captured_at='2026',
                data_url=png(),
            ),
        )


@pytest.mark.parametrize(
    'collection, id_field', [('inspections', 'inspection_id'), ('authorizations', 'auth_id')]
)
def test_job_list_pages_skip_jobs_whose_source_is_missing(store, collection, id_field):
    kept = seed_jobs(store, 205, lambda i: i % 3 == 0 or i > 180)
    page = getattr(store, collection[:-1].replace('inspection', 'inspection') + '_page')
    for uid in ('owner', 'office', 'estimator'):
        rows, cursor = page(uid)
        assert len(rows) == 100 and cursor
        seen = [r[id_field] for r in rows]
        while cursor:
            rows, cursor = page(uid, cursor)
            seen += [r[id_field] for r in rows]
        assert len(seen) == len(set(seen)) and set(seen) == kept[collection]
    assert page('estimator2') == ([], None)
    assert page('other-owner') == ([], None)
    store.db.records['_workspace_jobs/' + 'ADR-INS-' + 'f' * 32] = dict(
        job_id='ADR-INS-' + 'f' * 32, company_id='other', kind='inspection', updated_at='2027'
    )
    with pytest.raises(LookupError):
        page('owner', 'ADR-INS-' + 'f' * 32 if collection == 'inspections' else 'ADR-AUTH-999999')


def test_job_list_api_skips_orphans_but_direct_reads_stay_not_found(api, caplog):
    client, current, store = api
    seed_jobs(store, 3, lambda i: i == 1)
    orphan, auth_orphan = 'ADR-INS-' + f'{1:032x}', 'ADR-AUTH-000001'
    store.db.records['inspections/ADR-INS-' + f'{0:032x}'].update(
        data=data(), revision=1, status='signed'
    )
    store.db.records['inspections/ADR-INS-' + f'{2:032x}'].update(
        data=data(), revision=1, status='signed'
    )
    listed = client.get('/api/inspections')
    assert listed.status_code == 200
    assert [r['inspection_id'] for r in listed.json()['inspections']] == [
        'ADR-INS-' + f'{2:032x}',
        'ADR-INS-' + f'{0:032x}',
    ]
    signed = client.get('/api/authorizations')
    assert signed.status_code == 200
    assert [r['auth_id'] for r in signed.json()['authorizations']] == [
        'ADR-AUTH-000002',
        'ADR-AUTH-000000',
    ]
    assert client.get('/api/inspections/' + orphan).status_code == 404
    assert client.get('/api/authorizations/' + auth_orphan).status_code == 404
    assert '_workspace_jobs/' + orphan in store.db.records
    skipped = [r for r in caplog.records if r.getMessage().startswith('Job list skipped')]
    assert skipped and all(
        r.fields == dict(operation='job_list', outcome='missing_source') for r in skipped
    )


@pytest.mark.parametrize('uid', ['office', 'other-owner', 'admin', 'estimator2'])
def test_direct_api_cannot_bypass_scope_permissions(api, uid):
    client, current, store = api
    store.create_inspection('estimator', ID, data())
    current['uid'] = uid
    assert client.put(
        '/api/inspections/' + ID, json={'expected_revision': 1, 'data': data()}
    ).status_code in (403, 404)
    assert client.post(
        '/api/audit', json={'inspection_id': ID, 'expected_revision': 1}
    ).status_code in (403, 404)
    assert client.post(
        '/api/inspections/' + ID + '/scope-suggestions',
        json={'inspection_id': ID, 'expected_revision': 1},
    ).status_code in (403, 404)
    assert client.post(
        '/api/inspections/' + ID + '/photos/' + 'c' * 32 + '/ocr', json={}
    ).status_code in (403, 404)
    assert client.post(
        '/api/inspections/' + ID + '/voice-notes', json=voice_note()
    ).status_code in (
        403,
        404,
    )
    assert (
        'Offline voice note'
        not in store.get_inspection('estimator', ID)['data']['technician_transcript']
    )


@pytest.mark.parametrize('uid', ['owner', 'estimator'])
def test_owner_and_job_estimator_can_add_offline_voice_notes(api, monkeypatch, uid):
    client, current, store = api
    store.create_inspection('estimator', ID, data())

    async def generate(schema, *args, **kwargs):
        assert schema is bm.TranscriptionResult
        return bm.TranscriptionResult(text='Bathroom category 1.')

    monkeypatch.setattr(bm, 'generate', generate)
    current['uid'] = uid
    saved = client.post('/api/inspections/' + ID + '/voice-notes', json=voice_note())
    assert saved.status_code == 200, saved.text
    assert saved.json()['data']['technician_transcript'].endswith('\nBathroom category 1.\n')
    assert store.db.records['_workspace_jobs/' + ID]['updated_at'] == saved.json()['updated_at']


def test_office_creation_and_assignment(api):
    client, current, store = api
    current['uid'] = 'office'
    initial = InspectionData(address='Office job').model_dump(mode='json')
    assert (
        client.post('/api/inspections', json={'inspection_id': ID, 'data': initial}).status_code
        == 200
    )
    assert (
        client.post('/api/inspections', json={'inspection_id': OTHER, 'data': data()}).status_code
        == 403
    )
    job = client.get('/api/jobs/' + ID + '/coordination').json()
    request = {
        'expected_version': job['version'],
        'customer_name': 'Test',
        'assigned_estimator_uid': 'estimator',
        'address': 'Updated office job',
    }
    assert client.put('/api/jobs/' + ID + '/coordination', json=request).status_code == 200
    assert store.get_inspection('estimator', ID)['revision'] == 2
    request['expected_version'] = 2
    request['assigned_estimator_uid'] = 'other-owner'
    assert client.put('/api/jobs/' + ID + '/coordination', json=request).status_code == 400
    current['uid'] = 'estimator'
    assert client.put('/api/jobs/' + ID + '/coordination', json=request).status_code == 403
    assert client.get('/api/companies/other/team').status_code == 403


def test_team_roster_requires_owner_or_assignment_directory(api):
    client, current, store = api
    store.db.records['_memberships/gone'] = dict(
        uid='gone',
        email='gone@example.invalid',
        company_id='adr',
        role='estimator',
        status='disabled',
        version=2,
        updated_at='2026',
    )
    current['uid'] = 'estimator'
    assert client.get('/api/companies/adr/team').status_code == 403
    current['uid'] = 'office'
    directory = client.get('/api/companies/adr/team').json()['members']
    assert sorted(m['uid'] for m in directory) == ['estimator', 'estimator2']
    assert all(
        set(m) == {'uid', 'email', 'role', 'status'}
        and m['role'] == 'estimator'
        and m['status'] == 'active'
        for m in directory
    )
    assert client.get('/api/companies/other/team').status_code == 403
    current['uid'] = 'other-owner'
    roster = client.get('/api/companies/other/team').json()['members']
    assert [m['uid'] for m in roster] == ['other-owner'] and roster[0]['version'] == 1
    assert client.get('/api/companies/adr/team').status_code == 403
    current['uid'] = 'admin'
    assert {m['uid'] for m in client.get('/api/companies/adr/team').json()['members']} == {
        'owner',
        'estimator',
        'estimator2',
        'office',
        'gone',
    }


def test_assignment_retains_creator_and_revokes_previous_assignee(store):
    store.create_inspection('estimator', ID, data())
    first = CoordinationUpdate(expected_version=1, assigned_estimator_uid='estimator2')
    store.workspaces.coordination('office', ID, first)
    assert store.get_inspection('estimator2', ID)
    store.workspaces.coordination('owner', ID, CoordinationUpdate(expected_version=2))
    with pytest.raises(LookupError):
        store.get_inspection('estimator2', ID)
    assert store.get_inspection('estimator', ID)


def test_invitation_requires_google_email_expiry_and_explicit_acceptance(store):
    w = store.workspaces
    invitation = w.invite('owner', 'adr', 'new@example.invalid', 'estimator')
    assert not w.principal('new')['role']
    with pytest.raises(LookupError):
        w.accept(identity('wrong'), invitation['invitation_id'])
    claims = identity('new')
    assert w.accept(claims, invitation['invitation_id'])['role'] == 'estimator'
    assert w.accept(claims, invitation['invitation_id'])['role'] == 'estimator'
    expired = w.invite('owner', 'adr', 'expired@example.invalid', 'office')
    store.db.records['_invitations/' + expired['invitation_id']]['expires_at'] = 0
    with pytest.raises(Conflict):
        w.accept(identity('expired'), expired['invitation_id'])
    cancelled = w.invite('owner', 'adr', 'cancelled@example.invalid', 'office')
    w.invitation_action('owner', 'adr', cancelled['invitation_id'], 'cancel')
    with pytest.raises(Conflict):
        w.accept(identity('cancelled'), cancelled['invitation_id'])
    other = w.invite('owner', 'adr', 'other-owner@example.invalid', 'estimator')
    with pytest.raises(Conflict):
        w.accept(identity('other-owner'), other['invitation_id'])


def test_clear_hides_cancelled_and_expired_invitations_without_deleting_them(api, capsys):
    client, current, store = api
    del store.db.records['_platform_admins/owner']
    w = store.workspaces
    pending = w.invite('owner', 'adr', 'pending@example.invalid', 'estimator')
    cancelled = w.invite('owner', 'adr', 'cancelled@example.invalid', 'office')
    w.invitation_action('owner', 'adr', cancelled['invitation_id'], 'cancel')
    expired = w.invite('owner', 'adr', 'expired@example.invalid', 'office')
    store.db.records['_invitations/' + expired['invitation_id']]['expires_at'] = 0
    accepted = w.invite('owner', 'adr', 'accepted@example.invalid', 'estimator')
    assert w.accept(identity('accepted'), accepted['invitation_id'])['role'] == 'estimator'
    already = w.invite('owner', 'adr', 'already@example.invalid', 'office')
    w.invitation_action('owner', 'adr', already['invitation_id'], 'cancel')
    store.db.records['_invitations/' + already['invitation_id']].update(
        cleared_at='2026-01-01T00:00:00+00:00', cleared_by='owner'
    )
    limits = deepcopy(store.db.records['_company_limits/adr'])
    pending_record = deepcopy(store.db.records['_invitations/' + pending['invitation_id']])
    accepted_record = deepcopy(store.db.records['_invitations/' + accepted['invitation_id']])
    already_record = deepcopy(store.db.records['_invitations/' + already['invitation_id']])
    listed = {
        row['email'] for row in client.get('/api/companies/adr/invitations').json()['invitations']
    }
    assert listed == {
        'pending@example.invalid',
        'cancelled@example.invalid',
        'expired@example.invalid',
        'accepted@example.invalid',
    }
    capsys.readouterr()
    response = client.post('/api/companies/adr/invitations/clear')
    assert response.status_code == 200, response.text
    assert response.json() == {'cleared': 2}
    logged = [
        json.loads(line)
        for line in capsys.readouterr().out.splitlines()
        if 'Invitations cleared' in line
    ]
    assert logged == [
        {
            'severity': 'INFO',
            'message': 'Invitations cleared',
            'operation': 'invitation_clear',
            'outcome': 'cleared',
            'cleared': 2,
        }
    ]
    assert 'example.invalid' not in json.dumps(logged)
    visible = {
        row['email'] for row in client.get('/api/companies/adr/invitations').json()['invitations']
    }
    assert visible == {'pending@example.invalid', 'accepted@example.invalid'}
    assert store.db.records['_company_limits/adr'] == limits
    assert store.db.records['_invitations/' + pending['invitation_id']] == pending_record
    assert store.db.records['_invitations/' + accepted['invitation_id']] == accepted_record
    assert store.db.records['_invitations/' + already['invitation_id']] == already_record
    for record, status in ((cancelled, 'cancelled'), (expired, 'pending')):
        stored = store.db.records['_invitations/' + record['invitation_id']]
        assert stored['status'] == status
        assert stored['cleared_by'] == 'owner' and stored['cleared_at']
        assert stored['email'] == record['email']
    cleared_at = store.db.records['_invitations/' + cancelled['invitation_id']]['cleared_at']
    owner_events = [
        row for row in store.db.records.values() if row.get('action') == 'invitation_clear'
    ]
    assert len(owner_events) == 1
    assert owner_events[0]['details'] == {'cleared': 2}
    assert owner_events[0]['actor_uid'] == 'owner' and 'target' not in owner_events[0]
    assert 'example.invalid' not in json.dumps(owner_events)
    again = client.post('/api/companies/adr/invitations/clear')
    assert again.status_code == 200 and again.json() == {'cleared': 0}
    assert (
        store.db.records['_invitations/' + cancelled['invitation_id']]['cleared_at'] == cleared_at
    )
    with pytest.raises(Conflict):
        w.accept(identity('cancelled'), cancelled['invitation_id'])
    with pytest.raises(Conflict):
        w.accept(identity('expired'), expired['invitation_id'])
    fresh = w.invite('owner', 'adr', 'cancelled@example.invalid', 'office')
    assert fresh['invitation_id'] != cancelled['invitation_id']
    assert store.db.records['_invitations/' + cancelled['invitation_id']]['status'] == 'cancelled'
    snapshot = {
        key: deepcopy(value)
        for key, value in store.db.records.items()
        if key.startswith('_invitations/') or key.startswith('_company_limits/')
    }
    for uid in ('estimator', 'office', 'other-owner', 'outsider'):
        current['uid'] = uid
        refused = client.post('/api/companies/adr/invitations/clear')
        assert refused.status_code == 403, (uid, refused.text)
        assert 'example.invalid' not in refused.text
    assert {
        key: value
        for key, value in store.db.records.items()
        if key.startswith('_invitations/') or key.startswith('_company_limits/')
    } == snapshot
    other = w.invite('other-owner', 'other', 'other-cancelled@example.invalid', 'office')
    w.invitation_action('other-owner', 'other', other['invitation_id'], 'cancel')
    current['uid'] = 'admin'
    support = client.post('/api/companies/other/invitations/clear')
    assert support.status_code == 403
    stored = deepcopy(store.db.records['_invitations/' + other['invitation_id']])
    assert 'cleared_at' not in stored
    current['uid'] = 'other-owner'
    assert client.post('/api/companies/other/invitations/clear').json() == {'cleared': 1}
    stored = deepcopy(store.db.records['_invitations/' + other['invitation_id']])
    store.db.records['_companies/other']['status'] = 'suspended'
    assert client.post('/api/companies/other/invitations/clear').status_code == 403
    assert store.db.records['_invitations/' + other['invitation_id']] == stored


def test_clear_skips_an_invitation_accepted_after_the_list_read(api, monkeypatch):
    """The transaction re-reads each row before writing, so an acceptance that lands after the
    company query does not get a cleared stamp or lose its accepted status."""
    client, current, store = api
    w = store.workspaces
    race = w.invite('owner', 'adr', 'race@example.invalid', 'office')
    cancelled = w.invite('owner', 'adr', 'gone@example.invalid', 'office')
    w.invitation_action('owner', 'adr', cancelled['invitation_id'], 'cancel')
    original = w.company_invitation_rows

    def accept_during_query(company_id, tx=None):
        rows = original(company_id, tx)
        record = store.db.records['_invitations/' + race['invitation_id']]
        record['status'] = 'accepted'
        record['accepted_by'] = 'race'
        return rows

    monkeypatch.setattr(w, 'company_invitation_rows', accept_during_query)
    response = client.post('/api/companies/adr/invitations/clear')
    assert response.status_code == 200, response.text
    assert response.json() == {'cleared': 1}
    raced = store.db.records['_invitations/' + race['invitation_id']]
    assert raced['status'] == 'accepted' and raced['accepted_by'] == 'race'
    assert 'cleared_at' not in raced
    assert store.db.records['_invitations/' + cancelled['invitation_id']]['cleared_by'] == 'owner'


def test_no_owner_or_superadmin_escalation(store):
    w = store.workspaces
    with pytest.raises(AccessDenied):
        w.invite('office', 'adr', 'x@example.invalid', 'estimator')
    # owner is also a platform admin in this fixture; estimator is never an admin.
    with pytest.raises(AccessDenied):
        w.invite('estimator', 'adr', 'x@example.invalid', 'owner')
    with pytest.raises(AccessDenied):
        w.update_member(
            'owner',
            'adr',
            'owner',
            MemberUpdate(expected_version=1, role='office', status='disabled'),
        )
    with pytest.raises(AccessDenied):
        w.create_company('estimator', 'Company', 'x@example.invalid')
    with pytest.raises(LookupError):
        w.update_member(
            'owner',
            'adr',
            'other-owner',
            MemberUpdate(expected_version=1, role='office', status='disabled'),
        )


def test_email_confirmation_retry_and_idempotency(store):
    w = store.workspaces
    i = w.invite('owner', 'adr', 'new@example.invalid', 'office')
    calls = []

    def failed(*args):
        raise TimeoutError('Do not leak provider credentials')

    result = w.deliver('owner', i['invitation_id'], failed)
    assert result['delivery_status'] == 'failed' and 'credentials' not in result['delivery_error']

    def send(invitation, company):
        calls.append(invitation['send_attempt'])
        return 'message-id'

    result = w.deliver('owner', i['invitation_id'], send)
    assert result['delivery_status'] == 'sent'
    w.deliver('owner', i['invitation_id'], send)
    assert len(calls) == 1
    fresh = w.invitation_action('owner', 'adr', i['invitation_id'], 'resend')
    w.deliver('owner', i['invitation_id'], send)
    assert len(calls) == 2 and calls[0] != calls[1]


@pytest.mark.parametrize('resend', [False, True])
def test_invitation_failure_logs_once_without_pii(store, capsys, resend):
    w = store.workspaces
    invitation = w.invite('owner', 'adr', 'private@example.invalid', 'office')
    if resend:
        w.invitation_action('owner', 'adr', invitation['invitation_id'], 'resend')

    def fail(*args):
        raise smtplib.SMTPAuthenticationError(535, b'private@example.invalid secret-password body')

    capsys.readouterr()
    result = w.deliver('owner', invitation['invitation_id'], fail)
    lines = capsys.readouterr().out.splitlines()
    assert result['delivery_status'] == 'failed'
    assert [json.loads(line) for line in lines] == [
        {
            'severity': 'ERROR',
            'message': 'Email send failed',
            'operation': 'email',
            'status': 'send_failed',
            'outcome': 'SMTPAuthenticationError',
        }
    ]
    w.deliver('owner', invitation['invitation_id'], lambda *args: 'message-id')
    assert not capsys.readouterr().out


def test_disabled_inviter_and_concurrent_owner_replacement(store):
    w = store.workspaces
    invite = w.invite('owner', 'adr', 'new@example.invalid', 'office')
    store.db.records['_memberships/owner']['status'] = 'disabled'
    with pytest.raises(AccessDenied):
        w.accept(identity('new'), invite['invitation_id'])
    a = w.invite('admin', 'adr', 'a@example.invalid', 'owner')
    b = w.invite('admin', 'adr', 'b@example.invalid', 'owner')
    w.accept(identity('a'), a['invitation_id'])
    assert w.principal('a')['role'] == 'owner'
    with pytest.raises(Conflict):
        w.accept(identity('b'), b['invitation_id'])


def test_disabling_member_cancels_their_pending_invitation(store):
    w = store.workspaces
    stale = w.invite('owner', 'adr', 'estimator@example.invalid', 'estimator')
    other = w.invite('owner', 'adr', 'new@example.invalid', 'office')
    w.update_member(
        'owner',
        'adr',
        'estimator',
        MemberUpdate(expected_version=1, role='estimator', status='disabled'),
    )
    with pytest.raises(Conflict):
        w.accept(identity('estimator'), stale['invitation_id'])
    assert store.db.records['_memberships/estimator']['status'] == 'disabled'
    assert store.db.records['_invitations/' + other['invitation_id']]['status'] == 'pending'
    fresh = w.invite('owner', 'adr', 'estimator@example.invalid', 'estimator')
    assert fresh['invitation_id'] != stale['invitation_id']
    w.accept(identity('estimator'), fresh['invitation_id'])
    assert w.principal('estimator')['role'] == 'estimator'


def test_owner_replacement_cancels_the_former_owners_pending_invitations(store):
    w = store.workspaces
    former = w.invite('admin', 'adr', 'owner@example.invalid', 'owner')
    staff = w.invite('owner', 'adr', 'new@example.invalid', 'office')
    replacement = w.invite('admin', 'adr', 'a@example.invalid', 'owner')
    w.accept(identity('a'), replacement['invitation_id'])
    assert store.db.records['_memberships/owner']['status'] == 'disabled'
    assert store.db.records['_invitations/' + former['invitation_id']]['status'] == 'cancelled'
    assert store.db.records['_invitations/' + staff['invitation_id']]['status'] == 'pending'


def test_disable_company_and_membership_rechecked_inside_write(store):
    store.create_inspection('estimator', ID, data())
    store.workspaces.update_member(
        'owner',
        'adr',
        'estimator',
        MemberUpdate(expected_version=1, role='office', status='active'),
    )
    with pytest.raises(AccessDenied):
        store.update_inspection('estimator', ID, 1, data('Changed'))
    store.workspaces.update_company(
        'admin', 'adr', StatusUpdate(expected_version=1, status='suspended')
    )
    with pytest.raises(AccessDenied):
        store.get_inspection('office', ID)
    assert store.workspaces.principal('owner')['superadmin']


def test_company_snapshot_pricing_profile_conflict_and_signed_evidence(api):
    client, current, store = api
    current['uid'] = 'estimator'
    record = client.post('/api/inspections', json={'inspection_id': ID, 'data': data()}).json()
    response = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
    assert response.status_code == 200, response.text
    record = response.json()
    documents = record['audit']['documents']
    assert (
        documents['xactimate_total'] == 1775
        and documents['adr_estimate']['proposed_cost'] == 1788.9
    )
    assert documents['company_identity']['company_id'] == 'adr'
    payload = dict(
        inspection_id=ID,
        expected_revision=1,
        auth_id='ADR-AUTH-test123456',
        proposal_hash=record['audit']['proposal_hash'],
        signature_png=png(),
        documents_confirmed=True,
    )
    assert client.post('/api/authorize', json=payload).status_code == 200
    current['uid'] = 'office'
    assert client.get('/api/authorizations/' + payload['auth_id']).json()['documents'] == documents
    assert (
        client.get('/api/authorizations/' + payload['auth_id'] + '/evidence/signature').status_code
        == 200
    )
    assert client.post('/api/authorize', json=payload).status_code == 403
    current['uid'] = 'other-owner'
    assert client.get('/api/authorizations/' + payload['auth_id']).status_code == 404
    assert (
        client.get('/api/authorizations/' + payload['auth_id'] + '/evidence/signature').status_code
        == 404
    )
    assert store.db.records['authorizations/' + payload['auth_id']]['documents'] == documents


def test_profile_changes_invalidate_unsigned_audit_and_not_signed_payload(store):
    record = store.create_inspection('estimator', ID, data())
    documents = make_documents(
        InspectionData.model_validate(record['data']),
        [],
        AIResult(summary='Test', suggestions=[], unpriced_work=[]),
        store.workspaces.snapshot('estimator'),
    )
    record = store.save_audit('estimator', ID, 1, documents)
    profile = deepcopy(ADR_PROFILE)
    profile['phone'] = 'new phone'
    store.workspaces.update_company(
        'owner', 'adr', ProfileUpdate(expected_version=1, profile=CompanyProfile(**profile))
    )
    payload = dict(
        inspection_id=ID,
        expected_revision=1,
        auth_id='ADR-AUTH-test123456',
        proposal_hash=record['audit']['proposal_hash'],
        signature_png=png(),
    )
    with pytest.raises(Conflict):
        store.authorize('estimator', payload)
    assert not store.bucket.objects


def test_other_company_has_no_adr_identity_or_trade_promise(store):
    identity = store.workspaces.snapshot('other-owner')
    documents = make_documents(
        InspectionData.model_validate({**data(), 'water_heater_loss': True}),
        [],
        AIResult(summary='Test', suggestions=[], unpriced_work=[]),
        identity,
    )
    assert 'Alert Disaster' not in documents['iicrc_defense_letter']
    assert 'Matthew Myers' not in documents['iicrc_defense_letter']
    assert documents['signable'] and not documents['company_setup_missing']
    proposal = documents['adr_estimate']
    assert 'Alert Disaster' not in str(proposal) and 'Can Do Crew' not in str(proposal)
    assert f'will NOT be the responsibility of {identity["name"]}.' in proposal['disclaimers'][-3]
    assert any(
        text.startswith(f'Per IICRC and EPA protocols, {identity["name"]} technicians')
        for text in proposal['recommendations']
    )


def test_migration_preview_idempotency_and_signed_payload_unchanged():
    original = FakeStore()
    original.create_inspection('legacy', ID, data())
    original.db.records['authorizations/ADR-AUTH-legacy123'] = dict(
        auth_id='ADR-AUTH-legacy123',
        owner_uid='legacy',
        created_at='2026',
        payload_sha256='immutable-hash',
        documents={'saved': 'unchanged'},
    )
    original.db.records['authorizations/ADR-AUTH-unmapped'] = dict(
        auth_id='ADR-AUTH-unmapped', owner_uid='unknown', created_at='2026'
    )
    before = deepcopy(original.db.records)
    secured = FakeCompanyStore(original.db, original.bucket)
    preview = migrate(
        secured.workspaces, {'legacy': 'legacy@example.invalid'}, 'legacy', 'Legacy Co'
    )
    assert preview['create'] == 6 and preview['unmapped_source_records'] == 1
    assert original.db.records == before
    report = migrate(
        secured.workspaces, {'legacy': 'legacy@example.invalid'}, 'legacy', 'Legacy Co', True
    )
    again = migrate(
        secured.workspaces, {'legacy': 'legacy@example.invalid'}, 'legacy', 'Legacy Co', True
    )
    assert report['create'] == 6 and again['create'] == 0
    # The migration seeds only the given name; the owner enters the rest in Company settings.
    # Delivery starts off, with no crew-lead email, and is not turned on for the migrated company.
    assert original.db.records['_companies/adr']['profile'] == dict(
        name='Legacy Co',
        address='',
        phone='',
        email='',
        license='',
        signoff='',
        logo_data_url='',
        crew_lead_email='',
        document_delivery=False,
    )
    for key, value in before.items():
        assert original.db.records[key] == value
    assert secured.get('legacy', 'ADR-AUTH-legacy123')['payload_sha256'] == 'immutable-hash'
    with pytest.raises(LookupError):
        secured.get('legacy', 'ADR-AUTH-unmapped')


@pytest.mark.parametrize('role', ['office', 'admin', 'other-owner'])
def test_live_denial_precedes_vertex(store, monkeypatch, role):
    from starlette.websockets import WebSocketDisconnect

    store.create_inspection('estimator', ID, data())

    async def verified(token, **_):
        return {**identity(role), 'exp': time.time() + 600}

    monkeypatch.setattr(bm, 'WORKSPACES_ENABLED', True)
    monkeypatch.setattr(bm, 'verify_staff', verified)
    monkeypatch.setattr(bm, 'get_job_store', lambda: store)

    def forbidden(**kwargs):
        pytest.fail('Unauthorized Live must not connect to Vertex')

    monkeypatch.setattr(bm.genai, 'Client', forbidden)
    with TestClient(bm.app) as client:
        with client.websocket_connect('/api/live', headers={'origin': bm.ORIGINS[0]}) as socket:
            socket.send_json(
                {
                    'type': 'authenticate',
                    'token': 'synthetic',
                    'inspection_id': ID,
                    'protocol_version': 2,
                    'capture_id': 'f' * 32,
                }
            )
            assert socket.receive_json()['type'] == 'error'
            with pytest.raises(WebSocketDisconnect):
                socket.receive_json()
    assert not any(k.startswith('_live_sessions/') for k in store.db.records)


@pytest.mark.parametrize('uid', ['owner', 'other-owner'])
@pytest.mark.parametrize('workspace_protocol', [None, 0, 2])
def test_live_requires_workspace_protocol_for_every_company(
    store, monkeypatch, uid, workspace_protocol
):
    from starlette.websockets import WebSocketDisconnect

    store.create_inspection(uid, ID, data())

    async def verified(token, **_):
        return {**identity(uid), 'exp': time.time() + 600}

    monkeypatch.setattr(bm, 'WORKSPACES_ENABLED', True)
    monkeypatch.setattr(bm, 'verify_staff', verified)
    monkeypatch.setattr(bm, 'get_job_store', lambda: store)

    def forbidden(**kwargs):
        pytest.fail('An outdated workspace client must not connect to Vertex')

    monkeypatch.setattr(bm.genai, 'Client', forbidden)
    auth = {
        'type': 'authenticate',
        'token': 'synthetic',
        'inspection_id': ID,
        'protocol_version': 2,
        'capture_id': 'f' * 32,
    }
    if workspace_protocol is not None:
        auth['workspace_protocol_version'] = workspace_protocol
    with TestClient(bm.app) as client:
        with client.websocket_connect('/api/live', headers={'origin': bm.ORIGINS[0]}) as socket:
            socket.send_json(auth)
            assert socket.receive_json() == {
                'type': 'error',
                'status': 409,
                'message': 'Update the app before a company walkthrough.',
            }
            with pytest.raises(WebSocketDisconnect):
                socket.receive_json()
    assert not any(k.startswith('_live_sessions/') for k in store.db.records)


def test_live_resume_fallback_keeps_company_identity(store, monkeypatch):
    from contextlib import asynccontextmanager
    from types import SimpleNamespace as NS
    from starlette.websockets import WebSocketDisconnect

    store.create_inspection('other-owner', OTHER, data())
    configs = []

    class Session:
        async def send_client_content(self, **kw):
            pass

        async def receive(self):
            yield NS(
                server_content=None,
                session_resumption_update=NS(new_handle='synthetic-private', resumable=True),
            )
            yield NS(server_content=None, go_away=NS(time_left=1))

    @asynccontextmanager
    async def connect(**kwargs):
        configs.append(kwargs['config'])
        if kwargs['config'].session_resumption.handle:
            raise RuntimeError('Synthetic expired provider handle')
        yield Session()

    async def close():
        pass

    async def verified(token, **_):
        return {**identity('other-owner'), 'exp': time.time() + 600}

    monkeypatch.setattr(bm, 'WORKSPACES_ENABLED', True)
    monkeypatch.setattr(bm, 'verify_staff', verified)
    monkeypatch.setattr(bm, 'get_job_store', lambda: store)
    monkeypatch.setattr(
        bm.genai, 'Client', lambda **kwargs: NS(aio=NS(live=NS(connect=connect), aclose=close))
    )

    def auth(resume):
        return {
            'type': 'authenticate',
            'token': 'synthetic',
            'inspection_id': OTHER,
            'protocol_version': 2,
            'workspace_protocol_version': 1,
            'capture_id': 'f' * 32,
            'resume': resume,
        }

    with TestClient(bm.app) as client:
        with client.websocket_connect('/api/live', headers={'origin': bm.ORIGINS[0]}) as socket:
            socket.send_json(auth(False))
            assert socket.receive_json()['recovery'] == 'new'
            assert socket.receive_json()['type'] == 'recovery'
            with pytest.raises(WebSocketDisconnect):
                socket.receive_json()
        assert store.db.records['_live_resume/other-owner']['handle'] == 'synthetic-private'
        with client.websocket_connect('/api/live', headers={'origin': bm.ORIGINS[0]}) as socket:
            socket.send_json(auth(True))
            response = socket.receive_json()
            assert response.get('recovery') == 'restarted', response
            assert socket.receive_json()['type'] == 'recovery'
            with pytest.raises(WebSocketDisconnect):
                socket.receive_json()
    assert len(configs) == 3 and configs[1].session_resumption.handle == 'synthetic-private'
    for config in configs:
        prompt = str(config.system_instruction)
        assert 'Other Company' in prompt and 'Alert Disaster Restoration' not in prompt
