"""Company price books. ADR's output matches its workbook while the feature is off."""

import csv
import io
import logging
from copy import deepcopy
from decimal import Decimal

import pytest
from backend import ai_features, price_books
from backend.claims import PRETEST, proposal_range
from tests.adr_pricing import make_documents, price_scope
from backend.contracts import AIResult, InspectionData
from backend.adr_price_book import adr_rates
from backend.price_book_import import export_csv, parse_upload
from tests.fakes import ADR_PROFILE
from tests.test_backend import sign_payload
from tests.test_workspaces import ID, api, data, store

from tests.price_book_test_support import (
    enabled,
    rates,
    publish,
    counting,
    daily_audits,
    new_window,
    _v2_table,
    extras_on,
    _publish_v2,
    _v2_csv,
    _upload,
    _table_body,
    _other_owner_export,
    _template_rows,
    _priced_template,
    _working_copy_body,
    _approved_extra,
    _calculate,
    _engine_total,
    _save_working_policy,
    _wc_body,
    _import_body,
    COPY,
    AI,
    STANDALONE,
)


@pytest.mark.parametrize('with_extras', [True, False])
def test_additional_work_prices_from_a_v2_book_with_the_flag_off(
    api, enabled, with_extras, monkeypatch
):
    if with_extras:
        monkeypatch.setattr(ai_features, 'AI_FEATURES', {'priced_extras'})
    client, current, store = api
    current['uid'] = 'estimator'
    client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    current['uid'] = 'owner'
    _publish_v2(client, _v2_table('25.00', extras=with_extras))
    profile = store.db.records['_companies/adr']['profile']
    if with_extras:
        assert profile['additional_work_rate'] == '25.00'
    else:
        assert 'additional_work_rate' not in profile

    extra_id, request = _approved_extra(store)
    price_books.set_enabled(False)
    if not with_extras:
        # ADR's own book must not fill in for a table whose additional-work item is off.
        with pytest.raises(ValueError, match='additional-work hourly rate'):
            store.quote_extra('owner', ID, 2)
        with pytest.raises(ValueError, match='additional-work hourly rate'):
            store.approve_extra('owner', ID, extra_id, request)
        assert store.db.records['inspections/' + ID]['data']['extras'][0].get('approval') is None
        return
    quote = store.quote_extra('owner', ID, 2)
    assert (quote['rate'], quote['total']) == ('25.00', '50.00')
    request.expected_price_hash = quote['price_rate_fingerprint']
    store.approve_extra('owner', ID, extra_id, request)
    approval = store.db.records['inspections/' + ID]['data']['extras'][0]['approval']
    assert approval['rate'] == '25.00'


def test_additional_work_keeps_the_profile_rate_with_the_flag_off(api):
    client, current, store = api
    current['uid'] = 'estimator'
    client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    assert store.quote_extra('owner', ID, 2)['rate'] == '47.46'


def test_calculate_returns_samples_and_publish_problems(api, enabled, caplog):
    client, current, _ = api
    current['uid'] = 'owner'
    table = _v2_table('25.00')
    table['items'][0]['unit_price'] = ''
    with caplog.at_level(logging.ERROR):
        answer = client.post(
            '/api/companies/adr/prices/calculate',
            json={'items': table['items'], 'policy': table['policy']},
        )
    assert answer.status_code == 200, answer.text
    samples = answer.json()['samples']
    assert [sample['key'] for sample in samples] == ['small', 'medium', 'large']
    assert all(sample['incomplete'] for sample in samples)
    assert any('enter a unit price' in row['message'] for row in answer.json()['problems'])
    assert 'Storage operation failed' not in caplog.text


