"""dryscope-v2 cases for the pricing oracle: owner price tables, policies and square-foot brackets.

Tables start from the vendor-neutral starter items with synthetic prices. The pricing oracle
normalizes each raw table and pins it exactly as an audit would.
"""

import copy
import random
from decimal import Decimal

from backend.price_table import DEFAULT_POLICY, STARTER_ASSIST, STARTER_ITEMS
from scripts.pricing_oracle_cases import (
    AI,
    NO_BASELINE,
    V2,
    case,
    extra,
    job,
    photo,
    room,
    serializer_job,
)

PRICES = {
    'service_call': '150.00',
    'monitoring_visit': '50.00',
    'setup_documentation': '75.00',
    'debris_haul': '120.00',
    'after_hours_charge': '200.00',
    'containment': '95.00',
    'demo_cat1_floor': '1.10',
    'demo_cat1_wall': '2.20',
    'demo_cat2_floor': '1.50',
    'demo_cat2_wall': '2.90',
    'demo_cat3_floor': '2.50',
    'demo_cat3_wall': '8.40',
    'baseboard_removal': '1.75',
    'cabinet_removal': '12.00',
    'antimicrobial': '0.35',
    'hepa_vacuum': '0.45',
    'surface_cleaning': '0.60',
    'odor_treatment': '85.00',
    'air_mover': '30.00',
    'lgr_dehumidifier': '100.00',
    'air_scrubber': '75.00',
    'hepa_filter': '180.00',
    'floor_drying_system': '180.00',
    'desiccant_dehumidifier': '250.00',
    'heater': '60.00',
    'technician_labor': '55.00',
    'supervisor_labor': '75.00',
    'content_manipulation': '50.00',
    'scan_3d': '250.00',
    'dump_truck_load': '285.00',
    'equipment_decontamination': '28.00',
    'temporary_power': '65.00',
    'generator': '150.00',
    'testing_coordination': '100.00',
    'additional_work': '55.00',
}
# Item price bands in the bracket cases: (0, 500], (500, 1000], over 1000 square feet.
BANDS = [
    {'up_to_sf': 500, 'unit_price': '3.00'},
    {'up_to_sf': 1000, 'unit_price': '2.50'},
    {'up_to_sf': None, 'unit_price': '2.00'},
]
CUSHION_BANDS = [
    {'up_to_sf': 500, 'percent': '50'},
    {'up_to_sf': 1000, 'percent': '30'},
    {'up_to_sf': None, 'percent': '10'},
]
BOUNDARIES = (499, 500, 501, 999, 1000, 1001)


def items(**changes):
    """The starter items with synthetic prices. changes maps an item id to field updates, or None
    to leave the item out."""
    result = []
    for item in STARTER_ITEMS:
        change = changes.get(item['item_id'], {})
        if change is None:
            continue
        row = dict(copy.deepcopy(item), unit_price=PRICES[item['item_id']])
        row.update(change)
        result.append(row)
    return result


def policy(**changes):
    body = copy.deepcopy(DEFAULT_POLICY)
    for key, value in changes.items():
        if isinstance(value, dict) and isinstance(body.get(key), dict):
            body[key] = dict(body[key], **value)
        else:
            body[key] = value
    return body


def table(item_changes=None, **policy_changes):
    return dict(items=items(**(item_changes or {})), policy=policy(**policy_changes))


def v2(case_id, title, tags, data, raw_table=None, **more):
    return case(
        case_id,
        title,
        ['v2', *tags],
        data,
        calculation=V2,
        table=raw_table or table(),
        **more,
    )


MIXED = [
    room('Kitchen', 3, finished_sf=120, unfinished_sf=40, custom_cabinetry=True, floor_sf=150),
    room('Hall', 1, finished_sf=60, wet_floor_sf=90, floor_sf=110),
    room('Bath', 2, unfinished_sf=35, waste_percent=10),
]


