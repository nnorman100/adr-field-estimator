"""The saved calculation version selects the formulas; adr-residential-v1 never changes.

Every number below was worked out by hand from the workbook formulas in docs/adr-pricing-source.md and
is written as a literal, so a change to v1's rates, factors or rounding fails here. The rates are
spelled out rather than read from ADR's price book, because existing pins carry their own copy of them.
"""

from decimal import Decimal

import pytest
from backend.claims import make_documents, price_scope, proposal_range
from backend.contracts import AIResult, InspectionData

V1 = 'adr-residential-v1'
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
def test_v1_category_3_cabinetry_doubles_only_finished_demolition(
    after_hours, itemized, low, high
):
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
