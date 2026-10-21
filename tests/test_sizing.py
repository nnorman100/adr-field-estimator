import pytest
from pydantic import ValidationError

from backend.claims import price_scope
from backend.contracts import InspectionData, Room
from backend.sizing import equipment_sizing, letter_paragraph, room_check


def room(**values):
    return Room(**{'name': 'Kitchen', 'category': 1, 'loss': 'water', **values})


def sized(**values):
    return room(floor_sf=140, ceiling_height_ft=8, water_class=2, **values)


def test_air_movers_pin_the_s500_floor_examples():
    # Burton (Cleanfax, 2016): 140 SF of wet floor needs 2 to 3 air movers beyond the room's first.
    check = room_check(sized())
    assert (check['air_movers_min'], check['air_movers_max']) == (3, 4)
    # DocuSketch: a 22 x 22 room (484 SF) gives 484 / 70 -> 7 and 484 / 50 -> 10, rounded up.
    check = room_check(room(floor_sf=484, ceiling_height_ft=8, water_class=2))
    assert (check['air_movers_min'], check['air_movers_max']) == (8, 11)
    # Exact multiples are not rounded up further.
    check = room_check(room(floor_sf=350, ceiling_height_ft=8, water_class=2))
    assert (check['air_movers_min'], check['air_movers_max']) == (6, 8)
    # One air mover may be adequate below 25 SF.
    check = room_check(room(floor_sf=20, ceiling_height_ft=8, water_class=1))
    assert (check['air_movers_min'], check['air_movers_max']) == (1, 2)


@pytest.mark.parametrize(
    'water_class, factor, ppd', [(1, 100, 15), (2, 50, 29), (3, 40, 36), (4, 40, 36)]
)
def test_dehumidification_uses_the_iicrc_lgr_factor_chart(water_class, factor, ppd):
    # 180 SF x 8 ft = 1,440 cu ft; cubic feet / chart factor = pints per day, rounded up.
    check = room_check(room(floor_sf=180, ceiling_height_ft=8, water_class=water_class))
    assert check['cubic_feet'] == 1440
    assert (check['lgr_factor'], check['dehumidifier_ppd']) == (factor, ppd)


def test_rooms_without_confirmed_inputs_say_the_check_is_not_available():
    assert room_check(room(floor_sf=140)) == {
        'name': 'Kitchen',
        'status': 'not_available',
        'missing': ['ceiling height', 'water class'],
    }
    assert room_check(room(loss='mold', category=3))['status'] == 'not_applicable'
    # A room saved before loss types existed reads category 3 as mold, as the app shows it.
    assert room_check(room(loss=None, category=3))['status'] == 'not_applicable'
    data = InspectionData(rooms=[sized(), room(name='Hall')], air_movers=4)
    result = equipment_sizing(data)
    assert result['status'] == 'not_available' and 'air_movers' not in result
    assert letter_paragraph(result) is None
    assert equipment_sizing(InspectionData(rooms=[room(loss='mold', category=3)]))['status'] == (
        'not_applicable'
    )
    assert equipment_sizing(InspectionData(rooms=[]))['status'] == 'not_applicable'


@pytest.mark.parametrize(
    'entered, flag', [(2, 'below'), (3, 'within'), (4, 'within'), (5, 'above')]
)
def test_air_mover_counts_are_flagged_outside_the_range(entered, flag):
    result = equipment_sizing(InspectionData(rooms=[sized()], air_movers=entered))
    assert result['air_movers']['flag'] == flag
    assert result['air_movers']['entered'] == entered
    if flag == 'above':
        assert 'wet walls above 2 feet' in result['air_movers']['reason']


@pytest.mark.parametrize(
    'entered, rating, flag, units',
    [(0, 70, 'below', 1), (1, 70, 'within', 1), (2, 70, 'above', 1), (1, 25, 'below', 2)],
)
def test_dehumidifier_counts_compare_capacity_with_the_rated_units(entered, rating, flag, units):
    # Two rooms: 23 + 23 = 46 pints/day.
    data = InspectionData(
        rooms=[sized(), sized(name='Hall')], dehumidifiers=entered, dehumidifier_ppd=rating
    )
    dehus = equipment_sizing(data)['dehumidifiers']
    assert dehus['recommended_ppd'] == 46
    assert (dehus['flag'], dehus['recommended_units']) == (flag, units)


def test_dehumidifiers_without_a_rating_are_compared_only_when_none_are_entered():
    dehus = equipment_sizing(InspectionData(rooms=[sized()], dehumidifiers=1))['dehumidifiers']
    assert dehus['flag'] is None and dehus['recommended_units'] is None
    assert 'AHAM' in dehus['reason']
    dehus = equipment_sizing(InspectionData(rooms=[sized()], dehumidifiers=0))['dehumidifiers']
    assert dehus['flag'] == 'below'


def test_the_check_never_changes_counts_or_prices():
    plain = InspectionData(rooms=[room(finished_sf=50)], air_movers=9, dehumidifiers=4)
    checked = plain.model_copy(
        update={
            'rooms': [sized(finished_sf=50)],
            'dehumidifier_ppd': 70,
        }
    )
    assert equipment_sizing(checked)['air_movers']['flag'] == 'above'
    assert price_scope(checked) == price_scope(plain)


def test_letter_paragraph_prints_inputs_recommendation_and_entered_counts():
    data = InspectionData(
        rooms=[
            room(floor_sf=180, ceiling_height_ft=8.5, water_class=2),
            room(name='Closet', floor_sf=20, ceiling_height_ft=8, water_class=1),
            room(name='Attic', loss='mold', category=3),
        ],
        air_movers=7,
        dehumidifiers=1,
        dehumidifier_ppd=70,
    )
    assert letter_paragraph(equipment_sizing(data)).splitlines() == [
        'Equipment sizing check (IICRC S500 initial air mover placement; IICRC LGR dehumidification '
        'factor chart), from technician-confirmed room inputs:',
        'Kitchen: 180 SF floor × 8.5 ft ceiling = 1,530 cu ft, water class 2. Air movers: '
        '1 + 180 ÷ 70 to 1 + 180 ÷ 50, rounded up = 4 to 5. LGR dehumidification: 1,530 ÷ 50 = '
        '31 pints/day (AHAM).',
        'Closet: 20 SF floor × 8 ft ceiling = 160 cu ft, water class 1. Air movers: 1 (room under '
        '25 SF) to 1 + 20 ÷ 50, rounded up = 1 to 2. LGR dehumidification: 160 ÷ 100 = 2 '
        'pints/day (AHAM).',
        'Attic: mold only; not part of the drying check.',
        'Recommended: 5 to 7 air movers and 33 pints/day of LGR dehumidification (1 unit at 70 '
        'pints/day each).',
        'Entered for this proposal: 7 air movers and 1 LGR dehumidifier rated 70 pints/day each.',
        'Wet walls above 2 feet, wet ceilings and wall offsets over 18 inches add air movers and '
        'are not part of this floor-based range.',
    ]


@pytest.mark.parametrize(
    'values',
    [{'floor_sf': 0}, {'ceiling_height_ft': 0}, {'ceiling_height_ft': 61}, {'water_class': 5}],
)
def test_sizing_inputs_are_bounded(values):
    with pytest.raises(ValidationError):
        room(**values)
    with pytest.raises(ValidationError):
        InspectionData(dehumidifier_ppd=0)
