from tests.pricing_v2_support import (
    APPROVED_HOURS,
    D,
    EXAMPLE_A,
    EXAMPLE_D,
    ITEMS,
    InspectionData,
    SIZED_JOB,
    SIZED_ROOM,
    TWO_CATEGORIES,
    UNCERTAIN,
    _sentence,
    bumps,
    copy,
    job,
    price_books,
    priced,
    priced_on,
    pricing_v2,
    pytest,
    random,
    room,
    run,
    sized_job,
    sizing_bumps,
    table,
    uncertain,
    uncertain_ends,
    uncertain_table,
    without_sizing,
)


@pytest.mark.parametrize(
    'example,values,chosen,low,high',
    [
        ('A', SIZED_JOB, {}, '2950.00', '3495.50'),
        ('B', without_sizing(), {}, '2950.00', '3375.50'),
        ('C', {**SIZED_JOB, 'air_movers': 7}, {}, '3310.00', '3855.50'),
        (
            'D',
            TWO_CATEGORIES,
            dict(overhead_profit_percent='10', sales_tax={'enabled': True, 'percent': '8'}),
            '9023.08',
            '10969.42',
        ),
        (
            'F',
            SIZED_JOB,
            dict(
                assist=dict(
                    extra_drying_days=0, hidden_damage_percent={'1': '0', '2': '0', '3': '0'}
                )
            ),
            '2950.00',
            '3040.00',
        ),
        ('H', SIZED_JOB, dict(minimum_job_charge='5000'), '5000.00', '5000.00'),
        ('I', {**SIZED_JOB, 'extras': [APPROVED_HOURS]}, {}, '3075.00', '3620.50'),
    ],
)
def test_uncertainty_examples_a_to_i(example, values, chosen, low, high):
    result = priced_on(job(**values), uncertain(**chosen))
    assert (example, result['low']['total'], result['high']['total']) == (
        example,
        D(low),
        D(high),
    )


def test_uncertainty_example_a_shows_its_working():
    result = priced_on(job(**SIZED_JOB), uncertain())
    assert result['labor_material_low'] == D('1570.00')
    assert result['labor_material_high'] == D('1805.50')
    # 4 air movers x 4 days x 30 + 1 dehumidifier x 4 days x 100, on top of the same job charges.
    assert result['high']['subtotal'] == D('810.00') + D('880.00') + D('1805.50')
    assert result['uncertainty'] == {
        'air_movers': 4,
        'dehumidifiers': 1,
        'drying_days': 4,
        'sizing_available': True,
        'hidden_damage_percent': {'1': '10', '2': '15', '3': '25'},
    }


def test_uncertainty_example_e_and_g_single_price_and_an_old_table():
    single = priced_on(job(**SIZED_JOB), uncertain(estimate_mode='single'))
    assert single['low']['total'] == D('2950.00') and single['high'] is None

    old = table()
    assert 'assist' not in old['policy']
    result = priced_on(job(**EXAMPLE_A), old)
    assert (result['low']['total'], result['high']['total']) == (D('2880.00'), D('3630.00'))
    assert result['uncertainty'] is None


def test_the_cushion_path_is_byte_identical_with_and_without_the_assist_map():
    stored_unused = dict(
        drying_days=5,
        range_method='cushion',
        extra_drying_days=7,
        hidden_damage_percent={'1': '40', '2': '50', '3': '60'},
    )
    settings = dict(
        overhead_profit_percent='10',
        sales_tax={'enabled': True, 'percent': '8'},
        minimum_job_charge='250',
    )
    for values in (
        EXAMPLE_A,
        EXAMPLE_D,
        SIZED_JOB,
        TWO_CATEGORIES,
        {**SIZED_JOB, 'extras': [APPROVED_HOURS]},
        dict(rooms=[room('Basement', 3, finished_sf=800), room('Hall', 1, finished_sf=600)]),
    ):
        for mode in ('range', 'single'):
            plain = table(estimate_mode=mode, **settings)
            mapped = table(estimate_mode=mode, assist=stored_unused, **settings)
            data = job(**values)
            assert pricing_v2.price_scope(data, plain) == pricing_v2.price_scope(data, mapped)
            # Everything the documents read, line by line and end by end, texts included.
            assert priced_on(data, plain) == priced_on(data, mapped)
            assert run(data, plain)[1] == priced_on(data, plain)


