from tests.pricing_v2_support import (
    APPROVED_EXTRA,
    D,
    EXAMPLE_A,
    EXAMPLE_D,
    FULL_ROOM,
    ITEMS,
    InspectionData,
    SCAN_ITEMS,
    _item,
    _quantities,
    _quantity,
    adr_rates,
    claims,
    copy,
    job,
    price_books,
    price_table,
    priced,
    pricing,
    pricing_v2,
    pytest,
    random,
    random_table,
    room,
    run,
    table,
)


@pytest.mark.parametrize(
    'source,changes,expected',
    [
        ('room:demolition:unfinished', {}, 11.0),
        ('room:demolition:finished', {}, 22.0),
        ('room:wet_floor', {}, 33.0),
        ('room:floor', {}, 44.0),
        ('room:basis', {}, 33.0),  # demolition basis: 11 + 22
    ],
)
def test_quantity_sources_read_the_room_fields(source, changes, expected):
    quantities, _ = _quantity(job([room(**FULL_ROOM, **changes)]), source)
    assert quantities == [expected]

@pytest.mark.parametrize(
    'field,unit',
    [
        ('emergency_calls', 'each'),
        ('monitoring_hours', 'hour'),
        ('haul_loads', 'load'),
        ('air_scrubbers', 'day'),
        ('hepa_filters', 'each'),
        ('matterport_scans', 'each'),
        ('dump_truck_loads', 'each'),
        ('equipment_decon', 'each'),
        ('power_distribution', 'each'),
        ('labor_hours', 'hour'),
    ],
)
def test_quantity_sources_read_every_job_field(field, unit):
    zeroed = {name: 0 for name in price_table.FIELD_SOURCES}
    zeroed[field] = 7
    quantities, _ = _quantity(job(**zeroed), f'field:{field}', unit=unit)
    assert quantities == [7.0]
    zeroed[field] = 0
    assert _quantity(job(**zeroed), f'field:{field}', unit=unit)[0] == []

@pytest.mark.parametrize(
    'pair,count_field,days_field',
    [
        ('air_movers*drying_days', 'air_movers', 'drying_days'),
        ('dehumidifiers*drying_days', 'dehumidifiers', 'drying_days'),
        ('wood_floor_systems*wood_floor_days', 'wood_floor_systems', 'wood_floor_days'),
    ],
)
def test_quantity_sources_read_counts_times_days(pair, count_field, days_field):
    data = job(**{count_field: 3, days_field: 4})
    quantities, _ = _quantity(data, f'count_days:{pair}', unit='unit_day', group='drying_equipment')
    assert quantities == [12.0]

