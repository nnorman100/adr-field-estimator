"""Company policy is tested through real API handlers and transactional storage."""

import asyncio
import base64
import html
import json
import re
import logging
import smtplib
import socket
from copy import deepcopy
from types import SimpleNamespace
from concurrent.futures import ThreadPoolExecutor
import time
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
import backend.main as bm
import backend.workspaces as workspaces
from backend.claims import make_documents
from backend.contracts import InspectionData, AIResult
from backend.workspaces import (
    ADR_PROFILE,
    AccessDenied,
    CompanyCreate,
    MemberUpdate,
    ProfileUpdate,
    CompanyProfile,
    StatusUpdate,
    CoordinationUpdate,
)
from backend.inspection_store import Conflict, Limited
from backend.workspace_migration import migrate
from tests.fakes import FakeCompanyStore, FakeStore, png
from tests.test_voice_notes import note as voice_note

ID = 'ADR-INS-' + 'a' * 32
OTHER = 'ADR-INS-' + 'b' * 32
# Synthetic passwords, traced to show where they may and may not go.
TEMPORARY = 'synthetic-temporary-0001'
CHOSEN = 'synthetic-chosen-0002'


def seed(store):
    for company_id in ('adr', 'other'):
        profile = (
            {
                **ADR_PROFILE,
                'name': 'Other Company',
                'license': '123456',
                'signoff': 'Other Estimator',
                'water_heater_notice': '',
            }
            if company_id == 'other'
            else deepcopy(ADR_PROFILE)
        )
        store.db.records['_companies/' + company_id] = dict(
            company_id=company_id,
            profile=profile,
            version=1,
            status='active',
            owner_uid='owner' if company_id == 'adr' else 'other-owner',
            region='CA',
            created_at='2026',
            updated_at='2026',
        )
    for uid, role, cid in [
        ('owner', 'owner', 'adr'),
        ('estimator', 'estimator', 'adr'),
        ('estimator2', 'estimator', 'adr'),
        ('office', 'office', 'adr'),
        ('other-owner', 'owner', 'other'),
    ]:
        store.db.records['_memberships/' + uid] = dict(
            uid=uid,
            email=uid + '@example.invalid',
            company_id=cid,
            role=role,
            status='active',
            version=1,
            updated_at='2026',
        )
    store.db.records['_platform_admins/admin'] = {'active': True}
    store.db.records['_platform_admins/owner'] = {'active': True}
    return store


def data(address='Test property'):
    return InspectionData(
        address=address,
        year_built=2000,
        rooms=[dict(name='Bathroom', category=1, finished_sf=10)],
        air_movers=3,
        dehumidifiers=1,
        scope_confirmed=True,
    ).model_dump(mode='json')


def identity(uid):
    return dict(
        uid=uid,
        email=uid + '@example.invalid',
        email_verified=True,
        firebase={'sign_in_provider': 'google.com'},
    )


@pytest.fixture
def store():
    return seed(FakeCompanyStore())


@pytest.fixture
def api(store, monkeypatch):
    current = {'uid': 'owner'}
    monkeypatch.setattr(bm, 'WORKSPACES_ENABLED', True)
    monkeypatch.setattr(bm, 'get_job_store', lambda: store)
    for endpoint in (bm.current_staff, bm.current_identity, bm.account_identity):
        bm.app.dependency_overrides[endpoint] = lambda: identity(current['uid'])
    # Depends captured the original function before the module attribute was patched.
    for route in bm.app.routes:
        if hasattr(route, 'dependant'):
            for dep in route.dependant.dependencies:
                if getattr(dep.call, '__name__', '') == 'get_job_store':
                    bm.app.dependency_overrides[dep.call] = lambda: store

    async def generate(schema, *args, **kwargs):
        return AIResult(summary='Confirmed scope.', suggestions=[], unpriced_work=[])

    monkeypatch.setattr(bm, 'generate', generate)
    with TestClient(
        bm.app, headers={'X-ADR-Workspace-Protocol': '1', 'Authorization': 'Bearer synthetic'}
    ) as client:
        yield client, current, store
    bm.app.dependency_overrides.clear()


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


def seed_jobs(store, count, orphaned):
    """Signed company jobs whose inspection or authorization source is missing when orphaned(i)."""
    kept = {'inspections': set(), 'authorizations': set()}
    for i in range(count):
        stamp = f'2026-10-06T19:{i // 60:02}:{i % 60:02}Z'
        job_id = 'ADR-INS-' + f'{i:032x}'
        auth_id = f'ADR-AUTH-{i:06}'
        store.db.records['_workspace_jobs/' + job_id] = dict(
            job_id=job_id,
            company_id='adr',
            accessible_estimator_uids=['estimator'],
            kind='inspection',
            auth_exists=True,
            auth_id=auth_id,
            updated_at=stamp,
            signed_at=stamp,
        )
        store.db.records['_workspace_authorizations/' + auth_id] = dict(
            job_id=job_id, company_id='adr'
        )
        if orphaned(i):
            continue
        store.db.records['inspections/' + job_id] = dict(
            inspection_id=job_id, owner_uid='estimator', updated_at=stamp
        )
        store.db.records['authorizations/' + auth_id] = dict(
            auth_id=auth_id, owner_uid='estimator', created_at=stamp
        )
        kept['inspections'].add(job_id)
        kept['authorizations'].add(auth_id)
    return kept


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
    preview = migrate(secured.workspaces, {'legacy': 'legacy@example.invalid'}, 'legacy')
    assert preview['create'] == 6 and preview['unmapped_source_records'] == 1
    assert original.db.records == before
    report = migrate(secured.workspaces, {'legacy': 'legacy@example.invalid'}, 'legacy', True)
    again = migrate(secured.workspaces, {'legacy': 'legacy@example.invalid'}, 'legacy', True)
    assert report['create'] == 6 and again['create'] == 0
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


@pytest.mark.parametrize('change', ['role', 'company', 'assignment'])
def test_live_rechecks_workspace_permission_and_deletes_checkpoint(store, monkeypatch, change):
    from contextlib import asynccontextmanager
    from types import SimpleNamespace as NS
    from starlette.websockets import WebSocketDisconnect

    store.create_inspection('estimator', ID, data())
    store.workspaces.coordination(
        'owner', ID, CoordinationUpdate(expected_version=1, assigned_estimator_uid='estimator2')
    )
    closed = []

    async def verified(token, **_):
        return {**identity('estimator2'), 'exp': time.time() + 600}

    class Session:
        async def send_client_content(self, **kw):
            pass

        async def receive(self):
            yield NS(
                server_content=None,
                session_resumption_update=NS(new_handle='synthetic-private', resumable=True),
            )
            await asyncio.Event().wait()

    @asynccontextmanager
    async def connect(**kwargs):
        yield Session()

    async def close():
        await asyncio.sleep(0.02)
        closed.append(True)

    monkeypatch.setattr(bm, 'WORKSPACES_ENABLED', True)
    monkeypatch.setattr(bm, 'verify_staff', verified)
    monkeypatch.setattr(bm, 'get_job_store', lambda: store)
    monkeypatch.setattr(bm, 'LIVE_RECHECK_SECONDS', 0.02)
    monkeypatch.setattr(
        bm.genai, 'Client', lambda **kwargs: NS(aio=NS(live=NS(connect=connect), aclose=close))
    )
    with TestClient(bm.app) as client:
        with client.websocket_connect('/api/live', headers={'origin': bm.ORIGINS[0]}) as socket:
            socket.send_json(
                {
                    'type': 'authenticate',
                    'token': 'synthetic',
                    'inspection_id': ID,
                    'protocol_version': 2,
                    'workspace_protocol_version': 1,
                    'capture_id': 'f' * 32,
                }
            )
            assert socket.receive_json()['type'] == 'ready'
            if change == 'role':
                store.workspaces.update_member(
                    'owner',
                    'adr',
                    'estimator2',
                    MemberUpdate(expected_version=1, role='office', status='active'),
                )
            elif change == 'company':
                store.workspaces.update_company(
                    'admin', 'adr', StatusUpdate(expected_version=1, status='suspended')
                )
            else:
                store.workspaces.coordination('owner', ID, CoordinationUpdate(expected_version=2))
            assert socket.receive_json()['type'] == 'error'
            with pytest.raises(WebSocketDisconnect):
                socket.receive_json()
    assert (
        closed
        and '_live_resume/estimator2' not in store.db.records
        and '_live_sessions/estimator2' not in store.db.records
    )


def test_permission_change_during_ai_prevents_commit(api, monkeypatch):
    client, current, store = api
    store.create_inspection('estimator', ID, data())
    current['uid'] = 'estimator'

    async def revoked(*args, **kwargs):
        store.workspaces.update_member(
            'owner',
            'adr',
            'estimator',
            MemberUpdate(expected_version=1, role='office', status='active'),
        )
        return AIResult(summary='Test', suggestions=[], unpriced_work=[])

    monkeypatch.setattr(bm, 'generate', revoked)
    response = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
    assert response.status_code == 403 and store.get_inspection('owner', ID)['audit'] is None


def test_firestore_transactions_finish_all_reads_before_writes(monkeypatch):
    from tests.fakes import Collection, Ref, Tx

    original_get = Ref.get

    def get(ref, transaction=None):
        assert not transaction or not getattr(transaction, 'written', False), (
            'Firestore forbids reads after transaction writes'
        )
        return original_get(ref, transaction)

    class StrictTx(Tx):
        written = False

        def set(self, *args, **kwargs):
            self.written = True
            return super().set(*args, **kwargs)

        def create(self, *args, **kwargs):
            self.written = True
            return super().create(*args, **kwargs)

        def update(self, *args, **kwargs):
            self.written = True
            return super().update(*args, **kwargs)

    class StrictStore(FakeCompanyStore):
        def _atomic(self, callback):
            with self.db.lock:
                return callback(StrictTx())

    monkeypatch.setattr(Ref, 'get', get)
    store = seed(StrictStore())
    w = store.workspaces
    store.create_inspection('estimator', ID, data())
    w.coordination(
        'owner', ID, CoordinationUpdate(expected_version=1, assigned_estimator_uid='estimator2')
    )
    invitation = w.invite('owner', 'adr', 'new@example.invalid', 'office')
    w.deliver('owner', invitation['invitation_id'], lambda *args: 'message')
    w.accept(identity('new'), invitation['invitation_id'])
    record = store.get_inspection('estimator', ID)
    docs = make_documents(
        InspectionData.model_validate(record['data']),
        [],
        AIResult(summary='Test', suggestions=[], unpriced_work=[]),
        w.snapshot('estimator'),
    )
    record = store.save_audit('estimator', ID, record['revision'], docs)
    store.authorize(
        'estimator',
        dict(
            inspection_id=ID,
            expected_revision=record['revision'],
            auth_id='ADR-AUTH-strict123',
            proposal_hash=record['audit']['proposal_hash'],
            signature_png=png(),
        ),
    )
    original_stream = Collection.stream

    def stream(collection, transaction=None):
        assert not transaction or not getattr(transaction, 'written', False), (
            'Firestore forbids reads after transaction writes'
        )
        return original_stream(collection, transaction)

    monkeypatch.setattr(Collection, 'stream', stream)
    w.invite('admin', 'adr', 'owner@example.invalid', 'owner')
    w.invite('owner', 'adr', 'new@example.invalid', 'office')
    w.update_member(
        'owner', 'adr', 'new', MemberUpdate(expected_version=1, role='office', status='disabled')
    )
    w.accept(identity('a'), w.invite('admin', 'adr', 'a@example.invalid', 'owner')['invitation_id'])
    assert store.db.records['_memberships/owner']['status'] == 'disabled'
    # Superadmin support reads and fixes share the same read-then-write transactions.
    staff = w.invite('a', 'adr', 'staff@example.invalid', 'estimator')
    w.invitation_action('admin', 'adr', staff['invitation_id'], 'resend')
    w.update_member(
        'admin', 'adr', 'new', MemberUpdate(expected_version=2, role='office', status='active')
    )
    assert w.team('admin', 'adr') and store.support_inspection('admin', 'adr', ID)
    assert store.support_evidence('admin', 'adr', 'ADR-AUTH-strict123', 'signature')


def test_competing_invitation_acceptance_has_one_owner(store):
    w = store.workspaces
    a = w.invite('admin', 'adr', 'a@example.invalid', 'owner')
    b = w.invite('admin', 'adr', 'b@example.invalid', 'owner')

    def accept(invitation, name):
        try:
            w.accept(identity(name), invitation['invitation_id'])
            return True
        except Conflict:
            return False

    with ThreadPoolExecutor(2) as pool:
        futures = [pool.submit(accept, a, 'a'), pool.submit(accept, b, 'b')]
        assert sum(f.result() for f in futures) == 1
    assert (
        sum(
            m['role'] == 'owner' and m['status'] == 'active'
            for k, m in store.db.records.items()
            if k.startswith('_memberships/') and m['company_id'] == 'adr'
        )
        == 1
    )


def test_migration_refreshes_old_writer_summaries_and_preserves_assignments():
    legacy = FakeStore()
    legacy.create_inspection('legacy', ID, data())
    secured = FakeCompanyStore(legacy.db, legacy.bucket)
    w = secured.workspaces
    migrate(w, {'legacy': 'legacy@example.invalid'}, 'legacy', True)
    job = secured.db.records['_workspace_jobs/' + ID]
    job['office_notes'] = 'Keep coordination'
    job['assigned_estimator_uid'] = 'assigned'
    legacy.update_inspection('legacy', ID, 1, data('Changed by old production writer'))
    migrate(w, {'legacy': 'legacy@example.invalid'}, 'legacy', True)
    job = secured.db.records['_workspace_jobs/' + ID]
    assert (
        job['address'] == 'Changed by old production writer'
        and job['office_notes'] == 'Keep coordination'
        and job['assigned_estimator_uid'] == 'assigned'
    )
    secured.create_inspection('legacy', OTHER, data('New company-aware job'))
    assert migrate(w, {'legacy': 'legacy@example.invalid'}, 'legacy', True)['create'] == 0


def test_company_documents_require_a_client_that_renders_saved_identity(api):
    client, current, store = api
    store.create_inspection('estimator', ID, data())
    current['uid'] = 'estimator'
    client.headers.pop('X-ADR-Workspace-Protocol')
    assert (
        client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1}).status_code
        == 409
    )
    client.headers['X-ADR-Workspace-Protocol'] = '1'
    record = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1}).json()
    client.headers.pop('X-ADR-Workspace-Protocol')
    assert client.get('/api/inspections/' + ID).status_code == 409
    assert client.post('/api/authorize', json={}).status_code == 409


def test_memberships_override_static_allowlist_and_token_role_claims(store, monkeypatch):
    from fastapi import HTTPException

    monkeypatch.setattr(bm, 'WORKSPACES_ENABLED', True)
    monkeypatch.setattr(bm, 'get_job_store', lambda: store)
    monkeypatch.setattr(bm.firebase_admin, 'get_app', lambda name: object())
    claims = {
        **identity('unknown'),
        'email': 'nathanaelcnorman@gmail.com',
        'role': 'owner',
        'superadmin': True,
    }

    def verified(token, **kwargs):
        assert kwargs['check_revoked'] is True
        return claims

    monkeypatch.setattr(bm.firebase_auth, 'verify_id_token', verified)
    with pytest.raises(HTTPException) as error:
        asyncio.run(bm.verify_staff('normal-client-token'))
    assert error.value.status_code == 403
    claims.update(identity('office'))
    assert asyncio.run(bm.verify_staff('normal-client-token'))['uid'] == 'office'
    store.db.records['_memberships/office']['status'] = 'disabled'
    with pytest.raises(HTTPException) as error:
        asyncio.run(bm.verify_staff('normal-client-token'))
    assert error.value.status_code == 403


def verify_with(monkeypatch, enabled, changes):
    monkeypatch.setattr(bm, 'WORKSPACES_ENABLED', enabled)
    monkeypatch.setattr(bm.firebase_admin, 'get_app', lambda name: object())
    monkeypatch.setattr(
        bm.firebase_auth,
        'verify_id_token',
        lambda *args, **kwargs: {**identity('owner'), **changes},
    )
    return asyncio.run(bm.verify_identity('normal-client-token'))


@pytest.mark.parametrize('provider', ['google.com', 'password'])
def test_workspace_identity_accepts_verified_google_and_password(monkeypatch, provider):
    assert (
        verify_with(monkeypatch, True, {'firebase': {'sign_in_provider': provider}})['uid']
        == 'owner'
    )


