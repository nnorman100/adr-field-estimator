"""Owner-defined v2 price tables, generic starter catalog, normalization and diffs.

All prices, percentages and multipliers are canonical decimal strings validated on
the server with Decimal. The starter catalog is vendor-neutral and carries blank
unit prices.
"""

from collections import namedtuple
import copy
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import hashlib
import json
import re

try:
    from . import price_books
except ImportError:
    import price_books

CALCULATION_VERSION = 'dryscope-v2'
SCHEMA_VERSION = 2
CURRENCY = 'USD'
TEMPLATE_VERSION = 'dryscope-prices-v2'
MAX_ITEMS = 150
MAX_BRACKETS = 20
CENT = Decimal('0.01')
MILLI = Decimal('0.001')
DEFAULT_AFTER_HOURS_LABEL = 'After-hours adjustment'

GROUPS = (
    'job_charges',
    'demolition',
    'treatment',
    'drying_equipment',
    'labor',
    'optional_services',
    'extras',
)

UNITS = (
    'sf',
    'lf',
    'each',
    'hour',
    'day',
    'unit_day',
    'load',
    'visit',
)

BUCKET_OF_GROUP = {
    'job_charges': 'fixed',
    'optional_services': 'fixed',
    'extras': 'fixed',
    'drying_equipment': 'equipment',
    'demolition': 'labor_material',
    'treatment': 'labor_material',
    'labor': 'labor_material',
}

FIELD_SOURCES = (
    'emergency_calls',
    'monitoring_hours',
    'haul_loads',
    'air_scrubbers',
    'hepa_filters',
    'matterport_scans',
    'dump_truck_loads',
    'equipment_decon',
    'power_distribution',
    'labor_hours',
)

# The other job fields, and every count, are whole numbers: a fractional default could never be saved.
DECIMAL_FIELD_SOURCES = ('monitoring_hours', 'labor_hours')

SHEET_CHARGE_FIELDS = (
    'emergency_calls',
    'monitoring_hours',
    'haul_loads',
    'air_scrubbers',
    'hepa_filters',
)

COUNT_DAYS_SOURCES = {
    ('air_movers', 'drying_days'),
    ('dehumidifiers', 'drying_days'),
    ('wood_floor_systems', 'wood_floor_days'),
}

COLUMNS = (
    'template_version',
    'company_id',
    'base_version_id',
    'base_generation',
    'item_id',
    'code',
    'group',
    'name',
    'customer_description',
    'unit',
    'quantity_source',
    'categories',
    'default_quantity',
    'waste_percent',
    'unit_price',
    'taxable',
    'allow_zero',
    'xactimate_code',
    'enabled',
    'sort_order',
)

Source = namedtuple('Source', ('kind', 'field', 'count_field', 'days_field', 'finish'))

ITEM_ID_RE = re.compile(r'^[a-z][a-z0-9_]{1,39}$')
CODE_RE = re.compile(r'^[A-Z0-9][A-Z0-9-]{0,15}$')
XACTIMATE_RE = re.compile(r'^[A-Z0-9][A-Z0-9 ._/-]{0,29}$')
DECIMAL_RE = re.compile(r'^\d+(?:\.\d+)?$')
FORMULA_LEAD = re.compile(r'^[=+\-@]')

DEFAULT_POLICY = {
    'estimate_mode': 'range',
    'area_basis': 'demolition',
    'range': {
        'first_sf': 1000,
        'first_percent': '50',
        'beyond_percent': '20',
    },
    'after_hours': {
        'multiplier': '1.000',
        'label': DEFAULT_AFTER_HOURS_LABEL,
    },
    'category_multipliers': {
        '1': '1.000',
        '2': '1.000',
        '3': '1.000',
    },
    'cabinetry': {
        'multiplier': '1.000',
        'scope': 'finished_only',
    },
    'minimum_job_charge': '0',
    'overhead_profit_percent': '0',
    'sales_tax': {
        'enabled': False,
        'percent': '0',
    },
    'show_line_breakdown': False,
}

# The optional policy map behind estimate assist. A table stored without it keeps its hash, so
# normalize_policy never adds the map and every reader goes through assist_of.
DEFAULT_ASSIST = {
    'drying_days': 3,
    'range_method': 'cushion',
    'extra_drying_days': 0,
    'hidden_damage_percent': {'1': '0', '2': '0', '3': '0'},
}
STARTER_ASSIST = {
    'drying_days': 3,
    'range_method': 'uncertainty',
    'extra_drying_days': 1,
    'hidden_damage_percent': {'1': '10', '2': '15', '3': '25'},
}


