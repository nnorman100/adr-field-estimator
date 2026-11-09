"""Real Firestore transactions for delivery, monitoring, extras, insight, price-book, retention and
spending, run against the local emulator (the quota, lease and signing ones are in
tests/test_firestore_emulator.py, whose helpers and fixtures this module reuses).

Skipped unless FIRESTORE_EMULATOR_HOST is set. Run locally from the repository root:
    npx firebase-tools emulators:exec --only firestore --project demo-adr-emulator \
        "python -m pytest tests/test_firestore_emulator.py tests/test_firestore_emulator_operations.py -q -p no:cacheprovider"
Evidence objects use the in-memory bucket; only Firestore is real here.

The emulator resolves lock conflicts by timeout rather than production's wound-wait, so
concurrent transactions can exhaust their retries there ("Transaction lock timeout"; see
https://firebase.google.com/docs/emulator-suite/connect_firestore#transactions). Concurrent
tests therefore assert the safety properties (no lost update, nothing past a limit, one
receipt), accept contention aborts, then check the settled state with a sequential call.
"""

import base64
import json
import os
import time
import urllib.error
from copy import deepcopy
import pytest

EMULATOR = os.getenv('FIRESTORE_EMULATOR_HOST')
# The CI emulator job sets this so a missing emulator fails instead of skipping.
if not EMULATOR and os.getenv('ADR_FIRESTORE_EMULATOR_REQUIRED'):
    raise RuntimeError('FIRESTORE_EMULATOR_HOST is required for the Firestore emulator tests.')
pytestmark = pytest.mark.skipif(
    not EMULATOR,
    reason='FIRESTORE_EMULATOR_HOST is not set; start the Firestore emulator to run these tests.',
)
# The demo- prefix keeps the client offline: no credentials, no real project.
PROJECT = 'demo-adr-emulator'

from google.api_core.exceptions import ServiceUnavailable
from backend.adr_price_book import adr_rates
from tests.adr_pricing import make_documents
from backend.company_store import CompanyInspectionStore
from backend.contracts import AIResult, InspectionData
from backend.inspection_store import Conflict, Limited
from backend.workspaces import AccessDenied, MemberUpdate, WorkspaceStore
from tests.fakes import ADR_PROFILE, png
from tests.ai_spending_emulator import concurrently, company_spending_reservations
from tests.test_backend import ID, data, sign_payload
from tests.test_firestore_emulator import (
    client,
    empty_database,
    clock,
    instances,
    outcomes,
    stored,
    seed_company,
    audited,
    verified,
    browser_token,
    browser_request,
)


def test_concurrent_delivery_retries_send_each_entry_once_and_count_it(monkeypatch):
    """Two instances retry one job's delivery at once: each queued entry is sent exactly once, the
    shared daily count matches, and the sidecar stays private to the server."""
    import backend.delivery as delivery

    db = client()
    job = 'ADR-INS-' + 'd' * 32
    db.document('_companies/adr').set({'profile': {'document_delivery': True}})
    db.document('_workspace_jobs/' + job).set(
        dict(job_id=job, company_id='adr', auth_id='auth-' + 'd' * 32, status='signed')
    )
    sends = []
    monkeypatch.setattr(delivery, 'mail_settings', lambda: {})
    monkeypatch.setattr(
        delivery,
        'send_email',
        lambda settings, payload, kind, key, deadline, *, prevent_duplicates: (
            sends.append(key) or '<' + key + '>'
        ),
    )
    stores = [delivery.Deliveries(WorkspaceStore(client())) for _ in range(2)]
    stores[0].queue(job, {'crew_lead': 'Not switched on.'})
    compose = lambda role, record: {'to': [role + '@example.invalid']}
    outcomes(concurrently([lambda s=s: s.send(job, compose) for s in stores]), refused=LookupError)
    for s in stores:
        s.send(job, compose)
    entries = stored(db, '_job_deliveries/' + job)['entries']
    roles = [key.split('/')[1] for key in sends]
    # Never twice. An emulator lock timeout can abort a finish, leaving its entry reserved.
    assert sorted(roles) == ['adjuster', 'homeowner']
    assert entries['crew_lead']['status'] == 'skipped'
    sent = [role for role, e in entries.items() if e['status'] == 'sent']
    assert set(sent) <= set(roles)
    assert all(entries[role]['status'] in ('sent', 'sending') for role in roles)
    assert (stored(db, '_email_counts/daily') or {'sent': {'count': 0}})['sent']['count'] == len(
        sent
    )
    for path in ('_job_deliveries/' + job, '_job_deliveries', '_email_counts/daily'):
        assert browser_request('GET', path, browser_token('owner')) == 403, path