def test_quantity_sources_edge_rules():
    # room:basis under the wet-floor basis, and the wet-floor fallback to floor then zero.
    wet = {'area_basis': 'wet_floor'}
    assert _quantity(job([room(**FULL_ROOM)]), 'room:basis', chosen_policy=wet)[0] == [33.0]
    fallback = job([room(unfinished_sf=11, floor_sf=44)])
    assert _quantity(fallback, 'room:wet_floor')[0] == [44.0]
    assert _quantity(fallback, 'room:basis', chosen_policy=wet)[0] == [44.0]
    # A stated zero wet floor is zero: it does not fall back to the floor area.
    stated = job([room(unfinished_sf=11, floor_sf=44, wet_floor_sf=0)])
    assert _quantity(stated, 'room:wet_floor')[0] == []
    # Clearing a walkthrough-filled wet floor records entered 0 but leaves the room blank: whole floor.
    cleared = job(
        [room(unfinished_sf=11, floor_sf=120)],
        quantity_overrides={
            'Room:wet_floor_sf': {'measured': '40', 'entered': '0', 'reason': 'Whole floor wet'}
        },
    )
    assert _quantity(cleared, 'room:wet_floor')[0] == [120.0]
    assert _quantity(cleared, 'room:basis', chosen_policy=wet)[0] == [120.0]
    # An entered value on a room that holds one still wins.
    changed = job(
        [room(unfinished_sf=11, floor_sf=120, wet_floor_sf=60)],
        quantity_overrides={
            'Room:wet_floor_sf': {'measured': '40', 'entered': '60', 'reason': 'More of it wet'}
        },
    )
    assert _quantity(changed, 'room:wet_floor')[0] == [60.0]

    # after_hours is 1 with the flag, 0 without.
    assert _quantity(job(is_after_hours=True), 'after_hours', 'each', 'job_charges')[0] == [1.0]
    assert _quantity(job(), 'after_hours', 'each', 'job_charges')[0] == []

    # typed reads scope_items, else the default; an entered zero is zero.
    typed = dict(default_quantity='4')
    assert _quantity(job(), 'typed', 'each', **typed)[0] == [4.0]
    entered = job(scope_items={'probe': {'quantity': '2.5'}})
    assert _quantity(entered, 'typed', 'each', **typed)[0] == [2.5]
    cleared = job(scope_items={'probe': {'quantity': '0'}})
    assert _quantity(cleared, 'typed', 'each', **typed)[0] == []

    # typed_count_days reads count x days, else zero.
    equipment = dict(unit='unit_day', group='drying_equipment')
    assert _quantity(job(), 'typed_count_days', **equipment)[0] == []
    counted = job(scope_items={'probe': {'count': 2, 'days': 5}})
    assert _quantity(counted, 'typed_count_days', **equipment)[0] == [10.0]

    # Room sources price only matching rooms; job sources need one matching room.
    rooms = [room('One', 1, unfinished_sf=10), room('Three', 3, unfinished_sf=20)]
    only_three = dict(categories=[3])
    assert _quantity(job(rooms), 'room:demolition:unfinished', **only_three)[0] == [20.0]
    assert _quantity(job(rooms), 'field:emergency_calls', 'each', **only_three)[0] == [1.0]
    assert _quantity(job(rooms[:1]), 'field:emergency_calls', 'each', **only_three)[0] == []

def test_lines_carry_the_document_fields_in_group_then_sort_order():
    rows = priced(
        ITEMS,
        labor={'sort_order': 2, 'xactimate_code': 'WTR LAB'},
        trip={'customer_description': 'Service call to the property'},
    )
    rows.append(
        _item(
            'second_labor', 'labor', 'Second labor', 'hour', 'field:labor_hours', '10', sort_order=1
        )
    )
    lines, _, _ = run(job([room(finished_sf=10)], labor_hours=1), table(rows))
    assert lines[0]['description'] == 'Service call to the property'
    assert [line['item_id'] for line in lines if line['group'] == 'labor'] == [
        'second_labor',
        'labor',
    ]
    groups = [line['group'] for line in lines]
    assert groups == sorted(groups, key=price_table.GROUPS.index)
    wall = next(line for line in lines if line['room'])
    assert wall == {
        'code': 'DEMO-C2-FIN',
        'item_id': 'demo_c2_fin',
        'group': 'demolition',
        'bucket': 'labor_material',
        'description': 'Room: Category 2 drywall and trim removal',
        'quantity': 10.0,
        'unit': 'sf',
        'unit_price': 3.0,
        'waste_percent': 0.0,
        'total': 30.0,
        'taxable': False,
        'xactimate_code': '',
        'room': 'Room',
        'area': 10.0,
    }
    labor = next(line for line in lines if line['item_id'] == 'labor')
    assert labor['xactimate_code'] == 'WTR LAB'
    assert labor['room'] is None and labor['area'] is None

