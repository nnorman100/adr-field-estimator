"""Owner square-foot brackets: boundary arithmetic, persistence, and immutable job pins."""

import copy
from decimal import Decimal as D
import random

import pytest

from backend import price_table, pricing_v2
from backend.contracts import InspectionData, PricingPolicy
from backend.price_book_import import export_csv, export_xlsx, parse_upload
from tests.test_price_books import _publish_v2, enabled  # noqa: F401
from tests.test_workspaces import ID, api, data, store  # noqa: F401


def table(mode=None, price_bands=True):
    item = dict(
        item_id='area_work',
        code='AREA',
        group='demolition',
        name='Area work',
        unit='sf',
        quantity_source='room:demolition:finished',
        unit_price='10',
    )
    if price_bands:
        item['price_brackets'] = [
            {'up_to_sf': 500, 'unit_price': '10'},
            {'up_to_sf': 1000, 'unit_price': '5'},
            {'up_to_sf': None, 'unit_price': '2'},
        ]
    policy = copy.deepcopy(price_table.DEFAULT_POLICY)
    if mode is not None:
        policy['bracket_mode'] = mode
    return price_table.normalize_table({'items': [item], 'policy': policy}, publish=True)


def scope(sf, **rest):
    return InspectionData(
        rooms=[dict(name='Room', finished_sf=sf)],
        emergency_calls=0,
        monitoring_hours=0,
        air_movers=0,
        dehumidifiers=0,
        **rest,
    )


def estimate(table, job):
    lines, _ = pricing_v2.price_scope(job, table)
    return pricing_v2.totals(job, lines, table['policy'], table['items'])


def ends(table, sf):
    result = estimate(table, scope(sf))
    return result['low']['total'], result['high']['total']


def test_tiered_is_default_and_fills_each_band_across_rooms():
    book = table()
    assert 'bracket_mode' not in book['policy']
    assert ends(book, 499)[0] == D('4990')
    assert ends(book, 500)[0] == D('5000')
    assert ends(book, 501)[0] == D('5005')
    assert ends(book, 1001)[0] == D('7502')
    job = InspectionData(
        rooms=[dict(name='One', finished_sf=300), dict(name='Two', finished_sf=700)]
    )
    lines, _ = pricing_v2.price_scope(job, book)
    assert sum(D(str(line['total'])) for line in lines) == D('7500')
    assert sum(line['quantity'] for line in lines) == 1000
    assert all(line['price_bracket'] and 'tiered bracket' in line['description'] for line in lines)


def test_whole_job_selects_one_rate_and_cushion_and_preview_flags_drop():
    from backend.price_book_store import _boundary_samples

    book = table('whole-job')
    book['policy']['range']['brackets'] = [
        {'up_to_sf': 500, 'percent': '50'},
        {'up_to_sf': None, 'percent': '10'},
    ]
    assert ends(book, 500) == (D('5000'), D('7500'))
    assert ends(book, 501) == (D('2505'), D('2755.50'))
    lines, _ = pricing_v2.price_scope(scope(501), book)
    assert (
        'whole-job bracket: over 500 through 1,000 sq ft of bracketed work on the job'
        in lines[0]['description']
    )
    samples = _boundary_samples(book)
    assert len(samples) == 3
    assert all(sample['price_drop'] for sample in samples)
    assert [sample['sf'] for sample in samples[0]['samples']] == [499, 499.99, 500, 500.01, 501]


def test_cushion_alone_can_drop_in_whole_job_mode():
    book = table('whole-job', price_bands=False)
    assert ends(book, 1000) == (D('10000'), D('15000'))
    assert ends(book, 1001) == (D('10010'), D('12012'))