def test_calculate_prices_each_sample_from_the_table_it_was_sent(api, enabled):
    client, current, _ = api
    current['uid'] = 'owner'
    table = _v2_table('25.00')
    samples = _calculate(client, table)
    for key, sample in samples.items():
        assert sample['notice'] == 'Sample job only. This does not price a saved job.'
        assert sample['label'] and sample['description']
        assert sample['mode'] == 'range' and sample['incomplete'] is False
        assert sample['low'] == f'${_engine_total(table, key, "low"):,.2f}'
        assert sample['high'] == f'${_engine_total(table, key, "high"):,.2f}'
    dearer = _calculate(client, _v2_table('50.00'))
    for key in samples:
        assert Decimal(dearer[key]['low'].strip('$').replace(',', '')) > Decimal(
            samples[key]['low'].strip('$').replace(',', '')
        )

    table['policy']['estimate_mode'] = 'single'
    single = _calculate(client, table)['medium']
    assert single['mode'] == 'single' and single['high'] is None


def test_calculate_leaves_out_a_sample_nothing_priced_touches(api, enabled):
    from backend import price_table

    client, current, _ = api
    current['uid'] = 'owner'
    table = price_table.starter_table()
    assert _calculate(client, table) == {}
    for item in table['items']:
        if item['item_id'] == 'service_call':
            item['unit_price'] = '150.00'
    samples = _calculate(client, table)
    # Only the small sample has an emergency call.
    assert list(samples) == ['small'] and samples['small']['incomplete'] is True


@pytest.mark.parametrize('item_id', ['hepa_vacuum', 'surface_cleaning', 'antimicrobial'])
def test_a_floor_priced_item_moves_the_mold_sample(api, enabled, item_id):
    client, current, _ = api
    current['uid'] = 'owner'
    table = _v2_table('25.00')
    before = _calculate(client, table)['large']
    next(row for row in table['items'] if row['item_id'] == item_id)['unit_price'] = '50.00'
    after = _calculate(client, table)['large']
    assert after['low'] != before['low'] and after['high'] != before['high']


def test_the_wet_floor_basis_prices_the_whole_mold_sample(api, enabled):
    client, current, _ = api
    current['uid'] = 'owner'
    table = _v2_table('25.00')
    for item in table['items']:
        if item['group'] == 'demolition' and item['quantity_source'].startswith('room:demolition'):
            item['quantity_source'] = 'room:basis'
    table['policy']['area_basis'] = 'demolition'
    demolition = _calculate(client, table)['large']
    table['policy']['area_basis'] = 'wet_floor'
    # The sample's wet floor is the same 2,500 sq ft as its demolition.
    assert _calculate(client, table)['large']['low'] == demolition['low']


def test_preview_stores_the_samples_before_and_after_the_change(api, enabled):
    client, current, db = api
    current['uid'] = 'owner'
    first = _v2_table('25.00')
    review = client.post(
        '/api/companies/adr/prices/preview',
        json={'items': first['items'], 'policy': first['policy'], 'change_reason': 'First table'},
    ).json()
    assert review['sample_before'] == []
    assert [sample['key'] for sample in review['sample_after']] == ['small', 'medium', 'large']
    _publish_v2(client, first, 'First table')

    second = _v2_table('50.00')
    review = client.post(
        '/api/companies/adr/prices/preview',
        json={'items': second['items'], 'policy': second['policy'], 'change_reason': 'Dearer'},
    ).json()
    assert [row['low'] for row in review['sample_before']] == [
        sample['low'] for sample in _calculate(client, first).values()
    ]
    assert [row['low'] for row in review['sample_after']] == [
        sample['low'] for sample in _calculate(client, second).values()
    ]
    assert review['sample_before'][0]['low'] != review['sample_after'][0]['low']
    stored = db.workspaces.prices.ws.read('_price_book_previews', review['preview_id'])
    assert stored['sample_before'] == review['sample_before']
    assert stored['sample_after'] == review['sample_after']


def test_calculate_refuses_a_sample_choice_it_cannot_honor(api, enabled):
    client, current, _ = api
    current['uid'] = 'owner'
    table = _v2_table('25.00')
    answer = client.post(
        '/api/companies/adr/prices/calculate',
        json={'items': table['items'], 'policy': table['policy'], 'sample': 'small'},
    )
    assert answer.status_code == 422


