"""Price table presentation, v1 conversion, and comparison."""

import copy
from decimal import Decimal, ROUND_HALF_UP


def _table_module():
    # Resolve at call time so either module can be imported first.
    try:
        from . import price_table
    except ImportError:
        import price_table
    return price_table


def public_table(table: dict, *, manage: bool) -> dict:
    source = _table_module()
    normalize_table = source.normalize_table
    _MANAGE_ITEM_KEYS, _PUBLIC_ITEM_KEYS = source._MANAGE_ITEM_KEYS, source._PUBLIC_ITEM_KEYS
    _GROUP_RANK = source._GROUP_RANK
    """Filter items and fields for estimator/cache read vs owner management."""
    normalized = normalize_table(table, publish=False)
    keys = _MANAGE_ITEM_KEYS if manage else _PUBLIC_ITEM_KEYS
    ordered = sorted(
        normalized['items'],
        key=lambda it: (_GROUP_RANK.get(it['group'], 99), it['sort_order'], it['item_id']),
    )
    items = []
    for item in ordered:
        if not manage and not item['enabled']:
            continue
        items.append({k: copy.deepcopy(item[k]) for k in keys})
        if 'price_brackets' in item:
            items[-1]['price_brackets'] = copy.deepcopy(item['price_brackets'])
    return {
        'items': items,
        'policy': copy.deepcopy(normalized['policy']),
    }


_V1_KEY_MAPPING = {
    'demo_cat1_unfinished': ('demolition', 'sf', 'room:demolition:unfinished', [1], '0'),
    'demo_cat1_finished': ('demolition', 'sf', 'room:demolition:finished', [1], '0'),
    'demo_cat2_unfinished': ('demolition', 'sf', 'room:demolition:unfinished', [2], '0'),
    'demo_cat2_finished': ('demolition', 'sf', 'room:demolition:finished', [2], '0'),
    'demo_cat3_unfinished': ('demolition', 'sf', 'room:demolition:unfinished', [3], '0'),
    'demo_cat3_finished': ('demolition', 'sf', 'room:demolition:finished', [3], '0'),
    'emergency_call': ('job_charges', 'each', 'field:emergency_calls', [], '1'),
    'monitoring_hourly': ('job_charges', 'hour', 'field:monitoring_hours', [], '13.25'),
    'haul_pickup_load': ('job_charges', 'load', 'field:haul_loads', [], '1'),
    'air_scrubber_daily': ('job_charges', 'day', 'field:air_scrubbers', [], '1'),
    'hepa_filter': ('job_charges', 'each', 'field:hepa_filters', [], '1'),
    'matterport_scan': ('optional_services', 'each', 'field:matterport_scans', [], '0'),
    'dump_truck_load': ('optional_services', 'each', 'field:dump_truck_loads', [], '0'),
    'equipment_decontamination': ('optional_services', 'each', 'field:equipment_decon', [], '0'),
    'power_distribution': ('optional_services', 'each', 'field:power_distribution', [], '0'),
    'air_mover_daily': (
        'drying_equipment',
        'unit_day',
        'count_days:air_movers*drying_days',
        [],
        '0',
    ),
    'dehumidifier_daily': (
        'drying_equipment',
        'unit_day',
        'count_days:dehumidifiers*drying_days',
        [],
        '0',
    ),
    'wood_floor_daily': (
        'drying_equipment',
        'unit_day',
        'count_days:wood_floor_systems*wood_floor_days',
        [],
        '0',
    ),
    'sheet_labor_hourly': ('labor', 'hour', 'field:labor_hours', [], '0'),
    'after_hours_job_charge': ('job_charges', 'each', 'after_hours', [], '0'),
    'additional_work_hourly': ('extras', 'hour', 'typed', [], '0'),
}


