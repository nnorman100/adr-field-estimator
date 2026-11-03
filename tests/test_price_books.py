"""Company price books. ADR's output matches its workbook while the feature is off."""

import csv
import io
import logging
from copy import deepcopy
from decimal import Decimal

import pytest
from backend import ai_features, price_books
from backend.claims import PRETEST, proposal_range
from tests.adr_pricing import make_documents, price_scope
from backend.contracts import AIResult, InspectionData
from backend.adr_price_book import adr_rates
from backend.price_book_import import export_csv, parse_upload
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
    book = adr_rates()
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


def test_flag_off_hides_the_editor_and_prices_from_the_seed_pin(api, monkeypatch):
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
    assert documents['price_basis']['version_id'] == 'seed'
    assert documents['price_basis']['content_sha256'] == price_books.content_hash(adr_rates())
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
    assert basis['content_sha256'] == price_books.content_hash(adr_rates())
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


STANDALONE = """
import json, sys
import price_books, price_book_store
from workspaces import AccessDenied

price_books.set_enabled(True)
record = json.loads(sys.stdin.read())
from adr_price_book import adr_rates

seed = adr_rates()
pin = dict(
    rates=seed,
    version_id='seed',
    content_sha256=price_books.content_hash(seed),
    calculation_version=price_books.CALCULATION_VERSION,
)


class Workspaces:
    role = 'estimator'

    def company_actor(self, uid, company_id, manage=False, tx=None):
        caps = ['prices_read', 'prices_manage'] if self.role == 'owner' else ['prices_read']
        return dict(company={'company_id': company_id}, capabilities=caps)

    def job_access(self, uid, record, need, tx=None):
        return {'company_id': 'adr'}, {'role': self.role}

    def read(self, collection, key, tx=None):
        if collection == '_job_pricing':
            return pin
        if collection == '_companies':
            return {'company_id': key}
        return None


ws = Workspaces()
books = price_book_store.PriceBookStore(ws)
outcomes = []
for call in (
    lambda: books.preview('u', 'adr', {'rates': seed}),
    lambda: books.reprice_preview('u', record),
):
    try:
        call()
    except AccessDenied:
        outcomes.append('denied')
ws.role = 'owner'
try:
    books.preview('u', 'adr', {'rates': {**seed, 'emergency_call': '1.234'}})
except ValueError:
    outcomes.append('invalid')
outcomes.append(books.reprice_preview('u', record)['after']['itemized'])
print(json.dumps(outcomes))
"""


def test_owner_paths_run_in_the_deployed_top_level_layout():
    import json
    import subprocess
    import sys

    record = {'inspection_id': ID, 'revision': 1, 'status': 'draft', 'data': data()}
    run = subprocess.run(
        [sys.executable, '-c', STANDALONE],
        cwd='backend',
        input=json.dumps(record),
        capture_output=True,
        text=True,
    )
    assert run.returncode == 0, run.stderr
    items, total = price_scope(InspectionData.model_validate(record['data']), adr_rates())
    assert json.loads(run.stdout) == ['denied', 'denied', 'invalid', f'{total:.2f}']


def test_draft_created_after_first_publication_pins_the_current_book(api, enabled):
    client, current, store = api
    early = 'ADR-INS-' + 'e' * 32
    current['uid'] = 'estimator'
    made = client.post('/api/inspections', json={'inspection_id': early, 'data': data()})
    assert made.status_code == 200, made.text
    current['uid'] = 'owner'
    assert publish(client, rates(emergency_call='150.00'))['sequence'] == 1
    current['uid'] = 'estimator'
    made = client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    assert made.status_code == 200, made.text
    current['uid'] = 'owner'
    assert publish(client, rates(emergency_call='175.00'), 'Second trip charge')['sequence'] == 2
    current['uid'] = 'estimator'
    audited = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
    assert audited.status_code == 200, audited.text
    basis = audited.json()['audit']['documents']['price_basis']
    assert basis['sequence'] == 2 and basis['rates']['emergency_call'] == '175.00'
    assert store.db.records['_job_pricing/' + ID]['sequence'] == 2
    older = client.post('/api/audit', json={'inspection_id': early, 'expected_revision': 1})
    assert older.status_code == 200, older.text
    assert older.json()['audit']['documents']['price_basis']['version_id'] == 'seed'
    assert store.db.records['_job_pricing/' + early]['reason'] == 'legacy_rollout'


def counting(monkeypatch):
    import backend.main as bm

    calls = []

    async def generate(schema, *args, **kwargs):
        if schema is AIResult:
            calls.append(schema)
        return AI

    monkeypatch.setattr(bm, 'generate', generate)
    return calls


def daily_audits(store, uid='estimator'):
    return store.db.records.get('_limits/' + uid, {}).get('audit_day', {}).get('count', 0)


def new_window(store, uid='estimator'):
    store.db.records.get('_limits/' + uid, {}).pop('audit_attempt', None)


def test_pricing_reuse_and_signing_ignore_the_flag(api, enabled, monkeypatch):
    client, current, store = api
    calls = counting(monkeypatch)
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
    flag_off = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 2})
    assert flag_off.status_code == 200, flag_off.text
    documents = flag_off.json()['audit']['documents']
    assert documents['xactimate_scope'][0]['unit_price'] == 150
    assert documents['price_basis'] == pinned.json()['audit']['documents']['price_basis']
    used, model = daily_audits(store), len(calls)
    again = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 2})
    assert again.json()['audit'] == flag_off.json()['audit']
    assert (daily_audits(store), len(calls)) == (used, model)
    saved = deepcopy(store.db.records['inspections/' + ID]['audit'])
    store.db.records['inspections/' + ID]['audit']['documents'].pop('price_basis')
    current['uid'] = 'owner'
    refused = client.post('/api/authorize', json=sign_payload(flag_off.json()))
    assert refused.status_code == 409, refused.text
    store.db.records['inspections/' + ID]['audit'] = saved
    signed = client.post('/api/authorize', json=sign_payload(flag_off.json()))
    assert signed.status_code == 200, signed.text


