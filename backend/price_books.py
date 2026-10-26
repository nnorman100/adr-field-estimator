"""Company price catalog, ADR seed rates and fixed residential calculation policy.

Formulas, factors, default quantities and mandatory wording stay in code. A company
may replace only the unit prices listed here. The seed is a frozen asset: it is not
a live pointer at one company's editable book.
"""

import hashlib
import json
import os
import re
from decimal import Decimal, ROUND_HALF_UP

CALCULATION_VERSION = 'adr-residential-v1'
CATALOG_VERSION = 1
TEMPLATE_VERSION = 'dryscope-prices-v1'
CURRENCY = 'USD'
CENT = Decimal('0.01')
# F2's shipped bound is gt=0 and le=10000 with two decimal places. The other
# hourly rates stay at the narrower editor cap from the price-editor design.
F2_MAX = Decimal('10000.00')

# allow_zero is only the trip charge and the after-hours job charge.
ITEMS = (
    {
        'key': 'demo_cat1_unfinished',
        'group': 'Demolition',
        'description': 'Category 1 clean water, unfinished / subfloor',
        'unit': 'SF',
        'seed': '1.21',
        'minimum': '0.01',
        'maximum': '100.00',
    },
    {
        'key': 'demo_cat1_finished',
        'group': 'Demolition',
        'description': 'Category 1 clean water, finished / drywall / trim',
        'unit': 'SF',
        'seed': '2.78',
        'minimum': '0.01',
        'maximum': '100.00',
    },
    {
        'key': 'demo_cat2_unfinished',
        'group': 'Demolition',
        'description': 'Category 2 gray water, unfinished / subfloor',
        'unit': 'SF',
        'seed': '1.52',
        'minimum': '0.01',
        'maximum': '100.00',
    },
    {
        'key': 'demo_cat2_finished',
        'group': 'Demolition',
        'description': 'Category 2 gray water, finished / drywall / trim',
        'unit': 'SF',
        'seed': '2.89',
        'minimum': '0.01',
        'maximum': '100.00',
    },
    {
        'key': 'demo_cat3_unfinished',
        'group': 'Demolition',
        'description': 'Category 3 / mold, unfinished / subfloor',
        'unit': 'SF',
        'seed': '2.48',
        'minimum': '0.01',
        'maximum': '100.00',
    },
    {
        'key': 'demo_cat3_finished',
        'group': 'Demolition',
        'description': 'Category 3 / mold, finished / drywall / trim',
        'unit': 'SF',
        'seed': '8.39',
        'minimum': '0.01',
        'maximum': '100.00',
    },
    {
        'key': 'emergency_call',
        'group': 'Job charges',
        'description': 'Emergency call / trip charge',
        'unit': 'EA',
        'seed': '133.95',
        'minimum': '0.00',
        'maximum': '10000.00',
        'allow_zero': True,
    },
    {
        'key': 'monitoring_hourly',
        'group': 'Job charges',
        'description': 'Equipment monitoring',
        'unit': 'HR',
        'seed': '47.46',
        'minimum': '0.01',
        'maximum': '1000.00',
    },
    {
        'key': 'haul_pickup_load',
        'group': 'Job charges',
        'description': 'Haul debris and disposal',
        'unit': 'load',
        'seed': '159.53',
        'minimum': '0.01',
        'maximum': '10000.00',
    },
    {
        'key': 'air_scrubber_daily',
        'group': 'Job charges',
        'description': 'Air scrubber daily rental',
        'unit': 'day',
        'seed': '74.75',
        'minimum': '0.01',
        'maximum': '2500.00',
    },
    {
        'key': 'hepa_filter',
        'group': 'Job charges',
        'description': 'HEPA replacement filter',
        'unit': 'EA',
        'seed': '183.12',
        'minimum': '0.01',
        'maximum': '2500.00',
    },
    {
        'key': 'matterport_scan',
        'group': 'Job charges',
        'description': 'Matterport scan',
        'unit': 'EA',
        'seed': '250.00',
        'minimum': '0.01',
        'maximum': '10000.00',
    },
    {
        'key': 'dump_truck_load',
        'group': 'Job charges',
        'description': 'Single-axle dump truck load',
        'unit': 'EA',
        'seed': '286.78',
        'minimum': '0.01',
        'maximum': '10000.00',
    },
    {
        'key': 'equipment_decontamination',
        'group': 'Job charges',
        'description': 'Drying equipment decontamination',
        'unit': 'EA',
        'seed': '27.72',
        'minimum': '0.01',
        'maximum': '1000.00',
    },
    {
        'key': 'power_distribution',
        'group': 'Job charges',
        'description': 'Power distribution',
        'unit': 'EA',
        'seed': '66.74',
        'minimum': '0.01',
        'maximum': '2500.00',
    },
    {
        'key': 'air_mover_daily',
        'group': 'Equipment',
        'description': 'Axial air mover',
        'unit': 'unit-day',
        'seed': '29.25',
        'minimum': '0.01',
        'maximum': '2500.00',
    },
    {
        'key': 'dehumidifier_daily',
        'group': 'Equipment',
        'description': 'Commercial LGR dehumidifier',
        'unit': 'unit-day',
        'seed': '101.25',
        'minimum': '0.01',
        'maximum': '2500.00',
    },
    {
        'key': 'wood_floor_daily',
        'group': 'Equipment',
        'description': 'Wood-floor drying system / heater',
        'unit': 'unit-day',
        'seed': '180.00',
        'minimum': '0.01',
        'maximum': '2500.00',
    },
    {
        'key': 'sheet_labor_hourly',
        'group': 'Labor',
        'description': 'Additional labor in the estimating sheet',
        'unit': 'HR',
        'seed': '47.46',
        'minimum': '0.01',
        'maximum': '1000.00',
    },
    {
        'key': 'after_hours_job_charge',
        'group': 'Labor',
        'description': 'After-hours job charge',
        'unit': 'EA',
        'seed': '200.00',
        'minimum': '0.00',
        'maximum': '10000.00',
        'allow_zero': True,
    },
    {
        'key': 'additional_work_hourly',
        'group': 'Additional work',
        'description': 'Additional work outside the sheet',
        'unit': 'HR',
        'seed': '47.46',
        'minimum': '0.01',
        'maximum': '10000.00',
        'f2': True,
    },
)

