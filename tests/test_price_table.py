"""Unit tests for the v2 owner-defined price table model, contracts and stub dispatch."""

import copy
import json
from decimal import Decimal
import pytest
from pydantic import ValidationError

from backend import claims, main as bm, price_books, price_table, pricing, scope
from backend.adr_price_book import adr_rates
from backend.contracts import (
    InspectionData,
    PriceBasis,
    PricingPolicy,
    QuantityOverride,
    ScopeQuantity,
    Extra,
)
from tests.test_workspaces import store  # noqa: F401


def _priced_starter():
    table = price_table.starter_table()
    for item in table['items']:
        if item['enabled']:
            item['unit_price'] = '25.00'
    return table


def test_starter_catalog_has_no_prices_and_nothing_from_the_workbook():
    table = price_table.starter_table()
    items = table['items']
    assert 1 <= len(items) <= price_table.MAX_ITEMS

    v1_descriptions = {row['description'].strip().lower() for row in price_books.ITEMS}
    v1_seeds = set(adr_rates().values())

    seen_ids = set()
    seen_codes = set()
    disabled_ids = set()

    for item in items:
        assert item['unit_price'] == ''
        assert item['name'].strip().lower() not in v1_descriptions
        assert item['default_quantity'] not in v1_seeds
        assert not item['code'].startswith('ADR-')
        assert item['item_id'] not in seen_ids
        assert item['code'] not in seen_codes
        seen_ids.add(item['item_id'])
        seen_codes.add(item['code'])
        parsed = price_table.parse_source(item['quantity_source'])
        assert parsed.kind in (
            'room',
            'field',
            'count_days',
            'after_hours',
            'typed',
            'typed_count_days',
        )
        if not item['enabled']:
            disabled_ids.add(item['item_id'])

    assert disabled_ids == {'testing_coordination'}
    policy = table['policy']
    assert policy['estimate_mode'] == 'range'
    assert policy['area_basis'] == 'demolition'
    assert policy['range'] == {'first_sf': 1000, 'first_percent': '50', 'beyond_percent': '20'}
    assert policy['after_hours'] == {
        'multiplier': '1.000',
        'label': 'After-hours adjustment',
    }
    assert policy['minimum_job_charge'] == '0'
    assert policy['overhead_profit_percent'] == '0'
    assert policy['sales_tax'] == {'enabled': False, 'percent': '0'}


