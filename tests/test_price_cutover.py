"""The owner's switch from a rate book to an owner price table, and pricing from a table."""

from copy import deepcopy
from decimal import Decimal

import pytest
from backend import ai_features, price_books, price_table
from backend.adr_price_book import adr_rates
from backend.claims import price_scope, proposal_range
from backend.contracts import InspectionData
from backend.price_book_import import export_csv
from backend.pricing import price_and_range
from tests.test_backend import sign_payload
from tests.test_price_books import _publish_v2, _v2_table, enabled, publish, rates  # noqa: F401
from tests.test_workspaces import ID, OTHER, api, data, store  # noqa: F401

V2 = price_table.CALCULATION_VERSION
START = '/api/companies/adr/prices/start-v2'
LATER = 'ADR-INS-' + 'c' * 32


def preview_of(client, copy, company='adr', reason='Switch to our own table', acks=()):
    answer = client.post(
        f'/api/companies/{company}/prices/preview',
        json={
            'items': copy['items'],
            'policy': copy['policy'],
            'acknowledgements': list(acks),
            'change_reason': reason,
        },
    )
    assert answer.status_code == 200, answer.text
    return answer.json()


def publish_preview(client, preview, company='adr'):
    answer = client.post(
        f'/api/companies/{company}/prices/publish',
        json={'preview_id': preview['preview_id'], 'expected_generation': preview['generation']},
    )
    assert answer.status_code == 200, answer.text
    return answer.json()


def zero_acks(copy):
    return [row['item_id'] for row in copy['items'] if row['unit_price'] == '0.00']


def switch(client, company='adr'):
    started = client.post(f'/api/companies/{company}/prices/start-v2')
    assert started.status_code == 200, started.text
    copy = started.json()['working_copy']
    return publish_preview(client, preview_of(client, copy, company, acks=zero_acks(copy)), company)


def job(**changes):
    return InspectionData(
        address='Synthetic',
        year_built=2000,
        scope_confirmed=True,
        **changes,
    )


def test_start_v2_maps_v1_rates_and_is_owner_only_and_idempotent(api, enabled):
    client, current, store = api
    current['uid'] = 'owner'
    own = rates(emergency_call='150.00')
    publish(client, own)
    head = deepcopy(store.db.records['_company_price_books/adr'])

    # Other roles and companies cannot start it, and nothing is written.
    for uid, status in (
        ('estimator', 403),
        ('office', 403),
        ('admin', 403),
        ('other-owner', 403),
    ):
        current['uid'] = uid
        assert client.post(START).status_code == status, uid
    assert '_price_book_drafts/adr' not in store.db.records

    current['uid'] = 'owner'
    view = client.get('/api/companies/adr/prices').json()
    assert view['switch_available'] is True
    assert view['calculation_version'] == price_books.CALCULATION_VERSION
    assert 'working_copy' not in view

    started = client.post(START)
    assert started.status_code == 200, started.text
    copy = started.json()['working_copy']
    by_id = {row['item_id']: row for row in copy['items']}
    for key, price in own.items():
        assert by_id[key]['unit_price'] == price, key
    assert copy['policy']['range'] == {
        'first_sf': 1000,
        'first_percent': '50',
        'beyond_percent': '20',
    }
    assert copy['policy']['after_hours']['multiplier'] == '1.200'
    assert copy['policy']['cabinetry'] == {'multiplier': '2.000', 'scope': 'finished_only'}

    # Starting is not switching: the company still prices from its rate book.
    assert store.db.records['_company_price_books/adr'] == head
    saved = deepcopy(store.db.records['_price_book_drafts/adr'])
    event = next(
        row
        for key, row in store.db.records.items()
        if key.startswith('_admin_events/') and row['action'] == 'price_switch_started'
    )
    assert event['company_id'] == 'adr' and event['details']['carries_prices'] is True

    # A second start changes nothing, and the page now opens the saved copy.
    again = client.post(START)
    assert again.status_code == 409
    assert store.db.records['_price_book_drafts/adr'] == saved
    view = client.get('/api/companies/adr/prices').json()
    assert view['switch_available'] is False and view['working_copy']

    # Discarding returns to the rate book, and the switch can start again.
    assert client.post('/api/companies/adr/prices/working-copy/discard').status_code == 200
    assert client.get('/api/companies/adr/prices').json()['switch_available'] is True
    assert client.post(START).status_code == 200

    # Once on a table there is nothing to switch.
    publish_preview(client, preview_of(client, started.json()['working_copy']))
    assert client.post(START).status_code == 409