def test_import_preview_takes_the_published_policy_not_the_working_copy(api, enabled):
    client, current, store = api
    current['uid'] = 'owner'
    table = _v2_table('30.00')
    table['policy']['overhead_profit_percent'] = '10'
    head = _publish_v2(client, table)
    _save_working_policy(client, 'adr', head['generation'])

    uploaded = _upload(client, _v2_csv(base=head['version_id'], generation=head['generation']))
    assert uploaded.status_code == 200, uploaded.text
    preview = store.db.records['_price_book_previews/' + uploaded.json()['preview_id']]
    assert preview['policy']['overhead_profit_percent'] == '10'


def test_first_import_preview_takes_the_starter_policy_not_the_working_copy(api, enabled):
    from backend import price_table

    client, current, store = api
    current['uid'] = 'other-owner'
    rows = _template_rows(_other_owner_export(client).content)
    _save_working_policy(client, 'other', 0)

    uploaded = client.post(
        '/api/companies/other/prices/import-preview',
        files={'file': ('prices.csv', _priced_template(rows), 'text/csv')},
        data={'change_reason': 'First owner table'},
    )
    assert uploaded.status_code == 200, uploaded.text
    preview = store.db.records['_price_book_previews/' + uploaded.json()['preview_id']]
    assert preview['policy'] == price_table.starter_table()['policy']


@pytest.mark.parametrize(
    'price,copied',
    [('0.00', False), ('0.01', True), ('10000.00', True), ('10000.01', False)],
)
def test_v2_publish_copies_only_a_valid_profile_rate(api, enabled, extras_on, price, copied):
    client, current, store = api
    current['uid'] = 'owner'
    table = _v2_table('25.00', extras=True)
    extras = next(item for item in table['items'] if item['group'] == 'extras')
    extras['unit_price'] = price
    extras['allow_zero'] = price == '0.00'
    _publish_v2(client, table, acknowledgements=[extras['item_id']] if price == '0.00' else [])

    profile = store.db.records['_companies/adr']['profile']
    if copied:
        assert profile['additional_work_rate'] == price
    else:
        assert 'additional_work_rate' not in profile


def test_v1_publish_deletes_the_working_copy(api, enabled):
    client, current, store = api
    current['uid'] = 'owner'
    table = _v2_table('25.00')
    saved = client.put(
        '/api/companies/adr/prices/working-copy',
        json={'expected_working_version': 0, 'items': table['items'], 'policy': table['policy']},
    )
    assert saved.status_code == 200, saved.text
    assert '_price_book_drafts/adr' in store.db.records

    publish(client, rates(emergency_call='150.00'))

    assert '_price_book_drafts/adr' not in store.db.records
    assert client.get('/api/companies/adr/prices').json().get('working_copy') is None


def test_locked_extras_are_refused_at_preview_and_the_profile_stays(api, enabled):
    client, current, store = api
    current['uid'] = 'owner'
    before = deepcopy(store.db.records['_companies/adr'])

    refused = client.post(
        '/api/companies/adr/prices/preview', json=_table_body(_v2_table('25.00', extras=True))
    )
    assert 400 <= refused.status_code < 500
    assert 'Turn this item off' in refused.json()['detail']

    assert store.db.records['_companies/adr'] == before
    assert '_company_price_books/adr' not in store.db.records


def test_locked_extras_are_refused_on_upload(api, enabled):
    client, current, store = api
    current['uid'] = 'other-owner'
    rows = _template_rows(_other_owner_export(client).content)
    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=list(rows[0]), lineterminator='\n')
    writer.writeheader()
    for row in rows:
        writer.writerow({**row, 'unit_price': '40.00'} if row['enabled'] == 'yes' else row)
    before = deepcopy(store.db.records['_companies/other'])

    uploaded = client.post(
        '/api/companies/other/prices/import-preview',
        files={'file': ('prices.csv', out.getvalue().encode('utf-8'), 'text/csv')},
        data={'change_reason': 'First owner table'},
    )
    assert 400 <= uploaded.status_code < 500
    assert 'Turn this item off' in uploaded.json()['detail']
    assert store.db.records['_companies/other'] == before
    assert '_company_price_books/other' not in store.db.records


