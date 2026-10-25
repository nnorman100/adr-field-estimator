"""Delivery sidecar and its retry, sent through the shared sender against a fake SMTP server and a
fake Resend endpoint; no real account, project or inbox is contacted."""

import json
import smtplib
import time
import urllib.error
from copy import deepcopy
import pytest
import backend.workspaces as workspaces
from backend.delivery import RECIPIENTS, UNCONFIRMED, Deliveries, delivery_email
from tests.test_workspaces import (  # noqa: F401
    ID,
    api,
    direct_invite,
    mail,
    message_parts,
    smtp,
    store,
)

COMPANY = {
    'profile': {
        'name': 'Kern Water Pros',
        'address': '100 Main St, Bakersfield, CA 93301',
        'phone': '(661) 555-0100',
        'email': 'Office@KernWater.example.invalid',
    }
}


@pytest.fixture
def sending(smtp):
    client, store, accounts, sent, writes, connections, plan, sleeps = smtp
    store.db.records['_workspace_jobs/' + ID] = dict(
        job_id=ID, company_id='adr', auth_id='auth-' + 'c' * 32, status='signed', version=3
    )
    store.db.records['authorizations/auth-' + 'c' * 32] = {'signed': 'record'}
    return client, store, sent, connections, plan, Deliveries(store.workspaces)


def compose(role, record):
    return delivery_email(
        COMPANY,
        role + '@example.invalid',
        'Your documents from Kern Water Pros',
        ['Your signed documents are ready.'],
        [('View your documents', 'https://example.invalid/doc?a=1&b=2')],
    )


def entries(store):
    return {
        role: entry['status']
        for role, entry in store.db.records['_job_deliveries/' + ID]['entries'].items()
    }


def test_each_queued_entry_is_sent_once_beside_the_coordination_record(sending):
    client, store, sent, connections, plan, deliveries = sending
    before = deepcopy(store.db.records)
    record = deliveries.queue(ID, {})
    assert entries(store) == dict.fromkeys(RECIPIENTS, 'queued')
    assert record['auth_id'] == 'auth-' + 'c' * 32 and record['company_id'] == 'adr'
    result = deliveries.send(ID, compose)
    assert entries(store) == dict.fromkeys(RECIPIENTS, 'sent')
    assert [c['server'].message['To'] for c in connections] == [
        role + '@example.invalid' for role in RECIPIENTS
    ]
    for role, connection in zip(RECIPIENTS, connections):
        entry = result['entries'][role]
        assert (
            entry['message_id']
            == connection['server'].message['Message-ID']
            == (f'<delivery-{record["delivery_id"]}-{role}-{entry["attempt"]}@example.invalid>')
        )
    # Only the sidecar and the shared daily count were written: the signed record, the job's
    # coordination record and its authorization are untouched.
    changed = {k for k in store.db.records if store.db.records[k] != before.get(k)}
    assert changed == {'_job_deliveries/' + ID, '_email_counts/daily'}
    assert store.db.records['_email_counts/daily']['sent']['count'] == 3
    assert deliveries.send(ID, compose) == result and len(connections) == 3


def test_a_failed_entry_is_retried_and_then_sent_exactly_once(sending):
    client, store, sent, connections, plan, deliveries = sending
    deliveries.queue(ID, {'adjuster': 'No adjuster email.', 'crew_lead': 'Not switched on.'})
    plan.append(('send', smtplib.SMTPDataError(554, b'5.6.0 Message rejected')))
    failed = deliveries.send(ID, compose)['entries']['homeowner']
    assert (failed['status'], failed['retryable']) == ('failed', True)
    assert failed['reason'] == 'The email could not be sent. A retry sends it again.'
    assert len(connections) == 1
    retried = deliveries.send(ID, compose)['entries']['homeowner']
    assert retried['status'] == 'sent' and retried['attempt'] != failed['attempt']
    for _ in range(3):
        deliveries.send(ID, compose)
    assert len(connections) == 2
    assert entries(store) == dict(homeowner='sent', adjuster='skipped', crew_lead='skipped')
    assert store.db.records['_job_deliveries/' + ID]['entries']['adjuster']['reason'] == (
        'No adjuster email.'
    )
    assert store.db.records['_email_counts/daily']['sent']['count'] == 1


def test_queueing_again_keeps_the_first_record(sending):
    client, store, sent, connections, plan, deliveries = sending
    first = deliveries.queue(ID, {'crew_lead': 'Not switched on.'})
    assert deliveries.queue(ID, {}) == first
    assert entries(store)['crew_lead'] == 'skipped'


