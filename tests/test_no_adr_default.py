"""ADR's proprietary rates reach ADR only. Every other company starts with no prices."""

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
from backend.inspection_store import Conflict
from backend.contracts import InspectionData
from backend.price_book_import import export_csv
from backend.price_book_migration import apply_plan, build_plan
from tests.test_workspaces import ID, api, data, store  # noqa: F401

ROOT = Path(__file__).resolve().parents[1]
# Rates that are not also a round number or a default elsewhere in a response.
ADR_ONLY = sorted(
    {value for value in adr_rates().values() if value not in ('200.00', '250.00', '180.00')}
    | {'1,180.20', '1180.20', '628.85', '567.00', '83.45'}
)
OWN = {key: '11.11' for key in adr_rates()} | {'additional_work_hourly': ''}
OWNER_NOTICE = (
    'Set your company prices before your first estimate. Open Company prices from the menu.'
)


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


def session_prices(body):
    return {key: body[key] for key in ('prices_set', 'price_display', 'prices_not_set_message')}


def test_access_keeps_the_price_fields_current_like_the_session(api, enabled):
    client, current, company_store = api
    db = company_store.db
    current['uid'] = 'other-owner'
    unset = {'prices_set': False, 'price_display': None, 'prices_not_set_message': OWNER_NOTICE}
    assert session_prices(client.get('/api/session').json()) == unset
    assert session_prices(client.get('/api/access').json()) == unset

    db.records['_memberships/other-estimator'] = {
        **db.records['_memberships/other-owner'],
        'uid': 'other-estimator',
        'role': 'estimator',
    }
    current['uid'] = 'other-estimator'
    told = session_prices(client.get('/api/access').json())
    assert told['prices_not_set_message'] == (
        'Ask your company owner to set company prices before the first estimate.'
    )
    assert told == session_prices(client.get('/api/session').json())

    publish_own(client, current)
    current['uid'] = 'other-estimator'
    published = session_prices(client.get('/api/access').json())
    assert published['prices_set'] is True and published['prices_not_set_message'] is None
    assert published['price_display']['after_hours_job_charge'] == '11.11'
    assert published == session_prices(client.get('/api/session').json())


def test_access_clears_the_price_fields_when_a_member_leaves_the_company(api, enabled):
    client, current, company_store = api
    current['uid'] = 'owner'
    assert client.get('/api/access').json()['price_display'] is not None
    company_store.db.records['_memberships/owner']['status'] = 'disabled'
    cleared = {'prices_set': None, 'price_display': None, 'prices_not_set_message': None}
    access = client.get('/api/access')
    assert access.status_code == 200 and session_prices(access.json()) == cleared
    assert_no_adr_rate(access.text)
    assert session_prices(client.get('/api/session').json()) == cleared


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
    assert view.json()['pending_note'] == OWNER_NOTICE
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
    assert_no_adr_rate(export_csv('other', 'unset', 0, price_books.blank_rates()).decode())


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
    assert price_books.label_for(0, 'adr') == 'ADR starting prices'
    assert price_books.label_for(0, 'other') == 'Prices not set'
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


def test_adr_keeps_its_seed_version_for_old_pins(api, enabled):
    client, current, _ = api
    current['uid'] = 'owner'
    assert client.get('/api/companies/adr/prices').json()['label'] == 'ADR starting prices'
    version = client.get('/api/companies/adr/prices/versions/seed')
    assert version.status_code == 200
    assert {row['unit_price'] for row in version.json()['rates']} >= {'133.95', '47.46'}


def test_seed_restore_is_gone_for_adr_too(api, enabled):
    client, current, company_store = api
    current['uid'] = 'owner'
    restored = client.post(
        '/api/companies/adr/prices/versions/seed/restore',
        json={'change_reason': 'Give me the seed'},
    )
    assert restored.status_code == 404
    assert not [key for key in company_store.db.records if key.startswith('_price_book_previews/')]


