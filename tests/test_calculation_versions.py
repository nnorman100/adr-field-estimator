"""The saved calculation version selects the formulas; adr-residential-v1 never changes.

Every number below was worked out by hand from the workbook formulas in docs/adr-pricing-source.md and
is written as a literal, so a change to v1's rates, factors or rounding fails here. The rates are
spelled out rather than read from ADR's price book, because existing pins carry their own copy of them.
"""

from decimal import Decimal

import pytest
from backend import claims, price_books
from backend.claims import line, make_documents, price_scope, proposal_range
from backend.contracts import AIResult, InspectionData, PriceBasis
from backend.inspection_store import Conflict
from backend.price_books import calculation_policy, content_hash, sample_totals
from pydantic import ValidationError
from tests.test_workspaces import ID, api, data, store  # noqa: F401

V1 = 'adr-residential-v1'
NEXT = 'test-next-version'
UNKNOWN = 'adr-residential-v9'
# Hash of V1_RATES under v1, as saved in existing pins and signed documents.
V1_HASH = 'e4c41407ed544b53d4cb88ff75024399021a45401699b23a2733a3609063b2b5'
V1_RATES = {
    'demo_cat1_unfinished': '1.21',
    'demo_cat1_finished': '2.78',
    'demo_cat2_unfinished': '1.52',
    'demo_cat2_finished': '2.89',
    'demo_cat3_unfinished': '2.48',
    'demo_cat3_finished': '8.39',
    'emergency_call': '133.95',
    'monitoring_hourly': '47.46',
    'haul_pickup_load': '159.53',
    'air_scrubber_daily': '74.75',
    'hepa_filter': '183.12',
    'matterport_scan': '250.00',
    'dump_truck_load': '286.78',
    'equipment_decontamination': '27.72',
    'power_distribution': '66.74',
    'air_mover_daily': '29.25',
    'dehumidifier_daily': '101.25',
    'wood_floor_daily': '180.00',
    'sheet_labor_hourly': '47.46',
    'after_hours_job_charge': '200.00',
    'additional_work_hourly': '47.46',
}
# Default job charges $1,180.20 plus 3 fans and 1 dehumidifier for 3 days, $567.00.
AI = AIResult(summary='Confirmed scope.', suggestions=[], unpriced_work=[])


def job(rooms, **fields):
    return InspectionData(
        address='Synthetic',
        year_built=2000,
        rooms=rooms,
        air_movers=3,
        dehumidifiers=1,
        drying_days=3,
        scope_confirmed=True,
        **fields,
    )


def cat2(square_feet, **fields):
    return job([{'name': 'Room', 'category': 2, 'finished_sf': square_feet}], **fields)


def cabinetry(**fields):
    room = {
        'name': 'Kitchen',
        'category': 3,
        'finished_sf': 100,
        'unfinished_sf': 50,
        'custom_cabinetry': True,
    }
    return job([room], labor_hours=2, **fields)


@pytest.mark.parametrize(
    ('square_feet', 'after_hours', 'itemized', 'low', 'high'),
    [
        # Regular hours: demolition at $2.89, high factor 1.5 below 1,001 SF and 1.2 from there.
        (1000, False, '4637.20', '4637.20', '6082.20'),
        (1001, False, '4640.09', '4640.09', '5218.67'),
        (1250, False, '5359.70', '5359.70', '6082.20'),
        # After hours: $200 job charge, and demolition x1.2 before the same high factor.
        (1000, True, '4837.20', '5415.20', '7149.20'),
        (1001, True, '4840.09', '5418.67', '6112.96'),
        (1250, True, '5559.70', '6282.20', '7149.20'),
    ],
)
def test_v1_range_at_the_area_threshold(square_feet, after_hours, itemized, low, high):
    scope = cat2(square_feet, is_after_hours=after_hours)
    items, total = price_scope(scope, V1_RATES)
    assert total == float(itemized)
    assert proposal_range(scope, items) == (Decimal(low), Decimal(high))


@pytest.mark.parametrize(
    ('after_hours', 'itemized', 'low', 'high'),
    [
        # Demolition $1,678.00 + $124.00 + labor $94.92 = $1,896.92 before the factors.
        (False, '3644.12', '3644.12', '4592.58'),
        (True, '3844.12', '4223.50', '5361.66'),
    ],
)
def test_v1_category_3_cabinetry_doubles_only_finished_demolition(after_hours, itemized, low, high):
    scope = cabinetry(is_after_hours=after_hours)
    items, total = price_scope(scope, V1_RATES)
    demolition = [item for item in items if item['code'] == 'ADR-DEMO']
    assert [(item['unit_price'], item['total']) for item in demolition] == [
        (2.48, 124.0),
        (16.78, 1678.0),
    ]
    assert total == float(itemized)
    assert proposal_range(scope, items) == (Decimal(low), Decimal(high))


