"""ADR's proprietary rates reach ADR only. Every other company starts with no prices."""

import ast
import csv
import hashlib
import io
import json
import re
import zipfile
from pathlib import Path

import pytest
from backend import claims, price_books
from backend.adr_price_book import adr_rates
from backend.contracts import InspectionData
from backend.price_book_import import export_csv
from tests.test_workspaces import ID, api, data, store  # noqa: F401

ROOT = Path(__file__).resolve().parents[1]
# Rates that are not also a round number or a default elsewhere in a response.
ADR_ONLY = sorted(
    {value for value in adr_rates().values() if value not in ('200.00', '250.00', '180.00')}
    | {'1,180.20', '1180.20', '628.85', '567.00', '83.45'}
)
OWN = {key: '11.11' for key in adr_rates()} | {'additional_work_hourly': ''}


def assert_no_adr_rate(text):
    found = [
        value for value in ADR_ONLY if re.search(r'(?<![\d.])' + re.escape(value) + r'(?!\d)', text)
    ]
    assert not found, found


@pytest.fixture
def enabled():
    price_books.set_enabled(True)
    yield
    price_books.set_enabled(None)


def other_job(client, current, uid='other-owner'):
    current['uid'] = uid
    made = client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    assert made.status_code == 200, made.text
    assert_no_adr_rate(made.text)


def publish_own(client, current):
    current['uid'] = 'other-owner'
    preview = client.post(
        '/api/companies/other/prices/preview',
        json={'rates': OWN, 'change_reason': 'Our first prices'},
    )
    assert preview.status_code == 200, preview.text
    assert_no_adr_rate(preview.text)
    body = preview.json()
    saved = client.post(
        '/api/companies/other/prices/publish',
        json={'preview_id': body['preview_id'], 'expected_generation': body['generation']},
    )
    assert saved.status_code == 200, saved.text
    return body


def test_a_company_without_prices_sees_blanks_through_every_price_read(api, enabled):
    client, current, _ = api
    current['uid'] = 'other-owner'
    session = client.get('/api/session')
    assert session.json()['prices_set'] is False and session.json()['price_display'] is None
    assert_no_adr_rate(session.text)
    view = client.get('/api/companies/other/prices')
    assert view.status_code == 200
    body = view.json()
    assert body['prices_set'] is False and body['label'] == 'Prices not set'
    assert body['source'] == 'unset' and body['version_id'] == 'unset'
    assert {row['unit_price'] for row in body['rates']} == {''}
    assert 'Set your company prices before your first estimate' in body['used_for']
    assert 'seed' not in view.text.lower()
    assert_no_adr_rate(view.text)
    assert client.get('/api/companies/other/prices/versions').json() == {'versions': []}
    history = client.get('/api/companies/other/prices/history')
    assert history.json()['versions'] == []
    current['uid'] = 'admin'
    support = client.get('/api/admin/companies/other/prices')
    assert_no_adr_rate(support.text)


def test_the_export_template_has_names_and_units_but_no_prices(api, enabled):
    client, current, _ = api
    current['uid'] = 'other-owner'
    exported = client.get('/api/companies/other/prices/export?format=csv')
    assert exported.status_code == 200
    rows = list(csv.DictReader(io.StringIO(exported.content.decode('utf-8-sig'))))
    assert len(rows) == 21
    assert all(row['description'] and row['unit'] for row in rows)
    assert {row['unit_price'] for row in rows} == {''}
    assert {row['base_version_id'] for row in rows} == {'unset'}
    asked = client.get('/api/companies/other/prices/export?format=csv&version_id=seed')
    assert_no_adr_rate(asked.content.decode('utf-8-sig'))
    # Additional work stays locked while priced extras are off, so its row stays blank.
    filled = '\n'.join(
        line if 'additional_work_hourly' in line or not line.endswith(',USD,') else line + '11.11'
        for line in exported.content.decode('utf-8-sig').splitlines()
    )
    imported = client.post(
        '/api/companies/other/prices/import-preview',
        files={'file': ('prices.csv', filled.encode(), 'text/csv')},
        data={'change_reason': 'Our first prices'},
    )
    assert imported.status_code == 200, imported.text
    assert imported.json()['sample_before'] is None
    assert_no_adr_rate(imported.text)
    sheet = client.get('/api/companies/other/prices/export?format=xlsx')
    with zipfile.ZipFile(io.BytesIO(sheet.content)) as archive:
        assert_no_adr_rate(archive.read('xl/worksheets/sheet1.xml').decode())


