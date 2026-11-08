from tests.pricing_v2_support import (
    D,
    EXISTING_TABLE_PINS,
    FULL_ROOM,
    ITEMS,
    POLICY,
    TWO_ROOMS,
    WASTE_BASIS,
    _cabinetry_prices,
    _item,
    _job_area_table,
    _one,
    _starter_job_table,
    bumps,
    copy,
    ends,
    job,
    price_table,
    pricing_v2,
    pytest,
    random,
    random_job,
    random_table,
    room,
    run,
    table,
)


@pytest.mark.parametrize(
    'area_basis,quantities,low,high',
    [
        # 100 + 900 sq ft fits the first 1,000, so all of it carries 50%.
        ('demolition', [100.0, 900.0], '4220.00', '6330.00'),
        # The same lines and dollars, but 110 + 945 sq ft spills 55 sq ft past the first 1,000.
        (WASTE_BASIS, [100.0, 900.0], '4220.00', '6264.00'),
        # A job area item prices from the wet floor; the cushion counts those 920 sq ft.
        ('wet_floor', [120.0, 800.0], '3888.00', '5832.00'),
    ],
)
def test_the_three_area_bases_on_a_job_area_item(area_basis, quantities, low, high):
    lines, estimate, _ = run(job(TWO_ROOMS), _job_area_table(area_basis))
    assert [line['quantity'] for line in lines] == quantities
    assert [line['area'] for line in lines] == quantities
    assert [line['waste_percent'] for line in lines] == [10.0, 5.0]
    assert estimate['low']['total'] == D(low)
    assert estimate['high']['total'] == D(high)

@pytest.mark.parametrize(
    'area_basis,high',
    [
        # The dearest 1,000 of 1,920 line sq ft: 60 + 900 + 40, which is $3,996.
        ('demolition', '6553.20'),
        # Waste makes those lines 66 + 900 + 44, so only 34 of the 44 fit, which is $3,966.
        (WASTE_BASIS, '6544.20'),
        # Wet floor keeps today's cushion: each line's own square feet, the same as raw.
        ('wet_floor', '6553.20'),
    ],
)
def test_the_three_area_bases_on_a_starter_list_job(area_basis, high):
    data = job(
        [
            room('Hall', finished_sf=60, unfinished_sf=40, wet_floor_sf=120, waste_percent=10),
            room('Den', finished_sf=900, wet_floor_sf=800),
        ]
    )
    lines, estimate, _ = run(data, _starter_job_table(area_basis))
    assert [(line['room'], line['item_id'], line['quantity'], line['total']) for line in lines] == [
        ('Hall', 'demo_cat2_floor', 40.0, 132.0),
        ('Hall', 'demo_cat2_wall', 60.0, 264.0),
        ('Den', 'demo_cat2_wall', 900.0, 3600.0),
        ('Hall', 'antimicrobial', 120.0, 66.0),
        ('Den', 'antimicrobial', 800.0, 400.0),
    ]
    assert estimate['low']['total'] == D('4462.00')
    assert estimate['high']['total'] == D(high)

def test_the_waste_basis_charges_waste_once():
    # 100 sq ft with 10% waste at $10 is $1,100, on any item and either demolition choice.
    data = job([room('Hall', finished_sf=100, waste_percent=10)])
    for source in ('room:basis', 'room:demolition:finished'):
        for area_basis in ('demolition', WASTE_BASIS):
            item = _item('area', 'demolition', 'Area', 'sf', source, '10')
            lines, estimate, _ = run(data, table([item], area_basis=area_basis))
            assert lines[0]['quantity'] == 100.0
            assert lines[0]['waste_percent'] == 10.0
            assert lines[0]['total'] == 1100.0
            assert estimate['low']['total'] == D('1100.00')

def test_the_waste_basis_uses_the_item_waste_when_the_room_has_none():
    # The cushion's first 100 sq ft: 105 counted sq ft leaves 5 of them at the 20% beyond.
    first = {'first_sf': 100, 'first_percent': '50', 'beyond_percent': '20'}
    data = job([room('Hall', finished_sf=100)])
    _, estimate, _ = run(data, _job_area_table(WASTE_BASIS, waste='5', range=first))
    assert estimate['low']['total'] == D('420.00')
    assert estimate['high']['total'] == D('624.00')
    # Neither the room nor the item has waste: the same as raw.
    for area_basis in ('demolition', WASTE_BASIS):
        _, estimate, _ = run(data, _job_area_table(area_basis, waste='0', range=first))
        assert estimate['low']['total'] == D('400.00')
        assert estimate['high']['total'] == D('600.00')

def test_a_room_with_no_demolition_area_prices_nothing_on_the_waste_basis():
    # It has a floor and a waste percent, and the demolition bases read neither on their own.
    data = job([room('Hall', floor_sf=100, wet_floor_sf=100, waste_percent=10)])
    chosen = _job_area_table(WASTE_BASIS)
    lines, warnings = pricing_v2.price_scope(data, chosen)
    assert lines == []
    assert warnings == [dict(code='missing_area', item_id='area', room='Hall')]

def test_the_waste_basis_counts_waste_on_an_entered_quantity():
    first = {'first_sf': 200, 'first_percent': '50', 'beyond_percent': '20'}
    data = job(
        [room('Hall', finished_sf=100, waste_percent=10)],
        quantity_overrides={
            'Hall:finished_sf': {'measured': '100', 'entered': '200', 'reason': 'Measured again'}
        },
    )
    lines, estimate, _ = run(data, _job_area_table(WASTE_BASIS, range=first))
    assert lines[0]['quantity'] == 200.0
    assert estimate['low']['total'] == D('880.00')
    # 220 counted sq ft, 200 of them at 50%: 1.2 x 880 + 0.3 x 800.
    assert estimate['high']['total'] == D('1296.00')