KEYS = tuple(item['key'] for item in ITEMS)
BY_KEY = {item['key']: item for item in ITEMS}
COLUMNS = (
    'template_version',
    'company_id',
    'base_version_id',
    'base_generation',
    'item_key',
    'description',
    'unit',
    'currency',
    'unit_price',
)
PRICE_TEXT = re.compile(r'\d{1,7}(?:\.\d{1,2})?')
# Tests and the browser fixture set this; production uses the environment only.
_forced = None


def set_enabled(value):
    """Test hook. None follows PRICE_BOOKS_ENABLED (default off)."""
    global _forced
    _forced = value


def price_books_enabled():
    if _forced is not None:
        return bool(_forced)
    return os.getenv('PRICE_BOOKS_ENABLED', 'false').lower() == 'true'


def seed_rates():
    """The frozen ADR workbook rates, including the initial additional-work rate."""
    return {item['key']: item['seed'] for item in ITEMS}


def seed_digest():
    return content_hash(seed_rates())


def calculation_policy():
    return {
        'calculation_version': CALCULATION_VERSION,
        'cabinetry_factor': '2',
        'after_hours_factor': '1.2',
        'range_factor_below_1001_sf': '1.5',
        'range_factor_at_or_above_1001_sf': '1.2',
        'range_threshold_sf': '1001',
        'currency': CURRENCY,
    }


def content_hash(rates):
    payload = {
        'calculation_version': CALCULATION_VERSION,
        'catalog_version': CATALOG_VERSION,
        'currency': CURRENCY,
        'rates': {key: rates[key] for key in KEYS},
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(',', ':')).encode()
    return hashlib.sha256(encoded).hexdigest()


def rate_fingerprint(rates):
    """Identity of the additional-work rate alone, so other price edits do not void a quote."""
    return hashlib.sha256(
        f'additional_work_hourly:{rates["additional_work_hourly"]}'.encode()
    ).hexdigest()


def _money(value):
    return Decimal(value).quantize(CENT, rounding=ROUND_HALF_UP)


def normalize_price(raw, item, row=None):
    """Accept a plain decimal string. Reject symbols, separators, exponents and extra digits."""
    where = f'Row {row}, {item["key"]}' if row else item['key']
    if not isinstance(raw, str) or raw.strip() == '':
        raise ValueError(f'{where}: enter a price.')
    text = raw.strip()
    if not PRICE_TEXT.fullmatch(text):
        raise ValueError(f'{where}: enter a price with at most two decimal places.')
    amount = Decimal(text)
    normalized = f'{amount:.2f}'
    if Decimal(normalized) != amount:
        raise ValueError(f'{where}: enter a price with at most two decimal places.')
    low, high = Decimal(item['minimum']), Decimal(item['maximum'])
    if amount < low or amount > high:
        raise ValueError(f'{where}: enter a price from {item["minimum"]} to {item["maximum"]}.')
    return normalized