@pytest.mark.parametrize(
    'changes',
    [
        {'email_verified': False},
        {'email_verified': False, 'firebase': {'sign_in_provider': 'password'}},
        {'firebase': {'sign_in_provider': 'anonymous'}},
        {'firebase': {'sign_in_provider': 'custom'}},
        {'firebase': {}},
        {'email': ''},
    ],
)
def test_workspace_identity_rejects_unverified_or_unknown_provider(monkeypatch, changes):
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as error:
        verify_with(monkeypatch, True, changes)
    assert error.value.status_code == 403


@pytest.mark.parametrize('provider', ['google.com', 'password', 'anonymous', None])
def test_legacy_identity_ignores_provider_and_requires_verified_allowlisted_email(
    monkeypatch, provider
):
    from fastapi import HTTPException

    firebase = {'sign_in_provider': provider} if provider else {}
    assert verify_with(monkeypatch, False, {'firebase': firebase})['uid'] == 'owner'
    with pytest.raises(HTTPException) as error:
        verify_with(monkeypatch, False, {'firebase': firebase, 'email_verified': False})
    assert error.value.status_code == 403
    monkeypatch.setattr(bm, 'STAFF_EMAILS', {'staff@example.invalid'})
    with pytest.raises(HTTPException) as error:
        asyncio.run(bm.verify_staff('normal-client-token'))
    assert error.value.status_code == 403
    bm.firebase_auth.verify_id_token = lambda *args, **kwargs: {
        **identity('staff'),
        'firebase': firebase,
    }
    assert asyncio.run(bm.verify_staff('normal-client-token'))['email'] == 'staff@example.invalid'


def test_password_identity_accepts_only_its_exact_email_invitation(store):
    w = store.workspaces
    password = lambda uid: {**identity(uid), 'firebase': {'sign_in_provider': 'password'}}
    mine = w.invite('owner', 'adr', 'new@example.invalid', 'estimator')
    theirs = w.invite('owner', 'adr', 'someone@example.invalid', 'office')
    with pytest.raises(LookupError):
        w.accept(password('new'), theirs['invitation_id'])
    with pytest.raises(AccessDenied):
        w.accept({**password('new'), 'email_verified': False}, mine['invitation_id'])
    assert not w.principal('new')['role']
    assert w.accept(password('new'), mine['invitation_id'])['role'] == 'estimator'
    assert store.db.records['_invitations/' + theirs['invitation_id']]['status'] == 'pending'


@pytest.mark.parametrize(
    'name',
    [
        'Alert Disaster Restoration',
        'Other Company',
        "O'Brien & Sons (Kern) Co., Inc.",
        'Restauración Núñez 2',
        'A' * 80,
    ],
)
def test_company_names_accept_business_text(name):
    assert (
        CompanyProfile(name=name).name == name
        and CompanyCreate(name=name, owner_email='x@example.invalid').name == name
    )


@pytest.mark.parametrize(
    'name',
    [
        'Visit https://evil.example',
        'Go to WWW.evil.example',
        'Line\nBreak',
        'A' * 81,
        'Win $500 now!',
        '<b>Owner</b>',
        'Pay@once',
    ],
)
def test_company_names_reject_links_markup_and_long_text(api, name):
    with pytest.raises(ValidationError):
        CompanyProfile(name=name)
    with pytest.raises(ValidationError):
        CompanyCreate(name=name, owner_email='x@example.invalid')
    client, current, store = api
    response = client.put(
        '/api/companies/adr', json={'expected_version': 1, 'profile': {**ADR_PROFILE, 'name': name}}
    )
    assert response.status_code == 422 and 'Company name' in response.text
    assert store.db.records['_companies/adr']['profile']['name'] == 'Alert Disaster Restoration'


def test_company_settings_change_regenerates_documents_on_the_same_revision(api, monkeypatch):
    client, current, store = api
    calls = []

    async def generate(schema, *args, **kwargs):
        calls.append(schema)
        return AIResult(summary='Confirmed scope.', suggestions=[], unpriced_work=[])

    monkeypatch.setattr(bm, 'generate', generate)
    store.create_inspection('estimator', ID, data())
    current['uid'] = 'estimator'
    audit = lambda: client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
    assert audit().status_code == 200 and audit().status_code == 200 and len(calls) == 1
    current['uid'] = 'owner'
    profile = {**ADR_PROFILE, 'signoff': 'Synthetic Estimator'}
    response = client.put('/api/companies/adr', json={'expected_version': 1, 'profile': profile})
    assert response.status_code == 200, response.text
    current['uid'] = 'estimator'
    identity = audit().json()['audit']['documents']['company_identity']
    assert identity['signoff'] == 'Synthetic Estimator' and identity['version'] == 2
    assert len(calls) == 2


def test_older_profile_with_retired_heater_notice_still_saves(api):
    client, current, store = api
    profile = {**ADR_PROFILE, 'water_heater_notice': 'Retired coordination wording.'}
    response = client.put('/api/companies/adr', json={'expected_version': 1, 'profile': profile})
    assert response.status_code == 200, response.text
    assert 'water_heater_notice' not in store.db.records['_companies/adr']['profile']
    store.db.records['_companies/adr']['profile']['water_heater_notice'] = 'Retired wording.'
    assert 'water_heater_notice' not in store.workspaces.snapshot('owner')


def test_invitation_subject_names_the_company(mail):
    sent = mail[4]
    invite = dict(
        invitation_id='a' * 32, send_attempt='b' * 32, email='new@example.invalid', role='office'
    )
    workspaces.send_invitation(invite, {'profile': {'name': 'Owner Chosen Name'}})
    assert sent[0]['subject'] == 'Invitation to join Owner Chosen Name on DryScope'
    assert 'Owner Chosen Name' in sent[0]['text']


def test_invitation_sends_and_resends_have_a_daily_company_cap(api, monkeypatch):
    client, current, store = api
    w = store.workspaces
    monkeypatch.setattr(workspaces, 'INVITATION_DAILY_LIMIT', 3)
    first = w.invite('owner', 'adr', 'one@example.invalid', 'office')
    assert w.invite('owner', 'adr', 'one@example.invalid', 'office') == first
    w.invite('owner', 'adr', 'two@example.invalid', 'office')
    w.invitation_action('owner', 'adr', first['invitation_id'], 'resend')
    with pytest.raises(Limited) as limited:
        w.invite('owner', 'adr', 'three@example.invalid', 'office')
    assert 86000 < limited.value.retry_after <= 86400
    with pytest.raises(Limited):
        w.invitation_action('owner', 'adr', first['invitation_id'], 'resend')
    w.invite('other-owner', 'other', 'three@example.invalid', 'office')
    response = client.post(
        '/api/companies/adr/invitations', json={'email': 'four@example.invalid', 'role': 'office'}
    )
    assert response.status_code == 429 and int(response.headers['Retry-After']) > 86000
    assert not [
        r
        for r in store.db.records.values()
        if r.get('email') in ('three@example.invalid', 'four@example.invalid')
        and r.get('company_id') == 'adr'
    ]


@pytest.fixture
def mail(api, monkeypatch):
    """Real send_invitation against fake Resend and fake Firebase Admin; records every Firestore write."""
    from tests import fakes

    sent = []
    writes = []
    accounts = fakes.FakeAuth()

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self, size):
            return b'{"id":"message"}'

    monkeypatch.setenv('RESEND_API_KEY', 'test-key')
    monkeypatch.setenv('INVITATION_FROM', 'ADR <invite@example.invalid>')
    monkeypatch.setattr(
        workspaces.urllib.request,
        'urlopen',
        lambda request, timeout: sent.append(json.loads(request.data)) or Response(),
    )
    monkeypatch.setattr(workspaces, 'firebase_auth', accounts)
    monkeypatch.setattr(workspaces.firebase_admin, 'get_app', lambda name: object())
    for cls, name in ((fakes.Tx, 'set'), (fakes.Ref, 'create')):

        def logged(self, *args, _original=getattr(cls, name), **kwargs):
            writes.append(json.dumps(args, default=str))
            return _original(self, *args, **kwargs)

        monkeypatch.setattr(cls, name, logged)
    client, current, store = api
    return client, current, store, accounts, sent, writes


def test_invitation_provisions_a_password_account_and_mails_only_its_set_password_link(mail):
    client, current, store, accounts, sent, writes = mail
    invited = client.post(
        '/api/companies/adr/invitations', json={'email': 'New@Example.invalid', 'role': 'office'}
    ).json()
    assert invited['delivery_status'] == 'sent'
    assert accounts.created == [{'email': 'new@example.invalid', 'email_verified': False}]
    assert [(l['email'], l['url'], l['in_app']) for l in accounts.links] == [
        ('new@example.invalid', 'https://alert-disaster-field-2026.web.app/', False)
    ]
    link = accounts.links[0]['link']
    assert 'Set your password for DryScope: ' + link in sent[0]['text']
    assert html.escape(link) in sent[0]['html'] and link not in sent[0]['html']
    assert '?invite=' + invited['invitation_id'] in sent[0]['text']
    assert writes and not any('secret-oob' in w for w in writes)
    assert 'secret-oob' not in json.dumps(
        store.db.records, default=str
    ) and 'secret-oob' not in json.dumps(invited)


def test_owner_invitation_for_a_new_company_provisions_the_owner_account(mail):
    client, current, store, accounts, sent, writes = mail
    current['uid'] = 'admin'
    result = client.post(
        '/api/admin/companies',
        json={'name': 'New California Restoration', 'owner_email': 'boss@example.invalid'},
    ).json()
    assert result['invitation']['delivery_status'] == 'sent'
    assert accounts.created == [{'email': 'boss@example.invalid', 'email_verified': False}]
    assert accounts.links[0]['link'] in sent[0]['text'] and not any(
        'secret-oob' in w for w in writes
    )


def test_google_invitee_gets_sign_in_instructions_without_link_or_new_account(mail):
    client, current, store, accounts, sent, writes = mail
    accounts.add('google@example.invalid', 'google.com')
    assert (
        client.post(
            '/api/companies/adr/invitations',
            json={'email': 'google@example.invalid', 'role': 'office'},
        ).json()['delivery_status']
        == 'sent'
    )
    assert not accounts.created and not accounts.links
    assert (
        'Sign in with Google using this email' in sent[0]['text']
        and 'Set your password' not in sent[0]['text'] + sent[0]['html']
    )


def test_resend_reuses_the_existing_password_account_with_a_fresh_link(mail):
    client, current, store, accounts, sent, writes = mail
    accounts.add('staff@example.invalid', 'password')
    invited = client.post(
        '/api/companies/adr/invitations', json={'email': 'staff@example.invalid', 'role': 'office'}
    ).json()
    resent = client.post(
        '/api/companies/adr/invitations/' + invited['invitation_id'] + '/resend', json={}
    ).json()
    assert resent['delivery_status'] == 'sent' and not accounts.created
    assert [l['email'] for l in accounts.links] == ['staff@example.invalid'] * 2
    assert [accounts.links[i]['link'] in sent[i]['text'] for i in (0, 1)] == [True, True]
    assert not any('secret-oob' in w for w in writes)


def test_concurrent_account_creation_falls_back_to_the_existing_account(mail, monkeypatch):
    client, current, store, accounts, sent, writes = mail

    def created_elsewhere(email, email_verified, app=None):
        accounts.add(email, 'password')
        raise accounts.EmailAlreadyExistsError('exists', None, None)

    monkeypatch.setattr(accounts, 'create_user', created_elsewhere)
    assert (
        client.post(
            '/api/companies/adr/invitations',
            json={'email': 'race@example.invalid', 'role': 'office'},
        ).json()['delivery_status']
        == 'sent'
    )
    assert (
        accounts.links[0]['email'] == 'race@example.invalid'
        and accounts.links[0]['link'] in sent[0]['text']
    )


def test_denied_or_rate_limited_invitations_create_no_account_and_send_nothing(mail, monkeypatch):
    client, current, store, accounts, sent, writes = mail
    monkeypatch.setattr(workspaces, 'INVITATION_DAILY_LIMIT', 1)
    assert (
        client.post(
            '/api/companies/adr/invitations',
            json={'email': 'one@example.invalid', 'role': 'office'},
        ).status_code
        == 200
    )
    accounts.created.clear()
    accounts.links.clear()
    sent.clear()
    assert (
        client.post(
            '/api/companies/adr/invitations',
            json={'email': 'two@example.invalid', 'role': 'office'},
        ).status_code
        == 429
    )
    current['uid'] = 'office'
    assert (
        client.post(
            '/api/companies/adr/invitations',
            json={'email': 'three@example.invalid', 'role': 'office'},
        ).status_code
        == 403
    )
    assert (
        not accounts.created
        and not accounts.links
        and not sent
        and set(accounts.users) == {'one@example.invalid'}
    )


@pytest.mark.parametrize('uid', ['estimator2', 'admin', 'other-owner'])
def test_signed_job_records_evidence_and_coordination_stay_scoped(api, uid):
    client, current, store = api
    current['uid'] = 'estimator'
    assert (
        client.post('/api/inspections', json={'inspection_id': ID, 'data': data()}).status_code
        == 200
    )
    record = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1}).json()
    payload = dict(
        inspection_id=ID,
        expected_revision=1,
        auth_id='ADR-AUTH-scoped123456',
        proposal_hash=record['audit']['proposal_hash'],
        signature_png=png(),
        documents_confirmed=True,
    )
    assert client.post('/api/authorize', json=payload).status_code == 200
    current['uid'] = uid
    responses = [
        client.get('/api/authorizations/' + payload['auth_id']),
        client.get('/api/authorizations/' + payload['auth_id'] + '/evidence/signature'),
        client.get('/api/inspections/' + ID),
        client.get('/api/jobs/' + ID + '/coordination'),
    ]
    assert all(r.status_code in (403, 404) for r in responses), [
        (r.status_code, r.text) for r in responses
    ]
    assert payload['auth_id'] not in json.dumps(client.get('/api/authorizations').json())


def coordinate_customer(client, current, name):
    current['uid'] = 'office'
    job = client.get('/api/jobs/' + ID + '/coordination').json()
    request = {'expected_version': job['version'], 'customer_name': name}
    assert client.put('/api/jobs/' + ID + '/coordination', json=request).status_code == 200
    current['uid'] = 'estimator'


def test_documents_name_the_coordinated_customer_and_a_new_name_needs_new_documents(api):
    client, current, store = api
    current['uid'] = 'estimator'
    assert (
        client.post('/api/inspections', json={'inspection_id': ID, 'data': data()}).status_code
        == 200
    )
    unnamed = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1}).json()
    assert unnamed['audit']['documents']['adr_estimate']['customer_name'] == ''
    assert 'Customer:' not in unnamed['audit']['documents']['iicrc_defense_letter']
    coordinate_customer(client, current, '  Synthetic Homeowner  ')
    cleared = client.get('/api/inspections/' + ID).json()
    assert cleared['audit'] is None and cleared['status'] == 'draft' and cleared['revision'] == 1
    named = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1}).json()
    documents = named['audit']['documents']
    assert documents['adr_estimate']['customer_name'] == 'Synthetic Homeowner'
    assert (
        'RE: Remediation scope for Test property\nCustomer: Synthetic Homeowner'
        in documents['iicrc_defense_letter']
    )
    # Phone, email and notes are not on the documents, so they keep the audit.
    current['uid'] = 'office'
    job = client.get('/api/jobs/' + ID + '/coordination').json()
    request = {
        'expected_version': job['version'],
        'customer_name': 'Synthetic Homeowner',
        'customer_phone': '555-0100',
    }
    assert client.put('/api/jobs/' + ID + '/coordination', json=request).status_code == 200
    current['uid'] = 'estimator'
    assert client.get('/api/inspections/' + ID).json()['audit'] == named['audit']
    # A name saved while the audit was running no longer matches the documents.
    store.db.records['_workspace_jobs/' + ID]['customer_name'] = 'Renamed Mid-Audit'
    payload = dict(
        inspection_id=ID,
        expected_revision=1,
        auth_id='ADR-AUTH-customer123456',
        proposal_hash=named['audit']['proposal_hash'],
        signature_png=png(),
        documents_confirmed=True,
    )
    response = client.post('/api/authorize', json=payload)
    assert response.status_code == 409
    assert response.json()['detail'] == (
        'Customer details changed. Generate new documents before signing.'
    )
    store.db.records['_workspace_jobs/' + ID]['customer_name'] = 'Synthetic Homeowner'
    assert client.post('/api/authorize', json=payload).status_code == 200
    signed = store.db.records['authorizations/' + payload['auth_id']]
    assert signed['documents']['adr_estimate']['customer_name'] == 'Synthetic Homeowner'
    # The signed agreement keeps the name it was signed with.
    coordinate_customer(client, current, 'Later Name')
    assert store.db.records['authorizations/' + payload['auth_id']]['documents'] == documents