def test_adr_starting_prices_restore_as_adr_own_book_and_only_for_adr(api, enabled):
    client, current, company_store = api
    db = company_store.db
    apply_plan(company_store, build_plan(db, ['adr']), True)
    stored = db.records['_price_book_versions/migrate-adr-v1']
    assert stored['change_reason'] == 'ADR starting prices'
    stored['change_reason'] = 'Workbook seed'
    saved = dict(stored)
    db.records['_price_book_versions/migrate-other-v1'] = {
        **saved,
        'version_id': 'migrate-other-v1',
        'company_id': 'other',
        'rates': OWN,
        'content_sha256': price_books.content_hash(OWN),
    }

    current['uid'] = 'owner'
    base = '/api/companies/adr/prices'
    raised = client.post(
        base + '/preview',
        json={'rates': {**adr_rates(), 'emergency_call': '200.00'}, 'change_reason': 'Raise it'},
    ).json()
    published = client.post(
        base + '/publish',
        json={'preview_id': raised['preview_id'], 'expected_generation': raised['generation']},
    )
    assert published.status_code == 200, published.text
    history = client.get(base + '/history')
    rows = {row['version_id']: row for row in history.json()['versions']}
    assert rows['migrate-adr-v1']['label'] == 'ADR starting prices'
    assert rows['migrate-adr-v1']['change_reason'] == ''
    detail = client.get(base + '/versions/migrate-adr-v1')
    assert detail.json()['label'] == 'ADR starting prices'
    assert detail.json()['change_reason'] == ''
    for shown in (history, detail, client.get(base)):
        assert 'workbook seed' not in shown.text.lower()
    restored = client.post(
        base + '/versions/migrate-adr-v1/restore', json={'change_reason': 'Back to the start'}
    )
    assert restored.status_code == 200, restored.text
    assert restored.json()['preview_id']
    changed = {row['key']: row for row in restored.json()['diff']}['emergency_call']
    assert (changed['before'], changed['after']) == ('200.00', '133.95')
    assert db.records['_price_book_versions/migrate-adr-v1'] == saved

    current['uid'] = 'other-owner'
    base = '/api/companies/other/prices'
    responses = [client.get(base + '/history'), client.get(base + '/versions')]
    current['uid'] = 'admin'
    responses.append(client.get('/api/admin/companies/other/prices/versions'))
    for listed in responses:
        assert listed.status_code == 200, listed.text
        assert listed.json()['versions'] == []
        assert 'ADR starting prices' not in listed.text
        assert 'workbook seed' not in listed.text.lower()
    current['uid'] = 'other-owner'
    for version_id in ('migrate-other-v1', 'migrate-adr-v1'):
        refused = client.post(
            f'{base}/versions/{version_id}/restore', json={'change_reason': 'Bring it back'}
        )
        assert refused.status_code == 404
    assert client.get(base).json()['label'] == 'Prices not set'


LEGACY = {**adr_rates(), 'additional_work_hourly': ''}
REFUSED = 'These saved prices cannot be used for this company'


def legacy_pin(db, rates=None):
    rates = LEGACY if rates is None else rates
    db.records['_job_pricing/' + ID] = dict(
        inspection_id=ID,
        company_id='other',
        pin_version=1,
        version_id='seed',
        sequence=0,
        rates=rates,
        content_sha256=price_books.content_hash(rates),
        calculation_version=price_books.CALCULATION_VERSION,
        priced_at='2026',
    )


def legacy_version(db, version_id='old-seed', source='restore', parent=None):
    db.records['_price_book_versions/' + version_id] = dict(
        version_id=version_id,
        company_id='other',
        sequence=1,
        parent_version_id=parent,
        calculation_version=price_books.CALCULATION_VERSION,
        rates=LEGACY,
        content_sha256=price_books.content_hash(LEGACY),
        source=source,
        published_at='2026',
    )


def assert_refused(response):
    assert response.status_code == 409, response.text
    assert REFUSED in response.text
    assert_no_adr_rate(response.text)