def test_n_cushion_bands_and_labor_hours():
    book = table(price_bands=False)
    book['policy']['range']['brackets'] = [
        {'up_to_sf': 100, 'percent': '50'},
        {'up_to_sf': 200, 'percent': '30'},
        {'up_to_sf': None, 'percent': '10'},
    ]
    assert ends(book, 300) == (D('3000'), D('3900'))
    book['items'] += price_table.normalize_items(
        [
            dict(
                item_id='labor_work',
                code='LABOR',
                group='labor',
                name='Labor',
                unit='hour',
                quantity_source='typed',
                unit_price='100',
                default_quantity='1',
            )
        ],
        publish=True,
    )
    assert ends(book, 300) == (D('3100'), D('4050'))
    assert '30% over 100 through 200' in pricing_v2.range_explanation(book['policy'], scope(300))


def test_two_bracket_cushion_exactly_matches_legacy_on_mixed_costs_and_waste():
    rng = random.Random(867)
    for _ in range(150):
        old = table(price_bands=False)
        old['policy']['range'] = dict(
            first_sf=rng.randint(1, 2000), first_percent='53.29', beyond_percent='17.83'
        )
        old['policy']['category_multipliers']['3'] = '1.537'
        old['policy']['area_basis'] = rng.choice(
            ['demolition', 'demolition_with_waste', 'wet_floor']
        )
        new = copy.deepcopy(old)
        new['policy']['range']['brackets'] = price_table.cushion_brackets_of(old['policy'])
        job = InspectionData(
            rooms=[
                dict(
                    name=str(i),
                    category=rng.choice([1, 3]),
                    finished_sf=rng.randint(1, 2000) / 10,
                    waste_percent=rng.randint(0, 30),
                )
                for i in range(4)
            ]
        )
        assert estimate(old, job)['high'] == estimate(new, job)['high']


def test_tiered_monotonicity_property_with_arbitrary_rates_cushions_and_room_modifiers():
    rng = random.Random(528)
    for _ in range(300):
        book = table('tiered')
        for band in book['items'][0]['price_brackets']:
            band['unit_price'] = str(rng.randint(1, 2000) / 100)
        book['policy']['range']['brackets'] = [
            dict(up_to_sf=limit, percent=str(rng.randint(0, 100))) for limit in [300, 750, None]
        ]
        book['policy']['category_multipliers']['3'] = '2.143'
        old = InspectionData(
            rooms=[
                dict(name='Existing', category=3, finished_sf=500, waste_percent=13),
                dict(name='Growing', finished_sf=rng.randint(1, 1000), waste_percent=7),
            ]
        )
        new = old.model_copy(deep=True)
        new.rooms[1].finished_sf += rng.choice([0.01, 1, 100])
        before, after = estimate(book, old), estimate(book, new)
        assert after['low']['total'] >= before['low']['total']
        assert after['high']['total'] >= before['high']['total']


@pytest.mark.parametrize(
    'bands',
    [
        [],
        [{'up_to_sf': 500, 'unit_price': '1'}],
        [
            {'up_to_sf': 500, 'unit_price': '1'},
            {'up_to_sf': 400, 'unit_price': '1'},
            {'up_to_sf': None, 'unit_price': '1'},
        ],
        [{'up_to_sf': None, 'unit_price': '-1'}],
        [{'up_to_sf': True, 'unit_price': '1'}, {'up_to_sf': None, 'unit_price': '1'}],
        [{'up_to_sf': 0, 'unit_price': '1'}, {'up_to_sf': None, 'unit_price': '1'}],
        [{'up_to_sf': None, 'unit_price': 'NaN'}],
    ],
)
def test_invalid_brackets_rejected(bands):
    book = table()
    book['items'][0]['price_brackets'] = bands
    with pytest.raises(ValueError):
        price_table.normalize_table(book, publish=False)


def test_zero_bracket_requires_explicit_owner_acknowledgement():
    book = table()
    item = book['items'][0]
    item['price_brackets'][1]['unit_price'] = '0'
    with pytest.raises(ValueError, match='allow_zero'):
        price_table.normalize_table(book, publish=False)
    item['allow_zero'] = True
    assert price_table.publish_problems(book)
    with pytest.raises(ValueError, match='confirm'):
        price_table.normalize_table(book, publish=True)
    assert not price_table.publish_problems(book, ['area_work'])
    price_table.normalize_table(book, publish=True, acknowledgements=['area_work'])