def test_documents_audited_before_customer_names_still_sign(api):
    client, current, store = api
    current['uid'] = 'estimator'
    assert (
        client.post('/api/inspections', json={'inspection_id': ID, 'data': data()}).status_code
        == 200
    )
    record = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1}).json()
    del store.db.records['inspections/' + ID]['audit']['documents']['adr_estimate']['customer_name']
    store.db.records['_workspace_jobs/' + ID]['customer_name'] = 'Named Later'
    payload = dict(
        inspection_id=ID,
        expected_revision=1,
        auth_id='ADR-AUTH-legacy1234567',
        proposal_hash=record['audit']['proposal_hash'],
        signature_png=png(),
        documents_confirmed=True,
    )
    assert client.post('/api/authorize', json=payload).status_code == 200


def test_signed_job_address_cannot_change_through_coordination(api):
    client, current, store = api
    current['uid'] = 'estimator'
    assert (
        client.post('/api/inspections', json={'inspection_id': ID, 'data': data()}).status_code
        == 200
    )
    record = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1}).json()
    payload = dict(
        inspection_id=ID,
        expected_revision=1,
        auth_id='ADR-AUTH-address123456',
        proposal_hash=record['audit']['proposal_hash'],
        signature_png=png(),
        documents_confirmed=True,
    )
    assert client.post('/api/authorize', json=payload).status_code == 200
    current['uid'] = 'office'
    job = client.get('/api/jobs/' + ID + '/coordination').json()
    request = {
        'expected_version': job['version'],
        'customer_name': 'Test',
        'assigned_estimator_uid': 'estimator',
        'address': 'Changed after signing',
    }
    assert client.put('/api/jobs/' + ID + '/coordination', json=request).status_code == 409
    assert (
        store.db.records['authorizations/' + payload['auth_id']]['documents']
        == record['audit']['documents']
    )


@pytest.fixture
def smtp(mail, monkeypatch):
    """Real send_invitation over the SMTP transport against a fake SMTP server; never a real account."""
    client, current, store, accounts, sent, writes = mail
    monkeypatch.setenv('INVITATION_TRANSPORT', 'smtp')
    monkeypatch.setenv('INVITATION_SMTP_USERNAME', 'sender@example.invalid')
    monkeypatch.setenv('INVITATION_SMTP_PASSWORD', 'placeholder-app-password')
    connections, plan, sleeps = [], [], []

    class FakeSMTP:
        def __init__(self, host, port, timeout):
            self.steps = []
            self.failure = plan.pop(0) if plan else None
            connections.append(dict(host=host, port=port, timeout=timeout, server=self))
            self.fail('connect')

        def fail(self, stage):
            self.steps.append(stage)
            if self.failure and self.failure[0] == stage:
                raise self.failure[1]

        def starttls(self, context):
            self.context = context
            self.fail('starttls')

        def login(self, username, password):
            self.credentials = (username, password)
            self.fail('login')

        def send_message(self, message):
            self.message = message
            self.fail('send')

        def close(self):
            self.steps.append('close')

    monkeypatch.setattr(workspaces.smtplib, 'SMTP', FakeSMTP)
    monkeypatch.setattr(workspaces.time, 'sleep', sleeps.append)
    return client, store, accounts, sent, writes, connections, plan, sleeps


def direct_invite():
    return dict(
        invitation_id='a' * 32, send_attempt='b' * 32, email='new@example.invalid', role='office'
    )


def message_parts(message):
    """The text and HTML bodies, in order, wherever the inline logo nests them."""
    return [part.get_content() for part in message.walk() if part.get_content_maintype() == 'text']


@pytest.mark.parametrize(
    'transport, provider',
    [(None, 'resend'), ('', 'resend'), ('resend', 'resend'), ('smtp', 'smtp')],
)
def test_invitation_transport_is_selected_by_configuration(smtp, monkeypatch, transport, provider):
    client, store, accounts, sent, writes, connections, plan, sleeps = smtp
    if transport is None:
        monkeypatch.delenv('INVITATION_TRANSPORT')
    else:
        monkeypatch.setenv('INVITATION_TRANSPORT', transport)
    invited = client.post(
        '/api/companies/adr/invitations', json={'email': 'new@example.invalid', 'role': 'office'}
    ).json()
    assert invited['delivery_status'] == 'sent'
    assert (len(sent), len(connections)) == ((1, 0) if provider == 'resend' else (0, 1))


@pytest.mark.parametrize('transport', ['carrier-pigeon', 'SMTP', ' smtp ', 'Resend'])
def test_unknown_invitation_transport_is_not_configured_and_provisions_nothing(
    smtp, monkeypatch, transport
):
    client, store, accounts, sent, writes, connections, plan, sleeps = smtp
    monkeypatch.setenv('INVITATION_TRANSPORT', transport)
    with pytest.raises(RuntimeError, match='not configured'):
        workspaces.send_invitation(direct_invite(), {'profile': {'name': 'Owner Chosen Name'}})
    invited = client.post(
        '/api/companies/adr/invitations', json={'email': 'new@example.invalid', 'role': 'office'}
    ).json()
    assert invited['delivery_status'] == 'failed'
    assert not accounts.created and not accounts.links and not sent and not connections


def test_smtp_sends_the_resend_message_over_starttls_with_a_stable_message_id(smtp, monkeypatch):
    client, store, accounts, sent, writes, connections, plan, sleeps = smtp
    monkeypatch.setattr(
        workspaces, 'password_setup_link', lambda email: 'https://example.invalid/set'
    )
    company = {'profile': {'name': 'Owner Chosen Name'}}
    message_id = workspaces.send_invitation(direct_invite(), company)
    monkeypatch.setenv('INVITATION_TRANSPORT', 'resend')
    workspaces.send_invitation(direct_invite(), company)
    (connection,) = connections
    server = connection['server']
    assert (connection['host'], connection['port'], connection['timeout']) == (
        'smtp.gmail.com',
        587,
        8,
    )
    assert server.steps == ['connect', 'starttls', 'login', 'send', 'close']
    assert server.credentials == ('sender@example.invalid', 'placeholder-app-password')
    message = server.message
    assert (
        message_id == message['Message-ID'] == f'<invitation-{"a" * 32}-{"b" * 32}@example.invalid>'
    )
    assert (message['From'], message['To'], message['Subject']) == (
        sent[0]['from'],
        'new@example.invalid',
        sent[0]['subject'],
    )
    assert message_parts(message) == [sent[0]['text'] + '\n', sent[0]['html'] + '\n']


def branded(role='office', name='Kern Water Pros', logo=''):
    invite = {**direct_invite(), 'role': role}
    return invite, {'profile': {'name': name, 'logo_data_url': logo}}


def test_invitation_email_shows_the_company_logo_inline_and_explains_the_app():
    logo = workspaces.clean_logo(png())
    invite, company = branded(logo=logo)
    message = workspaces.invitation_email(invite, company, 'https://example.invalid/set?a=1&b=2')
    assert message['logo']['data'] == base64.b64decode(logo.partition(',')[2])
    assert message['logo']['subtype'] == 'jpeg' and message['logo']['data'] != workspaces.ADR_LOGO
    page, text = message['html'], message['text']
    assert page.count('src="cid:invitation-logo@dryscope"') == 1
    assert 'data:' not in page and 'src="http' not in page
    for body in (page, text):
        assert (
            'Kern Water Pros has invited you to join their team on DryScope as office staff.'
            in body
        )
        assert 'water and mold loss inspections, estimates and homeowner signatures' in body
        assert 'Sent by Kern Water Pros through DryScope.' in body
        assert 'This invitation expires in seven days.' in body
    assert 'If you weren&#x27;t expecting this, you can ignore this email.' in page
    assert "If you weren't expecting this, you can ignore this email." in text
    assert 'cid:' not in text and '<' not in text


def test_invitation_email_falls_back_to_the_dryscope_logo():
    with open('public/brand/adr-logo.jpg', 'rb') as public:
        assert workspaces.ADR_LOGO == public.read()
    oversized = 'data:image/jpeg;base64,' + base64.b64encode(b'x' * 100001).decode()
    for logo in [
        '',
        'data:image/png;base64,bm90IGFuIGltYWdl',
        oversized,
        'https://example.invalid/a.png',
    ]:
        message = workspaces.invitation_email(*branded(logo=logo), None)
        assert message['logo'] == dict(
            data=workspaces.DRYSCOPE_LOGO, subtype='png', width=200, height=58
        )
        assert 'width="200" height="58"' in message['html']
    legacy = {'profile': {'name': 'Company'}}
    assert (
        workspaces.invitation_email(direct_invite(), legacy, None)['logo']['data']
        == workspaces.DRYSCOPE_LOGO
    )
    # ADR alone keeps its bundled logo until its profile stores one.
    invite, adr = branded(name='Alert Disaster Restoration')
    message = workspaces.invitation_email(invite, {**adr, 'company_id': 'adr'}, None)
    assert message['logo'] == dict(data=workspaces.ADR_LOGO, subtype='jpeg', width=131, height=64)


def test_invitation_email_escapes_a_hostile_company_name():
    hostile = '<img src=x onerror=alert(1)> & "Co" <a href="https://evil.invalid">'
    message = workspaces.invitation_email(*branded(name=hostile), 'https://example.invalid/set')
    assert message['subject'] == f'Invitation to join {hostile} on DryScope'
    page = message['html']
    assert (
        '<img src=x' not in page
        and 'evil.invalid">' not in page
        and 'onerror=alert(1)>' not in page
    )
    assert html.escape(hostile) in page and hostile in message['text']
    assert page.count('<a href=') == 3 and page.count('<img ') == 1


@pytest.mark.parametrize(
    'role, phrase',
    [('owner', 'an owner'), ('estimator', 'an estimator'), ('office', 'office staff')],
)
def test_invitation_email_sign_in_steps_and_links(role, phrase):
    invite, company = branded(role=role)
    accept = 'https://alert-disaster-field-2026.web.app/?invite=' + 'a' * 32
    setup = 'https://example.invalid/set?mode=resetPassword&oobCode=secret-oob'
    password = workspaces.invitation_email(invite, company, setup)
    google = workspaces.invitation_email(invite, company, None)
    for message in (password, google):
        assert f'on DryScope as {phrase}.' in message['text']
        assert f'Accept the invitation: {accept}' in message['text']
        assert message['html'].count(f'href="{accept}"') == 2
        assert f'>{accept}</a>' in message['html'] and '>Accept invitation</a>' in message['html']
    assert '1. Set your password for DryScope: ' + setup in password['text']
    assert (
        '2. Accept the invitation. Then sign in with new@example.invalid and that password.'
        in password['text']
    )
    assert 'use Forgot password on the sign-in page' in password['text'] + password['html']
    assert f'href="{html.escape(setup)}"' in password['html'] and setup not in password['html']
    assert 'Sign in with Google using this email (new@example.invalid).' in google['text']
    assert 'Sign in with Google using this email' in google['html']
    assert 'Set your password' not in google['text'] + google['html'] and '1.' not in google['text']


def test_both_transports_send_the_logo_as_an_inline_attachment(smtp, monkeypatch):
    client, store, accounts, sent, writes, connections, plan, sleeps = smtp
    monkeypatch.setattr(workspaces, 'password_setup_link', lambda email: None)
    logo = workspaces.clean_logo(png())
    company = {'profile': {'name': 'Kern Water Pros', 'logo_data_url': logo}}
    workspaces.send_invitation(direct_invite(), company)
    monkeypatch.setenv('INVITATION_TRANSPORT', 'resend')
    workspaces.send_invitation(direct_invite(), company)
    data = base64.b64decode(logo.partition(',')[2])
    (attachment,) = sent[0]['attachments']
    assert attachment == {
        'content': base64.b64encode(data).decode(),
        'filename': 'logo.jpg',
        'content_type': 'image/jpeg',
        'content_id': 'invitation-logo@dryscope',
    }
    message = connections[0]['server'].message
    assert [part.get_content_type() for part in message.walk()] == [
        'multipart/alternative',
        'text/plain',
        'multipart/related',
        'text/html',
        'image/jpeg',
    ]
    image = list(message.walk())[-1]
    assert image['Content-ID'] == '<invitation-logo@dryscope>'
    assert image.get_content_disposition() == 'inline' and image.get_content() == data
    assert len(message.as_bytes()) < 60000


def test_smtp_invitation_records_the_message_id_and_mails_only_the_set_password_link(smtp):
    client, store, accounts, sent, writes, connections, plan, sleeps = smtp
    invited = client.post(
        '/api/companies/adr/invitations', json={'email': 'New@Example.invalid', 'role': 'office'}
    ).json()
    record = store.db.records['_invitations/' + invited['invitation_id']]
    assert invited['delivery_status'] == 'sent'
    assert record['message_id'] == (
        f'<invitation-{invited["invitation_id"]}-{record["send_attempt"]}@example.invalid>'
    )
    link = accounts.links[0]['link']
    text, body = message_parts(connections[0]['server'].message)
    assert 'Set your password for DryScope: ' + link in text
    assert html.escape(link) in body and '?invite=' + invited['invitation_id'] in text
    assert not any('secret-oob' in w for w in writes)
    assert 'secret-oob' not in json.dumps(store.db.records, default=str)


def test_smtp_retries_transient_failures_with_the_same_message_id(smtp):
    client, store, accounts, sent, writes, connections, plan, sleeps = smtp
    plan.extend(
        [
            ('connect', smtplib.SMTPServerDisconnected('Connection unexpectedly closed')),
            ('send', smtplib.SMTPResponseException(421, b'4.7.0 Try again later')),
        ]
    )
    message_id = workspaces.send_invitation(direct_invite(), {'profile': {'name': 'Company'}})
    assert len(connections) == 3 and sleeps == [2, 4]
    assert [c['server'].steps[-1] for c in connections] == ['connect', 'close', 'close']
    assert connections[2]['server'].message['Message-ID'] == message_id
    assert connections[1]['server'].message['Message-ID'] == message_id


def test_smtp_gives_up_after_three_transient_failures_and_shows_the_failure(smtp):
    client, store, accounts, sent, writes, connections, plan, sleeps = smtp
    plan.extend([('connect', TimeoutError('timed out'))] * 3)
    invited = client.post(
        '/api/companies/adr/invitations', json={'email': 'new@example.invalid', 'role': 'office'}
    ).json()
    assert len(connections) == 3 and sleeps == [2, 4]
    assert invited['delivery_status'] == 'failed' and invited['message_id'] is None
    assert 'could not be sent' in invited['delivery_error']
    resent = client.post(
        '/api/companies/adr/invitations/' + invited['invitation_id'] + '/resend', json={}
    ).json()
    assert resent['delivery_status'] == 'sent' and len(connections) == 4


@pytest.mark.parametrize(
    'failure',
    [
        (
            'login',
            smtplib.SMTPAuthenticationError(535, b'5.7.8 Username and Password not accepted'),
        ),
        (
            'send',
            smtplib.SMTPRecipientsRefused({'new@example.invalid': (550, b'5.1.1 No such user')}),
        ),
        ('send', smtplib.SMTPSenderRefused(553, b'5.7.1 Sender not allowed', 'x@example.invalid')),
        ('starttls', smtplib.SMTPNotSupportedError('STARTTLS extension not supported by server.')),
    ],
)
def test_smtp_permanent_failures_are_not_retried(smtp, failure):
    client, store, accounts, sent, writes, connections, plan, sleeps = smtp
    plan.append(failure)
    invited = client.post(
        '/api/companies/adr/invitations', json={'email': 'new@example.invalid', 'role': 'office'}
    ).json()
    assert len(connections) == 1 and not sleeps
    assert connections[0]['server'].steps[-1] == 'close'
    assert invited['delivery_status'] == 'failed' and invited['message_id'] is None


@pytest.mark.parametrize(
    'missing', ['INVITATION_SMTP_USERNAME', 'INVITATION_SMTP_PASSWORD', 'INVITATION_FROM']
)
def test_smtp_missing_configuration_fails_before_provisioning_or_connecting(
    smtp, monkeypatch, missing
):
    client, store, accounts, sent, writes, connections, plan, sleeps = smtp
    monkeypatch.delenv(missing)
    with pytest.raises(RuntimeError, match='not configured'):
        workspaces.send_invitation(direct_invite(), {'profile': {'name': 'Company'}})
    invited = client.post(
        '/api/companies/adr/invitations', json={'email': 'new@example.invalid', 'role': 'office'}
    ).json()
    assert invited['delivery_status'] == 'failed'
    assert not accounts.created and not accounts.links and not connections and not sent