def _policy_cases():
    data = job(MIXED, air_movers=6, dehumidifiers=2, labor_hours=4)
    return [
        v2(
            'v2-default-policy',
            'Default policy: two-step cushion over mixed rooms and categories',
            ['mixed_rooms', 'water_category', 'cabinetry', 'range'],
            data,
            photos=[photo('v2k', 'Kitchen', '40.0% WME')],
        ),
        v2(
            'v2-single-estimate',
            'Single-price mode prints one total and no range',
            ['estimate_mode'],
            data,
            table(estimate_mode='single'),
        ),
        v2(
            'v2-tax-overhead-minimum-low-only',
            'Tax on taxable items after overhead and profit; the minimum lifts only the low end',
            ['tax', 'overhead_profit', 'minimum_charge'],
            job([room('Bath', 1, finished_sf=200)], **NO_BASELINE),
            table(
                {'demo_cat1_wall': {'taxable': True}, 'antimicrobial': {'taxable': True}},
                minimum_job_charge='500',
                overhead_profit_percent='10',
                sales_tax={'enabled': True, 'percent': '7.25'},
                range={'first_percent': '100', 'beyond_percent': '20'},
            ),
        ),
        v2(
            'v2-minimum-both-ends',
            'A high end still under the minimum makes both ends the minimum',
            ['minimum_charge'],
            job([room('Closet', 1, finished_sf=10)], **NO_BASELINE),
            table(minimum_job_charge='2500', overhead_profit_percent='12.5'),
        ),
        v2(
            'v2-minimum-not-reached',
            'A job above the minimum carries no minimum charge',
            ['minimum_charge', 'tax'],
            data,
            table(
                {'air_mover': {'taxable': True}, 'service_call': {'taxable': True}},
                minimum_job_charge='100',
                sales_tax={'enabled': True, 'percent': '8.875'},
            ),
        ),
        v2(
            'v2-after-hours',
            'After-hours multiplier and charge with a custom label',
            ['after_hours'],
            dict(data, is_after_hours=True),
            table(after_hours={'multiplier': '1.250', 'label': 'Night & weekend rate'}),
        ),
        v2(
            'v2-category-multipliers-finished-cabinetry',
            'Category multipliers with cabinetry on finished category 3 work only',
            ['water_category', 'cabinetry'],
            data,
            table(
                category_multipliers={'1': '1.000', '2': '1.250', '3': '1.500'},
                cabinetry={'multiplier': '2.000', 'scope': 'finished_only'},
            ),
        ),
        v2(
            'v2-cabinetry-all-category-3',
            'Cabinetry multiplier on all category 3 work',
            ['water_category', 'cabinetry'],
            data,
            table(cabinetry={'multiplier': '3.000', 'scope': 'all_cat3'}),
        ),
        v2(
            'v2-line-breakdown',
            'An owner who shows the line breakdown',
            ['estimate_mode'],
            data,
            table(show_line_breakdown=True, overhead_profit_percent='15'),
        ),
    ]


def _basis_cases():
    """The same job under each area basis, priced with a two-step cushion whose first square feet
    end inside the waste-grown kitchen, and in whole-job mode, where the basis sets the band."""
    data = job(
        [
            room('Kitchen', 3, finished_sf=140, waste_percent=10, floor_sf=160, wet_floor_sf=120),
            room('Hall', 1, finished_sf=60, floor_sf=220, wet_floor_sf=200),
            room('Bath', 2, unfinished_sf=35),
        ],
        **NO_BASELINE,
    )
    basis_items = {'antimicrobial': {'quantity_source': 'room:basis'}}
    cases = []
    for basis in ('demolition', 'demolition_with_waste', 'wet_floor'):
        cases.append(
            v2(
                f'v2-area-basis-{basis}',
                f'Area basis {basis} with a two-step cushion over the first 150 sq ft',
                ['area_basis', 'wet_vs_demolition', 'waste', 'mixed_rooms'],
                data,
                table(basis_items, area_basis=basis, range={'first_sf': 150}),
            )
        )
        cases.append(
            v2(
                f'v2-area-basis-{basis}-whole-job',
                f'Area basis {basis} choosing the whole-job price and cushion bands',
                ['area_basis', 'wet_vs_demolition', 'whole-job', 'room_once', 'brackets'],
                data,
                table(
                    dict(basis_items, demo_cat1_wall={'price_brackets': BANDS}),
                    area_basis=basis,
                    bracket_mode='whole-job',
                    range={
                        'brackets': [
                            {'up_to_sf': 250, 'percent': '40'},
                            {'up_to_sf': 400, 'percent': '25'},
                            {'up_to_sf': None, 'percent': '10'},
                        ]
                    },
                ),
            )
        )
    return cases


