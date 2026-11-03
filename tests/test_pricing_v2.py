"""Calculation v2: the worked examples are fixed numbers from the owner-approved build spec.

Every price below is made up and round; nothing comes from any company's workbook.
Where the spec's section 3.13 predates the owner's later decisions, the owner's decision wins:
overhead and profit is applied before sales tax, so taxable items carry their share of it.
"""

import copy
from decimal import Decimal as D
import random

import pytest

from backend import claims, price_books, price_table, pricing, pricing_v2
from backend.adr_price_book import adr_rates
from backend.contracts import InspectionData


def _item(item_id, group, name, unit, source, price, **rest):
    return dict(
        {
            'item_id': item_id,
            'code': item_id.upper().replace('_', '-')[:16],
            'group': group,
            'name': name,
            'unit': unit,
            'quantity_source': source,
            'unit_price': price,
        },
        **rest,
    )


ITEMS = [
    _item('trip', 'job_charges', 'Emergency service call', 'each', 'field:emergency_calls', '150'),
    _item('monitor', 'job_charges', 'Equipment monitoring', 'hour', 'field:monitoring_hours', '50'),
    _item('haul', 'job_charges', 'Debris haul and disposal', 'load', 'field:haul_loads', '160'),
    _item(
        'after_hours',
        'job_charges',
        'After-hours response charge',
        'each',
        'after_hours',
        '200',
    ),
    _item(
        'demo_c1_sub',
        'demolition',
        'Category 1 flooring and subfloor removal',
        'sf',
        'room:demolition:unfinished',
        '1',
        categories=[1],
    ),
    _item(
        'demo_c1_fin',
        'demolition',
        'Category 1 drywall and trim removal',
        'sf',
        'room:demolition:finished',
        '2',
        categories=[1],
    ),
    _item(
        'demo_c2_sub',
        'demolition',
        'Category 2 flooring and subfloor removal',
        'sf',
        'room:demolition:unfinished',
        '1.50',
        categories=[2],
    ),
    _item(
        'demo_c2_fin',
        'demolition',
        'Category 2 drywall and trim removal',
        'sf',
        'room:demolition:finished',
        '3',
        categories=[2],
    ),
    _item(
        'demo_c3_sub',
        'demolition',
        'Category 3 or mold flooring and subfloor removal',
        'sf',
        'room:demolition:unfinished',
        '2.50',
        categories=[3],
    ),
    _item(
        'demo_c3_fin',
        'demolition',
        'Category 3 or mold drywall and trim removal',
        'sf',
        'room:demolition:finished',
        '8',
        categories=[3],
    ),
    _item(
        'antimicrobial',
        'treatment',
        'Antimicrobial application',
        'sf',
        'room:wet_floor',
        '0.50',
        taxable=True,
    ),
    _item(
        'air_mover',
        'drying_equipment',
        'Air mover',
        'unit_day',
        'count_days:air_movers*drying_days',
        '30',
        taxable=True,
    ),
    _item(
        'dehu',
        'drying_equipment',
        'LGR dehumidifier',
        'unit_day',
        'count_days:dehumidifiers*drying_days',
        '100',
        taxable=True,
    ),
    _item('labor', 'labor', 'Technician labor', 'hour', 'field:labor_hours', '50'),
    _item('scan', 'optional_services', '3D scan', 'each', 'field:matterport_scans', '250'),
    _item('extra_work', 'extras', 'Additional work (owner approved)', 'hour', 'typed', '50'),
]

POLICY = {
    'estimate_mode': 'range',
    'area_basis': 'demolition',
    'range': {'first_sf': 1000, 'first_percent': '50', 'beyond_percent': '20'},
    'after_hours': {'multiplier': '1.2'},
    'category_multipliers': {'1': '1', '2': '1', '3': '1'},
    'cabinetry': {'multiplier': '2', 'scope': 'finished_only'},
    'overhead_profit_percent': '0',
    'sales_tax': {'enabled': False, 'percent': '0'},
    'show_line_breakdown': False,
}


def table(items=None, **policy):
    """A table normalized by the real publish rules, so the engine reads what a pin holds."""
    merged = copy.deepcopy(POLICY)
    merged.update(policy)
    return price_table.normalize_table(
        {'items': copy.deepcopy(ITEMS if items is None else items), 'policy': merged},
        publish=True,
    )


def priced(items, **changes):
    """Copies of the fixture items with price or field changes by item id."""
    out = copy.deepcopy(items)
    for row in out:
        row.update(changes.get(row['item_id'], {}))
    return out


def job(rooms=(), **changes):
    values = dict(
        rooms=list(rooms),
        emergency_calls=1,
        monitoring_hours=10,
        haul_loads=1,
        air_scrubbers=0,
        hepa_filters=0,
        air_movers=0,
        dehumidifiers=0,
        drying_days=3,
        labor_hours=0,
    )
    values.update(changes)
    return InspectionData.model_validate(values)


def room(name='Room', category=2, **changes):
    return dict(name=name, category=category, **changes)


def run(data, chosen=None):
    chosen = chosen or table()
    lines, warnings = pricing_v2.price_scope(data, chosen)
    return lines, pricing_v2.totals(data, lines, chosen['policy']), warnings


EXAMPLE_A = dict(rooms=[room('Living room', finished_sf=500)], air_movers=3, dehumidifiers=1)
EXAMPLE_D = dict(
    rooms=[
        room(
            'Kitchen',
            category=3,
            finished_sf=300,
            custom_cabinetry=True,
            wet_floor_sf=300,
            floor_sf=400,
        )
    ],
    is_after_hours=True,
    labor_hours=4,
    air_movers=2,
    dehumidifiers=1,
)


