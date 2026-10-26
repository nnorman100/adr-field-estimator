"""Company price books. Seed output matches the ADR workbook while the feature is off."""

import logging
from copy import deepcopy
from decimal import Decimal

import pytest
from backend import ai_features, price_books
from backend.claims import PRETEST, make_documents, price_scope, proposal_range
from backend.contracts import AIResult, InspectionData
from backend.price_books import seed_rates
from tests.fakes import ADR_PROFILE
from tests.test_backend import sign_payload
from tests.test_workspaces import ID, api, data, store

COPY = 'ADR-INS-' + 'b' * 32
AI = AIResult(summary='Confirmed scope.', suggestions=[], unpriced_work=[])


@pytest.fixture
def enabled():
    price_books.set_enabled(True)
    yield
    price_books.set_enabled(None)


def rates(**changes):
    book = seed_rates()
    book.update(changes)
    return book


def test_seed_matches_workbook_lines_and_ignores_callers_without_a_book():
    items, total = price_scope(
        InspectionData(
            address='Synthetic',
            year_built=1960,
            rooms=[],
            air_movers=3,
            dehumidifiers=1,
            scope_confirmed=True,
        )
    )
    assert sum(Decimal(str(i['total'])) for i in items[:5]) == Decimal('1180.20')
    assert total == 1747.2
    demo, _ = price_scope(
        InspectionData(
            address='Synthetic',
            year_built=2000,
            rooms=[{'name': 'Room', 'category': 1, 'finished_sf': 36, 'waste_percent': 10}],
            scope_confirmed=True,
        )
    )
    assert demo[5]['total'] == 110.09
    scope = InspectionData(
        address='Sample',
        year_built=2000,
        rooms=[{'name': 'Sample room', 'category': 2, 'unfinished_sf': 140, 'finished_sf': 5}],
        is_after_hours=True,
        air_movers=3,
        dehumidifiers=1,
        drying_days=3,
        scope_confirmed=True,
    )
    items, total = price_scope(scope)
    low, high = proposal_range(scope, items)
    assert total == 2174.45 and low == Decimal('2219.90') and high == Decimal('2356.25')
    custom = rates(demo_cat1_finished='3.00')
    changed, _ = price_scope(
        InspectionData(
            address='Synthetic',
            year_built=2000,
            rooms=[
                {'name': 'Room', 'category': 1, 'finished_sf': 36, 'waste_percent': 10},
                {'name': 'Other', 'category': 2, 'finished_sf': 1},
            ],
            labor_hours=2,
            is_after_hours=True,
            scope_confirmed=True,
        ),
        custom,
    )
    assert next(i for i in changed if 'category 1' in i['description'])['unit_price'] == 3
    assert next(i for i in changed if 'category 2' in i['description'])['unit_price'] == 2.89
    assert next(i for i in changed if i['code'] == 'ADR-LABOR')['unit_price'] == 47.46
    cabinetry, _ = price_scope(
        InspectionData(
            address='Synthetic',
            year_built=2000,
            rooms=[
                {
                    'name': 'Room',
                    'category': 3,
                    'finished_sf': 1,
                    'custom_cabinetry': True,
                }
            ],
            scope_confirmed=True,
        ),
        rates(demo_cat3_finished='10.00'),
    )
    assert cabinetry[-1]['total'] == 20
    small = InspectionData(
        address='Synthetic',
        year_built=2000,
        rooms=[{'name': 'Room', 'finished_sf': Decimal('1000.99')}],
        scope_confirmed=True,
    )
    large = InspectionData(
        address='Synthetic',
        year_built=2000,
        rooms=[{'name': 'Room', 'finished_sf': 1001}],
        scope_confirmed=True,
    )
    _, small_high = proposal_range(small, price_scope(small, custom)[0])
    _, large_high = proposal_range(large, price_scope(large, custom)[0])
    assert small_high > large_high
    old = make_documents(
        InspectionData(
            address='Synthetic',
            year_built=1960,
            rooms=[{'name': 'Bath', 'finished_sf': 10}],
            scope_confirmed=True,
        ),
        [],
        AI,
    )
    assert 'price_basis' not in old and PRETEST in old['adr_estimate']['disclaimers']


