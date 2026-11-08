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


def test_v2_version_pin_basis_round_trip(api, enabled):
    from backend import price_table
    from backend.workspaces import Conflict

    client, current, db = api
    current['uid'] = 'owner'
    table = _v2_table('30.00')
    published = _publish_v2(client, table, 'Publish v2 table')
    assert published['sequence'] == 1
    current_book = client.get('/api/companies/adr/prices').json()
    assert current_book['calculation_version'] == price_table.CALCULATION_VERSION
    assert 'items' in current_book and 'policy' in current_book

    prices = db.workspaces.prices
    eff = prices.effective(db.workspaces.read('_companies', 'adr'))
    assert eff['calculation_version'] == price_table.CALCULATION_VERSION
    assert eff['version_id'] == published['version_id']
    assert eff['content_sha256'] == price_table.content_hash(table)
    assert 'items' in eff and 'policy' in eff and 'rates' not in eff

    current['uid'] = 'estimator'
    created = client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    assert created.status_code == 200, created.text
    record = db.get_inspection('estimator', ID)

    pin = prices.ensure_pin('estimator', ID)
    assert pin['calculation_version'] == price_table.CALCULATION_VERSION
    assert pin['version_id'] == published['version_id']
    assert pin['content_sha256'] == eff['content_sha256']
    assert 'items' in pin and 'policy' in pin and 'rates' not in pin

    basis = prices.basis_for(pin, 'adr')
    assert basis['calculation_version'] == price_table.CALCULATION_VERSION
    assert basis['version_id'] == pin['version_id']
    assert basis['content_sha256'] == pin['content_sha256']
    assert basis['policy'] == pin['policy']
    assert basis['item_count'] == len(pin['items'])
    assert 'rates' not in basis and 'items' not in basis

    # Tampered item price is rejected by basis_for
    tampered_item = deepcopy(pin)
    tampered_item['items'][0]['unit_price'] = '999.00'
    with pytest.raises(Conflict, match="This draft's saved prices are missing"):
        prices.basis_for(tampered_item, 'adr')

    # Tampered policy (including after_hours.label and minimum_job_charge) is rejected
    tampered_label = deepcopy(pin)
    tampered_label['policy']['after_hours']['label'] = 'Tampered label'
    with pytest.raises(Conflict, match="This draft's saved prices are missing"):
        prices.basis_for(tampered_label, 'adr')

    tampered_min = deepcopy(pin)
    tampered_min['policy']['minimum_job_charge'] = '750.00'
    with pytest.raises(Conflict, match="This draft's saved prices are missing"):
        prices.basis_for(tampered_min, 'adr')

    # A v1-shaped pin claiming a v2 calculation_version or v2 version_id is rejected
    v1_impostor = {
        'inspection_id': ID,
        'company_id': 'adr',
        'version_id': published['version_id'],
        'sequence': 1,
        'content_sha256': price_books.content_hash(adr_rates()),
        'calculation_version': price_table.CALCULATION_VERSION,
        'rates': adr_rates(),
        'priced_at': pin['priced_at'],
        'priced_by_uid': 'estimator',
    }
    with pytest.raises(Conflict):
        prices.basis_for(v1_impostor, 'adr')

    # assert_pin succeeds with matching audit price_basis and rejects mismatches
    audited_record = deepcopy(record)
    audited_record['audit'] = {
        'price_basis': basis,
        'documents': {'price_basis': basis},
    }
    prices.assert_pin(audited_record, basis)

    bad_basis = deepcopy(basis)
    bad_basis['content_sha256'] = '0' * 64
    with pytest.raises(Conflict):
        prices.assert_pin(audited_record, bad_basis)

    # job_view returns estimator-filtered public items + policy for v2 pins
    view = prices.job_view('estimator', audited_record)
    assert view['pinned']['version_id'] == published['version_id']
    assert view['newer_available'] is False
    assert view['calculation_version'] == price_table.CALCULATION_VERSION
    assert 'items' in view['table'] and 'policy' in view['table']
    assert all('enabled' not in it for it in view['table']['items'])