@pytest.mark.parametrize(
    'exporter,kind', [(export_csv, 'text/csv'), (export_xlsx, 'application/octet-stream')]
)
def test_brackets_round_trip_spreadsheets_and_contracts(exporter, kind):
    book = table('whole-job')
    book['policy']['range']['brackets'] = [
        dict(up_to_sf=250, percent='40'),
        dict(up_to_sf=None, percent='15'),
    ]
    parsed = parse_upload(
        exporter('company', 'v1', 1, book), kind, 'company', 'v1', 1, 'dryscope-v2'
    )
    assert parsed['items'] == book['items']
    assert parsed['bracket_policy'] == dict(
        bracket_mode='whole-job', brackets=book['policy']['range']['brackets']
    )
    assert PricingPolicy(**book['policy']).model_dump() == book['policy']
    flat = table(price_bands=False)
    assert (
        parse_upload(exporter('company', 'v1', 1, flat['items']), kind, 'company', 'v1', 1)
        == flat['items']
    )
    assert price_table.content_hash(flat) != price_table.content_hash(book)
    assert (
        price_table.public_table(book, manage=False)['items'][0]['price_brackets']
        == book['items'][0]['price_brackets']
    )
    diff, _ = price_table.diff_tables(flat, book)
    assert any(
        field['field'] == 'price_brackets' for row in diff['items'] for field in row['fields']
    )
    assert {row['field'] for row in diff['policy']} >= {'bracket_mode', 'range.brackets'}


def test_bracket_only_item_needs_no_flat_price():
    book = table()
    book['items'][0]['unit_price'] = ''
    book = price_table.normalize_table(book, publish=True)
    assert price_table.publish_problems(book) == []
    assert ends(book, 501)[0] == D('5005')


def test_publish_documents_pins_and_role_boundaries(api, enabled):
    client, current, db = api
    current['uid'] = 'owner'
    book = table()
    book['items'].append(
        dict(copy.deepcopy(book['items'][0]), item_id='disabled_work', code='OFF', enabled=False)
    )
    book['policy']['range']['brackets'] = [
        dict(up_to_sf=500, percent='40'),
        dict(up_to_sf=None, percent='10'),
    ]
    published = _publish_v2(client, book)
    job = data()
    job['scope_confirmed'] = True
    created = client.post('/api/inspections', json={'inspection_id': ID, 'data': job})
    assert created.status_code == 200, created.text
    pin = copy.deepcopy(db.db.records['_job_pricing/' + ID])
    audited = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
    assert audited.status_code == 200, audited.text
    docs = audited.json()['audit']['documents']
    assert 'disabled_work' not in docs['price_basis']['price_brackets']
    assert docs['price_basis']['price_brackets']['area_work'] == book['items'][0]['price_brackets']
    assert docs['price_basis']['policy']['range']['brackets'] == book['policy']['range']['brackets']
    assert docs['xactimate_scope'][0]['price_bracket']
    before = copy.deepcopy(db.db.records['inspections/' + ID])
    changed = copy.deepcopy(book)
    changed['items'][0]['price_brackets'][0]['unit_price'] = '20'
    _publish_v2(client, changed, 'Change first band')
    assert db.db.records['_job_pricing/' + ID] == pin
    assert db.db.records['inspections/' + ID] == before
    assert pin['version_id'] == published['version_id']
    for role in ['office', 'estimator']:
        current['uid'] = role
        view = client.get('/api/companies/adr/prices')
        assert view.status_code == 200
        assert view.json()['items'][0]['price_brackets'][0]['unit_price'] == '20.00'
        response = client.post('/api/companies/adr/prices/calculate', json=changed)
        assert response.status_code == 403


