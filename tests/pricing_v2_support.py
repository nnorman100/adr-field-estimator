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
    return lines, pricing_v2.totals(data, lines, chosen['policy'], chosen['items']), warnings


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


def _one(source, unit='sf', group='treatment', **rest):
    return [_item('probe', group, 'Probe', unit, source, '1', **rest)]


def _quantity(data, source, unit='sf', group='treatment', chosen_policy=None, **rest):
    chosen = table(_one(source, unit, group, **rest), **(chosen_policy or {}))
    lines, warnings = pricing_v2.price_scope(data, chosen)
    return [line['quantity'] for line in lines], warnings


FULL_ROOM = dict(unfinished_sf=11, finished_sf=22, floor_sf=44, wet_floor_sf=33)

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


def _quantities(data, chosen):
    lines, _ = pricing_v2.price_scope(data, chosen)
    return {line['item_id']: line['quantity'] for line in lines if not line['room']}


UNCERTAIN = dict(
    drying_days=3,
    range_method='uncertainty',
    extra_drying_days=1,
    hidden_damage_percent={'1': '10', '2': '15', '3': '25'},
)

SIZED_ROOM = dict(
    finished_sf=500, wet_floor_sf=140, floor_sf=400, ceiling_height_ft=8, water_class=2
)

SIZED_JOB = dict(
    rooms=[room('Living room', **SIZED_ROOM)],
    air_movers=3,
    dehumidifiers=1,
    dehumidifier_ppd=70,
)

TWO_CATEGORIES = dict(
    rooms=[
        room(
            'Kitchen',
            category=3,
            finished_sf=300,
            custom_cabinetry=True,
            wet_floor_sf=300,
            floor_sf=400,
            ceiling_height_ft=9,
            water_class=2,
        ),
        room(
            'Hall',
            category=1,
            finished_sf=200,
            wet_floor_sf=0,
            floor_sf=120,
            ceiling_height_ft=8,
            water_class=1,
        ),
    ],
    is_after_hours=True,
    labor_hours=4,
    air_movers=2,
    dehumidifiers=1,
    dehumidifier_ppd=70,
)