def test_v1_pins_and_versions_still_validate_unchanged(api, enabled, monkeypatch):
    client, current, db = api
    calls = counting(monkeypatch)
    current['uid'] = 'owner'
    published = publish(client, rates(emergency_call='145.00'), 'V1 trip rate')
    assert published['sequence'] == 1

    prices = db.workspaces.prices
    eff = prices.effective(db.workspaces.read('_companies', 'adr'))
    assert set(eff.keys()) == {
        'company_id',
        'version_id',
        'sequence',
        'parent_version_id',
        'catalog_version',
        'calculation_version',
        'currency',
        'rates',
        'content_sha256',
        'published_by_uid',
        'published_at',
        'effective_from',
        'source',
        'change_reason',
        'import_digest',
        'generation',
    }

    current['uid'] = 'estimator'
    client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    audited = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
    assert audited.status_code == 200, audited.text
    doc_basis = audited.json()['audit']['documents']['price_basis']
    pin = db.db.records[f'_job_pricing/{ID}']
    assert prices.basis_for(pin, 'adr') == doc_basis
    assert set(doc_basis.keys()) == {
        'company_id',
        'version_id',
        'sequence',
        'content_sha256',
        'calculation_version',
        'priced_at',
        'rates',
    }
    saved_rec = db.get_inspection('estimator', ID)
    prices.assert_pin(saved_rec, doc_basis)
    jview = prices.job_view('estimator', saved_rec)
    assert jview['pinned'] is not None and 'display_rates' in jview and 'table' not in jview

    # Audit reuse is byte-identical
    model_count = len(calls)
    reused = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
    assert reused.status_code == 200, reused.text
    assert reused.json()['audit'] == audited.json()['audit']
    assert len(calls) == model_count


