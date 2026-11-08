from tests.test_workspaces import *  # noqa: F403


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
    migrate(w, {'legacy': 'legacy@example.invalid'}, 'legacy', 'Legacy Co', True)
    job = secured.db.records['_workspace_jobs/' + ID]
    job['office_notes'] = 'Keep coordination'
    job['assigned_estimator_uid'] = 'assigned'
    legacy.update_inspection('legacy', ID, 1, data('Changed by old production writer'))
    migrate(w, {'legacy': 'legacy@example.invalid'}, 'legacy', 'Legacy Co', True)
    job = secured.db.records['_workspace_jobs/' + ID]
    assert (
        job['address'] == 'Changed by old production writer'
        and job['office_notes'] == 'Keep coordination'
        and job['assigned_estimator_uid'] == 'assigned'
    )
    secured.create_inspection('legacy', OTHER, data('New company-aware job'))
    assert (
        migrate(w, {'legacy': 'legacy@example.invalid'}, 'legacy', 'Legacy Co', True)['create'] == 0
    )


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


def test_invitation_provisions_a_password_account_and_mails_only_its_set_password_link(mail):
    client, current, store, accounts, sent, writes = mail
    invited = client.post(
        '/api/companies/adr/invitations', json={'email': 'New@Example.invalid', 'role': 'office'}
    ).json()
    assert invited['delivery_status'] == 'sent'
    assert accounts.created == [{'email': 'new@example.invalid', 'email_verified': False}]
    assert [(l['email'], l['url'], l['in_app']) for l in accounts.links] == [
        ('new@example.invalid', 'https://alert-disaster-field-2026.web.app/app', False)
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
    assert cleared['audit'] is None and cleared['status'] == 'draft' and cleared['revision'] == 2
    named = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 2}).json()
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
        expected_revision=2,
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


def test_invitations_keep_their_headers_and_idempotency_key_on_the_shared_sender(smtp, monkeypatch):
    """Guards the invitation path through the sender it shares with document delivery."""
    client, store, accounts, sent, writes, connections, plan, sleeps = smtp
    monkeypatch.setattr(workspaces, 'password_setup_link', lambda email: None)
    requests = []
    original = workspaces.urllib.request.urlopen
    monkeypatch.setattr(
        workspaces.urllib.request,
        'urlopen',
        lambda request, timeout: requests.append(request) or original(request, timeout),
    )
    company = {'profile': {'name': 'Owner Chosen Name', 'email': 'office@example.invalid'}}
    workspaces.send_invitation(direct_invite(), company)
    monkeypatch.setenv('INVITATION_TRANSPORT', 'resend')
    workspaces.send_invitation(direct_invite(), company)
    message = connections[0]['server'].message
    assert list(message.keys()) == [
        'From',
        'To',
        'Subject',
        'Message-ID',
        'MIME-Version',
        'Content-Type',
    ]
    assert sorted(sent[0]) == ['attachments', 'from', 'html', 'subject', 'text', 'to']
    assert sent[0]['from'] == 'ADR <invite@example.invalid>'
    assert requests[0].get_header('Idempotency-key') == 'a' * 32 + '/' + 'b' * 32


def test_invitation_email_shows_the_company_logo_inline_and_explains_the_app():
    logo = workspaces.clean_logo(png())
    invite, company = branded(logo=logo)
    message = workspaces.invitation_email(invite, company, 'https://example.invalid/set?a=1&b=2')
    assert message['logo']['data'] == base64.b64decode(logo.partition(',')[2])
    assert (
        message['logo']['subtype'] == 'jpeg' and message['logo']['data'] != workspaces.DRYSCOPE_LOGO
    )
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
    # ADR has no built-in logo: without a saved one it gets DryScope's like every company.
    invite, adr = branded(name='Alert Disaster Restoration')
    message = workspaces.invitation_email(invite, {**adr, 'company_id': 'adr'}, None)
    assert message['logo']['data'] == workspaces.DRYSCOPE_LOGO