@pytest.mark.parametrize('boundary', [1, 100000])
def test_boundary_previews_cover_valid_extreme_limits(boundary):
    from backend.price_book_store import _boundary_samples

    book = table()
    book['items'][0]['price_brackets'] = [
        dict(up_to_sf=boundary, unit_price='10'),
        dict(up_to_sf=None, unit_price='5'),
    ]
    book['policy']['range']['brackets'] = [
        dict(up_to_sf=boundary, percent='50'),
        dict(up_to_sf=None, percent='10'),
    ]
    samples = _boundary_samples(book)
    assert len(samples) == 2
    assert [row['sf'] for row in samples[0]['samples']] == [
        boundary - 1,
        boundary - 0.01,
        boundary,
        boundary + 0.01,
        boundary + 1,
    ]
    assert samples[0]['samples'][0]['low'] == f'${(boundary - 1) * 10:,.2f}'


def test_signed_brackets_never_change_after_publish(api, enabled):
    from tests.test_backend import sign_payload

    client, current, db = api
    current['uid'] = 'owner'
    book = table()
    _publish_v2(client, book)
    job = data()
    job['scope_confirmed'] = True
    created = client.post('/api/inspections', json={'inspection_id': ID, 'data': job})
    assert created.status_code == 200, created.text
    audited = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
    assert audited.status_code == 200, audited.text
    signed = client.post('/api/authorize', json=sign_payload(audited.json()))
    assert signed.status_code == 200, signed.text
    auth_key = f'authorizations/{signed.json()["auth_id"]}'
    before = copy.deepcopy(db.db.records[auth_key])
    pin = copy.deepcopy(db.db.records['_job_pricing/' + ID])
    book['policy']['bracket_mode'] = 'whole-job'
    book['items'][0]['price_brackets'][0]['unit_price'] = '20'
    _publish_v2(client, book, 'Update brackets after signing')
    assert db.db.records[auth_key] == before
    assert db.db.records['_job_pricing/' + ID] == pin
    assert client.post(f'/api/inspections/{ID}/pricing/reprice-preview').status_code == 409


def test_owner_export_import_preserves_item_and_cushion_brackets(api, enabled):
    import csv
    import io
    import json

    client, current, db = api
    current['uid'] = 'owner'
    book = table('whole-job')
    book['policy']['range']['brackets'] = [
        dict(up_to_sf=400, percent='40'),
        dict(up_to_sf=None, percent='10'),
    ]
    _publish_v2(client, book)
    exported = client.get('/api/companies/adr/prices/export')
    assert exported.status_code == 200
    rows = list(csv.DictReader(io.StringIO(exported.content.decode('utf-8-sig'))))
    rows[0]['price_brackets'] = json.dumps(
        [dict(up_to_sf=300, unit_price='8'), dict(up_to_sf=None, unit_price='4')]
    )
    rows[0]['cushion_brackets'] = json.dumps(
        [dict(up_to_sf=300, percent='30'), dict(up_to_sf=None, percent='5')]
    )
    rows[0]['bracket_mode'] = 'tiered'
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=rows[0].keys())
    writer.writeheader()
    writer.writerows(rows)
    preview = client.post(
        '/api/companies/adr/prices/import-preview',
        data={'change_reason': 'Import adjusted brackets'},
        files={'file': ('prices.csv', buffer.getvalue().encode(), 'text/csv')},
    )
    assert preview.status_code == 200, preview.text
    shown = preview.json()
    saved = client.post(
        '/api/companies/adr/prices/publish',
        json={'preview_id': shown['preview_id'], 'expected_generation': shown['generation']},
    )
    assert saved.status_code == 200, saved.text
    view = client.get('/api/companies/adr/prices').json()
    assert view['items'][0]['price_brackets'][0] == dict(up_to_sf=300, unit_price='8.00')
    assert view['policy']['range']['brackets'][0] == dict(up_to_sf=300, percent='30')
    assert view['policy']['bracket_mode'] == 'tiered'


