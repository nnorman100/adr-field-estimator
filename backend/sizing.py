"""IICRC drying-equipment sizing check: recommended air movers and dehumidification beside the
technician's counts. It never changes counts or prices; pricing reads only the entered counts.

Sources for the arithmetic (inputs are only technician-confirmed room values; nothing is guessed):

- Air movers, ANSI/IICRC S500 initial air mover placement (2015 edition, section 13.5.6.1, as
  explained by S500 consensus body member Brandon Burton, "ANSI/IICRC S500 Consensus Body member
  explains airmover updates", Cleanfax, 2016; restated in DocuSketch's "How to Perform IICRC Air
  Mover Calculations Correctly"; IICRC "US Imperial Airmover and Gallons Calculations Worksheet",
  7.1.22): one air mover per affected room, plus one per 70 (minimum) to 50 (maximum) square feet
  of wet floor, each fraction rounded up per room. Burton's example: 140 SF of wet floor gives 2
  to 3 more air movers. DocuSketch adds that one air mover may be adequate for a room under 25 SF.
  The wet floor area defaults to the room's floor area until the technician enters a smaller one. The same guidance adds one per 150 to 100 SF of wet wall above
  2 ft and ceiling, and one per wall offset over 18 in; the app does not collect those areas, so
  the range here is floor-based and the reasons say so.
- Dehumidification, IICRC "Initial Dehumidification Recommendation Factors and Formulas"
  (Imperial, revision 3.1.22): cubic feet / chart factor = total pints per day (AHAM), and total
  pints per day / unit AHAM rating = number of dehumidifiers. The Low Grain Refrigerant (LGR) row
  is used because the sheet prices commercial LGR units: class 1 = 100, class 2 = 50,
  class 3 = 40, class 4 = 40. Room demand stays unrounded until the job total, which is rounded
  up once, so several small rooms do not each add a fraction of a unit.
"""

from decimal import Decimal, ROUND_CEILING, ROUND_HALF_UP

AIR_MOVER_FLOOR_SF = (Decimal(70), Decimal(50))
SMALL_ROOM_SF = Decimal(25)
LGR_FACTORS = {1: 100, 2: 50, 3: 40, 4: 40}
# Required inputs; the optional wet_floor_sf defaults to floor_sf.
INPUTS = [
    ('floor_sf', 'floor area'),
    ('ceiling_height_ft', 'ceiling height'),
    ('water_class', 'water class'),
]
WALLS_NOTE = (
    'Wet walls above 2 feet, wet ceilings and wall offsets over 18 inches add air movers and are '
    'not part of this floor-based range.'
)


def up(value):
    return int(value.to_integral_value(rounding=ROUND_CEILING))


def tenths(value):
    return value.quantize(Decimal('0.1'), rounding=ROUND_HALF_UP)


def room_ppd(check):
    # The exact demand of one room; cubic_feet round-trips through its float unchanged.
    return Decimal(str(check['cubic_feet'])) / check['lgr_factor']


def number(value):
    """A measurement as the technician would write it: 180, 8.5, 1,440."""
    return f'{Decimal(str(value)).normalize():,f}'


def count(amount, noun):
    return f'{amount} {noun}' + ('' if amount == 1 else 's')


def room_loss(room):
    # A room saved before loss types existed reads as the tag it showed: category 3 as mold.
    return room.loss or ('mold' if room.category == 3 else 'water')


def room_check(room):
    if room_loss(room) == 'mold':
        return dict(name=room.name, status='not_applicable')
    missing = [label for field, label in INPUTS if getattr(room, field) is None]
    if missing:
        return dict(name=room.name, status='not_available', missing=missing)
    floor = Decimal(str(room.floor_sf))
    wet = floor if room.wet_floor_sf is None else Decimal(str(room.wet_floor_sf))
    if wet > floor:
        return dict(
            name=room.name,
            status='not_available',
            missing=[],
            problem='the wet floor area is larger than the floor area',
        )
    height = Decimal(str(room.ceiling_height_ft))
    cubic = floor * height
    factor = LGR_FACTORS[room.water_class]
    if not wet:
        low = high = None
    else:
        low = 1 if floor < SMALL_ROOM_SF else 1 + up(wet / AIR_MOVER_FLOOR_SF[0])
        high = 1 + up(wet / AIR_MOVER_FLOOR_SF[1])
    return dict(
        name=room.name,
        status='available',
        floor_sf=room.floor_sf,
        wet_floor_sf=float(wet),
        wet_floor_stated=room.wet_floor_sf is not None,
        ceiling_height_ft=room.ceiling_height_ft,
        water_class=room.water_class,
        cubic_feet=float(cubic),
        air_movers_min=low,
        air_movers_max=high,
        lgr_factor=factor,
        # Shown to a tenth; the job total sums the exact demand (room_ppd) before rounding up.
        dehumidifier_ppd=float(tenths(cubic / factor)),
    )


def air_mover_check(entered, low, high):
    if entered < low:
        return 'below', f'Fewer than the IICRC minimum of {low} for the wet floor areas.'
    if entered > high:
        return 'above', (
            f'More than the IICRC floor-based maximum of {high}. Note any wet walls above 2 feet, '
            'wet ceilings or wall offsets over 18 inches that need the extra air movers.'
        )
    return 'within', f'Within the IICRC range of {low} to {high}.'


