"""Guard rails while estimating: advisory warnings, derived on reads and never a signing rule."""

import json
import re
from decimal import Decimal
from pathlib import Path

import pytest

from backend import ai_features, estimate_warnings
from backend.contracts import InspectionData
from backend.pricing import PricedJob, price_and_range
from backend.sizing import equipment_sizing
from tests.test_backend import sign_payload
from tests.test_price_books import _publish_v2, _v2_table, enabled  # noqa: F401
from tests.test_workspaces import ID, api, data, store  # noqa: F401

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = json.loads((ROOT / 'tests/fixtures/estimate-warnings.json').read_text())
TABLE_CODES = {'unpriced_room', 'unpriced_quantity', 'unpriced_extras'}


def table_for(edits=None):
    edits = edits or {}
    table = _v2_table('30.00', extras=edits.get('extras', False))
    by_id = {item['item_id']: item for item in table['items']}
    for item_id, changes in edits.get('items', {}).items():
        by_id[item_id].update(changes)
    table['policy'].update(edits.get('policy', {}))
    return table


def priced_at(low):
    return PricedJob(lines=[], totals=None, low=Decimal(low))


def run(job, table=None, low=None, history=None):
    job = InspectionData.model_validate(job)
    priced = None if low is None else priced_at(low)
    return estimate_warnings.warnings(job, equipment_sizing(job), table, priced, history)


def job_of(rooms, **fields):
    return dict(address='Synthetic property', year_built=2000, rooms=rooms, **fields)


def hall(sf=100, category=2):
    return dict(name='Hall', category=category, finished_sf=sf)


def comparable(*lows, sf='100.00', category=2):
    return [dict(sf=sf, category=category, low=low) for low in lows]


@pytest.mark.parametrize('case', FIXTURES, ids=lambda case: case['name'])
def test_warning_fixtures(case):
    found = run(case['data'], table_for(case.get('table')), case.get('low'), case.get('history'))
    assert [warning['code'] for warning in found] == case['expected_codes']
    if case['expected_codes']:
        assert found[0]['text'].startswith(case['expected_text'])
        assert found[0]['room'] == case.get('expected_room', '')


def test_typical_job_comparison_uses_the_highest_category_and_the_area_window():
    typical = ['1000.00'] * 5
    far = {'low': '100.00', 'table': None}

    def far_from_typical(job, history, **kwargs):
        return [w['code'] for w in run(job, history=history, **{**far, **kwargs})] == [
            'far_from_typical'
        ]

    job = job_of([hall(sf=150)])
    # The window's edges are inside: two-thirds of 150 and one and a half times 150.
    assert far_from_typical(job, comparable(*typical, sf='100.00'))
    assert far_from_typical(job, comparable(*typical, sf='225.00'))
    assert not far_from_typical(job, comparable(*typical, sf='99.99'))
    assert not far_from_typical(job, comparable(*typical, sf='225.01'))
    # The highest category on the job decides, whichever room holds it.
    mixed = job_of([hall(sf=50, category=1), {**hall(sf=100, category=3), 'name': 'Den'}])
    assert far_from_typical(mixed, comparable(*typical, sf='150.00', category=3))
    assert not far_from_typical(mixed, comparable(*typical, sf='150.00', category=1))
    # A job with no area compares only with jobs with no area.
    empty = job_of([hall(sf=0)])
    assert far_from_typical(empty, comparable(*typical, sf='0.00'))
    assert not far_from_typical(empty, comparable(*typical, sf='1.00'))
    assert not far_from_typical(job_of([hall()]), comparable(*typical, sf='0.00'))
    # Exactly half and exactly double are not far; the median ignores one odd job.
    history = comparable('1000.00', '1000.00', '1000.00', '1000.00', '90000.00')
    assert not far_from_typical(job_of([hall()]), history, low='500.00')
    assert not far_from_typical(job_of([hall()]), history, low='2000.00')
    assert far_from_typical(job_of([hall()]), history, low='499.99')
    assert far_from_typical(job_of([hall()]), history, low='2000.01')
    # An even count takes the middle two.
    even = comparable('800.00', '800.00', '800.00', '1200.00', '1200.00', '1200.00')
    assert not far_from_typical(job_of([hall()]), even, low='500.00')
    assert far_from_typical(job_of([hall()]), even, low='499.00')