@pytest.mark.parametrize('flag', [False, True])
def test_migrated_drafts_price_reuse_and_sign_the_same_with_the_flag_off_or_on(
    api, flag, monkeypatch
):
    from backend.price_book_migration import apply_plan, build_plan
    from tests.test_signing_links import mint, sign, token

    client, current, store = api
    calls = counting(monkeypatch)
    linked, later = 'ADR-INS-' + 'e' * 32, 'ADR-INS-' + 'f' * 32
    unaudited, edited = 'ADR-INS-' + 'a1' * 16, 'ADR-INS-' + 'a2' * 16
    legacy = (ID, linked, later, edited)
    current['uid'] = 'estimator'
    for inspection_id in legacy + (unaudited,):
        client.post('/api/inspections', json={'inspection_id': inspection_id, 'data': data()})
    for inspection_id in legacy:
        new_window(store)
        audited = client.post(
            '/api/audit', json={'inspection_id': inspection_id, 'expected_revision': 1}
        )
        assert audited.status_code == 200, audited.text
        # Records saved before price books have no pin and no price basis.
        del store.db.records['_job_pricing/' + inspection_id]
        store.db.records['inspections/' + inspection_id]['audit']['documents'].pop('price_basis')
    records = {key: client.get('/api/inspections/' + key).json() for key in legacy}
    issued = mint(client, records[linked], linked)
    assert issued.status_code == 200, issued.text
    before = {key: deepcopy(store.db.records['inspections/' + key]) for key in legacy}
    price_books.set_enabled(flag)
    try:
        plan = build_plan(store.db, ['adr'])
        planned = {row['inspection_id']: row for row in plan['pins']}
        assert all(planned[key]['audit_basis']['version_id'] for key in legacy)
        assert planned[unaudited]['audit_basis'] is None
        dry = deepcopy(store.db.records)
        apply_plan(store, plan, False)
        assert store.db.records == dry
        apply_plan(store, plan, True)
        for key in legacy:
            saved = store.db.records['inspections/' + key]
            pin = store.db.records['_job_pricing/' + key]
            assert saved['audit']['price_basis'] == planned[key]['audit_basis']
            assert saved['audit']['price_basis']['content_sha256'] == pin['content_sha256']
            assert saved['audit']['documents'] == before[key]['audit']['documents']
            assert saved['audit']['proposal_hash'] == records[key]['audit']['proposal_hash']
            assert {k: v for k, v in saved.items() if k != 'audit'} == {
                k: v for k, v in before[key].items() if k != 'audit'
            }
        used, model = daily_audits(store), len(calls)
        new_window(store)
        reused = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
        assert reused.status_code == 200, reused.text
        assert reused.json()['audit']['proposal_hash'] == records[ID]['audit']['proposal_hash']
        assert (daily_audits(store), len(calls)) == (used, model)
        changed = client.put(
            '/api/inspections/' + edited,
            json={'expected_revision': 1, 'data': data('Edited property')},
        )
        assert changed.status_code == 200, changed.text
        for key, revision in ((unaudited, 1), (edited, 2)):
            new_window(store)
            priced = client.post(
                '/api/audit', json={'inspection_id': key, 'expected_revision': revision}
            )
            assert priced.status_code == 200, priced.text
            basis = priced.json()['audit']['documents']['price_basis']
            pin = store.db.records['_job_pricing/' + key]
            assert (basis['version_id'], basis['content_sha256']) == (
                pin['version_id'],
                pin['content_sha256'],
            )
            assert basis['rates'] == adr_rates()
        assert sign(token(issued)).status_code == 200
        fresh = mint(client, records[later], later)
        assert fresh.status_code == 200, fresh.text
        assert sign(token(fresh)).status_code == 200
        current['uid'] = 'owner'
        signed = client.post('/api/authorize', json=sign_payload(records[ID]))
        assert signed.status_code == 200, signed.text
        for key in (ID, linked, later):
            assert store.db.records['inspections/' + key]['status'] == 'signed'
    finally:
        price_books.set_enabled(None)


def _v2_table(unit_price='25.00', extras=False):
    from backend import price_table

    table = price_table.starter_table()
    for item in table['items']:
        if item['enabled']:
            item['unit_price'] = unit_price
        if item['group'] == 'extras':
            item['enabled'] = extras
    return table


@pytest.fixture
def extras_on(monkeypatch):
    monkeypatch.setattr(ai_features, 'AI_FEATURES', {'priced_extras'})


