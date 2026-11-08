from tests.test_workspaces import *  # noqa: F403


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
    response = client.post('/api/account/password', json={'password': CHOSEN})
    assert response.status_code == 503
    assert response.json() == {'detail': 'Your password could not be changed. Try again.'}
    assert store.db.records['_memberships/new-owner']['password_change_required']
    assert client.get('/api/session').status_code == 403


@pytest.mark.parametrize(
    'route, message',
    [
        ('replace', 'The owner login could not be created. Try again or contact support.'),
        ('create', 'The owner login could not be created. Try again or contact support.'),
        ('password', 'Your password could not be changed. Try again.'),
    ],
)
def test_quota_failure_names_the_account_action(mail, monkeypatch, route, message):
    client, current, store, accounts, sent, _ = mail
    current['uid'] = 'admin'
    if route == 'password':
        assert create_owner_login(client).status_code == 200
        real_verification(monkeypatch, current, accounts)
        current['uid'] = 'new-owner'

    def unavailable(*args, **kwargs):
        raise RuntimeError('Synthetic Firestore outage')

    monkeypatch.setattr(store, 'quota', unavailable)
    if route == 'replace':
        response = create_owner_login(client)
    elif route == 'create':
        response = client.post(
            '/api/admin/companies',
            json={
                'name': 'Valley Dry',
                'owner_email': 'valley@example.invalid',
                'owner_password': TEMPORARY,
            },
        )
    else:
        response = client.post('/api/account/password', json={'password': CHOSEN})
    assert response.status_code == 503
    assert response.json() == {'detail': message}


def test_owner_login_membership_lookup_failure_names_the_action(mail, monkeypatch):
    client, current, store, accounts, sent, _ = mail
    current['uid'] = 'admin'
    real_verification(monkeypatch, current, accounts)
    monkeypatch.setattr(
        bm.firebase_auth, 'verify_id_token', lambda *args, **kwargs: identity('admin')
    )

    def unavailable(*args, **kwargs):
        raise RuntimeError('Synthetic Firestore outage')

    monkeypatch.setattr(store.workspaces, 'unlocked', unavailable)
    company = {'name': 'Valley Dry', 'owner_email': 'valley@example.invalid'}
    owner_login = 'The owner login could not be created. Try again or contact support.'
    generic = 'Changes could not be saved. Your local draft can be retried.'
    for response, message in (
        (create_owner_login(client), owner_login),
        (
            client.post('/api/admin/companies', json={**company, 'owner_password': TEMPORARY}),
            owner_login,
        ),
        (client.post('/api/admin/companies', json=company), generic),
        (client.get('/api/admin/companies'), generic),
    ):
        assert response.status_code == 503
        assert response.json() == {'detail': message}


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


@pytest.mark.parametrize('route', ['replace', 'create'])
def test_owner_login_failure_names_the_action_instead_of_a_draft_retry(mail, monkeypatch, route):
    """A Firebase or database failure (such as a missing permission) says the login was not created."""
    client, current, store, accounts, sent, _ = mail

    def denied(*args, **kwargs):
        raise RuntimeError('Synthetic permission denied')

    monkeypatch.setattr(accounts, 'create_user', denied)
    current['uid'] = 'admin'
    response = (
        create_owner_login(client)
        if route == 'replace'
        else client.post(
            '/api/admin/companies',
            json={
                'name': 'Valley Dry',
                'owner_email': 'valley@example.invalid',
                'owner_password': TEMPORARY,
            },
        )
    )
    assert response.status_code == 503
    assert response.json() == {
        'detail': 'The owner login could not be created. Try again or contact support.'
    }
    assert not owner_events(store)


