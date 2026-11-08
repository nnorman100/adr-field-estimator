import backend.main as bm
import backend.workspaces as workspaces
import base64
import pytest
import time
from backend.inspection_store import Conflict
from backend.workspaces import AccessDenied
from copy import deepcopy
from fastapi.testclient import TestClient
from types import SimpleNamespace
from tests.test_workspaces import (
    CHOSEN,
    DRAFT,
    FORGED_CLAIMS,
    FORGED_HEADERS,
    ID,
    LIVE_KEEPS,
    LIVE_LOSSES,
    LiveHarness,
    OTHER,
    REFUSED_LOGINS,
    SIGNED,
    TEMPORARY,
    active_owners,
    apply_loss,
    assert_refused,
    company_records,
    create_owner_login,
    data,
    events,
    identity,
    live_participant,
    member_routes,
    owner_events,
    owner_routes,
    real_verification,
    revoke_admin,
    revoked,
    superadmin_gate,
    superadmin_tools,
    transfer_setup,
    unrestricted,
)
from tests.test_workspaces import (  # noqa: F401  (pytest fixtures)
    store,
    api,
    mail,
)


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


def test_session_carries_no_built_in_company_identity(api):
    client, current, store = api
    # ADR as an ordinary company that has entered only its name.
    store.db.records['_companies/adr']['profile'] = workspaces.WorkspaceStore.new_company(
        'Alert Disaster Restoration'
    )['profile']
    session = client.get('/api/session').json()
    assert 'legacy_identity' not in session
    assert session['company']['profile']['signoff'] == ''
    for value in ['Matthew Myers', '950983', 'Bakersfield', '426-2151', 'adr-logo', 'data:image']:
        assert value not in str(session)


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