@pytest.mark.parametrize('rates', [LEGACY, adr_rates()], ids=['blank extras', 'full'])
def test_a_legacy_pin_holding_adr_rates_is_refused_for_an_unsigned_draft(api, enabled, rates):
    client, current, company_store = api
    db = company_store.db
    other_job(client, current)
    legacy_pin(db, rates)
    assert_refused(client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1}))
    assert_refused(client.get(f'/api/inspections/{ID}/pricing'))
    assert_refused(client.post(f'/api/inspections/{ID}/pricing/reprice-preview'))
    assert db.records['_job_pricing/' + ID]['rates'] == rates


def test_saved_documents_on_an_adr_rate_pin_cannot_be_kept_or_signed(api, enabled):
    client, current, company_store = api
    db = company_store.db
    other_job(client, current)
    legacy_pin(db)
    record = db.records['inspections/' + ID]
    with pytest.raises(Conflict, match=REFUSED):
        company_store.workspaces.prices.assert_pin(
            record,
            dict(
                company_id='other',
                version_id='seed',
                content_sha256=price_books.content_hash(LEGACY),
                calculation_version=price_books.CALCULATION_VERSION,
            ),
        )


def test_a_signed_job_on_an_adr_rate_pin_stays_viewable(api, enabled):
    client, current, company_store = api
    db = company_store.db
    other_job(client, current)
    legacy_pin(db)
    db.records['inspections/' + ID]['status'] = 'signed'
    view = client.get(f'/api/inspections/{ID}/pricing')
    assert view.status_code == 200, view.text
    assert view.json()['pinned']['version_id'] == 'seed'
    assert client.get(f'/api/inspections/{ID}').status_code == 200
    pin = company_store.workspaces.prices.ensure_pin('other-owner', ID)
    assert pin['rates'] == LEGACY


def test_a_saved_version_holding_adr_rates_is_refused_on_every_read(api, enabled):
    client, current, company_store = api
    db = company_store.db
    legacy_version(db)
    current['uid'] = 'other-owner'
    base = '/api/companies/other/prices'
    assert_refused(client.get(base + '/versions/old-seed'))
    assert_refused(client.get(base + '/export?format=csv&version_id=old-seed'))
    assert_refused(
        client.post(base + '/versions/old-seed/restore', json={'change_reason': 'Bring it back'})
    )
    assert not [key for key in db.records if key.startswith('_price_book_previews/')]
    current['uid'] = 'admin'
    assert_refused(client.get('/api/admin/companies/other/prices/versions/old-seed'))


def test_a_restored_book_holding_adr_rates_does_not_count_as_prices(api, enabled):
    client, current, company_store = api
    db = company_store.db
    legacy_version(db, source='restore')
    db.records['_company_price_books/other'] = dict(
        company_id='other', generation=3, latest_version_id='old-seed', next_sequence=2
    )
    current['uid'] = 'other-owner'
    view = client.get('/api/companies/other/prices')
    assert view.json()['prices_set'] is False
    assert view.json()['generation'] == 3
    assert_no_adr_rate(view.text)
    assert client.get('/api/session').json()['prices_set'] is False


def test_a_company_cannot_publish_adr_rates_as_its_own(api, enabled):
    client, current, _ = api
    current['uid'] = 'other-owner'
    assert_refused(
        client.post(
            '/api/companies/other/prices/preview',
            json={'rates': LEGACY, 'change_reason': 'Copied prices'},
        )
    )


def test_a_version_detail_never_compares_against_an_adr_rate_parent(api, enabled):
    client, current, company_store = api
    db = company_store.db
    legacy_version(db)
    db.records['_price_book_versions/mine'] = dict(
        version_id='mine',
        company_id='other',
        sequence=2,
        parent_version_id='old-seed',
        calculation_version=price_books.CALCULATION_VERSION,
        rates=OWN,
        content_sha256=price_books.content_hash(OWN),
        source='manual',
        published_at='2026',
    )
    current['uid'] = 'other-owner'
    detail = client.get('/api/companies/other/prices/versions/mine')
    assert detail.status_code == 200, detail.text
    assert_no_adr_rate(detail.text)
    assert {row['before'] for row in detail.json()['diff']} == {''}