def test_drying_readings_follow_job_access_and_the_scope_capability(api):
    client, current, store = api
    current['uid'] = 'estimator'
    assert (
        client.post('/api/inspections', json={'inspection_id': ID, 'data': data()}).status_code
        == 200
    )
    body = {
        'reading': {
            'kind': 'air',
            'room': 'Bathroom',
            'zone': 'affected',
            'temperature_f': 74,
            'relative_humidity': 72,
            'taken_at': '2026-10-21T15:00:00Z',
        }
    }
    saved = client.post('/api/inspections/' + ID + '/readings', json=body)
    assert saved.status_code == 200, saved.text
    [air] = saved.json()['readings']
    assert air['recorded_by'] == 'estimator@example.invalid' and air['gpp'] == 91
    # The owner records and removes readings on any company job.
    current['uid'] = 'owner'
    assert client.post('/api/inspections/' + ID + '/readings', json=body).status_code == 200
    assert client.delete('/api/inspections/' + ID + '/readings/' + air['id']).status_code == 200
    # Office staff read the log but cannot change it; the capability is the scope one.
    current['uid'] = 'office'
    log = client.get('/api/inspections/' + ID + '/readings')
    assert log.status_code == 200 and len(log.json()['readings']) == 1
    [kept] = log.json()['readings']
    assert client.post('/api/inspections/' + ID + '/readings', json=body).status_code == 403
    assert client.delete('/api/inspections/' + ID + '/readings/' + kept['id']).status_code == 403
    # An unassigned estimator, another company and a superadmin without membership see no job.
    for uid in ('estimator2', 'other-owner', 'admin'):
        current['uid'] = uid
        responses = [
            client.get('/api/inspections/' + ID + '/readings'),
            client.post('/api/inspections/' + ID + '/readings', json=body),
            client.delete('/api/inspections/' + ID + '/readings/' + kept['id']),
        ]
        assert all(r.status_code in (403, 404) for r in responses), [
            (uid, r.status_code, r.text) for r in responses
        ]
    current['uid'] = 'estimator'
    assert len(client.get('/api/inspections/' + ID + '/readings').json()['readings']) == 1
    # Readings are a sidecar: the job summary, revision and audit state are untouched.
    record = client.get('/api/inspections/' + ID).json()
    assert record['revision'] == 1 and record['audit'] is None
    assert 'readings' not in record and 'readings' not in store.db.records['_workspace_jobs/' + ID]


def test_copy_to_new_draft_carries_scope_and_claim_but_no_signed_evidence(api):
    client, current, store = api
    signed_job(client, current, store)
    current['uid'] = 'office'
    claim = dict(carrier='Synthetic Mutual', claim_number='CLM-77', date_of_loss='2026-10-01')
    assert (
        client.put(
            '/api/jobs/' + ID + '/claim', json={'expected_version': 0, 'claim': claim}
        ).status_code
        == 200
    )
    before = deepcopy(
        {k: v for k, v in store.db.records.items() if k.split('/')[1] in (ID, SIGNED)}
    )
    copied = copy_request(client)
    assert copied.status_code == 200
    draft = copied.json()
    assert draft['inspection_id'] == COPY and draft['status'] == 'draft' and draft['revision'] == 1
    assert draft['copied_from'] == dict(auth_id=SIGNED, inspection_id=ID)
    assert [(r['name'], r['finished_sf']) for r in draft['data']['rooms']] == [('Bathroom', 10)]
    assert draft['data']['air_movers'] == 3
    assert draft['data']['address'] == 'Test property' and draft['data']['scope_confirmed'] is False
    assert draft['photos'] == [] and draft['audit'] is None
    assert not {'authorization_id', 'auth_id', 'signature'} & draft.keys()
    job = store.db.records['_workspace_jobs/' + COPY]
    assert (
        job['claim']['claim_number'] == 'CLM-77' and job['claim']['carrier'] == 'Synthetic Mutual'
    )
    assert job['claim_version'] == 1 and not job['auth_exists'] and job['status'] == 'draft'
    assert job['customer_name'] == '' and job['customer_email'] == ''
    assert job['assigned_estimator_uid'] is None and job['creator_uid'] == 'office'
    # The signed job, its evidence and its sidecars are untouched.
    after = {k: v for k, v in store.db.records.items() if k.split('/')[1] in (ID, SIGNED)}
    assert after == before
    assert not store.db.records['_workspace_jobs/' + ID].get('copied_from')
    assert 'signing' not in json.dumps(draft).lower()
    # A retry with the same identifiers returns the same draft; another source conflicts.
    assert copy_request(client).json() == draft
    current['uid'] = 'owner'
    assert (
        client.put(
            '/api/inspections/' + COPY, json={'expected_revision': 1, 'data': data('Moved')}
        ).status_code
        == 200
    )
    assert client.get('/api/inspections/' + COPY).json()['copied_from'] == draft['copied_from']