def normalize_rates(incoming, acknowledgements=(), locked=(), current=None):
    """Return canonical two-digit rates or raise ValueError. `locked` keys must stay unchanged."""
    if not isinstance(incoming, dict):
        raise ValueError('Send one price for each catalog row.')
    unknown = set(incoming) - set(KEYS)
    missing = set(KEYS) - set(incoming)
    if unknown or missing:
        raise ValueError('The price list must contain each catalog row once.')
    current = current or seed_rates()
    acked = set(acknowledgements or ())
    if any(not isinstance(key, str) for key in acked):
        raise ValueError('Confirm a zero trip or after-hours charge before publishing it.')
    normalized = {}
    for item in ITEMS:
        if item['key'] in locked:
            raw = incoming[item['key']]
            held = current[item['key']]
            same = isinstance(raw, str) and raw.strip() == held
            if not same and held:
                try:
                    same = normalize_price(raw, item) == held
                except ValueError:
                    same = False
            if not same:
                raise ValueError(
                    'Additional work is not enabled. Leave its rate unchanged and do not turn it on from a file.'
                )
            normalized[item['key']] = held
            continue
        value = normalize_price(incoming[item['key']], item)
        if Decimal(value) == 0 and not item.get('allow_zero'):
            raise ValueError(f'{item["key"]}: zero is not a price for this row.')
        if Decimal(value) == 0 and item['key'] not in acked:
            raise ValueError(
                f'{item["key"]}: confirm that a zero {item["description"].lower()} is intentional.'
            )
        normalized[item['key']] = value
    return normalized


def _amount(value):
    if value in (None, ''):
        return Decimal(0)
    return Decimal(str(value))


def diff_rates(before, after):
    rows = []
    warnings = []
    for item in ITEMS:
        old, new = _amount(before[item['key']]), _amount(after[item['key']])
        if old == new:
            continue
        if old == 0:
            percent = None
            large = new != 0
        else:
            percent = (new - old) / old
            large = abs(percent) >= Decimal('0.5')
        row_warnings = []
        if large:
            row_warnings.append('large_change')
        if new == 0:
            row_warnings.append('zero_rate')
        warnings.extend(row_warnings)
        rows.append(
            {
                'key': item['key'],
                'description': item['description'],
                'unit': item['unit'],
                'before': f'{old:.2f}',
                'after': f'{new:.2f}',
                'delta': f'{(new - old):.2f}',
                'percent': None if percent is None else f'{percent:.4f}',
                'warnings': row_warnings,
            }
        )
    return rows, sorted(set(warnings))


def label_for(sequence):
    if not sequence:
        return 'Workbook seed'
    return f'Prices v{sequence}'


def public_rates(rates, *, editable_additional_work):
    rows = []
    for item in ITEMS:
        rows.append(
            {
                'key': item['key'],
                'group': item['group'],
                'description': item['description'],
                'unit': item['unit'],
                'unit_price': rates[item['key']],
                'minimum': item['minimum'],
                'maximum': item['maximum'],
                'allow_zero': bool(item.get('allow_zero')),
                'editable': editable_additional_work or not item.get('f2'),
            }
        )
    return rows


def sample_totals(rates):
    """The workbook's filled example, labelled as an illustration. It creates no job."""
    try:
        from .claims import price_scope, proposal_range
        from .contracts import InspectionData
    except ImportError:
        from claims import price_scope, proposal_range
        from contracts import InspectionData

    data = InspectionData(
        address='Sample',
        year_built=2000,
        rooms=[
            {
                'name': 'Sample room',
                'category': 2,
                'unfinished_sf': 140,
                'finished_sf': 5,
            }
        ],
        is_after_hours=True,
        air_movers=3,
        dehumidifiers=1,
        drying_days=3,
        scope_confirmed=True,
    )
    items, total = price_scope(data, rates)
    low, high = proposal_range(data, items)
    return {
        'itemized': f'{_money(total):.2f}',
        'low': f'{low:.2f}',
        'high': f'{high:.2f}',
        'label': 'Sample job only. This does not price a saved job.',
    }


def reason_text(value):
    if not isinstance(value, str):
        raise ValueError('Enter a short reason for the price change.')
    text = ' '.join(value.split())
    if len(text) < 3 or len(text) > 500 or any(not c.isprintable() for c in text):
        raise ValueError('Enter a short reason for the price change.')
    return text