def test_normalize_table_bounds_and_messages():
    # Working copy accepts blank prices on enabled items; publish rejects them.
    starter = price_table.starter_table()
    working = price_table.normalize_table(starter, publish=False)
    assert len(working['items']) == len(starter['items'])
    problems = price_table.publish_problems(working)
    assert problems and any('enter a unit price' in p['message'] for p in problems)

    with pytest.raises(ValueError, match='enter a unit price or disable'):
        price_table.normalize_table(starter, publish=True)

    valid = _priced_starter()
    normalized = price_table.normalize_table(valid, publish=True)
    assert len(normalized['items']) == len(valid['items'])

    # Duplicate item_id and duplicate code
    dup_id = copy.deepcopy(valid)
    dup_id['items'][1]['item_id'] = dup_id['items'][0]['item_id']
    with pytest.raises(ValueError, match='duplicate item_id'):
        price_table.normalize_table(dup_id, publish=False)

    dup_code = copy.deepcopy(valid)
    dup_code['items'][1]['code'] = dup_code['items'][0]['code']
    with pytest.raises(ValueError, match='duplicate code'):
        price_table.normalize_table(dup_code, publish=False)

    # Unknown quantity source
    bad_src = copy.deepcopy(valid)
    bad_src['items'][0]['quantity_source'] = 'field:unknown_metric'
    with pytest.raises(ValueError, match='Unknown quantity source'):
        price_table.normalize_table(bad_src, publish=False)

    # Demolition item with a non-room source
    bad_demo = copy.deepcopy(valid)
    demo_item = next(it for it in bad_demo['items'] if it['group'] == 'demolition')
    demo_item['quantity_source'] = 'typed'
    with pytest.raises(ValueError, match='demolition items must use a room quantity source'):
        price_table.normalize_table(bad_demo, publish=False)

    # Zero price without allow_zero or acknowledgement
    zero_disallowed = copy.deepcopy(valid)
    zero_disallowed['items'][0]['unit_price'] = '0.00'
    zero_disallowed['items'][0]['allow_zero'] = False
    with pytest.raises(ValueError, match='allow_zero'):
        price_table.normalize_table(zero_disallowed, publish=False)

    zero_unacked = copy.deepcopy(valid)
    zero_unacked['items'][0]['unit_price'] = '0.00'
    zero_unacked['items'][0]['allow_zero'] = True
    assert price_table.normalize_table(zero_unacked, publish=False)
    with pytest.raises(ValueError, match='confirm that a zero unit price'):
        price_table.normalize_table(zero_unacked, publish=True)
    assert price_table.normalize_table(
        zero_unacked, publish=True, acknowledgements=[zero_unacked['items'][0]['item_id']]
    )

    # Item field bounds (1.3)
    for field, bad_val, match in (
        ('item_id', 'Bad-Id', 'invalid item_id'),
        ('code', 'bad_code', 'invalid code'),
        ('group', 'plumbing', 'unknown group'),
        ('name', '', 'name must be 1 to 80'),
        ('name', 'x' * 81, 'name must be 1 to 80'),
        ('customer_description', 'x' * 301, 'customer_description must be'),
        ('unit', 'gallon', 'unknown unit'),
        ('unit_price', '100000.01', 'unit_price must be between'),
        ('unit_price', '10.123', 'unit_price'),
        ('default_quantity', '100001', 'default_quantity must be between'),
        ('waste_percent', '101', 'waste_percent must be between'),
        ('categories', [1, 4], 'categories must be distinct'),
        ('categories', [2, 2], 'categories must not contain duplicates'),
        ('xactimate_code', 'bad*code', 'invalid xactimate_code'),
        ('sort_order', 10001, 'sort_order must be an integer from 0 to 10000'),
    ):
        broken = copy.deepcopy(valid)
        broken['items'][0][field] = bad_val
        with pytest.raises(ValueError, match=match):
            price_table.normalize_table(broken, publish=False)

    # More than 150 items
    too_many = copy.deepcopy(valid)
    while len(too_many['items']) <= price_table.MAX_ITEMS:
        idx = len(too_many['items'])
        extra = copy.deepcopy(valid['items'][0])
        extra['item_id'] = f'custom_item_{idx}'
        extra['code'] = f'CUST-{idx}'
        too_many['items'].append(extra)
    with pytest.raises(ValueError, match='at most 150 items'):
        price_table.normalize_table(too_many, publish=False)

    # Policy bounds (1.5, 3.11, and Captain additions)
    beyond_gt_first = copy.deepcopy(valid)
    beyond_gt_first['policy']['range'] = {
        'first_sf': 1000,
        'first_percent': '20',
        'beyond_percent': '50',
    }
    with pytest.raises(
        ValueError,
        match='The cushion beyond the first square feet cannot exceed the cushion on them',
    ):
        price_table.normalize_table(beyond_gt_first, publish=False)

    for mutate, match in (
        (lambda p: p.update(estimate_mode='tiered'), 'estimate_mode'),
        (lambda p: p.update(area_basis='ceiling'), 'area_basis'),
        (lambda p: p['range'].update(first_sf=0), 'range.first_sf'),
        (lambda p: p['range'].update(first_sf=100001), 'range.first_sf'),
        (lambda p: p['range'].update(first_percent='101'), 'range.first_percent'),
        (lambda p: p['after_hours'].update(multiplier='0.95'), 'after_hours.multiplier'),
        (lambda p: p['after_hours'].update(multiplier='2.001'), 'after_hours.multiplier'),
        (lambda p: p['after_hours'].update(label=''), 'after_hours.label'),
        (lambda p: p['after_hours'].update(label='x' * 81), 'after_hours.label'),
        (lambda p: p['category_multipliers'].update({'1': '3.5'}), 'category_multipliers.1'),
        (lambda p: p['cabinetry'].update(multiplier='0.5'), 'cabinetry.multiplier'),
        (lambda p: p['cabinetry'].update(scope='none'), 'cabinetry.scope'),
        (lambda p: p.update(minimum_job_charge='100000.01'), 'minimum_job_charge'),
        (lambda p: p.update(minimum_job_charge='-5'), 'minimum_job_charge'),
        (lambda p: p.update(overhead_profit_percent='30.01'), 'overhead_profit_percent'),
        (lambda p: p['sales_tax'].update(percent='15.001'), 'sales_tax.percent'),
        (lambda p: p['sales_tax'].update(enabled='yes'), 'sales_tax.enabled'),
        (lambda p: p.update(show_line_breakdown='yes'), 'show_line_breakdown'),
    ):
        broken_pol = copy.deepcopy(valid)
        mutate(broken_pol['policy'])
        with pytest.raises(ValueError, match=match):
            price_table.normalize_table(broken_pol, publish=False)