def test_warnings_are_advisory_and_unknown_items_are_not_priced():
    data = job(
        [room('Empty', 2)],
        scope_items={'gone_item': {'quantity': '5'}},
        quantity_overrides={
            'Attic:finished_sf': {
                'measured': '1',
                'entered': '2',
                'reason': 'Room was removed',
            },
            'not_a_field': {'measured': '1', 'entered': '2', 'reason': 'Unknown field'},
        },
    )
    lines, warnings = pricing_v2.price_scope(data, table())
    assert 'gone_item' not in {line['item_id'] for line in lines}
    assert {'code': 'unknown_scope_item', 'item_id': 'gone_item'} in warnings
    assert {'code': 'missing_area', 'item_id': 'demo_c2_fin', 'room': 'Empty'} in warnings
    assert {'code': 'unknown_quantity_override', 'key': 'Attic:finished_sf'} in warnings
    assert {'code': 'unknown_quantity_override', 'key': 'not_a_field'} in warnings

    # The working-copy preview runs the same engine: a blank enabled item is skipped and named.
    rows = priced(ITEMS, scan={'unit_price': ''})
    draft = price_table.normalize_table({'items': rows, 'policy': table()['policy']}, publish=False)
    lines, warnings = pricing_v2.price_scope(job(matterport_scans=1), draft)
    assert 'scan' not in {line['item_id'] for line in lines}
    assert {'code': 'blank_price_item', 'item_id': 'scan'} in warnings

    # Disabled items are never priced, and a key for one is not "unknown".
    rows = priced(ITEMS, odor_off={}) + [
        _item('odor_off', 'treatment', 'Odor', 'each', 'typed', '9', enabled=False)
    ]
    lines, warnings = pricing_v2.price_scope(
        job(scope_items={'odor_off': {'quantity': '1'}}), table(rows)
    )
    assert 'odor_off' not in {line['item_id'] for line in lines}
    assert not [warning for warning in warnings if warning['code'] == 'unknown_scope_item']

def test_the_extras_item_supplies_the_rate_and_is_never_priced_by_quantity():
    rows = priced(ITEMS, extra_work={'default_quantity': '5'})
    data = job(scope_items={'extra_work': {'quantity': '8'}})
    lines, warnings = pricing_v2.price_scope(data, table(rows))
    assert 'extra_work' not in {line['item_id'] for line in lines}
    assert warnings == [{'code': 'unpriced_extras_quantity', 'item_id': 'extra_work'}]

@pytest.mark.parametrize(
    'default,scope,warned',
    [
        ('0', None, False),
        ('0', {'quantity': '0'}, False),
        ('5', None, True),
        ('5', {'quantity': '0'}, True),
        ('0', {'quantity': '8'}, True),
    ],
)
def test_an_extras_quantity_that_will_not_be_priced_is_named(default, scope, warned):
    rows = priced(ITEMS, extra_work={'default_quantity': default})
    data = job(scope_items={'extra_work': scope} if scope else None)
    lines, warnings = pricing_v2.price_scope(data, table(rows))
    assert 'extra_work' not in {line['item_id'] for line in lines}
    expected = {'code': 'unpriced_extras_quantity', 'item_id': 'extra_work'}
    assert (expected in warnings) is warned

def test_a_blank_priced_extras_item_is_named_for_both_problems():
    rows = priced(ITEMS, extra_work={'default_quantity': '5', 'unit_price': ''})
    draft = price_table.normalize_table({'items': rows, 'policy': table()['policy']}, publish=False)
    _, warnings = pricing_v2.price_scope(job(), draft)
    assert {'code': 'unpriced_extras_quantity', 'item_id': 'extra_work'} in warnings
    assert {'code': 'blank_price_item', 'item_id': 'extra_work'} in warnings

def test_a_disabled_extras_item_is_not_named():
    rows = priced(ITEMS, extra_work={'default_quantity': '5', 'enabled': False})
    _, warnings = pricing_v2.price_scope(job(), table(rows))
    assert warnings == []

@pytest.mark.parametrize(
    'changes,taxable,tax',
    [
        ({'taxable': True}, True, '55.60'),  # 8% of 570 equipment + 125
        ({'taxable': False}, False, '45.60'),  # 8% of 570 equipment
        ({'taxable': True, 'enabled': False}, False, '45.60'),
    ],
)
def test_an_approved_extra_is_taxable_as_the_enabled_extras_item_is(changes, taxable, tax):
    chosen = table(priced(ITEMS, extra_work=changes), sales_tax={'enabled': True, 'percent': '8'})
    lines, result, _ = run(job(**EXAMPLE_A, extras=[APPROVED_EXTRA]), chosen)
    assert lines[-1]['code'] == 'EXTRA'
    assert lines[-1]['taxable'] is taxable
    assert lines[-1]['xactimate_code'] == ''
    assert result['low']['tax'] == D(tax)
    assert result['high']['tax'] == D(tax)