def test_bounds_reject_symbols_extra_digits_and_unacked_zeros():
    with pytest.raises(ValueError):
        price_books.normalize_rates(rates(emergency_call='1.239'))
    for bad in ('$10', '1e2', '-1', '', '10,00'):
        with pytest.raises(ValueError):
            price_books.normalize_rates(rates(emergency_call=bad))
    with pytest.raises(ValueError, match='confirm'):
        price_books.normalize_rates(rates(emergency_call='0'))
    assert (
        price_books.normalize_rates(rates(emergency_call='0'), ['emergency_call'])['emergency_call']
        == '0.00'
    )
    with pytest.raises(ValueError):
        price_books.normalize_rates(rates(additional_work_hourly='0'), ['additional_work_hourly'])
    with pytest.raises(ValueError):
        price_books.normalize_rates(rates(additional_work_hourly='10000.01'))
    assert (
        price_books.normalize_rates(rates(additional_work_hourly='10000'))['additional_work_hourly']
        == '10000.00'
    )
    with pytest.raises(ValueError):
        price_books.normalize_rates(rates(monitoring_hourly='1000.01'))


def test_flag_off_hides_prices_and_leaves_quotes_and_documents(api, monkeypatch):
    client, current, _ = api
    monkeypatch.setattr(ai_features, 'AI_FEATURES', {'priced_extras'})
    assert price_books.price_books_enabled() is False
    session = client.get('/api/session').json()
    assert session['price_books_enabled'] is False
    assert 'prices_read' not in session['capabilities']
    for uid, status in (('owner', 404), ('estimator', 404), ('admin', 404), ('other-owner', 404)):
        current['uid'] = uid
        assert client.get('/api/companies/adr/prices').status_code == status
    current['uid'] = 'admin'
    assert client.get('/api/admin/companies/adr/prices').status_code == 404
    current['uid'] = 'office'
    assert client.get('/api/admin/companies/adr/prices').status_code == 403
    current['uid'] = 'estimator'
    created = client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    assert created.status_code == 200, created.text
    quote = client.post(f'/api/inspections/{ID}/extras/quote', json={'hours': '2.5'})
    assert quote.status_code == 200, quote.text
    assert quote.json() == {'rate': '47.46', 'total': '118.65', 'company_version': 1}
    audited = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
    assert audited.status_code == 200, audited.text
    documents = audited.json()['audit']['documents']
    assert 'price_basis' not in documents
    assert documents['adr_estimate']['proposed_cost_low'] == 1775


def publish(client, book, reason='Trip charge for this company'):
    preview = client.post(
        '/api/companies/adr/prices/preview',
        json={'rates': book, 'acknowledgements': [], 'change_reason': reason},
    )
    assert preview.status_code == 200, preview.text
    body = preview.json()
    if body['no_changes']:
        return body
    saved = client.post(
        '/api/companies/adr/prices/publish',
        json={'preview_id': body['preview_id'], 'expected_generation': body['generation']},
    )
    assert saved.status_code == 200, saved.text
    return saved.json()