def assist_of(policy: dict) -> dict:
    """The stored assist map, or what a table without one reads as. Never writes to the policy."""
    return copy.deepcopy(policy.get('assist') or DEFAULT_ASSIST)


def bracket_mode_of(policy: dict) -> str:
    return policy.get('bracket_mode', 'tiered')


def cushion_brackets_of(policy: dict) -> list[dict]:
    """Read old two-step cushions without changing their stored representation or hash."""
    tier = policy['range']
    return copy.deepcopy(
        tier.get('brackets')
        or [
            {'up_to_sf': tier['first_sf'], 'percent': tier['first_percent']},
            {'up_to_sf': None, 'percent': tier['beyond_percent']},
        ]
    )


def normalize_brackets(raw, *, where: str, value_field: str, allow_blank=False) -> list[dict]:
    """Cumulative upper limits imply contiguous bands (0, first], (first, next], ... ."""
    if not isinstance(raw, list) or not (1 <= len(raw) <= MAX_BRACKETS):
        raise ValueError(
            f'{where}: enter 1 to {MAX_BRACKETS} brackets, ending with an unlimited band.'
        )
    previous = 0
    result = []
    for index, band in enumerate(raw):
        if not isinstance(band, dict) or set(band) != {'up_to_sf', value_field}:
            raise ValueError(f'{where}: each bracket needs up_to_sf and {value_field}.')
        limit = band['up_to_sf']
        if index == len(raw) - 1:
            if limit is not None:
                raise ValueError(f'{where}: the last bracket must have up_to_sf null (unlimited).')
        elif (
            isinstance(limit, bool)
            or not isinstance(limit, int)
            or not (previous < limit <= 100000)
        ):
            raise ValueError(
                f'{where}: square-foot limits must be ascending whole numbers from 1 to 100000.'
            )
        else:
            previous = limit
        value = band[value_field]
        if allow_blank and isinstance(value, str) and not value.strip():
            value = ''
        else:
            value = _decimal_str(
                value,
                where=where,
                field=value_field,
                low=Decimal(0),
                high=Decimal(100 if value_field == 'percent' else 100000),
                max_decimals=2,
                fixed_decimals=2 if value_field == 'unit_price' else None,
            )
        result.append({'up_to_sf': limit, value_field: value})
    return result


def _default_code(item_id: str) -> str:
    return item_id.upper().replace('_', '-')[:16]


try:
    from .price_table_starter import _STARTER_ROWS
except ImportError:
    from price_table_starter import _STARTER_ROWS


# The base version a v2 template names before a company has published prices.
STARTER_VERSION = 'starter'


def _build_starter_items() -> tuple[dict, ...]:
    group_counts: dict[str, int] = {}
    built = []
    for group, item_id, name, unit, src, cats, default_qty, enabled in _STARTER_ROWS:
        order = group_counts.get(group, 0)
        group_counts[group] = order + 1
        built.append(
            {
                'item_id': item_id,
                'code': _default_code(item_id),
                'group': group,
                'name': name,
                'customer_description': '',
                'unit': unit,
                'quantity_source': src,
                'unit_price': '',
                'allow_zero': False,
                'default_quantity': default_qty,
                'waste_percent': '0',
                'categories': list(cats),
                'taxable': False,
                'xactimate_code': '',
                'enabled': enabled,
                'sort_order': order,
            }
        )
    return tuple(built)


STARTER_ITEMS = _build_starter_items()


def starter_table() -> dict:
    """Return a fresh deep copy of the vendor-neutral starter table with blank prices."""
    return {
        'items': copy.deepcopy(list(STARTER_ITEMS)),
        'policy': {**copy.deepcopy(DEFAULT_POLICY), 'assist': copy.deepcopy(STARTER_ASSIST)},
    }