def test_readiness_derives_from_existing_log_without_source_writes():
    from backend.readiness import readiness

    store = instances(count=1)[0]
    record = store.create_inspection('owner', ID, data())
    before = stored(store.db, 'inspections/' + ID)
    state = readiness(
        record['data'], record['photos'], {}, store.drying_log('owner', ID)['readings']
    )
    assert 'setup_readings' in [g['code'] for g in state['gaps']]
    log = store.add_reading(
        'owner',
        'owner@example.invalid',
        ID,
        {
            'kind': 'air',
            'zone': 'affected',
            'room': 'Bathroom',
            'taken_at': '2026-10-25T10:00:00Z',
            'temperature_f': 70,
            'relative_humidity': 50,
        },
    )
    after = readiness(record['data'], record['photos'], {}, log['readings'])
    assert 'setup_readings' not in [g['code'] for g in after['gaps']]
    assert stored(store.db, 'inspections/' + ID) == before
    assert not stored(store.db, '_limits/owner')
    with pytest.raises((PermissionError, LookupError)):
        store.drying_log('other', ID)


def test_monitoring_reading_assignment_transactions_reminder_reservation_and_retention(monkeypatch):
    from backend import ai_features, monitoring_store
    from backend.monitoring_store import ReminderRequest
    from backend.workspaces import CoordinationUpdate
    from scripts.preview_drying_watch import preview

    monkeypatch.setattr(ai_features, 'AI_FEATURES', frozenset({'drying_watch'}))
    stores = instances(CompanyInspectionStore)
    record = audited(stores[0])
    agreement = stores[0].authorize('owner', sign_payload(record))
    db = stores[0].db
    original = stored(db, 'authorizations/' + agreement['auth_id'])
    db.document('_companies/adr').update(
        {'profile.drying_reminders': True, 'profile.crew_lead_email': 'crew@example.invalid'}
    )
    reading = dict(
        kind='material',
        room=record['data']['rooms'][0]['name'],
        material='Drywall',
        unit='%WME',
        moisture=22,
        dry_standard=12,
        affected=True,
        taken_at='2026-10-21T10:00:00Z',
    )
    result = stores[0].add_reading('owner', 'owner@example.invalid', ID, reading)
    watch = stored(db, '_job_monitoring/' + ID)
    assert watch['last_reading_at'] == reading['taken_at']
    assert watch['log_updated_at'] == result['updated_at']
    assert 'expire_at' not in watch  # Permanent coordination; no new TTL policy.
    stores[0].workspaces.coordination('owner', ID, CoordinationUpdate(expected_version=1))
    assert stored(db, '_job_monitoring/' + ID)['accessible_estimator_uids'] == ['owner']
    req = ReminderRequest(
        reminder_id='a' * 32,
        approved=True,
        recipient='crew_lead',
        recipient_hash=stores[0].workspaces.monitoring.view('owner', ID)['recipient_hashes'][
            'crew_lead'
        ],
        facts_hash=stores[0].workspaces.monitoring.view('owner', ID)['facts_hash'],
    )
    sends = []
    monkeypatch.setattr(monitoring_store, 'mail_settings', lambda: {})
    monkeypatch.setattr(
        monitoring_store, 'send_email', lambda *args, **kwargs: sends.append(args[3])
    )
    outcomes(
        concurrently(
            [lambda s=s: s.workspaces.monitoring.remind('owner', ID, req) for s in stores]
        ),
        refused=LookupError,
    )
    for s in stores:
        s.workspaces.monitoring.remind('owner', ID, req)
    assert sends == ['monitoring/' + ID + '/' + req.reminder_id]
    entry = stored(db, '_job_monitoring/' + ID)['reminders'][0]
    assert entry['status'] in ('sent', 'sending')
    assert stored(db, 'authorizations/' + agreement['auth_id']) == original
    for path in ('_job_monitoring/' + ID, '_job_monitoring'):
        assert browser_request('GET', path, browser_token('owner')) == 403
    assert (
        browser_request(
            'PATCH',
            '_job_monitoring/' + ID,
            browser_token('owner'),
            {'fields': {'status': {'stringValue': 'dry_standard_met'}}},
        )
        == 403
    )
    # The preview defaults to no writes and reports only counts, then applies idempotently.
    db.document('_job_monitoring/' + ID).delete()
    summary = preview(stores[0].workspaces, 'adr')
    assert summary['eligible_for_creation'] == 1 and summary['created'] == 0
    assert stored(db, '_job_monitoring/' + ID) is None
    assert preview(stores[0].workspaces, 'adr', apply=True)['created'] == 1
    assert preview(stores[0].workspaces, 'adr', apply=True)['created'] == 0