@pytest.mark.parametrize(
    'uid, allowed',
    [
        ('owner', True),
        ('office', True),
        ('estimator', True),
        ('estimator2', False),
        ('admin', False),
        ('other-owner', False),
    ],
)
def test_copy_to_new_draft_roles(api, uid, allowed):
    client, current, store = api
    signed_job(client, current, store)
    current['uid'] = uid
    response = copy_request(client)
    assert (response.status_code == 200) is allowed
    if not allowed:
        assert response.status_code in (403, 404)
        assert 'inspections/' + COPY not in store.db.records
        assert '_workspace_jobs/' + COPY not in store.db.records
    # The session capabilities are what the app reads to show the action.
    capabilities = client.get('/api/session').json()['capabilities']
    assert ('jobs_copy' in capabilities) is (uid != 'admin')


def test_copy_to_new_draft_is_refused_for_older_records_without_a_saved_scope(api):
    client, current, store = api
    signed_job(client, current, store)
    del store.db.records['authorizations/' + SIGNED]['inspection']
    current['uid'] = 'owner'
    response = copy_request(client)
    assert response.status_code == 400 and 'older signed job' in response.json()['detail']
    assert 'inspections/' + COPY not in store.db.records
    assert copy_request(client, 'ADR-AUTH-missing').status_code == 404


def test_a_new_company_starts_with_delivery_off_and_no_crew_lead_email():
    profile = workspaces.WorkspaceStore.new_company('Valley Dry')['profile']
    assert profile['document_delivery'] is False and profile['crew_lead_email'] == ''


def test_older_company_profiles_gain_no_delivery_settings_until_the_owner_sets_them(api):
    client, current, store = api
    profile = client.get('/api/companies/adr').json()['profile']
    assert 'crew_lead_email' not in profile and 'document_delivery' not in profile
    response = client.put(
        '/api/companies/adr',
        json={'expected_version': 1, 'profile': {**ADR_PROFILE, 'phone': '555-0102'}},
    )
    assert response.status_code == 200, response.text
    saved = store.db.records['_companies/adr']['profile']
    assert saved['phone'] == '555-0102'
    assert 'crew_lead_email' not in saved and 'document_delivery' not in saved


def test_omitted_delivery_fields_keep_stored_values_and_a_bad_email_is_refused(api):
    client, current, store = api
    turned_on = {
        **ADR_PROFILE,
        'crew_lead_email': ' Lead@Crew.example.invalid ',
        'document_delivery': True,
    }
    assert (
        client.put(
            '/api/companies/adr', json={'expected_version': 1, 'profile': turned_on}
        ).status_code
        == 200
    )
    older = {**ADR_PROFILE, 'phone': '555-0199'}
    response = client.put('/api/companies/adr', json={'expected_version': 2, 'profile': older})
    assert response.status_code == 200, response.text
    saved = store.db.records['_companies/adr']['profile']
    assert saved['phone'] == '555-0199'
    assert saved['crew_lead_email'] == 'lead@crew.example.invalid'
    assert saved['document_delivery'] is True
    bad = {**ADR_PROFILE, 'crew_lead_email': 'not an email', 'document_delivery': False}
    response = client.put('/api/companies/adr', json={'expected_version': 3, 'profile': bad})
    assert response.status_code == 400
    assert response.json()['detail'] == 'Enter a valid crew-lead email address.'
    assert 'not an email' not in response.text
    assert saved['crew_lead_email'] == 'lead@crew.example.invalid'
    assert saved['document_delivery'] is True
    response = client.put(
        '/api/companies/adr',
        json={
            'expected_version': 3,
            'profile': {**ADR_PROFILE, 'document_delivery': 'true'},
        },
    )
    assert response.status_code == 422
    assert saved['document_delivery'] is True


