"""Delivery status and Resend on a signed job. SMTP is the fake server; no live inbox is contacted."""

import json

import pytest

from backend.delivery import DELIVERY_OFF, RECIPIENTS, RESERVATION_SECONDS, UNCONFIRMED
from tests.fakes import ADR_PROFILE, png
from tests.test_workspaces import ID, SIGNED, data, signed_job  # noqa: F401
from tests.test_workspaces import api, mail, smtp, store  # noqa: F401


def enable(client, **profile):
    saved = client.put(
        '/api/companies/adr',
        json={'expected_version': 1, 'profile': {**ADR_PROFILE, **profile}},
    )
    assert saved.status_code == 200, saved.text


def statuses(body):
    return {entry['role']: entry['status'] for entry in body['delivery']['entries']}


@pytest.mark.parametrize(
    'uid, allowed',
    [
        ('owner', True),
        ('office', True),
        ('estimator', False),
        ('estimator2', False),
        ('admin', False),
        ('other-owner', False),
    ],
)
def test_delivery_status_and_resend_follow_the_role(api, uid, allowed):
    client, current, store = api
    signed_job(client, current, store)
    current['uid'] = uid
    status = client.get('/api/jobs/' + ID + '/delivery')
    resend = client.post('/api/jobs/' + ID + '/delivery/resend')
    if allowed:
        assert status.status_code == 200, status.text
        assert statuses(status.json()) == {
            'homeowner': 'skipped',
            'adjuster': 'skipped',
            'crew_lead': 'skipped',
        }
        assert all(
            entry['reason'] == DELIVERY_OFF for entry in status.json()['delivery']['entries']
        )
        assert resend.status_code == 200, resend.text
        assert resend.json() == status.json()
        assert '@' not in json.dumps(resend.json())
    else:
        assert status.status_code in (403, 404)
        assert resend.status_code in (403, 404)
        assert '_job_deliveries/' + ID in store.db.records
    capabilities = client.get('/api/session').json()['capabilities']
    assert ('delivery_resend' in capabilities) is (
        client.get('/api/session').json().get('role') in ('owner', 'office')
    )


def test_superadmin_support_sees_status_and_cannot_resend(api):
    client, current, store = api
    signed_job(client, current, store)
    current['uid'] = 'admin'
    opened = client.get('/api/admin/companies/adr/authorizations/' + SIGNED)
    assert opened.status_code == 200, opened.text
    body = opened.json()
    assert statuses(body) == {
        'homeowner': 'skipped',
        'adjuster': 'skipped',
        'crew_lead': 'skipped',
    }
    assert 'message_id' not in json.dumps(body['delivery'])
    assert client.post('/api/jobs/' + ID + '/delivery/resend').status_code == 403
    # A job signed before the sidecar has nothing to show and nothing to send.
    del store.db.records['_job_deliveries/' + ID]
    again = client.get('/api/admin/companies/adr/authorizations/' + SIGNED)
    assert again.status_code == 200 and again.json()['delivery'] is None
    current['uid'] = 'owner'
    assert client.get('/api/jobs/' + ID + '/delivery').json()['delivery'] is None
    assert client.post('/api/jobs/' + ID + '/delivery/resend').status_code == 404


def test_resend_sends_only_the_unsent_entry_and_not_a_second_copy(smtp, api, capsys):
    client, store, _accounts, _sent, _writes, connections, _plan, _sleeps = smtp
    _client, current, _store = api
    enable(client, document_delivery=True, crew_lead_email='Lead@Crew.example.invalid')
    signed_job(client, current, store)
    # Signing sends the adjuster and homeowner paths only. The crew lead stays queued.
    assert connections == []
    record = store.db.records['_job_deliveries/' + ID]
    assert record['entries']['crew_lead']['status'] == 'queued'
    assert record['entries']['homeowner']['status'] == 'skipped'
    current['uid'] = 'office'
    first = client.post('/api/jobs/' + ID + '/delivery/resend')
    assert first.status_code == 200, first.text
    assert statuses(first.json())['crew_lead'] == 'sent'
    assert statuses(first.json())['homeowner'] == 'skipped'
    assert [item['server'].message['To'] for item in connections] == ['lead@crew.example.invalid']
    text = connections[0]['server'].message.as_string()
    summary = text.split('Job summary', 1)[-1].split('Powered by DryScope')[0]
    assert 'Job summary' in text and 'Powered by DryScope' in text and '$' not in summary
    second = client.post('/api/jobs/' + ID + '/delivery/resend')
    assert second.status_code == 200 and second.json() == first.json()
    assert len(connections) == 1
    logged = capsys.readouterr().out
    assert 'lead@crew.example.invalid' not in logged and 'Lead@Crew' not in logged