def test_monitoring_sidecar_failure_rolls_back_reading(monkeypatch):
    from backend import ai_features

    monkeypatch.setattr(ai_features, 'AI_FEATURES', frozenset({'drying_watch'}))
    store = instances(CompanyInspectionStore, 1)[0]
    record = audited(store)
    store.authorize('owner', sign_payload(record))

    def broken(*args, **kwargs):
        raise RuntimeError('Synthetic monitoring failure')

    monkeypatch.setattr(store.workspaces.monitoring, 'compute', broken)
    with pytest.raises(RuntimeError):
        store.add_reading(
            'owner',
            'owner@example.invalid',
            ID,
            dict(
                kind='material',
                room='Bathroom',
                material='Drywall',
                unit='%WME',
                moisture=22,
                dry_standard=12,
                affected=True,
                taken_at='2026-10-21T10:00:00Z',
            ),
        )
    assert stored(store.db, 'drying_logs/' + ID) is None
    assert stored(store.db, '_job_monitoring/' + ID) is None


def test_extras_approval_is_atomic_private_and_revision_bound():
    from backend.contracts import ExtraApprove
    from tests.test_extras import proposed, EXTRA_ID

    first, second = instances(CompanyInspectionStore)
    seed_company(first.db)
    payload = data()
    payload['extras'] = [proposed()]
    record = first.create_inspection('owner', ID, payload)
    request = ExtraApprove(
        expected_revision=record['revision'],
        expected_company_version=1,
        owner_name='Synthetic Owner',
    )
    results = concurrently(
        [
            lambda: first.approve_extra('owner', ID, EXTRA_ID, request),
            lambda: second.approve_extra('owner', ID, EXTRA_ID, request),
        ]
    )
    outcomes(results, refused=Conflict)
    current = first.get_inspection('owner', ID)
    assert current['revision'] == 2 and current['audit'] is None
    assert current['data']['extras'][0]['approval']['total'] == '118.65'
    entries = [snap.to_dict() for snap in first.db.collection('_admin_events').stream()]
    assert len([entry for entry in entries if entry['action'] == 'extra_approved']) == 1
    for token in (browser_token('owner'), browser_token('owner', role='owner', admin=True)):
        assert browser_request('GET', 'inspections/' + ID, token) == 403
        assert (
            browser_request(
                'PATCH', 'inspections/' + ID, token, {'fields': {'extras': {'arrayValue': {}}}}
            )
            == 403
        )
        assert (
            browser_request(
                'PATCH',
                '_companies/adr',
                token,
                {'fields': {'additional_work_rate': {'doubleValue': 1}}},
            )
            == 403
        )
    assert first.get_inspection('owner', ID)['data']['extras'][0]['approval']['total'] == '118.65'