def _publish_v2(client, table, reason='Initial v2 price table', acknowledgements=None):
    preview = client.post(
        '/api/companies/adr/prices/preview',
        json={
            'items': table['items'],
            'policy': table['policy'],
            'acknowledgements': acknowledgements or [],
            'change_reason': reason,
        },
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


def test_v2_version_pin_basis_round_trip(api, enabled):
    from backend import price_table
    from backend.workspaces import Conflict

    client, current, db = api
    current['uid'] = 'owner'
    table = _v2_table('30.00')
    published = _publish_v2(client, table, 'Publish v2 table')
    assert published['sequence'] == 1
    current_book = client.get('/api/companies/adr/prices').json()
    assert current_book['calculation_version'] == price_table.CALCULATION_VERSION
    assert 'items' in current_book and 'policy' in current_book

    prices = db.workspaces.prices
    eff = prices.effective(db.workspaces.read('_companies', 'adr'))
    assert eff['calculation_version'] == price_table.CALCULATION_VERSION
    assert eff['version_id'] == published['version_id']
    assert eff['content_sha256'] == price_table.content_hash(table)
    assert 'items' in eff and 'policy' in eff and 'rates' not in eff

    current['uid'] = 'estimator'
    created = client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    assert created.status_code == 200, created.text
    record = db.get_inspection('estimator', ID)

    pin = prices.ensure_pin('estimator', ID)
    assert pin['calculation_version'] == price_table.CALCULATION_VERSION
    assert pin['version_id'] == published['version_id']
    assert pin['content_sha256'] == eff['content_sha256']
    assert 'items' in pin and 'policy' in pin and 'rates' not in pin

    basis = prices.basis_for(pin, 'adr')
    assert basis['calculation_version'] == price_table.CALCULATION_VERSION
    assert basis['version_id'] == pin['version_id']
    assert basis['content_sha256'] == pin['content_sha256']
    assert basis['policy'] == pin['policy']
    assert basis['item_count'] == len(pin['items'])
    assert 'rates' not in basis and 'items' not in basis

    # Tampered item price is rejected by basis_for
    tampered_item = deepcopy(pin)
    tampered_item['items'][0]['unit_price'] = '999.00'
    with pytest.raises(Conflict, match="This draft's saved prices are missing"):
        prices.basis_for(tampered_item, 'adr')

    # Tampered policy (including after_hours.label and minimum_job_charge) is rejected
    tampered_label = deepcopy(pin)
    tampered_label['policy']['after_hours']['label'] = 'Tampered label'
    with pytest.raises(Conflict, match="This draft's saved prices are missing"):
        prices.basis_for(tampered_label, 'adr')

    tampered_min = deepcopy(pin)
    tampered_min['policy']['minimum_job_charge'] = '750.00'
    with pytest.raises(Conflict, match="This draft's saved prices are missing"):
        prices.basis_for(tampered_min, 'adr')

    # A v1-shaped pin claiming a v2 calculation_version or v2 version_id is rejected
    v1_impostor = {
        'inspection_id': ID,
        'company_id': 'adr',
        'version_id': published['version_id'],
        'sequence': 1,
        'content_sha256': price_books.content_hash(adr_rates()),
        'calculation_version': price_table.CALCULATION_VERSION,
        'rates': adr_rates(),
        'priced_at': pin['priced_at'],
        'priced_by_uid': 'estimator',
    }
    with pytest.raises(Conflict):
        prices.basis_for(v1_impostor, 'adr')

    # assert_pin succeeds with matching audit price_basis and rejects mismatches
    audited_record = deepcopy(record)
    audited_record['audit'] = {
        'price_basis': basis,
        'documents': {'price_basis': basis},
    }
    prices.assert_pin(audited_record, basis)

    bad_basis = deepcopy(basis)
    bad_basis['content_sha256'] = '0' * 64
    with pytest.raises(Conflict):
        prices.assert_pin(audited_record, bad_basis)

    # job_view returns estimator-filtered public items + policy for v2 pins
    view = prices.job_view('estimator', audited_record)
    assert view['pinned']['version_id'] == published['version_id']
    assert view['newer_available'] is False
    assert view['calculation_version'] == price_table.CALCULATION_VERSION
    assert 'items' in view['table'] and 'policy' in view['table']
    assert all('enabled' not in it for it in view['table']['items'])


def test_v1_pins_and_versions_still_validate_unchanged(api, enabled, monkeypatch):
    client, current, db = api
    calls = counting(monkeypatch)
    current['uid'] = 'owner'
    published = publish(client, rates(emergency_call='145.00'), 'V1 trip rate')
    assert published['sequence'] == 1

    prices = db.workspaces.prices
    eff = prices.effective(db.workspaces.read('_companies', 'adr'))
    assert set(eff.keys()) == {
        'company_id',
        'version_id',
        'sequence',
        'parent_version_id',
        'catalog_version',
        'calculation_version',
        'currency',
        'rates',
        'content_sha256',
        'published_by_uid',
        'published_at',
        'effective_from',
        'source',
        'change_reason',
        'import_digest',
        'generation',
    }

    current['uid'] = 'estimator'
    client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    audited = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
    assert audited.status_code == 200, audited.text
    doc_basis = audited.json()['audit']['documents']['price_basis']
    pin = db.db.records[f'_job_pricing/{ID}']
    assert prices.basis_for(pin, 'adr') == doc_basis
    assert set(doc_basis.keys()) == {
        'company_id',
        'version_id',
        'sequence',
        'content_sha256',
        'calculation_version',
        'priced_at',
        'rates',
    }
    saved_rec = db.get_inspection('estimator', ID)
    prices.assert_pin(saved_rec, doc_basis)
    jview = prices.job_view('estimator', saved_rec)
    assert jview['pinned'] is not None and 'display_rates' in jview and 'table' not in jview

    # Audit reuse is byte-identical
    model_count = len(calls)
    reused = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
    assert reused.status_code == 200, reused.text
    assert reused.json()['audit'] == audited.json()['audit']
    assert len(calls) == model_count


def test_working_copy_save_conflicts_and_is_never_used_for_pricing(api, enabled):
    from backend import price_table

    client, current, db = api
    current['uid'] = 'owner'
    head = _publish_v2(client, _v2_table('25.00'), 'Published v2 head')
    assert head['generation'] == 1

    # Working copy starts empty on GET /api/companies/adr/prices
    initial = client.get('/api/companies/adr/prices').json()
    assert initial['working_copy'] is None

    # Save a working copy with a blank price on an enabled item (allowed in working copy, reported in publish_problems)
    draft_table = _v2_table('40.00')
    draft_table['items'][0]['unit_price'] = ''
    draft_table['policy']['after_hours']['label'] = 'Night & weekend dispatch'
    draft_table['policy']['minimum_job_charge'] = '350.00'

    saved_wc = client.put(
        '/api/companies/adr/prices/working-copy',
        json={
            'expected_working_version': 0,
            'expected_generation': 1,
            'items': draft_table['items'],
            'policy': draft_table['policy'],
        },
    )
    assert saved_wc.status_code == 200, saved_wc.text
    wc_body = saved_wc.json()
    assert wc_body['working_copy']['working_version'] == 1
    assert wc_body['working_copy']['base_generation'] == 1
    assert wc_body['working_copy']['policy']['after_hours']['label'] == 'Night & weekend dispatch'
    assert wc_body['working_copy']['policy']['minimum_job_charge'] == '350'
    assert wc_body['problems']

    # Stale expected_working_version returns 409
    stale_ver = client.put(
        '/api/companies/adr/prices/working-copy',
        json={
            'expected_working_version': 0,
            'expected_generation': 1,
            'items': draft_table['items'],
            'policy': draft_table['policy'],
        },
    )
    assert stale_ver.status_code == 409

    # Stale expected_generation returns 409
    stale_gen = client.put(
        '/api/companies/adr/prices/working-copy',
        json={
            'expected_working_version': 1,
            'expected_generation': 0,
            'items': draft_table['items'],
            'policy': draft_table['policy'],
        },
    )
    assert stale_gen.status_code == 409

    # Pinning a job while a working copy exists pins the published head (25.00), never the working copy (40.00)
    current['uid'] = 'estimator'
    est_prices = client.get('/api/companies/adr/prices').json()
    assert est_prices['working_copy'] is None
    client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    pin = db.workspaces.prices.ensure_pin('estimator', ID)
    assert pin['version_id'] == head['version_id']
    assert pin['content_sha256'] == price_table.content_hash(_v2_table('25.00'))
    assert pin['items'][0]['unit_price'] == '25.00'
    assert pin['policy']['minimum_job_charge'] == '0'

    # Role matrix on working-copy PUT and DELETE/discard
    for role_uid, expected_status in (
        ('estimator', 403),
        ('office', 403),
        ('admin', 403),
        ('other-owner', 403),
    ):
        current['uid'] = role_uid
        res = client.put(
            '/api/companies/adr/prices/working-copy',
            json={
                'expected_working_version': 1,
                'expected_generation': 1,
                'items': draft_table['items'],
                'policy': draft_table['policy'],
            },
        )
        assert res.status_code == expected_status, (role_uid, res.text)
        del_res = client.delete('/api/companies/adr/prices/working-copy')
        assert del_res.status_code == expected_status, (role_uid, del_res.text)

    # Discard working copy via DELETE and re-save, then discard via POST /working-copy/discard
    current['uid'] = 'owner'
    discarded = client.delete('/api/companies/adr/prices/working-copy')
    assert discarded.status_code == 200, discarded.text
    assert discarded.json()['working_copy'] is None
    assert '_price_book_drafts/adr' not in db.db.records

    resaved = client.put(
        '/api/companies/adr/prices/working-copy',
        json={
            'expected_working_version': 0,
            'expected_generation': 1,
            'items': draft_table['items'],
            'policy': draft_table['policy'],
        },
    )
    assert resaved.status_code == 200, resaved.text
    discarded_post = client.post('/api/companies/adr/prices/working-copy/discard')
    assert discarded_post.status_code == 200, discarded_post.text
    assert discarded_post.json()['working_copy'] is None

    # Save working copy again, then publish a new v2 table and verify publish deletes the working copy
    resaved2 = client.put(
        '/api/companies/adr/prices/working-copy',
        json={
            'expected_working_version': 0,
            'expected_generation': 1,
            'items': draft_table['items'],
            'policy': draft_table['policy'],
        },
    )
    assert resaved2.status_code == 200
    assert '_price_book_drafts/adr' in db.db.records
    published2 = _publish_v2(client, _v2_table('35.00'), 'Second v2 head')
    assert published2['sequence'] == 2
    assert '_price_book_drafts/adr' not in db.db.records
    after_pub = client.get('/api/companies/adr/prices').json()
    assert after_pub['working_copy'] is None

    # Flag off returns 404
    price_books.set_enabled(False)
    assert (
        client.put(
            '/api/companies/adr/prices/working-copy',
            json={
                'expected_working_version': 0,
                'expected_generation': 2,
                'items': draft_table['items'],
                'policy': draft_table['policy'],
            },
        ).status_code
        == 404
    )
    assert client.delete('/api/companies/adr/prices/working-copy').status_code == 404


def test_restore_across_calculation_versions_is_refused(api, enabled):
    client, current, db = api
    current['uid'] = 'owner'
    v2_first = _publish_v2(client, _v2_table('25.00'), 'First v2 version')
    v2_second = _publish_v2(client, _v2_table('30.00'), 'Second v2 version')
    assert v2_second['sequence'] == 2
    v1_id = 'a' * 32
    seed = adr_rates()
    db.db.records['_price_book_versions/' + v1_id] = {
        'version_id': v1_id,
        'company_id': 'adr',
        'sequence': 0,
        'calculation_version': price_books.CALCULATION_VERSION,
        'rates': seed,
        'content_sha256': price_books.content_hash(seed),
    }

    # Restoring the v1 version when head is v2 is refused with 409
    refused_v1 = client.post(
        f'/api/companies/adr/prices/versions/{v1_id}/restore',
        json={'change_reason': 'Try restore v1'},
    )
    assert refused_v1.status_code == 409, refused_v1.text
    assert (
        'This version uses the previous calculation. Start from the current table.'
        in refused_v1.json()['detail']
    )

    # There is no seed to restore.
    refused_seed = client.post(
        '/api/companies/adr/prices/versions/seed/restore',
        json={'change_reason': 'Try restore seed'},
    )
    assert refused_seed.status_code == 404, refused_seed.text

    # Restoring the earlier v2 version when head is v2 succeeds
    restored_v2 = client.post(
        f'/api/companies/adr/prices/versions/{v2_first["version_id"]}/restore',
        json={'change_reason': 'Restore earlier v2 table'},
    )
    assert restored_v2.status_code == 200, restored_v2.text
    assert restored_v2.json()['diff']


def _v2_csv(base, generation):
    from backend import price_table

    items = price_table.normalize_table(_v2_table(), publish=True)['items']
    return export_csv('adr', base, generation, items)


def _upload(client, raw):
    return client.post(
        '/api/companies/adr/prices/import-preview',
        files={'file': ('prices.csv', raw, 'text/csv')},
        data={'change_reason': 'Upload owner table'},
    )


def _table_body(table, reason='Move to the owner table'):
    return {'items': table['items'], 'policy': table['policy'], 'change_reason': reason}


def test_every_publish_path_writes_the_calculation_version_on_the_head(api, enabled):
    from backend import price_table
    from backend.price_book_migration import apply_plan, build_plan

    client, current, store = api
    apply_plan(store, build_plan(store.db, ['adr']), True)
    head = store.db.records['_company_price_books/adr']
    assert head['calculation_version'] == price_books.CALCULATION_VERSION
    current['uid'] = 'owner'
    publish(client, rates(emergency_call='150.00'))
    head = store.db.records['_company_price_books/adr']
    assert head['calculation_version'] == price_books.CALCULATION_VERSION
    assert head['schema_version'] == 1

    del store.db.records['_company_price_books/adr']
    for key in [k for k in store.db.records if k.startswith('_price_book_versions/')]:
        del store.db.records[key]
    _publish_v2(client, _v2_table('25.00'))
    head = store.db.records['_company_price_books/adr']
    assert head['calculation_version'] == price_table.CALCULATION_VERSION
    assert head['schema_version'] == 2


def test_head_saved_before_the_field_existed_still_prices_as_v1(api, enabled):
    from backend.price_book_migration import apply_plan, build_plan

    client, current, store = api
    apply_plan(store, build_plan(store.db, ['adr']), True)
    del store.db.records['_company_price_books/adr']['calculation_version']

    book = store.workspaces.prices.effective(store.workspaces.read('_companies', 'adr'))
    assert book['calculation_version'] == price_books.CALCULATION_VERSION

    current['uid'] = 'owner'
    refused = client.post('/api/companies/adr/prices/preview', json=_table_body(_v2_table()))
    assert refused.status_code == 409
    migrated = store.db.records['_company_price_books/adr']['latest_version_id']
    restored = client.post(
        f'/api/companies/adr/prices/versions/{migrated}/restore',
        json={'change_reason': 'Back to the starting book'},
    )
    assert restored.status_code == 200, restored.text


def test_company_on_a_published_v1_book_cannot_move_to_v2(api, enabled):
    client, current, store = api
    current['uid'] = 'owner'
    published = publish(client, rates(emergency_call='150.00'))
    before = deepcopy(store.db.records['_company_price_books/adr'])

    refused = client.post('/api/companies/adr/prices/preview', json=_table_body(_v2_table()))
    assert refused.status_code == 409
    assert 'previous calculation' in refused.json()['detail']

    uploaded = _upload(client, _v2_csv(base=published['version_id'], generation=1))
    assert uploaded.status_code == 409, uploaded.text
    assert 'previous calculation' in uploaded.json()['detail']
    assert store.db.records['_company_price_books/adr'] == before


def test_publish_refuses_a_v2_preview_once_the_head_is_v1(api, enabled):
    from backend.workspaces import Conflict

    client, current, store = api
    current['uid'] = 'owner'
    prices = store.workspaces.prices
    preview = prices.preview('owner', 'adr', {**_table_body(_v2_table()), 'source': 'manual'})
    published = publish(client, rates(emergency_call='150.00'))
    head = store.db.records['_company_price_books/adr']
    store.db.records['_price_book_previews/' + preview['preview_id']]['base_generation'] = head[
        'generation'
    ]
    with pytest.raises(Conflict, match='previous calculation'):
        prices.publish('owner', 'adr', preview['preview_id'], head['generation'])
    assert head['latest_version_id'] == published['version_id']


def _other_owner_export(client, fmt='csv'):
    exported = client.get(
        '/api/companies/other/prices/export', params={'format': fmt, 'version_id': 'starter'}
    )
    assert exported.status_code == 200, exported.text
    return exported


def _template_rows(raw):
    return list(csv.DictReader(io.StringIO(raw.decode('utf-8-sig'))))


def _priced_template(rows):
    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=list(rows[0]), lineterminator='\n')
    writer.writeheader()
    for row in rows:
        priced = {**row, 'unit_price': '40.00'} if row['enabled'] == 'yes' else row
        if row['group'] == 'extras':
            priced = {**priced, 'enabled': 'no'}
        writer.writerow(priced)
    return out.getvalue().encode('utf-8')