def test_v1_scope_lines_keep_their_exact_shape():
    items, _ = price_scope(cat2(1000, is_after_hours=True), V1_RATES)
    assert items == [
        {
            'code': 'ADR-TRIP',
            'description': 'Emergency call / trip charge',
            'quantity': 1.0,
            'unit': 'EA',
            'unit_price': 133.95,
            'waste_percent': 0.0,
            'total': 133.95,
        },
        {
            'code': 'ADR-MON',
            'description': 'Equipment monitoring',
            'quantity': 13.25,
            'unit': 'HR',
            'unit_price': 47.46,
            'waste_percent': 0.0,
            'total': 628.85,
        },
        {
            'code': 'ADR-HAUL',
            'description': 'Haul debris & disposal',
            'quantity': 1.0,
            'unit': 'load',
            'unit_price': 159.53,
            'waste_percent': 0.0,
            'total': 159.53,
        },
        {
            'code': 'ADR-SCRUB',
            'description': 'Air scrubber daily rental',
            'quantity': 1.0,
            'unit': 'day',
            'unit_price': 74.75,
            'waste_percent': 0.0,
            'total': 74.75,
        },
        {
            'code': 'ADR-HEPA',
            'description': 'HEPA replacement filter',
            'quantity': 1.0,
            'unit': 'EA',
            'unit_price': 183.12,
            'waste_percent': 0.0,
            'total': 183.12,
        },
        {
            'code': 'ADR-AFTER',
            'description': 'After-hours job charge',
            'quantity': 1.0,
            'unit': 'EA',
            'unit_price': 200.0,
            'waste_percent': 0.0,
            'total': 200.0,
        },
        {
            'code': 'ADR-DEMO',
            'description': 'Room: category 2 finished/drywall/trim demolition',
            'quantity': 1000.0,
            'unit': 'SF',
            'unit_price': 2.89,
            'waste_percent': 0.0,
            'total': 2890.0,
        },
        {
            'code': 'ADR-FAN',
            'description': 'Axial air movers',
            'quantity': 9.0,
            'unit': 'unit-day',
            'unit_price': 29.25,
            'waste_percent': 0.0,
            'total': 263.25,
        },
        {
            'code': 'ADR-DEHU',
            'description': 'Commercial LGR dehumidifiers',
            'quantity': 3.0,
            'unit': 'unit-day',
            'unit_price': 101.25,
            'waste_percent': 0.0,
            'total': 303.75,
        },
    ]


def test_v1_documents_print_the_pinned_numbers():
    documents = make_documents(cat2(1001), [], AI, rates=V1_RATES)
    assert documents['xactimate_total'] == 4640.09
    assert documents['adr_estimate']['proposed_cost_low'] == 4640.09
    assert documents['adr_estimate']['proposed_cost'] == 5218.67
    assert (
        'Itemized charges at base rates: $4,640.09. Customer estimate range: $4,640.09 to $5,218.67.'
        in documents['iicrc_defense_letter']
    )


def test_v1_hash_and_policy_summary_are_unchanged():
    assert content_hash(V1_RATES) == V1_HASH
    assert content_hash(V1_RATES, V1) == V1_HASH
    assert calculation_policy() == {
        'calculation_version': V1,
        'cabinetry_factor': '2',
        'after_hours_factor': '1.2',
        'range_factor_below_1001_sf': '1.5',
        'range_factor_at_or_above_1001_sf': '1.2',
        'range_threshold_sf': '1001',
        'currency': 'USD',
    }
    assert calculation_policy(V1) == calculation_policy()


def test_a_saved_v1_pin_reproduces_its_basis_exactly(store):
    pin = {
        'inspection_id': ID,
        'company_id': 'adr',
        'pin_version': 1,
        'version_id': 'seed',
        'sequence': 0,
        'content_sha256': V1_HASH,
        'calculation_version': V1,
        'rates': dict(V1_RATES),
        'priced_at': '2026-11-02T00:00:00+00:00',
        'reason': 'first_price',
    }
    assert store.workspaces.prices.basis_for(pin, 'adr') == {
        'company_id': 'adr',
        'version_id': 'seed',
        'sequence': 0,
        'content_sha256': V1_HASH,
        'calculation_version': V1,
        'priced_at': '2026-11-02T00:00:00+00:00',
        'rates': V1_RATES,
    }