def _assist_cases():
    sized = job(
        [
            room(
                'Basement',
                2,
                finished_sf=300,
                floor_sf=600,
                wet_floor_sf=500,
                ceiling_height_ft=8,
                water_class=3,
            ),
            room('Stairs', 3, unfinished_sf=40, floor_sf=60, ceiling_height_ft=9, water_class=2),
        ],
        air_movers=2,
        dehumidifiers=1,
        dehumidifier_ppd=70,
        labor_hours=6,
    )
    return [
        v2(
            'v2-uncertainty-with-sizing',
            'Uncertainty high end: sizing maximums, extra drying days and hidden damage',
            ['uncertainty', 'sizing', 'warnings'],
            sized,
            table(assist=STARTER_ASSIST),
        ),
        v2(
            'v2-uncertainty-without-sizing',
            'Uncertainty high end when the sizing check lacks its inputs',
            ['uncertainty'],
            job(MIXED, air_movers=3, dehumidifiers=1, labor_hours=2),
            table(assist=STARTER_ASSIST),
        ),
    ]


def _bracket_table(mode, cushion=False, assist=None):
    changes = {'demo_cat1_wall': {'price_brackets': BANDS}}
    extra_policy = {'bracket_mode': mode}
    if cushion:
        extra_policy['range'] = {'brackets': CUSHION_BANDS}
    if assist:
        extra_policy['assist'] = assist
    return table(changes, **extra_policy)


def _bracket_cases():
    cases = []
    for mode in ('tiered', 'whole-job'):
        for sf in BOUNDARIES:
            cases.append(
                v2(
                    f'v2-brackets-{mode}-{sf}',
                    f'{sf} sq ft of bracket-priced work in {mode} mode, split over two rooms',
                    ['bracket_boundary', 'brackets', mode],
                    job(
                        [
                            room('Great room', 1, finished_sf=sf - 200),
                            room('Den', 1, finished_sf=200, waste_percent=10),
                        ],
                        **NO_BASELINE,
                    ),
                    _bracket_table(mode),
                )
            )
            cases.append(
                v2(
                    f'v2-cushion-brackets-{mode}-{sf}',
                    f'{sf} sq ft against three cushion bands in {mode} mode',
                    ['bracket_boundary', 'cushion_brackets', mode],
                    job([room('Great room', 2, unfinished_sf=sf)], **NO_BASELINE),
                    _bracket_table(mode, cushion=True),
                )
            )
    for sf in (999, 1000, 1001):
        cases.append(
            v2(
                f'v2-cushion-two-step-{sf}',
                f'{sf} sq ft against the two-step cushion edge at 1,000 sq ft',
                ['bracket_boundary', 'range'],
                job([room('Wing', 1, finished_sf=sf)], **NO_BASELINE),
            )
        )
    cases.append(
        v2(
            'v2-brackets-uncertainty-tiered',
            'Tiered bands filled by grown cost under the uncertainty method',
            ['brackets', 'uncertainty', 'tiered'],
            job(
                [
                    room('North', 3, finished_sf=400, custom_cabinetry=True),
                    room('South', 1, finished_sf=700),
                ],
                labor_hours=3,
            ),
            dict(
                items=items(
                    demo_cat1_wall={'price_brackets': BANDS},
                    demo_cat3_wall={'price_brackets': BANDS},
                ),
                policy=policy(assist=STARTER_ASSIST, bracket_mode='tiered'),
            ),
        )
    )
    return cases


