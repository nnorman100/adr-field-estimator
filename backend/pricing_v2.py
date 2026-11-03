"""Calculation dryscope-v2: prices a job from the owner-defined table pinned to it.

Pure Decimal functions with no I/O. docs/pricing-source.md states the formulas and why the
high end tapers over the most expensive square feet: that is what keeps both totals from
dropping when work is added.
"""

from decimal import Decimal, ROUND_HALF_UP

try:
    from .price_table import (
        BUCKET_OF_GROUP,
        COUNT_DAYS_SOURCES,
        DEFAULT_AFTER_HOURS_LABEL,
        FIELD_SOURCES,
        GROUPS,
        parse_source,
    )
except ImportError:
    from price_table import (
        BUCKET_OF_GROUP,
        COUNT_DAYS_SOURCES,
        DEFAULT_AFTER_HOURS_LABEL,
        FIELD_SOURCES,
        GROUPS,
        parse_source,
    )

CENT = Decimal('0.01')
HUNDRED = Decimal(100)
ZERO = Decimal(0)
ONE = Decimal(1)
BUCKETS = frozenset(BUCKET_OF_GROUP.values())
EXTRA_CODE = 'EXTRA'
EXTRAS_GROUP = 'extras'
MINIMUM_CHARGE_LABEL = 'Minimum job charge'
ZERO_TOTAL = 'The priced scope totals $0.00. Enter at least one quantity or room measurement before auditing.'
ROOM_FIELDS = frozenset(('unfinished_sf', 'finished_sf', 'wet_floor_sf', 'floor_sf'))
# Job numbers an estimator can override: every number a quantity source reads.
JOB_FIELDS = frozenset(FIELD_SOURCES).union(*COUNT_DAYS_SOURCES)
SAMPLE_NOTICE = 'Sample job only. This does not price a saved job.'
# Every job number is stated, so a table's default_quantity never reaches a sample.
_SAMPLE_BASE = dict(
    emergency_calls=0,
    monitoring_hours=0,
    haul_loads=0,
    air_scrubbers=0,
    hepa_filters=0,
    matterport_scans=0,
    dump_truck_loads=0,
    equipment_decon=0,
    power_distribution=0,
    labor_hours=0,
    wood_floor_systems=0,
    wood_floor_days=1,
)
SAMPLE_JOBS = (
    {
        'key': 'small',
        'label': 'Clean-water kitchen leak',
        'description': '250 sq ft of category 1 demolition with 4 air movers and 1 dehumidifier for 3 days.',
        'notice': SAMPLE_NOTICE,
        'data': dict(
            _SAMPLE_BASE,
            rooms=[
                dict(
                    name='Kitchen',
                    category=1,
                    finished_sf=150,
                    unfinished_sf=100,
                    floor_sf=200,
                    wet_floor_sf=150,
                )
            ],
            air_movers=4,
            dehumidifiers=1,
            drying_days=3,
            emergency_calls=1,
            haul_loads=1,
        ),
    },
    {
        'key': 'medium',
        'label': 'Gray-water main floor',
        'description': '1,000 sq ft of category 2 demolition with 8 air movers and 2 dehumidifiers for 4 days and 4 labor hours.',
        'notice': SAMPLE_NOTICE,
        'data': dict(
            _SAMPLE_BASE,
            rooms=[
                dict(
                    name='Main floor',
                    category=2,
                    finished_sf=1000,
                    floor_sf=1200,
                    wet_floor_sf=1000,
                )
            ],
            air_movers=8,
            dehumidifiers=2,
            drying_days=4,
            labor_hours=4,
        ),
    },
    {
        'key': 'large',
        'label': 'Mold remediation, after hours',
        'description': '2,500 sq ft of category 3 demolition in two rooms, one with custom cabinetry, with 10 air movers and 3 dehumidifiers for 5 days and 8 labor hours, after hours.',
        'notice': SAMPLE_NOTICE,
        'data': dict(
            _SAMPLE_BASE,
            rooms=[
                dict(
                    name='Kitchen',
                    category=3,
                    finished_sf=800,
                    unfinished_sf=200,
                    custom_cabinetry=True,
                ),
                dict(name='Lower level', category=3, finished_sf=1200, unfinished_sf=300),
            ],
            air_movers=10,
            dehumidifiers=3,
            drying_days=5,
            labor_hours=8,
            is_after_hours=True,
        ),
    },
)

_GROUP_RANK = {group: rank for rank, group in enumerate(GROUPS)}


def _money(value):
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


def _dec(value):
    return Decimal(str(value))