def test_no_book_company_is_served_the_starter_and_can_round_trip_its_template(api, enabled):
    from backend import price_table

    client, current, store = api
    current['uid'] = 'other-owner'
    view = client.get('/api/companies/other/prices').json()
    assert view['starter'] is True
    assert view['calculation_version'] is None
    assert (view['version_id'], view['generation'], view['sequence']) == ('unset', 0, 0)
    assert {row['unit_price'] for row in view['rates']} == {''}
    assert view['working_copy'] is None and view['can_manage'] is True
    starter = price_table.starter_table()
    assert len(view['items']) == len(starter['items'])
    assert all(item['unit_price'] == '' for item in view['items'])
    assert view['policy'] == price_table.normalize_policy(starter['policy'])

    exported = _other_owner_export(client)
    assert b'133.95' not in exported.content
    rows = _template_rows(exported.content)
    assert len(rows) == len(starter['items'])
    assert {row['template_version'] for row in rows} == {price_table.TEMPLATE_VERSION}
    assert {row['base_version_id'] for row in rows} == {'starter'}
    assert {row['base_generation'] for row in rows} == {'0'}
    assert {row['unit_price'] for row in rows} == {''}
    # Nothing was written by reading.
    assert '_company_price_books/other' not in store.db.records

    sheet = _other_owner_export(client, 'xlsx')
    assert parse_upload(
        sheet.content, sheet.headers['content-type'], 'other', 'starter', 0, 'dryscope-v2'
    )

    uploaded = client.post(
        '/api/companies/other/prices/import-preview',
        files={'file': ('prices.csv', _priced_template(rows), 'text/csv')},
        data={'change_reason': 'First owner table'},
    )
    assert uploaded.status_code == 200, uploaded.text
    assert uploaded.json()['base_version_id'] is None
    saved = client.post(
        '/api/companies/other/prices/publish',
        json={'preview_id': uploaded.json()['preview_id'], 'expected_generation': 0},
    )
    assert saved.status_code == 200, saved.text
    version = store.db.records['_price_book_versions/' + saved.json()['version_id']]
    assert version['calculation_version'] == price_table.CALCULATION_VERSION
    assert version['source'] == 'import'

    after = client.get('/api/companies/other/prices').json()
    assert after['starter'] is False and after['version_id'] == saved.json()['version_id']