def _room_once_cases():
    """Whole-job mode counts each room once, at the largest figure its priced items read."""
    return [
        v2(
            'v2-room-once-largest-figure',
            'A room with demolition and a larger wet floor counts once, at the larger figure',
            ['room_once', 'whole-job', 'wet_vs_demolition'],
            job(
                [
                    room('Family', 1, finished_sf=300, unfinished_sf=150, wet_floor_sf=700),
                    room('Office', 1, finished_sf=250, floor_sf=200),
                ],
                **NO_BASELINE,
            ),
            dict(
                items=items(demo_cat1_wall={'price_brackets': BANDS}),
                policy=policy(bracket_mode='whole-job', range={'brackets': CUSHION_BANDS}),
            ),
        ),
        v2(
            'v2-room-once-zero-basis',
            'A mold room with floor area only still counts its floor under the demolition basis',
            ['room_once', 'whole-job', 'water_category'],
            job(
                [room('Attic', 3, floor_sf=800), room('Hall', 1, finished_sf=300)],
                **NO_BASELINE,
            ),
            dict(
                items=items(demo_cat1_wall={'price_brackets': BANDS}),
                policy=policy(bracket_mode='whole-job', range={'brackets': CUSHION_BANDS}),
            ),
        ),
        v2(
            'v2-room-once-typed-footage',
            'Typed square feet with no room add once to the job total',
            ['room_once', 'whole-job', 'typed'],
            job(
                [room('Hall', 1, finished_sf=450)],
                scope_items={'odor_treatment': {'quantity': '80'}},
                **NO_BASELINE,
            ),
            dict(
                items=items(
                    demo_cat1_wall={'price_brackets': BANDS},
                    odor_treatment={'unit': 'sf', 'price_brackets': BANDS},
                ),
                policy=policy(bracket_mode='whole-job'),
            ),
        ),
    ]