def test_a_wet_floor_table_compares_and_reports_the_wet_floor_area():
    table = table_for({'policy': {'area_basis': 'wet_floor'}})
    room = dict(name='Hall', category=2, finished_sf=10, wet_floor_sf=200)
    found = run(job_of([room]), table, '100.00', comparable(*['1000.00'] * 5, sf='200.00'))
    assert [warning['code'] for warning in found] == ['far_from_typical']
    # The whole floor counts when the wet floor is left blank; a stated 0 means none of it.
    for area, expected in ((None, 200), (0, None)):
        room = dict(name='Hall', category=3, floor_sf=200, wet_floor_sf=area)
        items = {
            item['item_id']: {'enabled': False}
            for item in table['items']
            if item['quantity_source'].startswith('room:')
        }
        off = table_for({'policy': {'area_basis': 'wet_floor'}, 'items': items})
        found = run(job_of([room]), off)
        texts = [warning['text'] for warning in found if warning['code'] == 'unpriced_room']
        if expected is None:
            assert texts == []
        else:
            assert texts == [
                f"Hall: {expected} sq ft of category 3 work prices nothing on your company's "
                'price list.'
            ]


def test_a_room_is_only_unpriced_when_nothing_enabled_and_priced_covers_its_category():
    room = {**hall(sf=40, category=3), 'loss': 'mold'}
    covered = table_for()
    assert 'unpriced_room' not in [w['code'] for w in run(job_of([room]), covered)]
    # A disabled item and an item with no price leave the room unpriced, as the engine would.
    off = {
        'demo_cat3_floor': {'enabled': False},
        'demo_cat3_wall': {'unit_price': ''},
        'hepa_vacuum': {'enabled': False},
        'surface_cleaning': {'enabled': False},
        'antimicrobial': {'unit_price': ''},
    }
    found = run(job_of([room]), table_for({'items': off}))
    assert [w['code'] for w in found if w['code'] == 'unpriced_room'] == ['unpriced_room']
    # A room with no area yet is the readiness check's to mention.
    empty = {**hall(sf=0, category=3), 'loss': 'mold'}
    assert 'unpriced_room' not in [
        w['code'] for w in run(job_of([empty]), table_for({'items': off}))
    ]
    # Another category's item does not cover this room.
    other = {'items': {**off, 'demo_cat3_wall': {'enabled': False}}}
    found = run(job_of([hall(sf=40, category=1)]), table_for(other))
    assert 'unpriced_room' not in [w['code'] for w in found]


def test_quantities_with_nothing_entered_or_a_listed_item_are_not_warned_about():
    off = table_for({'items': {'air_scrubber': {'enabled': False}}})
    job = job_of([hall()], air_scrubbers=0, scope_items={'old_item': {'quantity': 0}})
    assert 'unpriced_quantity' not in [w['code'] for w in run(job, off)]
    job = job_of([hall()], air_scrubbers=2)
    assert 'unpriced_quantity' not in [w['code'] for w in run(job, table_for())]
    # A saved default reads as entered, as it does on the phone's list.
    assert [w['text'] for w in run(job_of([hall()]), off) if w['code'] == 'unpriced_quantity'] == [
        '1 air scrubbers entered, but your price list has no item for it.'
    ]
    # A day count on its own prices nothing, so it never reads as an entered quantity.
    table = table_for({'items': {'air_mover': {'enabled': False}}})
    found = run(job_of([hall()], air_movers=0, drying_days=5), table)
    assert 'unpriced_quantity' not in [w['code'] for w in found]
    # A count-and-days item left off a table reads by its count.
    found = run(job_of([hall()], air_movers=3), table)
    assert [w['text'] for w in found if w['code'] == 'unpriced_quantity'] == [
        '3 air movers entered, but your price list has no item for it.'
    ]


def test_a_count_and_days_scope_item_reads_as_its_total():
    entry = {'quantity': 0, 'count': 2, 'days': 3}
    found = run(job_of([hall()], scope_items={'old_heater': entry}), table_for())
    assert [w['text'] for w in found if w['code'] == 'unpriced_quantity'] == [
        '6 old heater entered, but your price list has no item for it.'
    ]


def test_v1_jobs_get_sizing_and_typical_warnings_only():
    room = {
        'name': 'Hall',
        'category': 3,
        'loss': 'water',
        'finished_sf': 100,
        'floor_sf': 140,
        'ceiling_height_ft': 8,
        'water_class': 2,
    }
    job = job_of(
        [room],
        air_movers=2,
        dehumidifiers=1,
        dehumidifier_ppd=70,
        air_scrubbers=2,
        scope_items={'old_item': {'quantity': 2}},
    )
    found = run(job, None, '400.00', comparable(*['1000.00'] * 5, category=3))
    assert [warning['code'] for warning in found] == ['air_movers_below', 'far_from_typical']


def test_no_warning_text_names_an_amount():
    found = run(
        job_of([hall()], air_scrubbers=2),
        table_for({'items': {'air_scrubber': {'enabled': False}}}),
        '123.45',
        comparable(*['9876.54'] * 5),
    )
    assert {warning['code'] for warning in found} >= {'unpriced_quantity', 'far_from_typical'}
    for warning in found:
        assert '$' not in warning['text']
        assert '123' not in warning['text'] and '9876' not in warning['text']