def test_typed_square_foot_brackets_work_with_unchanged_uncertainty_method():
    book = table()
    book['items'][0].update(group='treatment', quantity_source='typed', unit_price='')
    book['policy']['assist'] = copy.deepcopy(price_table.DEFAULT_ASSIST)
    book['policy']['assist'].update(
        range_method='uncertainty', hidden_damage_percent={'1': '10', '2': '15', '3': '25'}
    )
    job = scope(1, scope_items={'area_work': {'quantity': '501'}})
    totals = estimate(book, job)
    assert totals['low']['total'] == D('5005')
    assert totals['high']['total'] == D('5505.50')


def test_preview_detects_a_fractional_drop_that_whole_foot_samples_would_miss():
    from backend.price_book_store import _boundary_samples

    book = table('whole-job')
    book['items'][0]['price_brackets'] = [
        dict(up_to_sf=500, unit_price='10'),
        dict(up_to_sf=None, unit_price='9.99'),
    ]
    samples = _boundary_samples(book)[0]
    assert samples['price_drop']
    assert samples['samples'][2]['low'] == '$5,000.00'
    assert samples['samples'][3]['low'] == '$4,995.10'
    assert samples['samples'][4]['low'] == '$5,004.99'


@pytest.mark.parametrize('mode', ['tiered', 'whole-job'])
def test_rate_book_switch_explanation_follows_the_selected_brackets(mode):
    book = table(mode)
    book['policy']['range']['brackets'] = [
        dict(up_to_sf=400, percent='40'),
        dict(up_to_sf=None, percent='10'),
    ]
    words = price_table.switch_differences(book['policy'])
    assert mode in words[0]
    if mode == 'whole-job':
        assert 'may cost less' in words[0]
        assert 'same selected cushion' in words[1]
    else:
        assert 'each percentage applied only to its band' in words[0]
        assert '40%' in words[1]


def test_unchanged_csv_round_trip_keeps_absent_defaults_and_content_hash(api, enabled):
    client, current, db = api
    current['uid'] = 'owner'
    book = table()
    _publish_v2(client, book)
    exported = client.get('/api/companies/adr/prices/export')
    assert exported.status_code == 200, exported.text
    preview = client.post(
        '/api/companies/adr/prices/import-preview',
        data={'change_reason': 'Round trip the current brackets'},
        files={'file': ('prices.csv', exported.content, 'text/csv')},
    )
    assert preview.status_code == 200, preview.text
    assert preview.json()['no_changes'] is True
    view = client.get('/api/companies/adr/prices').json()
    assert 'bracket_mode' not in view['policy']
    assert 'brackets' not in view['policy']['range']
    assert price_table.content_hash(view) == price_table.content_hash(book)


def _uncertainty(book):
    book['policy']['assist'] = copy.deepcopy(price_table.DEFAULT_ASSIST)
    book['policy']['assist'].update(
        range_method='uncertainty', hidden_damage_percent={'1': '10', '2': '15', '3': '25'}
    )


def _job(*rooms):
    return InspectionData(
        rooms=list(rooms), emergency_calls=0, monitoring_hours=0, air_movers=0, dehumidifiers=0
    )


def test_tiered_uncertainty_high_never_drops_when_a_cheaper_grown_room_is_added():
    book = table()
    book['items'][0]['price_brackets'] = [
        dict(up_to_sf=500, unit_price='10'),
        dict(up_to_sf=None, unit_price='1'),
    ]
    _uncertainty(book)
    existing = dict(name='Existing', category=3, finished_sf=500)
    before = estimate(book, _job(existing))
    after = estimate(book, _job(existing, dict(name='Added', finished_sf=500, waste_percent=1)))
    assert (before['low']['total'], before['high']['total']) == (D('5000'), D('6250'))
    assert (after['low']['total'], after['high']['total']) == (D('5550'), D('6805.50'))


