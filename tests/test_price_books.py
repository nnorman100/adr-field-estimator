"""Company price books. ADR's output matches its workbook while the feature is off."""

import logging
from copy import deepcopy
from decimal import Decimal

import pytest
from backend import ai_features, price_books
from backend.claims import PRETEST, proposal_range
from tests.adr_pricing import make_documents, price_scope
from backend.contracts import AIResult, InspectionData
from backend.adr_price_book import adr_rates
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


def _v2_table(unit_price='25.00'):
    from backend import price_table

    table = price_table.starter_table()
    for item in table['items']:
        if item['enabled']:
            item['unit_price'] = unit_price
    return table


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
    eff = prices.effective('adr')
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
        'content_sha256': price_books.content_hash(seed_rates()),
        'calculation_version': price_table.CALCULATION_VERSION,
        'rates': seed_rates(),
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
    eff = prices.effective('adr')
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
    seed = seed_rates()
    db.db.records['_price_book_versions/' + v1_id] = {
        'version_id': v1_id,
        'company_id': 'adr',
        'sequence': 0,
        'calculation_version': price_books.CALCULATION_VERSION,
        'rates': seed,
        'content_sha256': price_books.content_hash(seed),
    }

    # Restoring the v1 version (or 'seed') when head is v2 is refused with 409
    refused_v1 = client.post(
        f'/api/companies/adr/prices/versions/{v1_id}/restore',
        json={'change_reason': 'Try restore v1'},
    )
    assert refused_v1.status_code == 409, refused_v1.text
    assert (
        'This version uses the previous calculation. Start from the current table.'
        in refused_v1.json()['detail']
    )

    refused_seed = client.post(
        '/api/companies/adr/prices/versions/seed/restore',
        json={'change_reason': 'Try restore seed'},
    )
    assert refused_seed.status_code == 409, refused_seed.text
    assert (
        'This version uses the previous calculation. Start from the current table.'
        in refused_seed.json()['detail']
    )

    # Restoring the earlier v2 version when head is v2 succeeds
    restored_v2 = client.post(
        f'/api/companies/adr/prices/versions/{v2_first["version_id"]}/restore',
        json={'change_reason': 'Restore earlier v2 table'},
    )
    assert restored_v2.status_code == 200, restored_v2.text
    assert restored_v2.json()['diff']


def _v2_csv(company='adr', base='seed', generation=0, unit_price='25.00'):
    from backend import price_table
    from backend.price_book_import import export_csv

    items = price_table.normalize_table(_v2_table(unit_price), publish=True)['items']
    return export_csv(company, base, generation, items)


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

    book = store.workspaces.prices.effective('adr')
    assert book['calculation_version'] == price_books.CALCULATION_VERSION

    current['uid'] = 'owner'
    refused = client.post('/api/companies/adr/prices/preview', json=_table_body(_v2_table()))
    assert refused.status_code == 409
    restored = client.post(
        '/api/companies/adr/prices/versions/seed/restore', json={'change_reason': 'Back to seed'}
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


def test_company_with_no_published_book_may_publish_v2_by_form_or_file(api, enabled):
    from backend import price_table

    client, current, store = api
    current['uid'] = 'owner'
    uploaded = _upload(client, _v2_csv())
    assert uploaded.status_code == 200, uploaded.text
    saved = client.post(
        '/api/companies/adr/prices/publish',
        json={'preview_id': uploaded.json()['preview_id'], 'expected_generation': 0},
    )
    assert saved.status_code == 200, saved.text
    head = store.db.records['_company_price_books/adr']
    assert head['calculation_version'] == price_table.CALCULATION_VERSION

    v1_refused = client.post(
        '/api/companies/adr/prices/preview',
        json={'rates': rates(), 'change_reason': 'Back to v1 rates'},
    )
    assert v1_refused.status_code == 409
    assert 'owner price table' in v1_refused.json()['detail']


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


def test_v2_book_gives_readable_conflicts_and_writes_no_pin(api, enabled):
    client, current, store = api
    current['uid'] = 'owner'
    _publish_v2(client, _v2_table('25.00'))

    current['uid'] = 'estimator'
    job = data()
    job['scope_confirmed'] = True
    created = client.post('/api/inspections', json={'inspection_id': ID, 'data': job})
    assert created.status_code == 200, created.text
    audited = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
    assert audited.status_code == 409, audited.text
    assert 'v2 pricing is not available yet' in audited.json()['detail']
    assert f'_job_pricing/{ID}' not in store.db.records

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
    book = prices.effective('adr')
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


def test_estimator_export_hides_disabled_items_and_owner_only_columns(api, enabled):
    from backend import price_table
    import csv
    import io

    client, current, _ = api
    current['uid'] = 'owner'
    table = _v2_table('25.00')
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
