"""Tests for price table changes, prompts, and assist policy."""

import copy
import json
from decimal import Decimal

import pytest
from pydantic import ValidationError

from backend import main as bm, price_book_store, price_table, prompts, scope
from backend.adr_price_book import adr_rates
from backend.contracts import (
    Extra,
    InspectionData,
    PriceBasis,
    PricingPolicy,
    QuantityOverride,
    ScopeQuantity,
)
from tests.price_table_support import _priced_starter


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


def test_a_diff_row_names_each_changed_field_with_before_and_after():
    before = _priced_starter()
    after = copy.deepcopy(before)
    first, second = after['items'][0], after['items'][1]
    original = before['items'][1]
    first.update(unit_price='30.00', enabled=False)
    second.update(
        waste_percent='50',
        default_quantity='2',
        unit='each',
        quantity_source='typed',
        categories=[1, 2],
        taxable=True,
        code='NEW-CODE',
    )
    diff, _ = price_table.diff_tables(before, after)

    both = _diff_row(diff, first['item_id'])
    assert both['fields'] == [
        {'field': 'enabled', 'before': True, 'after': False},
        {'field': 'unit_price', 'before': '25.00', 'after': '30.00'},
    ]
    details = {row['field']: row for row in _diff_row(diff, second['item_id'])['fields']}
    normalized = price_table.normalize_table(after, publish=False)['items'][1]
    assert set(details) == {
        'waste_percent',
        'default_quantity',
        'unit',
        'quantity_source',
        'categories',
        'taxable',
        'code',
    }
    for field, row in details.items():
        assert (
            row['before'] == price_table.normalize_table(before, publish=False)['items'][1][field]
        )
        assert row['after'] == normalized[field]
    assert details['taxable'] == {'field': 'taxable', 'before': original['taxable'], 'after': True}


def test_an_added_row_says_whether_the_item_is_switched_on():
    before = _priced_starter()
    after = copy.deepcopy(before)
    after['items'].append(
        {
            **copy.deepcopy(after['items'][0]),
            'item_id': 'new_off',
            'code': 'NEW-OFF',
            'enabled': False,
        }
    )
    after['items'].append(
        {**copy.deepcopy(after['items'][0]), 'item_id': 'new_on', 'code': 'NEW-ON', 'enabled': True}
    )
    diff, _ = price_table.diff_tables(before, after)
    assert _diff_row(diff, 'new_off')['enabled'] is False
    assert _diff_row(diff, 'new_on')['enabled'] is True


def test_every_item_field_that_can_change_is_named_in_the_diff():
    before = price_table.normalize_table(_priced_starter(), publish=False)
    assert set(before['items'][0]) - {'item_id'} == set(price_table._DIFF_ITEM_FIELDS)


def test_a_reader_diff_leaves_out_what_a_reader_cannot_see():
    before = _priced_starter()
    after = copy.deepcopy(before)
    only_hidden, both = after['items'][0], after['items'][1]
    only_hidden['allow_zero'] = True
    both.update(allow_zero=True, waste_percent='5')
    diff, _ = price_table.public_diff(before, after)

    assert only_hidden['item_id'] not in {row['item_id'] for row in diff['items']}
    assert [row['field'] for row in _diff_row(diff, both['item_id'])['fields']] == ['waste_percent']


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


def test_audit_and_live_prompts_leave_out_job_quantities_and_override_reasons():
    draft = bm.inspection_payload(
        InspectionData(
            address='300 Elm St',
            year_built=1990,
            scope_items={'containment': ScopeQuantity(quantity=Decimal('2.50'))},
            quantity_overrides={
                'air_movers': QuantityOverride(
                    measured=Decimal('3'), entered=Decimal('5'), reason='Added hallway fans'
                )
            },
        )
    )
    assert draft['scope_items'] and draft['quantity_overrides']

    audit = prompts.audit_prompt(draft, [], {})
    live = prompts.live_prompt(draft)

    for prompt in (audit, live):
        assert 'Added hallway fans' not in prompt
        assert 'scope_items' not in prompt
        assert 'quantity_overrides' not in prompt
        assert '300 Elm St' in prompt


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


OLD_SHAPE_HASH = 'fe95802f3bb8971a6f32942099d58fe0ecad42c5acc88457f70fcb239f5fe9d2'


def _table_published_before_assist():
    # A table as PR 8 finds it: the policy has no assist map, and its hash is already stored.
    table = _priced_starter()
    table['policy'] = copy.deepcopy(price_table.DEFAULT_POLICY)
    return table


def _with_assist(**values):
    policy = copy.deepcopy(price_table.DEFAULT_POLICY)
    policy['assist'] = {**copy.deepcopy(price_table.DEFAULT_ASSIST), **values}
    return policy