def test_worked_examples_a_to_g():
    # A. 500 sq ft category 2 wall, 3 air movers and 1 dehumidifier for 3 days.
    lines, result, _ = run(job(**EXAMPLE_A))
    assert [(line['description'], line['total'], line['bucket']) for line in lines] == [
        ('Emergency service call', 150.0, 'fixed'),
        ('Equipment monitoring', 500.0, 'fixed'),
        ('Debris haul and disposal', 160.0, 'fixed'),
        ('Living room: Category 2 drywall and trim removal', 1500.0, 'labor_material'),
        ('Air mover', 270.0, 'equipment'),
        ('LGR dehumidifier', 300.0, 'equipment'),
    ]
    assert result['labor_material_low'] == D('1500.00')
    assert result['labor_material_high'] == D('2250.00')
    assert result['low']['total'] == D('2880.00')
    assert result['high']['total'] == D('3630.00')

    # C. Two rooms at different rates: the 1,000 most expensive square feet carry the first percent.
    _, result, _ = run(
        job([room('Basement', 3, finished_sf=800), room('Hall', 1, finished_sf=600)])
    )
    assert result['labor_material_low'] == D('7600.00')
    assert result['labor_material_high'] == D('11160.00')
    assert result['low']['total'] == D('8410.00')
    assert result['high']['total'] == D('11970.00')

    # D. After hours, cabinetry, labor hours, O&P 10% and tax 8%; O&P comes before tax.
    decided = table(overhead_profit_percent='10', sales_tax={'enabled': True, 'percent': '8'})
    lines, result, _ = run(job(**EXAMPLE_D), decided)
    assert {line['description']: line['unit_price'] for line in lines}[
        'Kitchen: Category 3 or mold drywall and trim removal'
    ] == 16.0
    assert result['labor_material_low'] == D('5150.00')
    assert result['labor_material_high'] == D('7725.00')
    assert result['low'] == {
        'subtotal': D('6640.00'),
        'after_hours': D('1030.00'),
        'minimum_charge': D('0.00'),
        'overhead_profit': D('767.00'),
        # 8% of (480 + 1.2 x 150) x 1.10 = 8% of 726.00
        'tax': D('58.08'),
        'total': D('8495.08'),
    }
    assert result['high'] == {
        'subtotal': D('9215.00'),
        'after_hours': D('1545.00'),
        'minimum_charge': D('0.00'),
        'overhead_profit': D('1076.00'),
        # 8% of (480 + 1.2 x 150 x 7725 / 5150) x 1.10 = 8% of 825.00
        'tax': D('66.00'),
        'total': D('11902.00'),
    }

    # E. The same job in single-price mode.
    single = table(
        estimate_mode='single',
        overhead_profit_percent='10',
        sales_tax={'enabled': True, 'percent': '8'},
    )
    _, result, _ = run(job(**EXAMPLE_D), single)
    assert result['mode'] == 'single'
    assert result['low']['total'] == D('8495.08')
    assert result['high'] is None

    # F. Example A plus one approved extra: exactly +125.00 at both ends.
    extra = dict(
        id='e' * 32,
        description='Reset toilet',
        hours='2.5',
        approval=dict(
            accepted_by_uid='owner',
            accepted_by_name='Owner',
            accepted_at='2026-11-02T12:00:00Z',
            rate='50.00',
            total='125.00',
            company_id='adr',
            company_version=1,
        ),
    )
    lines, result, _ = run(job(**EXAMPLE_A, extras=[extra]))
    assert lines[-1]['code'] == 'EXTRA'
    assert (lines[-1]['quantity'], lines[-1]['unit_price'], lines[-1]['total']) == (
        2.5,
        50.0,
        125.0,
    )
    assert lines[-1]['bucket'] == 'fixed'
    assert result['low']['total'] == D('3005.00')
    assert result['high']['total'] == D('3755.00')

    # G. Wet-floor basis: the demolition line still reads its own area; job area reads wet floor.
    with_basis = ITEMS + [
        _item(
            'dry_setup',
            'treatment',
            'Drying setup and moisture mapping',
            'sf',
            'room:basis',
            '0.25',
        )
    ]
    lines, result, _ = run(
        job([room('Bedroom', finished_sf=100, wet_floor_sf=200, floor_sf=400)]),
        table(with_basis, area_basis='wet_floor'),
    )
    by_name = {line['description']: line['quantity'] for line in lines}
    assert by_name['Bedroom: Category 2 drywall and trim removal'] == 100.0
    assert by_name['Bedroom: Antimicrobial application'] == 200.0
    assert by_name['Bedroom: Drying setup and moisture mapping'] == 200.0
    assert result['labor_material_low'] == D('450.00')
    assert result['labor_material_high'] == D('675.00')
    assert result['low']['total'] == D('1260.00')
    assert result['high']['total'] == D('1485.00')


@pytest.mark.parametrize(
    'area,low_lm,high_lm,factor,low,high',
    [
        (999, '2997.00', '4495.50', '1.5000', '3807.00', '5305.50'),
        (1000, '3000.00', '4500.00', '1.5000', '3810.00', '5310.00'),
        (1001, '3003.00', '4503.60', '1.4997', '3813.00', '5313.60'),
        (1002, '3006.00', '4507.20', '1.4994', '3816.00', '5317.20'),
        (1250, '3750.00', '5400.00', '1.4400', '4560.00', '6210.00'),
        (2000, '6000.00', '8100.00', '1.3500', '6810.00', '8910.00'),
        (5000, '15000.00', '18900.00', '1.2600', '15810.00', '19710.00'),
    ],
)
def test_small_job_factor_equals_first_percent_and_taper_is_continuous_at_n(
    area, low_lm, high_lm, factor, low, high
):
    _, result, _ = run(job([room(finished_sf=area)]))
    assert result['labor_material_low'] == D(low_lm)
    assert result['labor_material_high'] == D(high_lm)
    ratio = result['labor_material_high'] / result['labor_material_low']
    assert abs(ratio - D(factor)) < D('0.00005')
    if area in (999, 1000, 1001):
        assert abs(ratio - D('1.5')) <= D('0.0005')
    assert result['low']['total'] == D(low)
    assert result['high']['total'] == D(high)


def test_top_n_takes_the_most_expensive_square_feet_first():
    # Three rooms; 800 at $8 and 100 at $3 are whole, then 100 of the 600 at $2 are a partial line.
    rooms = [
        room('Hall', 1, finished_sf=600),
        room('Basement', 3, finished_sf=800),
        room('Bath', 2, finished_sf=100),
    ]
    _, result, _ = run(job(rooms))
    assert result['labor_material_low'] == D('7900.00')
    top = D('6400') + D('300') + D('200')
    assert result['labor_material_high'] == D('1.2') * D('7900') + D('0.3') * top

    # Reordering the rooms changes nothing.
    _, again, _ = run(job(list(reversed(rooms))))
    assert again['labor_material_high'] == result['labor_material_high']

    # Adding cheap area beyond N never lowers the high; a proportional taper would.
    _, more, _ = run(job(rooms + [room('Garage', 1, unfinished_sf=500)]))
    assert more['high']['total'] > result['high']['total']


def test_labor_hours_carry_the_first_percent_at_every_size():
    _, result, _ = run(job([room(finished_sf=5000)], labor_hours=10))
    # Area 15,000 tapers, the 500 of labor hours carry 50%.
    assert result['labor_material_high'] == D('18900.00') + D('750.00')


# Inputs bumped by the monotonicity scan. Each returns a changed job payload.
JOB_INTS = (
    'air_movers',
    'dehumidifiers',
    'drying_days',
    'emergency_calls',
    'haul_loads',
    'air_scrubbers',
    'hepa_filters',
    'matterport_scans',
    'dump_truck_loads',
    'equipment_decon',
    'power_distribution',
    'wood_floor_systems',
    'wood_floor_days',
)
JOB_FLOATS = ('labor_hours', 'monitoring_hours')

SCAN_ITEMS = ITEMS + [
    _item('scrubber', 'drying_equipment', 'Air scrubber', 'day', 'field:air_scrubbers', '75'),
    _item('filter', 'drying_equipment', 'HEPA filter', 'each', 'field:hepa_filters', '60'),
    _item(
        'floor_mat',
        'drying_equipment',
        'Floor drying',
        'unit_day',
        'count_days:wood_floor_systems*wood_floor_days',
        '150',
    ),
    _item('dump', 'optional_services', 'Dump load', 'each', 'field:dump_truck_loads', '300'),
    _item('decon', 'optional_services', 'Decon', 'each', 'field:equipment_decon', '25'),
    _item('power', 'optional_services', 'Power', 'each', 'field:power_distribution', '65'),
    _item('hepa_vac', 'treatment', 'HEPA vacuuming', 'sf', 'room:floor', '0.75'),
    _item('setup', 'treatment', 'Job area setup', 'sf', 'room:basis', '0.25'),
    _item('odor', 'treatment', 'Odor treatment', 'each', 'typed', '90'),
    _item('super', 'labor', 'Supervisor', 'hour', 'typed', '85'),
    _item('heater', 'drying_equipment', 'Heater', 'unit_day', 'typed_count_days', '40'),
]