def test_start_v2_is_refused_with_the_flag_off_and_for_a_suspended_company(api, enabled):
    client, current, store = api
    current['uid'] = 'owner'
    price_books.set_enabled(False)
    assert client.post(START).status_code == 404
    price_books.set_enabled(True)
    store.db.records['_companies/adr']['status'] = 'suspended'
    assert client.post(START).status_code in (403, 409)
    assert '_price_book_drafts/adr' not in store.db.records


def test_adr_switch_preview_names_the_three_differences(api, enabled):
    client, current, store = api
    current['uid'] = 'owner'
    publish(client, rates(emergency_call='150.00'))
    copy = client.post(START).json()['working_copy']
    preview = preview_of(client, copy, acks=zero_acks(copy))

    words = preview['switch']['differences']
    assert len(words) == 3
    assert 'tapers above 1,000 square feet instead of stepping' in words[0]
    assert 'Labor hours carry 50%' in words[1] and 'every job size' in words[1]
    assert 'after-hours 20%' in words[2] and 'inside the itemized total' in words[2]
    # The owner reads the same words before starting.
    page = client.get('/api/companies/adr/prices')
    assert page.json()['switch']['differences'] == words

    # An unchanged mapping lists nothing as changed and still publishes.
    assert preview['no_changes'] is False and preview['preview_id']
    assert preview['diff'] == {'items': [], 'policy': []}
    assert 'signed documents never change' in preview['effect'].lower()
    assert 'keep their current prices' in preview['effect']

    # Sample jobs are priced both ways, so the owner sees what the differences come to.
    before = {row['key']: row for row in preview['sample_before']}
    after = {row['key']: row for row in preview['sample_after']}
    assert before.keys() == after.keys() == {'small', 'medium', 'large'}
    assert before['large']['high'] != after['large']['high']

    # A price the owner changes is listed against the rates they had.
    edited = deepcopy(copy)
    next(row for row in edited['items'] if row['item_id'] == 'emergency_call')['unit_price'] = (
        '175.00'
    )
    changed = preview_of(client, edited, acks=zero_acks(copy))
    assert [row['item_id'] for row in changed['diff']['items']] == ['emergency_call']

    # The words follow the table the owner is publishing.
    edited['policy']['range'] = {'first_sf': 2000, 'first_percent': '40', 'beyond_percent': '10'}
    edited['policy']['after_hours']['multiplier'] = '1.000'
    words = preview_of(client, edited, acks=zero_acks(copy))['switch']['differences']
    assert 'above 2,000 square feet' in words[0] and 'Labor hours carry 40%' in words[1]
    assert 'no percentage' in words[2]
    edited['policy']['estimate_mode'] = 'single'
    words = preview_of(client, edited, acks=zero_acks(copy))['switch']['differences']
    assert len(words) == 2 and 'one price' in words[0]


def test_a_rate_book_company_moves_only_through_the_switch(api, enabled):
    client, current, store = api
    current['uid'] = 'owner'
    publish(client, rates(emergency_call='150.00'))
    refused = client.post(
        '/api/companies/adr/prices/preview',
        json={
            'items': _v2_table()['items'],
            'policy': _v2_table()['policy'],
            'change_reason': 'Skip the switch',
        },
    )
    assert refused.status_code == 409
    assert 'Start the switch' in refused.json()['detail']

    # Discarding the working copy after the review also stops its publish.
    copy = client.post(START).json()['working_copy']
    preview = preview_of(client, copy, acks=zero_acks(copy))
    assert client.post('/api/companies/adr/prices/working-copy/discard').status_code == 200
    late = client.post(
        '/api/companies/adr/prices/publish',
        json={'preview_id': preview['preview_id'], 'expected_generation': preview['generation']},
    )
    assert late.status_code == 409
    assert store.db.records['_company_price_books/adr'].get('calculation_version') != V2