def test_every_known_version_has_formulas():
    assert V1 in claims.POLICIES
    assert all(price_books.known_calculation_version(version) for version in claims.POLICIES)
    assert set(claims.POLICIES) == set(price_books.CALCULATION_FACTORS)


def test_an_omitted_version_prices_with_v1():
    scope = cat2(1001)
    items, total = price_scope(scope, V1_RATES)
    assert (items, total) == price_scope(scope, V1_RATES, V1)
    assert proposal_range(scope, items) == proposal_range(scope, items, V1)


@pytest.fixture
def next_version(monkeypatch):
    """A second registered version with obviously different numbers, to prove the dispatch."""

    def scope(_data, rates=None):
        return [line('ADR-TRIP', 'Next trip', 1, 'EA', 7)], 7.0

    def estimate(_data, _items):
        return Decimal('10.00'), Decimal('20.00')

    monkeypatch.setitem(claims.POLICIES, NEXT, claims.CalculationPolicy(scope, estimate))
    monkeypatch.setitem(price_books.CALCULATION_FACTORS, NEXT, {'range': 'next'})
    price_books.set_enabled(True)
    yield
    price_books.set_enabled(None)


def test_the_version_selects_the_formulas(next_version):
    scope = cat2(1001)
    items, total = price_scope(scope, V1_RATES, NEXT)
    assert total == 7.0 and [item['description'] for item in items] == ['Next trip']
    assert proposal_range(scope, items, NEXT) == (Decimal('10.00'), Decimal('20.00'))
    assert price_scope(scope, V1_RATES)[1] == 4640.09
    assert sample_totals(V1_RATES, NEXT)['itemized'] == '7.00'
    assert sample_totals(V1_RATES)['itemized'] != '7.00'
    assert calculation_policy(NEXT) == {
        'calculation_version': NEXT,
        'range': 'next',
        'currency': 'USD',
    }


def test_the_same_rates_hash_differently_under_another_version(next_version):
    assert content_hash(V1_RATES, NEXT) != V1_HASH


def basis(version):
    return dict(
        company_id='adr',
        version_id='seed',
        sequence=0,
        content_sha256=V1_HASH,
        calculation_version=version,
        priced_at='2026-11-02T00:00:00+00:00',
        rates=V1_RATES,
    )


def test_documents_price_with_the_version_on_their_basis(next_version):
    documents = make_documents(cat2(1001), [], AI, rates=V1_RATES, price_basis=basis(NEXT))
    assert documents['xactimate_total'] == 7.0
    assert documents['adr_estimate']['proposed_cost_low'] == 10.0
    assert documents['adr_estimate']['proposed_cost'] == 20.0
    assert documents['price_basis']['calculation_version'] == NEXT
    v1 = make_documents(cat2(1001), [], AI, rates=V1_RATES, price_basis=basis(V1))
    assert v1['adr_estimate']['proposed_cost'] == 5218.67
    assert v1['price_basis']['calculation_version'] == V1


def test_price_basis_accepts_only_known_versions(next_version):
    assert PriceBasis(**basis(V1)).calculation_version == V1
    assert PriceBasis(**basis(NEXT)).calculation_version == NEXT
    for bad in (UNKNOWN, '', None, ['adr-residential-v1']):
        with pytest.raises(ValidationError):
            PriceBasis(**basis(bad))


@pytest.mark.parametrize('bad', [UNKNOWN, None, ['adr-residential-v1']])
def test_an_unknown_version_has_no_formulas(bad):
    with pytest.raises(ValueError):
        claims.policy_for(bad)
    with pytest.raises(ValueError):
        price_scope(cat2(10), V1_RATES, bad)
    with pytest.raises(ValueError):
        proposal_range(cat2(10), [], bad)


def pin_for(version, digest=None):
    return {
        'inspection_id': ID,
        'company_id': 'adr',
        'pin_version': 1,
        'version_id': 'next-book',
        'sequence': 1,
        'content_sha256': digest or content_hash(V1_RATES, version),
        'calculation_version': version,
        'rates': dict(V1_RATES),
        'priced_at': '2026-11-02T00:00:00+00:00',
        'reason': 'first_price',
    }


def publish_directly(store, version):
    store.db.records['_company_price_books/adr'] = {
        'latest_version_id': 'next-book',
        'generation': 1,
        'next_sequence': 2,
    }
    store.db.records['_price_book_versions/next-book'] = {
        'version_id': 'next-book',
        'company_id': 'adr',
        'sequence': 1,
        'rates': dict(V1_RATES),
        'content_sha256': content_hash(V1_RATES, version),
        'calculation_version': version,
        'source': 'manual',
    }