def test_publish_pins_isolation_reprice_and_signing(api, enabled, caplog):
    client, current, db = api
    current['uid'] = 'estimator'
    created = client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    assert created.status_code == 200, created.text
    audited = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
    assert audited.status_code == 200, audited.text
    first = audited.json()
    basis = first['audit']['documents']['price_basis']
    assert basis['sequence'] == 0 and basis['version_id'] == 'seed'
    assert basis['content_sha256'] == price_books.content_hash(seed_rates())
    assert 'Priced from' not in first['audit']['documents']['adr_estimate']['disclaimers']
    proposal = first['audit']['proposal_hash']
    current['uid'] = 'estimator'
    assert (
        client.post(
            '/api/companies/adr/prices/preview',
            json={'rates': rates(emergency_call='150'), 'change_reason': 'Estimator edit'},
        ).status_code
        == 403
    )
    current['uid'] = 'other-owner'
    assert client.get('/api/companies/adr/prices').status_code == 403
    current['uid'] = 'owner'
    assert client.get('/api/session').json()['capabilities'].count('prices_manage') == 1
    company_version = client.get('/api/companies/adr').json()['version']
    with caplog.at_level(logging.INFO, logger='adr'):
        published = publish(client, rates(emergency_call='150.00'))
    assert published['sequence'] == 1
    assert '150.00' not in caplog.text and 'Trip charge' not in caplog.text
    assert client.get('/api/companies/adr').json()['version'] == company_version
    again = client.get(f'/api/inspections/{ID}').json()
    assert again['audit']['proposal_hash'] == proposal
    assert again['audit']['documents']['price_basis']['content_sha256'] == basis['content_sha256']
    current['uid'] = 'estimator'
    second_id = 'ADR-INS-' + 'd' * 32
    made = client.post('/api/inspections', json={'inspection_id': second_id, 'data': data()})
    assert made.status_code == 200, made.text
    second = client.post('/api/audit', json={'inspection_id': second_id, 'expected_revision': 1})
    assert second.status_code == 200, second.text
    new_basis = second.json()['audit']['documents']['price_basis']
    assert new_basis['sequence'] == 1
    assert new_basis['rates']['emergency_call'] == '150.00'
    assert new_basis['content_sha256'] != basis['content_sha256']
    current['uid'] = 'owner'
    preview = client.post(f'/api/inspections/{ID}/pricing/reprice-preview')
    assert preview.status_code == 200, preview.text
    review = preview.json()
    assert review['before'] != review['after']
    assert review['diff'][0]['key'] == 'emergency_call'
    current['uid'] = 'estimator'
    assert client.post(f'/api/inspections/{ID}/pricing/reprice-preview').status_code == 403
    current['uid'] = 'owner'
    applied = client.post(
        f'/api/inspections/{ID}/pricing/reprice',
        json={
            'expected_revision': review['revision'],
            'expected_pin_hash': review['from_hash'],
            'destination_version_id': review['to_version_id'],
            'destination_hash': review['to_hash'],
        },
    )
    assert applied.status_code == 200, applied.text
    repriced = applied.json()
    assert repriced['revision'] == review['revision'] + 1
    assert repriced['audit'] is None and repriced['data']['scope_confirmed'] is False
    assert db.db.records[f'_job_pricing/{ID}']['content_sha256'] == review['to_hash']
    stale = client.post(
        '/api/authorize',
        json=dict(sign_payload(first), expected_revision=repriced['revision']),
    )
    assert stale.status_code == 409
    # A second publish of the same preview is idempotent and does not add a version.
    repeated = client.post(
        '/api/companies/adr/prices/publish',
        json={'preview_id': published['version_id'], 'expected_generation': 1},
    )
    assert repeated.status_code == 200, repeated.text
    assert repeated.json()['idempotent'] is True
    versions = [key for key in db.db.records if key.startswith('_price_book_versions/')]
    assert len(versions) == 1
    conflict = client.post(
        '/api/companies/adr/prices/preview',
        json={'rates': rates(emergency_call='160.00'), 'change_reason': 'A later trip charge'},
    )
    assert conflict.status_code == 200, conflict.text
    raced = client.post(
        '/api/companies/adr/prices/publish',
        json={'preview_id': conflict.json()['preview_id'], 'expected_generation': 0},
    )
    assert raced.status_code == 409
    listing = client.get('/api/companies/adr/prices/history').json()
    assert listing['versions'][0]['change_reason'] == 'Trip charge for this company'
    assert any(entry.get('diff') for entry in listing['events'])
    current['uid'] = 'estimator'
    member = client.get('/api/companies/adr/prices/history').json()
    assert member['events'] == [] and 'change_reason' not in member['versions'][0]
    current['uid'] = 'admin'
    support = client.get('/api/admin/companies/adr/prices').json()
    assert support['can_manage'] is False and support['rates']
    current['uid'] = 'office'
    assert client.get('/api/admin/companies/adr/prices').status_code == 403