def test_smtp_set_password_link_never_reaches_logs(smtp, caplog, capsys):
    client, store, accounts, sent, writes, connections, plan, sleeps = smtp
    caplog.set_level(logging.DEBUG)
    plan.append(('send', smtplib.SMTPResponseException(451, b'4.3.0 Temporary failure')))
    first = client.post(
        '/api/companies/adr/invitations', json={'email': 'new@example.invalid', 'role': 'office'}
    ).json()
    plan.append(('send', smtplib.SMTPDataError(554, b'5.6.0 Message rejected')))
    second = client.post(
        '/api/companies/adr/invitations', json={'email': 'other@example.invalid', 'role': 'office'}
    ).json()
    assert (first['delivery_status'], second['delivery_status']) == ('sent', 'failed')
    assert len(accounts.links) == 2
    captured = capsys.readouterr()
    mailed = ''.join(message_parts(c['server'].message)[0] for c in connections)
    logged = caplog.text + captured.out + captured.err + ''.join(writes)
    for link in [l['link'] for l in accounts.links]:
        assert link in mailed and link not in logged
    assert 'secret-oob' not in logged
    assert 'placeholder-app-password' not in caplog.text + captured.out + captured.err
    assert 'secret-oob' not in json.dumps(store.db.records, default=str)


def test_smtp_send_including_retries_ends_inside_the_delivery_reservation(smtp, monkeypatch):
    client, store, accounts, sent, writes, connections, plan, sleeps = smtp
    clock = [0.0]

    def sleep(seconds):
        clock[0] += seconds

    monkeypatch.setattr(
        workspaces,
        'time',
        SimpleNamespace(time=time.time, monotonic=lambda: clock[0], sleep=sleep),
    )

    class SlowSMTP:
        def __init__(self, host, port, timeout):
            connections.append(timeout)
            clock[0] += timeout
            raise TimeoutError('timed out')

    monkeypatch.setattr(workspaces.smtplib, 'SMTP', SlowSMTP)
    with pytest.raises(OSError):
        workspaces.send_invitation(direct_invite(), {'profile': {'name': 'Company'}})
    assert connections == [8, 8, 2]
    assert clock[0] <= workspaces.SMTP_DEADLINE < 30


def test_smtp_session_that_hangs_is_cut_off_at_the_deadline_without_a_retry(smtp, monkeypatch):
    client, store, accounts, sent, writes, connections, plan, sleeps = smtp
    monkeypatch.setattr(workspaces, 'SMTP_DEADLINE', 0.3)
    peers = []

    class HungSMTP:
        def __init__(self, host, port, timeout):
            self.sock, peer = socket.socketpair()
            self.sock.settimeout(2)
            peers.append(peer)

        def starttls(self, context):
            pass

        def login(self, username, password):
            pass

        def send_message(self, message):
            if not self.sock.recv(1):
                raise smtplib.SMTPServerDisconnected('Connection unexpectedly closed')

        def close(self):
            self.sock.close()

    monkeypatch.setattr(workspaces.smtplib, 'SMTP', HungSMTP)
    started = time.monotonic()
    try:
        with pytest.raises(TimeoutError, match='deadline'):
            workspaces.send_invitation(direct_invite(), {'profile': {'name': 'Company'}})
        assert time.monotonic() - started < 1.5
        assert len(peers) == 1 and not sleeps
    finally:
        for peer in peers:
            peer.close()


@pytest.mark.parametrize('provisioning, timeouts', [(7, [8, 7]), (25, [])])
def test_smtp_deadline_counts_slow_account_provisioning(smtp, monkeypatch, provisioning, timeouts):
    client, store, accounts, sent, writes, connections, plan, sleeps = smtp
    clock = [0.0]

    def sleep(seconds):
        clock[0] += seconds

    def slow_setup_link(email):
        clock[0] += provisioning
        return 'https://example.invalid/set'

    monkeypatch.setattr(
        workspaces,
        'time',
        SimpleNamespace(time=time.time, monotonic=lambda: clock[0], sleep=sleep),
    )
    monkeypatch.setattr(workspaces, 'password_setup_link', slow_setup_link)

    class SlowSMTP:
        def __init__(self, host, port, timeout):
            connections.append(timeout)
            clock[0] += timeout
            raise TimeoutError('timed out')

    monkeypatch.setattr(workspaces.smtplib, 'SMTP', SlowSMTP)
    with pytest.raises(TimeoutError, match='deadline'):
        workspaces.send_invitation(direct_invite(), {'profile': {'name': 'Company'}})
    assert connections == timeouts
    assert clock[0] <= max(provisioning, workspaces.SMTP_DEADLINE)
    del connections[:]
    clock[0] = 0.0
    invited = client.post(
        '/api/companies/adr/invitations', json={'email': 'new@example.invalid', 'role': 'office'}
    ).json()
    assert invited['delivery_status'] == 'failed' and invited['message_id'] is None
    assert connections == timeouts


PHOTO = 'd' * 32
SIGNED = 'ADR-AUTH-support123456'


def support_events(store):
    return [
        v
        for k, v in store.db.records.items()
        if k.startswith('_admin_events/') and v['action'].startswith('support_')
    ]


def signed_job(client, current, store):
    """An ADR estimator's signed job with one photo, plus customer coordination text."""
    current['uid'] = 'estimator'
    assert (
        client.post('/api/inspections', json={'inspection_id': ID, 'data': data()}).status_code
        == 200
    )
    store.add_photo(
        'estimator',
        ID,
        dict(
            photo_id=PHOTO,
            expected_revision=1,
            room='Bathroom',
            captured_at='2026-10-14T12:00:00Z',
            data_url=png(),
        ),
    )
    # A recorded reading keeps the audit from waiting on photo recognition.
    reading = dict(
        meter_detected=True, meter_type='Moisture meter', value='12', classification='', notes=''
    )
    store.set_ocr('estimator', ID, PHOTO, reading)
    current['uid'] = 'office'
    job = client.get('/api/jobs/' + ID + '/coordination').json()
    assert (
        client.put(
            '/api/jobs/' + ID + '/coordination',
            json={
                'expected_version': job['version'],
                'customer_name': 'Synthetic Customer Name',
                'customer_phone': '555-0100',
                'customer_email': 'customer@example.invalid',
            },
        ).status_code
        == 200
    )
    current['uid'] = 'estimator'
    # Audited after coordination, so the documents name the customer.
    record = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 3}).json()
    payload = dict(
        inspection_id=ID,
        expected_revision=3,
        auth_id=SIGNED,
        proposal_hash=record['audit']['proposal_hash'],
        signature_png=png(),
        documents_confirmed=True,
    )
    assert client.post('/api/authorize', json=payload).status_code == 200
    store.create_inspection('other-owner', OTHER, data('Other company job'))


@pytest.mark.parametrize('uid', ['admin', 'owner'])
def test_superadmin_support_reads_any_company_and_audits_each_view(api, uid):
    client, current, store = api
    signed_job(client, current, store)
    current['uid'] = uid
    base = '/api/admin/companies/adr'
    jobs = client.get(base + '/jobs').json()
    assert [j['inspection_id'] for j in jobs['inspections']] == [ID]
    documents = client.get(base + '/authorizations').json()
    assert [d['auth_id'] for d in documents['authorizations']] == [SIGNED]
    opened = client.get(base + '/jobs/' + ID).json()
    assert opened['inspection']['status'] == 'signed' and 'owner_uid' not in opened['inspection']
    assert opened['job']['customer_name'] == 'Synthetic Customer Name'
    agreement = client.get(base + '/authorizations/' + SIGNED).json()
    assert agreement['authorization']['documents']['company_identity']['company_id'] == 'adr'
    assert client.get(base + '/jobs/' + ID + '/photos/' + PHOTO).content.startswith(b'\x89PNG')
    for name in ('signature', 'photo-0'):
        response = client.get(base + '/authorizations/' + SIGNED + '/evidence/' + name)
        assert response.status_code == 200 and response.content.startswith(b'\x89PNG')
    assert client.get(base + '/authorizations/' + SIGNED + '/evidence/photo-9').status_code == 404
    other = '/api/admin/companies/other'
    assert [j['inspection_id'] for j in client.get(other + '/jobs').json()['inspections']] == [
        OTHER
    ]
    assert client.get(other + '/authorizations').json()['authorizations'] == []
    # ADR records never open through another company's support view.
    for path in (
        '/jobs/' + ID,
        '/jobs/' + ID + '/photos/' + PHOTO,
        '/authorizations/' + SIGNED,
        '/authorizations/' + SIGNED + '/evidence/signature',
    ):
        assert client.get(other + path).status_code == 404
    assert client.get(base + '/jobs/' + OTHER).status_code == 404
    assert client.get('/api/admin/companies/missing/jobs').status_code == 404
    events = support_events(store)
    assert {e['actor_uid'] for e in events} == {uid}
    assert sorted((e['company_id'], e['action'], e['target']) for e in events) == sorted(
        [
            ('adr', 'support_view_jobs', 'jobs'),
            ('adr', 'support_view_documents', 'documents'),
            ('adr', 'support_view_job', 'job/' + ID),
            ('adr', 'support_view_document', 'document/' + SIGNED),
            ('adr', 'support_view_photo', 'photo/' + ID + '/' + PHOTO),
            ('adr', 'support_view_evidence', 'evidence/' + SIGNED + '/signature'),
            ('adr', 'support_view_evidence', 'evidence/' + SIGNED + '/photo-0'),
            ('other', 'support_view_jobs', 'jobs'),
            ('other', 'support_view_documents', 'documents'),
        ]
    )
    assert all(e['created_at'] and e['details'] == {} for e in events)
    logged = json.dumps(events)
    for private in ('Synthetic Customer Name', '555-0100', 'customer@example.invalid', 'Test'):
        assert private not in logged


@pytest.mark.parametrize('uid', ['estimator', 'office', 'other-owner', 'estimator2'])
def test_support_view_requires_superadmin(api, uid):
    client, current, store = api
    signed_job(client, current, store)
    current['uid'] = uid
    for company in ('adr', 'other'):
        base = '/api/admin/companies/' + company
        for path in (
            '/jobs',
            '/authorizations',
            '/jobs/' + ID,
            '/jobs/' + ID + '/photos/' + PHOTO,
            '/authorizations/' + SIGNED,
            '/authorizations/' + SIGNED + '/evidence/signature',
        ):
            assert client.get(base + path).status_code == 403, (company, path)
    assert not support_events(store)


def test_superadmin_cannot_change_company_jobs_documents_or_settings(api):
    client, current, store = api
    signed_job(client, current, store)
    current['uid'] = 'estimator'
    draft = 'ADR-INS-' + 'e' * 32
    client.post('/api/inspections', json={'inspection_id': draft, 'data': data()})
    record = client.post('/api/audit', json={'inspection_id': draft, 'expected_revision': 1})
    record = record.json()
    current['uid'] = 'admin'
    client.get('/api/admin/companies/adr/jobs')
    before = {k: deepcopy(v) for k, v in store.db.records.items() if not k.startswith('_limits/')}
    job = store.db.records['_workspace_jobs/' + draft]
    company = store.db.records['_companies/adr']
    upload = dict(
        photo_id='f' * 32,
        expected_revision=2,
        room='Bathroom',
        captured_at='2026-10-14T12:00:00Z',
        data_url=png(),
    )
    sign = dict(
        inspection_id=draft,
        expected_revision=record['revision'],
        auth_id='ADR-AUTH-admin123456',
        proposal_hash=record['audit']['proposal_hash'],
        signature_png=png(),
        documents_confirmed=True,
    )
    link = dict(
        expected_revision=record['revision'], proposal_hash=record['audit']['proposal_hash']
    )
    responses = {
        'create': client.post(
            '/api/inspections', json={'inspection_id': 'ADR-INS-' + '9' * 32, 'data': data()}
        ),
        'scope': client.put(
            '/api/inspections/' + draft, json={'expected_revision': 2, 'data': data('Changed')}
        ),
        'photo': client.post('/api/inspections/' + draft + '/photos', json=upload),
        'ocr': client.post('/api/inspections/' + ID + '/photos/' + PHOTO + '/ocr', json={}),
        'move photo': client.put(
            '/api/inspections/' + ID + '/photos/' + PHOTO + '/room',
            json={'expected_revision': 2, 'room': 'Bathroom'},
        ),
        'suggest': client.post(
            '/api/inspections/' + draft + '/scope-suggestions',
            json={'inspection_id': draft, 'expected_revision': 2},
        ),
        'audit': client.post('/api/audit', json={'inspection_id': draft, 'expected_revision': 2}),
        'voice note': client.post('/api/inspections/' + draft + '/voice-notes', json=voice_note()),
        'sign': client.post('/api/authorize', json=sign),
        'link': client.post(
            '/api/inspections/' + draft + '/signing-links',
            json=link,
            headers={'Origin': bm.ORIGINS[0]},
        ),
        'revoke': client.post(
            '/api/inspections/' + draft + '/signing-links/revoke',
            headers={'Origin': bm.ORIGINS[0]},
        ),
        'coordination': client.put(
            '/api/jobs/' + draft + '/coordination',
            json={'expected_version': job['version'], 'office_notes': 'Support note'},
        ),
        'profile': client.put(
            '/api/companies/other',
            json={
                'expected_version': 1,
                'profile': {**store.db.records['_companies/other']['profile'], 'name': 'Changed'},
            },
        ),
        'invite': client.post(
            '/api/companies/other/invitations',
            json={'email': 'support-new@example.invalid', 'role': 'estimator'},
        ),
        'member read': client.get('/api/inspections/' + draft),
        'member list': client.get('/api/inspections'),
        'member document': client.get('/api/authorizations/' + SIGNED),
        'coordination read': client.get('/api/jobs/' + draft + '/coordination'),
    }
    refused = {name: r.status_code for name, r in responses.items() if r.status_code not in (403,)}
    assert not refused, refused
    after = {k: v for k, v in store.db.records.items() if not k.startswith('_limits/')}
    assert after == before and company == store.db.records['_companies/adr']


def test_superadmin_support_actions_are_limited_and_audited(store):
    w = store.workspaces
    staff = w.invite('other-owner', 'other', 'staff@example.invalid', 'office')
    w.deliver('other-owner', staff['invitation_id'], lambda *args: 'first')
    resent = w.invitation_action('admin', 'other', staff['invitation_id'], 'resend')
    assert resent['send_attempt'] != staff['send_attempt']
    assert w.deliver('admin', staff['invitation_id'], lambda *args: 'second')['message_id'] == (
        'second'
    )
    w.invitation_action('admin', 'other', staff['invitation_id'], 'cancel')
    assert store.db.records['_invitations/' + staff['invitation_id']]['status'] == 'cancelled'
    # Creating staff invitations stays with the owner.
    with pytest.raises(AccessDenied):
        w.invite('admin', 'other', 'new@example.invalid', 'estimator')
    w.update_member(
        'admin',
        'adr',
        'estimator',
        MemberUpdate(expected_version=1, role='office', status='active'),
    )
    assert w.principal('estimator')['role'] == 'office'
    store.db.records['_memberships/office']['status'] = 'disabled'
    w.update_member(
        'admin', 'adr', 'office', MemberUpdate(expected_version=1, role='office', status='active')
    )
    assert w.principal('office')['role'] == 'office'
    refused = [
        (
            'estimator2',
            'adr',
            MemberUpdate(expected_version=1, role='estimator', status='disabled'),
        ),
        ('owner', 'adr', MemberUpdate(expected_version=1, role='office', status='active')),
        ('other-owner', 'other', MemberUpdate(expected_version=1, role='office', status='active')),
    ]
    for member_uid, company_id, req in refused:
        with pytest.raises(AccessDenied):
            w.update_member('admin', company_id, member_uid, req)
    assert store.db.records['_memberships/estimator2']['status'] == 'active'
    # A disabled former owner returns only through the owner's own team management.
    store.db.records['_memberships/former'] = dict(
        uid='former',
        email='former@example.invalid',
        company_id='other',
        role='owner',
        status='disabled',
        version=2,
        updated_at='2026',
    )
    with pytest.raises(AccessDenied):
        w.update_member(
            'admin',
            'other',
            'former',
            MemberUpdate(expected_version=2, role='estimator', status='active'),
        )
    events = support_events(store)
    assert sorted((e['company_id'], e['action'], e['target']) for e in events) == sorted(
        [
            ('other', 'support_invitation_resend', 'invitation/' + staff['invitation_id']),
            ('other', 'support_invitation_cancel', 'invitation/' + staff['invitation_id']),
            ('adr', 'support_member_access', 'member/estimator'),
            ('adr', 'support_member_access', 'member/office'),
        ]
    )
    assert all(e['actor_uid'] == 'admin' and 'example.invalid' not in str(e) for e in events)