def parse_source(text: str) -> Source:
    """Parse a quantity_source grammar string or raise ValueError."""
    if not isinstance(text, str) or not text:
        raise ValueError(f'Unknown quantity source: {text!r}.')
    if text == 'room:demolition:unfinished':
        return Source('room', 'unfinished_sf', None, None, 'unfinished')
    if text == 'room:demolition:finished':
        return Source('room', 'finished_sf', None, None, 'finished')
    if text == 'room:wet_floor':
        return Source('room', 'wet_floor_sf', None, None, None)
    if text == 'room:floor':
        return Source('room', 'floor_sf', None, None, None)
    if text == 'room:basis':
        return Source('room', 'basis', None, None, None)
    if text == 'after_hours':
        return Source('after_hours', None, None, None, None)
    if text == 'typed':
        return Source('typed', None, None, None, None)
    if text == 'typed_count_days':
        return Source('typed_count_days', None, None, None, None)
    if text.startswith('field:'):
        field = text[6:]
        if field in FIELD_SOURCES:
            return Source('field', field, None, None, None)
    if text.startswith('count_days:'):
        count_field, _, days_field = text[11:].partition('*')
        if (count_field, days_field) in COUNT_DAYS_SOURCES:
            return Source('count_days', None, count_field, days_field, None)
    raise ValueError(f'Unknown quantity source "{text}".')


def _printable_text(raw, *, where: str, field: str, min_len: int, max_len: int) -> str:
    if not isinstance(raw, str):
        raise ValueError(f'{where}: {field} must be text.')
    text = raw.strip()
    if len(text) < min_len or len(text) > max_len:
        raise ValueError(f'{where}: {field} must be {min_len} to {max_len} printable characters.')
    if any(not ch.isprintable() or ch in '\r\n\t' for ch in text):
        raise ValueError(f'{where}: {field} must contain only printable characters.')
    if FORMULA_LEAD.match(text):
        raise ValueError(f'{where}: {field} cannot start with =, +, - or @.')
    return text


def _decimal_str(
    raw,
    *,
    where: str,
    field: str,
    low: Decimal,
    high: Decimal,
    max_decimals: int,
    fixed_decimals: int | None = None,
) -> str:
    if isinstance(raw, bool) or raw is None:
        raise ValueError(f'{where}: {field} must be a decimal number from {low} to {high}.')
    if isinstance(raw, (int, Decimal)):
        text = str(raw)
    elif isinstance(raw, str):
        text = raw.strip()
    else:
        raise ValueError(f'{where}: {field} must be a decimal number from {low} to {high}.')
    if not DECIMAL_RE.fullmatch(text):
        raise ValueError(
            f'{where}: {field} must be between {low} and {high} with at most {max_decimals} decimal places.'
        )
    if '.' in text and len(text.split('.', 1)[1]) > max_decimals:
        raise ValueError(f'{where}: {field} must have at most {max_decimals} decimal places.')
    try:
        amount = Decimal(text)
    except InvalidOperation as error:
        raise ValueError(f'{where}: {field} is not a valid decimal number.') from error
    if amount < low or amount > high:
        raise ValueError(f'{where}: {field} must be between {low} and {high}.')
    if fixed_decimals is not None:
        return f'{amount:.{fixed_decimals}f}'
    if amount == 0:
        return '0'
    quant = Decimal(10) ** (-max_decimals)
    normalized = f'{amount.quantize(quant, rounding=ROUND_HALF_UP):.{max_decimals}f}'
    if '.' in normalized:
        normalized = normalized.rstrip('0').rstrip('.')
    return normalized or '0'


def listed_fields(table: dict) -> set[str]:
    """Job fields an enabled item reads; a field outside it has no input on the v2 form."""
    sources = [
        parse_source(item['quantity_source'])
        for item in table['items']
        if item.get('enabled', True)
    ]
    return {source.field for source in sources} | {source.count_field for source in sources}


def seed_quantities(data: dict, table: dict) -> dict:
    """An office-created job's starting quantities: the table's defaults, zero for any sheet charge
    the table does not list, and the version they came from. Matches applyDefaults on the phone."""
    seeded = copy.deepcopy(data)
    seeded['drying_days'] = assist_of(table.get('policy') or {})['drying_days']
    seen = set()
    enabled = [item for item in table['items'] if item.get('enabled', True)]
    for item in sorted(
        enabled,
        key=lambda i: (GROUPS.index(i['group']), i.get('sort_order', 0), i['item_id']),
    ):
        source = parse_source(item['quantity_source'])
        quantity = Decimal(item['default_quantity'])
        if source.kind == 'field' and source.field not in seen:
            seen.add(source.field)
            if source.field in DECIMAL_FIELD_SOURCES:
                seeded[source.field] = float(min(quantity, Decimal(500)))
            else:
                seeded[source.field] = int(min(quantity, Decimal(100)))
        elif source.kind == 'count_days' and source.count_field not in seen:
            seen.add(source.count_field)
            seeded[source.count_field] = int(min(quantity, Decimal(100)))
        elif source.kind == 'typed' and quantity > 0:
            seeded.setdefault('scope_items', {})[item['item_id']] = {
                'quantity': item['default_quantity'],
                'count': 0,
                'days': 0,
            }
        elif source.kind == 'typed_count_days' and quantity > 0:
            seeded.setdefault('scope_items', {})[item['item_id']] = {
                'quantity': '0',
                'count': int(min(quantity, Decimal(100))),
                'days': seeded['drying_days'],
            }
    for field in SHEET_CHARGE_FIELDS:
        if field not in seen:
            seeded[field] = 0
    seeded['seeded_from_version'] = table['version_id']
    return seeded