def test_jobs_without_a_signature_or_delivery_record_get_none(sending):
    client, store, sent, connections, plan, deliveries = sending
    store.db.records['_workspace_jobs/' + ID].pop('auth_id')
    with pytest.raises(LookupError):
        deliveries.queue(ID, {})
    # Jobs signed before delivery existed have no record, and nothing invents one.
    with pytest.raises(LookupError):
        deliveries.send(ID, compose)
    assert '_job_deliveries/' + ID not in store.db.records and not connections


def test_an_attempt_in_flight_is_left_alone_and_an_unconfirmed_one_is_not_resent(
    sending, monkeypatch
):
    client, store, sent, connections, plan, deliveries = sending
    deliveries.queue(ID, {'adjuster': 'Skipped.', 'crew_lead': 'Skipped.'})
    entry = store.db.records['_job_deliveries/' + ID]['entries']['homeowner']
    entry.update(status='sending', attempt='x' * 32, send_started=time.time())
    deliveries.send(ID, compose)
    assert entries(store)['homeowner'] == 'sending' and not connections
    entry = store.db.records['_job_deliveries/' + ID]['entries']['homeowner']
    entry['send_started'] = time.time() - 31
    stale = deliveries.send(ID, compose)['entries']['homeowner']
    assert (stale['status'], stale['reason'], stale['retryable']) == ('failed', UNCONFIRMED, False)
    deliveries.send(ID, compose)
    assert not connections


def test_missing_configuration_fails_the_entry_before_composing_or_connecting(sending, monkeypatch):
    client, store, sent, connections, plan, deliveries = sending
    deliveries.queue(ID, {'adjuster': 'Skipped.', 'crew_lead': 'Skipped.'})
    monkeypatch.delenv('INVITATION_SMTP_PASSWORD')
    composed = []
    deliveries.send(ID, lambda role, record: composed.append(role) or compose(role, record))
    assert entries(store)['homeowner'] == 'failed' and not composed and not connections
    monkeypatch.setenv('INVITATION_SMTP_PASSWORD', 'placeholder-app-password')
    deliveries.send(ID, compose)
    assert entries(store)['homeowner'] == 'sent' and len(connections) == 1


def test_delivery_email_replies_to_the_company_and_shows_its_identity(sending, monkeypatch):
    client, store, sent, connections, plan, deliveries = sending
    deliveries.queue(ID, {'adjuster': 'Skipped.', 'crew_lead': 'Skipped.'})
    deliveries.send(ID, compose)
    message = connections[0]['server'].message
    assert message['Reply-To'] == 'office@kernwater.example.invalid'
    assert message['From'] == 'ADR <invite@example.invalid>'
    text, page = message_parts(message)
    for body in (text, page):
        for value in ('Kern Water Pros', '100 Main St, Bakersfield, CA 93301', '(661) 555-0100'):
            assert value in body
        assert 'Powered by DryScope' in body and 'Your signed documents are ready.' in body
    assert 'View your documents: https://example.invalid/doc?a=1&b=2' in text
    assert 'href="https://example.invalid/doc?a=1&amp;b=2"' in page
    assert 'src="cid:invitation-logo@dryscope"' in page
    # Resend carries the same Reply-To in its own field.
    monkeypatch.setenv('INVITATION_TRANSPORT', 'resend')
    store.db.records['_job_deliveries/' + ID]['entries']['adjuster'].update(status='queued')
    deliveries.send(ID, compose)
    assert sent[-1]['reply_to'] == 'office@kernwater.example.invalid'
    assert sent[-1]['to'] == ['adjuster@example.invalid']


@pytest.mark.parametrize('email', ['', 'not an address', 'a@b.c\nBcc: x@example.invalid'])
def test_delivery_email_has_no_reply_to_without_a_valid_company_email(email):
    company = {'profile': {**COMPANY['profile'], 'email': email}}
    message = delivery_email(company, 'home@example.invalid', 'Subject', ['Body.'])
    assert 'reply_to' not in message


def test_delivery_logs_carry_only_the_delivery_id_role_and_status(sending, capsys):
    client, store, sent, connections, plan, deliveries = sending
    record = deliveries.queue(ID, {'adjuster': 'No adjuster email.', 'crew_lead': 'Skipped.'})
    plan.append(('send', smtplib.SMTPDataError(554, b'5.6.0 Message rejected')))
    deliveries.send(ID, compose)
    deliveries.send(ID, compose)
    lines = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    logged = [line for line in lines if line['message'] == 'Delivery entry']
    assert [(line['recipient_role'], line['status']) for line in logged] == [
        ('homeowner', 'queued'),
        ('adjuster', 'skipped'),
        ('crew_lead', 'skipped'),
        ('homeowner', 'failed'),
        ('homeowner', 'sent'),
    ]
    for line in logged:
        assert set(line) == {
            'severity',
            'message',
            'operation',
            'delivery_id',
            'recipient_role',
            'status',
        }
        assert line['delivery_id'] == record['delivery_id']
    output = json.dumps(lines)
    for secret in ('@example.invalid', 'Kern Water', 'No adjuster email', 'auth-'):
        assert secret not in output