def test_an_approved_extra_is_not_taxable_with_no_extras_item():
    rows = [row for row in ITEMS if row['group'] != 'extras']
    chosen = table(rows, sales_tax={'enabled': True, 'percent': '8'})
    lines, result, _ = run(job(**EXAMPLE_A, extras=[APPROVED_EXTRA]), chosen)
    assert lines[-1]['code'] == 'EXTRA' and lines[-1]['taxable'] is False
    assert result['low']['tax'] == D('45.60')

def test_the_monotonicity_tables_tax_the_extras_row_in_some_cases():
    rng = random.Random(20261102)
    flags = {
        next(row for row in random_table(rng)['items'] if row['group'] == 'extras')['taxable']
        for _ in range(50)
    }
    assert flags == {True, False}

def test_an_unset_job_number_prices_nothing_when_the_item_has_no_default():
    omitted = InspectionData.model_validate(dict(rooms=[room(finished_sf=100)]))
    assert omitted.monitoring_hours == 13.25 and omitted.air_scrubbers == 1
    assert _quantities(omitted, table(SCAN_ITEMS)) == {}

def test_an_unset_job_number_prices_the_owners_default_quantity():
    rows = priced(
        SCAN_ITEMS,
        monitor={'default_quantity': '2'},
        scrubber={'default_quantity': '3'},
        filter={'default_quantity': '4'},
        air_mover={'default_quantity': '6'},
    )
    chosen = table(rows)
    omitted = InspectionData.model_validate(dict(rooms=[room(finished_sf=100)]))
    assert _quantities(omitted, chosen) == {
        'monitor': 2.0,
        'scrubber': 3.0,
        'filter': 4.0,
        'air_mover': 6.0,
    }
    # Either number of a count and days source being unset prices the default, not the product.
    for partial in ({'air_movers': 2}, {'drying_days': 5}):
        data = InspectionData.model_validate(dict(rooms=[room(finished_sf=100)], **partial))
        assert _quantities(data, chosen)['air_mover'] == 6.0

def test_an_explicit_job_number_wins_over_the_default_quantity():
    chosen = table(
        priced(
            SCAN_ITEMS,
            monitor={'default_quantity': '2'},
            scrubber={'default_quantity': '3'},
            air_mover={'default_quantity': '6'},
        )
    )
    data = InspectionData.model_validate(
        dict(monitoring_hours=5, air_scrubbers=0, air_movers=2, drying_days=4)
    )
    found = _quantities(data, chosen)
    assert found['monitor'] == 5.0 and found['air_mover'] == 8.0
    assert 'scrubber' not in found

    # The estimator's entered number counts as set, on its own or as one side of a product.
    entered = dict(measured='1', entered='7', reason='Measured again')
    data = InspectionData.model_validate(
        dict(
            drying_days=2,
            quantity_overrides={'monitoring_hours': entered, 'air_movers': entered},
        )
    )
    found = _quantities(data, chosen)
    assert found['monitor'] == 7.0 and found['air_mover'] == 14.0
    # An override of only one side leaves the other unset, so the default still prices.
    data = InspectionData.model_validate(dict(quantity_overrides={'air_movers': entered}))
    assert _quantities(data, chosen)['air_mover'] == 6.0