def from_v1_rates(rates: dict[str, str]) -> dict:
    """Map the 21 v1 rate keys to a v2 table with equivalent policy settings."""
    table = _table_module()
    price_books, _default_code = table.price_books, table._default_code
    DEFAULT_AFTER_HOURS_LABEL, DEFAULT_ASSIST = (
        table.DEFAULT_AFTER_HOURS_LABEL,
        table.DEFAULT_ASSIST,
    )
    normalize_table = table.normalize_table
    if not isinstance(rates, dict):
        raise ValueError('Provide a v1 rates mapping.')
    group_counts: dict[str, int] = {}
    items = []
    for v1_item in price_books.ITEMS:
        key = v1_item['key']
        if key not in rates:
            raise ValueError(f'Missing v1 rate key "{key}".')
        group, unit, src, cats, default_qty = _V1_KEY_MAPPING[key]
        order = group_counts.get(group, 0)
        group_counts[group] = order + 1
        raw_price = str(rates[key]).strip()
        enabled = raw_price != ''
        items.append(
            {
                'item_id': key,
                'code': _default_code(key),
                'group': group,
                'name': v1_item['description'],
                'customer_description': '',
                'unit': unit,
                'quantity_source': src,
                'unit_price': raw_price if enabled else '',
                'allow_zero': bool(v1_item.get('allow_zero', False)),
                'default_quantity': default_qty,
                'waste_percent': '0',
                'categories': list(cats),
                'taxable': False,
                'xactimate_code': '',
                'enabled': enabled,
                'sort_order': order,
            }
        )
    policy = {
        'estimate_mode': 'range',
        'area_basis': 'demolition',
        'range': {
            'first_sf': 1000,
            'first_percent': '50',
            'beyond_percent': '20',
        },
        'after_hours': {
            'multiplier': '1.200',
            'label': DEFAULT_AFTER_HOURS_LABEL,
        },
        'category_multipliers': {
            '1': '1.000',
            '2': '1.000',
            '3': '1.000',
        },
        'cabinetry': {
            'multiplier': '2.000',
            'scope': 'finished_only',
        },
        'minimum_job_charge': '0',
        'overhead_profit_percent': '0',
        'sales_tax': {
            'enabled': False,
            'percent': '0',
        },
        'show_line_breakdown': False,
        # The cushion, so the switched table's range matches the rate book it replaces.
        'assist': copy.deepcopy(DEFAULT_ASSIST),
    }
    return normalize_table({'items': items, 'policy': policy}, publish=False)


def switch_differences(policy: dict) -> list[str]:
    """Where a table prices the same job differently from the rate book it replaces, in plain words."""
    table = _table_module()
    assist_of, bracket_mode_of = table.assist_of, table.bracket_mode_of
    cushion_brackets_of = table.cushion_brackets_of
    after_hours = Decimal(policy['after_hours']['multiplier'])
    range_rule = policy['range']
    first_sf = f'{range_rule["first_sf"]:,}'
    percent = (after_hours - 1) * 100
    late = (
        f'The after-hours {percent.normalize():f}% now prints as its own line inside the itemized '
        'total. Before, it was left out of the itemized total.'
        if after_hours > 1
        else 'After-hours work has no percentage on this table. Before, it added 20% to labor '
        'and materials in the customer range.'
    )
    if policy['estimate_mode'] == 'single':
        return [
            'The estimate is one price, the itemized total. Before, it was a low to high range.',
            late,
        ]
    assist = assist_of(policy)
    if assist['range_method'] == 'uncertainty':
        extra = assist['extra_drying_days']
        percents = ' / '.join(
            f'{Decimal(assist["hidden_damage_percent"][key]).normalize():f}%' for key in '123'
        )
        days = f'{extra} extra drying day' + ('' if extra == 1 else 's')
        return [
            f'The high end is built from the IICRC equipment range, {days} and hidden damage of '
            f'{percents} by category instead of a flat 50% cushion.',
            "Labor hours carry the hidden-damage percent of the job's rooms at every job size.",
            late,
        ]
    if 'brackets' in range_rule or bracket_mode_of(policy) == 'whole-job':
        if bracket_mode_of(policy) == 'whole-job':
            return [
                "The high end uses one whole-job cushion selected by the job's total square feet "
                'before waste: each room once at the largest area figure its priced square-foot '
                'items use (finished plus unfinished demolition is one figure), plus square feet '
                'typed without a room. '
                'A larger job may cost less when it crosses '
                'a bracket boundary.',
                'Labor hours carry the same selected cushion as the area-priced work.',
                late,
            ]
        return [
            "The high end uses the owner's tiered cushion brackets, highest-priced square feet first, "
            'with each percentage applied only to its band of area-priced work.',
            f'Labor hours carry {cushion_brackets_of(policy)[0]["percent"]}% on the high end at every job size.',
            late,
        ]
    return [
        f'The high end now tapers above {first_sf} square feet instead of stepping down at 1,001: '
        f'{range_rule["first_percent"]}% on the first {first_sf} square feet of area-priced work, '
        f'highest-priced areas first, and {range_rule["beyond_percent"]}% beyond that.',
        f'Labor hours carry {range_rule["first_percent"]}% on the high end at every job size. '
        'Before, they dropped to 20% on jobs above 1,000 square feet.',
        late,
    ]