def _scope_cases():
    return [
        v2(
            'v2-typed-items-and-overrides',
            'Typed items, count-by-days items and estimator overrides with reasons',
            ['typed', 'overrides', 'warnings'],
            job(
                [room('Kitchen', 2, finished_sf=95, unfinished_sf=20)],
                air_movers=5,
                scope_items={
                    'baseboard_removal': {'quantity': '42.5'},
                    'desiccant_dehumidifier': {'count': 2, 'days': 3},
                    'odor_treatment': {'quantity': '1'},
                    'mystery_item': {'quantity': '4'},
                },
                quantity_overrides={
                    'Kitchen:finished_sf': dict(
                        measured='110', entered='95', reason='Cabinets stay'
                    ),
                    'air_movers': dict(measured='4', entered='5', reason='Extra closet'),
                },
            ),
        ),
        v2(
            'v2-absent-versus-set-fields',
            'Absent job numbers take each item default; set zeros price nothing',
            ['null_omitted', 'typed'],
            dict(
                address='100 Oracle Lane, Testville',
                year_built=1990,
                scope_confirmed=True,
                rooms=[room('Hall', 1, finished_sf=50)],
                haul_loads=0,
            ),
            table(
                {
                    'service_call': {'default_quantity': '2'},
                    'debris_haul': {'default_quantity': '3'},
                }
            ),
        ),
        v2(
            'v2-extras-approved-and-pending',
            'An approved extra prices at its snapshot (taxable from the extras item); a pending one blocks',
            ['extras', 'approval_snapshot', 'tax', 'unpriced_work'],
            job(
                MIXED,
                extras=[
                    extra('v2ok', 'Detach and reset vanity', '2', '55.00', priced_from_book=True),
                    extra('v2old', 'Move refrigerator', '0.75', '47.46'),
                    extra('v2wait', 'Remove tile backsplash', '4'),
                ],
            ),
            table(
                {'additional_work': {'taxable': True, 'default_quantity': '1'}},
                sales_tax={'enabled': True, 'percent': '7.5'},
            ),
        ),
        v2(
            'v2-unpriced-room-and-quantities',
            'A category nothing prices and entered numbers without an item warn but do not price',
            ['unpriced_work', 'warnings', 'water_category'],
            job(
                [room('Hall', 1, finished_sf=80), room('Laundry', 2, unfinished_sf=40)],
                matterport_scans=2,
                wood_floor_systems=1,
            ),
            table(
                {
                    key: None
                    for key in (
                        'demo_cat2_floor',
                        'demo_cat2_wall',
                        'antimicrobial',
                        'scan_3d',
                        'floor_drying_system',
                    )
                }
            ),
            ai=dict(AI, unpriced_work=['Replace the laundry subfloor']),
        ),
        v2(
            'v2-zero-price-acknowledged',
            'A zero price the owner acknowledged stays on the table and prices $0.00',
            ['cent_boundary'],
            job(MIXED),
            table({'service_call': {'unit_price': '0.00', 'allow_zero': True}}),
            acknowledgements=['service_call'],
        ),
        v2(
            'v2-one-cent-half-cent',
            'One-cent rates: a 0.005 line and a 0.045 cushioned end both round half up',
            ['cent_boundary', 'half_cent'],
            job([room('Closet', 1, finished_sf=0.5, unfinished_sf=2)], **NO_BASELINE),
            table(
                {
                    'demo_cat1_wall': {'unit_price': '0.01'},
                    'demo_cat1_floor': {'unit_price': '0.01'},
                    'setup_documentation': None,
                },
                range={'first_percent': '50', 'beyond_percent': '50'},
            ),
        ),
        v2(
            'v2-unicode',
            'Unicode in room names and an item customer description',
            ['unicode'],
            job([room('Salón 😀', 1, finished_sf=70), room('Küche', 3, unfinished_sf=20)]),
            table({'demo_cat1_wall': {'customer_description': 'Retirar paneles – pared ✓'}}),
        ),
        v2(
            'v2-serializer-keys-and-exponents',
            'Override keys sort by code point across BMP and non-BMP names; tiny floats keep '
            'their exponent form in the canonical bytes',
            ['unicode', 'unicode_keys', 'exponent_format', 'float_format', 'overrides'],
            serializer_job(),
        ),
        v2(
            'v2-max-quantities',
            'Every quantity and multiplier at its maximum with the largest unit price',
            ['max_quantities', 'water_category', 'cabinetry', 'float_format'],
            job(
                [
                    room(
                        f'Unit {n:02d}',
                        3,
                        finished_sf=100000,
                        unfinished_sf=100000,
                        custom_cabinetry=True,
                        waste_percent=100,
                    )
                    for n in range(30)
                ],
                is_after_hours=True,
                labor_hours=500,
                air_movers=100,
                dehumidifiers=100,
                drying_days=60,
            ),
            table(
                {'demo_cat3_wall': {'unit_price': '100000.00'}},
                category_multipliers={'1': '3.000', '2': '3.000', '3': '3.000'},
                cabinetry={'multiplier': '3.000', 'scope': 'all_cat3'},
                after_hours={'multiplier': '2.000'},
                overhead_profit_percent='100',
                sales_tax={'enabled': True, 'percent': '15'},
                minimum_job_charge='100000',
            ),
        ),
        v2(
            'v2-reject-zero-total',
            'A table that prices nothing for the scope refuses the $0.00 job',
            ['rejection', 'zero_total', 'cent_boundary'],
            job([room('Hall', 1, finished_sf=0)], **NO_BASELINE),
            table({'setup_documentation': {'default_quantity': '0'}}),
        ),
        v2(
            'v2-reject-invalid-policy',
            'A cushion beyond the first square feet larger than on them is not a valid table',
            ['rejection'],
            job(MIXED),
            table(range={'first_percent': '10', 'beyond_percent': '20'}),
        ),
        v2(
            'v2-reject-unacknowledged-zero',
            'A zero price without the owner acknowledgement is not a valid table',
            ['rejection', 'cent_boundary'],
            job(MIXED),
            table({'service_call': {'unit_price': '0.00'}}),
        ),
    ]