def test_delivery_manage_is_required_to_change_the_switch_but_not_the_letterhead(api, monkeypatch):
    client, current, store = api
    monkeypatch.setitem(
        workspaces.CAPABILITIES,
        'owner',
        [cap for cap in workspaces.CAPABILITIES['owner'] if cap != 'delivery_manage'],
    )
    assert (
        client.put(
            '/api/companies/adr',
            json={'expected_version': 1, 'profile': {**ADR_PROFILE, 'phone': '555-0100'}},
        ).status_code
        == 200
    )
    response = client.put(
        '/api/companies/adr',
        json={
            'expected_version': 2,
            'profile': {
                **ADR_PROFILE,
                'phone': '555-0100',
                'document_delivery': True,
                'crew_lead_email': 'a@b.example.invalid',
            },
        },
    )
    assert response.status_code == 403
    assert response.json()['detail'] == 'Only the company owner can change document delivery.'
    saved = store.db.records['_companies/adr']['profile']
    assert saved['phone'] == '555-0100'
    assert 'document_delivery' not in saved and 'crew_lead_email' not in saved


@pytest.mark.parametrize(
    'uid, allowed',
    [
        ('owner', True),
        ('office', False),
        ('estimator', False),
        ('estimator2', False),
        ('admin', False),
        ('other-owner', False),
    ],
)
def test_only_the_owning_company_owner_sets_delivery(api, uid, allowed):
    client, current, store = api
    current['uid'] = uid
    response = client.put(
        '/api/companies/adr',
        json={
            'expected_version': 1,
            'profile': {
                **ADR_PROFILE,
                'crew_lead_email': 'Lead@Crew.example.invalid',
                'document_delivery': True,
            },
        },
    )
    session = client.get('/api/session').json()
    assert ('delivery_manage' in session['capabilities']) is (session.get('role') == 'owner')
    profile = store.db.records['_companies/adr']['profile']
    if allowed:
        assert response.status_code == 200, response.text
        assert profile['crew_lead_email'] == 'lead@crew.example.invalid'
        assert profile['document_delivery'] is True
        identity = store.workspaces.snapshot('owner')
        assert 'crew_lead_email' not in identity and 'document_delivery' not in identity
        events = [
            value
            for key, value in store.db.records.items()
            if key.startswith('_admin_events/') and value['action'] == 'company_profile'
        ]
        assert events[-1]['details'] == {'version': 2}
        assert 'lead@crew' not in json.dumps(events[-1])
    else:
        assert response.status_code in (403, 404)
        assert 'crew_lead_email' not in profile and 'document_delivery' not in profile


def test_another_companys_owner_sets_only_its_own_delivery_switch(api):
    client, current, store = api
    current['uid'] = 'other-owner'
    other = store.db.records['_companies/other']['profile']
    response = client.put(
        '/api/companies/other',
        json={
            'expected_version': 1,
            'profile': {
                **other,
                'crew_lead_email': 'other-lead@example.invalid',
                'document_delivery': True,
            },
        },
    )
    assert response.status_code == 200, response.text
    assert store.db.records['_companies/other']['profile']['document_delivery'] is True
    assert store.db.records['_companies/other']['profile']['crew_lead_email'] == (
        'other-lead@example.invalid'
    )
    adr = store.db.records['_companies/adr']['profile']
    assert 'document_delivery' not in adr and 'crew_lead_email' not in adr
    current['uid'] = 'owner'
    assert 'crew_lead_email' not in store.workspaces.snapshot('estimator')