def test_working_copy_save_conflicts_and_is_never_used_for_pricing(api, enabled):
    from backend import price_table

    client, current, db = api
    current['uid'] = 'owner'
    head = _publish_v2(client, _v2_table('25.00'), 'Published v2 head')
    assert head['generation'] == 1

    # Working copy starts empty on GET /api/companies/adr/prices
    initial = client.get('/api/companies/adr/prices').json()
    assert initial['working_copy'] is None

    # Save a working copy with a blank price on an enabled item (allowed in working copy, reported in publish_problems)
    draft_table = _v2_table('40.00')
    draft_table['items'][0]['unit_price'] = ''
    draft_table['policy']['after_hours']['label'] = 'Night & weekend dispatch'
    draft_table['policy']['minimum_job_charge'] = '350.00'

    saved_wc = client.put(
        '/api/companies/adr/prices/working-copy',
        json={
            'expected_working_version': 0,
            'expected_generation': 1,
            'items': draft_table['items'],
            'policy': draft_table['policy'],
        },
    )
    assert saved_wc.status_code == 200, saved_wc.text
    wc_body = saved_wc.json()
    assert wc_body['working_copy']['working_version'] == 1
    assert wc_body['working_copy']['base_generation'] == 1
    assert wc_body['working_copy']['policy']['after_hours']['label'] == 'Night & weekend dispatch'
    assert wc_body['working_copy']['policy']['minimum_job_charge'] == '350'
    assert wc_body['problems']

    # Stale expected_working_version returns 409
    stale_ver = client.put(
        '/api/companies/adr/prices/working-copy',
        json={
            'expected_working_version': 0,
            'expected_generation': 1,
            'items': draft_table['items'],
            'policy': draft_table['policy'],
        },
    )
    assert stale_ver.status_code == 409

    # Stale expected_generation returns 409
    stale_gen = client.put(
        '/api/companies/adr/prices/working-copy',
        json={
            'expected_working_version': 1,
            'expected_generation': 0,
            'items': draft_table['items'],
            'policy': draft_table['policy'],
        },
    )
    assert stale_gen.status_code == 409

    # Pinning a job while a working copy exists pins the published head (25.00), never the working copy (40.00)
    current['uid'] = 'estimator'
    est_prices = client.get('/api/companies/adr/prices').json()
    assert est_prices['working_copy'] is None
    client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    pin = db.workspaces.prices.ensure_pin('estimator', ID)
    assert pin['version_id'] == head['version_id']
    assert pin['content_sha256'] == price_table.content_hash(_v2_table('25.00'))
    assert pin['items'][0]['unit_price'] == '25.00'
    assert pin['policy']['minimum_job_charge'] == '0'

    # Role matrix on working-copy PUT and DELETE/discard
    for role_uid, expected_status in (
        ('estimator', 403),
        ('office', 403),
        ('admin', 403),
        ('other-owner', 403),
    ):
        current['uid'] = role_uid
        res = client.put(
            '/api/companies/adr/prices/working-copy',
            json={
                'expected_working_version': 1,
                'expected_generation': 1,
                'items': draft_table['items'],
                'policy': draft_table['policy'],
            },
        )
        assert res.status_code == expected_status, (role_uid, res.text)
        del_res = client.delete('/api/companies/adr/prices/working-copy')
        assert del_res.status_code == expected_status, (role_uid, del_res.text)

    # Discard working copy via DELETE and re-save, then discard via POST /working-copy/discard
    current['uid'] = 'owner'
    discarded = client.delete('/api/companies/adr/prices/working-copy')
    assert discarded.status_code == 200, discarded.text
    assert discarded.json()['working_copy'] is None
    assert '_price_book_drafts/adr' not in db.db.records

    resaved = client.put(
        '/api/companies/adr/prices/working-copy',
        json={
            'expected_working_version': 0,
            'expected_generation': 1,
            'items': draft_table['items'],
            'policy': draft_table['policy'],
        },
    )
    assert resaved.status_code == 200, resaved.text
    discarded_post = client.post('/api/companies/adr/prices/working-copy/discard')
    assert discarded_post.status_code == 200, discarded_post.text
    assert discarded_post.json()['working_copy'] is None

    # Save working copy again, then publish a new v2 table and verify publish deletes the working copy
    resaved2 = client.put(
        '/api/companies/adr/prices/working-copy',
        json={
            'expected_working_version': 0,
            'expected_generation': 1,
            'items': draft_table['items'],
            'policy': draft_table['policy'],
        },
    )
    assert resaved2.status_code == 200
    assert '_price_book_drafts/adr' in db.db.records
    published2 = _publish_v2(client, _v2_table('35.00'), 'Second v2 head')
    assert published2['sequence'] == 2
    assert '_price_book_drafts/adr' not in db.db.records
    after_pub = client.get('/api/companies/adr/prices').json()
    assert after_pub['working_copy'] is None

    # Flag off returns 404
    price_books.set_enabled(False)
    assert (
        client.put(
            '/api/companies/adr/prices/working-copy',
            json={
                'expected_working_version': 0,
                'expected_generation': 2,
                'items': draft_table['items'],
                'policy': draft_table['policy'],
            },
        ).status_code
        == 404
    )
    assert client.delete('/api/companies/adr/prices/working-copy').status_code == 404


def test_restore_across_calculation_versions_is_refused(api, enabled):
    client, current, db = api
    current['uid'] = 'owner'
    v2_first = _publish_v2(client, _v2_table('25.00'), 'First v2 version')
    v2_second = _publish_v2(client, _v2_table('30.00'), 'Second v2 version')
    assert v2_second['sequence'] == 2
    v1_id = 'a' * 32
    seed = adr_rates()
    db.db.records['_price_book_versions/' + v1_id] = {
        'version_id': v1_id,
        'company_id': 'adr',
        'sequence': 0,
        'calculation_version': price_books.CALCULATION_VERSION,
        'rates': seed,
        'content_sha256': price_books.content_hash(seed),
    }

    # Restoring the v1 version when head is v2 is refused with 409
    refused_v1 = client.post(
        f'/api/companies/adr/prices/versions/{v1_id}/restore',
        json={'change_reason': 'Try restore v1'},
    )
    assert refused_v1.status_code == 409, refused_v1.text
    assert (
        'This version uses the previous calculation. Start from the current table.'
        in refused_v1.json()['detail']
    )

    # There is no seed to restore.
    refused_seed = client.post(
        '/api/companies/adr/prices/versions/seed/restore',
        json={'change_reason': 'Try restore seed'},
    )
    assert refused_seed.status_code == 404, refused_seed.text

    # Restoring the earlier v2 version when head is v2 succeeds
    restored_v2 = client.post(
        f'/api/companies/adr/prices/versions/{v2_first["version_id"]}/restore',
        json={'change_reason': 'Restore earlier v2 table'},
    )
    assert restored_v2.status_code == 200, restored_v2.text
    assert restored_v2.json()['diff']