def test_publishing_the_switch_keeps_numbering_and_records_the_source(api, enabled):
    client, current, store = api
    current['uid'] = 'owner'
    published = publish(client, rates(emergency_call='150.00'))
    result = switch(client)

    version = (
        result['version']
        if 'version' in result
        else store.db.records['_price_book_versions/' + result['version_id']]
    )
    head = store.db.records['_company_price_books/adr']
    assert head['calculation_version'] == V2
    assert head['last_v1_version_id'] == published['version_id']
    assert head['switched_at'] == version['published_at']
    assert version['sequence'] == 2 and version['source'] == 'from_v1'
    assert version['parent_version_id'] == published['version_id']
    assert '_price_book_drafts/adr' not in store.db.records

    # There is no way back: the rate book cannot be restored or republished.
    refused = client.post(
        f'/api/companies/adr/prices/versions/{published["version_id"]}/restore',
        json={'change_reason': 'Go back'},
    )
    assert refused.status_code == 409
    view = client.get('/api/companies/adr/prices').json()
    assert view['calculation_version'] == V2 and 'switch' not in view
    current['uid'] = 'estimator'
    assert client.get('/api/session').json()['pricing_version'] == V2


def test_new_company_has_no_v1_path(api, enabled):
    client, current, store = api
    current['uid'] = 'other-owner'
    view = client.get('/api/companies/other/prices').json()
    assert view['starter'] is True and view['calculation_version'] is None
    assert 'switch' not in view and 'switch_available' not in view
    assert not {row['unit_price'] for row in view['items']} - {''}
    # Nothing is seeded by reading it, and starting saves only the blank starter list.
    assert '_company_price_books/other' not in store.db.records

    # A rate book is refused however it arrives, and nothing is stored.
    own = {key: '12.34' for key in price_books.KEYS}
    typed = client.post(
        '/api/companies/other/prices/preview',
        json={'rates': own, 'acknowledgements': [], 'change_reason': 'Our own rates'},
    )
    uploaded = client.post(
        '/api/companies/other/prices/import-preview',
        files={'file': ('prices.csv', export_csv('other', 'unset', 0, own), 'text/csv')},
        data={'change_reason': 'Our own rates'},
    )
    for refused in (typed, uploaded):
        assert refused.status_code == 409, refused.text
        assert 'price table, not a rate book' in refused.json()['detail']
    assert not [key for key in store.db.records if key.startswith('_price_book_previews/')]

    started = client.post('/api/companies/other/prices/start-v2')
    assert started.status_code == 200, started.text
    copy = started.json()['working_copy']
    assert {row['item_id'] for row in copy['items']} == {
        row['item_id'] for row in price_table.starter_table()['items']
    }
    assert not {row['unit_price'] for row in copy['items']} - {''}


def test_a_company_holding_adrs_rates_starts_from_the_blank_list(api, enabled):
    client, current, store = api
    book = adr_rates()
    store.db.records['_price_book_versions/copied'] = dict(
        version_id='copied',
        company_id='other',
        sequence=1,
        rates=book,
        content_sha256=price_books.content_hash(book),
        calculation_version=price_books.CALCULATION_VERSION,
    )
    store.db.records['_company_price_books/other'] = dict(
        company_id='other', generation=1, latest_version_id='copied', next_sequence=2
    )
    current['uid'] = 'other-owner'
    view = client.get('/api/companies/other/prices').json()
    assert view['switch']['carries_prices'] is False and view['switch']['differences'] == []
    started = client.post('/api/companies/other/prices/start-v2')
    assert started.status_code == 200, started.text
    copy = started.json()['working_copy']
    assert not {row['unit_price'] for row in copy['items']} - {''}

    table = _v2_table('20.00')
    preview = preview_of(client, table, 'other')
    assert preview['sample_before'] == []
    published = publish_preview(client, preview, 'other')
    version = store.db.records['_price_book_versions/' + preview['preview_id']]
    assert version['source'] == 'manual' and published
    # Nothing keeps an old draft on rates that were never this company's.
    assert 'last_v1_version_id' not in store.db.records['_company_price_books/other']