def normalize_items(items, *, publish: bool, acknowledgements=()) -> list[dict]:
    if not isinstance(items, list):
        raise ValueError('Settings: items must be a list.')
    if len(items) > MAX_ITEMS:
        raise ValueError(f'Settings: a price table can have at most {MAX_ITEMS} items.')
    if publish and not items:
        raise ValueError('Settings: at least one enabled item with a price is required to publish.')
    acked = set(acknowledgements or ())
    if any(not isinstance(key, str) for key in acked):
        raise ValueError('Settings: acknowledgements must be item ids or codes.')

    seen_ids: set[str] = set()
    seen_codes: set[str] = set()
    normalized: list[dict] = []

    for index, raw in enumerate(items, start=1):
        if not isinstance(raw, dict):
            raise ValueError(f'Row {index}: item must be an object.')
        item_id = raw.get('item_id')
        if not isinstance(item_id, str) or not ITEM_ID_RE.fullmatch(item_id):
            raise ValueError(f'Row {index}: invalid item_id "{item_id}".')
        raw_code = raw.get('code')
        if raw_code is None or (isinstance(raw_code, str) and raw_code.strip() == ''):
            code = _default_code(item_id)
        elif isinstance(raw_code, str):
            code = raw_code.strip()
        else:
            raise ValueError(f'Row {item_id}: code must be text.')
        where = f'Row {code}'
        if not CODE_RE.fullmatch(code):
            raise ValueError(f'{where}: invalid code "{code}".')
        if item_id in seen_ids:
            raise ValueError(f'{where}: duplicate item_id "{item_id}".')
        if code in seen_codes:
            raise ValueError(f'{where}: duplicate code "{code}".')
        seen_ids.add(item_id)
        seen_codes.add(code)

        group = raw.get('group')
        if group not in GROUPS:
            raise ValueError(f'{where}: unknown group "{group}".')

        name = _printable_text(raw.get('name'), where=where, field='name', min_len=1, max_len=80)
        desc_raw = raw.get('customer_description', '')
        if desc_raw is None:
            desc_raw = ''
        customer_description = _printable_text(
            desc_raw, where=where, field='customer_description', min_len=0, max_len=300
        )

        unit = raw.get('unit')
        if unit not in UNITS:
            raise ValueError(f'{where}: unknown unit "{unit}".')

        src_raw = raw.get('quantity_source')
        try:
            src = parse_source(src_raw)
        except ValueError as error:
            raise ValueError(f'{where}: {error}') from error

        if group == 'demolition' and unit == 'sf' and src.kind != 'room':
            raise ValueError(f'{where}: sf demolition items must use a room quantity source.')
        if group == 'extras' and unit != 'hour':
            raise ValueError(f'{where}: extras items must use unit "hour".')

        allow_zero = raw.get('allow_zero', False)
        if not isinstance(allow_zero, bool):
            raise ValueError(f'{where}: allow_zero must be a boolean.')
        enabled = raw.get('enabled', True)
        if not isinstance(enabled, bool):
            raise ValueError(f'{where}: enabled must be a boolean.')
        taxable = raw.get('taxable', False)
        if not isinstance(taxable, bool):
            raise ValueError(f'{where}: taxable must be a boolean.')

        brackets = None
        if 'price_brackets' in raw:
            if unit != 'sf' or src.kind not in ('room', 'typed'):
                raise ValueError(
                    f'{where}: price brackets require a square-foot room or typed item.'
                )
            brackets = normalize_brackets(
                raw['price_brackets'],
                where=where,
                value_field='unit_price',
                allow_blank=not publish or not enabled,
            )
            if any(
                band['unit_price'] != '' and Decimal(band['unit_price']) == 0 for band in brackets
            ):
                if not allow_zero:
                    raise ValueError(f'{where}: zero bracket prices require allow_zero.')
                if publish and enabled and item_id not in acked and code not in acked:
                    raise ValueError(
                        f'{where}: confirm that a zero bracket price for {name} is intentional.'
                    )

        price_raw = raw.get('unit_price', '')
        if price_raw is None:
            price_raw = ''
        if isinstance(price_raw, str) and price_raw.strip() == '':
            if publish and enabled and brackets is None:
                raise ValueError(
                    f'{where}: enter a unit price or disable the item before publishing.'
                )
            unit_price = ''
        else:
            unit_price = _decimal_str(
                price_raw,
                where=where,
                field='unit_price',
                low=Decimal('0.00'),
                high=Decimal('100000.00'),
                max_decimals=2,
                fixed_decimals=2,
            )
            if Decimal(unit_price) == 0:
                if not allow_zero:
                    raise ValueError(
                        f'{where}: zero is not a valid unit price unless allow_zero is enabled.'
                    )
                if publish and enabled and item_id not in acked and code not in acked:
                    raise ValueError(
                        f'{where}: confirm that a zero unit price for {name} is intentional.'
                    )

        default_quantity = _decimal_str(
            raw.get('default_quantity', '0'),
            where=where,
            field='default_quantity',
            low=Decimal('0'),
            high=Decimal('100000'),
            max_decimals=2,
        )
        if (
            (src.kind == 'field' and src.field not in DECIMAL_FIELD_SOURCES)
            or src.kind in ('count_days', 'typed_count_days')
        ) and Decimal(default_quantity) % 1 != 0:
            raise ValueError(f'{where}: default_quantity must be a whole number for this item.')
        waste_percent = _decimal_str(
            raw.get('waste_percent', '0'),
            where=where,
            field='waste_percent',
            low=Decimal('0'),
            high=Decimal('100'),
            max_decimals=2,
        )

        cats_raw = raw.get('categories', [])
        if cats_raw is None:
            cats_raw = []
        if not isinstance(cats_raw, (list, tuple)):
            raise ValueError(f'{where}: categories must be a list of 1, 2 or 3.')
        categories: list[int] = []
        for cat in cats_raw:
            if isinstance(cat, bool) or not isinstance(cat, int) or cat not in (1, 2, 3):
                raise ValueError(f'{where}: categories must be distinct values from 1, 2, 3.')
            if cat in categories:
                raise ValueError(f'{where}: categories must not contain duplicates.')
            categories.append(cat)
        categories.sort()

        xact_raw = raw.get('xactimate_code', '')
        if xact_raw is None:
            xact_raw = ''
        if not isinstance(xact_raw, str):
            raise ValueError(f'{where}: xactimate_code must be text.')
        xactimate_code = xact_raw.strip()
        if xactimate_code and not XACTIMATE_RE.fullmatch(xactimate_code):
            raise ValueError(f'{where}: invalid xactimate_code "{xactimate_code}".')

        order_raw = raw.get('sort_order', 0)
        if order_raw is None:
            order_raw = 0
        if (
            isinstance(order_raw, bool)
            or not isinstance(order_raw, int)
            or not (0 <= order_raw <= 10000)
        ):
            raise ValueError(f'{where}: sort_order must be an integer from 0 to 10000.')

        normalized.append(
            {
                'item_id': item_id,
                'code': code,
                'group': group,
                'name': name,
                'customer_description': customer_description,
                'unit': unit,
                'quantity_source': src_raw,
                'unit_price': unit_price,
                'allow_zero': allow_zero,
                'default_quantity': default_quantity,
                'waste_percent': waste_percent,
                'categories': categories,
                'taxable': taxable,
                'xactimate_code': xactimate_code,
                'enabled': enabled,
                'sort_order': order_raw,
            }
        )
        if brackets is not None:
            normalized[-1]['price_brackets'] = brackets

    enabled_extras = [it for it in normalized if it['group'] == 'extras' and it['enabled']]
    if len(enabled_extras) > 1:
        raise ValueError('Settings: at most one enabled item in group "extras" is allowed.')

    if publish and not any(
        it['enabled'] and (it['unit_price'] != '' or it.get('price_brackets')) for it in normalized
    ):
        raise ValueError('Settings: at least one enabled item with a price is required to publish.')

    return normalized


