from tests.test_workspaces import *  # noqa: F403


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
    accept = 'https://alert-disaster-field-2026.web.app/app?invite=' + 'a' * 32
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


@pytest.mark.parametrize('uid, allowed', [('owner', True), ('estimator', False), ('office', False)])
def test_only_the_owner_receives_quantity_notes_on_a_draft(api, uid, allowed):
    client, current, store = api
    store.create_inspection('estimator', ID, data())
    current['uid'] = 'estimator'
    client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
    saved = store.db.records['inspections/' + ID]['audit']['documents']
    with_note(saved)
    current['uid'] = uid
    assert ('quantity_notes_read' in client.get('/api/session').json()['capabilities']) is allowed
    opened = client.get('/api/inspections/' + ID)
    assert opened.status_code == 200, opened.text
    assert ('quantity_notes' in opened.json()['audit']['documents']) is allowed
    assert ('Synthetic override reason' in opened.text) is allowed
    # The audit route's answer for an audit it can reuse goes through the same check.
    if uid != 'office':
        audited = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
        assert audited.status_code == 200, audited.text
        assert ('quantity_notes' in audited.json()['audit']['documents']) is allowed
    # Omitting the note from a response leaves the saved record as it was.
    assert saved['quantity_notes'] == [QUANTITY_NOTE]


@pytest.mark.parametrize('uid, allowed', [('owner', True), ('estimator', False), ('office', False)])
def test_only_the_owner_receives_quantity_notes_on_a_signed_job(api, uid, allowed):
    client, current, store = api
    signed_job(client, current, store)
    with_note(store.db.records['inspections/' + ID]['audit']['documents'])
    with_note(store.db.records['authorizations/' + SIGNED]['documents'])
    current['uid'] = uid
    agreement = client.get('/api/authorizations/' + SIGNED)
    assert agreement.status_code == 200, agreement.text
    assert ('quantity_notes' in agreement.json()['documents']) is allowed
    inspection = client.get('/api/inspections/' + ID)
    assert inspection.status_code == 200, inspection.text
    assert ('Synthetic override reason' in inspection.text) is allowed


@pytest.mark.parametrize('uid', ['owner', 'estimator', 'office'])
def test_company_roles_keep_the_entered_overrides_in_the_job_data(api, uid):
    client, current, store = api
    signed_job(client, current, store)
    store.db.records['inspections/' + ID]['data']['quantity_overrides'] = OVERRIDES
    store.db.records['authorizations/' + SIGNED]['inspection']['quantity_overrides'] = OVERRIDES
    current['uid'] = uid
    assert client.get('/api/inspections/' + ID).json()['data']['quantity_overrides'] == OVERRIDES
    agreement = client.get('/api/authorizations/' + SIGNED).json()
    assert agreement['inspection']['quantity_overrides'] == OVERRIDES


def test_superadmin_support_never_receives_the_entered_overrides(api):
    client, current, store = api
    signed_job(client, current, store)
    inspection = store.db.records['inspections/' + ID]['data']
    agreement = store.db.records['authorizations/' + SIGNED]['inspection']
    inspection['quantity_overrides'] = agreement['quantity_overrides'] = OVERRIDES
    current['uid'] = 'admin'
    base = '/api/admin/companies/adr'
    for path in ('/jobs/' + ID, '/authorizations/' + SIGNED):
        opened = client.get(base + path)
        assert opened.status_code == 200, opened.text
        assert 'Synthetic entered reason' not in opened.text
    assert client.get(base + '/jobs/' + ID).json()['inspection']['data']['address']
    # The saved records keep what was entered.
    assert inspection['quantity_overrides'] == agreement['quantity_overrides'] == OVERRIDES


def test_superadmin_support_never_receives_quantity_notes(api):
    client, current, store = api
    signed_job(client, current, store)
    with_note(store.db.records['inspections/' + ID]['audit']['documents'])
    with_note(store.db.records['authorizations/' + SIGNED]['documents'])
    current['uid'] = 'admin'
    base = '/api/admin/companies/adr'
    for path in ('/jobs/' + ID, '/authorizations/' + SIGNED):
        opened = client.get(base + path)
        assert opened.status_code == 200, opened.text
        assert 'Synthetic override reason' not in opened.text


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


def test_job_lists_name_the_customer_and_claim_only_within_the_company(api):
    client, current, store = api
    signed_job(client, current, store)
    draft = 'ADR-INS-' + 'e' * 32
    current['uid'] = 'owner'
    assert (
        client.post('/api/inspections', json={'inspection_id': draft, 'data': data()}).status_code
        == 200
    )
    store.db.records['_workspace_jobs/' + draft].update(
        customer_name=' Draft Customer ', claim={'claim_number': 'CLM-DRAFT-1'}
    )
    store.db.records['_workspace_jobs/' + OTHER].update(
        customer_name='Foreign Customer', claim={'claim_number': 'CLM-FOREIGN-9'}
    )
    expected = {
        draft: ('Draft Customer', 'CLM-DRAFT-1'),
        ID: ('Synthetic Customer Name', ''),
    }

    def names(rows, key):
        return {r[key]: (r['customer_name'], r['claim_number']) for r in rows}

    for uid in ('owner', 'office'):
        current['uid'] = uid
        assert names(client.get('/api/inspections').json()['inspections'], 'inspection_id') == (
            expected
        )
        assert names(client.get('/api/authorizations').json()['authorizations'], 'auth_id') == {
            SIGNED: expected[ID]
        }
    # The estimator sees only their own job, and its listing carries only that job's names.
    current['uid'] = 'estimator'
    assert names(client.get('/api/inspections').json()['inspections'], 'inspection_id') == {
        ID: expected[ID]
    }
    current['uid'] = 'admin'
    base = '/api/admin/companies/adr'
    assert names(client.get(base + '/jobs').json()['inspections'], 'inspection_id') == expected
    assert names(client.get(base + '/authorizations').json()['authorizations'], 'auth_id') == {
        SIGNED: expected[ID]
    }
    for uid in ('owner', 'office', 'estimator', 'admin'):
        current['uid'] = uid
        for path in ('/api/inspections', '/api/authorizations', base + '/jobs'):
            listed = client.get(path)
            if listed.status_code == 200:
                assert 'Foreign' not in listed.text and 'CLM-FOREIGN' not in listed.text
    current['uid'] = 'other-owner'
    assert names(client.get('/api/inspections').json()['inspections'], 'inspection_id') == {
        OTHER: ('Foreign Customer', 'CLM-FOREIGN-9')
    }


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
        'tag photo': client.put(
            '/api/inspections/' + ID + '/photos/' + PHOTO + '/shot',
            json={'expected_revision': 2, 'shot': 'overview'},
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