def test_a_pin_on_another_version_prices_audits_signing_and_reprice(api, next_version):  # noqa: F811
    client, current, store = api
    current['uid'] = 'estimator'
    created = client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    assert created.status_code == 200, created.text
    store.db.records['_job_pricing/' + ID] = pin_for(NEXT)

    audited = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
    assert audited.status_code == 200, audited.text
    documents = audited.json()['audit']['documents']
    assert documents['xactimate_total'] == 7.0
    assert documents['adr_estimate']['proposed_cost_low'] == 10.0
    assert documents['adr_estimate']['proposed_cost'] == 20.0
    assert documents['price_basis']['calculation_version'] == NEXT
    assert documents['price_basis']['content_sha256'] == content_hash(V1_RATES, NEXT)
    # The signing check accepts the pin it priced from, and refuses a basis on another version.
    prices = store.workspaces.prices
    prices.assert_pin({'inspection_id': ID}, documents['price_basis'])
    with pytest.raises(Conflict):
        prices.assert_pin(
            {'inspection_id': ID}, {**documents['price_basis'], 'calculation_version': V1}
        )

    current['uid'] = 'owner'
    preview = client.post(f'/api/inspections/{ID}/pricing/reprice-preview')
    assert preview.status_code == 200, preview.text
    review = preview.json()
    assert review['before'] == {'itemized': '7.00', 'low': '10.00', 'high': '20.00'}
    # The destination book is the v1 seed, so the other side of the preview uses v1's formulas.
    expected = price_scope(
        InspectionData.model_validate(store.db.records['inspections/' + ID]['data']), V1_RATES
    )
    assert review['after']['itemized'] == f'{expected[1]:.2f}'
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
    moved = store.db.records['_job_pricing/' + ID]
    assert moved['calculation_version'] == V1 and moved['content_sha256'] == V1_HASH


def test_a_new_pin_takes_the_version_of_its_published_book(api, next_version):  # noqa: F811
    client, current, store = api
    publish_directly(store, NEXT)
    current['uid'] = 'owner'
    view = client.get('/api/companies/adr/prices')
    assert view.status_code == 200, view.text
    assert view.json()['calculation'] == calculation_policy(NEXT)
    preview = client.post(
        '/api/companies/adr/prices/preview',
        json={
            'rates': {**V1_RATES, 'emergency_call': '150.00'},
            'acknowledgements': [],
            'change_reason': 'Trip charge for this company',
        },
    )
    assert preview.status_code == 200, preview.text
    assert preview.json()['sample_before']['itemized'] == '7.00'

    current['uid'] = 'estimator'
    created = client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    assert created.status_code == 200, created.text
    audited = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
    assert audited.status_code == 200, audited.text
    documents = audited.json()['audit']['documents']
    assert documents['xactimate_total'] == 7.0
    assert documents['price_basis']['calculation_version'] == NEXT
    assert store.db.records['_job_pricing/' + ID]['calculation_version'] == NEXT


NO_VERSION_KEY = object()


@pytest.mark.parametrize('bad', [UNKNOWN, None, ['adr-residential-v1'], NO_VERSION_KEY])
def test_a_pin_on_an_unknown_version_is_refused(api, next_version, bad):  # noqa: F811
    client, current, store = api
    current['uid'] = 'estimator'
    created = client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    assert created.status_code == 200, created.text
    pin = pin_for(bad, V1_HASH)
    if bad is NO_VERSION_KEY:
        del pin['calculation_version']
    store.db.records['_job_pricing/' + ID] = pin
    audited = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
    assert audited.status_code == 409, audited.text
    current['uid'] = 'owner'
    preview = client.post(f'/api/inspections/{ID}/pricing/reprice-preview')
    assert preview.status_code == 409, preview.text


def test_a_pin_hash_is_bound_to_its_version(store, next_version):
    with pytest.raises(Conflict):
        store.workspaces.prices.basis_for(pin_for(NEXT, V1_HASH), 'adr')
    with pytest.raises(Conflict):
        store.workspaces.prices.basis_for(pin_for(V1, content_hash(V1_RATES, NEXT)), 'adr')


def test_a_book_on_an_unknown_version_cannot_be_used(api, next_version):  # noqa: F811
    client, current, store = api
    publish_directly(store, UNKNOWN)
    current['uid'] = 'owner'
    assert client.get('/api/companies/adr/prices').status_code == 409
    current['uid'] = 'estimator'
    created = client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    assert created.status_code == 200, created.text
    audited = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
    assert audited.status_code == 409, audited.text