def test_invitations_and_deliveries_share_the_daily_count_and_warn_past_400(sending, mail, capsys):
    client, store, sent, connections, plan, deliveries = sending
    current = mail[1]
    store.db.records['_email_counts/daily'] = {'sent': {'start': time.time(), 'count': 399}}
    invited = client.post(
        '/api/companies/adr/invitations', json={'email': 'new@example.invalid', 'role': 'office'}
    ).json()
    assert invited['delivery_status'] == 'sent'
    assert not client.get('/api/access').json()['email_notice']
    assert not client.get('/api/session').json()['email_notice']
    deliveries.queue(ID, {'adjuster': 'Skipped.', 'crew_lead': 'Skipped.'})
    deliveries.send(ID, compose)
    assert store.db.records['_email_counts/daily']['sent']['count'] == 401
    warnings = [
        json.loads(line) for line in capsys.readouterr().out.splitlines() if '"WARNING"' in line
    ]
    assert warnings == [
        {
            'severity': 'WARNING',
            'message': 'Daily email count passed the warning level',
            'operation': 'email',
            'status': 'daily_warning',
            'emails_today': 401,
        }
    ]
    # One sender serves every company, so every owner is told; nobody else is.
    for uid, notice in [
        ('owner', True),
        ('other-owner', True),
        ('office', False),
        ('estimator', False),
        ('admin', False),
    ]:
        current['uid'] = uid
        assert client.get('/api/access').json()['email_notice'] is notice
        assert client.get('/api/session').json()['email_notice'] is notice
    # A day after the count started, the notice clears and counting starts again.
    store.db.records['_email_counts/daily']['sent']['start'] -= 86400
    assert not store.workspaces.email_notice()


def test_a_failed_send_is_not_counted(smtp):
    client, store, accounts, sent, writes, connections, plan, sleeps = smtp
    plan.append(('send', smtplib.SMTPDataError(554, b'5.6.0 Message rejected')))
    invited = client.post(
        '/api/companies/adr/invitations', json={'email': 'new@example.invalid', 'role': 'office'}
    ).json()
    assert invited['delivery_status'] == 'failed'
    assert '_email_counts/daily' not in store.db.records


@pytest.mark.parametrize('error', [smtplib.SMTPServerDisconnected('Lost reply'), OSError('Lost socket'), TimeoutError()])
def test_uncertain_smtp_delivery_is_never_retried(sending, error):
    client, store, sent, connections, plan, deliveries = sending
    deliveries.queue(ID, {'adjuster': 'Skipped.', 'crew_lead': 'Skipped.'})
    plan.append(('send', error))
    entry = deliveries.send(ID, compose)['entries']['homeowner']
    assert (entry['status'], entry['reason'], entry['retryable']) == ('failed', UNCONFIRMED, False)
    deliveries.send(ID, compose)
    assert len(connections) == 1
    assert '_email_counts/daily' not in store.db.records


def test_smtp_failure_before_handoff_can_retry(sending):
    client, store, sent, connections, plan, deliveries = sending
    deliveries.queue(ID, {'adjuster': 'Skipped.', 'crew_lead': 'Skipped.'})
    plan.append(('login', smtplib.SMTPServerDisconnected('Not sent')))
    assert deliveries.send(ID, compose)['entries']['homeowner']['status'] == 'sent'
    deliveries.send(ID, compose)
    assert len(connections) == 2
    assert sum('send' in c['server'].steps for c in connections) == 1
    assert store.db.records['_email_counts/daily']['sent']['count'] == 1


@pytest.mark.parametrize('outcome', ['timeout', 'server_error', 'unconfirmed', 'malformed'])
def test_uncertain_resend_delivery_is_never_retried(sending, monkeypatch, outcome):
    client, store, sent, connections, plan, deliveries = sending
    monkeypatch.setenv('INVITATION_TRANSPORT', 'resend')
    calls = []

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def read(self, limit):
            return b'{}' if outcome == 'unconfirmed' else b'not json'

    def request(*args, **kwargs):
        calls.append(args)
        if outcome == 'timeout':
            raise TimeoutError()
        if outcome == 'server_error':
            raise urllib.error.HTTPError('https://example.invalid', 503, 'Unavailable', {}, None)
        return Response()

    monkeypatch.setattr(workspaces.urllib.request, 'urlopen', request)
    deliveries.queue(ID, {'adjuster': 'Skipped.', 'crew_lead': 'Skipped.'})
    entry = deliveries.send(ID, compose)['entries']['homeowner']
    assert (entry['status'], entry['reason'], entry['retryable']) == ('failed', UNCONFIRMED, False)
    deliveries.send(ID, compose)
    assert len(calls) == 1