def random_table(rng):
    items = copy.deepcopy(SCAN_ITEMS)
    for row in items:
        row['unit_price'] = f'{rng.choice([0.5, 1, 2, 3, 5, 8, 12, 20, 30, 50, 100, 150, 400]):.2f}'
        row['taxable'] = rng.random() < 0.5
        row['waste_percent'] = rng.choice(['0', '0', '10'])
    first, beyond = rng.choice([0, 10, 20, 35, 50, 75, 100]), rng.choice([0, 5, 10, 20, 35, 50])
    if beyond > first:
        first, beyond = beyond, first
    return table(
        items,
        estimate_mode=rng.choice(['range', 'range', 'single']),
        area_basis=rng.choice(['demolition', 'wet_floor']),
        range={
            'first_sf': rng.choice([100, 500, 1000, 1500, 3000]),
            'first_percent': str(first),
            'beyond_percent': str(beyond),
        },
        after_hours={'multiplier': rng.choice(['1', '1.1', '1.2', '1.5', '2'])},
        category_multipliers={key: rng.choice(['1', '1.25', '2', '3']) for key in '123'},
        cabinetry={
            'multiplier': rng.choice(['1', '1.5', '2', '3']),
            'scope': rng.choice(['finished_only', 'all_cat3']),
        },
        minimum_job_charge=rng.choice(['0', '0', '250', '1500', '5000', '25000']),
        overhead_profit_percent=rng.choice(['0', '5', '10', '30']),
        sales_tax={
            'enabled': rng.random() < 0.6,
            'percent': rng.choice(['0', '7.25', '8', '9.5', '15']),
        },
    )


def random_job(rng):
    rooms = [
        dict(
            name=f'R{index}',
            category=rng.choice([1, 2, 3]),
            finished_sf=rng.choice([0, 50, 300, 900, 1000, 1200, 2500]),
            unfinished_sf=rng.choice([0, 100, 400, 1000]),
            wet_floor_sf=rng.choice([None, 100, 500]),
            floor_sf=rng.choice([None, 200, 800]),
            custom_cabinetry=rng.random() < 0.3,
            waste_percent=rng.choice([0, 0, 10, 25]),
        )
        for index in range(rng.randint(1, 4))
    ]
    values = {key: rng.randint(0, 6) for key in JOB_INTS}
    values.update(
        rooms=rooms,
        drying_days=rng.randint(1, 10),
        wood_floor_days=rng.randint(1, 10),
        is_after_hours=rng.random() < 0.5,
        labor_hours=rng.choice([0, 2, 8, 40]),
        monitoring_hours=rng.choice([0, 5, 10]),
        scope_items={
            'odor': {'quantity': str(rng.choice([0, 1, 3]))},
            'super': {'quantity': str(rng.choice([0, 2]))},
            'heater': {'count': rng.randint(0, 3), 'days': rng.randint(0, 5)},
        },
        quantity_overrides={
            'air_movers': {
                'measured': '1',
                'entered': str(rng.randint(0, 9)),
                'reason': 'More fans',
            }
        },
    )
    # Guarantee a priced job so the $0 guard is not what the scan measures.
    values['emergency_calls'] = max(values['emergency_calls'], 1)
    return values


def bumps(values):
    """One small increase of every job input, one at a time."""
    for key in JOB_INTS:
        yield {**copy.deepcopy(values), key: values[key] + 1}
    for key in JOB_FLOATS:
        yield {**copy.deepcopy(values), key: values[key] + 1}
    if not values['is_after_hours']:
        yield {**copy.deepcopy(values), 'is_after_hours': True}
    for index, current in enumerate(values['rooms']):
        for key in ('finished_sf', 'unfinished_sf', 'wet_floor_sf', 'floor_sf'):
            if current[key] is None:
                continue
            changed = copy.deepcopy(values)
            changed['rooms'][index][key] = current[key] + 1
            yield changed
    for item_id, field, step in (
        ('odor', 'quantity', None),
        ('heater', 'count', 1),
        ('heater', 'days', 1),
    ):
        changed = copy.deepcopy(values)
        if step is None:
            changed['scope_items'][item_id][field] = str(
                int(values['scope_items'][item_id][field]) + 1
            )
        else:
            changed['scope_items'][item_id][field] += step
        yield changed
    changed = copy.deepcopy(values)
    changed['quantity_overrides']['air_movers']['entered'] = str(
        int(values['quantity_overrides']['air_movers']['entered']) + 1
    )
    yield changed
    extra = dict(
        id='e' * 32,
        description='Added work',
        hours='1.5',
        approval=dict(
            accepted_by_uid='owner',
            accepted_by_name='Owner',
            accepted_at='2026-11-02T12:00:00Z',
            rate='40.00',
            total='60.00',
            company_id='adr',
            company_version=1,
        ),
    )
    yield {**copy.deepcopy(values), 'extras': [extra]}


def ends(values, chosen):
    data = InspectionData.model_validate(values)
    _, result, _ = run(data, chosen)
    return result['low']['total'], (result['high'] or result['low'])['total']


def test_monotone_in_every_input_and_price():
    rng = random.Random(20261102)
    tolerance = D('0.02')
    checks = 0
    for _ in range(2000):
        chosen, values = random_table(rng), random_job(rng)
        low, high = ends(values, chosen)
        for changed in bumps(values):
            new_low, new_high = ends(changed, chosen)
            checks += 1
            assert new_low >= low - tolerance, (values, changed, chosen['policy'])
            assert new_high >= high - tolerance, (values, changed, chosen['policy'])
        # Sample three prices per table: every price is covered across the run.
        for row in rng.sample(chosen['items'], 3):
            raised = copy.deepcopy(chosen)
            target = next(i for i in raised['items'] if i['item_id'] == row['item_id'])
            target['unit_price'] = f'{D(target["unit_price"]) + D("0.01"):.2f}'
            new_low, new_high = ends(values, raised)
            checks += 1
            assert new_low >= low - tolerance, (values, row, chosen['policy'])
            assert new_high >= high - tolerance, (values, row, chosen['policy'])
    assert checks > 40000


def test_high_never_below_low_and_single_mode_returns_no_high():
    rng = random.Random(7)
    for _ in range(500):
        chosen, values = random_table(rng), random_job(rng)
        data = InspectionData.model_validate(values)
        _, result, _ = run(data, chosen)
        if chosen['policy']['estimate_mode'] == 'single':
            assert result['mode'] == 'single' and result['high'] is None
            # The high labor and materials amount stays available for a later switch to range mode.
            assert result['labor_material_high'] >= result['labor_material_low']
        else:
            assert result['mode'] == 'range'
            assert result['high']['total'] >= result['low']['total']


def test_every_printed_summary_adds_up_to_its_total():
    rng = random.Random(11)
    for _ in range(300):
        chosen, values = random_table(rng), random_job(rng)
        _, result, _ = run(InspectionData.model_validate(values), chosen)
        for end in (result['low'], result['high']):
            if end is None:
                continue
            assert end['total'] == (
                end['subtotal']
                + end['after_hours']
                + end['minimum_charge']
                + end['overhead_profit']
                + end['tax']
            )
            for amount in end.values():
                assert amount == amount.quantize(D('0.01'))


def test_after_hours_multiplier_and_flat_charge():
    rooms = [room(finished_sf=100)]
    lines, regular, _ = run(job(rooms))
    assert not [line for line in lines if line['item_id'] == 'after_hours']
    assert regular['low']['after_hours'] == D('0.00')

    lines, late, _ = run(job(rooms, is_after_hours=True))
    assert [line['total'] for line in lines if line['item_id'] == 'after_hours'] == [200.0]
    assert late['low']['after_hours'] == D('60.00')  # 20% of 300
    assert late['high']['after_hours'] == D('90.00')  # 20% of 450
    assert late['low']['total'] == D('810') + D('200') + D('300') + D('60')

    lines, flat, _ = run(
        job(rooms, is_after_hours=True), table(after_hours={'multiplier': '1.000'})
    )
    assert [line['total'] for line in lines if line['item_id'] == 'after_hours'] == [200.0]
    assert flat['low']['after_hours'] == D('0.00') and flat['high']['after_hours'] == D('0.00')