def test_no_book_company_template_and_view_for_readers_and_v1_file(api, enabled):
    client, current, store = api
    current['uid'] = 'other-owner'
    v1_file = export_csv('other', 'seed', 0, adr_rates())
    refused = client.post(
        '/api/companies/other/prices/import-preview',
        files={'file': ('prices.csv', v1_file, 'text/csv')},
        data={'change_reason': 'Old template'},
    )
    assert refused.status_code == 400
    assert 'Download a new template' in refused.json()['detail']

    # Asking for the seed version as a template still gives no workbook rates.
    named = client.get('/api/companies/other/prices/export', params={'version_id': 'seed'})
    assert b'133.95' not in named.content and b'dryscope-prices-v1' in named.content

    records = store.db.records
    estimator = 'other-estimator'
    records['_memberships/' + estimator] = {
        **records['_memberships/other-owner'],
        'uid': estimator,
        'role': 'estimator',
    }
    current['uid'] = estimator
    view = client.get('/api/companies/other/prices').json()
    assert view['starter'] is True and view['can_manage'] is False
    assert view['working_copy'] is None
    assert 'testing_coordination' not in {item['item_id'] for item in view['items']}
    assert all('enabled' not in item for item in view['items'])


def test_workbook_company_and_published_books_keep_the_v1_view_and_template(api, enabled):
    client, current, _ = api
    current['uid'] = 'owner'
    view = client.get('/api/companies/adr/prices').json()
    assert 'starter' not in view and 'working_copy' not in view and view['rates']
    assert view['version_id'] == 'seed'
    assert b'dryscope-prices-v1' in client.get('/api/companies/adr/prices/export').content
    starter = {'version_id': 'starter'}
    assert client.get('/api/companies/adr/prices/export', params=starter).status_code == 404

    current['uid'] = 'other-owner'
    published = client.post(
        '/api/companies/other/prices/preview',
        json={
            'rates': {**adr_rates(), 'additional_work_hourly': '', 'emergency_call': '150.00'},
            'change_reason': 'A published v1 book',
        },
    )
    assert published.status_code == 200, published.text
    saved = client.post(
        '/api/companies/other/prices/publish',
        json={'preview_id': published.json()['preview_id'], 'expected_generation': 0},
    )
    assert saved.status_code == 200, saved.text
    view = client.get('/api/companies/other/prices').json()
    assert 'starter' not in view and view['rates']
    assert b'dryscope-prices-v1' in client.get('/api/companies/other/prices/export').content
    assert client.get('/api/companies/other/prices/export', params=starter).status_code == 404


def test_company_with_no_published_book_may_publish_v2_by_form(api, enabled):
    from backend import price_table

    client, current, store = api
    current['uid'] = 'owner'
    _publish_v2(client, _v2_table('25.00'))
    head = store.db.records['_company_price_books/adr']
    assert head['calculation_version'] == price_table.CALCULATION_VERSION

    v1_refused = client.post(
        '/api/companies/adr/prices/preview',
        json={'rates': rates(), 'change_reason': 'Back to v1 rates'},
    )
    assert v1_refused.status_code == 409
    assert 'owner price table' in v1_refused.json()['detail']


def _working_copy_body(table):
    return {'expected_working_version': 0, 'items': table['items'], 'policy': table['policy']}


@pytest.mark.parametrize('company,uid', [('other', 'other-owner'), ('adr', 'owner')])
def test_owner_reads_back_a_working_copy_before_any_v2_publish(api, enabled, company, uid):
    client, current, _ = api
    current['uid'] = uid
    path = f'/api/companies/{company}/prices'
    saved = client.put(path + '/working-copy', json=_working_copy_body(_v2_table('')))
    assert saved.status_code == 200, saved.text

    view = client.get(path).json()
    assert view['working_copy']['working_version'] == 1
    stale = client.put(path + '/working-copy', json=_working_copy_body(_v2_table('')))
    assert stale.status_code == 409


def test_working_copy_stays_owner_only_on_a_v1_view(api, enabled):
    client, current, _ = api
    current['uid'] = 'owner'
    client.put('/api/companies/adr/prices/working-copy', json=_working_copy_body(_v2_table('')))
    current['uid'] = 'estimator'
    assert 'working_copy' not in client.get('/api/companies/adr/prices').json()


def test_version_detail_diff_hides_disabled_items_from_readers(api, enabled):
    client, current, _ = api
    current['uid'] = 'owner'
    table = _v2_table('25.00')
    hidden = next(item for item in table['items'] if not item['enabled'])
    hidden['unit_price'] = '77.00'
    first = _publish_v2(client, table)

    second_table = deepcopy(table)
    second_table['items'][0]['enabled'] = False
    just_disabled = second_table['items'][0]['item_id']
    removed = second_table['items'].pop(1)['item_id']
    second = _publish_v2(client, second_table, 'Second table')

    def detail(version):
        res = client.get(f'/api/companies/adr/prices/versions/{version["version_id"]}')
        assert res.status_code == 200, res.text
        return res.json()

    owner_first = detail(first)
    assert hidden['item_id'] in {row['item_id'] for row in owner_first['diff']['items']}
    owner_second = detail(second)
    assert {just_disabled, removed} <= {row['item_id'] for row in owner_second['diff']['items']}

    current['uid'] = 'estimator'
    first_rows = detail(first)['diff']['items']
    assert hidden['item_id'] not in {row['item_id'] for row in first_rows}
    assert first_rows and '77.00' not in {row['after'] for row in first_rows}
    reader_second = detail(second)
    assert reader_second['diff']['items'] == []
    assert 'disabled_items' not in reader_second['warnings']


def _approved_extra(store):
    from backend.contracts import ExtraApprove

    extra = {'id': 'e' * 32, 'description': 'More drywall', 'hours': '2.00', 'origin': 'manual'}
    record = store.db.records['inspections/' + ID]
    record['data']['extras'] = [extra]
    company = store.db.records['_companies/adr']
    return extra['id'], ExtraApprove(
        expected_revision=record['revision'],
        expected_company_version=company['version'],
        owner_name='Owner',
    )


@pytest.mark.parametrize('with_extras', [True, False])
def test_additional_work_refuses_a_v2_book_with_the_flag_off(
    api, enabled, with_extras, monkeypatch
):
    from backend.workspaces import Conflict

    if with_extras:
        monkeypatch.setattr(ai_features, 'AI_FEATURES', {'priced_extras'})
    client, current, store = api
    current['uid'] = 'estimator'
    client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    current['uid'] = 'owner'
    _publish_v2(client, _v2_table('25.00', extras=with_extras))
    profile = store.db.records['_companies/adr']['profile']
    if with_extras:
        assert profile['additional_work_rate'] == '25.00'
    else:
        assert 'additional_work_rate' not in profile

    extra_id, request = _approved_extra(store)
    price_books.set_enabled(False)
    with pytest.raises(Conflict, match='v2 pricing is not available yet'):
        store.quote_extra('owner', ID, 2)
    with pytest.raises(Conflict, match='v2 pricing is not available yet'):
        store.approve_extra('owner', ID, extra_id, request)
    assert store.db.records['inspections/' + ID]['data']['extras'][0].get('approval') is None