def test_extras_locked_after_preview_is_refused_inside_publish(
    api, enabled, extras_on, monkeypatch
):
    client, current, store = api
    current['uid'] = 'owner'
    preview = client.post(
        '/api/companies/adr/prices/preview', json=_table_body(_v2_table('25.00', extras=True))
    )
    assert preview.status_code == 200, preview.text
    before = deepcopy(store.db.records['_companies/adr'])

    monkeypatch.setattr(ai_features, 'AI_FEATURES', set())
    saved = client.post(
        '/api/companies/adr/prices/publish',
        json={'preview_id': preview.json()['preview_id'], 'expected_generation': 0},
    )
    assert 400 <= saved.status_code < 500
    assert 'Turn this item off' in saved.json()['detail']
    assert store.db.records['_companies/adr'] == before
    assert not store.db.records.get('_company_price_books/adr', {}).get('latest_version_id')


def test_working_copy_keeps_a_locked_extras_item_and_reports_it_like_publish(api, enabled):
    client, current, _ = api
    current['uid'] = 'owner'
    table = _v2_table('25.00', extras=True)
    saved = client.put(
        '/api/companies/adr/prices/working-copy',
        json={'expected_working_version': 0, 'items': table['items'], 'policy': table['policy']},
    )
    assert saved.status_code == 200, saved.text
    assert any('Turn this item off' in row['message'] for row in saved.json()['problems'])

    calculated = client.post(
        '/api/companies/adr/prices/calculate',
        json={'items': table['items'], 'policy': table['policy']},
    )
    assert calculated.status_code == 200, calculated.text
    assert any('Turn this item off' in row['message'] for row in calculated.json()['problems'])


def test_v2_book_audits_from_its_pin_and_reprices_only_on_the_owners_word(api, enabled):
    client, current, store = api
    current['uid'] = 'owner'
    _publish_v2(client, _v2_table('25.00'))

    current['uid'] = 'estimator'
    job = data()
    job['scope_confirmed'] = True
    created = client.post('/api/inspections', json={'inspection_id': ID, 'data': job})
    assert created.status_code == 200, created.text
    pinned = store.db.records.get(f'_job_pricing/{ID}')
    assert pinned['calculation_version'] == 'dryscope-v2'
    audited = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
    assert audited.status_code == 200, audited.text
    documents = audited.json()['audit']['documents']
    assert documents['price_basis']['calculation_version'] == 'dryscope-v2'
    assert documents['estimate']['mode'] == 'range'
    # The audit writes no pin of its own; the pin is the one made when the draft was created.
    assert store.db.records.get(f'_job_pricing/{ID}') == pinned

    prices = store.workspaces.prices
    current['uid'] = 'owner'
    record = store.get_inspection('owner', ID)
    assert prices.job_view('owner', record)['can_reprice'] is False
    _publish_v2(client, _v2_table('30.00'), 'Raise every price')
    record = store.get_inspection('owner', ID)
    view = prices.job_view('owner', record)
    assert view['newer_available'] is True and view['can_reprice'] is True
    # Nothing moves until the owner applies the table to this draft.
    assert store.db.records[f'_job_pricing/{ID}'] == pinned
    assert record['audit'] is not None

    preview = client.post(f'/api/inspections/{ID}/pricing/reprice-preview')
    assert preview.status_code == 200, preview.text
    review = preview.json()
    assert review['from_calculation_version'] == review['to_calculation_version'] == 'dryscope-v2'
    assert review['differences'] == []
    assert any(row['change'] == 'price' for row in review['diff']['items'])
    assert float(review['after']['low']) > float(review['before']['low'])
    applied = client.post(
        f'/api/inspections/{ID}/pricing/reprice',
        json={
            'expected_revision': review['revision'],
            'expected_pin_hash': review['from_hash'],
            'destination_version_id': review['to_version_id'],
            'destination_hash': review['to_hash'],
        },
    )
    assert applied.status_code == 200, applied.text
    moved = store.db.records[f'_job_pricing/{ID}']
    assert moved['version_id'] == review['to_version_id']
    assert moved['reason'] == 'explicit_reprice' and moved['pin_version'] == 2
    assert 'rates' not in moved and moved['items'][0]['unit_price'] == '30.00'
    assert store.db.records['inspections/' + ID]['audit'] is None