def test_tiered_waste_basis_cushion_never_drops_when_work_is_added():
    book = table()
    book['items'][0]['price_brackets'] = [
        dict(up_to_sf=100, unit_price='10'),
        dict(up_to_sf=None, unit_price='0.10'),
    ]
    book['policy']['area_basis'] = 'demolition_with_waste'
    book['policy']['category_multipliers'] = {'1': '1', '2': '1', '3': '1.201'}
    book['policy']['range']['brackets'] = [
        dict(up_to_sf=100, percent='0'),
        dict(up_to_sf=None, percent='100'),
    ]
    existing = dict(name='Existing', finished_sf=100, waste_percent=20)
    before = estimate(book, _job(existing))
    after = estimate(book, _job(existing, dict(name='Added', category=3, finished_sf=100)))
    assert after['low']['total'] >= before['low']['total']
    assert after['high']['total'] >= before['high']['total']


def test_tiered_monotonicity_across_range_methods_area_bases_and_mixed_rooms():
    rng = random.Random(4417)
    for _ in range(300):
        book = table('tiered')
        book['items'][0]['price_brackets'] = [
            dict(up_to_sf=limit, unit_price=str(rng.randint(0, 2000) / 100))
            for limit in [200, 600, None]
        ]
        book['items'][0]['allow_zero'] = True
        book['policy']['area_basis'] = rng.choice(
            ['demolition', 'demolition_with_waste', 'wet_floor']
        )
        book['policy']['category_multipliers'] = {
            key: str(rng.randint(1000, 2500) / 1000) for key in ('1', '2', '3')
        }
        book['policy']['range']['brackets'] = [
            dict(up_to_sf=limit, percent=str(rng.randint(0, 100))) for limit in [150, 500, None]
        ]
        if rng.random() < 0.5:
            _uncertainty(book)
        rooms = [
            dict(
                name=f'Room {index}',
                category=rng.choice([1, 2, 3]),
                finished_sf=rng.randint(1, 400),
                waste_percent=rng.randint(0, 30),
            )
            for index in range(rng.randint(1, 3))
        ]
        grown = copy.deepcopy(rooms)
        if rng.random() < 0.5:
            grown.append(
                dict(
                    name='Added',
                    category=rng.choice([1, 2, 3]),
                    finished_sf=rng.randint(1, 400),
                    waste_percent=rng.randint(0, 30),
                )
            )
        else:
            grown[rng.randrange(len(grown))]['finished_sf'] += rng.choice([0.01, 1, 100])
        try:
            before = estimate(book, _job(*rooms))
        except ValueError:
            continue
        after = estimate(book, _job(*grown))
        assert after['low']['total'] >= before['low']['total']
        assert after['high']['total'] >= before['high']['total'] - D('0.02')
        assert after['high']['total'] >= after['low']['total']


def test_whole_job_picks_every_items_band_from_the_jobs_total_square_feet():
    book = table('whole-job')
    first = book['items'][0]
    first.update(
        categories=[1],
        price_brackets=[dict(up_to_sf=750, unit_price='10'), dict(up_to_sf=None, unit_price='5')],
    )
    book['items'].append(dict(first, item_id='area_work_cat3', code='AREA3', categories=[3]))
    book = price_table.normalize_table(book, publish=True)
    job = _job(
        dict(name='Kitchen', category=1, finished_sf=500),
        dict(name='Bath', category=3, finished_sf=500),
    )
    lines, _ = pricing_v2.price_scope(job, book)
    assert len(lines) == 2
    assert all('over 750 sq ft' in line['description'] for line in lines)
    assert estimate(book, job)['low']['total'] == D('5000')
    alone = estimate(book, _job(dict(name='Kitchen', category=1, finished_sf=500)))
    assert alone['low']['total'] == D('5000')


def test_bracket_spreadsheet_without_cushion_policy_is_rejected():
    import csv
    import io

    book = table('whole-job')
    exported = export_csv('company', 'v1', 1, book).decode('utf-8-sig')
    rows = list(csv.reader(io.StringIO(exported)))
    for row in rows[1:]:
        row[-2:] = ['', '']
    buffer = io.StringIO()
    csv.writer(buffer, lineterminator='\n').writerows(rows)
    with pytest.raises(ValueError, match='cushion brackets'):
        parse_upload(
            buffer.getvalue().encode('utf-8'), 'text/csv', 'company', 'v1', 1, 'dryscope-v2'
        )