def test_high_numbers_take_the_s500_maximum_and_recommended_units_and_never_fall_below_entered():
    assist = dict(UNCERTAIN, extra_drying_days=2)
    numbers = pricing_v2.high_numbers(job(**SIZED_JOB), assist)
    assert numbers == dict(air_movers=4, dehumidifiers=1, drying_days=5, sizing_available=True)

    # 2 rooms: (1 + ceil(140/50)) + (1 + ceil(60/50)) air movers; 400x8/50 + 300x8/50 = 112 pints.
    rooms = [
        room('Living room', **SIZED_ROOM),
        room('Hall', wet_floor_sf=60, floor_sf=300, ceiling_height_ft=8, water_class=2),
    ]
    numbers = pricing_v2.high_numbers(job(**{**SIZED_JOB, 'rooms': rooms}), assist)
    assert (numbers['air_movers'], numbers['dehumidifiers']) == (7, 2)

    above = job(**{**SIZED_JOB, 'air_movers': 9, 'dehumidifiers': 5})
    numbers = pricing_v2.high_numbers(above, assist)
    assert (numbers['air_movers'], numbers['dehumidifiers']) == (9, 5)

    # The count the low end prices is the entered one, so the high never starts below it.
    explained = job(
        **{
            **SIZED_JOB,
            'quantity_overrides': {
                'air_movers': {'measured': '3', 'entered': '6', 'reason': 'More fans'}
            },
        }
    )
    assert pricing_v2.high_numbers(explained, assist)['air_movers'] == 6

    # No rating means no recommendation to price (decision D5).
    unrated = job(**{**SIZED_JOB, 'dehumidifier_ppd': None})
    assert pricing_v2.high_numbers(unrated, assist)['dehumidifiers'] == 1


def test_an_unavailable_sizing_check_prices_equipment_as_entered_at_the_high_end():
    assist = dict(UNCERTAIN)
    for values in (
        without_sizing(),
        # A wet floor larger than the floor makes the check unavailable.
        {
            **SIZED_JOB,
            'rooms': [room('Living room', **{**SIZED_ROOM, 'wet_floor_sf': 500})],
        },
        # A mold room is not sized, and a job with only mold rooms has no check at all.
        {
            **SIZED_JOB,
            'rooms': [room('Living room', category=3, **SIZED_ROOM)],
        },
    ):
        numbers = pricing_v2.high_numbers(job(**values), assist)
        assert numbers == dict(air_movers=3, dehumidifiers=1, drying_days=4, sizing_available=False)

    # A wet-walls-only room leaves air movers unsized while dehumidifiers are still recommended.
    walls = job(**{**SIZED_JOB, 'rooms': [room('Hall', **{**SIZED_ROOM, 'wet_floor_sf': 0})]})
    numbers = pricing_v2.high_numbers(walls, assist)
    assert numbers == dict(air_movers=3, dehumidifiers=1, drying_days=4, sizing_available=True)


def test_equipment_lines_appear_at_the_high_end_when_none_were_entered():
    data = job(**{**SIZED_JOB, 'air_movers': 0, 'dehumidifiers': 0})
    assert 'Air mover' not in [
        line['description'] for line in pricing_v2.price_scope(data, table())[0]
    ]
    result = priced_on(data, uncertain())
    # 4 air movers and 1 dehumidifier for 4 days appear only in the high end.
    assert result['high']['subtotal'] - result['low']['subtotal'] == D('880.00') + D('235.50')


def test_an_unset_job_number_keeps_its_default_quantity_at_both_ends():
    items = priced(ITEMS, air_mover={'default_quantity': '12'})
    data = InspectionData.model_validate(
        dict(
            rooms=[room('Living room', **SIZED_ROOM)],
            emergency_calls=1,
            monitoring_hours=0,
            haul_loads=0,
            labor_hours=0,
            dehumidifiers=0,
        )
    )
    lines, _ = pricing_v2.price_scope(data, uncertain(items))
    assert next(line for line in lines if line['description'] == 'Air mover')['quantity'] == 12
    high_lines, _ = pricing_v2.price_scope(
        data, uncertain(items), dict(air_movers=D(40), drying_days=D(9))
    )
    assert next(line for line in high_lines if line['description'] == 'Air mover')['quantity'] == 12


def test_the_high_numbers_reach_only_the_equipment_bucket():
    # Air movers priced as a job charge stay the low line at the high end.
    items = priced(ITEMS, air_mover={'group': 'job_charges'})
    result = priced_on(job(**SIZED_JOB), uncertain(items))
    # Job charges 810 + the 270 air mover line, flat; the dehumidifier moves from 300 to 400.
    assert result['high']['subtotal'] == D('1080.00') + D('400.00') + D('1805.50')