def test_additional_work_keeps_the_profile_rate_with_the_flag_off(api):
    client, current, store = api
    current['uid'] = 'estimator'
    client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    assert store.quote_extra('owner', ID, 2)['rate'] == '47.46'


def test_calculate_returns_publish_problems_until_v2_pricing_exists(api, enabled, caplog):
    client, current, _ = api
    current['uid'] = 'owner'
    table = _v2_table('25.00')
    table['items'][0]['unit_price'] = ''
    with caplog.at_level(logging.ERROR):
        answer = client.post(
            '/api/companies/adr/prices/calculate',
            json={'items': table['items'], 'policy': table['policy']},
        )
    assert answer.status_code == 200, answer.text
    assert answer.json()['samples'] == []
    assert any('enter a unit price' in row['message'] for row in answer.json()['problems'])
    assert 'Storage operation failed' not in caplog.text


def test_calculate_refuses_a_sample_choice_it_cannot_honor(api, enabled):
    client, current, _ = api
    current['uid'] = 'owner'
    table = _v2_table('25.00')
    answer = client.post(
        '/api/companies/adr/prices/calculate',
        json={'items': table['items'], 'policy': table['policy'], 'sample': 'small'},
    )
    assert answer.status_code == 422


def _save_working_policy(client, company_id, generation):
    table = _v2_table('25.00')
    table['policy']['overhead_profit_percent'] = '30'
    saved = client.put(
        f'/api/companies/{company_id}/prices/working-copy',
        json={
            'expected_working_version': 0,
            'expected_generation': generation,
            'items': table['items'],
            'policy': table['policy'],
        },
    )
    assert saved.status_code == 200, saved.text


def test_import_preview_takes_the_published_policy_not_the_working_copy(api, enabled):
    client, current, store = api
    current['uid'] = 'owner'
    table = _v2_table('30.00')
    table['policy']['overhead_profit_percent'] = '10'
    head = _publish_v2(client, table)
    _save_working_policy(client, 'adr', head['generation'])

    uploaded = _upload(client, _v2_csv(base=head['version_id'], generation=head['generation']))
    assert uploaded.status_code == 200, uploaded.text
    preview = store.db.records['_price_book_previews/' + uploaded.json()['preview_id']]
    assert preview['policy']['overhead_profit_percent'] == '10'


def test_first_import_preview_takes_the_starter_policy_not_the_working_copy(api, enabled):
    from backend import price_table

    client, current, store = api
    current['uid'] = 'other-owner'
    rows = _template_rows(_other_owner_export(client).content)
    _save_working_policy(client, 'other', 0)

    uploaded = client.post(
        '/api/companies/other/prices/import-preview',
        files={'file': ('prices.csv', _priced_template(rows), 'text/csv')},
        data={'change_reason': 'First owner table'},
    )
    assert uploaded.status_code == 200, uploaded.text
    preview = store.db.records['_price_book_previews/' + uploaded.json()['preview_id']]
    assert preview['policy'] == price_table.starter_table()['policy']


@pytest.mark.parametrize(
    'price,copied',
    [('0.00', False), ('0.01', True), ('10000.00', True), ('10000.01', False)],
)
def test_v2_publish_copies_only_a_valid_profile_rate(api, enabled, extras_on, price, copied):
    client, current, store = api
    current['uid'] = 'owner'
    table = _v2_table('25.00', extras=True)
    extras = next(item for item in table['items'] if item['group'] == 'extras')
    extras['unit_price'] = price
    extras['allow_zero'] = price == '0.00'
    _publish_v2(client, table, acknowledgements=[extras['item_id']] if price == '0.00' else [])

    profile = store.db.records['_companies/adr']['profile']
    if copied:
        assert profile['additional_work_rate'] == price
    else:
        assert 'additional_work_rate' not in profile


def test_v1_publish_deletes_the_working_copy(api, enabled):
    client, current, store = api
    current['uid'] = 'owner'
    table = _v2_table('25.00')
    saved = client.put(
        '/api/companies/adr/prices/working-copy',
        json={'expected_working_version': 0, 'items': table['items'], 'policy': table['policy']},
    )
    assert saved.status_code == 200, saved.text
    assert '_price_book_drafts/adr' in store.db.records

    publish(client, rates(emergency_call='150.00'))

    assert '_price_book_drafts/adr' not in store.db.records
    assert client.get('/api/companies/adr/prices').json().get('working_copy') is None


def test_locked_extras_are_refused_at_preview_and_the_profile_stays(api, enabled):
    client, current, store = api
    current['uid'] = 'owner'
    before = deepcopy(store.db.records['_companies/adr'])

    refused = client.post(
        '/api/companies/adr/prices/preview', json=_table_body(_v2_table('25.00', extras=True))
    )
    assert 400 <= refused.status_code < 500
    assert 'Turn this item off' in refused.json()['detail']

    assert store.db.records['_companies/adr'] == before
    assert '_company_price_books/adr' not in store.db.records


def test_locked_extras_are_refused_on_upload(api, enabled):
    client, current, store = api
    current['uid'] = 'other-owner'
    rows = _template_rows(_other_owner_export(client).content)
    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=list(rows[0]), lineterminator='\n')
    writer.writeheader()
    for row in rows:
        writer.writerow({**row, 'unit_price': '40.00'} if row['enabled'] == 'yes' else row)
    before = deepcopy(store.db.records['_companies/other'])

    uploaded = client.post(
        '/api/companies/other/prices/import-preview',
        files={'file': ('prices.csv', out.getvalue().encode('utf-8'), 'text/csv')},
        data={'change_reason': 'First owner table'},
    )
    assert 400 <= uploaded.status_code < 500
    assert 'Turn this item off' in uploaded.json()['detail']
    assert store.db.records['_companies/other'] == before
    assert '_company_price_books/other' not in store.db.records


def test_extras_locked_after_preview_is_refused_inside_publish(
    api, enabled, extras_on, monkeypatch
):
    client, current, store = api
    current['uid'] = 'owner'
    preview = client.post(
        '/api/companies/adr/prices/preview', json=_table_body(_v2_table('25.00', extras=True))
    )
    assert preview.status_code == 200, preview.text
    before = deepcopy(store.db.records['_companies/adr'])

    monkeypatch.setattr(ai_features, 'AI_FEATURES', set())
    saved = client.post(
        '/api/companies/adr/prices/publish',
        json={'preview_id': preview.json()['preview_id'], 'expected_generation': 0},
    )
    assert 400 <= saved.status_code < 500
    assert 'Turn this item off' in saved.json()['detail']
    assert store.db.records['_companies/adr'] == before
    assert not store.db.records.get('_company_price_books/adr', {}).get('latest_version_id')


def test_working_copy_keeps_a_locked_extras_item_and_reports_it_like_publish(api, enabled):
    client, current, _ = api
    current['uid'] = 'owner'
    table = _v2_table('25.00', extras=True)
    saved = client.put(
        '/api/companies/adr/prices/working-copy',
        json={'expected_working_version': 0, 'items': table['items'], 'policy': table['policy']},
    )
    assert saved.status_code == 200, saved.text
    assert any('Turn this item off' in row['message'] for row in saved.json()['problems'])

    calculated = client.post(
        '/api/companies/adr/prices/calculate',
        json={'items': table['items'], 'policy': table['policy']},
    )
    assert calculated.status_code == 200, calculated.text
    assert any('Turn this item off' in row['message'] for row in calculated.json()['problems'])