def test_a_table_without_assist_hashes_exactly_as_before():
    table = _table_published_before_assist()
    assert 'assist' not in price_table.normalize_policy(table['policy'])
    assert 'assist' not in price_table.normalize_policy({**table['policy'], 'assist': None})
    # The hash the code printed before the assist map existed. Every published table and pin
    # carries a hash like it, and _valid_v2_doc recomputes it on each read.
    assert price_table.content_hash(table) == OLD_SHAPE_HASH
    pin = {
        'calculation_version': price_table.CALCULATION_VERSION,
        **copy.deepcopy(table),
        'content_sha256': OLD_SHAPE_HASH,
    }
    valid, normalized = price_book_store._valid_v2_doc(pin)
    assert valid
    assert 'assist' not in normalized['policy']


@pytest.mark.parametrize(
    'values, message',
    [
        ({'drying_days': 0}, 'Settings: assist.drying_days must be an integer from 1 to 60.'),
        ({'drying_days': 61}, 'Settings: assist.drying_days must be an integer from 1 to 60.'),
        ({'drying_days': 2.5}, 'Settings: assist.drying_days must be an integer from 1 to 60.'),
        ({'drying_days': '3'}, 'Settings: assist.drying_days must be an integer from 1 to 60.'),
        ({'drying_days': True}, 'Settings: assist.drying_days must be an integer from 1 to 60.'),
        (
            {'extra_drying_days': -1},
            'Settings: assist.extra_drying_days must be an integer from 0 to 30.',
        ),
        (
            {'extra_drying_days': 31},
            'Settings: assist.extra_drying_days must be an integer from 0 to 30.',
        ),
        (
            {'range_method': 'flat'},
            'Settings: assist.range_method must be "cushion" or "uncertainty".',
        ),
        (
            {'hidden_damage_percent': {'1': '101', '2': '0', '3': '0'}},
            'Settings: assist.hidden_damage_percent.1 must be between 0 and 100.',
        ),
        (
            {'hidden_damage_percent': {'1': '0', '2': '1.234', '3': '0'}},
            'Settings: assist.hidden_damage_percent.2 must have at most 2 decimal places.',
        ),
        (
            {'hidden_damage_percent': {'1': '0', '2': '0'}},
            'Settings: assist.hidden_damage_percent must contain keys 1, 2 and 3.',
        ),
    ],
)
def test_assist_bounds_and_messages(values, message):
    with pytest.raises(ValueError) as error:
        price_table.normalize_policy(_with_assist(**values))
    assert str(error.value) == message


def test_assist_must_be_a_map_and_its_values_read_back_canonical():
    policy = copy.deepcopy(price_table.DEFAULT_POLICY)
    policy['assist'] = 'on'
    with pytest.raises(ValueError, match='Settings: assist must be an object.'):
        price_table.normalize_policy(policy)
    kept = price_table.normalize_policy(
        _with_assist(
            drying_days=60,
            range_method='uncertainty',
            extra_drying_days=30,
            hidden_damage_percent={'1': '0.50', '2': '15.00', '3': 100},
        )
    )
    assert kept['assist'] == {
        'drying_days': 60,
        'range_method': 'uncertainty',
        'extra_drying_days': 30,
        'hidden_damage_percent': {'1': '0.5', '2': '15', '3': '100'},
    }
    # Normalizing a stored map again changes nothing, so its hash holds.
    assert price_table.normalize_policy(kept) == kept


def test_assist_of_reads_absent_as_the_cushion_defaults_and_starter_as_uncertainty():
    absent = {
        'drying_days': 3,
        'range_method': 'cushion',
        'extra_drying_days': 0,
        'hidden_damage_percent': {'1': '0', '2': '0', '3': '0'},
    }
    assert price_table.assist_of(price_table.DEFAULT_POLICY) == absent
    assert price_table.assist_of({'assist': None}) == absent
    # A reader cannot change the shared defaults through what it was handed.
    price_table.assist_of({})['hidden_damage_percent']['1'] = '99'
    assert price_table.assist_of({}) == absent
    assert 'assist' not in price_table.DEFAULT_POLICY
    starter = price_table.starter_table()['policy']
    assert starter['assist'] == {
        'drying_days': 3,
        'range_method': 'uncertainty',
        'extra_drying_days': 1,
        'hidden_damage_percent': {'1': '10', '2': '15', '3': '25'},
    }
    assert price_table.assist_of(starter) == starter['assist']
    assert price_table.normalize_policy(starter) == starter


def test_from_v1_rates_keeps_the_cushion_so_the_switch_matches_the_rate_book():
    policy = price_table.from_v1_rates(adr_rates())['policy']
    assert policy['assist'] == price_table.DEFAULT_ASSIST
    assert policy['range'] == {'first_sf': 1000, 'first_percent': '50', 'beyond_percent': '20'}