def test_v1_pinned_draft_is_offered_a_v2_book_and_moves_only_when_applied(api, enabled):
    client, current, store = api
    current['uid'] = 'estimator'
    client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    prices = store.workspaces.prices
    pin = prices.ensure_pin('estimator', ID)
    assert pin['calculation_version'] == price_books.CALCULATION_VERSION

    current['uid'] = 'owner'
    _publish_v2(client, _v2_table('25.00'))
    book = prices.effective(store.workspaces.read('_companies', 'adr'))
    record = store.get_inspection('owner', ID)
    view = prices.job_view('owner', record)
    assert view['newer_available'] is True and view['can_reprice'] is True
    assert store.db.records[f'_job_pricing/{ID}']['version_id'] == pin['version_id']

    review = prices.reprice_preview('owner', record)
    assert review['from_calculation_version'] == price_books.CALCULATION_VERSION
    assert review['to_calculation_version'] == 'dryscope-v2'
    assert len(review['differences']) == 3
    prices.reprice(
        'owner',
        ID,
        {
            'expected_revision': record['revision'],
            'expected_pin_hash': pin['content_sha256'],
            'destination_version_id': book['version_id'],
            'destination_hash': book['content_sha256'],
        },
    )
    moved = store.db.records[f'_job_pricing/{ID}']
    assert moved['version_id'] == book['version_id']
    assert moved['calculation_version'] == 'dryscope-v2'
    assert 'rates' not in moved


def test_additional_work_on_a_v2_book_prices_from_its_extras_item(api, enabled, extras_on):
    client, current, store = api
    current['uid'] = 'owner'
    _publish_v2(client, _v2_table('25.00', extras=True))
    company = store.db.records['_companies/adr']
    source = store.workspaces.prices.approval_source(company)
    assert source['calculation_version'] == 'dryscope-v2'
    current['uid'] = 'estimator'
    client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    quote = client.post(f'/api/inspections/{ID}/extras/quote', json={'hours': '2.5'})
    assert quote.status_code == 200, quote.text
    assert quote.json()['rate'] == '25.00' and quote.json()['total'] == '62.50'


@pytest.mark.parametrize('audited', [False, True])
def test_legacy_draft_keeps_the_seed_when_the_company_publishes_v2(api, enabled, audited):
    client, current, store = api
    current['uid'] = 'estimator'
    client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    record = store.db.records['inspections/' + ID]
    if audited:
        record['audit'] = {'documents': {}}
    else:
        record['created_at'] = '2020-01-01T00:00:00+00:00'
    current['uid'] = 'owner'
    _publish_v2(client, _v2_table('25.00'))

    pin = store.workspaces.prices.ensure_pin('estimator', ID)
    assert pin['version_id'] == 'seed'
    assert pin['calculation_version'] == price_books.CALCULATION_VERSION
    assert pin['reason'] == 'legacy_rollout'


def test_estimator_export_hides_disabled_items_and_owner_only_columns(api, enabled, extras_on):
    from backend import price_table

    client, current, _ = api
    current['uid'] = 'owner'
    table = _v2_table('25.00', extras=True)
    disabled = next(item for item in table['items'] if not item['enabled'])
    disabled['unit_price'] = '77.00'
    zero = table['items'][0]
    zero['allow_zero'] = True
    published = _publish_v2(client, table)

    def exported(version=None):
        path = '/api/companies/adr/prices/export'
        res = client.get(path, params={'version_id': version} if version else None)
        assert res.status_code == 200, res.text
        return list(csv.DictReader(io.StringIO(res.content.decode('utf-8-sig'))))

    owner_rows = exported()
    assert disabled['item_id'] in {row['item_id'] for row in owner_rows}
    assert {r['allow_zero'] for r in owner_rows if r['item_id'] == zero['item_id']} == {'yes'}

    current['uid'] = 'estimator'
    for rows in (exported(), exported(published['version_id'])):
        assert len(rows) == len(price_table.starter_table()['items']) - 1
        assert disabled['item_id'] not in {row['item_id'] for row in rows}
        assert {row['allow_zero'] for row in rows} == {'no'}


