"""Adjuster email after a durable signature, through the real signing routes and a fake SMTP server.

No real account, project or inbox is contacted. The homeowner and crew lead are not emailed.
"""

import json
import smtplib

import pytest
from fastapi.testclient import TestClient

import backend.document_links as document_links
import backend.main as bm
from backend.delivery import (
    DOCUMENT_ORIGINS,
    INVALID_ADJUSTER_EMAIL,
    NO_ADJUSTER_EMAIL,
    NOT_SWITCHED_ON,
)
from tests.test_backend import audit as owner_audit
from tests.test_backend import context, inspect, sign_payload
from tests.test_claim_details import CLAIM, audit, save_claim, started, signing
from tests.test_signing_links import mint, sign, token
from tests.test_workspaces import ID, api, mail, message_parts, smtp, store  # noqa: F401

AUTH = 'ADR-AUTH-adjuster12345'
ORIGIN = DOCUMENT_ORIGINS[0]


def prepare(client, current, claim=CLAIM):
    started(client, current)
    if claim is not None:
        assert save_claim(client, claim).status_code == 200
    current['uid'] = 'estimator'
    return audit(client)


def authorize(client, record, auth_id=AUTH, origin=ORIGIN):
    return client.post('/api/authorize', json=signing(record, auth_id), headers={'Origin': origin})


def record(store):
    return store.db.records.get('_job_deliveries/' + ID)


def statuses(store):
    return {role: entry['status'] for role, entry in record(store)['entries'].items()}


def link_from(message):
    text, page = message_parts(message)
    marker = ORIGIN + '/documents#'
    assert marker in text and marker in page
    value = text.split(marker, 1)[1].split()[0]
    assert value in page
    for body in (text, page):
        assert 'ESX' not in body and 'Xactimate' not in body
        assert 'itemized claim' in body and 'scope defense letter' in body
        assert 'scope-code' in body
    kinds = [part.get_content_type() for part in message.walk() if not part.is_multipart()]
    assert 'application/pdf' not in kinds and 'application/json' not in kinds
    assert any(kind.startswith('image/') for kind in kinds)
    return value, text


def test_document_origins_match_the_app():
    assert tuple(bm.ORIGINS) == DOCUMENT_ORIGINS


def test_adjuster_email_sends_one_private_link_and_a_repeat_does_not(api, smtp, capsys):
    client, current, store = api
    connections = smtp[5]
    store.db.records['_companies/adr']['profile']['email'] = 'Office@Alert.example.invalid'
    audited = prepare(client, current)
    capsys.readouterr()
    saved = authorize(client, audited, origin='https://evil.example')
    assert saved.status_code == 200, saved.text
    assert saved.json()['auth_id'] == AUTH
    assert statuses(store) == {'homeowner': 'skipped', 'adjuster': 'sent', 'crew_lead': 'skipped'}
    assert record(store)['entries']['homeowner']['reason'] == NOT_SWITCHED_ON['homeowner']
    assert record(store)['entries']['crew_lead']['reason'] == NOT_SWITCHED_ON['crew_lead']
    assert len(connections) == 1
    message = connections[0]['server'].message
    value, text = link_from(message)
    assert message['To'] == 'avery@example.invalid'
    assert message['Subject'] == 'Claim documents from Alert Disaster Restoration'
    assert message['Reply-To'] == 'office@alert.example.invalid'
    assert 'Test property' in text and 'CLM-0042-77' in text
    assert 'https://evil.example' not in text
    view = TestClient(bm.app, headers={'X-ADR-Document-Link': value}).get('/api/documents')
    assert view.status_code == 200, view.text
    body = view.json()
    assert body['document_set'] == 'adjuster' and body['tabs'] == ['claim', 'defense']
    assert body['documents']['xactimate_scope']
    assert body['documents']['iicrc_defense_letter']
    # The link, the address and the property stay out of the log and the saved agreement.
    output = capsys.readouterr().out
    agreement = store.db.records['authorizations/' + AUTH]
    for secret in (value, 'avery@example.invalid', 'Test property', 'evil.example'):
        assert secret not in output
        assert secret not in json.dumps(saved.json())
    assert value not in json.dumps(store.db.records, default=str)
    assert agreement['documents'] == audited['audit']['documents']
    assert store.db.records['_email_counts/daily']['sent']['count'] == 1
    again = authorize(client, audited)
    assert again.status_code == 200 and again.json() == saved.json()
    assert len(connections) == 1 and statuses(store)['adjuster'] == 'sent'
    # Reading the agreement, or a historical post with no inspection, does not create another one.
    delivery_id = record(store)['delivery_id']
    del store.db.records['_job_deliveries/' + ID]
    assert client.get('/api/authorizations/' + AUTH).status_code == 200
    assert client.post('/api/authorize', json={'auth_id': AUTH}).status_code in (200, 409)
    assert '_job_deliveries/' + ID not in store.db.records
    assert delivery_id