def test_support_actions_respect_company_status_and_never_touch_the_superadmins_membership(store):
    w = store.workspaces
    store.db.records['_memberships/admin'] = dict(
        uid='admin',
        email='admin@example.invalid',
        company_id='other',
        role='estimator',
        status='disabled',
        version=1,
        updated_at='2026',
    )
    with pytest.raises(AccessDenied):
        w.update_member(
            'admin',
            'other',
            'admin',
            MemberUpdate(expected_version=1, role='estimator', status='active'),
        )
    assert w.principal('admin')['role'] is None
    store.db.records['_memberships/office']['status'] = 'disabled'
    store.db.records['_companies/adr']['status'] = 'suspended'
    with pytest.raises(AccessDenied):
        w.update_member(
            'admin',
            'adr',
            'office',
            MemberUpdate(expected_version=1, role='office', status='active'),
        )
    pending = w.invite('other-owner', 'other', 'staff@example.invalid', 'office')
    store.db.records['_companies/other']['status'] = 'suspended'
    with pytest.raises(AccessDenied):
        w.invitation_action('admin', 'other', pending['invitation_id'], 'cancel')
    # Reads stay available for troubleshooting a suspended company.
    assert w.team('admin', 'adr') and w.invitations('admin', 'other')
    assert not any(e['action'].startswith('support_member') for e in support_events(store))


def test_support_access_is_not_a_membership(api):
    client, current, store = api
    signed_job(client, current, store)
    current['uid'] = 'admin'
    assert client.get('/api/admin/companies/adr/jobs/' + ID).status_code == 200
    assert '_memberships/admin' not in store.db.records
    session = client.get('/api/session').json()
    assert session['role'] is None and session['capabilities'] == [] and session['superadmin']
    current['uid'] = 'office'
    job = client.get('/api/jobs/' + ID + '/coordination').json()
    assigned = client.put(
        '/api/jobs/' + ID + '/coordination',
        json={'expected_version': job['version'], 'assigned_estimator_uid': 'admin'},
    )
    assert assigned.status_code == 400
    # The one-membership rule still applies: the superadmin can join one company by invitation.
    w = store.workspaces
    invitation = w.invite('other-owner', 'other', 'admin@example.invalid', 'estimator')
    assert w.accept(identity('admin'), invitation['invitation_id'])['company_id'] == 'other'
    second = w.invite('owner', 'adr', 'admin@example.invalid', 'office')
    with pytest.raises(Conflict):
        w.accept(identity('admin'), second['invitation_id'])
    current['uid'] = 'admin'
    # Membership permissions apply in the member's company; support still covers others read-only.
    own = 'ADR-INS-' + '7' * 32
    assert (
        client.post('/api/inspections', json={'inspection_id': own, 'data': data()}).status_code
        == 200
    )
    assert client.get('/api/inspections/' + OTHER).status_code == 404
    assert client.get('/api/admin/companies/adr/authorizations/' + SIGNED).status_code == 200
    assert client.put(
        '/api/inspections/' + ID, json={'expected_revision': 4, 'data': data('Changed')}
    ).status_code in (403, 404)


def test_owner_superadmin_uses_membership_for_own_company_without_support_audit(api):
    client, current, store = api
    current['uid'] = 'owner'
    assert client.get('/api/companies/adr').status_code == 200
    assert client.get('/api/companies/adr/team').status_code == 200
    assert client.get('/api/companies/adr/invitations').status_code == 200
    assert not support_events(store)
    assert client.get('/api/companies/other').status_code == 200
    assert client.get('/api/companies/other/team').status_code == 200
    assert client.get('/api/companies/other/invitations').status_code == 200
    assert sorted(e['action'] for e in support_events(store)) == [
        'support_view_company',
        'support_view_invitations',
        'support_view_team',
    ]
    # Office staff who are also superadmin get the full roster through audited support.
    store.db.records['_platform_admins/office'] = {'active': True}
    current['uid'] = 'office'
    assert len(client.get('/api/companies/adr/team').json()['members']) == 4
    assert support_events(store)[-1]['action'] == 'support_view_team'


def test_support_reads_recheck_superadmin_before_returning_evidence(api, monkeypatch):
    client, current, store = api
    signed_job(client, current, store)
    current['uid'] = 'admin'
    download = store.bucket.blob('any').__class__.download_as_bytes

    def revoked_during_download(blob):
        store.db.records['_platform_admins/admin']['active'] = False
        return download(blob)

    monkeypatch.setattr(
        store.bucket.blob('any').__class__, 'download_as_bytes', revoked_during_download
    )
    base = '/api/admin/companies/adr'
    assert client.get(base + '/authorizations/' + SIGNED + '/evidence/signature').status_code == 403
    store.db.records['_platform_admins/admin']['active'] = True
    assert client.get(base + '/jobs/' + ID + '/photos/' + PHOTO).status_code == 403
    assert not support_events(store)


def test_support_view_is_unavailable_in_legacy_owner_only_mode(monkeypatch):
    monkeypatch.setattr(bm, 'WORKSPACES_ENABLED', False)
    client = TestClient(bm.app, headers={'Authorization': 'Bearer owner.a'})
    for path in ('/jobs', '/authorizations', '/jobs/' + ID, '/authorizations/' + SIGNED):
        assert client.get('/api/admin/companies/adr' + path).status_code == 503


# Superadmin-only tools: every caller who is not an active superadmin is refused.
NON_SUPERADMINS = [
    'owner',  # ADR owner; superadmin_gate removes this fixture's superadmin record
    'estimator',
    'office',
    'outsider',  # verified sign-in, no membership
    'disabled',  # disabled ADR estimator
    'suspended',  # owner of a suspended company
    'inactive',  # superadmin record set inactive
    'removed',  # former ADR office member whose superadmin record was deleted
]


def superadmin_gate(client, current, store):
    """Adds the non-superadmin callers and the records each superadmin tool targets."""
    signed_job(client, current, store)
    records = store.db.records
    del records['_platform_admins/owner']
    records['_companies/paused'] = {
        **deepcopy(records['_companies/other']),
        'company_id': 'paused',
        'status': 'suspended',
        'owner_uid': 'suspended',
    }
    for uid, role, company_id, status in [
        ('disabled', 'estimator', 'adr', 'disabled'),
        ('suspended', 'owner', 'paused', 'active'),
        ('removed', 'office', 'adr', 'active'),
        ('other-estimator', 'estimator', 'other', 'active'),
        ('other-staff', 'office', 'other', 'disabled'),
    ]:
        records['_memberships/' + uid] = dict(
            uid=uid,
            email=uid + '@example.invalid',
            company_id=company_id,
            role=role,
            status=status,
            version=1,
            updated_at='2026',
        )
    records['_platform_admins/inactive'] = {'active': False}
    records['_platform_admins/removed'] = {'active': True}
    del records['_platform_admins/removed']
    w = store.workspaces
    return dict(
        staff=w.invite('other-owner', 'other', 'other-new@example.invalid', 'office'),
        owner=w.invite('admin', 'other', 'other-next-owner@example.invalid', 'owner'),
        adr_owner=w.invite('admin', 'adr', 'adr-next-owner@example.invalid', 'owner'),
    )


def superadmin_tools(invites):
    """(name, method, path, body, superadmin status), ordered so an active superadmin succeeds."""
    support = '/api/admin/companies/'
    other = '/api/companies/other'
    staff = other + '/invitations/' + invites['staff']['invitation_id']
    owner = other + '/invitations/' + invites['owner']['invitation_id']
    adr_owner = '/api/companies/adr/invitations/' + invites['adr_owner']['invitation_id']
    return [
        ('list companies', 'GET', '/api/admin/companies', None, 200),
        ('company metadata', 'GET', other, None, 200),
        ('team metadata', 'GET', other + '/team', None, 200),
        ('invitation metadata', 'GET', other + '/invitations', None, 200),
        ('support jobs', 'GET', support + 'adr/jobs', None, 200),
        ('support documents', 'GET', support + 'adr/authorizations', None, 200),
        ('support job', 'GET', support + 'adr/jobs/' + ID, None, 200),
        ('support photo', 'GET', support + 'adr/jobs/' + ID + '/photos/' + PHOTO, None, 200),
        ('support document', 'GET', support + 'adr/authorizations/' + SIGNED, None, 200),
        (
            'support evidence',
            'GET',
            support + 'adr/authorizations/' + SIGNED + '/evidence/signature',
            None,
            200,
        ),
        ('support other jobs', 'GET', support + 'other/jobs', None, 200),
        ('support other job', 'GET', support + 'other/jobs/' + OTHER, None, 200),
        ('support other documents', 'GET', support + 'other/authorizations', None, 200),
        (
            'switch member role',
            'PUT',
            other + '/team/other-estimator',
            {'expected_version': 1, 'role': 'office', 'status': 'active'},
            200,
        ),
        (
            're-enable member',
            'PUT',
            other + '/team/other-staff',
            {'expected_version': 1, 'role': 'office', 'status': 'active'},
            200,
        ),
        ('resend staff invitation', 'POST', staff + '/resend', None, 200),
        ('cancel staff invitation', 'POST', staff + '/cancel', None, 200),
        ('resend owner invitation', 'POST', owner + '/resend', None, 200),
        ('cancel owner invitation', 'POST', owner + '/cancel', None, 200),
        (
            'replace owner',
            'POST',
            other + '/invitations',
            {'email': 'other-replacement@example.invalid', 'role': 'owner'},
            200,
        ),
        (
            'replace own company owner',
            'POST',
            '/api/companies/adr/invitations',
            {'email': 'adr-replacement@example.invalid', 'role': 'owner'},
            200,
        ),
        ('cancel own company owner invitation', 'POST', adr_owner + '/cancel', None, 200),
        (
            'suspend own company',
            'PUT',
            support + 'adr/status',
            {'expected_version': 1, 'status': 'suspended'},
            200,
        ),
        (
            'reactivate suspended company',
            'PUT',
            support + 'paused/status',
            {'expected_version': 1, 'status': 'active'},
            200,
        ),
        (
            'create owner login',
            'POST',
            support + 'paused/owner-login',
            {'email': 'paused-owner@example.invalid', 'password': TEMPORARY, 'expected_version': 2},
            200,
        ),
        (
            'suspend company',
            'PUT',
            support + 'other/status',
            {'expected_version': 1, 'status': 'suspended'},
            200,
        ),
        (
            'status of unknown company',
            'PUT',
            support + 'missing/status',
            {'expected_version': 1, 'status': 'suspended'},
            404,
        ),
        (
            'create company',
            'POST',
            '/api/admin/companies',
            {'name': 'Forged Restoration', 'owner_email': 'forged-owner@example.invalid'},
            200,
        ),
        (
            'create company with owner login',
            'POST',
            '/api/admin/companies',
            {
                'name': 'Login Restoration',
                'owner_email': 'login-owner@example.invalid',
                'owner_password': TEMPORARY,
            },
            200,
        ),
    ]


def unrestricted(store):
    # A refused caller's own rate-limit counter (_limits) is the only record a request may touch.
    return {k: deepcopy(v) for k, v in store.db.records.items() if not k.startswith('_limits/')}


def assert_refused(client, tools, headers=None, expected=(403,)):
    for name, method, path, body, _ in tools:
        response = client.request(method, path, json=body, headers=headers)
        assert response.status_code in expected, (name, response.status_code, response.text)
        assert set(response.json()) == {'detail'}, name


@pytest.mark.parametrize('uid', NON_SUPERADMINS)
def test_superadmin_tools_refuse_every_non_superadmin(mail, uid):
    client, current, store, accounts, sent, _ = mail
    invites = superadmin_gate(client, current, store)
    sent.clear()
    before = unrestricted(store)
    current['uid'] = uid
    assert not client.get('/api/access').json()['superadmin']
    assert_refused(client, superadmin_tools(invites))
    assert unrestricted(store) == before
    assert not sent and not accounts.created and not accounts.updated


def test_superadmin_tools_succeed_for_an_active_superadmin(mail):
    """The same requests succeed for a superadmin, so each refusal above comes from the gate."""
    client, current, store, accounts, sent, _ = mail
    invites = superadmin_gate(client, current, store)
    current['uid'] = 'admin'
    for name, method, path, body, expected in superadmin_tools(invites):
        response = client.request(method, path, json=body)
        assert response.status_code == expected, (name, response.text)
    assert store.db.records['_companies/paused']['status'] == 'active'
    assert store.db.records['_memberships/other-staff']['status'] == 'active'
    assert {m['to'][0] for m in sent} >= {
        'other-new@example.invalid',
        'other-next-owner@example.invalid',
        'forged-owner@example.invalid',
    }


def test_superadmin_tool_inventory_is_covered_and_rechecks_revocation():
    """Every /api/admin route is in the refusal matrix and always repeats the revoked-account check."""
    invites = {k: {'invitation_id': k} for k in ('staff', 'owner', 'adr_owner')}
    tools = superadmin_tools(invites)
    for route in bm.app.routes:
        if not route.path.startswith('/api/admin'):
            continue
        for method in route.methods:
            assert any(m == method and route.path_regex.fullmatch(p) for _, m, p, _, _ in tools), (
                method,
                route.path,
            )
        scopes = [
            scope
            for dependency in route.dependant.dependencies
            if dependency.call is bm.current_identity
            for scope in dependency.own_oauth_scopes
        ]
        assert bm.LIVE_REVOCATION[0] in scopes, route.path


def revoke_admin(store):
    store.db.records['_platform_admins/admin']['active'] = False


def revoked(records):
    # The revocation itself is the one expected change.
    return {**records, '_platform_admins/admin': {'active': False}}


@pytest.mark.parametrize(
    'name',
    [
        'switch member role',
        're-enable member',
        'resend staff invitation',
        'cancel staff invitation',
        'resend owner invitation',
        'cancel owner invitation',
        'replace owner',
        'suspend company',
        'reactivate suspended company',
        'create company',
        'create owner login',
        'create company with owner login',
    ],
)
def test_superadmin_revoked_before_a_write_is_refused_without_changes(mail, monkeypatch, name):
    client, current, store, accounts, sent, _ = mail
    invites = superadmin_gate(client, current, store)
    sent.clear()
    tool = next(t for t in superadmin_tools(invites) if t[0] == name)
    quota = store.quota

    def revoked_after_sign_in(*args):
        revoke_admin(store)
        return quota(*args)

    monkeypatch.setattr(store, 'quota', revoked_after_sign_in)
    before = unrestricted(store)
    current['uid'] = 'admin'
    assert_refused(client, [tool])
    assert unrestricted(store) == revoked(before)
    assert not sent and not accounts.created and not accounts.updated


@pytest.mark.parametrize(
    'name',
    [
        'company metadata',
        'team metadata',
        'invitation metadata',
        'support jobs',
        'support documents',
        'support job',
        'support photo',
        'support document',
        'support evidence',
        'support other jobs',
        'support other job',
        'switch member role',
        're-enable member',
    ],
)
def test_superadmin_revoked_during_a_support_request_gets_nothing(api, monkeypatch, name):
    client, current, store = api
    invites = superadmin_gate(client, current, store)
    tool = next(t for t in superadmin_tools(invites) if t[0] == name)
    principal = store.workspaces.principal

    def revoked_after_first_check(*args, **kwargs):
        actor = principal(*args, **kwargs)
        revoke_admin(store)
        return actor

    monkeypatch.setattr(store.workspaces, 'principal', revoked_after_first_check)
    before = unrestricted(store)
    current['uid'] = 'admin'
    assert_refused(client, [tool])
    assert unrestricted(store) == revoked(before)


def test_owner_invitations_from_a_revoked_superadmin_cannot_be_accepted(store):
    w = store.workspaces
    company, created = w.create_company('admin', 'Revoked Restoration', 'first@example.invalid')
    replacement = w.invite('admin', 'other', 'next@example.invalid', 'owner')
    revoke_admin(store)
    for uid, invitation in (('first', created), ('next', replacement)):
        with pytest.raises(AccessDenied):
            w.accept(identity(uid), invitation['invitation_id'])
        assert '_memberships/' + uid not in store.db.records
    assert store.db.records['_companies/' + company['company_id']]['owner_uid'] is None
    assert store.db.records['_companies/other']['owner_uid'] == 'other-owner'