def test_entered_quantity_overrides_the_walkthrough_measurement():
    override = dict(measured='3', entered='5', reason='Added two fans for the hallway')
    data = job(air_movers=3, quantity_overrides={'air_movers': override})
    lines, _, _ = run(data)
    assert next(line for line in lines if line['item_id'] == 'air_mover')['quantity'] == 15.0

    days = dict(measured='3', entered='4', reason='Slow drying in the hallway')
    data = job(air_movers=2, quantity_overrides={'drying_days': days})
    lines, _, _ = run(data)
    assert next(line for line in lines if line['item_id'] == 'air_mover')['quantity'] == 8.0

    hours = dict(measured='10', entered='12.5', reason='Second visit needed')
    data = job(quantity_overrides={'monitoring_hours': hours})
    lines, _, _ = run(data)
    assert next(line for line in lines if line['item_id'] == 'monitor')['total'] == 625.0

    # Room fields are keyed "<room>:<field>", compared as room names are, and only touch that room.
    wall = dict(measured='120', entered='160', reason='Behind the pantry')
    data = job(
        [room('  kitchen ', finished_sf=120), room('Hall', finished_sf=120)],
        quantity_overrides={'Kitchen:finished_sf': wall},
    )
    lines, _, warnings = run(data)
    by_room = {line['room']: line for line in lines if line['room']}
    assert by_room['  kitchen ']['quantity'] == 160.0
    assert by_room['  kitchen ']['area'] == 160.0
    assert by_room['Hall']['quantity'] == 120.0
    assert not [warning for warning in warnings if warning['code'] == 'unknown_quantity_override']

    # A room name may hold a colon: the field is the part after the last one.
    wall = dict(measured='1', entered='9', reason='Measured again')
    data = job(
        [room('Unit: 4', finished_sf=1)],
        quantity_overrides={'Unit: 4:finished_sf': wall},
    )
    assert next(line for line in run(data)[0] if line['room'])['quantity'] == 9.0

    # An override to zero removes the line.
    zero = dict(measured='3', entered='0', reason='Fans were not used')
    lines, _, _ = run(job(air_movers=3, quantity_overrides={'air_movers': zero}))
    assert 'air_mover' not in {line['item_id'] for line in lines}

    # A typed item's entered quantity is what prices; the measured one is only kept.
    typed = priced(ITEMS) + [_item('odor', 'treatment', 'Odor', 'each', 'typed', '10')]
    data = job(
        scope_items={
            'odor': {'quantity': '6', 'measured_quantity': '2', 'override_reason': 'Whole house'}
        }
    )
    lines, _, _ = run(data, table(typed))
    assert next(line for line in lines if line['item_id'] == 'odor')['quantity'] == 6.0

def test_zero_total_and_unbucketed_guards():
    nothing = job(emergency_calls=0, monitoring_hours=0, haul_loads=0)
    lines, _ = pricing_v2.price_scope(nothing, table())
    assert lines == []
    message = r'^The priced scope totals \$0\.00\. Enter at least one quantity or room measurement before auditing\.$'
    with pytest.raises(ValueError, match=message):
        pricing_v2.totals(nothing, lines, table()['policy'], table()['items'])
    with pytest.raises(ValueError, match=message):
        pricing.price_and_range(nothing, {'calculation_version': 'dryscope-v2', **table()})

    # A minimum job charge must not turn an empty job into a signable one.
    minimum = table(minimum_job_charge='500')
    with pytest.raises(ValueError, match=message):
        pricing_v2.totals(nothing, [], minimum['policy'], minimum['items'])

    lines, _ = pricing_v2.price_scope(job(), table())
    lines.append(dict(lines[0], code='NEW-CODE', bucket='mystery'))
    with pytest.raises(RuntimeError, match='NEW-CODE'):
        pricing_v2.totals(job(), lines, table()['policy'], table()['items'])

    # A group outside the closed bucket table fails at line creation too.
    corrupt = table()
    corrupt['items'][0]['group'] = 'mystery'
    with pytest.raises(RuntimeError, match='mystery'):
        pricing_v2.price_scope(job(), corrupt)

def test_v1_dispatch_unchanged():
    rates = adr_rates()
    data = InspectionData.model_validate(
        dict(
            rooms=[room(unfinished_sf=140, finished_sf=5)],
            is_after_hours=True,
            air_movers=3,
            dehumidifiers=1,
        )
    )
    result = pricing.price_and_range(
        data, {'calculation_version': 'adr-residential-v1', 'rates': rates}
    )
    lines, total = claims.price_scope(data, rates)
    assert result.lines == lines
    assert result.xactimate_total == total
    assert (result.low, result.high) == claims.proposal_range(data, lines)
    assert result.totals is None
    assert result.calculation_version == 'adr-residential-v1'
    # Today's pinned workbook example.
    assert (result.low, result.high) == (D('2219.90'), D('2356.25'))

def test_v2_dispatch_returns_the_engine_result():
    chosen = table(overhead_profit_percent='10', sales_tax={'enabled': True, 'percent': '8'})
    result = pricing.price_and_range(
        job(**EXAMPLE_D), {'calculation_version': 'dryscope-v2', **chosen}
    )
    assert result.calculation_version == 'dryscope-v2'
    assert result.low == D('8495.08')
    assert result.high == D('11902.00')
    assert result.xactimate_total == 8495.08
    assert result.totals['mode'] == 'range'
    assert result.lines[0]['item_id'] == 'trip'
    # Warnings pass through: this kitchen has no floor demolition for the category 3 floor item.
    assert result.warnings == [
        {'code': 'missing_area', 'item_id': 'demo_c3_sub', 'room': 'Kitchen'}
    ]

    single = table(estimate_mode='single')
    result = pricing.price_and_range(
        job(**EXAMPLE_A), {'calculation_version': 'dryscope-v2', **single}
    )
    assert result.low == D('2880.00') and result.high is None