def test_every_publish_path_writes_the_calculation_version_on_the_head(api, enabled):
    from backend import price_table
    from backend.price_book_migration import apply_plan, build_plan

    client, current, store = api
    apply_plan(store, build_plan(store.db, ['adr']), True)
    head = store.db.records['_company_price_books/adr']
    assert head['calculation_version'] == price_books.CALCULATION_VERSION
    current['uid'] = 'owner'
    publish(client, rates(emergency_call='150.00'))
    head = store.db.records['_company_price_books/adr']
    assert head['calculation_version'] == price_books.CALCULATION_VERSION
    assert head['schema_version'] == 1

    del store.db.records['_company_price_books/adr']
    for key in [k for k in store.db.records if k.startswith('_price_book_versions/')]:
        del store.db.records[key]
    _publish_v2(client, _v2_table('25.00'))
    head = store.db.records['_company_price_books/adr']
    assert head['calculation_version'] == price_table.CALCULATION_VERSION
    assert head['schema_version'] == 2


def test_head_saved_before_the_field_existed_still_prices_as_v1(api, enabled):
    from backend.price_book_migration import apply_plan, build_plan

    client, current, store = api
    apply_plan(store, build_plan(store.db, ['adr']), True)
    del store.db.records['_company_price_books/adr']['calculation_version']

    book = store.workspaces.prices.effective(store.workspaces.read('_companies', 'adr'))
    assert book['calculation_version'] == price_books.CALCULATION_VERSION

    current['uid'] = 'owner'
    refused = client.post('/api/companies/adr/prices/preview', json=_table_body(_v2_table()))
    assert refused.status_code == 409
    migrated = store.db.records['_company_price_books/adr']['latest_version_id']
    restored = client.post(
        f'/api/companies/adr/prices/versions/{migrated}/restore',
        json={'change_reason': 'Back to the starting book'},
    )
    assert restored.status_code == 200, restored.text


def test_company_on_a_published_v1_book_cannot_move_to_v2(api, enabled):
    client, current, store = api
    current['uid'] = 'owner'
    published = publish(client, rates(emergency_call='150.00'))
    before = deepcopy(store.db.records['_company_price_books/adr'])

    refused = client.post('/api/companies/adr/prices/preview', json=_table_body(_v2_table()))
    assert refused.status_code == 409
    assert 'previous calculation' in refused.json()['detail']

    uploaded = _upload(client, _v2_csv(base=published['version_id'], generation=1))
    assert uploaded.status_code == 409, uploaded.text
    assert 'previous calculation' in uploaded.json()['detail']
    assert store.db.records['_company_price_books/adr'] == before


def test_publish_refuses_a_v2_preview_once_the_head_is_v1(api, enabled):
    from backend.workspaces import Conflict

    client, current, store = api
    current['uid'] = 'owner'
    prices = store.workspaces.prices
    preview = prices.preview('owner', 'adr', {**_table_body(_v2_table()), 'source': 'manual'})
    published = publish(client, rates(emergency_call='150.00'))
    head = store.db.records['_company_price_books/adr']
    store.db.records['_price_book_previews/' + preview['preview_id']]['base_generation'] = head[
        'generation'
    ]
    with pytest.raises(Conflict, match='previous calculation'):
        prices.publish('owner', 'adr', preview['preview_id'], head['generation'])
    assert head['latest_version_id'] == published['version_id']