def _percent_text(value):
    return format(Decimal(value).normalize(), 'f')


def _room_key(name):
    # Compared as distinct_rooms and the app's roomKey compare room names.
    return ' '.join(name.split()).lower()


def _bucket(group, code):
    bucket = BUCKET_OF_GROUP.get(group)
    if bucket is None:
        raise RuntimeError(f'Priced codes missing from the estimate range: {code} ({group})')
    return bucket


def _overrides(data, warnings):
    """Estimator-entered quantities by job field and by (room key, room field)."""
    job, rooms = {}, {}
    room_keys = {_room_key(room.name) for room in data.rooms}
    for key, override in (data.quantity_overrides or {}).items():
        entered = _dec(override.entered)
        if key in JOB_FIELDS:
            job[key] = entered
            continue
        name, _, field = key.rpartition(':')
        if field in ROOM_FIELDS and _room_key(name) in room_keys:
            rooms[(_room_key(name), field)] = entered
        else:
            warnings.append(dict(code='unknown_quantity_override', key=key))
    return job, rooms


def _room_quantity(room, source, policy, overrides):
    def read(field):
        value = getattr(room, field)
        if value is None:
            return None
        entered = overrides.get((_room_key(room.name), field))
        return entered if entered is not None else _dec(value)

    def wet_floor():
        wet = read('wet_floor_sf')
        if wet is not None:
            return wet
        return read('floor_sf') or ZERO

    if source.field == 'basis':
        if policy['area_basis'] == 'wet_floor':
            return wet_floor()
        return read('unfinished_sf') + read('finished_sf')
    if source.field == 'wet_floor_sf':
        return wet_floor()
    return read(source.field) or ZERO


def _job_quantity(item, source, data, overrides):
    def read(*fields):
        quantity = ONE
        for field in fields:
            if field in overrides:
                quantity *= overrides[field]
            elif field in data.model_fields_set:
                quantity *= _dec(getattr(data, field))
            else:
                return Decimal(item['default_quantity'])
        return quantity

    if source.kind == 'field':
        return read(source.field)
    if source.kind == 'count_days':
        return read(source.count_field, source.days_field)
    if source.kind == 'after_hours':
        return ONE if data.is_after_hours else ZERO
    entry = (data.scope_items or {}).get(item['item_id'])
    if source.kind == 'typed':
        return Decimal(item['default_quantity']) if entry is None else _dec(entry.quantity)
    if source.kind == 'typed_count_days':
        return ZERO if entry is None else Decimal(entry.count * entry.days)
    raise RuntimeError(f'Unknown quantity source kind: {source.kind}')


def _has_unpriced_quantity(item, data):
    entry = (data.scope_items or {}).get(item['item_id'])
    return Decimal(item['default_quantity']) > 0 or (entry is not None and entry.quantity > 0)


def _line(item, description, quantity, price, waste, room=None, area=None):
    total = _money(quantity * price * (1 + waste / HUNDRED))
    return dict(
        code=item['code'],
        item_id=item['item_id'],
        group=item['group'],
        bucket=_bucket(item['group'], item['code']),
        description=description,
        quantity=float(quantity),
        unit=item['unit'],
        unit_price=float(price),
        waste_percent=float(waste),
        total=float(total),
        taxable=item['taxable'],
        xactimate_code=item['xactimate_code'],
        room=room,
        area=area,
    )


def _room_lines(item, source, data, policy, overrides, warnings):
    lines = []
    label = item['customer_description'] or item['name']
    cabinetry = policy['cabinetry']
    for room in data.rooms:
        if item['categories'] and room.category not in item['categories']:
            continue
        quantity = _room_quantity(room, source, policy, overrides)
        if not quantity:
            warnings.append(dict(code='missing_area', item_id=item['item_id'], room=room.name))
            continue
        price = Decimal(item['unit_price']) * Decimal(
            policy['category_multipliers'][str(room.category)]
        )
        if (
            room.category == 3
            and room.custom_cabinetry
            and (source.finish == 'finished' or cabinetry['scope'] == 'all_cat3')
        ):
            price *= Decimal(cabinetry['multiplier'])
        waste = (
            _dec(room.waste_percent) if room.waste_percent > 0 else Decimal(item['waste_percent'])
        )
        lines.append(
            _line(
                item,
                f'{room.name}: {label}',
                quantity,
                price,
                waste,
                room=room.name,
                area=float(quantity),
            )
        )
    return lines