def test_after_hours_line_label_is_the_owners():
    default = run(job([room(finished_sf=100)], is_after_hours=True))[1]
    assert default['after_hours_label'] == 'After-hours adjustment'
    chosen = table(after_hours={'multiplier': '1.2', 'label': 'Emergency response adjustment'})
    labelled = run(job([room(finished_sf=100)], is_after_hours=True), chosen)[1]
    assert labelled['after_hours_label'] == 'Emergency response adjustment'
    assert 'Emergency response adjustment' in labelled['explanation']


def test_category_and_cabinetry_multipliers_and_scope():
    both = [
        room('Mold', 3, unfinished_sf=100, finished_sf=100, custom_cabinetry=True),
        room('Gray', 2, finished_sf=100, custom_cabinetry=True),
    ]
    multiplied = table(
        category_multipliers={'1': '1', '2': '1.5', '3': '1.25'},
        cabinetry={'multiplier': '2', 'scope': 'finished_only'},
    )
    lines, _, _ = run(job(both), multiplied)
    prices = {line['description']: line['unit_price'] for line in lines if line['room']}
    # Category 3 floor keeps only the category multiplier under finished_only.
    assert prices['Mold: Category 3 or mold flooring and subfloor removal'] == 3.125
    assert prices['Mold: Category 3 or mold drywall and trim removal'] == 20.0
    # Category 2 rooms take their own multiplier and never the cabinetry one.
    assert prices['Gray: Category 2 drywall and trim removal'] == 4.5
    # Multipliers change room lines only.
    assert {line['description']: line['unit_price'] for line in lines}[
        'Emergency service call'
    ] == 150.0

    wide = table(
        category_multipliers={'1': '1', '2': '1.5', '3': '1.25'},
        cabinetry={'multiplier': '2', 'scope': 'all_cat3'},
    )
    lines, _, _ = run(job(both), wide)
    prices = {line['description']: line['unit_price'] for line in lines if line['room']}
    assert prices['Mold: Category 3 or mold flooring and subfloor removal'] == 6.25
    assert prices['Gray: Category 2 drywall and trim removal'] == 4.5

    # Without the cabinetry flag no cabinetry multiplier applies, in either scope.
    plain = [room('Mold', 3, finished_sf=100)]
    lines, _, _ = run(job(plain), wide)
    assert [line['unit_price'] for line in lines if line['room']] == [10.0]


def test_overhead_profit_and_tax_bases_and_rounding():
    on = {'enabled': True, 'percent': '8'}
    # O&P off: it plays no part in tax. These are the spec's own numbers for the example.
    _, off, _ = run(job(**EXAMPLE_D), table(sales_tax=on))
    assert off['low']['overhead_profit'] == D('0.00')
    assert off['low']['tax'] == D('52.80')
    assert off['high']['tax'] == D('60.00')

    # O&P on: the tax base carries the taxable items' own share of O&P, and only theirs.
    _, withop, _ = run(job(**EXAMPLE_D), table(sales_tax=on, overhead_profit_percent='10'))
    assert withop['low']['tax'] == D('58.08')
    assert withop['high']['tax'] == D('66.00')
    assert withop['low']['overhead_profit'] == D('767.00')

    # A job with nothing taxable pays no tax, O&P or not.
    no_tax_items = priced(
        ITEMS,
        antimicrobial={'taxable': False},
        air_mover={'taxable': False},
        dehu={'taxable': False},
    )
    _, untaxed = run(
        job(**EXAMPLE_D), table(no_tax_items, sales_tax=on, overhead_profit_percent='10')
    )[:2]
    assert untaxed['low']['tax'] == D('0.00') and untaxed['high']['tax'] == D('0.00')

    # L = 0: the taxable labor share is zero, taxable equipment still taxes, nothing divides by zero.
    _, no_lm, _ = run(job(air_movers=1), table(sales_tax=on))
    assert no_lm['labor_material_low'] == D('0.00')
    assert no_lm['low']['tax'] == no_lm['high']['tax'] == D('7.20')  # 8% of 90

    # Tax off keeps the percent out of the total even with a stored percent.
    _, disabled, _ = run(job(**EXAMPLE_D), table(sales_tax={'enabled': False, 'percent': '8'}))
    assert disabled['low']['tax'] == D('0.00')

    # Half-up on the summary line: 8.25% of 30.00 = 2.475 prints 2.48.
    _, cents, _ = run(
        job(air_movers=1, drying_days=1), table(sales_tax={'enabled': True, 'percent': '8.25'})
    )
    assert cents['low']['tax'] == D('2.48')


def test_minimum_job_charge_raises_the_low_before_overhead_profit_and_tax():
    # Off by default.
    _, off, _ = run(job(**EXAMPLE_A))
    assert off['low']['minimum_charge'] == D('0.00')
    assert off['minimum_charge_label'] == 'Minimum job charge'

    # Between the ends: only the low moves, the high keeps its own amount.
    _, between, _ = run(job(**EXAMPLE_A), table(minimum_job_charge='3000'))
    assert between['low']['minimum_charge'] == D('120.00')
    assert between['low']['total'] == D('3000.00')
    assert between['high']['minimum_charge'] == D('0.00')
    assert between['high']['total'] == D('3630.00')

    # Above both ends: the job is the minimum, and high equals low.
    _, above, _ = run(job(**EXAMPLE_A), table(minimum_job_charge='5000'))
    assert above['low']['minimum_charge'] == D('2120.00')
    assert above['low']['total'] == D('5000.00')
    assert above['high'] == above['low']

    # Below the low it adds nothing.
    _, below, _ = run(job(**EXAMPLE_A), table(minimum_job_charge='1000'))
    assert below['low']['minimum_charge'] == D('0.00')
    assert below['low']['total'] == D('2880.00')

    # Single mode: the price is the minimum.
    _, single, _ = run(job(**EXAMPLE_A), table(minimum_job_charge='5000', estimate_mode='single'))
    assert single['low']['total'] == D('5000.00')
    assert single['high'] is None

    # O&P is charged on the raised amount; tax stays on the taxable items and their share only.
    _, stacked, _ = run(
        job(**EXAMPLE_A),
        table(
            minimum_job_charge='5000',
            overhead_profit_percent='10',
            sales_tax={'enabled': True, 'percent': '8'},
        ),
    )
    assert stacked['low']['minimum_charge'] == D('2120.00')
    assert stacked['low']['overhead_profit'] == D('500.00')
    # 8% of 570 taxable equipment x 1.10
    assert stacked['low']['tax'] == D('50.16')
    assert stacked['low']['total'] == D('5550.16')
    assert stacked['high'] == stacked['low']


def test_minimum_job_charge_never_lets_more_work_lower_the_high():
    # Under the minimum, the taxable share at the high end shrinks as non-taxable area is added.
    # Flooring the high separately would let that lower the total; the high follows the low instead.
    rows = priced(
        ITEMS,
        demo_c2_fin={'taxable': True},
        demo_c1_fin={'unit_price': '2.00', 'taxable': False},
    )
    chosen = table(
        rows,
        minimum_job_charge='100000',
        range={'first_sf': 100, 'first_percent': '100', 'beyond_percent': '0'},
        sales_tax={'enabled': True, 'percent': '15'},
    )
    previous = None
    for extra_area in (0, 100, 500, 2000, 5000):
        rooms = [room('Taxed', 2, finished_sf=200), room('Plain', 1, finished_sf=extra_area)]
        _, result, _ = run(job(rooms), chosen)
        high = result['high']['total']
        assert high >= result['low']['total']
        if previous is not None:
            assert high >= previous
        previous = high