def test_insight_cache_transaction_rechecks_facts_access_and_expiry(monkeypatch):
    from datetime import datetime, timedelta, timezone
    from backend import ai_features
    from backend.insights import Insights, JobSummary

    monkeypatch.setattr(ai_features, 'AI_FEATURES', frozenset({'job_summary', 'ai_usage'}))
    first, second = instances(CompanyInspectionStore)
    seed_company(first.db)
    first.create_inspection('owner', ID, data())
    readers = [Insights(first), Insights(second)]
    before = stored(first.db, 'inspections/' + ID)
    current = readers[0].view('owner', ID)
    selection = JobSummary(topics=['rooms', 'equipment'])
    results = concurrently(
        [lambda r=r: r.save('owner', ID, current['facts_hash'], selection) for r in readers]
    )
    outcomes(results, Conflict)
    readers[0].save('owner', ID, current['facts_hash'], selection)
    cached = stored(first.db, '_job_insights/' + ID)
    assert cached['company_id'] == 'adr'
    assert cached['expire_at'] - datetime.fromisoformat(cached['generated_at']) == timedelta(
        days=30
    )
    assert readers[1].view('owner', ID)['narrative'] == cached['narrative']
    assert stored(first.db, 'inspections/' + ID) == before
    # A source update between generation and commit invalidates the candidate.
    first.db.document('inspections/' + ID).update({'data.air_movers': 9})
    with pytest.raises(Conflict):
        readers[1].save('owner', ID, current['facts_hash'], selection)
    assert stored(first.db, '_job_insights/' + ID) == cached
    current = readers[1].view('owner', ID)
    assert current['stale'] and current['narrative'] is None
    readers[1].save('owner', ID, current['facts_hash'], selection)
    first.db.document('_job_insights/' + ID).update(
        {'expire_at': datetime.now(timezone.utc) - timedelta(seconds=1)}
    )
    assert readers[0].view('owner', ID)['narrative'] is None
    # Emulators do not execute TTL deletion; simulate that lifecycle explicitly.
    first.db.document('_job_insights/' + ID).delete()
    assert readers[0].view('owner', ID)['narrative'] is None
    readers[1].save('owner', ID, current['facts_hash'], selection)
    for token in (browser_token('owner'), browser_token('owner', superadmin=True)):
        for method, path, body in [
            ('GET', '_job_insights/' + ID, None),
            ('GET', '_job_insights', None),
            ('PATCH', '_job_insights/' + ID, {'fields': {'narrative': {'stringValue': 'forged'}}}),
            ('DELETE', '_job_insights/' + ID, None),
        ]:
            assert browser_request(method, path, token, body) == 403
    first.db.document('_memberships/owner').update({'status': 'disabled'})
    with pytest.raises(AccessDenied):
        readers[0].save('owner', ID, current['facts_hash'], selection)
    with pytest.raises(AccessDenied):
        readers[1].view('owner', ID)


def test_job_summary_daily_limit_and_usage_reads_share_transactional_counters(clock):
    first, second = instances()
    first.db.document('_limits/owner').set({'job_summary_day': {'start': clock[0], 'count': 59}})
    admitted = len(
        outcomes(
            concurrently([lambda s=s: s.quota('owner', 'job_summary', 6) for s in (first, second)])
        )
    )
    assert admitted <= 1
    if not admitted:
        first.quota('owner', 'job_summary', 6)
    before = stored(first.db, '_limits/owner')
    assert second.usage('owner')['job_summary'] == dict(used=60, limit=60, remaining=0)
    with pytest.raises(Limited):
        second.quota('owner', 'job_summary', 6)
    assert stored(first.db, '_limits/owner') == before
    clock[0] += 86400
    assert first.usage('owner')['job_summary'] == dict(used=0, limit=60, remaining=60)
    assert stored(first.db, '_limits/owner') == before