@pytest.mark.parametrize('flag', [True, False])
def test_there_is_no_seed_version_for_another_company(api, flag):
    client, current, _ = api
    price_books.set_enabled(flag)
    try:
        current['uid'] = 'other-owner'
        for response in (
            client.get('/api/companies/other/prices/versions/seed'),
            client.post(
                '/api/companies/other/prices/versions/seed/restore',
                json={'change_reason': 'Give me the seed'},
            ),
        ):
            assert response.status_code == 404
            assert_no_adr_rate(response.text)
    finally:
        price_books.set_enabled(None)


def test_a_first_price_preview_has_no_adr_parent_or_sample(api, enabled):
    client, current, _ = api
    body = publish_own(client, current)
    assert body['sample_before'] is None
    assert {row['before'] for row in body['diff']} == {''}
    assert 'large_change' not in body['warnings']
    current['uid'] = 'other-owner'
    latest = client.get('/api/companies/other/prices').json()
    version = client.get(f'/api/companies/other/prices/versions/{latest["version_id"]}')
    assert version.status_code == 200
    assert_no_adr_rate(version.text)
    assert client.get('/api/session').json()['prices_set'] is True


@pytest.mark.parametrize('flag', [True, False])
def test_audit_is_blocked_with_the_right_message_for_each_role(api, flag):
    client, current, company_store = api
    db = company_store.db
    price_books.set_enabled(flag)
    try:
        other_job(client, current)
        blocked = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
        assert blocked.status_code == 409
        assert 'Set your company prices before your first estimate' in blocked.text
        assert ('Contact support' in blocked.text) is (not flag)
        assert not db.records.get('_job_pricing/' + ID)
        db.records['_memberships/other-estimator'] = {
            **db.records['_memberships/other-owner'],
            'uid': 'other-estimator',
            'role': 'estimator',
        }
        db.records['_workspace_jobs/' + ID]['accessible_estimator_uids'] = ['other-estimator']
        current['uid'] = 'other-estimator'
        told = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
        assert told.status_code == 409
        assert 'Ask your company owner to set company prices' in told.text
    finally:
        price_books.set_enabled(None)


def test_job_pricing_and_reprice_refuse_without_prices(api, enabled):
    client, current, company_store = api
    db = company_store.db
    other_job(client, current)
    view = client.get(f'/api/inspections/{ID}/pricing')
    assert view.status_code == 200
    assert view.json()['display_rates'] == {'after_hours_job_charge': '', 'sheet_labor_hourly': ''}
    assert 'Set your company prices' in view.json()['pending_note']
    assert view.json()['newer_available'] is False
    # A pin saved before this rule cannot be moved onto an empty book.
    db.records['_job_pricing/' + ID] = dict(
        inspection_id=ID,
        company_id='other',
        version_id='old',
        sequence=1,
        rates=OWN,
        content_sha256=price_books.content_hash(OWN),
        calculation_version=price_books.CALCULATION_VERSION,
        priced_at='2026',
    )
    assert client.post(f'/api/inspections/{ID}/pricing/reprice-preview').status_code == 409
    blank = price_books.blank_rates()
    applied = client.post(
        f'/api/inspections/{ID}/pricing/reprice',
        json={
            'expected_revision': 1,
            'expected_pin_hash': price_books.content_hash(OWN),
            'destination_version_id': 'unset',
            'destination_hash': price_books.content_hash(blank),
        },
    )
    assert applied.status_code == 409
    assert db.records['_job_pricing/' + ID]['rates'] == OWN