def test_room_waste_overrides_item_waste_only_when_positive():
    rows = priced(ITEMS, demo_c2_fin={'waste_percent': '10'}, trip={'waste_percent': '50'})
    lines, _, _ = run(
        job([room('Own', finished_sf=100, waste_percent=25), room('Falls back', finished_sf=100)]),
        table(rows),
    )
    by_room = {line['room']: line for line in lines if line['room']}
    assert by_room['Own']['waste_percent'] == 25.0 and by_room['Own']['total'] == 375.0
    assert by_room['Falls back']['waste_percent'] == 10.0
    assert by_room['Falls back']['total'] == 330.0
    # Job lines use the item's waste.
    trip = next(line for line in lines if line['item_id'] == 'trip')
    assert trip['waste_percent'] == 50.0 and trip['total'] == 225.0


def _one(source, unit='sf', group='treatment', **rest):
    return [_item('probe', group, 'Probe', unit, source, '1', **rest)]


def _quantity(data, source, unit='sf', group='treatment', chosen_policy=None, **rest):
    chosen = table(_one(source, unit, group, **rest), **(chosen_policy or {}))
    lines, warnings = pricing_v2.price_scope(data, chosen)
    return [line['quantity'] for line in lines], warnings


FULL_ROOM = dict(unfinished_sf=11, finished_sf=22, floor_sf=44, wet_floor_sf=33)


@pytest.mark.parametrize(
    'source,changes,expected',
    [
        ('room:demolition:unfinished', {}, 11.0),
        ('room:demolition:finished', {}, 22.0),
        ('room:wet_floor', {}, 33.0),
        ('room:floor', {}, 44.0),
        ('room:basis', {}, 33.0),  # demolition basis: 11 + 22
    ],
)
def test_quantity_sources_read_the_room_fields(source, changes, expected):
    quantities, _ = _quantity(job([room(**FULL_ROOM, **changes)]), source)
    assert quantities == [expected]


@pytest.mark.parametrize(
    'field,unit',
    [
        ('emergency_calls', 'each'),
        ('monitoring_hours', 'hour'),
        ('haul_loads', 'load'),
        ('air_scrubbers', 'day'),
        ('hepa_filters', 'each'),
        ('matterport_scans', 'each'),
        ('dump_truck_loads', 'each'),
        ('equipment_decon', 'each'),
        ('power_distribution', 'each'),
        ('labor_hours', 'hour'),
    ],
)
def test_quantity_sources_read_every_job_field(field, unit):
    zeroed = {name: 0 for name in price_table.FIELD_SOURCES}
    zeroed[field] = 7
    quantities, _ = _quantity(job(**zeroed), f'field:{field}', unit=unit)
    assert quantities == [7.0]
    zeroed[field] = 0
    assert _quantity(job(**zeroed), f'field:{field}', unit=unit)[0] == []


@pytest.mark.parametrize(
    'pair,count_field,days_field',
    [
        ('air_movers*drying_days', 'air_movers', 'drying_days'),
        ('dehumidifiers*drying_days', 'dehumidifiers', 'drying_days'),
        ('wood_floor_systems*wood_floor_days', 'wood_floor_systems', 'wood_floor_days'),
    ],
)
def test_quantity_sources_read_counts_times_days(pair, count_field, days_field):
    data = job(**{count_field: 3, days_field: 4})
    quantities, _ = _quantity(data, f'count_days:{pair}', unit='unit_day', group='drying_equipment')
    assert quantities == [12.0]


def test_quantity_sources_edge_rules():
    # room:basis under the wet-floor basis, and the wet-floor fallback to floor then zero.
    wet = {'area_basis': 'wet_floor'}
    assert _quantity(job([room(**FULL_ROOM)]), 'room:basis', chosen_policy=wet)[0] == [33.0]
    fallback = job([room(unfinished_sf=11, floor_sf=44)])
    assert _quantity(fallback, 'room:wet_floor')[0] == [44.0]
    assert _quantity(fallback, 'room:basis', chosen_policy=wet)[0] == [44.0]
    # A stated zero wet floor is zero: it does not fall back to the floor area.
    stated = job([room(unfinished_sf=11, floor_sf=44, wet_floor_sf=0)])
    assert _quantity(stated, 'room:wet_floor')[0] == []
    # Clearing a walkthrough-filled wet floor records entered 0 but leaves the room blank: whole floor.
    cleared = job(
        [room(unfinished_sf=11, floor_sf=120)],
        quantity_overrides={
            'Room:wet_floor_sf': {'measured': '40', 'entered': '0', 'reason': 'Whole floor wet'}
        },
    )
    assert _quantity(cleared, 'room:wet_floor')[0] == [120.0]
    assert _quantity(cleared, 'room:basis', chosen_policy=wet)[0] == [120.0]
    # An entered value on a room that holds one still wins.
    changed = job(
        [room(unfinished_sf=11, floor_sf=120, wet_floor_sf=60)],
        quantity_overrides={
            'Room:wet_floor_sf': {'measured': '40', 'entered': '60', 'reason': 'More of it wet'}
        },
    )
    assert _quantity(changed, 'room:wet_floor')[0] == [60.0]

    # after_hours is 1 with the flag, 0 without.
    assert _quantity(job(is_after_hours=True), 'after_hours', 'each', 'job_charges')[0] == [1.0]
    assert _quantity(job(), 'after_hours', 'each', 'job_charges')[0] == []

    # typed reads scope_items, else the default; an entered zero is zero.
    typed = dict(default_quantity='4')
    assert _quantity(job(), 'typed', 'each', **typed)[0] == [4.0]
    entered = job(scope_items={'probe': {'quantity': '2.5'}})
    assert _quantity(entered, 'typed', 'each', **typed)[0] == [2.5]
    cleared = job(scope_items={'probe': {'quantity': '0'}})
    assert _quantity(cleared, 'typed', 'each', **typed)[0] == []

    # typed_count_days reads count x days, else zero.
    equipment = dict(unit='unit_day', group='drying_equipment')
    assert _quantity(job(), 'typed_count_days', **equipment)[0] == []
    counted = job(scope_items={'probe': {'count': 2, 'days': 5}})
    assert _quantity(counted, 'typed_count_days', **equipment)[0] == [10.0]

    # Room sources price only matching rooms; job sources need one matching room.
    rooms = [room('One', 1, unfinished_sf=10), room('Three', 3, unfinished_sf=20)]
    only_three = dict(categories=[3])
    assert _quantity(job(rooms), 'room:demolition:unfinished', **only_three)[0] == [20.0]
    assert _quantity(job(rooms), 'field:emergency_calls', 'each', **only_three)[0] == [1.0]
    assert _quantity(job(rooms[:1]), 'field:emergency_calls', 'each', **only_three)[0] == []


def test_lines_carry_the_document_fields_in_group_then_sort_order():
    rows = priced(
        ITEMS,
        labor={'sort_order': 2, 'xactimate_code': 'WTR LAB'},
        trip={'customer_description': 'Service call to the property'},
    )
    rows.append(
        _item(
            'second_labor', 'labor', 'Second labor', 'hour', 'field:labor_hours', '10', sort_order=1
        )
    )
    lines, _, _ = run(job([room(finished_sf=10)], labor_hours=1), table(rows))
    assert lines[0]['description'] == 'Service call to the property'
    assert [line['item_id'] for line in lines if line['group'] == 'labor'] == [
        'second_labor',
        'labor',
    ]
    groups = [line['group'] for line in lines]
    assert groups == sorted(groups, key=price_table.GROUPS.index)
    wall = next(line for line in lines if line['room'])
    assert wall == {
        'code': 'DEMO-C2-FIN',
        'item_id': 'demo_c2_fin',
        'group': 'demolition',
        'bucket': 'labor_material',
        'description': 'Room: Category 2 drywall and trim removal',
        'quantity': 10.0,
        'unit': 'sf',
        'unit_price': 3.0,
        'waste_percent': 0.0,
        'total': 30.0,
        'taxable': False,
        'xactimate_code': '',
        'room': 'Room',
        'area': 10.0,
    }
    labor = next(line for line in lines if line['item_id'] == 'labor')
    assert labor['xactimate_code'] == 'WTR LAB'
    assert labor['room'] is None and labor['area'] is None