def test_adjuster_is_skipped_without_an_email_and_nothing_is_minted(api, smtp):
    client, current, store = api
    connections = smtp[5]
    audited = prepare(client, current, claim={'carrier': 'Synthetic Mutual'})
    saved = authorize(client, audited)
    assert saved.status_code == 200, saved.text
    assert statuses(store)['adjuster'] == 'skipped'
    assert record(store)['entries']['adjuster']['reason'] == NO_ADJUSTER_EMAIL
    assert not connections
    assert not any(key.startswith('_document_links/') for key in store.db.records)
    assert '_email_counts/daily' not in store.db.records
    # A later edit of the live sidecar does not un-skip the entry or send it.
    assert save_claim(client, CLAIM).status_code == 200
    assert authorize(client, audited).status_code == 200
    assert statuses(store)['adjuster'] == 'skipped' and not connections


def test_a_failed_adjuster_email_is_retried_once(api, smtp):
    client, current, store = api
    connections, plan = smtp[5], smtp[6]
    audited = prepare(client, current)
    plan.append(('send', smtplib.SMTPDataError(554, b'5.6.0 Message rejected')))
    saved = authorize(client, audited)
    assert saved.status_code == 200, saved.text
    failed = record(store)['entries']['adjuster']
    assert (failed['status'], failed['retryable']) == ('failed', True)
    assert len(connections) == 1
    first, _ = link_from(connections[0]['server'].message)
    retried = authorize(client, audited)
    assert retried.status_code == 200
    assert record(store)['entries']['adjuster']['status'] == 'sent'
    assert len(connections) == 2
    second, _ = link_from(connections[1]['server'].message)
    assert second != first
    assert (
        store.db.records['_document_links/' + document_links.link_id(first)]['status'] == 'revoked'
    )
    opened = TestClient(bm.app, headers={'X-ADR-Document-Link': second}).get('/api/documents')
    assert opened.status_code == 200 and opened.json()['tabs'] == ['claim', 'defense']
    assert (
        TestClient(bm.app, headers={'X-ADR-Document-Link': first}).get('/api/documents').status_code
        == 404
    )
    assert authorize(client, audited).status_code == 200
    assert len(connections) == 2
    assert store.db.records['_email_counts/daily']['sent']['count'] == 1


def test_an_unusable_adjuster_email_is_not_a_recipient():
    # Signing validates the address, so a stored bad value is the only way this reason is reached.
    from backend.delivery import adjuster_recipient

    assert adjuster_recipient({'claim': {'adjuster_email': 'not-an-email'}}) == (
        None,
        INVALID_ADJUSTER_EMAIL,
    )
    assert adjuster_recipient({}) == (None, NO_ADJUSTER_EMAIL)
    assert adjuster_recipient({'claim': {'adjuster_email': 'Avery@Example.invalid'}}) == (
        'avery@example.invalid',
        None,
    )


def test_documents_audited_before_claim_details_skip_the_adjuster(api, smtp):
    client, current, store = api
    connections = smtp[5]
    audited = prepare(client, current, claim=None)
    del store.db.records['inspections/' + ID]['audit']['documents']['claim']
    saved = authorize(client, audited, auth_id='ADR-AUTH-legacyadjuster')
    assert saved.status_code == 200, saved.text
    assert record(store)['entries']['adjuster']['reason'] == NO_ADJUSTER_EMAIL
    assert not connections


@pytest.mark.parametrize('uid', ['office', 'admin', 'other-owner', 'estimator2'])
def test_someone_who_cannot_sign_does_not_send(api, smtp, uid):
    client, current, store = api
    connections = smtp[5]
    audited = prepare(client, current)
    current['uid'] = uid
    refused = authorize(client, audited)
    assert refused.status_code in (403, 404)
    assert record(store) is None and not connections


def test_homeowner_link_signing_sends_the_adjuster_the_same_email(api, smtp):
    client, current, store = api
    connections = smtp[5]
    audited = prepare(client, current)
    link = mint(client, audited)
    assert link.status_code == 200, link.text
    saved = sign(token(link))
    assert saved.status_code == 200, saved.text
    assert statuses(store)['adjuster'] == 'sent' and len(connections) == 1
    value, _ = link_from(connections[0]['server'].message)
    opened = TestClient(bm.app, headers={'X-ADR-Document-Link': value}).get('/api/documents')
    assert opened.status_code == 200 and opened.json()['document_set'] == 'adjuster'
    assert sign(token(link)).status_code == 200
    assert len(connections) == 1


def test_owner_only_signing_does_not_queue_delivery(context):
    client, store = context
    record = owner_audit(client, inspect(client))
    assert client.post('/api/authorize', json=sign_payload(record)).status_code == 200
    assert not any(key.startswith('_job_deliveries/') for key in store.db.records)
