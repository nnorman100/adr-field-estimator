"""Advisory warnings on an unsigned draft: server arithmetic over the sizing check, the pinned table
and the company's signed jobs. Derived on every read and never stored. They never reach a document,
a link or a model, and never change whether a job can be signed.
"""

from decimal import ROUND_HALF_UP, Decimal
from statistics import median

try:
    from .outcomes import room_area
    from .price_table import COUNT_DAYS_SOURCES, FIELD_SOURCES, parse_source
    from .pricing_v2 import EXTRAS_GROUP, price_scope
    from .sizing import number
except ImportError:
    from outcomes import room_area
    from price_table import COUNT_DAYS_SOURCES, FIELD_SOURCES, parse_source
    from pricing_v2 import EXTRAS_GROUP, price_scope
    from sizing import number

COMPARABLE_LOW = Decimal('2') / 3
COMPARABLE_HIGH = Decimal('1.5')
FAR_LOW = Decimal('0.5')
FAR_HIGH = Decimal('2')
MIN_JOBS = 5
RATIO = Decimal('0.1')
# Every job number a technician enters a quantity into. Day counts only multiply another count.
QUANTITY_FIELDS = (*FIELD_SOURCES, *sorted({count for count, _ in COUNT_DAYS_SOURCES}))
EXTRAS_TEXT = 'Additional work hours are only priced once the owner approves them.'


def _warning(code, text, room=''):
    return dict(code=code, text=text, room=room)


def _sizing_warnings(sizing):
    if sizing['status'] != 'available':
        return []
    found = []
    for name, check in (
        ('air_movers', sizing['air_movers']),
        ('dehumidifiers', sizing['dehumidifiers']),
    ):
        if check['flag'] in ('below', 'above'):
            found.append(_warning(f'{name}_{check["flag"]}', check['reason']))
    return found


def _wet_basis(table):
    return bool(table) and table['policy']['area_basis'] == 'wet_floor'


def _room_warnings(data, table):
    """Rooms with area whose category nothing on the table prices, as the engine would skip them."""
    sources = [
        item
        for item in table['items']
        if item['enabled']
        and (item['unit_price'] != '' or item.get('price_brackets'))
        and item['group'] != EXTRAS_GROUP
        and parse_source(item['quantity_source']).kind == 'room'
    ]
    wet = _wet_basis(table)
    found = []
    for room in data.rooms:
        if any(not item['categories'] or room.category in item['categories'] for item in sources):
            continue
        fields = room.model_dump(mode='json')
        area = room_area(fields, wet) or room_area(fields, not wet)
        if area:
            name = room.name.strip() or 'Unnamed room'
            found.append(
                _warning(
                    'unpriced_room',
                    f'{name}: {number(area)} sq ft of category {room.category} work prices nothing '
                    "on your company's price list.",
                    name,
                )
            )
    return found


def _no_item(quantity, name):
    text = f'{number(quantity)} {name.replace("_", " ")} entered, but your price list has no item for it.'
    return _warning('unpriced_quantity', text)


def _quantity_warnings(data, table, engine):
    """The server form of the phone's "Not in the current price list" list."""
    listed = set()
    for item in table['items']:
        if item['enabled']:
            source = parse_source(item['quantity_source'])
            listed |= {source.field, source.count_field}
    found = [
        _no_item(getattr(data, field), field)
        for field in QUANTITY_FIELDS
        if field not in listed and getattr(data, field) > 0
    ]
    for warning in engine:
        if warning['code'] == 'unknown_scope_item':
            entry = data.scope_items[warning['item_id']]
            quantity = entry.quantity or entry.count * entry.days
            if quantity:
                found.append(_no_item(quantity, warning['item_id']))
    return found


def _typical_warning(data, table, low, history):
    """How this job's low end compares with signed jobs of the same highest category and size."""
    if low is None or not history:
        return []
    category = max((room.category for room in data.rooms), default=1)
    wet = _wet_basis(table)
    area = sum(
        (room_area(room.model_dump(mode='json'), wet) for room in data.rooms),
        Decimal(0),
    )
    comparable = [
        Decimal(row['low'])
        for row in history
        if row['category'] == category
        and COMPARABLE_LOW * area <= Decimal(row['sf']) <= COMPARABLE_HIGH * area
    ]
    if len(comparable) < MIN_JOBS:
        return []
    typical = median(comparable)
    low = Decimal(str(low))
    if typical <= 0 or FAR_LOW * typical <= low <= FAR_HIGH * typical:
        return []
    ratio = (low / typical).quantize(RATIO, rounding=ROUND_HALF_UP)
    return [
        _warning(
            'far_from_typical',
            f"This estimate's low end is about {ratio}× your company's typical category {category} "
            f'job of this size ({len(comparable)} signed jobs). Check the quantities before you '
            'finish.',
        )
    ]


def warnings(data, sizing, table=None, priced=None, history=None):
    """Every warning for a draft. Pure.

    `table` is the pinned v2 table, None for a rate book or no pin. `priced` is the job's
    price_and_range result, None without a pin or when it prices nothing yet. `history` is the
    company's rows from `_estimate_history`, None or empty when it has none.
    """
    found = _sizing_warnings(sizing)
    if table:
        engine = price_scope(data, table)[1]
        found += _room_warnings(data, table)
        found += _quantity_warnings(data, table, engine)
        if any(warning['code'] == 'unpriced_extras_quantity' for warning in engine):
            found.append(_warning('unpriced_extras', EXTRAS_TEXT))
    found += _typical_warning(data, table, priced.low if priced else None, history)
    return found