def test_another_companys_switch_carries_only_its_own_rates(api, enabled):
    client, current, store = api
    current['uid'] = 'other-owner'
    own = {key: '12.34' for key in price_books.KEYS}
    store.db.records['_price_book_versions/own'] = dict(
        version_id='own',
        company_id='other',
        sequence=1,
        rates=own,
        content_sha256=price_books.content_hash(own),
        calculation_version=price_books.CALCULATION_VERSION,
    )
    store.db.records['_company_price_books/other'] = dict(
        company_id='other', generation=1, latest_version_id='own', next_sequence=2
    )
    copy = client.post('/api/companies/other/prices/start-v2').json()['working_copy']
    assert {row['unit_price'] for row in copy['items']} == {'12.34'}
    assert not {row['unit_price'] for row in copy['items']} & set(adr_rates().values())


def test_the_switch_turns_additional_work_off_while_priced_extras_are_off(
    api, enabled, monkeypatch
):
    client, current, store = api
    current['uid'] = 'owner'
    monkeypatch.setattr(ai_features, 'AI_FEATURES', set())
    copy = client.post(START).json()
    assert not [row for row in copy['problems'] if 'Turn this item off' in row['message']]
    extras = [row for row in copy['working_copy']['items'] if row['group'] == 'extras']
    assert [row['enabled'] for row in extras] == [False]
    assert extras[0]['unit_price'] == adr_rates()['additional_work_hourly']


@pytest.mark.parametrize('pinned', [True, False], ids=['pinned', 'not yet pinned'])
def test_a_v1_draft_keeps_v1_until_the_owner_reprices_it(api, enabled, pinned):
    client, current, store = api
    current['uid'] = 'owner'
    published = publish(client, rates(emergency_call='150.00'))
    current['uid'] = 'estimator'
    assert client.post('/api/inspections', json={'inspection_id': ID, 'data': data()}).is_success
    prices = store.workspaces.prices
    if pinned:
        pin = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
        assert pin.status_code == 200, pin.text
    before = client.get(f'/api/inspections/{ID}').json()

    current['uid'] = 'owner'
    switch(client)
    table = store.db.records['_company_price_books/adr']['latest_version_id']

    # The draft looks and prices as it did.
    record = store.get_inspection('owner', ID)
    view = prices.job_view('owner', record)
    assert 'table' not in view and view['display_rates']
    assert view['newer_available'] is True and view['can_reprice'] is True
    current['uid'] = 'estimator'
    assert client.get(f'/api/inspections/{ID}').json()['status'] == before['status']
    assert (
        prices.job_view('estimator', store.get_inspection('estimator', ID))['can_reprice'] is False
    )
    revision = store.db.records['inspections/' + ID]['revision']
    audited = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': revision})
    assert audited.status_code == 200, audited.text
    documents = audited.json()['audit']['documents']
    assert documents['price_basis']['version_id'] == published['version_id']
    assert documents['price_basis']['calculation_version'] == price_books.CALCULATION_VERSION
    assert 'estimate' not in documents or documents['estimate'] is None
    v1_low = documents['adr_estimate']['proposed_cost_low']

    # An estimator cannot move it, and only the owner's reprice does.
    assert client.post(f'/api/inspections/{ID}/pricing/reprice-preview').status_code == 403
    current['uid'] = 'owner'
    review = client.post(f'/api/inspections/{ID}/pricing/reprice-preview').json()
    assert review['from_version_id'] == published['version_id']
    assert review['to_version_id'] == table
    assert review['to_calculation_version'] == V2 and len(review['differences']) == 3
    assert float(review['before']['low']) == v1_low
    # Prices carried over one for one, so the review shows nothing but the calculation change.
    assert review['diff'] == {'items': [], 'policy': []}
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
    assert moved['calculation_version'] == V2 and moved['reason'] == 'explicit_reprice'
    assert moved['version_id'] == table
    assert 'table' in prices.job_view('owner', store.get_inspection('owner', ID))


def test_a_draft_not_yet_pinned_can_be_repriced_before_it_is_audited(api, enabled):
    client, current, store = api
    current['uid'] = 'owner'
    published = publish(client, rates(emergency_call='150.00'))
    current['uid'] = 'estimator'
    client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    current['uid'] = 'owner'
    switch(client)
    assert f'_job_pricing/{ID}' not in store.db.records
    review = client.post(f'/api/inspections/{ID}/pricing/reprice-preview').json()
    assert review['from_version_id'] == published['version_id']
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
    assert store.db.records[f'_job_pricing/{ID}']['pin_version'] == 1
    assert store.db.records[f'_job_pricing/{ID}']['calculation_version'] == V2