def test_content_hash_is_order_independent_and_includes_disabled_items_and_policy():
    table = _priced_starter()
    reversed_table = {
        'items': list(reversed(copy.deepcopy(table['items']))),
        'policy': copy.deepcopy(table['policy']),
    }
    digest = price_table.content_hash(table)
    assert price_table.content_hash(reversed_table) == digest

    # Disabled items are included in the hash
    toggled = copy.deepcopy(table)
    disabled_item = next(it for it in toggled['items'] if not it['enabled'])
    disabled_item['unit_price'] = '99.00'
    assert price_table.content_hash(toggled) != digest

    enabled_toggle = copy.deepcopy(table)
    enabled_toggle['items'][0]['enabled'] = False
    assert price_table.content_hash(enabled_toggle) != digest

    # Policy fields (including after-hours label and minimum job charge) are in the hash
    label_changed = copy.deepcopy(table)
    label_changed['policy']['after_hours']['label'] = 'Emergency after-hours surcharge'
    assert price_table.content_hash(label_changed) != digest

    min_changed = copy.deepcopy(table)
    min_changed['policy']['minimum_job_charge'] = '500.00'
    assert price_table.content_hash(min_changed) != digest

    op_changed = copy.deepcopy(table)
    op_changed['policy']['overhead_profit_percent'] = '10'
    assert price_table.content_hash(op_changed) != digest

    # Extras fingerprint only changes when the extras item changes
    fp = price_table.rate_fingerprint(table)
    assert price_table.rate_fingerprint(op_changed) == fp
    extras_changed = copy.deepcopy(table)
    extras_item = next(it for it in extras_changed['items'] if it['group'] == 'extras')
    extras_item['unit_price'] = '75.00'
    assert price_table.rate_fingerprint(extras_changed) != fp

    # public_table hides disabled items and owner-only keys unless manage=True
    estimator_view = price_table.public_table(table, manage=False)
    owner_view = price_table.public_table(table, manage=True)
    assert len(estimator_view['items']) == len(table['items']) - 1
    assert len(owner_view['items']) == len(table['items'])
    assert 'enabled' not in estimator_view['items'][0]
    assert 'allow_zero' not in estimator_view['items'][0]
    assert owner_view['items'][0]['enabled'] is True