def _assist_int(raw: dict, field: str, low: int, high: int) -> int:
    value = raw.get(field, DEFAULT_ASSIST[field])
    if isinstance(value, bool) or not isinstance(value, int) or not (low <= value <= high):
        raise ValueError(f'Settings: assist.{field} must be an integer from {low} to {high}.')
    return value


def _normalize_assist(raw) -> dict:
    if not isinstance(raw, dict):
        raise ValueError('Settings: assist must be an object.')
    method = raw.get('range_method', DEFAULT_ASSIST['range_method'])
    if method not in ('cushion', 'uncertainty'):
        raise ValueError('Settings: assist.range_method must be "cushion" or "uncertainty".')
    percents = raw.get('hidden_damage_percent', DEFAULT_ASSIST['hidden_damage_percent'])
    if not isinstance(percents, dict) or {str(key) for key in percents} != {'1', '2', '3'}:
        raise ValueError('Settings: assist.hidden_damage_percent must contain keys 1, 2 and 3.')
    percents = {str(key): value for key, value in percents.items()}
    return {
        'drying_days': _assist_int(raw, 'drying_days', 1, 60),
        'range_method': method,
        'extra_drying_days': _assist_int(raw, 'extra_drying_days', 0, 30),
        'hidden_damage_percent': {
            key: _decimal_str(
                percents[key],
                where='Settings',
                field=f'assist.hidden_damage_percent.{key}',
                low=Decimal('0'),
                high=Decimal('100'),
                max_decimals=2,
            )
            for key in ('1', '2', '3')
        },
    }