def test_price_publish_rolls_back_and_two_publishes_keep_one_generation():
    """A failure before the audit event commits nothing, and two publishes cannot both win."""
    from backend import price_books

    def stop():
        raise RuntimeError('stop before the event')

    price_books.set_enabled(True)
    try:
        stores = instances(CompanyInspectionStore)
        seed_company(stores[0].db)
        books = stores[0].workspaces.prices
        changed = dict(adr_rates(), emergency_call='150.00')
        other = dict(adr_rates(), emergency_call='160.00')
        payload = {
            'rates': changed,
            'acknowledgements': [],
            'change_reason': 'Trip charge review',
            'source': 'manual',
        }
        preview = books.preview('owner', 'adr', payload)
        books._before_event = stop
        with pytest.raises(RuntimeError):
            books.publish('owner', 'adr', preview['preview_id'], preview['generation'])
        assert list(stores[0].db.collection('_price_book_versions').stream()) == []
        assert stored(stores[0].db, '_company_price_books/adr') is None
        assert stored(stores[0].db, '_companies/adr')['version'] == 1
        books._before_event = None
        first = books.preview('owner', 'adr', payload)
        second = stores[1].workspaces.prices.preview(
            'owner',
            'adr',
            {
                'rates': other,
                'acknowledgements': [],
                'change_reason': 'A competing trip charge',
                'source': 'manual',
            },
        )
        outcomes(
            concurrently(
                [
                    lambda: books.publish('owner', 'adr', first['preview_id'], first['generation']),
                    lambda: stores[1].workspaces.prices.publish(
                        'owner', 'adr', second['preview_id'], second['generation']
                    ),
                ]
            ),
            refused=Conflict,
        )
        if not list(stores[0].db.collection('_price_book_versions').stream()):
            books.publish('owner', 'adr', first['preview_id'], 0)
        assert len(list(stores[0].db.collection('_price_book_versions').stream())) == 1
        assert stored(stores[0].db, '_company_price_books/adr')['generation'] == 1
        assert stored(stores[0].db, '_companies/adr')['version'] == 1
    finally:
        price_books.set_enabled(None)


def test_v2_publish_and_working_copy_transactions():
    """v2 publish rollback leaves working copy intact, competing publishes keep one generation,
    winning publish deletes the working copy, and client rules deny _price_book_drafts."""
    from backend import price_books, price_table

    def stop():
        raise RuntimeError('stop before the event')

    def priced_v2(amount):
        table = price_table.starter_table()
        for item in table['items']:
            if item['enabled']:
                item['unit_price'] = amount
            if item['group'] == 'extras':
                item['enabled'] = False
        return table

    price_books.set_enabled(True)
    try:
        stores = instances(CompanyInspectionStore)
        seed_company(stores[0].db)
        books = stores[0].workspaces.prices
        table_a = priced_v2('25.00')
        table_b = priced_v2('35.00')

        # Save a working copy and verify client rules deny direct access to _price_book_drafts
        wc = books.save_working_copy(
            'owner',
            'adr',
            {
                'expected_working_version': 0,
                'expected_generation': 0,
                'items': table_a['items'],
                'policy': table_a['policy'],
            },
        )
        assert wc['working_version'] == 1
        assert stored(stores[0].db, '_price_book_drafts/adr') is not None

        for token in (browser_token('owner'), browser_token('owner', superadmin=True)):
            for method, path, body in [
                ('GET', '_price_book_drafts/adr', None),
                ('GET', '_price_book_drafts', None),
                (
                    'PATCH',
                    '_price_book_drafts/adr',
                    {'fields': {'working_version': {'integerValue': '99'}}},
                ),
                ('DELETE', '_price_book_drafts/adr', None),
            ]:
                assert browser_request(method, path, token, body) == 403

        # Competing working-copy saves at the same expected_working_version admit at most one
        wc_outcomes = outcomes(
            concurrently(
                [
                    lambda: books.save_working_copy(
                        'owner',
                        'adr',
                        {
                            'expected_working_version': 1,
                            'expected_generation': 0,
                            'items': table_a['items'],
                            'policy': table_a['policy'],
                        },
                    ),
                    lambda: stores[1].workspaces.prices.save_working_copy(
                        'owner',
                        'adr',
                        {
                            'expected_working_version': 1,
                            'expected_generation': 0,
                            'items': table_b['items'],
                            'policy': table_b['policy'],
                        },
                    ),
                ]
            ),
            refused=Conflict,
        )
        assert len(wc_outcomes) <= 1

        # A publish failure before the audit event rolls back both the version and the working-copy deletion
        preview_a = books.preview(
            'owner',
            'adr',
            {
                'items': table_a['items'],
                'policy': table_a['policy'],
                'acknowledgements': [],
                'change_reason': 'First v2 table',
                'source': 'manual',
            },
        )
        books._before_event = stop
        with pytest.raises(RuntimeError):
            books.publish('owner', 'adr', preview_a['preview_id'], preview_a['generation'])
        assert list(stores[0].db.collection('_price_book_versions').stream()) == []
        assert stored(stores[0].db, '_company_price_books/adr') is None
        assert stored(stores[0].db, '_price_book_drafts/adr') is not None
        books._before_event = None

        # Competing v2 publishes keep one generation and delete the working copy
        first = books.preview(
            'owner',
            'adr',
            {
                'items': table_a['items'],
                'policy': table_a['policy'],
                'acknowledgements': [],
                'change_reason': 'First v2 table',
                'source': 'manual',
            },
        )
        second = stores[1].workspaces.prices.preview(
            'owner',
            'adr',
            {
                'items': table_b['items'],
                'policy': table_b['policy'],
                'acknowledgements': [],
                'change_reason': 'Competing v2 table',
                'source': 'manual',
            },
        )
        outcomes(
            concurrently(
                [
                    lambda: books.publish('owner', 'adr', first['preview_id'], first['generation']),
                    lambda: stores[1].workspaces.prices.publish(
                        'owner', 'adr', second['preview_id'], second['generation']
                    ),
                ]
            ),
            refused=Conflict,
        )
        if not list(stores[0].db.collection('_price_book_versions').stream()):
            books.publish('owner', 'adr', first['preview_id'], 0)
        assert len(list(stores[0].db.collection('_price_book_versions').stream())) == 1
        head = stored(stores[0].db, '_company_price_books/adr')
        assert head['generation'] == 1
        assert head['calculation_version'] == price_table.CALCULATION_VERSION
        assert stored(stores[0].db, '_price_book_drafts/adr') is None
        assert stored(stores[0].db, '_companies/adr')['version'] == 1
    finally:
        price_books.set_enabled(None)