def _seeded_policy(rng):
    first = Decimal(rng.randint(0, 10000)) / 100
    body = policy(
        estimate_mode=rng.choice(['range', 'range', 'single']),
        area_basis=rng.choice(['demolition', 'demolition_with_waste', 'wet_floor']),
        range={
            'first_sf': rng.choice([1, 250, 1000, 1001, rng.randint(1, 5000)]),
            'first_percent': str(first),
            'beyond_percent': str((first * Decimal(rng.random())).quantize(Decimal('0.01'))),
        },
        after_hours={'multiplier': rng.choice(['1.000', '1.150', '1.500', '2.000'])},
        category_multipliers={k: rng.choice(['1.000', '1.100', '1.333', '2.000']) for k in '123'},
        cabinetry={
            'multiplier': rng.choice(['1.000', '1.500', '2.000']),
            'scope': rng.choice(['finished_only', 'all_cat3']),
        },
        minimum_job_charge=rng.choice(['0', '250', '999.99', '5000']),
        overhead_profit_percent=rng.choice(['0', '10', '12.5', '20']),
        sales_tax={'enabled': rng.random() < 0.5, 'percent': rng.choice(['0', '7.25', '8.875'])},
    )
    if rng.random() < 0.4:
        body['bracket_mode'] = rng.choice(['tiered', 'whole-job'])
    if rng.random() < 0.3:
        body['range'] = dict(body['range'], brackets=CUSHION_BANDS)
    if rng.random() < 0.4:
        body['assist'] = copy.deepcopy(STARTER_ASSIST)
    return body


def _seeded_items(rng):
    changes = {}
    for item in STARTER_ITEMS:
        roll = rng.random()
        if roll < 0.15:
            changes[item['item_id']] = None
        elif roll < 0.6:
            cents = rng.randint(1, 50000 if item['unit'] != 'sf' else 2000)
            change = {'unit_price': str((Decimal(cents) / 100).quantize(Decimal('0.01')))}
            if rng.random() < 0.3:
                change['taxable'] = True
            if item['unit'] == 'sf' and rng.random() < 0.3:
                change['waste_percent'] = rng.choice(['5', '10', '12.5'])
            changes[item['item_id']] = change
    if changes.get('demo_cat1_wall', {}) is not None and rng.random() < 0.4:
        changes['demo_cat1_wall'] = {'price_brackets': BANDS}
    return items(**changes)


def seeded_v2(count=40, seed=19780102):
    rng = random.Random(seed)
    cases = []
    for n in range(count):
        rooms = [
            room(
                f'Space {k + 1}',
                rng.randint(1, 3),
                finished_sf=rng.choice([0, rng.randint(1, 1200), round(rng.uniform(1, 600), 2)]),
                unfinished_sf=rng.choice([0, rng.randint(1, 900)]),
                custom_cabinetry=rng.random() < 0.3,
                waste_percent=rng.choice([0, 0, 10, 15]),
                **({'floor_sf': rng.randint(50, 1500)} if rng.random() < 0.5 else {}),
                **({'wet_floor_sf': rng.randint(0, 900)} if rng.random() < 0.4 else {}),
            )
            for k in range(rng.randint(1, 4))
        ]
        data = job(
            rooms,
            year_built=rng.randint(1940, 2025),
            is_after_hours=rng.random() < 0.3,
            air_movers=rng.randint(0, 10),
            dehumidifiers=rng.randint(0, 3),
            drying_days=rng.randint(1, 6),
            labor_hours=rng.choice([0, 2, round(rng.uniform(0, 20), 2)]),
        )
        cases.append(
            v2(
                f'v2-seeded-{n:02d}',
                f'Seeded v2 job {n} (seed {seed})',
                ['seeded'],
                data,
                dict(items=_seeded_items(rng), policy=_seeded_policy(rng)),
            )
        )
    return cases


def v2_cases():
    return (
        _policy_cases()
        + _basis_cases()
        + _assist_cases()
        + _bracket_cases()
        + _room_once_cases()
        + _scope_cases()
        + seeded_v2()
    )