def normalize_policy(raw) -> dict:
    if not isinstance(raw, dict):
        raise ValueError('Settings: policy must be an object.')
    where = 'Settings'

    estimate_mode = raw.get('estimate_mode', 'range')
    if estimate_mode not in ('range', 'single'):
        raise ValueError(f'{where}: estimate_mode must be "range" or "single".')

    area_basis = raw.get('area_basis', 'demolition')
    if area_basis not in ('demolition', 'demolition_with_waste', 'wet_floor'):
        raise ValueError(
            f'{where}: area_basis must be "demolition", "demolition_with_waste" or "wet_floor".'
        )

    range_raw = raw.get('range')
    if not isinstance(range_raw, dict):
        raise ValueError(f'{where}: range must be an object.')
    if 'brackets' in range_raw:
        range_raw = {**DEFAULT_POLICY['range'], **range_raw}
    first_sf = range_raw.get('first_sf')
    if isinstance(first_sf, bool) or not isinstance(first_sf, int) or not (1 <= first_sf <= 100000):
        raise ValueError(f'{where}: range.first_sf must be an integer from 1 to 100000.')
    first_percent = _decimal_str(
        range_raw.get('first_percent'),
        where=where,
        field='range.first_percent',
        low=Decimal('0'),
        high=Decimal('100'),
        max_decimals=2,
    )
    beyond_percent = _decimal_str(
        range_raw.get('beyond_percent'),
        where=where,
        field='range.beyond_percent',
        low=Decimal('0'),
        high=Decimal('100'),
        max_decimals=2,
    )
    if 'brackets' not in range_raw and Decimal(beyond_percent) > Decimal(first_percent):
        raise ValueError(
            f'{where}: The cushion beyond the first square feet cannot exceed the cushion on them.'
        )

    ah_raw = raw.get('after_hours')
    if not isinstance(ah_raw, dict):
        raise ValueError(f'{where}: after_hours must be an object.')
    ah_multiplier = _decimal_str(
        ah_raw.get('multiplier'),
        where=where,
        field='after_hours.multiplier',
        low=Decimal('1.000'),
        high=Decimal('2.000'),
        max_decimals=3,
        fixed_decimals=3,
    )
    ah_label = _printable_text(
        ah_raw.get('label', DEFAULT_AFTER_HOURS_LABEL),
        where=where,
        field='after_hours.label',
        min_len=1,
        max_len=80,
    )

    cat_raw = raw.get('category_multipliers')
    if not isinstance(cat_raw, dict):
        raise ValueError(f'{where}: category_multipliers must be an object.')
    cat_keys = {str(k): v for k, v in cat_raw.items()}
    if set(cat_keys) != {'1', '2', '3'}:
        raise ValueError(f'{where}: category_multipliers must contain keys 1, 2 and 3.')
    category_multipliers = {
        key: _decimal_str(
            cat_keys[key],
            where=where,
            field=f'category_multipliers.{key}',
            low=Decimal('1.000'),
            high=Decimal('3.000'),
            max_decimals=3,
            fixed_decimals=3,
        )
        for key in ('1', '2', '3')
    }

    cab_raw = raw.get('cabinetry')
    if not isinstance(cab_raw, dict):
        raise ValueError(f'{where}: cabinetry must be an object.')
    cab_multiplier = _decimal_str(
        cab_raw.get('multiplier'),
        where=where,
        field='cabinetry.multiplier',
        low=Decimal('1.000'),
        high=Decimal('3.000'),
        max_decimals=3,
        fixed_decimals=3,
    )
    cab_scope = cab_raw.get('scope')
    if cab_scope not in ('finished_only', 'all_cat3'):
        raise ValueError(f'{where}: cabinetry.scope must be "finished_only" or "all_cat3".')

    minimum_job_charge = _decimal_str(
        raw.get('minimum_job_charge', '0'),
        where=where,
        field='minimum_job_charge',
        low=Decimal('0'),
        high=Decimal('100000'),
        max_decimals=2,
    )

    overhead_profit_percent = _decimal_str(
        raw.get('overhead_profit_percent', '0'),
        where=where,
        field='overhead_profit_percent',
        low=Decimal('0'),
        high=Decimal('100'),
        max_decimals=2,
    )

    tax_raw = raw.get('sales_tax')
    if not isinstance(tax_raw, dict):
        raise ValueError(f'{where}: sales_tax must be an object.')
    tax_enabled = tax_raw.get('enabled')
    if not isinstance(tax_enabled, bool):
        raise ValueError(f'{where}: sales_tax.enabled must be a boolean.')
    tax_percent = _decimal_str(
        tax_raw.get('percent', '0'),
        where=where,
        field='sales_tax.percent',
        low=Decimal('0'),
        high=Decimal('15'),
        max_decimals=3,
    )

    show_line_breakdown = raw.get('show_line_breakdown', False)
    if not isinstance(show_line_breakdown, bool):
        raise ValueError(f'{where}: show_line_breakdown must be a boolean.')

    normalized = {
        'estimate_mode': estimate_mode,
        'area_basis': area_basis,
        'range': {
            'first_sf': first_sf,
            'first_percent': first_percent,
            'beyond_percent': beyond_percent,
        },
        'after_hours': {
            'multiplier': ah_multiplier,
            'label': ah_label,
        },
        'category_multipliers': category_multipliers,
        'cabinetry': {
            'multiplier': cab_multiplier,
            'scope': cab_scope,
        },
        'minimum_job_charge': minimum_job_charge,
        'overhead_profit_percent': overhead_profit_percent,
        'sales_tax': {
            'enabled': tax_enabled,
            'percent': tax_percent,
        },
        'show_line_breakdown': show_line_breakdown,
    }
    # Absent stays absent: an added key would change the hash of every stored table and pin.
    if raw.get('assist') is not None:
        normalized['assist'] = _normalize_assist(raw['assist'])
    if 'bracket_mode' in raw:
        if raw['bracket_mode'] not in ('tiered', 'whole-job'):
            raise ValueError('Settings: bracket_mode must be "tiered" or "whole-job".')
        normalized['bracket_mode'] = raw['bracket_mode']
    if 'brackets' in range_raw:
        normalized['range']['brackets'] = normalize_brackets(
            range_raw['brackets'], where='Settings: cushion', value_field='percent'
        )
    return normalized