def test_after_publishing_a_company_prices_from_its_own_book(api, enabled):
    client, current, company_store = api
    db = company_store.db
    publish_own(client, current)
    other_job(client, current)
    audited = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
    assert audited.status_code == 200, audited.text
    assert_no_adr_rate(audited.text)
    basis = audited.json()['audit']['documents']['price_basis']
    assert basis['sequence'] == 1 and basis['rates']['emergency_call'] == '11.11'
    display = client.get('/api/session').json()['price_display']
    assert display['after_hours_job_charge'] == '11.11'
    assert db.records['_job_pricing/' + ID]['rates']['emergency_call'] == '11.11'


def test_a_legacy_draft_in_another_company_never_falls_back_to_adr_rates(api, enabled):
    client, current, company_store = api
    db = company_store.db
    publish_own(client, current)
    other_job(client, current)
    # Created before this company's prices started, which ADR's own drafts treat as legacy.
    db.records['inspections/' + ID]['created_at'] = '2000-01-01T00:00:00+00:00'
    audited = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
    assert audited.status_code == 200, audited.text
    assert db.records['_job_pricing/' + ID]['rates']['emergency_call'] == '11.11'
    assert_no_adr_rate(audited.text)


def test_a_seeded_book_outside_adr_does_not_count_as_prices(api, enabled):
    client, current, company_store = api
    db = company_store.db
    rates = {**adr_rates(), 'additional_work_hourly': ''}
    db.records['_price_book_versions/migrate-other-v1'] = dict(
        version_id='migrate-other-v1',
        company_id='other',
        sequence=0,
        calculation_version=price_books.CALCULATION_VERSION,
        rates=rates,
        content_sha256=price_books.content_hash(rates),
        source='seed',
    )
    db.records['_company_price_books/other'] = dict(
        company_id='other', generation=0, latest_version_id='migrate-other-v1', next_sequence=1
    )
    current['uid'] = 'other-owner'
    view = client.get('/api/companies/other/prices')
    assert view.json()['prices_set'] is False
    assert_no_adr_rate(view.text)
    other_job(client, current)
    assert (
        client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1}).status_code
        == 409
    )


def test_additional_work_quote_has_no_adr_rate_for_another_company(api, enabled):
    client, current, _ = api
    from backend import ai_features

    ai_features.AI_FEATURES = {*ai_features.AI_FEATURES, 'priced_extras'}
    try:
        other_job(client, current)
        quote = client.post(f'/api/inspections/{ID}/extras/quote', json={'hours': '2.5'})
        assert quote.status_code == 400
        assert_no_adr_rate(quote.text)
    finally:
        ai_features.AI_FEATURES = ai_features.AI_FEATURES - {'priced_extras'}


def test_pricing_has_no_default_book():
    scope = InspectionData(address='Sample', year_built=2000, scope_confirmed=True)
    with pytest.raises(TypeError):
        claims.price_scope(scope)
    with pytest.raises(ValueError, match='Company prices are required'):
        claims.price_scope(scope, None)
    with pytest.raises(ValueError):
        claims.make_documents(scope, [], None)


def test_the_catalog_holds_no_prices():
    assert all('seed' not in item for item in price_books.ITEMS)
    assert set(price_books.blank_rates().values()) == {''}
    assert not hasattr(price_books, 'seed_rates')
    assert_no_adr_rate((ROOT / 'backend/price_books.py').read_text())
    assert_no_adr_rate(export_csv('other', 'unset', 0, price_books.blank_rates()).decode())


def test_only_named_modules_may_read_adr_rates():
    allowed = {
        'adr_price_book.py',
        'extras.py',
        'main.py',
        'price_book_migration.py',
        'price_book_store.py',
        'price_books.py',
        'workspaces.py',
    }
    importers = set()
    for path in (ROOT / 'backend').glob('*.py'):
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.ImportFrom) and node.module == 'adr_price_book':
                importers.add(path.name)
    assert importers <= allowed


def served_files():
    for path in (ROOT / 'public').rglob('*'):
        if 'vendor' in path.parts or 'fonts' in path.parts or 'brand' in path.parts:
            continue
        if path.suffix in ('.js', '.html', '.css', '.json', '.webmanifest', '.txt', '.xml'):
            yield path
    yield ROOT / 'index.html'