def test_scope_items_absent_on_old_drafts_and_bounded(store):
    old_draft = InspectionData(address='100 Oak St')
    assert old_draft.scope_items is None
    assert old_draft.quantity_overrides is None
    dumped = bm.inspection_payload(old_draft)
    assert 'scope_items' not in dumped
    assert 'quantity_overrides' not in dumped

    # Office empty-scope rule still passes on a fresh draft
    created = store.create_inspection(
        'office',
        'ADR-INS-' + 'b' * 32,
        bm.inspection_payload(InspectionData(address='Office draft')),
    )
    assert 'scope_items' not in created['data']
    assert 'quantity_overrides' not in created['data']

    # Valid scope_items and estimator quantity overrides round-trip cleanly
    with_items = InspectionData(
        address='200 Pine St',
        scope_items={
            'containment': ScopeQuantity(quantity=Decimal('2.50')),
            'desiccant_dehumidifier': ScopeQuantity(count=2, days=4),
            'baseboard_removal': ScopeQuantity(
                quantity=Decimal('45.00'),
                measured_quantity=Decimal('30.00'),
                override_reason='Behind wet vanity and closet wall',
            ),
        },
        quantity_overrides={
            'air_movers': QuantityOverride(
                measured=Decimal('3'),
                entered=Decimal('5'),
                reason='Added two fans for hallway corner',
            ),
            'Kitchen:finished_sf': QuantityOverride(
                measured=Decimal('120.00'),
                entered=Decimal('160.00'),
                reason='Moisture extended behind pantry',
            ),
        },
    )
    payload = bm.inspection_payload(with_items)
    assert payload['scope_items']['containment'] == {'quantity': '2.50', 'count': 0, 'days': 0}
    assert payload['scope_items']['baseboard_removal']['measured_quantity'] == '30.00'
    assert (
        payload['scope_items']['baseboard_removal']['override_reason']
        == 'Behind wet vanity and closet wall'
    )
    assert payload['quantity_overrides']['air_movers'] == {
        'measured': '3',
        'entered': '5',
        'reason': 'Added two fans for hallway corner',
    }
    round_trip = InspectionData.model_validate(payload)
    assert round_trip.scope_items['containment'].quantity == Decimal('2.50')
    assert round_trip.quantity_overrides['air_movers'].entered == Decimal('5')

    # Missing or blank override reason is rejected
    with pytest.raises(ValidationError):
        ScopeQuantity(quantity=Decimal('20.00'), measured_quantity=Decimal('10.00'))
    with pytest.raises(ValidationError):
        QuantityOverride(measured=Decimal('3'), entered=Decimal('5'), reason='  ')

    # Invalid item_id and >150 entries in scope_items are rejected
    with pytest.raises(ValidationError):
        InspectionData(scope_items={'Bad-Key': ScopeQuantity(quantity=Decimal('1'))})
    with pytest.raises(ValidationError):
        InspectionData(
            scope_items={
                f'item_{i}': ScopeQuantity(quantity=Decimal('1'))
                for i in range(price_table.MAX_ITEMS + 1)
            }
        )


def test_price_basis_v2_requires_policy_and_v1_requires_rates():
    table = _priced_starter()
    digest = price_table.content_hash(table)

    v2_basis = PriceBasis(
        company_id='co_v2',
        version_id='v2_ver_1',
        sequence=1,
        content_sha256=digest,
        calculation_version='dryscope-v2',
        priced_at='2026-11-02T19:00:00+00:00',
        policy=PricingPolicy(**table['policy']),
        item_count=len(table['items']),
    )
    assert v2_basis.calculation_version == 'dryscope-v2'
    assert v2_basis.policy.after_hours.label == 'After-hours adjustment'
    assert v2_basis.policy.minimum_job_charge == '0'
    assert v2_basis.rates is None

    # v2 without policy or item_count or with rates is rejected
    with pytest.raises(ValidationError):
        PriceBasis(
            company_id='co_v2',
            version_id='v2_ver_1',
            sequence=1,
            content_sha256=digest,
            calculation_version='dryscope-v2',
            priced_at='2026-11-02T19:00:00+00:00',
            item_count=10,
        )
    with pytest.raises(ValidationError):
        PriceBasis(
            company_id='co_v2',
            version_id='v2_ver_1',
            sequence=1,
            content_sha256=digest,
            calculation_version='dryscope-v2',
            priced_at='2026-11-02T19:00:00+00:00',
            policy=PricingPolicy(**table['policy']),
        )
    with pytest.raises(ValidationError):
        PriceBasis(
            company_id='co_v2',
            version_id='v2_ver_1',
            sequence=1,
            content_sha256=digest,
            calculation_version='dryscope-v2',
            priced_at='2026-11-02T19:00:00+00:00',
            policy=PricingPolicy(**table['policy']),
            item_count=10,
            rates=adr_rates(),
        )

    # v1 requires rates and rejects policy or item_count
    v1_rates = adr_rates()
    v1_digest = price_books.content_hash(v1_rates)
    v1_basis = PriceBasis(
        company_id='adr',
        version_id='seed',
        sequence=0,
        content_sha256=v1_digest,
        calculation_version='adr-residential-v1',
        priced_at='2026-11-02T19:00:00+00:00',
        rates=v1_rates,
    )
    assert v1_basis.rates['emergency_call'] == '133.95'
    assert v1_basis.policy is None

    with pytest.raises(ValidationError):
        PriceBasis(
            company_id='adr',
            version_id='seed',
            sequence=0,
            content_sha256=v1_digest,
            calculation_version='adr-residential-v1',
            priced_at='2026-11-02T19:00:00+00:00',
        )
    with pytest.raises(ValidationError):
        PriceBasis(
            company_id='adr',
            version_id='seed',
            sequence=0,
            content_sha256=v1_digest,
            calculation_version='adr-residential-v1',
            priced_at='2026-11-02T19:00:00+00:00',
            rates=v1_rates,
            policy=PricingPolicy(**table['policy']),
        )