def test_effective_takes_only_a_company_record(store):
    prices = store.workspaces.prices

    assert prices.effective(store.workspaces.read('_companies', 'adr'))['company_id'] == 'adr'
    with pytest.raises(TypeError):
        prices.effective('adr')
    with pytest.raises(TypeError):
        prices.effective('no-such-company')


def test_working_copy_routes_are_owner_only(api, enabled):
    client, current, _ = api
    table = _v2_table('30.00')
    current['uid'] = 'owner'
    head = _publish_v2(client, _v2_table('20.00'), 'Head for the working copy')
    saved = client.put(
        '/api/companies/adr/prices/working-copy',
        json=_wc_body(table, expected_generation=head['generation']),
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()['working_version'] == 1
    assert saved.json()['working_copy']['items'][0]['unit_price'] == '30.00'
    # The owner reads the copy back with the page, disabled items included.
    page = client.get('/api/companies/adr/prices').json()
    assert page['working_copy']['working_version'] == 1
    assert any(not item['enabled'] for item in page['working_copy']['items'])

    for uid in ('estimator', 'office', 'admin', 'other-owner'):
        current['uid'] = uid
        put = client.put(
            '/api/companies/adr/prices/working-copy',
            json=_wc_body(table, expected_generation=1, expected_working_version=1),
        )
        assert put.status_code in (403, 404), (uid, put.text)
        assert client.post('/api/companies/adr/prices/working-copy/discard').status_code in (
            403,
            404,
        ), uid
    # Members who may read prices never receive the working copy.
    current['uid'] = 'estimator'
    read = client.get('/api/companies/adr/prices')
    assert read.status_code == 200
    assert read.json().get('working_copy') is None
    assert read.json()['can_manage'] is False

    price_books.set_enabled(False)
    current['uid'] = 'owner'
    assert (
        client.put(
            '/api/companies/adr/prices/working-copy',
            json=_wc_body(table, expected_generation=1, expected_working_version=1),
        ).status_code
        == 404
    )


def test_preview_diff_lists_items_policy_and_warnings(api, enabled):
    client, current, _ = api
    current['uid'] = 'owner'
    head = _v2_table('20.00')
    _publish_v2(client, head, 'First table')
    changed = deepcopy(head)
    changed['items'][0]['unit_price'] = '40.00'  # +100 percent
    changed['items'][1]['enabled'] = False
    changed['items'][2]['unit_price'] = '0.00'
    changed['items'][2]['allow_zero'] = True
    changed['items'][3]['taxable'] = True
    changed['items'] = changed['items'][:-1] + [
        {**deepcopy(changed['items'][-1]), 'item_id': 'extra_new', 'code': 'EXTRA-NEW'}
    ]
    changed['policy']['estimate_mode'] = 'single'
    changed['policy']['sales_tax'] = {'enabled': True, 'percent': '8'}
    changed['policy']['after_hours']['label'] = 'Night work'
    preview = client.post(
        '/api/companies/adr/prices/preview',
        json={
            'items': changed['items'],
            'policy': changed['policy'],
            'acknowledgements': [changed['items'][2]['item_id']],
            'change_reason': 'Quarterly review',
        },
    )
    assert preview.status_code == 200, preview.text
    body = preview.json()
    kinds = {(row['item_id'], row['change']) for row in body['diff']['items']}
    assert (changed['items'][0]['item_id'], 'price') in kinds
    assert (changed['items'][1]['item_id'], 'enabled') in kinds
    assert ('extra_new', 'added') in kinds
    assert (head['items'][-1]['item_id'], 'removed') in kinds
    fields = {row['field'] for row in body['diff']['policy']}
    assert {
        'estimate_mode',
        'sales_tax.enabled',
        'sales_tax.percent',
        'after_hours.label',
    } <= fields
    assert {'large_change', 'zero_price', 'disabled_items', 'mode_change', 'tax_change'} <= set(
        body['warnings']
    )


def test_import_replaces_items_and_keeps_policy(api, enabled):
    from backend import price_book_import, price_table

    client, current, db = api
    current['uid'] = 'owner'
    table = _v2_table('25.00')
    table['policy']['overhead_profit_percent'] = '10'
    table['policy']['after_hours']['label'] = 'Night work'
    _publish_v2(client, table, 'Head with a policy')
    company, base_version, generation, exported = db.workspaces.prices.export_rows('owner', 'adr')
    changed = deepcopy(exported)
    changed[0]['unit_price'] = '31.00'
    raw = price_book_import.export_csv(company, base_version, generation, changed)
    boundary = 'xBOUNDARYx'
    body = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="p.csv"\r\n'
        f'Content-Type: text/csv\r\n\r\n'.encode()
        + raw
        + f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="change_reason"\r\n\r\n'
        f'Imported prices\r\n--{boundary}--\r\n'.encode()
    )
    preview = client.post(
        '/api/companies/adr/prices/import-preview',
        content=body,
        headers={'Content-Type': f'multipart/form-data; boundary={boundary}'},
    )
    assert preview.status_code == 200, preview.text
    result = preview.json()
    assert [row['change'] for row in result['diff']['items']] == ['price']
    assert result['diff']['policy'] == []
    assert result['sample_before'] and result['sample_after']
    client.post(
        '/api/companies/adr/prices/publish',
        json={'preview_id': result['preview_id'], 'expected_generation': result['generation']},
    )
    view = client.get('/api/companies/adr/prices').json()
    assert view['policy']['overhead_profit_percent'] == '10'
    assert view['policy']['after_hours']['label'] == 'Night work'
    assert price_table.starter_table()['items'][0]['item_id'] == view['items'][0]['item_id']