def test_no_book_company_is_served_the_starter_and_can_round_trip_its_template(api, enabled):
    from backend import price_table

    client, current, store = api
    current['uid'] = 'other-owner'
    view = client.get('/api/companies/other/prices').json()
    assert view['starter'] is True
    assert view['calculation_version'] is None
    assert (view['version_id'], view['generation'], view['sequence']) == ('unset', 0, 0)
    assert {row['unit_price'] for row in view['rates']} == {''}
    assert view['working_copy'] is None and view['can_manage'] is True
    starter = price_table.starter_table()
    assert len(view['items']) == len(starter['items'])
    assert all(item['unit_price'] == '' for item in view['items'])
    assert view['policy'] == price_table.normalize_policy(starter['policy'])

    exported = _other_owner_export(client)
    assert b'133.95' not in exported.content
    rows = _template_rows(exported.content)
    assert len(rows) == len(starter['items'])
    assert {row['template_version'] for row in rows} == {price_table.TEMPLATE_VERSION}
    assert {row['base_version_id'] for row in rows} == {'starter'}
    assert {row['base_generation'] for row in rows} == {'0'}
    assert {row['unit_price'] for row in rows} == {''}
    # Nothing was written by reading.
    assert '_company_price_books/other' not in store.db.records

    sheet = _other_owner_export(client, 'xlsx')
    assert parse_upload(
        sheet.content, sheet.headers['content-type'], 'other', 'starter', 0, 'dryscope-v2'
    )

    uploaded = client.post(
        '/api/companies/other/prices/import-preview',
        files={'file': ('prices.csv', _priced_template(rows), 'text/csv')},
        data={'change_reason': 'First owner table'},
    )
    assert uploaded.status_code == 200, uploaded.text
    assert uploaded.json()['base_version_id'] is None
    saved = client.post(
        '/api/companies/other/prices/publish',
        json={'preview_id': uploaded.json()['preview_id'], 'expected_generation': 0},
    )
    assert saved.status_code == 200, saved.text
    version = store.db.records['_price_book_versions/' + saved.json()['version_id']]
    assert version['calculation_version'] == price_table.CALCULATION_VERSION
    assert version['source'] == 'import'

    after = client.get('/api/companies/other/prices').json()
    assert after['starter'] is False and after['version_id'] == saved.json()['version_id']


def test_no_book_company_template_and_view_for_readers_and_v1_file(api, enabled):
    client, current, store = api
    current['uid'] = 'other-owner'
    v1_file = export_csv('other', 'seed', 0, adr_rates())
    refused = client.post(
        '/api/companies/other/prices/import-preview',
        files={'file': ('prices.csv', v1_file, 'text/csv')},
        data={'change_reason': 'Old template'},
    )
    assert refused.status_code == 400
    assert 'Download a new template' in refused.json()['detail']

    # Asking for the seed version as a template still gives no workbook rates.
    named = client.get('/api/companies/other/prices/export', params={'version_id': 'seed'})
    assert b'133.95' not in named.content and b'dryscope-prices-v1' in named.content

    records = store.db.records
    estimator = 'other-estimator'
    records['_memberships/' + estimator] = {
        **records['_memberships/other-owner'],
        'uid': estimator,
        'role': 'estimator',
    }
    current['uid'] = estimator
    view = client.get('/api/companies/other/prices').json()
    assert view['starter'] is True and view['can_manage'] is False
    assert view['working_copy'] is None
    assert 'testing_coordination' not in {item['item_id'] for item in view['items']}
    assert all('enabled' not in item for item in view['items'])