FORGED_CLAIMS = dict(
    superadmin=True,
    admin=True,
    role='superadmin',
    capabilities=['team_manage', 'profile_manage', 'superadmin'],
    platform_admin=True,
)
FORGED_HEADERS = {
    'X-ADR-Superadmin': 'true',
    'X-ADR-Role': 'superadmin',
    'X-ADR-Capabilities': 'superadmin,team_manage',
}


@pytest.mark.parametrize('uid', ['outsider', 'office', 'owner', 'inactive'])
def test_forged_claims_headers_and_fields_cannot_grant_superadmin(mail, monkeypatch, uid):
    """Firebase custom claims and browser-supplied capabilities never grant superadmin tools."""
    client, current, store, accounts, sent, _ = mail
    invites = superadmin_gate(client, current, store)
    sent.clear()
    for endpoint in (bm.current_staff, bm.current_identity):
        bm.app.dependency_overrides.pop(endpoint)
    checks = []

    def verified(token, app=None, check_revoked=False):
        checks.append((token, check_revoked))
        return {**identity(uid), **FORGED_CLAIMS}

    monkeypatch.setattr(bm, 'revocation_checked', type(bm.revocation_checked)())
    monkeypatch.setattr(bm.firebase_admin, 'get_app', lambda name: object())
    monkeypatch.setattr(bm.firebase_auth, 'verify_id_token', verified)
    before = unrestricted(store)
    # A cached revocation lookup from an ordinary read must not carry over to superadmin tools.
    access = client.get('/api/access', headers=FORGED_HEADERS).json()
    assert not access['superadmin'] and 'superadmin' not in access['capabilities']
    checks.clear()
    tools = superadmin_tools(invites)
    assert_refused(client, tools, FORGED_HEADERS)
    assert len(checks) == len(tools) and all(check for _, check in checks)
    forged_fields = [
        (
            'create company',
            'POST',
            '/api/admin/companies',
            {'name': 'Forged', 'owner_email': 'forged@example.invalid', **FORGED_CLAIMS},
            None,
        ),
        (
            'suspend company',
            'PUT',
            '/api/admin/companies/other/status',
            {'expected_version': 1, 'status': 'suspended', 'superadmin': True},
            None,
        ),
        (
            'replace owner',
            'POST',
            '/api/companies/other/invitations',
            {'email': 'forged@example.invalid', 'role': 'owner', 'superadmin': True},
            None,
        ),
    ]
    assert_refused(client, forged_fields, FORGED_HEADERS, (403, 422))
    assert unrestricted(store) == before
    assert not sent and not accounts.created


# Ownership transfer: superadmin replaces the owner; the switch is atomic on acceptance.

DRAFT = 'ADR-INS-' + 'c' * 32


def transfer_setup(client, current, store):
    """A plain owner (no superadmin record), the owner's draft, an estimator's signed job and
    a staff invitation the owner sent; returns that invitation."""
    signed_job(client, current, store)
    del store.db.records['_platform_admins/owner']
    current['uid'] = 'owner'
    assert (
        client.post(
            '/api/inspections', json={'inspection_id': DRAFT, 'data': data('Owner draft')}
        ).status_code
        == 200
    )
    staff = client.post(
        '/api/companies/adr/invitations', json={'email': 'staff@example.invalid', 'role': 'office'}
    )
    assert staff.status_code == 200
    return staff.json()


def owner_routes(store, staff_invitation):
    """(name, method, path, body) for every owner route, with bodies valid for the current records."""
    records = store.db.records
    company = records['_companies/adr']
    job = records['_workspace_jobs/' + ID]
    evidence = '/api/authorizations/' + SIGNED
    return [
        ('company', 'GET', '/api/companies/adr', None),
        (
            'profile',
            'PUT',
            '/api/companies/adr',
            {'expected_version': company['version'], 'profile': company['profile']},
        ),
        ('team', 'GET', '/api/companies/adr/team', None),
        (
            'member',
            'PUT',
            '/api/companies/adr/team/estimator2',
            {
                'expected_version': records['_memberships/estimator2']['version'],
                'role': 'estimator',
                'status': 'active',
            },
        ),
        ('invitations', 'GET', '/api/companies/adr/invitations', None),
        (
            'invite',
            'POST',
            '/api/companies/adr/invitations',
            {'email': 'next-staff@example.invalid', 'role': 'estimator'},
        ),
        (
            'cancel invitation',
            'POST',
            '/api/companies/adr/invitations/' + staff_invitation['invitation_id'] + '/cancel',
            None,
        ),
        ('jobs', 'GET', '/api/inspections', None),
        ('job', 'GET', '/api/inspections/' + ID, None),
        ('draft', 'GET', '/api/inspections/' + DRAFT, None),
        ('photo', 'GET', '/api/inspections/' + ID + '/photos/' + PHOTO, None),
        ('documents', 'GET', '/api/authorizations', None),
        ('document', 'GET', evidence, None),
        ('evidence', 'GET', evidence + '/evidence/signature', None),
        ('coordination', 'GET', '/api/jobs/' + ID + '/coordination', None),
        (
            'coordinate',
            'PUT',
            '/api/jobs/' + ID + '/coordination',
            {
                'expected_version': job['version'],
                **{
                    k: job[k]
                    for k in ('customer_name', 'customer_phone', 'customer_email', 'office_notes')
                },
            },
        ),
    ]


def active_owners(store, company_id='adr'):
    return sorted(
        m['uid']
        for k, m in store.db.records.items()
        if k.startswith('_memberships/')
        and m['company_id'] == company_id
        and m['role'] == 'owner'
        and m['status'] == 'active'
    )


def company_records(store):
    """Customer jobs, drafts, signed agreements and their company sidecars."""
    prefixes = ('inspections/', 'authorizations/', '_workspace_jobs/', '_workspace_authorizations/')
    return {k: deepcopy(v) for k, v in store.db.records.items() if k.startswith(prefixes)}


def events(store, action):
    return [
        v
        for k, v in store.db.records.items()
        if k.startswith('_admin_events/') and v['action'] == action
    ]


def test_owner_transfer_end_to_end_moves_owner_access_and_keeps_company_records(mail):
    client, current, store, accounts, sent, _ = mail
    staff_invitation = transfer_setup(client, current, store)
    records = store.db.records
    jobs = company_records(store)
    current['uid'] = 'admin'
    invited = client.post(
        '/api/companies/adr/invitations',
        json={'email': 'successor@example.invalid', 'role': 'owner'},
    )
    assert invited.status_code == 200
    invitation = invited.json()
    assert invitation['expected_owner_uid'] == 'owner'
    assert sent[-1]['to'] == ['successor@example.invalid']
    competing = client.post(
        '/api/companies/adr/invitations', json={'email': 'rival@example.invalid', 'role': 'owner'}
    ).json()
    accept = '/api/invitations/' + invitation['invitation_id'] + '/accept'
    # Until acceptance the current owner keeps the company.
    assert active_owners(store) == ['owner'] and records['_companies/adr']['owner_uid'] == 'owner'

    # Only the exact invited, verified account can accept.
    for uid in ('intruder', 'owner', 'estimator'):
        current['uid'] = uid
        assert client.post(accept).status_code == 404, uid
    bm.app.dependency_overrides[bm.current_identity] = lambda: {
        **identity('successor'),
        'email_verified': False,
    }
    assert client.post(accept).status_code == 403
    bm.app.dependency_overrides[bm.current_identity] = lambda: identity(current['uid'])
    assert active_owners(store) == ['owner'] and records['_memberships/owner']['version'] == 1

    current['uid'] = 'successor'
    assert client.post(accept).json() == {'uid': 'successor', 'company_id': 'adr', 'role': 'owner'}
    company = deepcopy(records['_companies/adr'])
    assert company['owner_uid'] == 'successor'
    assert active_owners(store) == ['successor']
    assert records['_memberships/owner'] | {'updated_at': None} == dict(
        uid='owner',
        email='owner@example.invalid',
        company_id='adr',
        role='owner',
        status='disabled',
        version=2,
        updated_at=None,
    )
    # Repeating the acceptance changes nothing; a competing invitation bound to the old owner fails.
    assert client.post(accept).status_code == 200
    assert records['_companies/adr'] == company and active_owners(store) == ['successor']
    current['uid'] = 'rival'
    assert (
        client.post('/api/invitations/' + competing['invitation_id'] + '/accept').status_code == 409
    )
    assert active_owners(store) == ['successor'] and '_memberships/rival' not in records

    # The former owner immediately loses every owner route and changes nothing.
    current['uid'] = 'owner'
    before = unrestricted(store)
    for name, method, path, body in owner_routes(store, staff_invitation):
        response = client.request(method, path, json=body)
        assert response.status_code == 403, (name, response.status_code, response.text)
        assert set(response.json()) == {'detail'}, name
    assert unrestricted(store) == before

    # The new owner gains them, over the same company jobs, drafts and signed agreements.
    current['uid'] = 'successor'
    for name, method, path, body in owner_routes(store, staff_invitation):
        response = client.request(method, path, json=body)
        assert response.status_code == 200, (name, response.status_code, response.text)
    assert {j['inspection_id'] for j in client.get('/api/inspections').json()['inspections']} == {
        ID,
        DRAFT,
    }
    assert [a['auth_id'] for a in client.get('/api/authorizations').json()['authorizations']] == [
        SIGNED
    ]
    after = company_records(store)
    # Only the coordination sidecar's version moved; jobs, drafts and signed agreements are intact.
    after['_workspace_jobs/' + ID].update(
        version=jobs['_workspace_jobs/' + ID]['version'],
        updated_at=jobs['_workspace_jobs/' + ID]['updated_at'],
    )
    assert after == jobs
    assert all(after['_workspace_jobs/' + job]['company_id'] == 'adr' for job in (ID, DRAFT))

    # The former owner can later be given a staff role, and then has only that role's access.
    assert (
        client.put(
            '/api/companies/adr/team/owner',
            json={'expected_version': 2, 'role': 'estimator', 'status': 'active'},
        ).status_code
        == 200
    )
    current['uid'] = 'owner'
    allowed = {'company', 'jobs', 'draft', 'documents'}
    for name, method, path, body in owner_routes(store, staff_invitation):
        response = client.request(method, path, json=body)
        expected = (200,) if name in allowed else (403, 404)
        assert response.status_code in expected, (name, response.status_code, response.text)
    assert [j['inspection_id'] for j in client.get('/api/inspections').json()['inspections']] == [
        DRAFT
    ]
    assert client.get('/api/authorizations').json()['authorizations'] == []
    assert active_owners(store) == ['successor']

    created = [e for e in events(store, 'invitation_created') if e['details']['role'] == 'owner']
    assert [(e['actor_uid'], e['details']['invitation_id']) for e in created] == [
        ('admin', invitation['invitation_id']),
        ('admin', competing['invitation_id']),
    ]
    accepted = [e for e in events(store, 'invitation_accepted') if e['actor_uid'] == 'successor']
    assert [e['details'] for e in accepted] == [{'role': 'owner', 'previous_owner_uid': 'owner'}]
    assert [(e['actor_uid'], e['details']) for e in events(store, 'member_access')][-1] == (
        'successor',
        {'uid': 'owner', 'role': 'estimator', 'status': 'active'},
    )
    assert all(e['company_id'] == 'adr' for e in created + accepted)


@pytest.mark.parametrize('ending', ['expired', 'cancelled'])
def test_expired_or_cancelled_owner_invitation_changes_nothing(mail, ending):
    client, current, store, accounts, sent, _ = mail
    del store.db.records['_platform_admins/owner']
    current['uid'] = 'admin'
    invitation = client.post(
        '/api/companies/adr/invitations',
        json={'email': 'successor@example.invalid', 'role': 'owner'},
    ).json()
    path = '/api/companies/adr/invitations/' + invitation['invitation_id']
    if ending == 'expired':
        store.db.records['_invitations/' + invitation['invitation_id']]['expires_at'] = 0
    else:
        assert client.post(path + '/cancel').status_code == 200
    before = unrestricted(store)
    current['uid'] = 'successor'
    response = client.post('/api/invitations/' + invitation['invitation_id'] + '/accept')
    assert response.status_code == 409 and 'expired or cancelled' in response.json()['detail']
    assert unrestricted(store) == before
    assert (
        active_owners(store) == ['owner']
        and store.workspaces.principal('successor')['role'] is None
    )
    if ending == 'cancelled':
        current['uid'] = 'admin'
        assert client.post(path + '/resend').status_code == 409


def test_owner_cannot_transfer_disable_or_demote_themselves(mail):
    client, current, store, accounts, sent, _ = mail
    del store.db.records['_platform_admins/owner']
    current['uid'] = 'owner'
    before = unrestricted(store)
    attempts = [
        ('POST', '/api/companies/adr/invitations', {'email': 'x@example.invalid', 'role': 'owner'}),
        (
            'PUT',
            '/api/companies/adr/team/owner',
            {'expected_version': 1, 'role': 'estimator', 'status': 'disabled'},
        ),
        (
            'PUT',
            '/api/companies/adr/team/owner',
            {'expected_version': 1, 'role': 'office', 'status': 'active'},
        ),
    ]
    for method, path, body in attempts:
        response = client.request(method, path, json=body)
        assert response.status_code == 403, (path, body, response.text)
    assert unrestricted(store) == before and not sent
    # A staff invitation to the owner's own email cannot demote the active owner either.
    staff = client.post(
        '/api/companies/adr/invitations', json={'email': 'owner@example.invalid', 'role': 'office'}
    ).json()
    assert client.post('/api/invitations/' + staff['invitation_id'] + '/accept').status_code == 409
    assert active_owners(store) == ['owner']
    assert store.db.records['_memberships/owner']['role'] == 'owner'


def test_staff_member_promoted_to_owner_leaves_one_owner(store):
    w = store.workspaces
    invitation = w.invite('admin', 'adr', 'estimator2@example.invalid', 'owner')
    assert w.accept(identity('estimator2'), invitation['invitation_id'])['role'] == 'owner'
    assert active_owners(store) == ['estimator2']
    assert store.db.records['_memberships/estimator2']['version'] == 2
    assert w.principal('owner')['role'] is None
    assert 'team_manage' in w.principal('estimator2')['capabilities']


# Permission changes during a Live walkthrough, at the production 20-second recheck.


class LiveHarness:
    """Real identity, membership and job checks around a fake Vertex session.

    Each heartbeat parks until the test ticks it; a tick moves the virtual clock forward by the
    full LIVE_RECHECK_SECONDS. The log orders Vertex calls against the first refused check."""

    def __init__(self, store, monkeypatch):
        self.store = store
        self.now = 1_000_000.0
        self.parked = 0
        self.ticks = 0
        self.revoked = set()
        self.log = []
        self.connects = 0
        harness = self

        async def sleep(seconds):
            if seconds != bm.LIVE_RECHECK_SECONDS:
                return await asyncio.sleep(seconds)
            harness.parked += 1
            while harness.ticks < harness.parked:
                await asyncio.sleep(0.002)
            harness.now += seconds

        def verify_id_token(token, app=None, check_revoked=False):
            if check_revoked and token in harness.revoked:
                raise ValueError('Synthetic revoked account')
            return {**identity(token), 'exp': harness.now + 3000}

        class Session:
            async def send_client_content(self, **kwargs):
                pass

            async def send_realtime_input(self, **kwargs):
                harness.log.append('vertex ' + next(iter(kwargs)))

            async def receive(self):
                yield SimpleNamespace(
                    server_content=None,
                    session_resumption_update=SimpleNamespace(
                        new_handle='synthetic-private', resumable=True
                    ),
                )
                await asyncio.Event().wait()

        from contextlib import asynccontextmanager

        @asynccontextmanager
        async def connect(**kwargs):
            harness.connects += 1
            harness.log.append('vertex connect')
            yield Session()

        async def close():
            harness.log.append('vertex closed')

        def refused(call):
            async def wrapped(*args, **kwargs):
                try:
                    return await call(*args, **kwargs)
                except bm.HTTPException as error:
                    if error.status_code in (401, 403, 404):
                        harness.log.append('refused')
                    raise

            return wrapped

        clock = asyncio.__dict__ | {'sleep': sleep}
        monkeypatch.setattr(bm, 'asyncio', SimpleNamespace(**clock))
        monkeypatch.setattr(
            bm, 'time', SimpleNamespace(time=lambda: harness.now, monotonic=time.monotonic)
        )
        monkeypatch.setattr(bm, 'LIVE_RECHECK_SECONDS', 20)
        monkeypatch.setattr(bm, 'REVOCATION_CACHE_SECONDS', 45)
        monkeypatch.setattr(bm, 'revocation_checked', type(bm.revocation_checked)())
        monkeypatch.setattr(bm.firebase_admin, 'get_app', lambda name: object())
        monkeypatch.setattr(bm.firebase_auth, 'verify_id_token', verify_id_token)
        monkeypatch.setattr(bm, 'WORKSPACES_ENABLED', True)
        monkeypatch.setattr(bm, 'get_job_store', lambda: store)
        monkeypatch.setattr(bm, 'verify_staff', refused(bm.verify_staff))
        monkeypatch.setattr(bm, 'stored', refused(bm.stored))
        monkeypatch.setattr(
            bm.genai,
            'Client',
            lambda **kwargs: SimpleNamespace(
                aio=SimpleNamespace(live=SimpleNamespace(connect=connect), aclose=close)
            ),
        )

    def until(self, condition, what):
        deadline = time.monotonic() + 5
        while not condition():
            assert time.monotonic() < deadline, what
            time.sleep(0.002)

    def tick(self):
        """Let the parked heartbeat run once, then wait until it parks again or the session ends."""
        self.ticks += 1
        self.until(
            lambda: self.parked > self.ticks or 'vertex closed' in self.log, 'heartbeat finished'
        )

    def start(self, socket, uid, resume=False):
        socket.send_json(
            {
                'type': 'authenticate',
                'token': uid,
                'inspection_id': ID,
                'protocol_version': 2,
                'workspace_protocol_version': 1,
                'capture_id': 'f' * 32,
                'resume': resume,
            }
        )