def test_sample_jobs_contain_no_workbook_values():
    keys = [sample['key'] for sample in pricing_v2.SAMPLE_JOBS]
    assert keys == ['small', 'medium', 'large']
    workbook_words = {row['description'].lower() for row in price_books.ITEMS}
    for sample in pricing_v2.SAMPLE_JOBS:
        data = InspectionData.model_validate(sample['data'])
        # Quantities the workbook seeds as defaults must not leak in through the model's defaults.
        assert data.monitoring_hours != 13.25
        assert data.air_scrubbers == 0 and data.hepa_filters == 0
        text = f'{sample["label"]} {sample["description"]}'.lower()
        assert 'adr' not in text.split() and 'workbook' not in text
        assert not any(word in text for word in workbook_words)
        assert sample['label'] != pricing_v2.SAMPLE_NOTICE
        assert sample['notice'] == 'Sample job only. This does not price a saved job.'
    assert pricing_v2.SAMPLE_NOTICE == 'Sample job only. This does not price a saved job.'

    small, medium, large = (
        InspectionData.model_validate(sample['data']) for sample in pricing_v2.SAMPLE_JOBS
    )
    assert (small.rooms[0].category, small.rooms[0].finished_sf, small.rooms[0].unfinished_sf) == (
        1,
        150,
        100,
    )
    assert (small.rooms[0].floor_sf, small.rooms[0].wet_floor_sf) == (200, 150)
    assert (small.air_movers, small.dehumidifiers, small.drying_days) == (4, 1, 3)
    assert (small.emergency_calls, small.haul_loads, small.labor_hours) == (1, 1, 0)
    assert (medium.rooms[0].category, medium.rooms[0].finished_sf) == (2, 1000)
    assert (medium.rooms[0].floor_sf, medium.rooms[0].wet_floor_sf) == (1200, 1000)
    assert (medium.air_movers, medium.dehumidifiers, medium.drying_days, medium.labor_hours) == (
        8,
        2,
        4,
        4,
    )
    assert [item.category for item in large.rooms] == [3, 3]
    assert sum(item.finished_sf for item in large.rooms) == 2000
    assert sum(item.unfinished_sf for item in large.rooms) == 500
    assert sum(item.custom_cabinetry for item in large.rooms) == 1
    assert (large.air_movers, large.dehumidifiers, large.drying_days, large.labor_hours) == (
        10,
        3,
        5,
        8,
    )
    assert large.is_after_hours is True

    # Each sample prices against a real table.
    for sample in pricing_v2.SAMPLE_JOBS:
        priced_job = pricing.price_and_range(
            InspectionData.model_validate(sample['data']),
            {'calculation_version': 'dryscope-v2', **table()},
        )
        assert priced_job.low > 0

def test_a_tables_default_quantity_never_reaches_a_sample():
    job_numbers = set(price_table.FIELD_SOURCES).union(*price_table.COUNT_DAYS_SOURCES)
    with_defaults = copy.deepcopy(SCAN_ITEMS)
    for row in with_defaults:
        if row['quantity_source'].startswith(('field:', 'count_days:')):
            row['default_quantity'] = '99'
    for sample in pricing_v2.SAMPLE_JOBS:
        data = InspectionData.model_validate(sample['data'])
        assert job_numbers <= data.model_fields_set
        assert (
            pricing_v2.price_scope(data, table(with_defaults))[0]
            == pricing_v2.price_scope(data, table(SCAN_ITEMS))[0]
        )