def test_hidden_damage_applies_per_room_category_and_labor_hours_carry_the_largest():
    data = job(
        rooms=[
            room('Basement', 3, finished_sf=100),
            room('Hall', 1, finished_sf=100),
            room('Bath', 2, finished_sf=100),
        ],
        labor_hours=2,
    )
    result = priced_on(data, uncertain())
    # 800 x 1.25 + 200 x 1.10 + 300 x 1.15 + labor 100 x 1.25
    assert result['labor_material_low'] == D('1400.00')
    assert result['labor_material_high'] == D('1690.00')

    # The largest percent among the job's rooms, not among all three categories.
    only_clean = job(rooms=[room('Hall', 1, finished_sf=100)], labor_hours=2)
    assert priced_on(only_clean, uncertain())['labor_material_high'] == D('330.00')
    # With no rooms at all, labor hours carry nothing.
    no_rooms = job(labor_hours=2)
    assert priced_on(no_rooms, uncertain())['labor_material_high'] == D('100.00')

    # Two stored rooms sharing a name take the larger percent, so neither is underpriced.
    twins = job(rooms=[room('Hall', 1, finished_sf=100), room('Hall', 3, finished_sf=100)])
    assert priced_on(twins, uncertain())['labor_material_high'] == D('1250.00')


def test_tax_at_the_high_end_is_exact_per_line():
    chosen = uncertain(overhead_profit_percent='10', sales_tax={'enabled': True, 'percent': '8'})
    result = priced_on(job(**TWO_CATEGORIES), chosen)
    assert result['low']['tax'] == D('58.08')
    # 8% of (taxed equipment 640 + 1.2 x antimicrobial 150 x 1.25) x 1.10
    assert result['high']['tax'] == D('76.12')
    assert result['high'] == {
        'subtotal': D('8527.50'),
        'after_hours': D('1375.50'),
        'minimum_charge': D('0.00'),
        'overhead_profit': D('990.30'),
        'tax': D('76.12'),
        'total': D('10969.42'),
    }


def test_minimum_job_charge_floors_both_ends_and_the_high_is_never_below_the_low():
    floored = priced_on(job(**SIZED_JOB), uncertain(minimum_job_charge='5000'))
    assert floored['high'] == floored['low']
    assert floored['low']['minimum_charge'] == D('2050.00')
    # A minimum between the two ends: the low is floored and the high has no minimum line.
    between = priced_on(job(**SIZED_JOB), uncertain(minimum_job_charge='3200'))
    assert between['low']['total'] == D('3200.00')
    assert between['high']['total'] == D('3495.50')
    assert between['high']['minimum_charge'] == 0


def test_monotone_in_every_input_price_and_assist_setting():
    rng = random.Random(20261103)
    tolerance = D('0.02')
    checks = 0

    def check(changed_values, changed_table, low, high, where):
        new_low, new_high = uncertain_ends(changed_values, changed_table)
        assert new_low >= low - tolerance, where
        assert new_high >= high - tolerance, where
        assert new_high >= new_low, where

    for _ in range(2000):
        chosen, values = uncertain_table(rng), sized_job(rng)
        low, high = uncertain_ends(values, chosen)
        assert high >= low, (values, chosen['policy'])
        job_bumps = [
            changed
            for changed in bumps(values)
            if all(
                # bumps() walks the room areas without the check's rule; sizing_bumps has it.
                new['wet_floor_sf'] is None
                or new['floor_sf'] is None
                or new['wet_floor_sf'] <= new['floor_sf']
                for new in changed['rooms']
            )
        ]
        for changed in rng.sample(job_bumps, 6) + list(sizing_bumps(values)):
            check(changed, chosen, low, high, (values, changed, chosen['policy']))
            checks += 1
        for row in rng.sample(chosen['items'], 2):
            raised = copy.deepcopy(chosen)
            target = next(i for i in raised['items'] if i['item_id'] == row['item_id'])
            target['unit_price'] = f'{D(target["unit_price"]) + D("0.01"):.2f}'
            check(values, raised, low, high, (values, row, chosen['policy']))
            checks += 1
        raised = copy.deepcopy(chosen)
        raised['policy']['assist']['extra_drying_days'] += 1
        check(values, raised, low, high, (values, chosen['policy']))
        checks += 1
        key = rng.choice('123')
        raised = copy.deepcopy(chosen)
        percents = raised['policy']['assist']['hidden_damage_percent']
        percents[key] = str(min(100, int(percents[key]) + 5))
        check(values, raised, low, high, (values, key, chosen['policy']))
        checks += 1
    assert checks > 20000