def test_warnings_are_advisory_and_unknown_items_are_not_priced():
    data = job(
        [room('Empty', 2)],
        scope_items={'gone_item': {'quantity': '5'}},
        quantity_overrides={
            'Attic:finished_sf': {
                'measured': '1',
                'entered': '2',
                'reason': 'Room was removed',
            },
            'not_a_field': {'measured': '1', 'entered': '2', 'reason': 'Unknown field'},
        },
    )
    lines, warnings = pricing_v2.price_scope(data, table())
    assert 'gone_item' not in {line['item_id'] for line in lines}
    assert {'code': 'unknown_scope_item', 'item_id': 'gone_item'} in warnings
    assert {'code': 'missing_area', 'item_id': 'demo_c2_fin', 'room': 'Empty'} in warnings
    assert {'code': 'unknown_quantity_override', 'key': 'Attic:finished_sf'} in warnings
    assert {'code': 'unknown_quantity_override', 'key': 'not_a_field'} in warnings

    # The working-copy preview runs the same engine: a blank enabled item is skipped and named.
    rows = priced(ITEMS, scan={'unit_price': ''})
    draft = price_table.normalize_table({'items': rows, 'policy': table()['policy']}, publish=False)
    lines, warnings = pricing_v2.price_scope(job(matterport_scans=1), draft)
    assert 'scan' not in {line['item_id'] for line in lines}
    assert {'code': 'blank_price_item', 'item_id': 'scan'} in warnings

    # Disabled items are never priced, and a key for one is not "unknown".
    rows = priced(ITEMS, odor_off={}) + [
        _item('odor_off', 'treatment', 'Odor', 'each', 'typed', '9', enabled=False)
    ]
    lines, warnings = pricing_v2.price_scope(
        job(scope_items={'odor_off': {'quantity': '1'}}), table(rows)
    )
    assert 'odor_off' not in {line['item_id'] for line in lines}
    assert not [warning for warning in warnings if warning['code'] == 'unknown_scope_item']


def test_the_extras_item_supplies_the_rate_and_is_never_priced_by_quantity():
    rows = priced(ITEMS, extra_work={'default_quantity': '5'})
    data = job(scope_items={'extra_work': {'quantity': '8'}})
    lines, warnings = pricing_v2.price_scope(data, table(rows))
    assert 'extra_work' not in {line['item_id'] for line in lines}
    assert warnings == [{'code': 'unpriced_extras_quantity', 'item_id': 'extra_work'}]


@pytest.mark.parametrize(
    'default,scope,warned',
    [
        ('0', None, False),
        ('0', {'quantity': '0'}, False),
        ('5', None, True),
        ('5', {'quantity': '0'}, True),
        ('0', {'quantity': '8'}, True),
    ],
)
def test_an_extras_quantity_that_will_not_be_priced_is_named(default, scope, warned):
    rows = priced(ITEMS, extra_work={'default_quantity': default})
    data = job(scope_items={'extra_work': scope} if scope else None)
    lines, warnings = pricing_v2.price_scope(data, table(rows))
    assert 'extra_work' not in {line['item_id'] for line in lines}
    expected = {'code': 'unpriced_extras_quantity', 'item_id': 'extra_work'}
    assert (expected in warnings) is warned


def test_a_blank_priced_extras_item_is_named_for_both_problems():
    rows = priced(ITEMS, extra_work={'default_quantity': '5', 'unit_price': ''})
    draft = price_table.normalize_table({'items': rows, 'policy': table()['policy']}, publish=False)
    _, warnings = pricing_v2.price_scope(job(), draft)
    assert {'code': 'unpriced_extras_quantity', 'item_id': 'extra_work'} in warnings
    assert {'code': 'blank_price_item', 'item_id': 'extra_work'} in warnings


def test_a_disabled_extras_item_is_not_named():
    rows = priced(ITEMS, extra_work={'default_quantity': '5', 'enabled': False})
    _, warnings = pricing_v2.price_scope(job(), table(rows))
    assert warnings == []


APPROVED_EXTRA = dict(
    id='e' * 32,
    description='Reset toilet',
    hours='2.5',
    approval=dict(
        accepted_by_uid='owner',
        accepted_by_name='Owner',
        accepted_at='2026-11-02T12:00:00Z',
        rate='50.00',
        total='125.00',
        company_id='adr',
        company_version=1,
    ),
)


@pytest.mark.parametrize(
    'changes,taxable,tax',
    [
        ({'taxable': True}, True, '55.60'),  # 8% of 570 equipment + 125
        ({'taxable': False}, False, '45.60'),  # 8% of 570 equipment
        ({'taxable': True, 'enabled': False}, False, '45.60'),
    ],
)
def test_an_approved_extra_is_taxable_as_the_enabled_extras_item_is(changes, taxable, tax):
    chosen = table(priced(ITEMS, extra_work=changes), sales_tax={'enabled': True, 'percent': '8'})
    lines, result, _ = run(job(**EXAMPLE_A, extras=[APPROVED_EXTRA]), chosen)
    assert lines[-1]['code'] == 'EXTRA'
    assert lines[-1]['taxable'] is taxable
    assert lines[-1]['xactimate_code'] == ''
    assert result['low']['tax'] == D(tax)
    assert result['high']['tax'] == D(tax)


def test_an_approved_extra_is_not_taxable_with_no_extras_item():
    rows = [row for row in ITEMS if row['group'] != 'extras']
    chosen = table(rows, sales_tax={'enabled': True, 'percent': '8'})
    lines, result, _ = run(job(**EXAMPLE_A, extras=[APPROVED_EXTRA]), chosen)
    assert lines[-1]['code'] == 'EXTRA' and lines[-1]['taxable'] is False
    assert result['low']['tax'] == D('45.60')


def test_the_monotonicity_tables_tax_the_extras_row_in_some_cases():
    rng = random.Random(20261102)
    flags = {
        next(row for row in random_table(rng)['items'] if row['group'] == 'extras')['taxable']
        for _ in range(50)
    }
    assert flags == {True, False}


def _quantities(data, chosen):
    lines, _ = pricing_v2.price_scope(data, chosen)
    return {line['item_id']: line['quantity'] for line in lines if not line['room']}


def test_an_unset_job_number_prices_nothing_when_the_item_has_no_default():
    omitted = InspectionData.model_validate(dict(rooms=[room(finished_sf=100)]))
    assert omitted.monitoring_hours == 13.25 and omitted.air_scrubbers == 1
    assert _quantities(omitted, table(SCAN_ITEMS)) == {}