def test_a_range_built_from_uncertainty_does_not_read_the_area_setting():
    assist = {
        'range_method': 'uncertainty',
        'drying_days': 3,
        'extra_drying_days': 0,
        'hidden_damage_percent': {'1': '10', '2': '20', '3': '30'},
    }
    item = _item('demo', 'demolition', 'Removal', 'sf', 'room:demolition:finished', '4')
    estimates = [
        run(job(TWO_ROOMS), table([item], area_basis=area_basis, assist=assist))[1]
        for area_basis in ('demolition', WASTE_BASIS, 'wet_floor')
    ]
    assert estimates[0]['low'] == estimates[1]['low'] == estimates[2]['low']
    assert estimates[0]['high'] == estimates[1]['high'] == estimates[2]['high']

@pytest.mark.parametrize(
    'source',
    [
        'room:demolition:unfinished',
        'room:demolition:finished',
        'room:wet_floor',
        'room:floor',
        'room:basis',
    ],
)
def test_the_waste_basis_never_changes_a_line(source):
    data = job([room(**FULL_ROOM, waste_percent=10)])
    items = _one(source)
    assert pricing_v2.price_scope(
        data, table(items, area_basis=WASTE_BASIS)
    ) == pricing_v2.price_scope(data, table(items))

def test_the_wet_floor_basis_does_not_change_the_flat_cushion():
    # No item here is set to job area, so wet floor must match raw to the cent.
    items = [
        _item('demo', 'demolition', 'Removal', 'sf', 'room:demolition:finished', '4'),
        _item('anti', 'treatment', 'Antimicrobial', 'sf', 'room:wet_floor', '0.50'),
    ]
    for wet_floor in (100, 800, 1200):
        data = job([room('Hall', finished_sf=1500, floor_sf=2000, wet_floor_sf=wet_floor)])
        raw = run(data, table(items))[1]
        wet = run(data, table(items, area_basis='wet_floor'))[1]
        assert wet['low'] == raw['low']
        assert wet['high'] == raw['high']

def test_the_waste_basis_stays_monotone_in_every_input_and_never_falls_below_the_low():
    rng = random.Random(20261104)
    tolerance = D('0.02')
    checks = 0
    for _ in range(600):
        chosen, values = random_table(rng), random_job(rng)
        chosen['policy']['area_basis'] = WASTE_BASIS
        low, high = ends(values, chosen)
        assert high >= low
        for changed in bumps(values):
            new_low, new_high = ends(changed, chosen)
            assert new_low >= low - tolerance, changed
            assert new_high >= high - tolerance, changed
            checks += 1
    assert checks > 10000

def test_the_waste_basis_never_raises_the_high_above_raw():
    rng = random.Random(20261105)
    for _ in range(600):
        chosen, values = random_table(rng), random_job(rng)
        chosen['policy']['area_basis'] = 'demolition'
        low, high = ends(values, chosen)
        chosen['policy']['area_basis'] = WASTE_BASIS
        waste_low, waste_high = ends(values, chosen)
        assert waste_low == low
        assert low <= waste_high <= high

def test_existing_tables_keep_their_hash_and_totals():
    rng = random.Random(20261104)
    for number, pin in enumerate(EXISTING_TABLE_PINS, start=1):
        chosen, values = random_table(rng), random_job(rng)
        low, high = ends(values, chosen)
        actual = (chosen['policy']['area_basis'], price_table.content_hash(chosen), low, high)
        assert actual == pin, f'seeded job {number}'

def test_tables_that_never_chose_the_waste_basis_keep_their_content_hash():
    # Hashes from before the third choice existed. A change here would move every stored pin.
    assert price_table.content_hash(table()) == (
        '004cfd4e0be1ebb1280a4dd4377a5b66b4936a2afd04ec8a158645934869811f'
    )
    assert price_table.content_hash(table(area_basis='wet_floor')) == (
        '19243b891f80211af721661dd4c5686912515d3452f540501360da89ba3bc6a7'
    )
    without_the_key = copy.deepcopy(POLICY)
    without_the_key.pop('area_basis', None)
    assert price_table.content_hash(
        {'items': copy.deepcopy(ITEMS), 'policy': without_the_key}
    ) == price_table.content_hash(table())
    assert price_table.content_hash(table(area_basis=WASTE_BASIS)) != price_table.content_hash(
        table()
    )

def test_what_the_cabinetry_definitions_say_each_scope_reaches():
    # Finished-surface demolition only: just the finished lines.
    assert _cabinetry_prices('finished_only') == {
        'item0': 10.0,
        'item1': 20.0,
        'item2': 10.0,
        'item3': 10.0,
        'item4': 10.0,
        'calls': 10.0,
    }
    # All category 3 room lines: every line priced from the room's square feet, never a job line.
    assert _cabinetry_prices('all_cat3') == {
        'item0': 20.0,
        'item1': 20.0,
        'item2': 20.0,
        'item3': 20.0,
        'item4': 20.0,
        'calls': 10.0,
    }

def test_the_cabinetry_definitions_worked_example():
    def total(multiplier):
        chosen = table(
            [_item('demo', 'demolition', 'Removal', 'sf', 'room:demolition:finished', '10')],
            cabinetry={'multiplier': multiplier, 'scope': 'finished_only'},
        )
        data = job([room(category=3, finished_sf=100, custom_cabinetry=True)])
        return pricing_v2.price_scope(data, chosen)[0][0]['total']

    assert total('1.0') == 1000.0
    assert total('2.0') == 2000.0