def test_pricing_dispatch_runs_v1_and_stubs_v2():
    job_data = InspectionData(
        address='10 Main St',
        rooms=[{'name': 'Kitchen', 'category': 2, 'finished_sf': 200}],
        air_movers=2,
        dehumidifiers=1,
        drying_days=3,
    )
    rates = adr_rates()
    result = pricing.price_and_range(
        job_data,
        {'calculation_version': 'adr-residential-v1', 'rates': rates},
    )
    expected_lines, expected_total = claims.price_scope(job_data, rates)
    expected_low, expected_high = claims.proposal_range(job_data, expected_lines)
    assert result.lines == expected_lines
    assert result.xactimate_total == expected_total
    assert (result.low, result.high) == (expected_low, expected_high)
    assert result.totals is None

    table = _priced_starter()
    with pytest.raises(NotImplementedError, match='dryscope-v2 pricing is not available yet'):
        pricing.price_and_range(
            job_data,
            {
                'calculation_version': 'dryscope-v2',
                'items': table['items'],
                'policy': table['policy'],
            },
        )


def _item(**changes):
    item = {
        'item_id': 'test_item',
        'code': 'TEST-ITEM',
        'group': 'labor',
        'name': 'Test item',
        'unit': 'hour',
        'quantity_source': 'typed',
        'unit_price': '10.00',
    }
    item.update(changes)
    return item


@pytest.mark.parametrize(
    'source,kind,count_field,days_field',
    [
        ('field:emergency_calls', 'field', None, None),
        ('field:monitoring_hours', 'field', None, None),
        ('field:haul_loads', 'field', None, None),
        ('field:labor_hours', 'field', None, None),
        ('field:matterport_scans', 'field', None, None),
        ('field:dump_truck_loads', 'field', None, None),
        ('field:decon_units', 'field', None, None),
        ('field:power_distribution', 'field', None, None),
        (
            'count_days:air_scrubbers*air_scrubber_days',
            'count_days',
            'air_scrubbers',
            'air_scrubber_days',
        ),
        ('count_days:hepa_filters*1', 'count_days', 'hepa_filters', '1'),
        ('count_days:air_movers*drying_days', 'count_days', 'air_movers', 'drying_days'),
        ('count_days:dehumidifiers*drying_days', 'count_days', 'dehumidifiers', 'drying_days'),
        (
            'count_days:wood_floor_systems*wood_floor_days',
            'count_days',
            'wood_floor_systems',
            'wood_floor_days',
        ),
    ],
)
def test_source_grammar_accepts_every_listed_form(source, kind, count_field, days_field):
    parsed = price_table.parse_source(source)
    assert (parsed.kind, parsed.count_field, parsed.days_field) == (kind, count_field, days_field)