def test_switch_from_a_rate_book_and_reprice_transactions():
    """Starting and publishing the switch and repricing a kept draft run in real transactions."""
    from backend import price_books, price_table

    price_books.set_enabled(True)
    try:
        stores = instances(CompanyInspectionStore)
        db = stores[0].db
        seed_company(db)
        books = stores[0].workspaces.prices
        rates = adr_rates()
        rates['emergency_call'] = '150.00'
        preview = books.preview(
            'owner',
            'adr',
            {
                'rates': rates,
                'acknowledgements': [],
                'change_reason': 'Starting rates',
                'source': 'manual',
            },
        )
        first = books.publish('owner', 'adr', preview['preview_id'], preview['generation'])
        record = stores[0].create_inspection('owner', ID, data())
        assert stored(db, '_job_pricing/' + ID) is None

        started = books.start_v2('owner', 'adr')
        with pytest.raises(Conflict):
            stores[1].workspaces.prices.start_v2('owner', 'adr')
        copy = started['working_copy']
        assert stored(db, '_company_price_books/adr').get('calculation_version') != (
            price_table.CALCULATION_VERSION
        )
        preview = books.preview(
            'owner',
            'adr',
            {
                'items': copy['items'],
                'policy': copy['policy'],
                'acknowledgements': [
                    row['item_id'] for row in copy['items'] if row['unit_price'] == '0.00'
                ],
                'change_reason': 'Move to our own table',
                'source': 'manual',
            },
        )
        books.publish('owner', 'adr', preview['preview_id'], preview['generation'])
        head = stored(db, '_company_price_books/adr')
        assert head['calculation_version'] == price_table.CALCULATION_VERSION
        assert head['last_v1_version_id'] == first['version_id']
        assert stored(db, '_price_book_drafts/adr') is None

        # The draft begun earlier stays on the rate book, and only the owner's reprice moves it.
        record = stores[0].get_inspection('owner', ID)
        review = books.reprice_preview('owner', record)
        assert review['from_version_id'] == first['version_id']
        books.reprice(
            'owner',
            ID,
            {
                'expected_revision': review['revision'],
                'expected_pin_hash': review['from_hash'],
                'destination_version_id': review['to_version_id'],
                'destination_hash': review['to_hash'],
            },
        )
        pin = stored(db, '_job_pricing/' + ID)
        assert pin['calculation_version'] == price_table.CALCULATION_VERSION
        assert pin['reason'] == 'explicit_reprice'
        assert stored(db, 'inspections/' + ID)['audit'] is None
    finally:
        price_books.set_enabled(None)