_POLICY_DIFF_PATHS = (
    ('bracket_mode', ('bracket_mode',)),
    ('range.brackets', ('range', 'brackets')),
    ('estimate_mode', ('estimate_mode',)),
    ('area_basis', ('area_basis',)),
    ('range.first_sf', ('range', 'first_sf')),
    ('range.first_percent', ('range', 'first_percent')),
    ('range.beyond_percent', ('range', 'beyond_percent')),
    ('after_hours.multiplier', ('after_hours', 'multiplier')),
    ('after_hours.label', ('after_hours', 'label')),
    ('category_multipliers.1', ('category_multipliers', '1')),
    ('category_multipliers.2', ('category_multipliers', '2')),
    ('category_multipliers.3', ('category_multipliers', '3')),
    ('cabinetry.multiplier', ('cabinetry', 'multiplier')),
    ('cabinetry.scope', ('cabinetry', 'scope')),
    ('minimum_job_charge', ('minimum_job_charge',)),
    ('overhead_profit_percent', ('overhead_profit_percent',)),
    ('sales_tax.enabled', ('sales_tax', 'enabled')),
    ('sales_tax.percent', ('sales_tax', 'percent')),
    ('show_line_breakdown', ('show_line_breakdown',)),
    ('assist.drying_days', ('assist', 'drying_days')),
    ('assist.range_method', ('assist', 'range_method')),
    ('assist.extra_drying_days', ('assist', 'extra_drying_days')),
    ('assist.hidden_damage_percent.1', ('assist', 'hidden_damage_percent', '1')),
    ('assist.hidden_damage_percent.2', ('assist', 'hidden_damage_percent', '2')),
    ('assist.hidden_damage_percent.3', ('assist', 'hidden_damage_percent', '3')),
)

_LARGE_CHANGE_POLICY_FIELDS = {
    'range.first_sf',
    'range.first_percent',
    'range.beyond_percent',
    'after_hours.multiplier',
    'category_multipliers.1',
    'category_multipliers.2',
    'category_multipliers.3',
    'cabinetry.multiplier',
    'minimum_job_charge',
    'overhead_profit_percent',
    'sales_tax.percent',
    'assist.drying_days',
    'assist.range_method',
    'assist.extra_drying_days',
    'assist.hidden_damage_percent.1',
    'assist.hidden_damage_percent.2',
    'assist.hidden_damage_percent.3',
}


def _nested_get(mapping: dict, path: tuple[str, ...]):
    cur = mapping
    for part in path:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(part)
    return cur


_DIFF_ITEM_FIELDS = (
    'enabled',
    'unit_price',
    'name',
    'customer_description',
    'code',
    'group',
    'unit',
    'quantity_source',
    'default_quantity',
    'waste_percent',
    'categories',
    'taxable',
    'allow_zero',
    'xactimate_code',
    'sort_order',
)