def test_import_that_raises_a_waste_shows_it_in_the_review(api, enabled):
    from backend import price_book_import

    client, current, db = api
    current['uid'] = 'owner'
    _publish_v2(client, _v2_table('25.00'), 'Head before the waste change')
    company, base_version, generation, exported = db.workspaces.prices.export_rows('owner', 'adr')
    changed = deepcopy(exported)
    changed[0]['waste_percent'] = '50'
    raw = price_book_import.export_csv(company, base_version, generation, changed)

    preview = client.post(
        '/api/companies/adr/prices/import-preview',
        content=_import_body(raw, 'xBOUNDARYx', change_reason='Waste from the file'),
        headers={'Content-Type': 'multipart/form-data; boundary=xBOUNDARYx'},
    )
    assert preview.status_code == 200, preview.text
    row = preview.json()['diff']['items'][0]
    assert row['item_id'] == changed[0]['item_id']
    assert row['change'] == 'fields'
    assert [field['field'] for field in row['fields']] == ['waste_percent']
    assert row['fields'][0]['before'] == exported[0]['waste_percent']
    assert Decimal(row['fields'][0]['after']) == 50


def test_calculate_is_stateless_and_quota_limited(api, enabled):
    client, current, db = api
    table = _v2_table('30.00')
    table['items'][0]['unit_price'] = ''
    current['uid'] = 'owner'
    before = {key for key in db.db.records}
    result = client.post(
        '/api/companies/adr/prices/calculate',
        json={'items': table['items'], 'policy': table['policy']},
    )
    assert result.status_code == 200, result.text
    assert any(row['item_id'] == table['items'][0]['item_id'] for row in result.json()['problems'])
    created = {key for key in db.db.records} - before
    assert not any(
        key.startswith(('_price_book_drafts', '_price_book_previews')) for key in created
    )
    for uid in ('estimator', 'office'):
        current['uid'] = uid
        assert (
            client.post(
                '/api/companies/adr/prices/calculate',
                json={'items': table['items'], 'policy': table['policy']},
            ).status_code
            == 403
        ), uid
    current['uid'] = 'owner'
    statuses = [
        client.post(
            '/api/companies/adr/prices/calculate',
            json={'items': table['items'], 'policy': table['policy']},
        ).status_code
        for _ in range(300)
    ]
    # The first call above used one of the 300.
    assert statuses[0] == 200 and statuses[298] == 200 and statuses[299] == 429