def normalize_table(payload, *, publish: bool, acknowledgements=()) -> dict:
    """Validate and normalize a v2 table payload {'items': [...], 'policy': {...}}."""
    if not isinstance(payload, dict):
        raise ValueError('Settings: send items and policy.')
    items = normalize_items(
        payload.get('items'), publish=publish, acknowledgements=acknowledgements
    )
    policy = normalize_policy(payload.get('policy'))
    return {'items': items, 'policy': policy}


def locked_extras_problems(table: dict) -> list[dict]:
    """An enabled extras item cannot be published while priced extras are off."""
    return [
        {
            'item_id': item['item_id'],
            'message': (
                f'Row {item.get("code", item["item_id"])}: priced additional work is off for this '
                'company. Turn this item off before publishing.'
            ),
        }
        for item in table.get('items') or []
        if item.get('group') == 'extras' and item.get('enabled', True)
    ]


def publish_problems(table: dict, acknowledgements=(), *, extras_locked=False) -> list[dict]:
    """Return a list of problems that would prevent publishing a working-copy table."""
    problems: list[dict] = []
    acked = set(acknowledgements or ())
    items = table.get('items') or []
    priced_enabled = 0
    for item in items:
        item_id = item.get('item_id', '')
        code = item.get('code', item_id)
        if not item.get('enabled', True):
            continue
        price = item.get('unit_price', '')
        if any(band['unit_price'] == '' for band in item.get('price_brackets', [])):
            problems.append(
                {
                    'item_id': item_id,
                    'message': f'Row {code}: enter a unit price for each price bracket before publishing.',
                }
            )
            continue
        if price == '' and not item.get('price_brackets'):
            problems.append(
                {
                    'item_id': item_id,
                    'message': f'Row {code}: enter a unit price or disable the item before publishing.',
                }
            )
            continue
        priced_enabled += 1
        zero_price = any(
            band['unit_price'] != '' and Decimal(band['unit_price']) == 0
            for band in item.get('price_brackets', [])
        )
        if zero_price or (price != '' and Decimal(price) == 0):
            if not item.get('allow_zero'):
                problems.append(
                    {
                        'item_id': item_id,
                        'message': f'Row {code}: zero is not a valid unit price unless allow_zero is enabled.',
                    }
                )
            elif item_id not in acked and code not in acked:
                problems.append(
                    {
                        'item_id': item_id,
                        'message': f'Row {code}: confirm that a zero unit price for {item.get("name", code)} is intentional.',
                    }
                )
    if priced_enabled == 0:
        problems.append(
            {
                'item_id': 'policy.items',
                'message': 'Settings: at least one enabled item with a price is required to publish.',
            }
        )
    if extras_locked:
        problems.extend(locked_extras_problems(table))
    return problems


