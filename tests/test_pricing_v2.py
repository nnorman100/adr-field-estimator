from tests.pricing_v2_support import (
    D,
    EXAMPLE_A,
    EXAMPLE_D,
    ITEMS,
    InspectionData,
    _item,
    bumps,
    copy,
    ends,
    job,
    priced,
    pytest,
    random,
    random_job,
    random_table,
    room,
    run,
    table,
)


def test_worked_examples_a_to_g():
    # A. 500 sq ft category 2 wall, 3 air movers and 1 dehumidifier for 3 days.
    lines, result, _ = run(job(**EXAMPLE_A))
    assert [(line['description'], line['total'], line['bucket']) for line in lines] == [
        ('Emergency service call', 150.0, 'fixed'),
        ('Equipment monitoring', 500.0, 'fixed'),
        ('Debris haul and disposal', 160.0, 'fixed'),
        ('Living room: Category 2 drywall and trim removal', 1500.0, 'labor_material'),
        ('Air mover', 270.0, 'equipment'),
        ('LGR dehumidifier', 300.0, 'equipment'),
    ]
    assert result['labor_material_low'] == D('1500.00')
    assert result['labor_material_high'] == D('2250.00')
    assert result['low']['total'] == D('2880.00')
    assert result['high']['total'] == D('3630.00')

    # C. Two rooms at different rates: the 1,000 most expensive square feet carry the first percent.
    _, result, _ = run(
        job([room('Basement', 3, finished_sf=800), room('Hall', 1, finished_sf=600)])
    )
    assert result['labor_material_low'] == D('7600.00')
    assert result['labor_material_high'] == D('11160.00')
    assert result['low']['total'] == D('8410.00')
    assert result['high']['total'] == D('11970.00')

    # D. After hours, cabinetry, labor hours, O&P 10% and tax 8%; O&P comes before tax.
    decided = table(overhead_profit_percent='10', sales_tax={'enabled': True, 'percent': '8'})
    lines, result, _ = run(job(**EXAMPLE_D), decided)
    assert {line['description']: line['unit_price'] for line in lines}[
        'Kitchen: Category 3 or mold drywall and trim removal'
    ] == 16.0
    assert result['labor_material_low'] == D('5150.00')
    assert result['labor_material_high'] == D('7725.00')
    assert result['low'] == {
        'subtotal': D('6640.00'),
        'after_hours': D('1030.00'),
        'minimum_charge': D('0.00'),
        'overhead_profit': D('767.00'),
        # 8% of (480 + 1.2 x 150) x 1.10 = 8% of 726.00
        'tax': D('58.08'),
        'total': D('8495.08'),
    }
    assert result['high'] == {
        'subtotal': D('9215.00'),
        'after_hours': D('1545.00'),
        'minimum_charge': D('0.00'),
        'overhead_profit': D('1076.00'),
        # 8% of (480 + 1.2 x 150 x 7725 / 5150) x 1.10 = 8% of 825.00
        'tax': D('66.00'),
        'total': D('11902.00'),
    }

    # E. The same job in single-price mode.
    single = table(
        estimate_mode='single',
        overhead_profit_percent='10',
        sales_tax={'enabled': True, 'percent': '8'},
    )
    _, result, _ = run(job(**EXAMPLE_D), single)
    assert result['mode'] == 'single'
    assert result['low']['total'] == D('8495.08')
    assert result['high'] is None

    # F. Example A plus one approved extra: exactly +125.00 at both ends.
    extra = dict(
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
    lines, result, _ = run(job(**EXAMPLE_A, extras=[extra]))
    assert lines[-1]['code'] == 'EXTRA'
    assert (lines[-1]['quantity'], lines[-1]['unit_price'], lines[-1]['total']) == (
        2.5,
        50.0,
        125.0,
    )
    assert lines[-1]['bucket'] == 'fixed'
    assert result['low']['total'] == D('3005.00')
    assert result['high']['total'] == D('3755.00')

    # G. Wet-floor basis: the demolition line still reads its own area; job area reads wet floor.
    with_basis = ITEMS + [
        _item(
            'dry_setup',
            'treatment',
            'Drying setup and moisture mapping',
            'sf',
            'room:basis',
            '0.25',
        )
    ]
    lines, result, _ = run(
        job([room('Bedroom', finished_sf=100, wet_floor_sf=200, floor_sf=400)]),
        table(with_basis, area_basis='wet_floor'),
    )
    by_name = {line['description']: line['quantity'] for line in lines}
    assert by_name['Bedroom: Category 2 drywall and trim removal'] == 100.0
    assert by_name['Bedroom: Antimicrobial application'] == 200.0
    assert by_name['Bedroom: Drying setup and moisture mapping'] == 200.0
    assert result['labor_material_low'] == D('450.00')
    assert result['labor_material_high'] == D('675.00')
    assert result['low']['total'] == D('1260.00')
    assert result['high']['total'] == D('1485.00')


@pytest.mark.parametrize(
    'area,low_lm,high_lm,factor,low,high',
    [
        (999, '2997.00', '4495.50', '1.5000', '3807.00', '5305.50'),
        (1000, '3000.00', '4500.00', '1.5000', '3810.00', '5310.00'),
        (1001, '3003.00', '4503.60', '1.4997', '3813.00', '5313.60'),
        (1002, '3006.00', '4507.20', '1.4994', '3816.00', '5317.20'),
        (1250, '3750.00', '5400.00', '1.4400', '4560.00', '6210.00'),
        (2000, '6000.00', '8100.00', '1.3500', '6810.00', '8910.00'),
        (5000, '15000.00', '18900.00', '1.2600', '15810.00', '19710.00'),
    ],
)
def test_small_job_factor_equals_first_percent_and_taper_is_continuous_at_n(
    area, low_lm, high_lm, factor, low, high
):
    _, result, _ = run(job([room(finished_sf=area)]))
    assert result['labor_material_low'] == D(low_lm)
    assert result['labor_material_high'] == D(high_lm)
    ratio = result['labor_material_high'] / result['labor_material_low']
    assert abs(ratio - D(factor)) < D('0.00005')
    if area in (999, 1000, 1001):
        assert abs(ratio - D('1.5')) <= D('0.0005')
    assert result['low']['total'] == D(low)
    assert result['high']['total'] == D(high)


def test_top_n_takes_the_most_expensive_square_feet_first():
    # Three rooms; 800 at $8 and 100 at $3 are whole, then 100 of the 600 at $2 are a partial line.
    rooms = [
        room('Hall', 1, finished_sf=600),
        room('Basement', 3, finished_sf=800),
        room('Bath', 2, finished_sf=100),
    ]
    _, result, _ = run(job(rooms))
    assert result['labor_material_low'] == D('7900.00')
    top = D('6400') + D('300') + D('200')
    assert result['labor_material_high'] == D('1.2') * D('7900') + D('0.3') * top

    # Reordering the rooms changes nothing.
    _, again, _ = run(job(list(reversed(rooms))))
    assert again['labor_material_high'] == result['labor_material_high']

    # Adding cheap area beyond N never lowers the high; a proportional taper would.
    _, more, _ = run(job(rooms + [room('Garage', 1, unfinished_sf=500)]))
    assert more['high']['total'] > result['high']['total']


def test_labor_hours_carry_the_first_percent_at_every_size():
    _, result, _ = run(job([room(finished_sf=5000)], labor_hours=10))
    # Area 15,000 tapers, the 500 of labor hours carry 50%.
    assert result['labor_material_high'] == D('18900.00') + D('750.00')


def test_monotone_in_every_input_and_price():
    rng = random.Random(20261102)
    tolerance = D('0.02')
    checks = 0
    for _ in range(2000):
        chosen, values = random_table(rng), random_job(rng)
        low, high = ends(values, chosen)
        for changed in bumps(values):
            new_low, new_high = ends(changed, chosen)
            checks += 1
            assert new_low >= low - tolerance, (values, changed, chosen['policy'])
            assert new_high >= high - tolerance, (values, changed, chosen['policy'])
        # Sample three prices per table: every price is covered across the run.
        for row in rng.sample(chosen['items'], 3):
            raised = copy.deepcopy(chosen)
            target = next(i for i in raised['items'] if i['item_id'] == row['item_id'])
            target['unit_price'] = f'{D(target["unit_price"]) + D("0.01"):.2f}'
            new_low, new_high = ends(values, raised)
            checks += 1
            assert new_low >= low - tolerance, (values, row, chosen['policy'])
            assert new_high >= high - tolerance, (values, row, chosen['policy'])
    assert checks > 40000


def test_high_never_below_low_and_single_mode_returns_no_high():
    rng = random.Random(7)
    for _ in range(500):
        chosen, values = random_table(rng), random_job(rng)
        data = InspectionData.model_validate(values)
        _, result, _ = run(data, chosen)
        if chosen['policy']['estimate_mode'] == 'single':
            assert result['mode'] == 'single' and result['high'] is None
            # The high labor and materials amount stays available for a later switch to range mode.
            assert result['labor_material_high'] >= result['labor_material_low']
        else:
            assert result['mode'] == 'range'
            assert result['high']['total'] >= result['low']['total']


def test_every_printed_summary_adds_up_to_its_total():
    rng = random.Random(11)
    for _ in range(300):
        chosen, values = random_table(rng), random_job(rng)
        _, result, _ = run(InspectionData.model_validate(values), chosen)
        for end in (result['low'], result['high']):
            if end is None:
                continue
            assert end['total'] == (
                end['subtotal']
                + end['after_hours']
                + end['minimum_charge']
                + end['overhead_profit']
                + end['tax']
            )
            for amount in end.values():
                assert amount == amount.quantize(D('0.01'))


def test_after_hours_multiplier_and_flat_charge():
    rooms = [room(finished_sf=100)]
    lines, regular, _ = run(job(rooms))
    assert not [line for line in lines if line['item_id'] == 'after_hours']
    assert regular['low']['after_hours'] == D('0.00')

    lines, late, _ = run(job(rooms, is_after_hours=True))
    assert [line['total'] for line in lines if line['item_id'] == 'after_hours'] == [200.0]
    assert late['low']['after_hours'] == D('60.00')  # 20% of 300
    assert late['high']['after_hours'] == D('90.00')  # 20% of 450
    assert late['low']['total'] == D('810') + D('200') + D('300') + D('60')

    lines, flat, _ = run(
        job(rooms, is_after_hours=True), table(after_hours={'multiplier': '1.000'})
    )
    assert [line['total'] for line in lines if line['item_id'] == 'after_hours'] == [200.0]
    assert flat['low']['after_hours'] == D('0.00') and flat['high']['after_hours'] == D('0.00')


def test_after_hours_line_label_is_the_owners():
    default = run(job([room(finished_sf=100)], is_after_hours=True))[1]
    assert default['after_hours_label'] == 'After-hours adjustment'
    chosen = table(after_hours={'multiplier': '1.2', 'label': 'Emergency response adjustment'})
    labelled = run(job([room(finished_sf=100)], is_after_hours=True), chosen)[1]
    assert labelled['after_hours_label'] == 'Emergency response adjustment'
    assert 'Emergency response adjustment' in labelled['explanation']


def test_category_and_cabinetry_multipliers_and_scope():
    both = [
        room('Mold', 3, unfinished_sf=100, finished_sf=100, custom_cabinetry=True),
        room('Gray', 2, finished_sf=100, custom_cabinetry=True),
    ]
    multiplied = table(
        category_multipliers={'1': '1', '2': '1.5', '3': '1.25'},
        cabinetry={'multiplier': '2', 'scope': 'finished_only'},
    )
    lines, _, _ = run(job(both), multiplied)
    prices = {line['description']: line['unit_price'] for line in lines if line['room']}
    # Category 3 floor keeps only the category multiplier under finished_only.
    assert prices['Mold: Category 3 or mold flooring and subfloor removal'] == 3.125
    assert prices['Mold: Category 3 or mold drywall and trim removal'] == 20.0
    # Category 2 rooms take their own multiplier and never the cabinetry one.
    assert prices['Gray: Category 2 drywall and trim removal'] == 4.5
    # Multipliers change room lines only.
    assert {line['description']: line['unit_price'] for line in lines}[
        'Emergency service call'
    ] == 150.0

    wide = table(
        category_multipliers={'1': '1', '2': '1.5', '3': '1.25'},
        cabinetry={'multiplier': '2', 'scope': 'all_cat3'},
    )
    lines, _, _ = run(job(both), wide)
    prices = {line['description']: line['unit_price'] for line in lines if line['room']}
    assert prices['Mold: Category 3 or mold flooring and subfloor removal'] == 6.25
    assert prices['Gray: Category 2 drywall and trim removal'] == 4.5

    # Without the cabinetry flag no cabinetry multiplier applies, in either scope.
    plain = [room('Mold', 3, finished_sf=100)]
    lines, _, _ = run(job(plain), wide)
    assert [line['unit_price'] for line in lines if line['room']] == [10.0]


def test_overhead_profit_and_tax_bases_and_rounding():
    on = {'enabled': True, 'percent': '8'}
    # O&P off: it plays no part in tax. These are the spec's own numbers for the example.
    _, off, _ = run(job(**EXAMPLE_D), table(sales_tax=on))
    assert off['low']['overhead_profit'] == D('0.00')
    assert off['low']['tax'] == D('52.80')
    assert off['high']['tax'] == D('60.00')

    # O&P on: the tax base carries the taxable items' own share of O&P, and only theirs.
    _, withop, _ = run(job(**EXAMPLE_D), table(sales_tax=on, overhead_profit_percent='10'))
    assert withop['low']['tax'] == D('58.08')
    assert withop['high']['tax'] == D('66.00')
    assert withop['low']['overhead_profit'] == D('767.00')

    # A job with nothing taxable pays no tax, O&P or not.
    no_tax_items = priced(
        ITEMS,
        antimicrobial={'taxable': False},
        air_mover={'taxable': False},
        dehu={'taxable': False},
    )
    _, untaxed = run(
        job(**EXAMPLE_D), table(no_tax_items, sales_tax=on, overhead_profit_percent='10')
    )[:2]
    assert untaxed['low']['tax'] == D('0.00') and untaxed['high']['tax'] == D('0.00')

    # L = 0: the taxable labor share is zero, taxable equipment still taxes, nothing divides by zero.
    _, no_lm, _ = run(job(air_movers=1), table(sales_tax=on))
    assert no_lm['labor_material_low'] == D('0.00')
    assert no_lm['low']['tax'] == no_lm['high']['tax'] == D('7.20')  # 8% of 90

    # Tax off keeps the percent out of the total even with a stored percent.
    _, disabled, _ = run(job(**EXAMPLE_D), table(sales_tax={'enabled': False, 'percent': '8'}))
    assert disabled['low']['tax'] == D('0.00')

    # Half-up on the summary line: 8.25% of 30.00 = 2.475 prints 2.48.
    _, cents, _ = run(
        job(air_movers=1, drying_days=1), table(sales_tax={'enabled': True, 'percent': '8.25'})
    )
    assert cents['low']['tax'] == D('2.48')


def test_minimum_job_charge_raises_the_low_before_overhead_profit_and_tax():
    # Off by default.
    _, off, _ = run(job(**EXAMPLE_A))
    assert off['low']['minimum_charge'] == D('0.00')
    assert off['minimum_charge_label'] == 'Minimum job charge'

    # Between the ends: only the low moves, the high keeps its own amount.
    _, between, _ = run(job(**EXAMPLE_A), table(minimum_job_charge='3000'))
    assert between['low']['minimum_charge'] == D('120.00')
    assert between['low']['total'] == D('3000.00')
    assert between['high']['minimum_charge'] == D('0.00')
    assert between['high']['total'] == D('3630.00')

    # Above both ends: the job is the minimum, and high equals low.
    _, above, _ = run(job(**EXAMPLE_A), table(minimum_job_charge='5000'))
    assert above['low']['minimum_charge'] == D('2120.00')
    assert above['low']['total'] == D('5000.00')
    assert above['high'] == above['low']

    # Below the low it adds nothing.
    _, below, _ = run(job(**EXAMPLE_A), table(minimum_job_charge='1000'))
    assert below['low']['minimum_charge'] == D('0.00')
    assert below['low']['total'] == D('2880.00')

    # Single mode: the price is the minimum.
    _, single, _ = run(job(**EXAMPLE_A), table(minimum_job_charge='5000', estimate_mode='single'))
    assert single['low']['total'] == D('5000.00')
    assert single['high'] is None

    # O&P is charged on the raised amount; tax stays on the taxable items and their share only.
    _, stacked, _ = run(
        job(**EXAMPLE_A),
        table(
            minimum_job_charge='5000',
            overhead_profit_percent='10',
            sales_tax={'enabled': True, 'percent': '8'},
        ),
    )
    assert stacked['low']['minimum_charge'] == D('2120.00')
    assert stacked['low']['overhead_profit'] == D('500.00')
    # 8% of 570 taxable equipment x 1.10
    assert stacked['low']['tax'] == D('50.16')
    assert stacked['low']['total'] == D('5550.16')
    assert stacked['high'] == stacked['low']


def test_minimum_job_charge_never_lets_more_work_lower_the_high():
    # Under the minimum, the taxable share at the high end shrinks as non-taxable area is added.
    # Flooring the high separately would let that lower the total; the high follows the low instead.
    rows = priced(
        ITEMS,
        demo_c2_fin={'taxable': True},
        demo_c1_fin={'unit_price': '2.00', 'taxable': False},
    )
    chosen = table(
        rows,
        minimum_job_charge='100000',
        range={'first_sf': 100, 'first_percent': '100', 'beyond_percent': '0'},
        sales_tax={'enabled': True, 'percent': '15'},
    )
    previous = None
    for extra_area in (0, 100, 500, 2000, 5000):
        rooms = [room('Taxed', 2, finished_sf=200), room('Plain', 1, finished_sf=extra_area)]
        _, result, _ = run(job(rooms), chosen)
        high = result['high']['total']
        assert high >= result['low']['total']
        if previous is not None:
            assert high >= previous
        previous = high


def test_room_waste_overrides_item_waste_only_when_positive():
    rows = priced(ITEMS, demo_c2_fin={'waste_percent': '10'}, trip={'waste_percent': '50'})
    lines, _, _ = run(
        job([room('Own', finished_sf=100, waste_percent=25), room('Falls back', finished_sf=100)]),
        table(rows),
    )
    by_room = {line['room']: line for line in lines if line['room']}
    assert by_room['Own']['waste_percent'] == 25.0 and by_room['Own']['total'] == 375.0
    assert by_room['Falls back']['waste_percent'] == 10.0
    assert by_room['Falls back']['total'] == 330.0
    # Job lines use the item's waste.
    trip = next(line for line in lines if line['item_id'] == 'trip')
    assert trip['waste_percent'] == 50.0 and trip['total'] == 225.0