LIVE_LOSSES = [
    'member disabled',
    'role changed to office',
    'job reassigned away',
    'company suspended',
    'membership removed',
    'account revoked',
    'owner replaced',
    'superadmin owner replaced',
]


def live_participant(store, change):
    """Creates the job and returns who runs Live for this change."""
    if 'owner' in change:
        if change == 'owner replaced':
            del store.db.records['_platform_admins/owner']
        store.create_inspection('owner', ID, data())
        return 'owner'
    store.create_inspection('estimator', ID, data())
    if change == 'job reassigned away':
        store.workspaces.coordination(
            'owner', ID, CoordinationUpdate(expected_version=1, assigned_estimator_uid='estimator2')
        )
        return 'estimator2'
    return 'estimator'


def apply_loss(harness, change):
    w = harness.store.workspaces
    if change == 'member disabled':
        w.update_member(
            'owner',
            'adr',
            'estimator',
            MemberUpdate(expected_version=1, role='estimator', status='disabled'),
        )
    elif change == 'role changed to office':
        w.update_member(
            'owner',
            'adr',
            'estimator',
            MemberUpdate(expected_version=1, role='office', status='active'),
        )
    elif change == 'job reassigned away':
        w.coordination('owner', ID, CoordinationUpdate(expected_version=2))
    elif change == 'company suspended':
        w.update_company('admin', 'adr', StatusUpdate(expected_version=1, status='suspended'))
    elif change == 'membership removed':
        del harness.store.db.records['_memberships/estimator']
    elif change == 'account revoked':
        harness.revoked.add('estimator')
    else:
        # The owner is live while a superadmin replacement is accepted.
        invitation = w.invite('admin', 'adr', 'successor@example.invalid', 'owner')
        w.accept(identity('successor'), invitation['invitation_id'])


@pytest.mark.parametrize('change', LIVE_LOSSES)
def test_live_permission_loss_ends_session_at_next_recheck_and_refuses_resume(
    store, monkeypatch, change
):
    """A change that ends access cuts Live at the first 20-second recheck after it: no Vertex call
    follows the refusal, the checkpoint and lease are deleted and a resume is refused before Vertex."""
    from starlette.websockets import WebSocketDisconnect

    uid = live_participant(store, change)
    harness = LiveHarness(store, monkeypatch)
    audio = {'type': 'audio', 'data': base64.b64encode(bytes(3200)).decode()}
    with TestClient(bm.app) as client:
        with client.websocket_connect('/api/live', headers={'origin': bm.ORIGINS[0]}) as socket:
            harness.start(socket, uid)
            assert socket.receive_json()['type'] == 'ready'
            harness.until(
                lambda: store.db.records.get('_live_resume/' + uid, {}).get('handle'),
                'checkpoint saved',
            )
            harness.until(lambda: harness.parked == 1, 'first heartbeat parked')
            socket.send_json(audio)
            harness.until(lambda: 'vertex audio' in harness.log, 'audio reached Vertex')
            apply_loss(harness, change)
            # The technician keeps streaming while the recheck runs.
            for _ in range(10):
                socket.send_json(audio)
            harness.tick()
            assert harness.parked == 1, 'Access must end at the first recheck after the change'
            message = socket.receive_json()
            assert message['type'] == 'error' and message['status'] in (401, 403, 404), message
            with pytest.raises(WebSocketDisconnect):
                socket.receive_json()
    refused = harness.log.index('refused')
    assert [e for e in harness.log[refused:] if e.startswith('vertex ')] == ['vertex closed']
    assert '_live_resume/' + uid not in store.db.records
    assert '_live_sessions/' + uid not in store.db.records

    with TestClient(bm.app) as client:
        with client.websocket_connect('/api/live', headers={'origin': bm.ORIGINS[0]}) as socket:
            harness.start(socket, uid, resume=True)
            message = socket.receive_json()
            assert message['type'] == 'error' and message['status'] in (401, 403, 404), message
            with pytest.raises(WebSocketDisconnect):
                socket.receive_json()
    assert harness.connects == 1
    assert not any(k.startswith(('_live_sessions/', '_live_resume/')) for k in store.db.records)


LIVE_KEEPS = {
    'same role saved again': lambda w: w.update_member(
        'owner',
        'adr',
        'estimator',
        MemberUpdate(expected_version=1, role='estimator', status='active'),
    ),
    'job also assigned to another estimator': lambda w: w.coordination(
        'owner', ID, CoordinationUpdate(expected_version=1, assigned_estimator_uid='estimator2')
    ),
    'company profile changed': lambda w: w.update_company(
        'owner',
        'adr',
        ProfileUpdate(
            expected_version=1, profile=CompanyProfile(**{**ADR_PROFILE, 'phone': '555-0101'})
        ),
    ),
    'another member disabled': lambda w: w.update_member(
        'owner', 'adr', 'office', MemberUpdate(expected_version=1, role='office', status='disabled')
    ),
    'owner replaced': lambda w: w.accept(
        identity('successor'),
        w.invite('admin', 'adr', 'successor@example.invalid', 'owner')['invitation_id'],
    ),
}


@pytest.mark.parametrize('change', LIVE_KEEPS)
def test_live_permission_change_that_keeps_access_keeps_the_session(store, monkeypatch, change):
    store.create_inspection('estimator', ID, data())
    harness = LiveHarness(store, monkeypatch)
    with TestClient(bm.app) as client:
        with client.websocket_connect('/api/live', headers={'origin': bm.ORIGINS[0]}) as socket:
            harness.start(socket, 'estimator')
            assert socket.receive_json()['type'] == 'ready'
            harness.until(lambda: harness.parked == 1, 'first heartbeat parked')
            LIVE_KEEPS[change](store.workspaces)
            harness.tick()
            harness.tick()
            assert harness.parked == 3 and 'refused' not in harness.log
            socket.send_json({'type': 'end', 'preserve_resume': True})
            assert socket.receive_json() == {'type': 'finished', 'complete': True}
    assert 'refused' not in harness.log and harness.connects == 1
    assert store.db.records['_live_resume/estimator']['handle'] == 'synthetic-private'


def test_session_supplies_historical_identity_without_mutating_current_profile(api):
    client, current, store = api
    store.db.records['_companies/adr']['profile']['signoff'] = 'New Estimator'
    session = client.get('/api/session').json()
    assert session['legacy_identity'] == workspaces.LEGACY_IDENTITY
    assert session['legacy_identity']['signoff'] == ADR_PROFILE['signoff']
    assert session['legacy_identity']['logo_data_url'].startswith('data:image/jpeg;base64,')
    assert session['company']['profile']['signoff'] == 'New Estimator'


# Owner logins with a temporary password: the superadmin alternative to an owner invitation.
def owner_events(store, action='owner_login_created'):
    return [
        v
        for k, v in store.db.records.items()
        if k.startswith('_admin_events/') and v['action'] == action
    ]


def create_owner_login(client, email='new-owner@example.invalid', company='other', **changes):
    body = {'email': email, 'password': TEMPORARY, 'expected_version': 1, **changes}
    return client.post('/api/admin/companies/' + company + '/owner-login', json=body)


def test_owner_login_replaces_the_owner_like_an_accepted_owner_invitation(mail):
    client, current, store, accounts, sent, _ = mail
    w = store.workspaces
    pending = w.invite('admin', 'other', 'invited-owner@example.invalid', 'owner')
    staff = w.invite('other-owner', 'other', 'other-office@example.invalid', 'office')
    current['uid'] = 'admin'
    response = create_owner_login(client)
    assert response.status_code == 200, response.text
    assert TEMPORARY not in response.text
    result = response.json()
    assert result['owner'] == {'uid': 'new-owner', 'email': 'new-owner@example.invalid'}
    records = store.db.records
    account = accounts.users['new-owner@example.invalid']
    assert account.password == TEMPORARY and account.email_verified
    assert account.custom_claims == {'password_change_required': True}
    assert records['_memberships/new-owner'] == {
        'uid': 'new-owner',
        'email': 'new-owner@example.invalid',
        'company_id': 'other',
        'role': 'owner',
        'status': 'active',
        'version': 1,
        'updated_at': records['_memberships/new-owner']['updated_at'],
        'password_change_required': True,
    }
    assert records['_memberships/other-owner']['status'] == 'disabled'
    assert records['_memberships/other-owner']['version'] == 2
    company = records['_companies/other']
    assert company['owner_uid'] == 'new-owner' and company['version'] == 2
    assert result['company']['owner_uid'] == 'new-owner'
    # Pending owner invitations end; staff invitations from before stay.
    assert records['_invitations/' + pending['invitation_id']]['status'] == 'cancelled'
    assert records['_invitations/' + staff['invitation_id']]['status'] == 'pending'
    [event] = owner_events(store)
    assert event['actor_uid'] == 'admin' and event['company_id'] == 'other'
    assert event['target'] == 'member/new-owner'
    assert event['details'] == {
        'email': 'n***@example.invalid',
        'replacement': True,
        'previous_owner_uid': 'other-owner',
        'cancelled_invitations': 1,
    }
    assert not sent and not accounts.links


def test_owner_login_creates_a_company_without_an_invitation(mail):
    client, current, store, accounts, sent, _ = mail
    current['uid'] = 'admin'
    response = client.post(
        '/api/admin/companies',
        json={
            'name': 'Valley Dry',
            'owner_email': 'Valley-Owner@Example.invalid',
            'owner_password': TEMPORARY,
        },
    )
    assert response.status_code == 200, response.text
    assert TEMPORARY not in response.text
    company = response.json()['company']
    cid = company['company_id']
    assert company['profile']['name'] == 'Valley Dry'
    assert company['owner_uid'] == 'valley-owner' and company['version'] == 1
    assert store.db.records['_companies/' + cid] == company
    assert store.db.records['_memberships/valley-owner']['company_id'] == cid
    assert not [k for k in store.db.records if k.startswith('_invitations/')]
    [event] = owner_events(store)
    assert event['details']['replacement'] is False and event['company_id'] == cid
    assert not sent
    current['uid'] = 'valley-owner'
    session = client.get('/api/session')
    assert session.status_code == 403
    assert session.json() == {'detail': workspaces.PASSWORD_CHANGE_REQUIRED}


def test_owner_login_sets_the_password_on_an_invited_account_and_ends_its_invitation(mail):
    """The account an owner invitation provisioned, without a password yet, takes the temporary one."""
    client, current, store, accounts, sent, _ = mail
    current['uid'] = 'admin'
    invited = client.post(
        '/api/companies/other/invitations',
        json={'email': 'invited-owner@example.invalid', 'role': 'owner'},
    ).json()
    assert accounts.users['invited-owner@example.invalid'].provider_data == []
    response = create_owner_login(client, 'invited-owner@example.invalid')
    assert response.status_code == 200, response.text
    account = accounts.users['invited-owner@example.invalid']
    assert account.password == TEMPORARY and account.email_verified
    assert account.custom_claims == {'password_change_required': True}
    invitation = store.db.records['_invitations/' + invited['invitation_id']]
    assert invitation['status'] == 'cancelled'
    current['uid'] = 'invited-owner'
    assert (
        client.post('/api/invitations/' + invited['invitation_id'] + '/accept').status_code == 403
    )


REFUSED_LOGINS = {
    'member email': ('estimator@example.invalid', {}, 409, 'already has company access'),
    'Google account': ('google-owner@example.invalid', {}, 409, 'signs in with Google'),
    'Google and password': ('both-owner@example.invalid', {}, 409, 'signs in with Google'),
    'disabled account': ('disabled-owner@example.invalid', {}, 409, 'disabled'),
    'short password': ('new-owner@example.invalid', {'password': 'x' * 11}, 400, '12 to 128'),
    'long password': ('new-owner@example.invalid', {'password': 'x' * 129}, 400, '12 to 128'),
    'invalid email': ('not-an-email', {}, 400, 'valid email'),
    'stale version': ('new-owner@example.invalid', {'expected_version': 2}, 409, 'Reload'),
    'suspended company': ('new-owner@example.invalid', {'company': 'paused'}, 403, 'active'),
    'unknown company': ('new-owner@example.invalid', {'company': 'missing'}, 404, 'not found'),
}


@pytest.mark.parametrize('case', REFUSED_LOGINS)
def test_owner_login_refusals_change_no_account_or_record(mail, case):
    client, current, store, accounts, sent, _ = mail
    store.db.records['_companies/paused'] = {
        **deepcopy(store.db.records['_companies/other']),
        'company_id': 'paused',
        'status': 'suspended',
    }
    accounts.add('estimator@example.invalid', 'password')
    accounts.add('google-owner@example.invalid', 'google.com')
    accounts.add('both-owner@example.invalid', 'password', 'google.com')
    accounts.add('disabled-owner@example.invalid', 'password', disabled=True)
    email, changes, status, message = REFUSED_LOGINS[case]
    current['uid'] = 'admin'
    before = unrestricted(store)
    response = create_owner_login(client, email, **changes)
    assert response.status_code == status, response.text
    assert message in response.json()['detail']
    assert 'x' * 11 not in response.text and TEMPORARY not in response.text
    assert unrestricted(store) == before
    assert not accounts.created and not accounts.updated and not sent


def test_owner_login_refuses_when_the_owner_changes_after_the_account_step(mail, monkeypatch):
    """An owner invitation accepted between the checks and the commit wins; nothing else changes."""
    client, current, store, accounts, sent, _ = mail
    w = store.workspaces
    invitation = w.invite('admin', 'other', 'rival@example.invalid', 'owner')
    provision = workspaces.set_temporary_password

    def accepted_meanwhile(*args):
        uid = provision(*args)
        w.accept(identity('rival'), invitation['invitation_id'])
        return uid

    monkeypatch.setattr(workspaces, 'set_temporary_password', accepted_meanwhile)
    current['uid'] = 'admin'
    response = create_owner_login(client)
    assert response.status_code == 409 and 'Reload' in response.json()['detail']
    records = store.db.records
    assert records['_companies/other']['owner_uid'] == 'rival'
    assert '_memberships/new-owner' not in records and not owner_events(store)
    # The account holds the password but grants nothing; a retry updates the same account.
    assert accounts.users['new-owner@example.invalid'].password == TEMPORARY
    assert create_owner_login(client, expected_version=2).status_code == 200
    assert records['_memberships/rival']['status'] == 'disabled'
    assert records['_companies/other']['owner_uid'] == 'new-owner'