def test_a_failed_entry_is_resent_once(smtp):
    client, store, _accounts, _sent, _writes, connections, plan, _sleeps = smtp
    enable(client, document_delivery=True)
    plan.extend([('connect', OSError('down'))] * 3)
    created = client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    assert created.status_code == 200, created.text
    job = client.get('/api/jobs/' + ID + '/coordination').json()
    assert (
        client.put(
            '/api/jobs/' + ID + '/coordination',
            json={'expected_version': job['version'], 'customer_email': 'home@example.invalid'},
        ).status_code
        == 200
    )
    record = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1}).json()
    signed = client.post(
        '/api/authorize',
        json={
            'inspection_id': ID,
            'expected_revision': 1,
            'auth_id': 'ADR-AUTH-resendfail1',
            'proposal_hash': record['audit']['proposal_hash'],
            'signature_png': png(),
            'documents_confirmed': True,
            'email_copy': True,
        },
    )
    assert signed.status_code == 200, signed.text
    entry = store.db.records['_job_deliveries/' + ID]['entries']['homeowner']
    assert entry['status'] == 'failed' and entry['retryable'] is True
    failed_attempts = len(connections)
    resent = client.post('/api/jobs/' + ID + '/delivery/resend')
    assert resent.status_code == 200, resent.text
    assert statuses(resent.json())['homeowner'] == 'sent'
    assert len(connections) == failed_attempts + 1
    assert connections[-1]['server'].message['To'] == 'home@example.invalid'
    again = client.post('/api/jobs/' + ID + '/delivery/resend')
    assert again.status_code == 200 and statuses(again.json())['homeowner'] == 'sent'
    assert len(connections) == failed_attempts + 1


@pytest.mark.parametrize('uid', ['owner', 'office', 'admin'])
@pytest.mark.parametrize('role', RECIPIENTS)
@pytest.mark.parametrize('age', [RESERVATION_SECONDS - 1, RESERVATION_SECONDS])
def test_status_expires_interrupted_sends_without_retrying(smtp, api, monkeypatch, uid, role, age):
    client, store, _accounts, _sent, _writes, connections, _plan, _sleeps = smtp
    _client, current, _store = api
    enable(client, document_delivery=True)
    signed_job(client, current, store)
    record = store.db.records['_job_deliveries/' + ID]
    record['entries'][role].update(
        status='sending', send_started=1000, attempt='interrupted', retryable=False, reason=''
    )
    monkeypatch.setattr('backend.delivery.time.time', lambda: 1000 + age)
    current['uid'] = uid
    path = (
        '/api/admin/companies/adr/authorizations/' + SIGNED
        if uid == 'admin'
        else '/api/jobs/' + ID + '/delivery'
    )
    response = client.get(path)
    assert response.status_code == 200, response.text
    entry = next(item for item in response.json()['delivery']['entries'] if item['role'] == role)
    expired = age >= RESERVATION_SECONDS
    assert entry == {
        'role': role,
        'status': 'failed' if expired else 'sending',
        'reason': UNCONFIRMED if expired else '',
        'retryable': False,
    }
    assert record['entries'][role]['status'] == 'sending'
    current['uid'] = 'owner'
    for _ in range(2):
        resent = client.post('/api/jobs/' + ID + '/delivery/resend')
        assert resent.status_code == 200, resent.text
        returned = next(
            item for item in resent.json()['delivery']['entries'] if item['role'] == role
        )
        assert returned == entry
    assert connections == []