def dehumidifier_check(entered, demand, rating):
    ppd = up(demand)
    if rating is None:
        if not entered:
            return None, 'below', f'No dehumidifier entered; {ppd} pints/day are recommended.'
        return None, None, "Enter the dehumidifier's AHAM pints/day rating to compare."
    units = up(demand / rating)
    capacity = entered * rating
    if entered < units:
        return (
            units,
            'below',
            (
                f'{entered} × {rating} = {capacity} pints/day is less than the {ppd} pints/day recommended.'
            ),
        )
    if entered > units:
        return (
            units,
            'above',
            (
                f'{units} at {rating} pints/day each cover the {ppd} pints/day recommended; '
                f'{entered} are entered.'
            ),
        )
    return (
        units,
        'within',
        f'{entered} × {rating} = {capacity} pints/day covers the {ppd} recommended.',
    )


def equipment_sizing(data):
    """The check for an inspection; status is available only when every water room has inputs."""
    rooms = [room_check(room) for room in data.rooms]
    water = [room for room in rooms if room['status'] != 'not_applicable']
    if not water:
        return dict(status='not_applicable', rooms=rooms)
    if any(room['status'] == 'not_available' for room in water):
        return dict(status='not_available', rooms=rooms)
    demand = sum(room_ppd(room) for room in water)
    unsized = [room['name'] for room in water if room['air_movers_min'] is None]
    if unsized:
        low = high = flag = None
        reason = (
            'Cannot size air movers: no wet floor area in ' + ', '.join(unsized) + '. '
            'The floor-based IICRC placement does not cover wet walls only.'
        )
    else:
        low = sum(room['air_movers_min'] for room in water)
        high = sum(room['air_movers_max'] for room in water)
        flag, reason = air_mover_check(data.air_movers, low, high)
    units, dehu_flag, dehu_reason = dehumidifier_check(
        data.dehumidifiers, demand, data.dehumidifier_ppd
    )
    return dict(
        status='available',
        rooms=rooms,
        air_movers=dict(entered=data.air_movers, min=low, max=high, flag=flag, reason=reason),
        dehumidifiers=dict(
            entered=data.dehumidifiers,
            recommended_ppd=up(demand),
            unit_ppd=data.dehumidifier_ppd,
            recommended_units=units,
            flag=dehu_flag,
            reason=dehu_reason,
        ),
    )


def letter_paragraph(sizing):
    """The calculation for the scope defense letter, or None when the check is not available."""
    if sizing['status'] != 'available':
        return None
    lines = [
        'Equipment sizing check (IICRC S500 initial air mover placement; IICRC LGR '
        'dehumidification factor chart), from technician-confirmed room inputs:'
    ]
    for room in sizing['rooms']:
        if room['status'] == 'not_applicable':
            lines.append(f'{room["name"]}: mold only; not part of the drying check.')
            continue
        floor, wet = number(room['floor_sf']), number(room['wet_floor_sf'])
        low = (
            '1 (room under 25 SF)'
            if Decimal(str(room['floor_sf'])) < SMALL_ROOM_SF
            else f'1 + {wet} ÷ 70'
        )
        source = (
            '' if room['wet_floor_stated'] else ' (the whole floor; no smaller wet area entered)'
        )
        placement = (
            ''
            if room['air_movers_min'] is None
            else f'Air movers for {wet} SF of wet floor{source}: {low} to 1 + {wet} ÷ 50, '
            f'rounded up = {room["air_movers_min"]} to {room["air_movers_max"]}. '
        )
        exact = room_ppd(room)
        equals = '=' if tenths(exact) == exact else '≈'
        lines.append(
            f'{room["name"]}: {floor} SF floor × {number(room["ceiling_height_ft"])} ft ceiling = '
            f'{number(room["cubic_feet"])} cu ft, water class {room["water_class"]}. '
            f'{placement}LGR dehumidification: '
            f'{number(room["cubic_feet"])} ÷ {room["lgr_factor"]} {equals} '
            f'{number(room["dehumidifier_ppd"])} pints/day (AHAM).'
        )
    movers, dehus = sizing['air_movers'], sizing['dehumidifiers']
    rating = dehus['unit_ppd']
    lines.append(
        'Recommended: '
        + ('' if movers['min'] is None else f'{movers["min"]} to {movers["max"]} air movers and ')
        + f'{dehus["recommended_ppd"]} pints/day of LGR dehumidification (the room total, rounded up'
        + (
            f'; {count(dehus["recommended_units"], "unit")} at {rating} pints/day each'
            if rating is not None
            else ''
        )
        + ').'
    )
    lines.append(
        f'Entered for this proposal: {count(movers["entered"], "air mover")} and '
        f'{count(dehus["entered"], "LGR dehumidifier")}'
        + (f' rated {rating} pints/day each' if rating is not None else '')
        + '.'
    )
    lines.append(WALLS_NOTE)
    return '\n'.join(lines)