def test_concurrent_owner_logins_for_one_account_leave_the_winners_password(mail, monkeypatch):
    """A second owner login for the same account while the first holds it changes no password."""
    client, current, store, accounts, sent, _ = mail
    w = store.workspaces
    accounts.add('invited-owner@example.invalid')
    provision = workspaces.set_temporary_password
    rivals = []

    def raced(*args):
        with pytest.raises(Conflict, match='in progress'):
            w.owner_login(
                'admin',
                None,
                'invited-owner@example.invalid',
                'synthetic-rival-00001',
                None,
                'Rival',
            )
        rivals.append(len(accounts.updated))
        return provision(*args)

    monkeypatch.setattr(workspaces, 'set_temporary_password', raced)
    current['uid'] = 'admin'
    response = create_owner_login(client, 'invited-owner@example.invalid')
    assert response.status_code == 200, response.text
    assert rivals == [0]
    account = accounts.users['invited-owner@example.invalid']
    assert account.password == TEMPORARY
    assert store.db.records['_companies/other']['owner_uid'] == 'invited-owner'
    assert not [k for k in store.db.records if k.startswith(workspaces.LOGIN_RESERVATIONS)]
    # Once the first commits, a later attempt is refused before touching the password.
    monkeypatch.setattr(workspaces, 'set_temporary_password', provision)
    later = create_owner_login(client, 'invited-owner@example.invalid', expected_version=2)
    assert later.status_code == 409 and 'already has company access' in later.json()['detail']
    assert account.password == TEMPORARY and len(accounts.updated) == 1


def test_owner_login_and_invitation_acceptance_for_one_account_cannot_both_win(mail, monkeypatch):
    client, current, store, accounts, sent, _ = mail
    w = store.workspaces
    accounts.add('invited-owner@example.invalid')
    invitation = w.invite('admin', 'adr', 'invited-owner@example.invalid', 'owner')
    provision = workspaces.set_temporary_password

    def accepted_meanwhile(*args):
        with pytest.raises(Conflict, match='owner login is being created'):
            w.accept(identity('invited-owner'), invitation['invitation_id'])
        return provision(*args)

    monkeypatch.setattr(workspaces, 'set_temporary_password', accepted_meanwhile)
    current['uid'] = 'admin'
    response = create_owner_login(client, 'invited-owner@example.invalid')
    assert response.status_code == 200, response.text
    records = store.db.records
    assert records['_memberships/invited-owner']['company_id'] == 'other'
    assert records['_companies/adr']['owner_uid'] == 'owner'
    assert accounts.users['invited-owner@example.invalid'].password == TEMPORARY
    # Acceptance that commits first wins; the owner login then changes no password.
    accounts.add('second-owner@example.invalid')
    second = w.invite('admin', 'adr', 'second-owner@example.invalid', 'owner')
    w.accept(identity('second-owner'), second['invitation_id'])
    monkeypatch.setattr(workspaces, 'set_temporary_password', provision)
    refused = create_owner_login(client, 'second-owner@example.invalid', expected_version=2)
    assert refused.status_code == 409 and 'already has company access' in refused.json()['detail']
    assert accounts.users['second-owner@example.invalid'].password is None


def test_reservation_is_not_reusable_while_the_bounded_password_write_can_run(mail, monkeypatch):
    """Even at the latest moment the bounded Firebase calls can still be running, the account stays held."""
    client, current, store, accounts, sent, _ = mail
    w = store.workspaces
    accounts.add('invited-owner@example.invalid')
    start = time.time()
    clock = SimpleNamespace(time=lambda: start, sleep=time.sleep, monotonic=time.monotonic)
    monkeypatch.setattr(workspaces, 'time', clock)
    provision = workspaces.set_temporary_password

    def slowest(*args):
        clock.time = lambda: start + 24 * workspaces.LOGIN_HTTP_SECONDS
        with pytest.raises(Conflict, match='in progress'):
            w.owner_login(
                'admin',
                None,
                'invited-owner@example.invalid',
                'synthetic-rival-00001',
                None,
                'Rival',
            )
        return provision(*args)

    monkeypatch.setattr(workspaces, 'set_temporary_password', slowest)
    current['uid'] = 'admin'
    response = create_owner_login(client, 'invited-owner@example.invalid')
    assert response.status_code == 200, response.text
    assert accounts.users['invited-owner@example.invalid'].password == TEMPORARY
    assert workspaces.LOGIN_RESERVATION_SECONDS >= 2 * 24 * workspaces.LOGIN_HTTP_SECONDS


@pytest.mark.parametrize('delay, status', [(0, 503), (3, 200)], ids=['retry-after', 'stalled'])
def test_owner_login_firebase_writes_neither_retry_nor_outlast_their_bound(
    monkeypatch, delay, status
):
    """Against a local Auth endpoint: a 503 asking for an hour's wait and a stalled reply each end the
    write after one request, within the configured timeout."""
    import threading
    import firebase_admin
    from firebase_admin import exceptions
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    hits = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            hits.append(self.path)
            time.sleep(delay)
            body = b'{}'
            self.send_response(status)
            self.send_header('Retry-After', '3600')
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    def forget_app():
        try:
            firebase_admin.delete_app(firebase_admin.get_app('adr-owner-login'))
        except ValueError:
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setenv('FIREBASE_AUTH_EMULATOR_HOST', '127.0.0.1:%d' % server.server_port)
    monkeypatch.setattr(workspaces, 'LOGIN_HTTP_SECONDS', 0.5)
    forget_app()
    try:
        started = time.monotonic()
        with pytest.raises(exceptions.FirebaseError):
            workspaces.set_temporary_password(
                SimpleNamespace(uid='owner', custom_claims=None), 'owner@example.invalid', TEMPORARY
            )
        assert time.monotonic() - started < 2.5
        assert len(hits) == 1
    finally:
        server.shutdown()
        server.server_close()
        forget_app()


def test_failed_password_write_releases_the_account_for_a_retry(mail, monkeypatch):
    client, current, store, accounts, sent, _ = mail
    provision = workspaces.set_temporary_password

    def unavailable(*args):
        raise RuntimeError('Synthetic Firebase outage')

    monkeypatch.setattr(workspaces, 'set_temporary_password', unavailable)
    current['uid'] = 'admin'
    before = unrestricted(store)
    assert create_owner_login(client).status_code == 503
    assert unrestricted(store) == before
    monkeypatch.setattr(workspaces, 'set_temporary_password', provision)
    assert create_owner_login(client).status_code == 200


def test_a_temporary_password_claim_without_a_membership_cannot_accept_an_invitation(
    mail, monkeypatch
):
    """If the membership step failed after Firebase took the temporary password, the claim alone
    still refuses every route, so the account cannot accept a pending owner invitation unchanged."""
    client, current, store, accounts, sent, _ = mail
    invitation = store.workspaces.invite('admin', 'other', 'stranded@example.invalid', 'owner')
    accounts.add('stranded@example.invalid', 'password')
    accounts.users['stranded@example.invalid'].custom_claims = {'password_change_required': True}
    real_verification(monkeypatch, current, accounts)
    current['uid'] = 'stranded'
    before = unrestricted(store)
    for method, path in (
        ('GET', '/api/invitations/' + invitation['invitation_id']),
        ('POST', '/api/invitations/' + invitation['invitation_id'] + '/accept'),
        ('GET', '/api/access'),
        ('GET', '/api/session'),
    ):
        response = client.request(method, path)
        assert response.status_code == 403, (path, response.text)
        assert response.json() == {'detail': workspaces.PASSWORD_CHANGE_REQUIRED}
    assert unrestricted(store) == before


def locked_identity(accounts, uid):
    """Claims as Firebase would issue them now: the account's current custom claims at top level."""
    user = accounts.get_user(uid)
    return {
        **identity(uid),
        'firebase': {'sign_in_provider': 'password'},
        **(user.custom_claims or {}),
    }


def real_verification(monkeypatch, current, accounts):
    for endpoint in (bm.current_staff, bm.current_identity, bm.account_identity):
        bm.app.dependency_overrides.pop(endpoint)
    monkeypatch.setattr(bm, 'revocation_checked', type(bm.revocation_checked)())
    monkeypatch.setattr(bm.firebase_admin, 'get_app', lambda name: object())
    monkeypatch.setattr(
        bm.firebase_auth,
        'verify_id_token',
        lambda *args, **kwargs: locked_identity(accounts, current['uid']),
    )


def member_routes():
    """Every authenticated HTTP route except the password change itself."""
    for route in bm.app.routes:
        path = getattr(route, 'path', '')
        if (
            not path.startswith('/api/')
            or not getattr(route, 'methods', None)
            or path in ('/api/health', '/api/sign', '/api/account/password')
            or path.startswith('/api/sign/')
        ):
            continue
        for method in route.methods - {'HEAD'}:
            yield method, re.sub(r'\{[^}]+\}', 'x', path)


def test_temporary_password_refuses_every_member_route_until_replaced(mail, monkeypatch):
    client, current, store, accounts, sent, _ = mail
    current['uid'] = 'admin'
    assert create_owner_login(client).status_code == 200
    real_verification(monkeypatch, current, accounts)
    current['uid'] = 'new-owner'
    before = unrestricted(store)
    routes = list(member_routes())
    assert len(routes) > 40
    for method, path in routes:
        response = client.request(method, path, json={} if method in ('POST', 'PUT') else None)
        assert response.status_code == 403, (method, path, response.text)
        assert response.json() == {'detail': workspaces.PASSWORD_CHANGE_REQUIRED}, (method, path)
    assert unrestricted(store) == before
    # Store checks refuse too, for callers that skip the request gate.
    w = store.workspaces
    actor = w.principal('new-owner')
    assert actor['password_change_required'] and not actor['role'] and not actor['capabilities']
    for check in (lambda: w.company_actor('new-owner'), lambda: w.admin('new-owner')):
        with pytest.raises(workspaces.PasswordChangeRequired):
            check()
    changed = client.post('/api/account/password', json={'password': CHOSEN})
    assert changed.status_code == 200 and changed.json() == {'password_changed': True}
    session = client.get('/api/session')
    assert session.status_code == 200, session.text
    assert session.json()['role'] == 'owner' and session.json()['company_id'] == 'other'
    assert not session.json()['password_change_required']


def test_superadmin_given_a_temporary_password_loses_support_access_until_replaced(mail):
    client, current, store, accounts, sent, _ = mail
    store.db.records['_platform_admins/new-owner'] = {'active': True}
    current['uid'] = 'admin'
    assert create_owner_login(client).status_code == 200
    current['uid'] = 'new-owner'
    for path in ('/api/admin/companies', '/api/companies/adr', '/api/admin/companies/adr/jobs'):
        response = client.get(path)
        assert response.status_code == 403
        assert response.json()['detail'] == workspaces.PASSWORD_CHANGE_REQUIRED


def test_live_refuses_a_temporary_password_before_vertex(mail, monkeypatch):
    from starlette.websockets import WebSocketDisconnect

    client, current, store, accounts, sent, _ = mail
    current['uid'] = 'admin'
    assert create_owner_login(client).status_code == 200
    real_verification(monkeypatch, current, accounts)
    current['uid'] = 'new-owner'
    monkeypatch.setattr(
        bm.genai, 'Client', lambda **kwargs: pytest.fail('Locked Live must not reach Vertex')
    )
    with client.websocket_connect('/api/live', headers={'origin': bm.ORIGINS[0]}) as socket:
        socket.send_json(
            {
                'type': 'authenticate',
                'token': 'synthetic',
                'inspection_id': OTHER,
                'protocol_version': 2,
                'capture_id': 'f' * 32,
                'workspace_protocol_version': 1,
            }
        )
        assert socket.receive_json()['type'] == 'error'
        with pytest.raises(WebSocketDisconnect):
            socket.receive_json()
    assert not any(k.startswith('_live_sessions/') for k in store.db.records)


def test_password_change_replaces_the_temporary_password_and_lifts_the_gate(mail, monkeypatch):
    client, current, store, accounts, sent, _ = mail
    current['uid'] = 'admin'
    assert create_owner_login(client).status_code == 200
    real_verification(monkeypatch, current, accounts)
    current['uid'] = 'new-owner'
    short = client.post('/api/account/password', json={'password': 'x' * 11})
    assert short.status_code == 400 and 'x' * 11 not in short.text
    account = accounts.users['new-owner@example.invalid']
    assert account.password == TEMPORARY
    assert client.post('/api/account/password', json={'password': CHOSEN}).status_code == 200
    assert account.password == CHOSEN and account.custom_claims == {}
    assert 'password_change_required' not in store.db.records['_memberships/new-owner']
    [event] = owner_events(store, 'temporary_password_replaced')
    assert event['actor_uid'] == 'new-owner' and event['company_id'] == 'other'
    assert event['details'] == {} and event['target'] == 'member/new-owner'
    # Once set, the password changes only through Forgot password.
    again = client.post('/api/account/password', json={'password': 'synthetic-another-0003'})
    assert again.status_code == 409 and 'Forgot password' in again.json()['detail']
    assert account.password == CHOSEN


def test_password_change_requires_a_password_sign_in(mail, monkeypatch):
    client, current, store, accounts, sent, _ = mail
    current['uid'] = 'admin'
    assert create_owner_login(client).status_code == 200
    current['uid'] = 'new-owner'
    # The api fixture signs everyone in with Google.
    response = client.post('/api/account/password', json={'password': CHOSEN})
    assert response.status_code == 403
    assert accounts.users['new-owner@example.invalid'].password == TEMPORARY


def test_password_change_keeps_the_gate_when_firebase_fails(mail, monkeypatch):
    """Firebase changes first, so a failure leaves the temporary password locked, never usable."""
    client, current, store, accounts, sent, _ = mail
    current['uid'] = 'admin'
    assert create_owner_login(client).status_code == 200
    real_verification(monkeypatch, current, accounts)
    current['uid'] = 'new-owner'

    def unavailable(*args, **kwargs):
        raise RuntimeError('Synthetic Firebase outage')

    monkeypatch.setattr(accounts, 'update_user', unavailable)
    assert client.post('/api/account/password', json={'password': CHOSEN}).status_code == 503
    assert store.db.records['_memberships/new-owner']['password_change_required']
    assert client.get('/api/session').status_code == 403


def test_password_change_recovers_a_claim_left_without_a_membership(mail, monkeypatch):
    """If the membership step failed after Firebase took the temporary password, the claim still lets
    the account choose its own password instead of staying on the change screen."""
    client, current, store, accounts, sent, _ = mail
    accounts.add('stranded@example.invalid', 'password')
    accounts.users['stranded@example.invalid'].custom_claims = {'password_change_required': True}
    real_verification(monkeypatch, current, accounts)
    current['uid'] = 'stranded'
    assert client.post('/api/account/password', json={'password': CHOSEN}).status_code == 200
    assert accounts.users['stranded@example.invalid'].custom_claims == {}
    assert '_memberships/stranded' not in store.db.records


def test_temporary_and_chosen_passwords_never_reach_logs_records_or_responses(
    mail, monkeypatch, caplog, capsys
):
    client, current, store, accounts, sent, writes = mail
    caplog.set_level(logging.DEBUG)
    current['uid'] = 'admin'
    responses = [
        create_owner_login(client),
        client.post(
            '/api/admin/companies',
            json={
                'name': 'Valley Dry',
                'owner_email': 'valley@example.invalid',
                'owner_password': TEMPORARY,
            },
        ),
        create_owner_login(client, 'x@example.invalid', password='short'),
    ]
    real_verification(monkeypatch, current, accounts)
    current['uid'] = 'new-owner'
    responses.append(client.post('/api/account/password', json={'password': CHOSEN}))
    responses.append(client.get('/api/session'))
    traced = '\n'.join(
        [r.text for r in responses]
        + writes
        + [json.dumps(store.db.records, default=str), caplog.text, *capsys.readouterr()]
    )
    for secret in (TEMPORARY, CHOSEN, 'short'):
        assert secret not in traced
    assert 'new-owner@example.invalid' not in json.dumps(
        [e['details'] for e in owner_events(store)]
    )


@pytest.mark.parametrize(
    'path, body',
    [
        (
            '/api/admin/companies/other/owner-login',
            {'email': 'n@example.invalid', 'password': TEMPORARY},
        ),
        ('/api/admin/companies', {'owner_email': 'n@example.invalid', 'owner_password': TEMPORARY}),
        (
            '/api/admin/companies/other/owner-login',
            {'password': TEMPORARY, 'expected_version': 'one'},
        ),
        ('/api/account/password', {'password': TEMPORARY, 'extra': True}),
    ],
)
def test_validation_errors_never_echo_a_password(api, path, body):
    client, current, store = api
    current['uid'] = 'admin'
    response = client.post(path, json=body)
    assert response.status_code == 422
    assert TEMPORARY not in response.text
    assert all('msg' in error and 'loc' in error for error in response.json()['detail'])