def test_single_mode_prices_the_low_and_hides_the_uncertainty_fields():
    chosen = uncertain(estimate_mode='single')
    result = priced_on(job(**SIZED_JOB), chosen)
    assert result['mode'] == 'single' and result['high'] is None
    assert result['low']['total'] == D('2950.00')
    # H and the numbers are still worked out, so a later switch to a range needs no change.
    assert result['labor_material_high'] == D('1805.50')
    assert result['uncertainty']['air_movers'] == 4
    assert result['range_explanation'] is None
    assert result['explanation'] == 'The price covers the itemized scope below.'


def test_range_explanation_names_counts_days_and_only_the_categories_on_the_job():
    assert _sentence(SIZED_JOB) == (
        'The high end allows for up to 4 air movers and 1 dehumidifier for 4 drying days (1 more '
        'than planned), the most the IICRC S500 placement recommends for the stated room sizes, '
        'and hidden damage of 15% in category 2 rooms.'
    )
    # The categories on the job only, lowest first.
    assert _sentence(TWO_CATEGORIES).endswith(
        'and hidden damage of 10% in category 1 rooms and 25% in category 3 or mold rooms.'
    )
    all_three = {
        **SIZED_JOB,
        'rooms': [
            room('A', 3, **SIZED_ROOM),
            room('B', 2, **SIZED_ROOM),
            room('C', 1, **SIZED_ROOM),
        ],
    }
    assert _sentence(all_three).endswith(
        'and hidden damage of 10% in category 1 rooms, 15% in category 2 rooms and 25% in '
        'category 3 or mold rooms.'
    )
    # The check unavailable.
    assert _sentence(without_sizing()) == (
        'The high end allows for the equipment counts as entered for 4 drying days (1 more than '
        'planned), and hidden damage of 15% in category 2 rooms.'
    )
    # No extra days drops the parenthesis, and the plural follows the numbers.
    assert _sentence(
        {**SIZED_JOB, 'drying_days': 1, 'dehumidifiers': 2},
        uncertain(assist=dict(extra_drying_days=0)),
    ) == (
        'The high end allows for up to 4 air movers and 2 dehumidifiers for 1 drying day, the '
        'larger of the counts entered and what the IICRC S500 placement recommends for the stated '
        'room sizes, and hidden damage of 15% in category 2 rooms.'
    )
    # Fractional percents print as the owner typed them.
    assert _sentence(
        SIZED_JOB, uncertain(assist=dict(hidden_damage_percent={'1': '0', '2': '12.50', '3': '0'}))
    ).endswith('and hidden damage of 12.5% in category 2 rooms.')


def test_the_sentence_says_the_s500_most_only_when_the_counts_are_the_checks():
    # Above the maximum, unsized and unrated counts are the technician's, not the placement's.
    for values in (
        {**SIZED_JOB, 'air_movers': 7},
        {**SIZED_JOB, 'dehumidifier_ppd': None},
        {**SIZED_JOB, 'rooms': [room('Hall', **{**SIZED_ROOM, 'wet_floor_sf': 0})]},
    ):
        text = _sentence(values)
        assert 'the most the IICRC' not in text
        assert 'the larger of the counts entered and what the IICRC S500 placement' in text
    # With the check available a count of zero is still named.
    assert _sentence({**SIZED_JOB, 'dehumidifiers': 0, 'dehumidifier_ppd': None}).startswith(
        'The high end allows for up to 4 air movers and 0 dehumidifiers for 4 drying days (1 more '
        'than planned), the larger of'
    )
    zero = uncertain(assist=dict(extra_drying_days=0))
    assert _sentence(
        {
            **SIZED_JOB,
            'rooms': [room('Hall', **{**SIZED_ROOM, 'wet_floor_sf': 0})],
            'air_movers': 0,
            'dehumidifiers': 0,
            'dehumidifier_ppd': None,
        },
        zero,
    ).startswith(
        'The high end allows for up to 0 air movers and 0 dehumidifiers for 3 drying days, the '
        'larger of the counts entered and what the IICRC S500 placement recommends for the stated '
        'room sizes, and hidden damage'
    )
    # Only an unavailable check drops the counts and the S500 clause, zero counts or not.
    assert _sentence(without_sizing(air_movers=0, dehumidifiers=0), zero) == (
        'The high end allows for the equipment counts as entered for 3 drying days, and hidden '
        'damage of 15% in category 2 rooms.'
    )