def test_an_unset_job_number_prices_the_owners_default_quantity():
    rows = priced(
        SCAN_ITEMS,
        monitor={'default_quantity': '2'},
        scrubber={'default_quantity': '3'},
        filter={'default_quantity': '4'},
        air_mover={'default_quantity': '6'},
    )
    chosen = table(rows)
    omitted = InspectionData.model_validate(dict(rooms=[room(finished_sf=100)]))
    assert _quantities(omitted, chosen) == {
        'monitor': 2.0,
        'scrubber': 3.0,
        'filter': 4.0,
        'air_mover': 6.0,
    }
    # Either number of a count and days source being unset prices the default, not the product.
    for partial in ({'air_movers': 2}, {'drying_days': 5}):
        data = InspectionData.model_validate(dict(rooms=[room(finished_sf=100)], **partial))
        assert _quantities(data, chosen)['air_mover'] == 6.0


def test_an_explicit_job_number_wins_over_the_default_quantity():
    chosen = table(
        priced(
            SCAN_ITEMS,
            monitor={'default_quantity': '2'},
            scrubber={'default_quantity': '3'},
            air_mover={'default_quantity': '6'},
        )
    )
    data = InspectionData.model_validate(
        dict(monitoring_hours=5, air_scrubbers=0, air_movers=2, drying_days=4)
    )
    found = _quantities(data, chosen)
    assert found['monitor'] == 5.0 and found['air_mover'] == 8.0
    assert 'scrubber' not in found

    # The estimator's entered number counts as set, on its own or as one side of a product.
    entered = dict(measured='1', entered='7', reason='Measured again')
    data = InspectionData.model_validate(
        dict(
            drying_days=2,
            quantity_overrides={'monitoring_hours': entered, 'air_movers': entered},
        )
    )
    found = _quantities(data, chosen)
    assert found['monitor'] == 7.0 and found['air_mover'] == 14.0
    # An override of only one side leaves the other unset, so the default still prices.
    data = InspectionData.model_validate(dict(quantity_overrides={'air_movers': entered}))
    assert _quantities(data, chosen)['air_mover'] == 6.0


def test_entered_quantity_overrides_the_walkthrough_measurement():
    override = dict(measured='3', entered='5', reason='Added two fans for the hallway')
    data = job(air_movers=3, quantity_overrides={'air_movers': override})
    lines, _, _ = run(data)
    assert next(line for line in lines if line['item_id'] == 'air_mover')['quantity'] == 15.0

    days = dict(measured='3', entered='4', reason='Slow drying in the hallway')
    data = job(air_movers=2, quantity_overrides={'drying_days': days})
    lines, _, _ = run(data)
    assert next(line for line in lines if line['item_id'] == 'air_mover')['quantity'] == 8.0

    hours = dict(measured='10', entered='12.5', reason='Second visit needed')
    data = job(quantity_overrides={'monitoring_hours': hours})
    lines, _, _ = run(data)
    assert next(line for line in lines if line['item_id'] == 'monitor')['total'] == 625.0

    # Room fields are keyed "<room>:<field>", compared as room names are, and only touch that room.
    wall = dict(measured='120', entered='160', reason='Behind the pantry')
    data = job(
        [room('  kitchen ', finished_sf=120), room('Hall', finished_sf=120)],
        quantity_overrides={'Kitchen:finished_sf': wall},
    )
    lines, _, warnings = run(data)
    by_room = {line['room']: line for line in lines if line['room']}
    assert by_room['  kitchen ']['quantity'] == 160.0
    assert by_room['  kitchen ']['area'] == 160.0
    assert by_room['Hall']['quantity'] == 120.0
    assert not [warning for warning in warnings if warning['code'] == 'unknown_quantity_override']

    # A room name may hold a colon: the field is the part after the last one.
    wall = dict(measured='1', entered='9', reason='Measured again')
    data = job(
        [room('Unit: 4', finished_sf=1)],
        quantity_overrides={'Unit: 4:finished_sf': wall},
    )
    assert next(line for line in run(data)[0] if line['room'])['quantity'] == 9.0

    # An override to zero removes the line.
    zero = dict(measured='3', entered='0', reason='Fans were not used')
    lines, _, _ = run(job(air_movers=3, quantity_overrides={'air_movers': zero}))
    assert 'air_mover' not in {line['item_id'] for line in lines}

    # A typed item's entered quantity is what prices; the measured one is only kept.
    typed = priced(ITEMS) + [_item('odor', 'treatment', 'Odor', 'each', 'typed', '10')]
    data = job(
        scope_items={
            'odor': {'quantity': '6', 'measured_quantity': '2', 'override_reason': 'Whole house'}
        }
    )
    lines, _, _ = run(data, table(typed))
    assert next(line for line in lines if line['item_id'] == 'odor')['quantity'] == 6.0


def test_zero_total_and_unbucketed_guards():
    nothing = job(emergency_calls=0, monitoring_hours=0, haul_loads=0)
    lines, _ = pricing_v2.price_scope(nothing, table())
    assert lines == []
    message = r'^The priced scope totals \$0\.00\. Enter at least one quantity or room measurement before auditing\.$'
    with pytest.raises(ValueError, match=message):
        pricing_v2.totals(nothing, lines, table()['policy'])
    with pytest.raises(ValueError, match=message):
        pricing.price_and_range(nothing, {'calculation_version': 'dryscope-v2', **table()})

    # A minimum job charge must not turn an empty job into a signable one.
    minimum = table(minimum_job_charge='500')
    with pytest.raises(ValueError, match=message):
        pricing_v2.totals(nothing, [], minimum['policy'])

    lines, _ = pricing_v2.price_scope(job(), table())
    lines.append(dict(lines[0], code='NEW-CODE', bucket='mystery'))
    with pytest.raises(RuntimeError, match='NEW-CODE'):
        pricing_v2.totals(job(), lines, table()['policy'])

    # A group outside the closed bucket table fails at line creation too.
    corrupt = table()
    corrupt['items'][0]['group'] = 'mystery'
    with pytest.raises(RuntimeError, match='mystery'):
        pricing_v2.price_scope(job(), corrupt)


def test_v1_dispatch_unchanged():
    rates = adr_rates()
    data = InspectionData.model_validate(
        dict(
            rooms=[room(unfinished_sf=140, finished_sf=5)],
            is_after_hours=True,
            air_movers=3,
            dehumidifiers=1,
        )
    )
    result = pricing.price_and_range(
        data, {'calculation_version': 'adr-residential-v1', 'rates': rates}
    )
    lines, total = claims.price_scope(data, rates)
    assert result.lines == lines
    assert result.xactimate_total == total
    assert (result.low, result.high) == claims.proposal_range(data, lines)
    assert result.totals is None
    assert result.calculation_version == 'adr-residential-v1'
    # Today's pinned workbook example.
    assert (result.low, result.high) == (D('2219.90'), D('2356.25'))


def test_v2_dispatch_returns_the_engine_result():
    chosen = table(overhead_profit_percent='10', sales_tax={'enabled': True, 'percent': '8'})
    result = pricing.price_and_range(
        job(**EXAMPLE_D), {'calculation_version': 'dryscope-v2', **chosen}
    )
    assert result.calculation_version == 'dryscope-v2'
    assert result.low == D('8495.08')
    assert result.high == D('11902.00')
    assert result.xactimate_total == 8495.08
    assert result.totals['mode'] == 'range'
    assert result.lines[0]['item_id'] == 'trip'
    # Warnings pass through: this kitchen has no floor demolition for the category 3 floor item.
    assert result.warnings == [
        {'code': 'missing_area', 'item_id': 'demo_c3_sub', 'room': 'Kitchen'}
    ]

    single = table(estimate_mode='single')
    result = pricing.price_and_range(
        job(**EXAMPLE_A), {'calculation_version': 'dryscope-v2', **single}
    )
    assert result.low == D('2880.00') and result.high is None