@pytest.mark.parametrize(
    'source',
    ['count_days:hepa_filters*drying_days', 'count_days:air_movers', 'field:air_scrubber_days'],
)
def test_source_grammar_refuses_unlisted_forms(source):
    with pytest.raises(ValueError, match='Unknown quantity source'):
        price_table.parse_source(source)


@pytest.mark.parametrize(
    'source', ['field:air_scrubbers', 'field:hepa_filters', 'field:equipment_decon']
)
def test_source_grammar_refuses_equipment_counts_as_field_sources(source):
    with pytest.raises(ValueError, match='Unknown quantity source'):
        price_table.parse_source(source)


def test_every_starter_item_unit_matches_its_quantity_source():
    field_units = {
        'emergency_calls': {'each'},
        'monitoring_hours': {'hour'},
        'labor_hours': {'hour'},
        'haul_loads': {'load'},
        'matterport_scans': {'each'},
        'dump_truck_loads': {'each'},
        'decon_units': {'each'},
        'power_distribution': {'each'},
    }
    for item in price_table.starter_table()['items']:
        source = price_table.parse_source(item['quantity_source'])
        if source.kind == 'field':
            expected = field_units[source.field]
        elif source.kind == 'count_days':
            expected = {'day', 'unit_day'} if source.days_field.endswith('_days') else {'each'}
        elif source.kind == 'room':
            expected = {'sf'}
        elif source.kind == 'after_hours':
            expected = {'each'}
        elif source.kind == 'typed_count_days':
            expected = {'unit_day'}
        else:
            assert source.kind == 'typed'
            continue
        assert item['unit'] in expected, item['item_id']


def test_starter_monitoring_is_priced_by_the_hour():
    item = next(
        row for row in price_table.starter_table()['items'] if row['item_id'] == 'monitoring_visit'
    )
    assert item['unit'] == 'hour'
    assert item['name'] == 'Drying monitoring (per hour)'


def test_v1_mapping_uses_the_count_sources_for_equipment():
    table = price_table.from_v1_rates(adr_rates())
    sources = {item['item_id']: item['quantity_source'] for item in table['items']}
    assert sources['air_scrubber_daily'] == 'count_days:air_scrubbers*air_scrubber_days'
    assert sources['hepa_filter'] == 'count_days:hepa_filters*1'
    assert sources['equipment_decontamination'] == 'field:decon_units'


def test_item_id_and_code_patterns_match_the_specification():
    longest_id = 'a' * 48
    longest_code = 'A' * 24
    normalized = price_table.normalize_items(
        [
            _item(item_id=longest_id, code=longest_code),
            _item(item_id='with_code_underscore', code='AB_2'),
        ],
        publish=False,
    )
    assert normalized[0]['item_id'] == longest_id
    assert normalized[1]['code'] == 'AB_2'
    for changes, match in (
        ({'item_id': 'a' * 49}, 'invalid item_id'),
        ({'code': 'A'}, 'invalid code'),
        ({'code': 'A' * 25}, 'invalid code'),
    ):
        with pytest.raises(ValueError, match=match):
            price_table.normalize_items([_item(**changes)], publish=False)
    # A blank code falls back to one that satisfies the pattern, even for the longest id.
    defaulted = price_table.normalize_items([_item(item_id='a' + '_' * 47, code='')], publish=False)
    assert price_table.CODE_RE.fullmatch(defaulted[0]['code'])
    assert InspectionData(scope_items={longest_id: ScopeQuantity()}).scope_items


@pytest.mark.parametrize('basis', ['demolition', 'wet_floor', 'floor'])
def test_every_area_basis_is_accepted_by_the_table_and_the_saved_basis(basis):
    policy = copy.deepcopy(price_table.DEFAULT_POLICY)
    policy['area_basis'] = basis
    assert price_table.normalize_policy(policy)['area_basis'] == basis
    assert PricingPolicy(**policy).area_basis == basis


def test_new_companies_start_with_no_cabinetry_multiplier():
    assert price_table.DEFAULT_POLICY['cabinetry']['multiplier'] == '1.000'
    assert price_table.starter_table()['policy']['cabinetry']['multiplier'] == '1.000'
    assert PricingPolicy().cabinetry.multiplier == '1.000'