def test_adrs_unpublished_starting_book_switches_like_a_published_one(api, enabled):
    client, current, store = api
    current['uid'] = 'estimator'
    client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    current['uid'] = 'owner'
    assert '_company_price_books/adr' not in store.db.records
    copy = client.post(START).json()['working_copy']
    by_id = {row['item_id']: row['unit_price'] for row in copy['items']}
    assert by_id['emergency_call'] == adr_rates()['emergency_call']
    preview = preview_of(client, copy, acks=zero_acks(copy))
    assert len(preview['switch']['differences']) == 3 and preview['sample_before']
    publish_preview(client, preview)
    head = store.db.records['_company_price_books/adr']
    assert head['switched_at'] and 'last_v1_version_id' not in head

    prices = store.workspaces.prices
    view = prices.job_view('owner', store.get_inspection('owner', ID))
    assert 'table' not in view and view['can_reprice'] is True
    assert prices.ensure_pin('estimator', ID)['version_id'] == 'seed'


def test_a_job_started_after_the_switch_prices_from_the_table_and_signs(api, enabled):
    client, current, store = api
    current['uid'] = 'owner'
    publish(client, rates(emergency_call='150.00'))
    switch(client)

    current['uid'] = 'estimator'
    made = client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    assert made.status_code == 200, made.text
    pin = store.db.records[f'_job_pricing/{ID}']
    assert pin['calculation_version'] == V2 and pin['reason'] == 'first_price'
    audited = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
    assert audited.status_code == 200, audited.text
    documents = audited.json()['audit']['documents']
    assert documents['price_basis']['version_id'] == pin['version_id']
    assert documents['estimate']['mode'] == 'range'
    assert any('Emergency' in row['description'] for row in documents['xactimate_scope'])
    assert (
        documents['adr_estimate']['proposed_cost_low'] < documents['adr_estimate']['proposed_cost']
    )

    current['uid'] = 'owner'
    record = client.get(f'/api/inspections/{ID}').json()
    signed = client.post('/api/authorize', json=sign_payload(record))
    assert signed.status_code == 200, signed.text
    assert store.db.records['inspections/' + ID]['status'] == 'signed'


def test_an_empty_table_scope_reads_as_the_zero_total_message(api, enabled):
    client, current, store = api
    current['uid'] = 'owner'
    table = _v2_table('25.00')
    for row in table['items']:
        row['default_quantity'] = '0'
    _publish_v2(client, table)
    current['uid'] = 'estimator'
    empty = InspectionData(
        address='Synthetic',
        year_built=2000,
        rooms=[dict(name='Hall', category=1)],
        scope_confirmed=True,
        emergency_calls=0,
        monitoring_hours=0,
        haul_loads=0,
        air_scrubbers=0,
        hepa_filters=0,
        air_movers=0,
        dehumidifiers=0,
    ).model_dump(mode='json')
    client.post('/api/inspections', json={'inspection_id': ID, 'data': empty})
    audited = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
    assert audited.status_code == 400
    assert 'totals $0.00' in audited.json()['detail']


def test_signed_documents_do_not_change_when_the_company_switches(api, enabled):
    client, current, store = api
    current['uid'] = 'owner'
    publish(client, rates(emergency_call='150.00'))
    client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    audited = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
    signed = client.post('/api/authorize', json=sign_payload(audited.json()))
    assert signed.status_code == 200, signed.text
    record = deepcopy(store.db.records['inspections/' + ID])
    pin = deepcopy(store.db.records[f'_job_pricing/{ID}'])

    switch(client)
    assert store.db.records['inspections/' + ID] == record
    assert store.db.records[f'_job_pricing/{ID}'] == pin
    view = store.workspaces.prices.job_view('owner', store.get_inspection('owner', ID))
    assert view['can_reprice'] is False
    assert view['newer_available'] is False
    refused = client.post(f'/api/inspections/{ID}/pricing/reprice-preview')
    assert refused.status_code == 409