def diff_tables(before: dict | None, after: dict) -> tuple[dict, list[str]]:
    """Compute item and policy changes plus warning codes between two v2 tables."""
    table = _table_module()
    normalize_table, assist_of = table.normalize_table, table.assist_of
    DEFAULT_POLICY, STARTER_ASSIST = table.DEFAULT_POLICY, table.STARTER_ASSIST
    after_norm = normalize_table(after, publish=False)
    if before is None or not before.get('items'):
        before_items: dict[str, dict] = {}
        before_policy = copy.deepcopy(DEFAULT_POLICY)
        # A first table starts from the starter's settings, so only what the owner moved is listed.
        if 'assist' in after_norm['policy']:
            before_policy['assist'] = copy.deepcopy(STARTER_ASSIST)
    else:
        before_norm = normalize_table(before, publish=False)
        before_items = {it['item_id']: it for it in before_norm['items']}
        before_policy = before_norm['policy']

    after_items = {it['item_id']: it for it in after_norm['items']}
    item_diffs: list[dict] = []
    warning_set: set[str] = set()

    for item_id, after_it in after_items.items():
        zero_price = (after_it['unit_price'] != '' and Decimal(after_it['unit_price']) == 0) or any(
            band['unit_price'] != '' and Decimal(band['unit_price']) == 0
            for band in after_it.get('price_brackets', [])
        )
        if after_it['enabled'] and zero_price:
            warning_set.add('zero_price')
        before_it = before_items.get(item_id)
        if before_it is None:
            row_warnings: list[str] = []
            if after_it['enabled'] and zero_price:
                row_warnings.append('zero_price')
            item_diffs.append(
                {
                    'item_id': item_id,
                    'name': after_it['name'],
                    'group': after_it['group'],
                    'unit': after_it['unit'],
                    'change': 'added',
                    'before': None,
                    'after': after_it['unit_price'],
                    'percent': None,
                    'warnings': row_warnings,
                    'enabled': after_it['enabled'],
                }
            )
            if after_it.get('price_brackets'):
                item_diffs[-1]['fields'] = [
                    {'field': 'price_brackets', 'before': None, 'after': after_it['price_brackets']}
                ]
            continue

        if before_it == after_it:
            continue

        row_warnings = []
        percent = None
        if before_it['enabled'] != after_it['enabled']:
            change = 'enabled'
            if not after_it['enabled']:
                warning_set.add('disabled_items')
                row_warnings.append('disabled_items')
        elif before_it['unit_price'] != after_it['unit_price']:
            change = 'price'
        else:
            change = 'fields'

        if (
            before_it['unit_price'] != ''
            and after_it['unit_price'] != ''
            and before_it['unit_price'] != after_it['unit_price']
        ):
            old_p = Decimal(before_it['unit_price'])
            new_p = Decimal(after_it['unit_price'])
            large = True
            if old_p > 0:
                pct = (new_p - old_p) / old_p * Decimal(100)
                percent = f'{pct.quantize(Decimal("0.1"), rounding=ROUND_HALF_UP):.1f}'
                large = abs(pct) >= Decimal('50')
            if large:
                warning_set.add('large_change')
                row_warnings.append('large_change')

        if before_it['taxable'] != after_it['taxable']:
            warning_set.add('tax_change')
        if after_it['enabled'] and zero_price:
            row_warnings.append('zero_price')

        item_diffs.append(
            {
                'item_id': item_id,
                'name': after_it['name'],
                'group': after_it['group'],
                'unit': after_it['unit'],
                'change': change,
                'before': before_it['unit_price'],
                'after': after_it['unit_price'],
                'percent': percent,
                'warnings': row_warnings,
                'fields': [
                    {'field': key, 'before': before_it.get(key), 'after': after_it.get(key)}
                    # Required legacy fields plus optional schedules (absent on old tables).
                    for key in (*_DIFF_ITEM_FIELDS, 'price_brackets')
                    if before_it.get(key) != after_it.get(key)
                ],
            }
        )

    for item_id, before_it in before_items.items():
        if item_id not in after_items:
            warning_set.add('disabled_items')
            item_diffs.append(
                {
                    'item_id': item_id,
                    'name': before_it['name'],
                    'group': before_it['group'],
                    'unit': before_it['unit'],
                    'change': 'removed',
                    'before': before_it['unit_price'],
                    'after': None,
                    'percent': None,
                    'warnings': ['disabled_items'],
                }
            )

    policy_diffs: list[dict] = []
    # Both sides read through assist_of: adding the map at its absent values is no change.
    before_policy = {**before_policy, 'assist': assist_of(before_policy)}
    after_policy = {**after_norm['policy'], 'assist': assist_of(after_norm['policy'])}
    for label, path in _POLICY_DIFF_PATHS:
        old_val = _nested_get(before_policy, path)
        new_val = _nested_get(after_policy, path)
        if old_val != new_val:
            policy_diffs.append({'field': label, 'before': old_val, 'after': new_val})
            if label in _LARGE_CHANGE_POLICY_FIELDS:
                warning_set.add('large_change')
            if label == 'estimate_mode':
                warning_set.add('mode_change')
            if label.startswith('sales_tax.'):
                warning_set.add('tax_change')

    ordered_warnings = [
        code
        for code in ('large_change', 'zero_price', 'disabled_items', 'mode_change', 'tax_change')
        if code in warning_set
    ]
    return {'items': item_diffs, 'policy': policy_diffs}, ordered_warnings


def public_diff(before: dict | None, after: dict) -> tuple[dict, list[str]]:
    """The diff a price reader may see: only items enabled in the version shown."""
    _PUBLIC_ITEM_KEYS = _table_module()._PUBLIC_ITEM_KEYS

    def enabled(table):
        return {
            'items': [item for item in table['items'] if item['enabled']],
            'policy': table['policy'],
        }

    diff, warnings = diff_tables(enabled(before) if before else None, enabled(after))
    rows = []
    for row in diff['items']:
        if row['change'] == 'removed':
            continue
        if 'fields' in row:
            shown = [
                field
                for field in row['fields']
                if field['field'] in (*_PUBLIC_ITEM_KEYS, 'price_brackets')
            ]
            if not shown:
                continue
            row = {**row, 'fields': shown}
        rows.append(row)
    return {**diff, 'items': rows}, [code for code in warnings if code != 'disabled_items']