def test_sample_jobs_contain_no_workbook_values():
    keys = [sample['key'] for sample in pricing_v2.SAMPLE_JOBS]
    assert keys == ['small', 'medium', 'large']
    workbook_words = {row['description'].lower() for row in price_books.ITEMS}
    for sample in pricing_v2.SAMPLE_JOBS:
        data = InspectionData.model_validate(sample['data'])
        # Quantities the workbook seeds as defaults must not leak in through the model's defaults.
        assert data.monitoring_hours != 13.25
        assert data.air_scrubbers == 0 and data.hepa_filters == 0
        text = f'{sample["label"]} {sample["description"]}'.lower()
        assert 'adr' not in text.split() and 'workbook' not in text
        assert not any(word in text for word in workbook_words)
        assert sample['label'] != pricing_v2.SAMPLE_NOTICE
        assert sample['notice'] == 'Sample job only. This does not price a saved job.'
    assert pricing_v2.SAMPLE_NOTICE == 'Sample job only. This does not price a saved job.'

    small, medium, large = (
        InspectionData.model_validate(sample['data']) for sample in pricing_v2.SAMPLE_JOBS
    )
    assert (small.rooms[0].category, small.rooms[0].finished_sf, small.rooms[0].unfinished_sf) == (
        1,
        150,
        100,
    )
    assert (small.rooms[0].floor_sf, small.rooms[0].wet_floor_sf) == (200, 150)
    assert (small.air_movers, small.dehumidifiers, small.drying_days) == (4, 1, 3)
    assert (small.emergency_calls, small.haul_loads, small.labor_hours) == (1, 1, 0)
    assert (medium.rooms[0].category, medium.rooms[0].finished_sf) == (2, 1000)
    assert (medium.rooms[0].floor_sf, medium.rooms[0].wet_floor_sf) == (1200, 1000)
    assert (medium.air_movers, medium.dehumidifiers, medium.drying_days, medium.labor_hours) == (
        8,
        2,
        4,
        4,
    )
    assert [item.category for item in large.rooms] == [3, 3]
    assert sum(item.finished_sf for item in large.rooms) == 2000
    assert sum(item.unfinished_sf for item in large.rooms) == 500
    assert sum(item.custom_cabinetry for item in large.rooms) == 1
    assert (large.air_movers, large.dehumidifiers, large.drying_days, large.labor_hours) == (
        10,
        3,
        5,
        8,
    )
    assert large.is_after_hours is True

    # Each sample prices against a real table.
    for sample in pricing_v2.SAMPLE_JOBS:
        priced_job = pricing.price_and_range(
            InspectionData.model_validate(sample['data']),
            {'calculation_version': 'dryscope-v2', **table()},
        )
        assert priced_job.low > 0


def test_a_tables_default_quantity_never_reaches_a_sample():
    job_numbers = set(price_table.FIELD_SOURCES).union(*price_table.COUNT_DAYS_SOURCES)
    with_defaults = copy.deepcopy(SCAN_ITEMS)
    for row in with_defaults:
        if row['quantity_source'].startswith(('field:', 'count_days:')):
            row['default_quantity'] = '99'
    for sample in pricing_v2.SAMPLE_JOBS:
        data = InspectionData.model_validate(sample['data'])
        assert job_numbers <= data.model_fields_set
        assert (
            pricing_v2.price_scope(data, table(with_defaults))[0]
            == pricing_v2.price_scope(data, table(SCAN_ITEMS))[0]
        )


def test_a_typed_items_default_quantity_does_reach_a_sample():
    typed = copy.deepcopy(SCAN_ITEMS) + [
        {
            **copy.deepcopy(SCAN_ITEMS[0]),
            'item_id': 'typed_fee',
            'code': 'TYPED-FEE',
            'group': 'job_charges',
            'unit': 'each',
            'quantity_source': 'typed',
            'categories': [],
            'default_quantity': '2',
            'unit_price': '10.00',
            'enabled': True,
        }
    ]
    data = InspectionData.model_validate(pricing_v2.SAMPLE_JOBS[0]['data'])
    lines, _ = pricing_v2.price_scope(data, table(typed))
    assert next(line for line in lines if line['item_id'] == 'typed_fee')['total'] == 20.0


def test_the_mold_sample_states_its_floor_areas():
    large = InspectionData.model_validate(pricing_v2.SAMPLE_JOBS[2]['data'])
    assert sum(room.floor_sf for room in large.rooms) == 2500
    assert sum(room.wet_floor_sf for room in large.rooms) == 2500
    _, warnings = pricing_v2.price_scope(large, table(SCAN_ITEMS))
    assert not [row for row in warnings if row['code'] == 'missing_area']


def test_explanation_text_comes_from_the_policy():
    chosen = table()['policy']
    assert pricing_v2.explanation(chosen, job()) == (
        'The low amount is the itemized total. The high amount adds an allowance to labor and '
        'materials for conditions found during the work: 50% on the first 1,000 square feet of '
        'area-priced work (highest-priced areas first), 20% on area beyond that, and 50% on labor '
        'hours. Job charges, drying equipment and approved additional work are the same in both '
        'amounts.'
    )
    # The multiplier is only stated on after-hours jobs.
    stacked = table(overhead_profit_percent='10', sales_tax={'enabled': True, 'percent': '7.25'})
    text = pricing_v2.explanation(stacked['policy'], job(is_after_hours=True))
    assert text.endswith(
        'Both amounts include an after-hours adjustment of 20% of labor and materials. '
        'Both amounts include overhead and profit at 10%. '
        'Sales tax at 7.25% applies to the items marked taxable and their share of overhead and profit.'
    )
    # Without O&P, tax stays on the taxable items alone.
    text = pricing_v2.explanation(
        table(sales_tax={'enabled': True, 'percent': '8'})['policy'], job()
    )
    assert text.endswith('Sales tax at 8% applies to the items marked taxable.')

    single = table(estimate_mode='single')['policy']
    assert pricing_v2.explanation(single, job()) == 'The price covers the itemized scope below.'

    # The totals carry the text; the minimum shows as its own line and is not explained here.
    _, plain, _ = run(job(**EXAMPLE_A))
    assert plain['explanation'] == pricing_v2.explanation(table()['policy'], job(**EXAMPLE_A))
    assert 'minimum' not in plain['explanation'].lower()
    _, floored, _ = run(job(**EXAMPLE_A), table(minimum_job_charge='5000'))
    assert floored['low']['minimum_charge'] > 0
    assert 'minimum' not in floored['explanation'].lower()


@pytest.mark.parametrize(
    'first,beyond,expected',
    [
        (
            '50',
            '20',
            'The high end allows 50% extra on the first 1,000 sq ft of work and 20% beyond, for hidden damage.',
        ),
        (
            '50',
            '0',
            'The high end allows 50% extra on the first 1,000 sq ft of work, for hidden damage.',
        ),
        ('30', '30', 'The high end allows 30% extra on the work, for hidden damage.'),
        (
            '12.50',
            '5',
            'The high end allows 12.5% extra on the first 1,000 sq ft of work and 5% beyond, for hidden damage.',
        ),
        ('0', '0', None),
    ],
)
def test_range_explanation_names_the_cushion_tiers(first, beyond, expected):
    chosen = table(range={'first_sf': 1000, 'first_percent': first, 'beyond_percent': beyond})
    assert pricing_v2.range_explanation(chosen['policy']) == expected
    _, result, _ = run(job(**EXAMPLE_A), chosen)
    assert result['range_explanation'] == expected


def test_single_mode_has_no_range_explanation():
    chosen = table(estimate_mode='single')
    assert pricing_v2.range_explanation(chosen['policy']) is None
    assert run(job(**EXAMPLE_A), chosen)[1]['range_explanation'] is None