def test_signed_jobs_copies_and_profile_rate_stay_put(api, enabled, monkeypatch):
    client, current, db = api
    monkeypatch.setattr(ai_features, 'AI_FEATURES', {'priced_extras'})
    current['uid'] = 'estimator'
    record = client.post('/api/inspections', json={'inspection_id': ID, 'data': data()}).json()
    record = client.post(
        '/api/audit', json={'inspection_id': ID, 'expected_revision': record['revision']}
    ).json()
    current['uid'] = 'owner'
    signed = client.post('/api/authorize', json=sign_payload(record))
    assert signed.status_code == 200, signed.text
    before = deepcopy(db.db.records[f'authorizations/{signed.json()["auth_id"]}'])
    publish(client, rates(emergency_call='150.00'), 'After signing')
    assert db.db.records[f'authorizations/{signed.json()["auth_id"]}'] == before
    assert client.post(f'/api/inspections/{ID}/pricing/reprice-preview').status_code == 409
    copied = client.post(
        f'/api/authorizations/{signed.json()["auth_id"]}/copy', json={'inspection_id': COPY}
    )
    assert copied.status_code == 200, copied.text
    assert f'_job_pricing/{COPY}' not in db.db.records
    current['uid'] = 'owner'
    confirmed = dict(copied.json()['data'])
    confirmed['scope_confirmed'] = True
    ready = client.put(
        f'/api/inspections/{COPY}',
        json={'expected_revision': copied.json()['revision'], 'data': confirmed},
    )
    assert ready.status_code == 200, ready.text
    follow = client.post(
        '/api/audit', json={'inspection_id': COPY, 'expected_revision': ready.json()['revision']}
    )
    assert follow.status_code == 200, follow.text
    assert follow.json()['audit']['documents']['price_basis']['sequence'] == 1
    profile = {**ADR_PROFILE, 'additional_work_rate': '55.00'}
    refused = client.put('/api/companies/adr', json={'expected_version': 1, 'profile': profile})
    assert refused.status_code == 409
    kept = client.put('/api/companies/adr', json={'expected_version': 1, 'profile': ADR_PROFILE})
    assert kept.status_code == 200, kept.text
    assert kept.json()['profile']['additional_work_rate'] == '47.46'
    quote = client.post(f'/api/inspections/{COPY}/extras/quote', json={'hours': '2.5'})
    assert quote.status_code == 200, quote.text
    body = quote.json()
    assert body['rate'] == '47.46' and body['price_content_sha256']
    updated = dict(follow.json()['data'])
    updated['extras'] = [
        {
            'id': 'e' * 32,
            'description': 'Move and reset toilet',
            'hours': '2.5',
            'origin': 'manual',
            'unpriced_item': '',
            'approval': None,
        }
    ]
    saved = client.put(
        f'/api/inspections/{COPY}',
        json={'expected_revision': follow.json()['revision'], 'data': updated},
    )
    assert saved.status_code == 200, saved.text
    bare = client.post(
        f'/api/inspections/{COPY}/extras/{"e" * 32}/approve',
        json={
            'expected_revision': saved.json()['revision'],
            'expected_company_version': body['company_version'],
            'owner_name': 'Test Owner',
        },
    )
    assert bare.status_code == 409
    approved = client.post(
        f'/api/inspections/{COPY}/extras/{"e" * 32}/approve',
        json={
            'expected_revision': saved.json()['revision'],
            'expected_company_version': body['company_version'],
            'expected_price_hash': body['price_rate_fingerprint'],
            'owner_name': 'Test Owner',
        },
    )
    assert approved.status_code == 200, approved.text


def test_import_preview_matches_the_published_book(api, enabled):
    client, current, db = api
    current['uid'] = 'owner'
    exported = client.get('/api/companies/adr/prices/export')
    assert exported.status_code == 200, exported.text
    assert exported.headers['content-disposition'].endswith('filename="company-prices.csv"')
    raw = exported.content.replace(b'133.95', b'150.00', 1)
    preview = client.post(
        '/api/companies/adr/prices/import-preview',
        files={'file': ('company-prices.csv', raw, 'text/csv')},
        data={'change_reason': 'Imported trip charge'},
    )
    assert preview.status_code == 200, preview.text
    body = preview.json()
    assert (
        body['diff']
        == [
            row
            for row in body['diff']
            if row['key'] == 'emergency_call' and row['after'] == '150.00'
        ]
        or body['diff'][0]['after'] == '150.00'
    )
    saved = client.post(
        '/api/companies/adr/prices/publish',
        json={'preview_id': body['preview_id'], 'expected_generation': body['generation']},
    )
    assert saved.status_code == 200, saved.text
    published = client.get('/api/companies/adr/prices').json()
    prices = {row['key']: row['unit_price'] for row in published['rates']}
    assert prices['emergency_call'] == '150.00'
    assert prices['demo_cat1_finished'] == '2.78'
    sheet = client.get('/api/companies/adr/prices/export?format=xlsx')
    assert sheet.status_code == 200
    parsed = price_books.normalize_rates(
        __import__('backend.price_book_import', fromlist=['parse_upload']).parse_upload(
            sheet.content,
            sheet.headers['content-type'],
            'adr',
            published['version_id'],
            published['generation'],
        )
    )
    assert parsed == prices
    db.db.records[f'_price_book_previews/{body["preview_id"]}']['expires'] = (
        '2000-01-01T00:00:00+00:00'
    )
    # The version already exists, so the retry stays idempotent after the preview expires.
    assert (
        client.post(
            '/api/companies/adr/prices/publish',
            json={'preview_id': body['preview_id'], 'expected_generation': body['generation']},
        ).json()['idempotent']
        is True
    )