@pytest.mark.parametrize('company', ['adr', 'other'])
def test_a_signed_job_with_no_pin_stays_on_the_rate_book_view(api, enabled, company):
    client, current, store = api
    if company == 'adr':
        current['uid'] = 'owner'
        publish(client, rates(emergency_call='150.00'))
        held = adr_rates()
    else:
        current['uid'] = 'other-owner'
        held = {key: '12.34' for key in price_books.KEYS}
        store.db.records['_price_book_versions/own'] = dict(
            version_id='own',
            company_id='other',
            sequence=1,
            rates=held,
            content_sha256=price_books.content_hash(held),
            calculation_version=price_books.CALCULATION_VERSION,
        )
        store.db.records['_company_price_books/other'] = dict(
            company_id='other', generation=1, latest_version_id='own', next_sequence=2
        )
    client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    audited = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
    signed = client.post('/api/authorize', json=sign_payload(audited.json()))
    assert signed.status_code == 200, signed.text
    # ADR's jobs signed before price books have no pin: the migration writes none.
    del store.db.records[f'_job_pricing/{ID}']

    switch(client, company)
    view = client.get(f'/api/inspections/{ID}/pricing').json()
    assert 'table' not in view and view['pinned'] is None
    assert view['calculation_version'] == price_books.CALCULATION_VERSION
    assert view['newer_available'] is False and view['can_reprice'] is False
    assert view['pending_note'] is None
    assert (
        view['display_rates']['standard_job_charges']
        == (price_books.price_display(held)['standard_job_charges'])
    )
    assert client.post(f'/api/inspections/{ID}/pricing/reprice-preview').status_code == 409
    assert f'_job_pricing/{ID}' not in store.db.records


def test_the_session_carries_when_the_company_switched_while_the_flag_is_on(api, enabled):
    client, current, store = api
    current['uid'] = 'owner'
    publish(client, rates(emergency_call='150.00'))
    assert client.get('/api/session').json()['switched_at'] is None
    switch(client)
    stamp = store.db.records['_company_price_books/adr']['switched_at']
    assert client.get('/api/session').json()['switched_at'] == stamp
    assert client.get('/api/access').json()['switched_at'] == stamp
    price_books.set_enabled(False)
    assert client.get('/api/session').json()['switched_at'] is None


def test_flag_off_hides_editor_and_item_list_but_v2_pins_still_price(api, enabled):
    client, current, store = api
    current['uid'] = 'owner'
    publish(client, rates(emergency_call='150.00'))
    switch(client)
    current['uid'] = 'estimator'
    client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    pin = deepcopy(store.db.records[f'_job_pricing/{ID}'])
    assert pin['calculation_version'] == V2

    price_books.set_enabled(False)
    # The editor, the pricing card and the item list all go away.
    current['uid'] = 'owner'
    assert client.get('/api/companies/adr/prices').status_code == 404
    assert client.post(START).status_code == 404
    assert client.get(f'/api/inspections/{ID}/pricing').status_code == 404
    session = client.get('/api/session').json()
    assert session['price_books_enabled'] is False and session['pricing_version'] is None
    assert session['prices_set'] is True

    # The pinned job still prices from its table, and the documents print it.
    current['uid'] = 'estimator'
    audited = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
    assert audited.status_code == 200, audited.text
    documents = audited.json()['audit']['documents']
    assert documents['price_basis']['calculation_version'] == V2
    assert documents['price_basis']['version_id'] == pin['version_id']
    assert store.db.records[f'_job_pricing/{ID}'] == pin

    # A job started while it is off keeps working from the same table.
    made = client.post('/api/inspections', json={'inspection_id': LATER, 'data': data()})
    assert made.status_code == 200, made.text
    assert f'_job_pricing/{LATER}' not in store.db.records
    later = client.post('/api/audit', json={'inspection_id': LATER, 'expected_revision': 1})
    assert later.status_code == 200, later.text
    assert store.db.records[f'_job_pricing/{LATER}']['calculation_version'] == V2

    # Turning it on again changes nothing that was priced.
    price_books.set_enabled(True)
    assert store.db.records[f'_job_pricing/{ID}'] == pin


