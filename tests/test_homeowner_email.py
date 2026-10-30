"""Homeowner document email after signing, against the fake SMTP server. No live inbox is contacted."""

import json
import re
import smtplib

import pytest

import backend.main as bm
from backend.delivery import NO_CREW_LEAD, NO_CUSTOMER_EMAIL, NOT_ASKED
from tests.fakes import ADR_PROFILE
from tests.test_backend import ID, audit, context, inspect, sign_payload
from tests.test_document_links import reader
from tests.test_signing_links import SIGNER, homeowner, mint, token
from tests.test_workspaces import api, data, mail, message_parts, smtp, store  # noqa: F401

CUSTOMER = 'home@example.invalid'
LINK = re.compile(r'https://\S+/documents#(\S+)')


def prepare(client, store, email=CUSTOMER):
    assert (
        client.put(
            '/api/companies/adr',
            json={
                'expected_version': 1,
                'profile': {
                    **ADR_PROFILE,
                    'email': 'Office@Alert.example.invalid',
                    'document_delivery': True,
                },
            },
        ).status_code
        == 200
    )
    created = client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    assert created.status_code == 200, created.text
    job = client.get('/api/jobs/' + ID + '/coordination').json()
    saved = client.put(
        '/api/jobs/' + ID + '/coordination',
        json={
            'expected_version': job['version'],
            'customer_name': 'Synthetic Customer',
            'customer_email': email,
        },
    )
    assert saved.status_code == 200, saved.text
    record = audit_job(client)
    return record


def audit_job(client):
    response = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
    assert response.status_code == 200, response.text
    return response.json()


def payload_for(record, **extra):
    body = dict(
        inspection_id=ID,
        expected_revision=record['revision'],
        auth_id='ADR-AUTH-homeowner1',
        proposal_hash=record['audit']['proposal_hash'],
        signature_png=sign_payload(record)['signature_png'],
        documents_confirmed=True,
    )
    body.update(extra)
    return body


def authorize(client, record, **extra):
    return client.post(
        '/api/authorize',
        json=payload_for(record, **extra),
        headers={'Origin': 'https://evil.example'},
    )


def delivery(store):
    return store.db.records['_job_deliveries/' + ID]


def test_a_ticked_box_emails_one_private_link_and_a_retry_does_not(smtp, capsys):
    client, store, _accounts, _sent, _writes, connections, plan, _sleeps = smtp
    record = prepare(client, store)
    first = authorize(client, record, email_copy=True)
    assert first.status_code == 200, first.text
    assert first.json()['status'] == 'success'
    saved = client.get('/api/authorizations/ADR-AUTH-homeowner1').json()
    assert saved['email_copy'] is True
    assert saved['documents']['iicrc_defense_letter']
    entry = delivery(store)['entries']
    assert entry['homeowner']['status'] == 'sent'
    assert {role: item['status'] for role, item in entry.items()} == {
        'homeowner': 'sent',
        'adjuster': 'skipped',
        'crew_lead': 'skipped',
    }
    assert entry['crew_lead']['reason'] == NO_CREW_LEAD
    assert len(connections) == 1
    message = connections[0]['server'].message
    assert message['To'] == CUSTOMER
    assert message['Reply-To'] == 'office@alert.example.invalid'
    text, page = message_parts(message)
    found = LINK.search(text)
    assert found, text
    token_value = found.group(1)
    assert f'/documents#{token_value}' in text
    assert 'Nothing is attached.' in text and 'Powered by DryScope' in text
    for value in (
        'Alert Disaster Restoration',
        ADR_PROFILE['address'],
        ADR_PROFILE['phone'],
        'Your signed proposal and photo log are ready.',
    ):
        assert value in text and value in page
    assert 'href="' + bm.ORIGINS[0] + '/documents#' in page
    assert all(part.get_content_type() != 'application/pdf' for part in message.walk())
    assert token_value not in json.dumps(store.db.records, default=str)
    view = reader(token_value).get('/api/documents')
    assert view.status_code == 200, view.text
    body = view.json()
    assert body['document_set'] == 'homeowner' and body['tabs'] == ['proposal', 'photos']
    assert body['documents']['adr_estimate']['proposed_cost']
    assert (
        body['documents']['xactimate_scope'] == []
        and body['documents']['iicrc_defense_letter'] == ''
    )
    # The signed choice sticks, and a second receipt does not send another copy.
    again = authorize(client, record, email_copy=False)
    assert again.status_code == 200 and again.json() == first.json()
    assert client.get('/api/authorizations/ADR-AUTH-homeowner1').json()['email_copy'] is True
    assert len(connections) == 1
    assert store.db.records['_email_counts/daily']['sent']['count'] == 1
    logged = capsys.readouterr().out
    for secret in (
        CUSTOMER,
        token_value,
        'Office@Alert',
        ADR_PROFILE['address'],
        'Synthetic Customer',
    ):
        assert secret not in logged