APPROVED_HOURS = dict(
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


def uncertain(items=None, assist=None, **policy):
    return table(items, assist={**UNCERTAIN, **(assist or {})}, **policy)


def priced_on(data, chosen):
    """What a job comes to on a table, the way the audit prices it."""
    pin = {'calculation_version': 'dryscope-v2', **chosen}
    return pricing.price_and_range(data, pin).totals


def without_sizing(**changes):
    rooms = [room('Living room', **{**SIZED_ROOM, 'ceiling_height_ft': None})]
    return {**SIZED_JOB, 'rooms': rooms, **changes}


def uncertain_table(rng):
    chosen = random_table(rng)
    chosen['policy']['assist'] = dict(
        drying_days=3,
        range_method=rng.choice(['uncertainty', 'uncertainty', 'uncertainty', 'cushion']),
        extra_drying_days=rng.choice([0, 1, 2, 5, 30]),
        hidden_damage_percent={key: str(rng.choice([0, 5, 10, 15, 25, 50, 100])) for key in '123'},
    )
    return chosen


def sized_job(rng):
    values = random_job(rng)
    values['dehumidifier_ppd'] = rng.choice([None, 70, 110, 150])
    for current in values['rooms']:
        stated = rng.random() < 0.8
        current['floor_sf'] = rng.choice([20, 120, 200, 600, 1500]) if stated else None
        current['ceiling_height_ft'] = rng.choice([8, 9, 10]) if stated else None
        current['water_class'] = rng.choice([1, 2, 3, 4]) if stated else None
        current['loss'] = rng.choice([None, 'water', 'mold'])
        wet = rng.choice([None, 0, 60, 140, 500])
        current['wet_floor_sf'] = (
            min(wet, current['floor_sf']) if wet is not None and stated else None
        )
    return values


def sizing_bumps(values):
    for index, current in enumerate(values['rooms']):
        wet, floor = current['wet_floor_sf'], current['floor_sf']
        # A wet floor past the floor is a mistake the check refuses, not more work.
        for key, skip in (
            ('finished_sf', False),
            ('unfinished_sf', False),
            ('floor_sf', floor is None),
            ('wet_floor_sf', wet is None or floor is None or wet >= floor),
            ('ceiling_height_ft', current['ceiling_height_ft'] is None),
        ):
            if skip:
                continue
            changed = copy.deepcopy(values)
            changed['rooms'][index][key] = current[key] + 1
            yield changed


def uncertain_ends(values, chosen):
    result = priced_on(InspectionData.model_validate(values), chosen)
    return result['low']['total'], (result['high'] or result['low'])['total']


def _sentence(values, chosen=None):
    return priced_on(job(**values), chosen or uncertain())['range_explanation']


WASTE_BASIS = 'demolition_with_waste'

TWO_ROOMS = [
    room(
        'Hall', finished_sf=60, unfinished_sf=40, floor_sf=150, wet_floor_sf=120, waste_percent=10
    ),
    room('Den', finished_sf=900, floor_sf=1000, wet_floor_sf=800),
]


def _job_area_table(area_basis, price='4', waste='5', **policy):
    item = _item(
        'area', 'demolition', 'Area removal', 'sf', 'room:basis', price, waste_percent=waste
    )
    return table([item], area_basis=area_basis, **policy)


def _starter_job_table(area_basis):
    """The starter list on a flat cushion, priced where this job reaches it."""
    prices = {
        'demo_cat2_floor': '3',
        'demo_cat2_wall': '4',
        'antimicrobial': '0.50',
    }
    chosen = price_table.starter_table()
    for row in chosen['items']:
        row['unit_price'] = prices.get(row['item_id'], '')
        row['enabled'] = row['item_id'] in prices
    chosen['policy']['area_basis'] = area_basis
    chosen['policy']['assist']['range_method'] = 'cushion'
    return price_table.normalize_table(chosen, publish=False)


EXISTING_TABLE_PINS = [
    (
        'demolition',
        'ff2bbae7f1ec215bbf444648d9e2ad9355c4bc71e447505a473ba24c3b4b8ae9',
        D('5954232.18'),
        D('6590496.32'),
    ),
    (
        'demolition',
        '3bb3d39a5b5bcfe757b47f1e534b40fb1bc81727b53334e81b211b913231b353',
        D('1308826.58'),
        D('1871626.58'),
    ),
    (
        'demolition',
        'ac26117df55fa42b832f1c2b77a2d8c58cafa9626e70fae7d01b713dcf03bd84',
        D('865158.50'),
        D('865158.50'),
    ),
    (
        'demolition',
        '1c2770372b0e9a4971e29363e51cf11812d6ee1f8d86b237fd35365935ac9b01',
        D('737890.82'),
        D('829800.78'),
    ),
    (
        'wet_floor',
        'e3f66a8487f630ba3af60df6edf26946eb6061e8c3dde6ab32da5bc21d7c2ac8',
        D('1335256.89'),
        D('1735273.43'),
    ),
    (
        'demolition',
        '265bbeee3ce1ae3aea35617af4115abed74e6f7aa90b3ab00d6abe6e2aac96e3',
        D('333310.53'),
        D('385768.32'),
    ),
    (
        'demolition',
        '01216abdcdcd9f4ff5dc13443bcd44e2fb803287822579e20bcb357927e26662',
        D('76520.00'),
        D('76520.00'),
    ),
    (
        'demolition',
        '41d1ebe30928ad37d54a3cd4a52f22a9ff33bf0c504e491d1ab3282737440f65',
        D('298729.20'),
        D('351490.65'),
    ),
    (
        'wet_floor',
        '9e3e815ed268cc5f784d3c6a902184f3ec2d234d02a1289ab00b7eef2d44e962',
        D('1662917.42'),
        D('1662917.42'),
    ),
    (
        'wet_floor',
        'f2bcaeb519222cd306206dd2b3d0de8bbfec12e3eb4eb653af57547336d37f6f',
        D('1008072.20'),
        D('1008072.20'),
    ),
    (
        'demolition',
        'cbe6e2086a8b8da4c28710f88c20fe82ea212e2a9c6c16242edae17047566f1d',
        D('1473223.73'),
        D('1473223.73'),
    ),
    (
        'demolition',
        '777abac89a98edaf9d0f6be40ea689a93a3814d92128a2f5c455557887fcf210',
        D('622895.34'),
        D('739628.01'),
    ),
    (
        'wet_floor',
        'f54bbbecfe378e1ceccf129113be649881c049b6410067d3014f4a9f847298ec',
        D('916497.48'),
        D('1113265.85'),
    ),
]

CABINETRY_ROOM = dict(
    category=3,
    unfinished_sf=100,
    finished_sf=100,
    floor_sf=100,
    wet_floor_sf=100,
    custom_cabinetry=True,
)

ROOM_SOURCES = [
    'room:demolition:unfinished',
    'room:demolition:finished',
    'room:wet_floor',
    'room:floor',
    'room:basis',
]


def _cabinetry_prices(scope):
    items = [
        _item(f'item{index}', 'treatment', source, 'sf', source, '10')
        for index, source in enumerate(ROOM_SOURCES)
    ] + [_item('calls', 'job_charges', 'Calls', 'each', 'field:emergency_calls', '10')]
    chosen = table(items, cabinetry={'multiplier': '2', 'scope': scope})
    lines, _ = pricing_v2.price_scope(job([room(**CABINETRY_ROOM)]), chosen)
    return {line['item_id']: line['unit_price'] for line in lines}