def test_adr_keeps_the_sheet_sentence_on_a_draft_pinned_before_a_newer_book(api, enabled):
    client, current, company_store = api
    db = company_store.db
    current['uid'] = 'owner'
    made = client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    assert made.status_code == 200, made.text
    rates = adr_rates()
    db.records['_job_pricing/' + ID] = dict(
        inspection_id=ID,
        company_id='adr',
        pin_version=1,
        version_id='seed',
        sequence=0,
        rates=rates,
        content_sha256=price_books.content_hash(rates),
        calculation_version=price_books.CALCULATION_VERSION,
        priced_at='2026',
    )
    preview = client.post(
        '/api/companies/adr/prices/preview',
        json={
            'rates': {**rates, 'after_hours_job_charge': '210.00'},
            'change_reason': 'A newer book',
        },
    ).json()
    published = client.post(
        '/api/companies/adr/prices/publish',
        json={'preview_id': preview['preview_id'], 'expected_generation': preview['generation']},
    )
    assert published.status_code == 200, published.text
    view = client.get(f'/api/inspections/{ID}/pricing').json()
    assert view['display_rates']['after_hours_job_charge'] == '200.00'
    assert view['sheet_rates'] is True


def test_adr_draft_pinned_before_a_newer_book_keeps_its_own_job_charges_total(api, enabled):
    client, current, company_store = api
    db = company_store.db
    current['uid'] = 'owner'
    made = client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    assert made.status_code == 200, made.text
    rates = adr_rates()
    db.records['_job_pricing/' + ID] = dict(
        inspection_id=ID,
        company_id='adr',
        pin_version=1,
        version_id='seed',
        sequence=0,
        rates=rates,
        content_sha256=price_books.content_hash(rates),
        calculation_version=price_books.CALCULATION_VERSION,
        priced_at='2026',
    )
    preview = client.post(
        '/api/companies/adr/prices/preview',
        json={'rates': {**rates, 'emergency_call': '150.00'}, 'change_reason': 'A newer book'},
    ).json()
    published = client.post(
        '/api/companies/adr/prices/publish',
        json={'preview_id': preview['preview_id'], 'expected_generation': preview['generation']},
    )
    assert published.status_code == 200, published.text
    assert client.get('/api/session').json()['price_display']['standard_job_charges'] == '1,196.25'
    view = client.get(f'/api/inspections/{ID}/pricing').json()
    assert view['display_rates']['standard_job_charges'] == '1,180.20'


def test_a_job_on_a_company_with_no_prices_has_no_job_charges_total(api, enabled):
    client, current, _ = api
    other_job(client, current)
    view = client.get(f'/api/inspections/{ID}/pricing').json()
    assert 'standard_job_charges' not in view['display_rates']


def test_another_company_never_gets_the_sheet_sentence_signal(api, enabled):
    client, current, _ = api
    publish_own(client, current)
    other_job(client, current)
    assert client.get(f'/api/inspections/{ID}/pricing').json()['sheet_rates'] is False


def test_a_first_publication_with_an_intentional_zero_stays_in_the_review():
    rows, warnings = price_books.diff_rates(
        price_books.blank_rates(), {**OWN, 'emergency_call': '0.00'}
    )
    zero = next(row for row in rows if row['key'] == 'emergency_call')
    assert (zero['before'], zero['after'], zero['warnings']) == ('', '0.00', ['zero_rate'])
    assert 'zero_rate' in warnings
    assert 'additional_work_hourly' not in {row['key'] for row in rows}


def test_a_zero_price_left_at_zero_is_not_a_change():
    rates = {**OWN, 'emergency_call': '0.00'}
    assert price_books.diff_rates(rates, {**rates, 'emergency_call': '0'}) == ([], [])