def test_zero_acknowledgement_large_change_and_expired_preview(api, enabled):
    client, current, db = api
    current['uid'] = 'owner'
    refused = client.post(
        '/api/companies/adr/prices/preview',
        json={'rates': rates(emergency_call='0'), 'change_reason': 'Waive the trip'},
    )
    assert refused.status_code == 400
    warned = client.post(
        '/api/companies/adr/prices/preview',
        json={
            'rates': rates(emergency_call='0.00'),
            'acknowledgements': ['emergency_call'],
            'change_reason': 'Waive the trip',
        },
    )
    assert warned.status_code == 200, warned.text
    assert 'zero_rate' in warned.json()['warnings']
    db.db.records[f'_price_book_previews/{warned.json()["preview_id"]}']['expires'] = (
        '2000-01-01T00:00:00+00:00'
    )
    expired = client.post(
        '/api/companies/adr/prices/publish',
        json={
            'preview_id': warned.json()['preview_id'],
            'expected_generation': warned.json()['generation'],
        },
    )
    assert expired.status_code == 410
    large = client.post(
        '/api/companies/adr/prices/preview',
        json={'rates': rates(hepa_filter='400.00'), 'change_reason': 'Filter price doubled'},
    )
    assert large.status_code == 200, large.text
    assert 'large_change' in large.json()['warnings']
    assert (
        client.post(
            '/api/companies/adr/prices/import-preview',
            files={'file': ('prices.csv', b'x' * (256 * 1024 + 1), 'text/csv')},
            data={'change_reason': 'Too big to import'},
        ).status_code
        == 413
    )


def test_missing_pin_blocks_repeat_audit(api, enabled):
    client, current, store = api
    current['uid'] = 'estimator'
    client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    audited = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
    assert audited.status_code == 200, audited.text
    before = deepcopy(store.db.records['inspections/' + ID])
    del store.db.records['_job_pricing/' + ID]
    result = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
    assert result.status_code == 409, result.text
    assert '_job_pricing/' + ID not in store.db.records
    assert store.db.records['inspections/' + ID] == before


def test_corrupt_pin_blocks_signing(api, enabled):
    client, current, store = api
    current['uid'] = 'estimator'
    client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    audited = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
    assert audited.status_code == 200, audited.text
    store.db.records['_job_pricing/' + ID]['rates']['emergency_call'] = '999.00'
    current['uid'] = 'owner'
    result = client.post('/api/authorize', json=sign_payload(audited.json()))
    assert result.status_code == 409, result.text
    assert not any(key.startswith('authorizations/') for key in store.db.records)


def test_first_publication_after_migration_is_version_one(api, enabled):
    from backend.price_book_migration import apply_plan, build_plan

    client, current, store = api
    apply_plan(store, build_plan(store.db, ['adr']), True)
    current['uid'] = 'owner'
    published = publish(client, rates(emergency_call='150.00'))
    assert published['sequence'] == 1
    assert published['published_at'] and published['effective_from']


def test_flag_rollback_audit_cannot_be_reused_or_signed_on_a_pinned_job(api, enabled):
    client, current, store = api
    current['uid'] = 'owner'
    publish(client, rates(emergency_call='150.00'))
    current['uid'] = 'estimator'
    client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    pinned = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
    assert pinned.status_code == 200, pinned.text
    assert pinned.json()['audit']['documents']['xactimate_scope'][0]['unit_price'] == 150
    price_books.set_enabled(False)
    edited = client.put(
        '/api/inspections/' + ID, json={'expected_revision': 1, 'data': data('Edited property')}
    )
    assert edited.status_code == 200, edited.text
    rollback = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 2})
    assert rollback.status_code == 200, rollback.text
    documents = rollback.json()['audit']['documents']
    assert 'price_basis' not in documents
    assert documents['xactimate_scope'][0]['unit_price'] == 133.95
    current['uid'] = 'owner'
    assert client.post('/api/authorize', json=sign_payload(rollback.json())).status_code == 409
    price_books.set_enabled(True)
    refused = client.post('/api/authorize', json=sign_payload(rollback.json()))
    assert refused.status_code == 409, refused.text
    assert not any(key.startswith('authorizations/') for key in store.db.records)
    current['uid'] = 'estimator'
    fresh = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 2})
    assert fresh.status_code == 200, fresh.text
    renewed = fresh.json()['audit']
    assert renewed['proposal_hash'] != rollback.json()['audit']['proposal_hash']
    assert renewed['documents']['price_basis']['rates']['emergency_call'] == '150.00'
    assert renewed['documents']['xactimate_scope'][0]['unit_price'] == 150
    current['uid'] = 'owner'
    signed = client.post('/api/authorize', json=sign_payload(fresh.json()))
    assert signed.status_code == 200, signed.text