def price_scope(data, table):
    """(lines, warnings) for a job and a table holding `items` and `policy`."""
    policy = table['policy']
    warnings = []
    job_overrides, room_overrides = _overrides(data, warnings)
    known = {item['item_id'] for item in table['items']}
    for key in data.scope_items or {}:
        if key not in known:
            warnings.append(dict(code='unknown_scope_item', item_id=key))
    categories = {room.category for room in data.rooms}
    lines = []
    enabled = (item for item in table['items'] if item['enabled'])
    extras_taxable = False
    for item in sorted(
        enabled, key=lambda row: (_GROUP_RANK.get(row['group'], len(GROUPS)), row['sort_order'])
    ):
        if item['group'] == EXTRAS_GROUP:
            extras_taxable = item['taxable']
            if _has_unpriced_quantity(item, data):
                warnings.append(dict(code='unpriced_extras_quantity', item_id=item['item_id']))
        if item['unit_price'] == '':
            warnings.append(dict(code='blank_price_item', item_id=item['item_id']))
            continue
        # The extras item only supplies the rate an owner approves work at (extras.rate_for).
        # Pricing it by quantity would let unapproved hours into the total.
        if item['group'] == EXTRAS_GROUP:
            continue
        source = parse_source(item['quantity_source'])
        if source.kind == 'room':
            lines += _room_lines(item, source, data, policy, room_overrides, warnings)
            continue
        if item['categories'] and not categories.intersection(item['categories']):
            continue
        quantity = _job_quantity(item, source, data, job_overrides)
        if quantity:
            lines.append(
                _line(
                    item,
                    item['customer_description'] or item['name'],
                    quantity,
                    Decimal(item['unit_price']),
                    Decimal(item['waste_percent']),
                )
            )
    for extra in data.extras:
        if extra.approval:
            total = _money(_dec(extra.hours) * _dec(extra.approval.rate))
            lines.append(
                dict(
                    code=EXTRA_CODE,
                    item_id=None,
                    group=EXTRAS_GROUP,
                    bucket=_bucket(EXTRAS_GROUP, EXTRA_CODE),
                    description=extra.description,
                    quantity=float(extra.hours),
                    unit='hour',
                    unit_price=float(extra.approval.rate),
                    waste_percent=0.0,
                    total=float(total),
                    taxable=extras_taxable,
                    xactimate_code='',
                    room=None,
                    area=None,
                )
            )
    return lines, warnings


def _top_dollars(area_lines, first_sf):
    """The dollars of the first_sf most expensive square feet. Exact, never rounded on its own."""
    if sum(area for _, area in area_lines) <= first_sf:
        return sum((total for total, _ in area_lines), ZERO)
    remaining, dollars = first_sf, ZERO
    for total, area in sorted(area_lines, key=lambda pair: pair[0] / pair[1], reverse=True):
        take = min(remaining, area)
        dollars += total if take == area else total * take / area
        remaining -= take
        if not remaining:
            break
    return dollars


def _sum(lines, bucket, *, taxable=False):
    return sum(
        (
            _dec(line['total'])
            for line in lines
            if line['bucket'] == bucket and (line['taxable'] or not taxable)
        ),
        ZERO,
    )