def test_starter_catalog_has_35_items_across_all_seven_groups():
    items = price_table.starter_table()['items']
    assert len(items) == 35
    assert {item['group'] for item in items} == set(price_table.GROUPS)
    assert len(price_table.GROUPS) == 7


def test_item_lower_bound_and_sf_demolition_source_rule():
    policy = price_table.DEFAULT_POLICY
    empty = {'items': [], 'policy': policy}
    assert price_table.normalize_table(empty, publish=False)['items'] == []
    with pytest.raises(ValueError):
        price_table.normalize_table(empty, publish=True)
    with pytest.raises(ValueError):
        price_table.content_hash(empty)

    # Only square-foot demolition items are tied to a room source.
    for source in ('field:labor_hours', 'typed_count_days', 'typed'):
        kept = _item(group='demolition', unit='each', quantity_source=source)
        assert price_table.normalize_items([kept], publish=False)
    with pytest.raises(ValueError, match='room quantity source'):
        price_table.normalize_items(
            [_item(group='demolition', unit='sf', quantity_source='field:labor_hours')],
            publish=False,
        )


def test_policy_accepts_only_the_documented_shapes():
    policy = copy.deepcopy(price_table.DEFAULT_POLICY)
    policy['minimum_job_charge'] = {'enabled': True, 'amount': '500'}
    with pytest.raises(ValueError, match='minimum_job_charge'):
        price_table.normalize_policy(policy)

    aliased = copy.deepcopy(price_table.DEFAULT_POLICY)
    del aliased['after_hours']['label']
    aliased['after_hours_label'] = 'Night rate'
    assert (
        price_table.normalize_policy(aliased)['after_hours']['label']
        == price_table.DEFAULT_AFTER_HOURS_LABEL
    )
    with pytest.raises(ValidationError):
        QuantityOverride(measured=Decimal('1'), entered=Decimal('2'), reason='More', room='Kitchen')


@pytest.mark.parametrize('lead', ['=', '+', '-', '@'])
def test_formula_leading_text_is_refused_for_every_exported_or_printed_label(lead):
    for field in ('name', 'customer_description'):
        with pytest.raises(ValueError, match=field):
            price_table.normalize_items([_item(**{field: lead + 'SUM(1)'})], publish=False)
    policy = copy.deepcopy(price_table.DEFAULT_POLICY)
    policy['after_hours']['label'] = lead + 'SUM(1)'
    with pytest.raises(ValueError, match='after_hours.label'):
        price_table.normalize_policy(policy)


def test_v1_pin_without_rates_never_prices_at_the_seed():
    for pin in ({'calculation_version': 'adr-residential-v1'}, {'rates': adr_rates()}):
        with pytest.raises(ValueError):
            pricing.price_and_range(InspectionData(), pin)


def _diff_row(diff, item_id):
    return next(row for row in diff['items'] if row['item_id'] == item_id)


def test_large_change_warns_when_a_price_moves_with_enabled_or_from_zero():
    before = _priced_starter()
    before['items'][0].update(unit_price='10.00', enabled=False)
    before['items'][1].update(unit_price='0.00', allow_zero=True)
    after = copy.deepcopy(before)
    after['items'][0].update(unit_price='100.00', enabled=True)
    after['items'][1].update(unit_price='100.00')
    diff, warnings = price_table.diff_tables(before, after)

    moved = _diff_row(diff, before['items'][0]['item_id'])
    assert (moved['change'], moved['percent']) == ('enabled', '900.0')
    assert moved['warnings'] == ['large_change']
    from_zero = _diff_row(diff, before['items'][1]['item_id'])
    assert (from_zero['change'], from_zero['percent']) == ('price', None)
    assert from_zero['warnings'] == ['large_change']
    assert 'large_change' in warnings