def test_heavy_sample_editing_cannot_block_preview_or_publish(api, enabled):
    client, current, _ = api
    current['uid'] = 'owner'
    table = _v2_table('30.00')
    for _ in range(100):
        assert (
            client.post(
                '/api/companies/adr/prices/calculate',
                json={'items': table['items'], 'policy': table['policy']},
            ).status_code
            == 200
        )
    published = _publish_v2(client, table, 'Published after a long edit')
    assert published['generation'] == 1


def test_import_with_a_zero_price_needs_the_confirmation(api, enabled):
    from backend import price_book_import

    client, current, db = api
    current['uid'] = 'owner'
    _publish_v2(client, _v2_table('25.00'), 'Head before a zero price')
    company, base_version, generation, exported = db.workspaces.prices.export_rows('owner', 'adr')
    changed = deepcopy(exported)
    changed[0]['unit_price'] = '0.00'
    changed[0]['allow_zero'] = True
    changed[0]['enabled'] = True
    raw = price_book_import.export_csv(company, base_version, generation, changed)
    headers = {'Content-Type': 'multipart/form-data; boundary=xBOUNDARYx'}

    refused = client.post(
        '/api/companies/adr/prices/import-preview',
        content=_import_body(raw, 'xBOUNDARYx', change_reason='Free first row'),
        headers=headers,
    )
    assert refused.status_code == 400 or refused.status_code == 422, refused.text
    assert 'confirm that a zero unit price' in refused.text

    confirmed = client.post(
        '/api/companies/adr/prices/import-preview',
        content=_import_body(
            raw, 'xBOUNDARYx', change_reason='Free first row', confirm_zero_prices='yes'
        ),
        headers=headers,
    )
    assert confirmed.status_code == 200, confirmed.text
    assert 'zero_price' in confirmed.json()['warnings']


def test_the_waste_basis_is_published_and_kept_by_an_import(api, enabled):
    client, current, store = api
    current['uid'] = 'owner'
    table = _v2_table('30.00')
    table['policy']['area_basis'] = 'demolition_with_waste'
    head = _publish_v2(client, table)
    assert client.get('/api/companies/adr/prices').json()['policy']['area_basis'] == (
        'demolition_with_waste'
    )

    # The file holds items only, so an import reprices them under the published settings.
    uploaded = _upload(client, _v2_csv(base=head['version_id'], generation=head['generation']))
    assert uploaded.status_code == 200, uploaded.text
    preview = store.db.records['_price_book_previews/' + uploaded.json()['preview_id']]
    assert preview['policy']['area_basis'] == 'demolition_with_waste'


def test_the_review_reports_a_change_to_the_waste_basis(api, enabled):
    client, current, _ = api
    current['uid'] = 'owner'
    table = _v2_table('30.00')
    _publish_v2(client, table)
    table['policy']['area_basis'] = 'demolition_with_waste'
    preview = client.post(
        '/api/companies/adr/prices/preview',
        json={
            'items': table['items'],
            'policy': table['policy'],
            'acknowledgements': [],
            'change_reason': 'Count waste in the area',
        },
    )
    assert preview.status_code == 200, preview.text
    assert {
        'field': 'area_basis',
        'before': 'demolition',
        'after': 'demolition_with_waste',
    } in preview.json()['diff']['policy']