def totals(data, lines, policy):
    """The low and high ends of an estimate. Every summary amount is rounded once, to cents."""
    unbucketed = sorted({str(line['code']) for line in lines if line['bucket'] not in BUCKETS})
    if unbucketed:
        # A priced line outside every bucket would count in the itemized list but vanish from the range.
        raise RuntimeError(f'Priced codes missing from the estimate range: {unbucketed}')

    fixed, equipment = _sum(lines, 'fixed'), _sum(lines, 'equipment')
    labor_material = [line for line in lines if line['bucket'] == 'labor_material']
    area_lines = [
        (_dec(line['total']), _dec(line['area'])) for line in labor_material if line['area']
    ]
    area_dollars = sum((total for total, _ in area_lines), ZERO)
    other_dollars = sum((_dec(line['total']) for line in labor_material if not line['area']), ZERO)
    low_lm = area_dollars + other_dollars
    # Checked before the minimum, so a minimum never turns an empty job into a signable one.
    if fixed + equipment + low_lm <= 0:
        raise ValueError(ZERO_TOTAL)

    tier = policy['range']
    first, beyond = (
        Decimal(tier['first_percent']) / HUNDRED,
        Decimal(tier['beyond_percent']) / HUNDRED,
    )
    top = _top_dollars(area_lines, Decimal(tier['first_sf']))
    high_lm = _money(
        (1 + beyond) * area_dollars + (first - beyond) * top + (1 + first) * other_dollars
    )

    multiplier = Decimal(policy['after_hours']['multiplier']) if data.is_after_hours else ONE
    overhead = Decimal(policy['overhead_profit_percent']) / HUNDRED
    tax_rate = (
        Decimal(policy['sales_tax']['percent']) / HUNDRED
        if policy['sales_tax']['enabled']
        else ZERO
    )
    minimum = Decimal(policy['minimum_job_charge'])
    taxed_fixed_equipment = _sum(lines, 'fixed', taxable=True) + _sum(
        lines, 'equipment', taxable=True
    )
    taxed_lm = _sum(lines, 'labor_material', taxable=True)

    def pre_minimum(lm):
        return fixed + equipment + lm + _money(lm * (multiplier - 1))

    def end(lm):
        subtotal = fixed + equipment + lm
        adjustment = _money(lm * (multiplier - 1))
        floor = max(ZERO, minimum - (subtotal + adjustment))
        overhead_profit = _money(overhead * (subtotal + adjustment + floor))
        # High taxes labor and materials in the same proportion as low. Overhead and profit comes
        # before tax, so taxable items carry their own share of it; the minimum is not a taxable item.
        share = taxed_lm * lm / low_lm if low_lm else ZERO
        tax = _money(tax_rate * (taxed_fixed_equipment + multiplier * share) * (1 + overhead))
        return dict(
            subtotal=subtotal,
            after_hours=adjustment,
            minimum_charge=floor,
            overhead_profit=overhead_profit,
            tax=tax,
            total=subtotal + adjustment + floor + overhead_profit + tax,
        )

    low = end(low_lm)
    mode = policy['estimate_mode']
    high = None
    if mode == 'range':
        # While the cushioned amount is still under the minimum the job is the minimum at both ends.
        # Flooring the high separately would let added non-taxable work shrink its taxable share and
        # lower the total with nothing to offset it.
        high = dict(low) if pre_minimum(high_lm) < minimum else end(high_lm)
    return dict(
        mode=mode,
        low=low,
        high=high,
        labor_material_low=low_lm,
        labor_material_high=high_lm,
        after_hours_label=policy['after_hours']['label'],
        minimum_charge_label=MINIMUM_CHARGE_LABEL,
        explanation=explanation(policy, data),
        range_explanation=range_explanation(policy),
    )


def range_explanation(policy):
    """One plain sentence naming the cushion tiers, for the documents. None when there is no range."""
    if policy['estimate_mode'] != 'range':
        return None
    tier = policy['range']
    first, beyond = Decimal(tier['first_percent']), Decimal(tier['beyond_percent'])
    if not first:
        return None
    if first == beyond:
        return f'The high end allows {_percent_text(first)}% extra on the work, for hidden damage.'
    tail = f' and {_percent_text(beyond)}% beyond' if beyond else ''
    return (
        f'The high end allows {_percent_text(first)}% extra on the first {tier["first_sf"]:,} sq ft '
        f'of work{tail}, for hidden damage.'
    )


def explanation(policy, data):
    """The plain-language explanation printed under the amounts, from the pinned policy."""
    if policy['estimate_mode'] == 'single':
        return 'The price covers the itemized scope below.'
    return ' '.join(_range_sentences(policy, data))


def _range_sentences(policy, data):
    tier = policy['range']
    first, beyond = _percent_text(tier['first_percent']), _percent_text(tier['beyond_percent'])
    sentences = [
        'The low amount is the itemized total.',
        'The high amount adds an allowance to labor and materials for conditions found during the '
        f'work: {first}% on the first {tier["first_sf"]:,} square feet of area-priced work '
        f'(highest-priced areas first), {beyond}% on area beyond that, and {first}% on labor hours.',
        'Job charges, drying equipment and approved additional work are the same in both amounts.',
    ]
    multiplier = Decimal(policy['after_hours']['multiplier'])
    if data.is_after_hours and multiplier > 1:
        percent = _percent_text((multiplier - 1) * HUNDRED)
        label = policy['after_hours']['label']
        named = 'an after-hours adjustment' if label == DEFAULT_AFTER_HOURS_LABEL else f'"{label}"'
        sentences.append(f'Both amounts include {named} of {percent}% of labor and materials.')
    overhead = Decimal(policy['overhead_profit_percent'])
    if overhead:
        sentences.append(f'Both amounts include overhead and profit at {_percent_text(overhead)}%.')
    tax = Decimal(policy['sales_tax']['percent'])
    if policy['sales_tax']['enabled'] and tax:
        share = ' and their share of overhead and profit' if overhead else ''
        sentences.append(
            f'Sales tax at {_percent_text(tax)}% applies to the items marked taxable{share}.'
        )
    return sentences