def test_a_typed_items_default_quantity_does_reach_a_sample():
    typed = copy.deepcopy(SCAN_ITEMS) + [
        {
            **copy.deepcopy(SCAN_ITEMS[0]),
            'item_id': 'typed_fee',
            'code': 'TYPED-FEE',
            'group': 'job_charges',
            'unit': 'each',
            'quantity_source': 'typed',
            'categories': [],
            'default_quantity': '2',
            'unit_price': '10.00',
            'enabled': True,
        }
    ]
    data = InspectionData.model_validate(pricing_v2.SAMPLE_JOBS[0]['data'])
    lines, _ = pricing_v2.price_scope(data, table(typed))
    assert next(line for line in lines if line['item_id'] == 'typed_fee')['total'] == 20.0

def test_the_mold_sample_states_its_floor_areas():
    large = InspectionData.model_validate(pricing_v2.SAMPLE_JOBS[2]['data'])
    assert sum(room.floor_sf for room in large.rooms) == 2500
    assert sum(room.wet_floor_sf for room in large.rooms) == 2500
    _, warnings = pricing_v2.price_scope(large, table(SCAN_ITEMS))
    assert not [row for row in warnings if row['code'] == 'missing_area']

def test_explanation_text_comes_from_the_policy():
    chosen = table()['policy']
    assert pricing_v2.explanation(chosen, job()) == (
        'The low amount is the itemized total. The high amount adds an allowance to labor and '
        'materials for conditions found during the work: 50% on the first 1,000 square feet of '
        'area-priced work (highest-priced areas first), 20% on area beyond that, and 50% on labor '
        'hours. Job charges, drying equipment and approved additional work are the same in both '
        'amounts.'
    )
    # The multiplier is only stated on after-hours jobs.
    stacked = table(overhead_profit_percent='10', sales_tax={'enabled': True, 'percent': '7.25'})
    text = pricing_v2.explanation(stacked['policy'], job(is_after_hours=True))
    assert text.endswith(
        'Both amounts include an after-hours adjustment of 20% of labor and materials. '
        'Both amounts include overhead and profit at 10%. '
        'Sales tax at 7.25% applies to the items marked taxable and their share of overhead and profit.'
    )
    # Without O&P, tax stays on the taxable items alone.
    text = pricing_v2.explanation(
        table(sales_tax={'enabled': True, 'percent': '8'})['policy'], job()
    )
    assert text.endswith('Sales tax at 8% applies to the items marked taxable.')

    single = table(estimate_mode='single')['policy']
    assert pricing_v2.explanation(single, job()) == 'The price covers the itemized scope below.'

    # The totals carry the text; the minimum shows as its own line and is not explained here.
    _, plain, _ = run(job(**EXAMPLE_A))
    assert plain['explanation'] == pricing_v2.explanation(table()['policy'], job(**EXAMPLE_A))
    assert 'minimum' not in plain['explanation'].lower()
    _, floored, _ = run(job(**EXAMPLE_A), table(minimum_job_charge='5000'))
    assert floored['low']['minimum_charge'] > 0
    assert 'minimum' not in floored['explanation'].lower()

@pytest.mark.parametrize(
    'first,beyond,expected',
    [
        (
            '50',
            '20',
            'The high end allows 50% extra on the first 1,000 sq ft of work and 20% beyond, for hidden damage.',
        ),
        (
            '50',
            '0',
            'The high end allows 50% extra on the first 1,000 sq ft of work, for hidden damage.',
        ),
        ('30', '30', 'The high end allows 30% extra on the work, for hidden damage.'),
        (
            '12.50',
            '5',
            'The high end allows 12.5% extra on the first 1,000 sq ft of work and 5% beyond, for hidden damage.',
        ),
        ('0', '0', None),
    ],
)
def test_range_explanation_names_the_cushion_tiers(first, beyond, expected):
    chosen = table(range={'first_sf': 1000, 'first_percent': first, 'beyond_percent': beyond})
    assert pricing_v2.range_explanation(chosen['policy'], job(**EXAMPLE_A)) == expected
    _, result, _ = run(job(**EXAMPLE_A), chosen)
    assert result['range_explanation'] == expected

def test_single_mode_has_no_range_explanation():
    chosen = table(estimate_mode='single')
    assert pricing_v2.range_explanation(chosen['policy'], job(**EXAMPLE_A)) is None
    assert run(job(**EXAMPLE_A), chosen)[1]['range_explanation'] is None