def test_workbook_company_and_published_books_keep_the_v1_view_and_template(api, enabled):
    client, current, store = api
    current['uid'] = 'owner'
    view = client.get('/api/companies/adr/prices').json()
    assert 'starter' not in view and 'working_copy' not in view and view['rates']
    assert view['version_id'] == 'seed'
    assert b'dryscope-prices-v1' in client.get('/api/companies/adr/prices/export').content
    starter = {'version_id': 'starter'}
    assert client.get('/api/companies/adr/prices/export', params=starter).status_code == 404

    # The API refuses a new company a rate book, so a book of its own is stored directly.
    current['uid'] = 'other-owner'
    book = {**adr_rates(), 'additional_work_hourly': '', 'emergency_call': '150.00'}
    store.db.records['_price_book_versions/own'] = dict(
        version_id='own',
        company_id='other',
        sequence=1,
        rates=book,
        content_sha256=price_books.content_hash(book),
        calculation_version=price_books.CALCULATION_VERSION,
    )
    store.db.records['_company_price_books/other'] = dict(
        company_id='other', generation=1, latest_version_id='own', next_sequence=2
    )
    view = client.get('/api/companies/other/prices').json()
    assert 'starter' not in view and view['rates']
    assert b'dryscope-prices-v1' in client.get('/api/companies/other/prices/export').content
    assert client.get('/api/companies/other/prices/export', params=starter).status_code == 404


def test_company_with_no_published_book_may_publish_v2_by_form(api, enabled):
    from backend import price_table

    client, current, store = api
    current['uid'] = 'owner'
    _publish_v2(client, _v2_table('25.00'))
    head = store.db.records['_company_price_books/adr']
    assert head['calculation_version'] == price_table.CALCULATION_VERSION

    v1_refused = client.post(
        '/api/companies/adr/prices/preview',
        json={'rates': rates(), 'change_reason': 'Back to v1 rates'},
    )
    assert v1_refused.status_code == 409
    assert 'owner price table' in v1_refused.json()['detail']


@pytest.mark.parametrize('company,uid', [('other', 'other-owner'), ('adr', 'owner')])
def test_owner_reads_back_a_working_copy_before_any_v2_publish(api, enabled, company, uid):
    client, current, _ = api
    current['uid'] = uid
    path = f'/api/companies/{company}/prices'
    saved = client.put(path + '/working-copy', json=_working_copy_body(_v2_table('')))
    assert saved.status_code == 200, saved.text

    view = client.get(path).json()
    assert view['working_copy']['working_version'] == 1
    stale = client.put(path + '/working-copy', json=_working_copy_body(_v2_table('')))
    assert stale.status_code == 409


def test_working_copy_stays_owner_only_on_a_v1_view(api, enabled):
    client, current, _ = api
    current['uid'] = 'owner'
    client.put('/api/companies/adr/prices/working-copy', json=_working_copy_body(_v2_table('')))
    current['uid'] = 'estimator'
    assert 'working_copy' not in client.get('/api/companies/adr/prices').json()


def test_version_detail_diff_hides_disabled_items_from_readers(api, enabled):
    client, current, _ = api
    current['uid'] = 'owner'
    table = _v2_table('25.00')
    hidden = next(item for item in table['items'] if not item['enabled'])
    hidden['unit_price'] = '77.00'
    first = _publish_v2(client, table)

    second_table = deepcopy(table)
    second_table['items'][0]['enabled'] = False
    just_disabled = second_table['items'][0]['item_id']
    removed = second_table['items'].pop(1)['item_id']
    second = _publish_v2(client, second_table, 'Second table')

    def detail(version):
        res = client.get(f'/api/companies/adr/prices/versions/{version["version_id"]}')
        assert res.status_code == 200, res.text
        return res.json()

    owner_first = detail(first)
    assert hidden['item_id'] in {row['item_id'] for row in owner_first['diff']['items']}
    owner_second = detail(second)
    assert {just_disabled, removed} <= {row['item_id'] for row in owner_second['diff']['items']}

    current['uid'] = 'estimator'
    first_rows = detail(first)['diff']['items']
    assert hidden['item_id'] not in {row['item_id'] for row in first_rows}
    assert first_rows and '77.00' not in {row['after'] for row in first_rows}
    reader_second = detail(second)
    assert reader_second['diff']['items'] == []
    assert 'disabled_items' not in reader_second['warnings']