def test_large_change_uses_the_exact_percent_not_the_rounded_one():
    before = _priced_starter()
    before['items'][0]['unit_price'] = '10000.00'
    just_under = copy.deepcopy(before)
    just_under['items'][0]['unit_price'] = '14996.00'
    diff, warnings = price_table.diff_tables(before, just_under)
    assert _diff_row(diff, before['items'][0]['item_id'])['percent'] == '50.0'
    assert 'large_change' not in warnings

    exactly = copy.deepcopy(before)
    exactly['items'][0]['unit_price'] = '15000.00'
    assert 'large_change' in price_table.diff_tables(before, exactly)[1]


def test_disabled_zero_item_needs_no_acknowledgement_in_either_check():
    table = _priced_starter()
    disabled = next(item for item in table['items'] if not item['enabled'])
    disabled.update(unit_price='0.00', allow_zero=True)
    normalized = price_table.normalize_table(table, publish=True)
    assert price_table.publish_problems(normalized) == []

    disabled['enabled'] = True
    with pytest.raises(ValueError, match='confirm that a zero unit price'):
        price_table.normalize_table(table, publish=True)
    assert price_table.publish_problems(price_table.normalize_table(table, publish=False))


def test_public_diff_shows_only_items_enabled_in_the_version():
    before = _priced_starter()
    hidden = next(item for item in before['items'] if not item['enabled'])
    hidden['unit_price'] = '77.00'
    after = copy.deepcopy(before)
    just_disabled = after['items'][0]
    just_disabled['enabled'] = False
    removed = after['items'].pop(1)
    newly_enabled = next(it for it in after['items'] if it['item_id'] == hidden['item_id'])
    newly_enabled.update(enabled=True, unit_price='88.00')

    diff, warnings = price_table.public_diff(before, after)
    assert {row['item_id'] for row in diff['items']} == {hidden['item_id']}
    row = _diff_row(diff, hidden['item_id'])
    assert (row['change'], row['before'], row['after']) == ('added', None, '88.00')
    assert 'disabled_items' not in warnings
    assert just_disabled['item_id'] != removed['item_id']

    first, _ = price_table.public_diff(None, before)
    assert hidden['item_id'] not in {row['item_id'] for row in first['items']}


def _prompt_form(prompt):
    start = prompt.index('{"current_form"')
    return json.loads(prompt[start:])['current_form']


def test_scope_prompt_builds_for_a_draft_with_decimal_fields_and_leaves_v2_fields_out():
    draft = InspectionData(
        address='300 Elm St',
        scope_items={
            'containment': ScopeQuantity(
                quantity=Decimal('2.50'),
                measured_quantity=Decimal('1.50'),
                override_reason='Second room needs containment',
            )
        },
        quantity_overrides={
            'air_movers': QuantityOverride(
                measured=Decimal('3'), entered=Decimal('5'), reason='Added fans for the hallway'
            )
        },
        extras=[Extra(id='a' * 32, description='Move contents', hours=Decimal('1.50'))],
    )

    form = _prompt_form(scope.scope_prompt(draft))

    assert 'scope_items' not in form
    assert 'quantity_overrides' not in form
    assert form['extras'][0]['hours'] == '1.50'


def test_scope_prompt_is_the_same_for_a_draft_without_v2_fields_whether_unset_or_null():
    unset = InspectionData(address='300 Elm St')
    explicit_null = InspectionData(address='300 Elm St', scope_items=None, quantity_overrides=None)

    form = _prompt_form(scope.scope_prompt(unset))

    assert 'scope_items' not in form
    assert 'quantity_overrides' not in form
    assert scope.scope_prompt(unset) == scope.scope_prompt(explicit_null)


def test_saved_payload_is_the_one_place_that_omits_empty_v2_fields():
    unset = InspectionData(address='300 Elm St')
    explicit_null = InspectionData(address='300 Elm St', scope_items=None, quantity_overrides=None)

    assert unset.model_dump() == explicit_null.model_dump()
    assert bm.inspection_payload(unset) == bm.inspection_payload(explicit_null)
    assert 'scope_items' not in bm.inspection_payload(explicit_null)
    assert 'quantity_overrides' not in bm.inspection_payload(explicit_null)