def test_the_sentence_is_omitted_when_the_two_amounts_are_equal():
    flat = dict(extra_drying_days=0, hidden_damage_percent={'1': '0', '2': '0', '3': '0'})
    within = {**SIZED_JOB, 'air_movers': 4}
    result = priced_on(job(**within), uncertain(assist=flat))
    assert result['low']['total'] == result['high']['total']
    assert result['range_explanation'] is None
    # A percent on a category the job does not have changes nothing, so it is not named.
    other = dict(flat, hidden_damage_percent={'1': '10', '2': '0', '3': '25'})
    assert priced_on(job(**within), uncertain(assist=other))['range_explanation'] is None
    # Any one difference brings it back.
    assert priced_on(job(**SIZED_JOB), uncertain(assist=flat))['range_explanation'].startswith(
        'The high end allows for up to 4 air movers'
    )
    assert priced_on(job(**within), uncertain(assist=dict(flat, extra_drying_days=1)))[
        'range_explanation'
    ]
    assert priced_on(
        job(**within),
        uncertain(assist=dict(flat, hidden_damage_percent=UNCERTAIN['hidden_damage_percent'])),
    )['range_explanation'].endswith('and hidden damage of 15% in category 2 rooms.')


def test_the_explanation_paragraph_prices_the_same_clause():
    result = priced_on(
        job(**{**SIZED_JOB, 'is_after_hours': True}),
        uncertain(overhead_profit_percent='10', sales_tax={'enabled': True, 'percent': '8'}),
    )
    assert result['explanation'] == (
        'The low amount is the itemized total at the equipment counts and drying days entered. '
        'The high amount prices up to 4 air movers and 1 dehumidifier for 4 drying days (1 more '
        'than planned) and adds the hidden-damage allowance above to labor and materials. '
        'Job charges and approved additional work are the same in both amounts. '
        'Both amounts include an after-hours adjustment of 20% of labor and materials. '
        'Both amounts include overhead and profit at 10%. '
        'Sales tax at 8% applies to the items marked taxable and their share of overhead and profit.'
    )
    unavailable = priced_on(job(**without_sizing()), uncertain())
    assert unavailable['explanation'].startswith(
        'The low amount is the itemized total at the equipment counts and drying days entered. '
        'The high amount prices the equipment counts as entered for 4 drying days (1 more than '
        'planned) and adds'
    )


def test_sample_jobs_state_sizing_inputs_and_still_hold_no_workbook_values():
    small, medium, large = (
        InspectionData.model_validate(sample['data']) for sample in pricing_v2.SAMPLE_JOBS
    )
    for data in (small, medium, large):
        assert data.dehumidifier_ppd == 70
        for current in data.rooms:
            assert current.ceiling_height_ft == 8 and current.water_class == 2
    # The water samples are sized; the mold sample has no water room to size.
    for data, status in ((small, 'available'), (medium, 'available'), (large, 'not_applicable')):
        assert pricing_v2.high_numbers(data, UNCERTAIN)['sizing_available'] is (
            status == 'available'
        )
    # Small: 200 sq ft x 8 ft / 50 = 32 pints; 150 wet sq ft: at most 1 + 3 = 4 air movers.
    numbers = pricing_v2.high_numbers(small, UNCERTAIN)
    assert (numbers['air_movers'], numbers['dehumidifiers']) == (4, 1)
    # Stating the inputs moves no cushion price.
    bare = copy.deepcopy(pricing_v2.SAMPLE_JOBS[0]['data'])
    del bare['dehumidifier_ppd']
    for current in bare['rooms']:
        del current['ceiling_height_ft'], current['water_class']
    assert (
        priced_on(small, table())['high']
        == priced_on(InspectionData.model_validate(bare), table())['high']
    )
    workbook_words = {row['description'].lower() for row in price_books.ITEMS}
    for sample in pricing_v2.SAMPLE_JOBS:
        text = f'{sample["label"]} {sample["description"]}'.lower()
        assert not any(word in text for word in workbook_words)


def test_the_editors_sample_jobs_price_the_high_end_from_the_table():
    from backend import price_book_store

    items = copy.deepcopy(ITEMS)
    cushion = {row['key']: row for row in price_book_store._sample_jobs(table(items))}
    built = {row['key']: row for row in price_book_store._sample_jobs(uncertain(items))}
    assert built['small']['low'] == cushion['small']['low']
    # 250 sq ft of category 1: the area lines carry 10%, not the cushion's 50%, and the 4 air
    # movers and 1 dehumidifier gain a day.
    data = InspectionData.model_validate(pricing_v2.SAMPLE_JOBS[0]['data'])
    expected = priced_on(data, uncertain(items))['high']['total']
    assert built['small']['high'] == f'${expected:,.2f}'
    assert built['small']['high'] != cushion['small']['high']