def test_v2_book_gives_readable_conflicts_and_audit_adds_no_pin(api, enabled):
    client, current, store = api
    current['uid'] = 'owner'
    _publish_v2(client, _v2_table('25.00'))

    current['uid'] = 'estimator'
    job = data()
    job['scope_confirmed'] = True
    created = client.post('/api/inspections', json={'inspection_id': ID, 'data': job})
    assert created.status_code == 200, created.text
    pinned = store.db.records.get(f'_job_pricing/{ID}')
    audited = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
    assert audited.status_code == 409, audited.text
    assert 'v2 pricing is not available yet' in audited.json()['detail']
    # The audit writes no pin of its own; any pin is the one made when the draft was created.
    assert store.db.records.get(f'_job_pricing/{ID}') == pinned

    prices = store.workspaces.prices
    record = store.get_inspection('estimator', ID)
    pin = prices.ensure_pin('estimator', ID)
    # An existing v2 pin is refused the same way when the caller prices the job.
    repeat = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
    assert repeat.status_code == 409
    assert 'v2 pricing is not available yet' in repeat.json()['detail']

    current['uid'] = 'owner'
    assert prices.job_view('owner', record)['can_reprice'] is False
    preview = client.post(f'/api/inspections/{ID}/pricing/reprice-preview')
    assert preview.status_code == 409
    assert 'v2 pricing is not available yet' in preview.json()['detail']
    applied = client.post(
        f'/api/inspections/{ID}/pricing/reprice',
        json={
            'expected_revision': record['revision'],
            'expected_pin_hash': pin['content_sha256'],
            'destination_version_id': pin['version_id'],
            'destination_hash': pin['content_sha256'],
        },
    )
    assert applied.status_code == 409
    assert 'v2 pricing is not available yet' in applied.json()['detail']


def test_v1_pinned_draft_is_not_offered_or_moved_to_a_v2_book(api, enabled):
    from backend.workspaces import Conflict

    client, current, store = api
    current['uid'] = 'estimator'
    client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    prices = store.workspaces.prices
    pin = prices.ensure_pin('estimator', ID)
    assert pin['calculation_version'] == price_books.CALCULATION_VERSION

    current['uid'] = 'owner'
    _publish_v2(client, _v2_table('25.00'))
    book = prices.effective(store.workspaces.read('_companies', 'adr'))
    record = store.get_inspection('owner', ID)
    view = prices.job_view('owner', record)
    assert view['newer_available'] is True and view['can_reprice'] is False
    with pytest.raises(Conflict, match='v2 pricing is not available yet'):
        prices.reprice_preview('owner', record)
    with pytest.raises(Conflict, match='v2 pricing is not available yet'):
        prices.reprice(
            'owner',
            ID,
            {
                'expected_revision': record['revision'],
                'expected_pin_hash': pin['content_sha256'],
                'destination_version_id': book['version_id'],
                'destination_hash': book['content_sha256'],
            },
        )
    assert store.db.records[f'_job_pricing/{ID}']['version_id'] == pin['version_id']


def test_additional_work_on_a_v2_book_answers_a_readable_conflict(api, enabled):
    from backend.workspaces import Conflict

    client, current, store = api
    current['uid'] = 'owner'
    _publish_v2(client, _v2_table('25.00'))
    company = store.db.records['_companies/adr']
    with pytest.raises(Conflict, match='v2 pricing is not available yet'):
        store.workspaces.prices.approval_source(company)


@pytest.mark.parametrize('audited', [False, True])
def test_legacy_draft_keeps_the_seed_when_the_company_publishes_v2(api, enabled, audited):
    client, current, store = api
    current['uid'] = 'estimator'
    client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    record = store.db.records['inspections/' + ID]
    if audited:
        record['audit'] = {'documents': {}}
    else:
        record['created_at'] = '2020-01-01T00:00:00+00:00'
    current['uid'] = 'owner'
    _publish_v2(client, _v2_table('25.00'))

    pin = store.workspaces.prices.ensure_pin('estimator', ID)
    assert pin['version_id'] == 'seed'
    assert pin['calculation_version'] == price_books.CALCULATION_VERSION
    assert pin['reason'] == 'legacy_rollout'


def test_estimator_export_hides_disabled_items_and_owner_only_columns(api, enabled, extras_on):
    from backend import price_table

    client, current, _ = api
    current['uid'] = 'owner'
    table = _v2_table('25.00', extras=True)
    disabled = next(item for item in table['items'] if not item['enabled'])
    disabled['unit_price'] = '77.00'
    zero = table['items'][0]
    zero['allow_zero'] = True
    published = _publish_v2(client, table)

    def exported(version=None):
        path = '/api/companies/adr/prices/export'
        res = client.get(path, params={'version_id': version} if version else None)
        assert res.status_code == 200, res.text
        return list(csv.DictReader(io.StringIO(res.content.decode('utf-8-sig'))))

    owner_rows = exported()
    assert disabled['item_id'] in {row['item_id'] for row in owner_rows}
    assert {r['allow_zero'] for r in owner_rows if r['item_id'] == zero['item_id']} == {'yes'}

    current['uid'] = 'estimator'
    for rows in (exported(), exported(published['version_id'])):
        assert len(rows) == len(price_table.starter_table()['items']) - 1
        assert disabled['item_id'] not in {row['item_id'] for row in rows}
        assert {row['allow_zero'] for row in rows} == {'no'}


def test_effective_takes_only_a_company_record(store):
    prices = store.workspaces.prices

    assert prices.effective(store.workspaces.read('_companies', 'adr'))['company_id'] == 'adr'
    with pytest.raises(TypeError):
        prices.effective('adr')
    with pytest.raises(TypeError):
        prices.effective('no-such-company')


# --- Owner price-table editor (PR 4): routes the editor screen depends on ---


def _wc_body(table, **extra):
    return {
        'items': table['items'],
        'policy': table['policy'],
        'expected_working_version': 0,
        'expected_generation': 0,
        **extra,
    }