def test_a_job_that_prices_nothing_keeps_its_other_warnings(api, enabled, monkeypatch):  # noqa: F811
    """Pricing refuses an all-zero job. That is exactly when a room that prices nothing matters."""
    client, current, store = api
    monkeypatch.setattr(ai_features, 'AI_FEATURES', {'estimate_assist'})
    table = _v2_table('30.00')
    for item in table['items']:
        if item['quantity_source'].startswith('room:') or item['default_quantity'] != '0':
            item['enabled'] = False
    current['uid'] = 'owner'
    _publish_v2(client, table)
    current['uid'] = 'estimator'
    job = InspectionData(
        address='Synthetic property',
        year_built=2000,
        rooms=[{**hall(sf=40, category=3), 'loss': 'mold'}],
        air_movers=0,
        emergency_calls=0,
        monitoring_hours=0,
        haul_loads=0,
        air_scrubbers=0,
        hepa_filters=0,
    ).model_dump(mode='json')
    made = client.post('/api/inspections', json={'inspection_id': ID, 'data': job})
    assert made.status_code == 200, made.text
    pin = store.workspaces.prices._pin(ID)
    with pytest.raises(ValueError):
        price_and_range(InspectionData.model_validate(job), pin)
    assert [warning['code'] for warning in made.json()['warnings']] == ['unpriced_room']


def test_warnings_never_change_signable_documents_or_the_proposal_hash(
    api,
    enabled,  # noqa: F811
    monkeypatch,
):
    client, current, store = api
    current['uid'] = 'owner'
    _publish_v2(client, _v2_table('30.00'))
    job = InspectionData(
        address='Synthetic property',
        year_built=2000,
        rooms=[
            dict(
                name='Kitchen',
                loss='water',
                category=2,
                finished_sf=100,
                floor_sf=140,
                ceiling_height_ft=8,
                water_class=2,
            )
        ],
        air_movers=9,
        dehumidifiers=1,
        dehumidifier_ppd=70,
        scope_confirmed=True,
    ).model_dump(mode='json')

    def audited(flags, inspection_id):
        monkeypatch.setattr(ai_features, 'AI_FEATURES', flags)
        current['uid'] = 'estimator'
        made = client.post('/api/inspections', json={'inspection_id': inspection_id, 'data': job})
        assert made.status_code == 200, made.text
        record = client.post(
            '/api/audit', json={'inspection_id': inspection_id, 'expected_revision': 1}
        )
        assert record.status_code == 200, record.text
        return record.json()

    plain = audited(set(), 'ADR-INS-' + 'c' * 32)
    warned = audited({'estimate_assist'}, ID)
    assert 'warnings' not in plain
    assert [warning['code'] for warning in warned['warnings']] == ['air_movers_above']
    # The same inputs give the same documents; only the job id and the pricing time differ.
    assert warned['audit']['documents']['signable'] is True

    def comparable_documents(record):
        text = json.dumps(record['audit']['documents'], sort_keys=True)
        text = text.replace(record['inspection_id'], '')
        return re.sub(r'"priced_at": "[^"]+"', '', text)

    assert comparable_documents(warned) == comparable_documents(plain)
    # The stored audit and its hash read the same with the flag off: warnings are not part of them.
    monkeypatch.setattr(ai_features, 'AI_FEATURES', set())
    reread = client.get('/api/inspections/' + ID).json()
    assert reread['audit'] == warned['audit']
    monkeypatch.setattr(ai_features, 'AI_FEATURES', {'estimate_assist'})
    text = warned['warnings'][0]['text']
    assert text not in json.dumps(warned['audit'])
    # A warning never stops the signature, and the signed record carries none.
    signed = client.post('/api/authorize', json=sign_payload(warned))
    assert signed.status_code == 200, signed.text
    assert text not in json.dumps(store.db.records['authorizations/' + 'ADR-AUTH-test123456'])
    assert 'warnings' not in store.db.records['inspections/' + ID]
    assert 'warnings' not in client.get('/api/inspections/' + ID).json()


def test_warnings_are_never_stored_on_the_draft(api, monkeypatch):
    client, current, store = api
    monkeypatch.setattr(ai_features, 'AI_FEATURES', {'estimate_assist'})
    current['uid'] = 'estimator'
    made = client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    assert made.status_code == 200, made.text
    assert 'warnings' in made.json()
    assert 'warnings' not in store.db.records['inspections/' + ID]
    assert 'warnings' not in store.db.records['inspections/' + ID]['data']