def test_two_instances_run_one_retention_sweep_that_deletes_each_record_once(monkeypatch):
    """Record retention in real transactions: the daily lease admits one sweep, the activity-log
    range query and invitation paging run on Firestore, and each record is deleted once."""
    import hashlib
    from datetime import datetime, timezone

    import backend.retention as retention
    from backend.workspaces import ArchiveRequest

    monkeypatch.setattr(retention, '_forced', True)
    stores = instances(CompanyInspectionStore)
    db = stores[0].db
    seed_company(db)
    now = time.time()
    old = datetime.fromtimestamp(now - 200 * 86400, timezone.utc).isoformat()
    recent = datetime.fromtimestamp(now - 10 * 86400, timezone.utc).isoformat()
    for index in range(3):
        identifier = f'{index:032x}'
        email = f'invitee{index}@example.invalid'
        db.document('_invitations/' + identifier).set(
            dict(
                invitation_id=identifier,
                company_id='adr',
                email=email,
                role='estimator',
                status='accepted' if index else 'pending',
                # The pending one has not expired; the others expired 200 days ago.
                expires_at=now + 86400 if not index else now - 200 * 86400,
                created_at=old,
            )
        )
        key = hashlib.sha256(('adr:' + email).encode()).hexdigest()
        db.document('_invite_keys/' + key).set({'invitation_id': identifier})
    for identifier, created in (('a' * 32, old), ('b' * 32, recent)):
        db.document('_admin_events/' + identifier).set(
            dict(
                event_id=identifier, company_id='adr', action='company_profile', created_at=created
            )
        )
    db.document('_admin_events/' + 'c' * 32).set(
        dict(event_id='c' * 32, company_id='other', action='company_profile', created_at=old)
    )
    store = stores[0]
    store.create_inspection('owner', ID, data())
    record = store.add_photo(
        'owner',
        ID,
        dict(
            photo_id='d' * 32,
            expected_revision=1,
            room='Bathroom',
            captured_at='2026-10-01T10:00:00Z',
            data_url=png(),
        ),
    )
    path = record['photos'][0]['file']['path']
    job = stored(db, '_workspace_jobs/' + ID)
    store.workspaces.archive_job('owner', ID, ArchiveRequest(expected_version=job['version']))
    db.document('_workspace_jobs/' + ID).update({'archived_at': old})

    keepers = [retention.Retention(s.workspaces, s.bucket) for s in stores]
    results = concurrently([lambda k=k: k.tick('owner', 'adr', now) for k in keepers])
    ran = [r for r in outcomes(results, refused=()) if r['ran']]
    assert len(ran) <= 1
    if not ran:  # both lost the lease transaction to emulator contention; run again in sequence
        ran = [keepers[0].tick('owner', 'adr', now)]
    assert ran[0]['deleted'] == dict(
        invitations=2, admin_events=1, job_monitoring=0, evidence_photos=1
    )
    left = {s.id for s in db.collection('_invitations').stream()}
    assert left == {f'{0:032x}'}
    assert len(list(db.collection('_invite_keys').stream())) == 1
    events = {s.id: s.to_dict() for s in db.collection('_admin_events').stream()}
    assert 'a' * 32 not in events and {'b' * 32, 'c' * 32} <= set(events)
    runs = [e for e in events.values() if e['action'] == 'retention_run']
    assert len(runs) == 1 and runs[0]['actor_uid'] == 'system:retention'
    assert path not in store.bucket.objects
    assert stored(db, 'inspections/' + ID)['photos'] == []
    assert keepers[1].tick('owner', 'adr', now + 60) == {'ran': False}


def test_company_spending_reservations_and_crash_holds_across_real_clients():
    company_spending_reservations(instances, concurrently, outcomes)