def test_working_copy_routes_are_owner_only(api, enabled):
    client, current, _ = api
    table = _v2_table('30.00')
    current['uid'] = 'owner'
    head = _publish_v2(client, _v2_table('20.00'), 'Head for the working copy')
    saved = client.put(
        '/api/companies/adr/prices/working-copy',
        json=_wc_body(table, expected_generation=head['generation']),
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()['working_version'] == 1
    assert saved.json()['working_copy']['items'][0]['unit_price'] == '30.00'
    # The owner reads the copy back with the page, disabled items included.
    page = client.get('/api/companies/adr/prices').json()
    assert page['working_copy']['working_version'] == 1
    assert any(not item['enabled'] for item in page['working_copy']['items'])

    for uid in ('estimator', 'office', 'admin', 'other-owner'):
        current['uid'] = uid
        put = client.put(
            '/api/companies/adr/prices/working-copy',
            json=_wc_body(table, expected_generation=1, expected_working_version=1),
        )
        assert put.status_code in (403, 404), (uid, put.text)
        assert client.post('/api/companies/adr/prices/working-copy/discard').status_code in (
            403,
            404,
        ), uid
    # Members who may read prices never receive the working copy.
    current['uid'] = 'estimator'
    read = client.get('/api/companies/adr/prices')
    assert read.status_code == 200
    assert read.json().get('working_copy') is None
    assert read.json()['can_manage'] is False

    price_books.set_enabled(False)
    current['uid'] = 'owner'
    assert (
        client.put(
            '/api/companies/adr/prices/working-copy',
            json=_wc_body(table, expected_generation=1, expected_working_version=1),
        ).status_code
        == 404
    )


def test_preview_diff_lists_items_policy_and_warnings(api, enabled):
    client, current, _ = api
    current['uid'] = 'owner'
    head = _v2_table('20.00')
    _publish_v2(client, head, 'First table')
    changed = deepcopy(head)
    changed['items'][0]['unit_price'] = '40.00'  # +100 percent
    changed['items'][1]['enabled'] = False
    changed['items'][2]['unit_price'] = '0.00'
    changed['items'][2]['allow_zero'] = True
    changed['items'][3]['taxable'] = True
    changed['items'] = changed['items'][:-1] + [
        {**deepcopy(changed['items'][-1]), 'item_id': 'extra_new', 'code': 'EXTRA-NEW'}
    ]
    changed['policy']['estimate_mode'] = 'single'
    changed['policy']['sales_tax'] = {'enabled': True, 'percent': '8'}
    changed['policy']['after_hours']['label'] = 'Night work'
    preview = client.post(
        '/api/companies/adr/prices/preview',
        json={
            'items': changed['items'],
            'policy': changed['policy'],
            'acknowledgements': [changed['items'][2]['item_id']],
            'change_reason': 'Quarterly review',
        },
    )
    assert preview.status_code == 200, preview.text
    body = preview.json()
    kinds = {(row['item_id'], row['change']) for row in body['diff']['items']}
    assert (changed['items'][0]['item_id'], 'price') in kinds
    assert (changed['items'][1]['item_id'], 'enabled') in kinds
    assert ('extra_new', 'added') in kinds
    assert (head['items'][-1]['item_id'], 'removed') in kinds
    fields = {row['field'] for row in body['diff']['policy']}
    assert {
        'estimate_mode',
        'sales_tax.enabled',
        'sales_tax.percent',
        'after_hours.label',
    } <= fields
    assert {'large_change', 'zero_price', 'disabled_items', 'mode_change', 'tax_change'} <= set(
        body['warnings']
    )


def test_import_replaces_items_and_keeps_policy(api, enabled):
    from backend import price_book_import, price_table

    client, current, db = api
    current['uid'] = 'owner'
    table = _v2_table('25.00')
    table['policy']['overhead_profit_percent'] = '10'
    table['policy']['after_hours']['label'] = 'Night work'
    _publish_v2(client, table, 'Head with a policy')
    company, base_version, generation, exported = db.workspaces.prices.export_rows('owner', 'adr')
    changed = deepcopy(exported)
    changed[0]['unit_price'] = '31.00'
    raw = price_book_import.export_csv(company, base_version, generation, changed)
    boundary = 'xBOUNDARYx'
    body = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="p.csv"\r\n'
        f'Content-Type: text/csv\r\n\r\n'.encode()
        + raw
        + f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="change_reason"\r\n\r\n'
        f'Imported prices\r\n--{boundary}--\r\n'.encode()
    )
    preview = client.post(
        '/api/companies/adr/prices/import-preview',
        content=body,
        headers={'Content-Type': f'multipart/form-data; boundary={boundary}'},
    )
    assert preview.status_code == 200, preview.text
    result = preview.json()
    assert [row['change'] for row in result['diff']['items']] == ['price']
    assert result['diff']['policy'] == []
    client.post(
        '/api/companies/adr/prices/publish',
        json={'preview_id': result['preview_id'], 'expected_generation': result['generation']},
    )
    view = client.get('/api/companies/adr/prices').json()
    assert view['policy']['overhead_profit_percent'] == '10'
    assert view['policy']['after_hours']['label'] == 'Night work'
    assert price_table.starter_table()['items'][0]['item_id'] == view['items'][0]['item_id']


def test_calculate_is_stateless_and_quota_limited(api, enabled):
    client, current, db = api
    table = _v2_table('30.00')
    table['items'][0]['unit_price'] = ''
    current['uid'] = 'owner'
    before = {key for key in db.db.records}
    result = client.post(
        '/api/companies/adr/prices/calculate',
        json={'items': table['items'], 'policy': table['policy']},
    )
    assert result.status_code == 200, result.text
    assert any(row['item_id'] == table['items'][0]['item_id'] for row in result.json()['problems'])
    created = {key for key in db.db.records} - before
    assert not any(
        key.startswith(('_price_book_drafts', '_price_book_previews')) for key in created
    )
    for uid in ('estimator', 'office'):
        current['uid'] = uid
        assert (
            client.post(
                '/api/companies/adr/prices/calculate',
                json={'items': table['items'], 'policy': table['policy']},
            ).status_code
            == 403
        ), uid
    current['uid'] = 'owner'
    statuses = [
        client.post(
            '/api/companies/adr/prices/calculate',
            json={'items': table['items'], 'policy': table['policy']},
        ).status_code
        for _ in range(300)
    ]
    # The first call above used one of the 300.
    assert statuses[0] == 200 and statuses[298] == 200 and statuses[299] == 429


def test_heavy_sample_editing_cannot_block_preview_or_publish(api, enabled):
    client, current, _ = api
    current['uid'] = 'owner'
    table = _v2_table('30.00')
    for _ in range(100):
        assert (
            client.post(
                '/api/companies/adr/prices/calculate',
                json={'items': table['items'], 'policy': table['policy']},
            ).status_code
            == 200
        )
    published = _publish_v2(client, table, 'Published after a long edit')
    assert published['generation'] == 1


def _import_body(raw, boundary, **fields):
    parts = [
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="p.csv"\r\n'
        f'Content-Type: text/csv\r\n\r\n'.encode()
        + raw
        + b'\r\n'
    ]
    parts += [
        f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
        for name, value in fields.items()
    ]
    return b''.join(parts) + f'--{boundary}--\r\n'.encode()


def test_import_with_a_zero_price_needs_the_confirmation(api, enabled):
    from backend import price_book_import

    client, current, db = api
    current['uid'] = 'owner'
    _publish_v2(client, _v2_table('25.00'), 'Head before a zero price')
    company, base_version, generation, exported = db.workspaces.prices.export_rows('owner', 'adr')
    changed = deepcopy(exported)
    changed[0]['unit_price'] = '0.00'
    changed[0]['allow_zero'] = True
    changed[0]['enabled'] = True
    raw = price_book_import.export_csv(company, base_version, generation, changed)
    headers = {'Content-Type': 'multipart/form-data; boundary=xBOUNDARYx'}

    refused = client.post(
        '/api/companies/adr/prices/import-preview',
        content=_import_body(raw, 'xBOUNDARYx', change_reason='Free first row'),
        headers=headers,
    )
    assert refused.status_code == 400 or refused.status_code == 422, refused.text
    assert 'confirm that a zero unit price' in refused.text

    confirmed = client.post(
        '/api/companies/adr/prices/import-preview',
        content=_import_body(
            raw, 'xBOUNDARYx', change_reason='Free first row', confirm_zero_prices='yes'
        ),
        headers=headers,
    )
    assert confirmed.status_code == 200, confirmed.text
    assert 'zero_price' in confirmed.json()['warnings']