def test_delivery_settings_do_not_enter_an_audit(api, monkeypatch):
    client, current, store = api

    async def generate(schema, *args, **kwargs):
        return AIResult(summary='Confirmed scope.', suggestions=[], unpriced_work=[])

    monkeypatch.setattr(bm, 'generate', generate)
    store.create_inspection('estimator', ID, data())
    current['uid'] = 'owner'
    saved = client.put(
        '/api/companies/adr',
        json={
            'expected_version': 1,
            'profile': {
                **ADR_PROFILE,
                'crew_lead_email': 'lead@crew.example.invalid',
                'document_delivery': True,
            },
        },
    )
    assert saved.status_code == 200, saved.text
    current['uid'] = 'estimator'
    documents = client.post(
        '/api/audit', json={'inspection_id': ID, 'expected_revision': 1}
    ).json()['audit']['documents']
    identity = documents['company_identity']
    assert 'crew_lead_email' not in identity and 'document_delivery' not in identity
    assert 'lead@crew.example.invalid' not in json.dumps(documents)
    assert '$' in documents['iicrc_defense_letter']
    assert documents['adr_estimate']['proposed_cost'] > 0


def test_copy_to_new_draft_drops_the_original_walkthrough_record(api):
    client, current, store = api
    signed_job(client, current, store)
    stored_data = store.db.records['authorizations/' + SIGNED]['inspection']
    stored_data.update(
        technician_transcript='heard on site',
        assistant_transcript='replied on site',
        package_price='legacy',
        equipment_scans=[
            dict(
                id='e' * 32,
                kind='air_mover',
                asset_id='AM-1',
                room='Bathroom',
                scanned_at='2026-10-14T12:00:00Z',
            )
        ],
        technician_notes='Crawl space is wet.',
    )
    current['uid'] = 'estimator'
    copied = copy_request(client).json()['data']
    assert copied['technician_transcript'] == '' and copied['assistant_transcript'] == ''
    assert 'equipment_scans' not in copied and copied['package_price'] is None
    assert copied['technician_notes'] == 'Crawl space is wet.'


def test_copy_to_new_draft_checks_the_role_again_where_the_draft_is_created(api):
    client, current, store = api
    signed_job(client, current, store)
    # An estimator removed from the job after the first check cannot create the copy.
    store.db.records['_workspace_jobs/' + ID]['accessible_estimator_uids'] = ['estimator2']
    with pytest.raises((AccessDenied, LookupError)):
        store.create_inspection(
            'estimator',
            COPY,
            data(),
            copied_from=dict(auth_id=SIGNED, inspection_id=ID),
        )
    assert 'inspections/' + COPY not in store.db.records
    # A forged marker from another company's user finds no job.
    with pytest.raises((AccessDenied, LookupError)):
        store.create_inspection(
            'other-owner', COPY, data(), copied_from=dict(auth_id=SIGNED, inspection_id=ID)
        )


def test_clear_paginates_past_hidden_rows_and_bounds_writes(store):
    w = store.workspaces
    template = w.invite('owner', 'adr', 'old@example.invalid', 'office')
    del store.db.records['_invitations/' + template['invitation_id']]
    for i in range(805):
        row = dict(template, invitation_id=f'{i:032x}', expires_at=0)
        store.db.records['_invitations/' + row['invitation_id']] = row
    assert len(w.invitations('owner', 'adr')) == 805
    assert w.clear_invitations('owner', 'adr') == {'cleared': 400}
    assert len(w.invitations('owner', 'adr')) == 405
    assert w.clear_invitations('owner', 'adr') == {'cleared': 400}
    assert w.clear_invitations('owner', 'adr') == {'cleared': 5}
    fresh = w.invite('owner', 'adr', 'fresh@example.invalid', 'office')
    assert w.invitations('owner', 'adr') == [fresh]


@pytest.mark.parametrize('actor', ['owner', 'admin'])
def test_resend_restores_cleared_expired_invitation_visibility(store, actor):
    w = store.workspaces
    invite = w.invite('owner', 'adr', 'renewed@example.invalid', 'office')
    store.db.records['_invitations/' + invite['invitation_id']]['expires_at'] = 0
    assert w.clear_invitations('owner', 'adr') == {'cleared': 1}
    renewed = w.invitation_action(actor, 'adr', invite['invitation_id'], 'resend')
    assert renewed['expires_at'] > time.time()
    assert 'cleared_at' not in renewed and 'cleared_by' not in renewed
    assert w.invitations('owner', 'adr') == [renewed]
    assert w.accept(identity('renewed'), invite['invitation_id'])['role'] == 'office'