@pytest.mark.parametrize('path', list(served_files()), ids=lambda path: path.name)
def test_no_adr_rate_is_shipped_to_browsers(path):
    text = path.read_text()
    assert_no_adr_rate(text)
    assert not re.search(r'\$(?:200|250|180)\b', text)
    assert 'Restore workbook seed' not in text


def adr_job(**spec):
    return InspectionData(address='Sample', year_built=2000, scope_confirmed=True, **spec)


# Hashes and amounts read from the code before ADR's rates moved out of the catalog.
ADR_JOBS = {
    'workbook': (
        dict(
            rooms=[dict(name='A', category=2, unfinished_sf=140, finished_sf=5)],
            is_after_hours=True,
            air_movers=3,
            dehumidifiers=1,
            drying_days=3,
        ),
        '7fa0c2e9be739a843cc394f22fac45926cd7be89e63c27c7c4057f395e6ae209',
        2174.45,
        '2219.90',
        '2356.25',
    ),
    'category 3 with cabinetry and every charge': (
        dict(
            rooms=[
                dict(
                    name='K',
                    category=3,
                    unfinished_sf=100,
                    finished_sf=200,
                    custom_cabinetry=True,
                    waste_percent=10,
                )
            ],
            air_movers=6,
            dehumidifiers=2,
            drying_days=4,
            wood_floor_systems=1,
            wood_floor_days=7,
            labor_hours=8,
            matterport_scans=1,
            dump_truck_loads=1,
            equipment_decon=2,
            power_distribution=1,
        ),
        '1aaea1c286633a9d6f76beea2d80a9faadf952f418f68211abf9d2508bc06e8c',
        8955.24,
        '8955.24',
        '11127.28',
    ),
    '1,001 sq ft': (
        dict(
            rooms=[dict(name='B', category=1, unfinished_sf=1001, finished_sf=0)],
            air_movers=10,
            dehumidifiers=3,
            drying_days=3,
        ),
        'a620b5d12fadfb78fc6f45266ceff85a51b9c0518402c8229cc27b214e5936d1',
        4180.16,
        '4180.16',
        '4422.40',
    ),
    '1,000 sq ft after hours': (
        dict(
            rooms=[dict(name='B', category=1, unfinished_sf=1000, finished_sf=0)],
            air_movers=10,
            dehumidifiers=3,
            drying_days=3,
            is_after_hours=True,
        ),
        'b8c92ed906574fd853d5d74531e987bb95706184a024581dca2c4bcc8da3d6f8',
        4378.95,
        '4620.95',
        '5346.95',
    ),
}


@pytest.mark.parametrize('name', ADR_JOBS)
def test_adr_sample_jobs_are_byte_identical(name):
    spec, digest, itemized, low, high = ADR_JOBS[name]
    scope = adr_job(**spec)
    items, total = claims.price_scope(scope, adr_rates())
    assert hashlib.sha256(json.dumps(items, sort_keys=True).encode()).hexdigest() == digest
    assert total == itemized
    bounds = claims.proposal_range(scope, items)
    assert (f'{bounds[0]:.2f}', f'{bounds[1]:.2f}') == (low, high)


def test_adr_book_hash_and_display_are_unchanged(api):
    assert price_books.content_hash(adr_rates()) == (
        'e4c41407ed544b53d4cb88ff75024399021a45401699b23a2733a3609063b2b5'
    )
    assert price_books.label_for(0, 'adr') == 'Workbook seed'
    client, current, _ = api
    current['uid'] = 'estimator'
    session = client.get('/api/session').json()
    assert session['prices_set'] is True
    assert session['price_display'] == {
        'after_hours_job_charge': '200.00',
        'sheet_labor_hourly': '47.46',
        'additional_work_hourly': '47.46',
        'standard_job_charges': '1,180.20',
    }


def test_adr_keeps_its_seed_version_and_restore(api, enabled):
    client, current, _ = api
    current['uid'] = 'owner'
    assert client.get('/api/companies/adr/prices').json()['label'] == 'Workbook seed'
    version = client.get('/api/companies/adr/prices/versions/seed')
    assert version.status_code == 200
    assert {row['unit_price'] for row in version.json()['rates']} >= {'133.95', '47.46'}