def test_the_mapped_table_prices_a_small_job_like_the_rate_book():
    book = rates(
        emergency_call='150.00', sheet_labor_hourly='50.00', after_hours_job_charge='75.00'
    )
    table = {**price_table.from_v1_rates(book), 'calculation_version': V2}
    scope = job(
        rooms=[
            dict(name='Hall', category=1, unfinished_sf=120, finished_sf=80, waste_percent=10),
            dict(name='Bath', category=2, unfinished_sf=30, finished_sf=40),
            dict(name='Den', category=3, finished_sf=60, custom_cabinetry=True),
        ],
        air_movers=4,
        dehumidifiers=2,
        drying_days=3,
        wood_floor_systems=1,
        wood_floor_days=2,
        labor_hours=4,
        matterport_scans=1,
    )
    lines, total = price_scope(scope, book)
    low, high = proposal_range(scope, lines)
    mapped = price_and_range(scope, table)
    assert Decimal(str(mapped.xactimate_total)) == Decimal(str(total))
    assert Decimal(str(mapped.low)) == Decimal(str(low))
    assert Decimal(str(mapped.high)) == Decimal(str(high))
    assert sorted(row['total'] for row in mapped.lines) == sorted(row['total'] for row in lines)

    # After hours the same range holds; the percent now sits inside the itemized total.
    late = scope.model_copy(update={'is_after_hours': True})
    lines, total = price_scope(late, book)
    low, high = proposal_range(late, lines)
    mapped = price_and_range(late, table)
    assert Decimal(str(mapped.low)) == Decimal(str(low))
    assert Decimal(str(mapped.high)) == Decimal(str(high))
    assert Decimal(str(mapped.xactimate_total)) == Decimal(str(low)) > Decimal(str(total))


def test_a_large_job_shows_the_taper_and_the_labor_difference():
    book = rates(sheet_labor_hourly='50.00')
    table = {**price_table.from_v1_rates(book), 'calculation_version': V2}
    scope = job(rooms=[dict(name='Hall', category=2, finished_sf=1500)], labor_hours=4)
    lines, _ = price_scope(scope, book)
    low, high = proposal_range(scope, lines)
    mapped = price_and_range(scope, table)
    # The same itemized work and low end; the high end tapers instead of stepping to 20%.
    assert Decimal(str(mapped.low)) == Decimal(str(low))
    labor = Decimal('200.00')
    area = sum(Decimal(str(row['total'])) for row in lines if row['unit'] == 'SF')
    expected = (
        Decimal(str(low))
        + Decimal('0.20') * area
        + Decimal('0.30') * area * Decimal(1000) / Decimal(1500)
        + Decimal('0.50') * labor
    )
    assert abs(Decimal(str(mapped.high)) - expected) <= Decimal('0.01')
    assert Decimal(str(mapped.high)) > Decimal(str(high))


def test_switch_differences_describe_the_uncertainty_method():
    table = price_table.from_v1_rates(rates())
    policy = table['policy']
    policy['assist'] = dict(
        drying_days=3,
        range_method='uncertainty',
        extra_drying_days=1,
        hidden_damage_percent={'1': '10', '2': '15', '3': '25'},
    )
    differences = price_table.switch_differences(policy)
    assert differences[:2] == [
        'The high end is built from the IICRC equipment range, 1 extra drying day and hidden '
        'damage of 10% / 15% / 25% by category instead of a flat 50% cushion.',
        "Labor hours carry the hidden-damage percent of the job's rooms at every job size.",
    ]
    # The after-hours sentence does not depend on the method.
    cushion = price_table.from_v1_rates(rates())['policy']
    assert differences[2] == price_table.switch_differences(cushion)[2]
    assert 'tapers above' in price_table.switch_differences(cushion)[0]

    policy['assist']['extra_drying_days'] = 2
    policy['assist']['hidden_damage_percent'] = {'1': '0', '2': '12.50', '3': '25'}
    assert price_table.switch_differences(policy)[0].startswith(
        'The high end is built from the IICRC equipment range, 2 extra drying days and hidden '
        'damage of 0% / 12.5% / 25% by category'
    )
    # One price has no high end to describe.
    policy['estimate_mode'] = 'single'
    assert price_table.switch_differences(policy)[0].startswith('The estimate is one price')