def test_an_unticked_box_is_skipped_and_recorded_with_the_signature(smtp):
    client, store, _accounts, _sent, _writes, connections, _plan, _sleeps = smtp
    record = prepare(client, store)
    response = authorize(client, record, email_copy=False)
    assert response.status_code == 200, response.text
    saved = client.get('/api/authorizations/ADR-AUTH-homeowner1').json()
    assert saved['email_copy'] is False
    homeowner_entry = delivery(store)['entries']['homeowner']
    assert (homeowner_entry['status'], homeowner_entry['reason']) == ('skipped', NOT_ASKED)
    assert not connections
    # A later tick on the same receipt does not start sending.
    assert authorize(client, record, email_copy=True).status_code == 200
    assert delivery(store)['entries']['homeowner']['status'] == 'skipped'
    assert not connections


def test_a_ticked_box_with_no_customer_email_is_skipped(smtp):
    client, store, _accounts, _sent, _writes, connections, _plan, _sleeps = smtp
    record = prepare(client, store, email='')
    response = authorize(client, record, email_copy=True)
    assert response.status_code == 200, response.text
    homeowner_entry = delivery(store)['entries']['homeowner']
    assert (homeowner_entry['status'], homeowner_entry['reason']) == ('skipped', NO_CUSTOMER_EMAIL)
    assert not connections and '_email_counts/daily' not in store.db.records


def test_a_failed_send_still_signs_and_a_retry_sends_once(smtp):
    client, store, _accounts, _sent, _writes, connections, plan, _sleeps = smtp
    record = prepare(client, store)
    plan.append(('send', smtplib.SMTPDataError(554, b'5.6.0 Message rejected')))
    failed = authorize(client, record, email_copy=True)
    assert failed.status_code == 200, failed.text
    entry = delivery(store)['entries']['homeowner']
    assert (entry['status'], entry['retryable']) == ('failed', True)
    assert len(connections) == 1
    retried = authorize(client, record, email_copy=True)
    assert retried.status_code == 200 and retried.json() == failed.json()
    assert delivery(store)['entries']['homeowner']['status'] == 'sent'
    authorize(client, record, email_copy=True)
    assert len(connections) == 2
    assert sum('send' in item['server'].steps for item in connections) == 2
    assert store.db.records['_email_counts/daily']['sent']['count'] == 1


def test_an_agreement_signed_without_the_choice_is_not_backfilled(smtp):
    client, store, _accounts, _sent, _writes, connections, _plan, _sleeps = smtp
    record = prepare(client, store)
    first = authorize(client, record)
    assert first.status_code == 200, first.text
    saved = client.get('/api/authorizations/ADR-AUTH-homeowner1').json()
    assert 'email_copy' not in saved
    entry = delivery(store)['entries']['homeowner']
    assert (entry['status'], entry['reason']) == ('skipped', 'Homeowner email is not switched on.')
    assert not connections
    assert authorize(client, record, email_copy=True).json() == first.json()
    assert 'email_copy' not in client.get('/api/authorizations/ADR-AUTH-homeowner1').json()
    entry = delivery(store)['entries']['homeowner']
    assert (entry['status'], entry['reason']) == ('skipped', 'Homeowner email is not switched on.')
    assert not connections


def test_a_signing_link_emails_the_same_copy(smtp):
    client, store, _accounts, _sent, _writes, connections, _plan, _sleeps = smtp
    record = prepare(client, store)
    link = mint(client, record)
    assert link.status_code == 200, link.text
    signed = homeowner(token(link)).post(
        '/api/sign',
        json={**SIGNER, 'signature_png': sign_payload(record)['signature_png'], 'email_copy': True},
        headers={'Origin': bm.ORIGINS[0]},
    )
    assert signed.status_code == 200, signed.text
    agreement = next(v for k, v in store.db.records.items() if k.startswith('authorizations/'))
    assert agreement['email_copy'] is True and agreement['signing_channel'] == 'link'
    assert delivery(store)['entries']['homeowner']['status'] == 'sent'
    assert len(connections) == 1 and connections[0]['server'].message['To'] == CUSTOMER
    # Repeating the link returns the receipt and does not send a second copy.
    again = homeowner(token(link)).post(
        '/api/sign',
        json={
            **SIGNER,
            'signature_png': sign_payload(record)['signature_png'],
            'email_copy': False,
        },
    )
    assert again.status_code == 200 and again.json()['auth_id'] == signed.json()['auth_id']
    assert len(connections) == 1