def content_hash(table: dict) -> str:
    """Canonical SHA-256 over calculation_version, currency, sorted items (including disabled) and policy."""
    normalized = normalize_table(table, publish=False)
    if not normalized['items']:
        raise ValueError('Settings: a published price table needs at least one item.')
    sorted_items = sorted(normalized['items'], key=lambda it: it['item_id'])
    payload = {
        'calculation_version': CALCULATION_VERSION,
        'currency': CURRENCY,
        'items': sorted_items,
        'policy': normalized['policy'],
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(',', ':')).encode('utf-8')
    return hashlib.sha256(encoded).hexdigest()


def rate_fingerprint(table: dict) -> str:
    """Fingerprint of the enabled extras item's rate, protecting approved extra quotes."""
    normalized = normalize_table(table, publish=False)
    for item in normalized['items']:
        if item['group'] == 'extras' and item['enabled'] and item['unit_price'] != '':
            token = f'extras:{item["item_id"]}:{item["unit_price"]}'
            return hashlib.sha256(token.encode('utf-8')).hexdigest()
    return hashlib.sha256(b'extras::').hexdigest()


_PUBLIC_ITEM_KEYS = (
    'item_id',
    'code',
    'group',
    'name',
    'customer_description',
    'unit',
    'quantity_source',
    'unit_price',
    'default_quantity',
    'waste_percent',
    'categories',
    'taxable',
    'xactimate_code',
    'sort_order',
)
_MANAGE_ITEM_KEYS = (*_PUBLIC_ITEM_KEYS, 'enabled', 'allow_zero')
_GROUP_RANK = {group: idx for idx, group in enumerate(GROUPS)}


# Re-export the table presentation and comparison API from its focused module.
try:
    from .price_table_comparison import (
        public_table,
        _V1_KEY_MAPPING,
        from_v1_rates,
        switch_differences,
        _POLICY_DIFF_PATHS,
        _LARGE_CHANGE_POLICY_FIELDS,
        _nested_get,
        _DIFF_ITEM_FIELDS,
        diff_tables,
        public_diff,
    )
except ImportError:
    from price_table_comparison import (
        public_table,
        _V1_KEY_MAPPING,
        from_v1_rates,
        switch_differences,
        _POLICY_DIFF_PATHS,
        _LARGE_CHANGE_POLICY_FIELDS,
        _nested_get,
        _DIFF_ITEM_FIELDS,
        diff_tables,
        public_diff,
    )