def test_adding_assist_at_absent_values_is_no_change_and_a_method_change_is_large():
    before = _table_published_before_assist()
    same = copy.deepcopy(before)
    same['policy']['assist'] = copy.deepcopy(price_table.DEFAULT_ASSIST)
    assert price_table.diff_tables(before, same) == ({'items': [], 'policy': []}, [])
    assert price_table.diff_tables(same, before) == ({'items': [], 'policy': []}, [])

    for label, values, old, new in (
        ('assist.drying_days', {'drying_days': 5}, 3, 5),
        ('assist.range_method', {'range_method': 'uncertainty'}, 'cushion', 'uncertainty'),
        ('assist.extra_drying_days', {'extra_drying_days': 2}, 0, 2),
        (
            'assist.hidden_damage_percent.1',
            {'hidden_damage_percent': {'1': '10', '2': '0', '3': '0'}},
            '0',
            '10',
        ),
        (
            'assist.hidden_damage_percent.2',
            {'hidden_damage_percent': {'1': '0', '2': '10', '3': '0'}},
            '0',
            '10',
        ),
        (
            'assist.hidden_damage_percent.3',
            {'hidden_damage_percent': {'1': '0', '2': '0', '3': '10'}},
            '0',
            '10',
        ),
    ):
        after = copy.deepcopy(before)
        after['policy'] = _with_assist(**values)
        diff, warnings = price_table.diff_tables(before, after)
        assert diff['policy'] == [{'field': label, 'before': old, 'after': new}]
        assert warnings == ['large_change']


def test_a_first_table_reads_the_starter_settings_as_no_change():
    starter = _priced_starter()
    diff, warnings = price_table.diff_tables(None, starter)
    assert not [row for row in diff['policy'] if row['field'].startswith('assist.')]
    assert 'large_change' not in warnings
    # An owner who moves a starter setting before the first publish sees it in the review.
    changed = copy.deepcopy(starter)
    changed['policy']['assist']['extra_drying_days'] = 2
    diff, warnings = price_table.diff_tables(None, changed)
    assert [row for row in diff['policy'] if row['field'].startswith('assist.')] == [
        {'field': 'assist.extra_drying_days', 'before': 1, 'after': 2}
    ]
    assert 'large_change' in warnings


def test_price_basis_accepts_a_policy_with_and_without_assist():
    old = PricingPolicy(**price_table.DEFAULT_POLICY)
    assert old.assist is None
    # A saved document's dump gains no key, so its bytes and its proposal hash stay as signed.
    assert 'assist' not in old.model_dump()
    assert 'assist' not in old.model_dump(mode='json')
    assert old.model_dump() == price_table.normalize_policy(price_table.DEFAULT_POLICY)
    starter = price_table.starter_table()['policy']
    dumped = PricingPolicy(**starter).model_dump()
    assert dumped == starter
    bad = _with_assist(drying_days=61)
    with pytest.raises(ValidationError):
        PricingPolicy(**bad)
    with pytest.raises(ValidationError):
        PricingPolicy(**{**price_table.DEFAULT_POLICY, 'assist': {'unknown': 1}})


def test_a_new_v2_job_starts_at_the_tables_drying_days():
    table = {**_priced_starter(), 'version_id': 'v1'}
    table['policy']['assist']['drying_days'] = 5
    item = next(i for i in table['items'] if i['quantity_source'] == 'typed_count_days')
    item['default_quantity'] = '2'
    seeded = price_table.seed_quantities(InspectionData().model_dump(mode='json'), table)
    assert seeded['drying_days'] == 5
    # A typed count-days item starts at the same days as the job.
    assert seeded['scope_items'][item['item_id']]['days'] == 5
    # An office-created job holds no measured value, so changing the days needs no reason.
    assert 'quantity_overrides' not in seeded or not seeded['quantity_overrides']
    old = {**_table_published_before_assist(), 'version_id': 'v0'}
    assert (
        price_table.seed_quantities(InspectionData().model_dump(mode='json'), old)['drying_days']
        == 3
    )


def test_the_waste_basis_is_accepted_and_the_default_stays_demolition():
    policy = copy.deepcopy(price_table.starter_table()['policy'])
    assert policy['area_basis'] == 'demolition'
    assert PricingPolicy(**{'area_basis': 'demolition_with_waste'}).area_basis == (
        'demolition_with_waste'
    )
    policy['area_basis'] = 'demolition_with_waste'
    assert price_table.normalize_policy(policy)['area_basis'] == 'demolition_with_waste'
    policy['area_basis'] = 'demolition with waste'
    with pytest.raises(ValueError, match='demolition_with_waste'):
        price_table.normalize_policy(policy)