def test_owner_only_mode_records_the_choice_and_sends_nothing(context):
    client, store = context
    record = audit(client, inspect(client))
    body = sign_payload(record)
    body['email_copy'] = True
    assert client.post('/api/authorize', json=body).status_code == 200
    saved = client.get('/api/authorizations/' + body['auth_id']).json()
    assert saved['email_copy'] is True
    assert not any(key.startswith('_job_deliveries/') for key in store.db.records)


@pytest.mark.parametrize('uid,status', [('office', 403), ('admin', 403), ('other-owner', 404)])
def test_roles_that_cannot_sign_do_not_queue_a_delivery(api, uid, status):
    client, current, store = api
    current['uid'] = 'estimator'
    assert (
        client.post('/api/inspections', json={'inspection_id': ID, 'data': data()}).status_code
        == 200
    )
    current['uid'] = 'office'
    job = client.get('/api/jobs/' + ID + '/coordination').json()
    assert (
        client.put(
            '/api/jobs/' + ID + '/coordination',
            json={
                'expected_version': job['version'],
                'customer_email': CUSTOMER,
            },
        ).status_code
        == 200
    )
    current['uid'] = 'estimator'
    record = audit_job(client)
    body = payload_for(record, email_copy=True)
    current['uid'] = uid
    response = client.post('/api/authorize', json=body)
    assert response.status_code == status, response.text
    assert '_job_deliveries/' + ID not in store.db.records


@pytest.mark.parametrize('channel', ['onsite', 'link'])
def test_queue_failure_cannot_commit_a_signature(smtp, monkeypatch, channel):
    from tests.fakes import Tx

    client, store, _accounts, _sent, _writes, connections, _plan, _sleeps = smtp
    record = prepare(client, store)
    link = mint(client, record) if channel == 'link' else None
    original = Tx.create

    def fail_queue(tx, ref, value):
        if ref.key.startswith('_job_deliveries/'):
            raise RuntimeError('Synthetic queue failure')
        return original(tx, ref, value)

    monkeypatch.setattr(Tx, 'create', fail_queue)

    def submit():
        if channel == 'onsite':
            return authorize(client, record, email_copy=True)
        return homeowner(token(link)).post(
            '/api/sign',
            json={
                **SIGNER,
                'signature_png': sign_payload(record)['signature_png'],
                'email_copy': True,
            },
        )

    response = submit()
    assert response.status_code == 503
    assert not any(key.startswith('authorizations/') for key in store.db.records)
    assert store.db.records['inspections/' + ID]['status'] != 'signed'
    assert not store.db.records['_workspace_jobs/' + ID].get('auth_id')
    assert '_job_deliveries/' + ID not in store.db.records
    assert not connections
    monkeypatch.setattr(Tx, 'create', original)
    assert submit().status_code == 200
    assert delivery(store)['entries']['homeowner']['status'] == 'sent'


@pytest.mark.parametrize('channel', ['onsite', 'link'])
def test_delivery_is_durable_before_transport_starts(smtp, monkeypatch, channel):
    client, store, _accounts, _sent, _writes, connections, _plan, _sleeps = smtp
    record = prepare(client, store)

    def interrupted(*args):
        raise RuntimeError('Synthetic interruption before sending')

    monkeypatch.setattr(bm, 'deliver_homeowner', interrupted)
    if channel == 'onsite':
        response = authorize(client, record, email_copy=True)
    else:
        link = mint(client, record)
        response = homeowner(token(link)).post(
            '/api/sign',
            json={
                **SIGNER,
                'signature_png': sign_payload(record)['signature_png'],
                'email_copy': True,
            },
        )
    assert response.status_code == 200
    assert store.db.records['authorizations/' + response.json()['auth_id']]['email_copy'] is True
    assert delivery(store)['entries']['homeowner']['status'] == 'queued'
    assert not connections


def test_signing_link_names_the_masked_address_or_offers_no_copy(api, mail):
    client, current, store = api
    record = prepare(client, store)
    link = mint(client, record)
    assert homeowner(token(link)).get('/api/sign').json()['email_to'] == 'h•••@example.invalid'
    job = client.get('/api/jobs/' + ID + '/coordination').json()
    client.put(
        '/api/jobs/' + ID + '/coordination',
        json={'expected_version': job['version'], 'customer_name': 'Synthetic Customer'},
    )
    # The same name keeps the documents, so the link still reads, now with no copy to offer.
    assert homeowner(token(link)).get('/api/sign').json()['email_to'] == ''
