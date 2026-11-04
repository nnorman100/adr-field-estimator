"""Job close, the company history sidecar and the estimate-accuracy statistics (plan PR 10)."""

from copy import deepcopy
from decimal import Decimal

import pytest
from backend import ai_features, insights, outcomes, price_table, signing_links
from backend.contracts import InspectionData
from backend.outcomes import ROW_LIMIT, history_row_at_signing, landed, p80, statistics
from backend.prompts import audit_prompt
from backend.signing_links import link_documents
from tests.fakes import png
from tests.test_backend import sign_payload
from tests.test_price_books import _publish_v2, _v2_table, enabled  # noqa: F401
from tests.test_workspaces import ID, SIGNED, api, data, signed_job, store  # noqa: F401

HISTORY = '_estimate_history/adr'


@pytest.fixture
def assist(monkeypatch):
    monkeypatch.setattr(ai_features, 'AI_FEATURES', {'estimate_assist'})


def row_of(store, job=ID, company='adr'):
    return store.db.records['_estimate_history/' + company]['rows'][job]


def close_body(client, current, final='3310.00', days=4, note='', uid='office', job=ID):
    current['uid'] = 'owner'
    signed_at = client.get(f'/api/jobs/{job}/outcome').json()['signed_at']
    current['uid'] = uid
    return dict(final_amount=final, actual_days=days, note=note, expected_signed_at=signed_at)


def close(client, current, job=ID, **kwargs):
    body = close_body(client, current, job=job, **kwargs)
    return client.post(f'/api/jobs/{job}/close', json=body)


def signed_v2(client, current, store, rooms, table=None, **fields):
    """A v2 job priced and signed through the routes, on a table the owner published."""
    current['uid'] = 'owner'
    _publish_v2(client, table or _v2_table(), 'Synthetic table for the close tests')
    current['uid'] = 'estimator'
    job = InspectionData(
        address='Synthetic property',
        year_built=2000,
        rooms=rooms,
        air_movers=3,
        dehumidifiers=1,
        drying_days=fields.pop('drying_days', 3),
        scope_confirmed=True,
        **fields,
    ).model_dump(mode='json')
    created = client.post('/api/inspections', json={'inspection_id': ID, 'data': job})
    assert created.status_code == 200, created.text
    record = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
    assert record.status_code == 200, record.text
    payload = sign_payload(record.json())
    assert client.post('/api/authorize', json=payload).status_code == 200
    return store.db.records['authorizations/' + payload['auth_id']]


def test_signing_writes_a_history_row_with_the_proposals_low_high_area_category_and_labor_material_v1(
    api,
):
    client, current, store = api
    signed_job(client, current, store)
    agreement = store.db.records['authorizations/' + SIGNED]
    row = row_of(store)
    assert row['auth_id'] == SIGNED
    assert row['signed_at'] == agreement['created_at']
    assert row['calculation_version'] == 'adr-residential-v1'
    assert row['estimate_mode'] == 'range'
    assert row['low'] == f'{Decimal(str(agreement["proposed_cost_low"])):.2f}'
    assert row['high'] == f'{Decimal(str(agreement["proposed_cost"])):.2f}'
    # The single room in data(): 10 finished sq ft, category 1.
    assert (row['sf'], row['category'], row['single_category']) == ('10.00', 1, True)
    demolition = [
        item['total']
        for item in agreement['documents']['xactimate_scope']
        if item['code'] in ('ADR-DEMO', 'ADR-LABOR')
    ]
    assert Decimal(row['labor_material_low']) == Decimal(str(sum(demolition)))
    assert Decimal(row['labor_material_low']) > 0
    assert row['planned_days'] == agreement['inspection']['drying_days']
    assert 'closed_at' not in row and 'final' not in row
    assert store.db.records[HISTORY]['company_id'] == 'adr'


def test_signing_writes_a_history_row_on_a_table_and_single_modes_high_is_null(
    api, enabled, assist
):
    client, current, store = api
    table = _v2_table()
    table['policy']['estimate_mode'] = 'single'
    table['policy']['area_basis'] = 'wet_floor'
    agreement = signed_v2(
        client,
        current,
        store,
        [
            dict(name='Kitchen', category=2, finished_sf=100, floor_sf=200, wet_floor_sf=140),
            dict(name='Hall', category=3, unfinished_sf=50, floor_sf=60),
        ],
        table,
    )
    row = row_of(store)
    assert row['calculation_version'] == price_table.CALCULATION_VERSION
    assert row['estimate_mode'] == 'single'
    assert row['high'] is None
    assert row['low'] == f'{Decimal(str(agreement["proposed_cost"])):.2f}'
    # Wet floor basis: 140 stated, and the floor area where no wet floor is stated.
    assert (row['sf'], row['category'], row['single_category']) == ('200.00', 3, False)
    assert Decimal(row['labor_material_low']) > 0


def test_a_range_table_row_uses_the_demolition_area_and_the_proposal_amounts(api, enabled, assist):
    client, current, store = api
    agreement = signed_v2(
        client,
        current,
        store,
        [dict(name='Kitchen', category=2, finished_sf=100, unfinished_sf=20)],
    )
    row = row_of(store)
    assert row['estimate_mode'] == 'range'
    assert row['sf'] == '120.00'
    assert row['low'] == f'{Decimal(str(agreement["proposed_cost_low"])):.2f}'
    assert row['high'] == f'{Decimal(str(agreement["proposed_cost"])):.2f}'


def test_a_link_signature_writes_the_same_row_as_one_on_the_phone(api):
    client, current, store = api
    current['uid'] = 'estimator'
    client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    record = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1}).json()
    token, _ = signing_links.mint(
        store, 'estimator', ID, record['revision'], record['audit']['proposal_hash']
    )
    signer = dict(
        signer_name='Synthetic Signer',
        signer_role='owner',
        documents_reviewed=True,
        electronic_consent=True,
        consent_version=signing_links.CONSENT_VERSION,
        signature_png=png(),
    )
    receipt = signing_links.sign(store, token, signer, dict(ip_address='', user_agent=''))
    row = row_of(store)
    assert row['auth_id'] == receipt['auth_id']
    agreement = store.db.records['authorizations/' + receipt['auth_id']]
    assert row['low'] == f'{Decimal(str(agreement["proposed_cost_low"])):.2f}'
    assert row['signed_at'] == agreement['created_at']


def test_a_pricing_failure_never_stops_a_signature(api, enabled, assist, monkeypatch):
    client, current, store = api

    def broken(*args):
        raise ValueError('synthetic pricing failure')

    real = outcomes.price_and_range
    monkeypatch.setattr(outcomes, 'price_and_range', broken)
    try:
        agreement = signed_v2(client, current, store, [dict(name='Room', finished_sf=10)])
    finally:
        monkeypatch.setattr(outcomes, 'price_and_range', real)
    assert agreement['status'] == 'saved'
    assert row_of(store)['labor_material_low'] == '0.00'


@pytest.mark.parametrize(
    'uid, status, message',
    [
        ('owner', 200, None),
        ('office', 200, None),
        ('estimator', 403, 'Only the owner or office staff can close a job.'),
        ('admin', 403, None),
        ('other-owner', 404, None),
    ],
)
def test_close_is_owner_or_office_only_and_needs_a_signed_job(api, assist, uid, status, message):
    client, current, store = api
    signed_job(client, current, store)
    answer = close(client, current, uid=uid)
    assert answer.status_code == status, answer.text
    if message:
        assert answer.json()['detail'] == message
    if status == 200:
        assert answer.json()['closed'] is True
        assert answer.json()['final'] == '3310.00'
        assert row_of(store)['closed_by_uid'] == uid
    else:
        assert 'closed_at' not in row_of(store)


def test_closing_an_unsigned_job_is_refused(api, assist):
    client, current, store = api
    current['uid'] = 'estimator'
    client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    current['uid'] = 'office'
    answer = client.post(
        f'/api/jobs/{ID}/close',
        json=dict(final_amount='10.00', actual_days=1, note='', expected_signed_at='x'),
    )
    assert answer.status_code == 409
    assert answer.json()['detail'] == 'Close a job after it is signed.'
    assert client.get(f'/api/jobs/{ID}/outcome').status_code == 404


def test_the_routes_answer_404_with_the_flag_off(api, monkeypatch):
    client, current, store = api
    signed_job(client, current, store)
    monkeypatch.setattr(ai_features, 'AI_FEATURES', set())
    current['uid'] = 'owner'
    assert client.get(f'/api/jobs/{ID}/outcome').status_code == 404
    assert (
        client.post(
            f'/api/jobs/{ID}/close',
            json=dict(final_amount='10.00', actual_days=1, note='', expected_signed_at='x'),
        ).status_code
        == 404
    )
    assert client.get('/api/companies/adr/estimate-accuracy').status_code == 404
    # The row is written regardless, so closes and statistics have history when the flag turns on.
    assert row_of(store)['auth_id'] == SIGNED


def test_a_stale_phone_is_told_to_reload_and_records_nothing(api, assist):
    client, current, store = api
    signed_job(client, current, store)
    current['uid'] = 'office'
    answer = client.post(
        f'/api/jobs/{ID}/close',
        json=dict(final_amount='10.00', actual_days=1, note='', expected_signed_at='2020-01-01'),
    )
    assert answer.status_code == 409
    assert answer.json()['detail'] == 'Reload this job.'
    assert 'closed_at' not in row_of(store)


@pytest.mark.parametrize(
    'amount', ['', 'abc', '0', '0.00', '12.345', '-5.00', '2000000.01', '1e3', 'NaN', 12.5, None]
)
def test_a_bad_amount_gets_the_fixed_message(api, assist, amount):
    client, current, store = api
    signed_job(client, current, store)
    answer = close(client, current, final=amount)
    assert answer.status_code == 400, answer.text
    assert answer.json()['detail'] == 'Enter the final invoiced amount as dollars and cents.'


@pytest.mark.parametrize('days', [-1, 366, 3.5, '4', True])
def test_bad_days_get_the_fixed_message(api, assist, days):
    client, current, store = api
    signed_job(client, current, store)
    answer = close(client, current, days=days)
    assert answer.status_code == 400, answer.text
    assert answer.json()['detail'] == 'Actual drying days must be a whole number from 0 to 365.'


@pytest.mark.parametrize(
    'amount, stored', [('2000000.00', '2000000.00'), ('0.01', '0.01'), ('3310', '3310.00')]
)
def test_amounts_are_stored_as_two_decimal_strings(api, assist, amount, stored):
    client, current, store = api
    signed_job(client, current, store)
    assert close(client, current, final=amount, days=None).status_code == 200
    assert row_of(store)['final'] == stored
    assert row_of(store)['actual_days'] is None


@pytest.mark.parametrize(
    'final, expected',
    [('50.00', 'below'), ('100.00', 'inside'), ('150.00', 'inside'), ('150.01', 'above')],
)
def test_landed_in_range_mode(final, expected):
    assert landed(final, dict(low='100.00', high='150.00')) == expected


@pytest.mark.parametrize(
    'final, expected', [('50.00', 'inside'), ('100.00', 'inside'), ('101.00', 'above')]
)
def test_landed_in_single_mode(final, expected):
    assert landed(final, dict(low='100.00', high=None)) == expected


def admin_events(store, action='job_closed'):
    return [
        value
        for key, value in store.db.records.items()
        if key.startswith('_admin_events/') and value['action'] == action
    ]


def test_close_records_landed_and_is_audited_without_amounts(api, assist):
    client, current, store = api
    signed_job(client, current, store)
    row = row_of(store)
    final = f'{Decimal(row["low"]) - 1:.2f}'
    answer = close(client, current, final=final, note='  Supplement   approved  ')
    assert answer.status_code == 200
    assert answer.json()['landed'] == 'below'
    assert answer.json()['landed_text'] == 'below the low end'
    assert row_of(store)['note'] == 'Supplement approved'
    events = admin_events(store)
    assert len(events) == 1
    assert events[0]['details'] == {'job_id': ID, 'landed': 'below'}
    assert events[0]['company_id'] == 'adr'
    assert final not in str(events[0])
    # Re-closing overwrites and is audited again.
    again = close(client, current, final=row['low'], days=5)
    assert again.json()['landed'] == 'inside'
    assert row_of(store)['actual_days'] == 5
    assert len(admin_events(store)) == 2


def test_a_job_signed_before_the_feature_gets_its_row_at_close(api, assist):
    client, current, store = api
    signed_job(client, current, store)
    before = deepcopy(row_of(store))
    del store.db.records[HISTORY]
    answer = close(client, current)
    assert answer.status_code == 200, answer.text
    after = row_of(store)
    assert {key: after[key] for key in before} == before
    assert after['final'] == '3310.00'


def test_a_job_with_no_saved_amounts_cannot_close_and_records_nothing(api, assist):
    client, current, store = api
    signed_job(client, current, store)
    del store.db.records[HISTORY]
    agreement = store.db.records['authorizations/' + SIGNED]
    del agreement['proposed_cost']
    answer = close(client, current)
    assert answer.status_code == 400
    assert HISTORY not in store.db.records


def test_the_row_limit_drops_the_oldest_signed_row(api):
    client, current, store = api
    rows = {
        f'ADR-INS-{i:032d}': dict(signed_at=f'2026-01-01T00:00:{i % 60:02d}+00:00', auth_id='a')
        for i in range(ROW_LIMIT)
    }
    oldest = 'ADR-INS-' + '0' * 32
    rows[oldest]['signed_at'] = '2020-01-01T00:00:00+00:00'
    store.db.records[HISTORY] = dict(company_id='adr', rows=rows)
    signed_job(client, current, store)
    kept = store.db.records[HISTORY]['rows']
    assert len(kept) == ROW_LIMIT
    assert oldest not in kept
    assert ID in kept


def test_closing_a_job_older_than_every_row_keeps_its_close(api, assist):
    client, current, store = api
    signed_job(client, current, store)
    rows = {
        f'ADR-INS-{i:032d}': dict(signed_at='2100-01-01T00:00:00+00:00') for i in range(ROW_LIMIT)
    }
    store.db.records[HISTORY] = dict(company_id='adr', rows=rows)
    answer = close(client, current)
    assert answer.status_code == 200
    assert answer.json()['closed'] is True
    assert len(store.db.records[HISTORY]['rows']) == ROW_LIMIT


def test_prefilled_actual_days_come_from_drying_watch_when_on_else_the_plan(
    api, assist, monkeypatch
):
    client, current, store = api
    signed_job(client, current, store)
    current['uid'] = 'office'
    planned = store.db.records['authorizations/' + SIGNED]['inspection']['drying_days']
    plan = client.get(f'/api/jobs/{ID}/outcome').json()
    assert plan['suggested_actual_days'] == planned == plan['planned_days']
    assert plan['suggested_days_source'] == 'plan'

    monkeypatch.setattr(ai_features, 'AI_FEATURES', {'estimate_assist', 'drying_watch'})
    watch = dict(status='active', day_number=7)
    monkeypatch.setattr(store.workspaces.monitoring, 'compute', lambda job: dict(watch))
    # Monitoring still running: the watch's day is not yet the actual count.
    assert client.get(f'/api/jobs/{ID}/outcome').json()['suggested_days_source'] == 'plan'
    for status in ('dry_standard_met', 'marked_dry', 'closed'):
        watch['status'] = status
        finished = client.get(f'/api/jobs/{ID}/outcome').json()
        assert finished['suggested_actual_days'] == 7
        assert finished['suggested_days_source'] == 'drying_watch'

    def missing(job):
        raise LookupError('This older agreement has no saved drying plan.')

    monkeypatch.setattr(store.workspaces.monitoring, 'compute', missing)
    assert client.get(f'/api/jobs/{ID}/outcome').json()['suggested_days_source'] == 'plan'


def test_estimators_read_closed_yes_no_without_amounts(api, assist):
    client, current, store = api
    signed_job(client, current, store)
    current['uid'] = 'estimator'
    assert client.get(f'/api/jobs/{ID}/outcome').json() == dict(
        closed=False, closed_at=None, can_close=False
    )
    assert close(client, current, uid='office').status_code == 200
    current['uid'] = 'estimator'
    seen = client.get(f'/api/jobs/{ID}/outcome')
    closed_at = row_of(store)['closed_at']
    assert seen.json() == dict(closed=True, closed_at=closed_at, can_close=False)
    assert seen.headers['Cache-Control'] == 'private, no-store'


def test_an_estimator_off_the_job_and_another_company_get_404(api, assist):
    client, current, store = api
    signed_job(client, current, store)
    for uid in ('estimator2', 'other-owner'):
        current['uid'] = uid
        assert client.get(f'/api/jobs/{ID}/outcome').status_code == 404
    current['uid'] = 'admin'
    assert client.get(f'/api/jobs/{ID}/outcome').status_code == 403


def fixture_row(category, low, final, labor_material, single=True, planned=3, actual=None):
    row = dict(
        signed_at='2026-10-01T00:00:00+00:00',
        category=category,
        single_category=single,
        low=low,
        high=f'{Decimal(low) * Decimal("1.2"):.2f}',
        estimate_mode='range',
        labor_material_low=labor_material,
        planned_days=planned,
        closed_at='2026-10-20T00:00:00+00:00',
        final=final,
        actual_days=actual,
    )
    row['landed'] = landed(final, row)
    return row


def closed_jobs():
    """Fifteen closed jobs and one still open, mostly on $1,000 of labor and materials, by hand:

    Category 2 overruns: 0, 5, 10, 12, 18, 20, 40 percent; the 80th percentile of 7 is element
    ceil(5.6) - 1 = 5 (20%), already on a 5. Category 1 overruns: 0, 1, 7, 8, 11 percent;
    element ceil(4) - 1 = 3 (8%), rounded up to 10.
    Category 3 and the multi-category job have too few or do not count.
    """
    rows = [
        fixture_row(2, '2000.00', f'{2000 + percent * 10}.00', '1000.00', actual=3 + extra)
        for percent, extra in zip((0, 5, 10, 12, 18, 20, 40), (0, 0, 1, 1, 2, 2, 5))
    ]
    rows += [
        fixture_row(1, '1000.00', f'{1000 + percent * 10}.00', '1000.00')
        for percent in (0, 1, 7, 8, 11)
    ]
    rows.append(fixture_row(3, '1000.00', '1500.00', '1000.00'))
    rows.append(fixture_row(3, '1000.00', '900.00', '1000.00', single=False))
    rows.append(fixture_row(1, '1000.00', '1100.00', '0.00'))
    rows.append(dict(signed_at='2026-10-02T00:00:00+00:00', low='5.00', high='6.00'))
    return rows


def uncertainty_book(**assist_map):
    table = price_table.starter_table()
    table['policy']['assist'] = {**table['policy']['assist'], **assist_map}
    return dict(table, calculation_version=price_table.CALCULATION_VERSION)


def test_p80_is_nearest_rank():
    assert p80([1, 2, 3, 4, 5]) == 4
    assert p80([1, 2, 3, 4, 5, 6]) == 5
    assert p80([10]) == 10
    assert p80([5, 1, 3, 2, 4, 9, 8, 7, 6, 10]) == 8


def test_accuracy_counts_percentiles_and_suggestions_on_a_fixture_history():
    result = statistics(closed_jobs(), uncertainty_book())
    assert result['signed'] == 16
    assert result['closed'] == 15
    assert (result['inside'], result['below'], result['above']) == (13, 1, 1)
    assert result['inside_percent'] == 87
    assert result['counts'] == {'1': 6, '2': 7, '3': 1}
    assert result['method'] == 'uncertainty'
    assert result['reason'] is None
    hidden = result['suggestions']['hidden_damage_percent']
    assert hidden['2'] == dict(value='20', jobs=7)
    # Six category 1 jobs, one with no labor and materials to divide by: five qualify.
    assert hidden['1'] == dict(value='10', jobs=5)
    assert hidden['3'] == dict(value=None, jobs=1)
    assert result['suggestions']['extra_drying_days'] == dict(value=2, jobs=7)
    assert 'first_percent' not in result['suggestions']
    assert result['headline'] == '13 of 15 closed jobs landed inside the range · 1 above · 1 below'
    assert (
        result['sentences'][0]
        == 'In 13 of 15 closed jobs the final invoice landed inside the range.'
    )
    assert (
        'Category 2 rooms: a 20% allowance would have covered 4 of 5 of your 7 single-category jobs.'
        in result['sentences']
    )
    assert (
        'Category 3 rooms: 1 single-category job so far. A suggestion needs at least 5.'
        in result['sentences']
    )
    assert (
        'Drying days: 2 extra days would have covered 4 of 5 of your 7 closed jobs with actual days.'
        in result['sentences']
    )
    assert outcomes.COVERAGE_NOTE in result['sentences']


def test_a_suggestion_needs_five_jobs_and_says_how_many_it_has():
    rows = [fixture_row(2, '1000.00', '1100.00', '1000.00', actual=4) for _ in range(4)]
    four = statistics(rows, uncertainty_book())['suggestions']
    assert four['hidden_damage_percent']['2'] == dict(value=None, jobs=4)
    assert four['extra_drying_days'] == dict(value=None, jobs=4)
    rows.append(fixture_row(2, '1000.00', '1100.00', '1000.00', actual=4))
    five = statistics(rows, uncertainty_book())['suggestions']
    assert five['hidden_damage_percent']['2'] == dict(value='10', jobs=5)
    assert five['extra_drying_days'] == dict(value=1, jobs=5)


def test_percents_round_up_to_the_next_5_and_cap_at_100_and_days_cap_at_30():
    rows = [fixture_row(1, '1000.00', '1101.00', '1000.00', actual=3 + 40) for _ in range(5)]
    five = statistics(rows, uncertainty_book())['suggestions']
    assert five['hidden_damage_percent']['1']['value'] == '15'
    assert five['extra_drying_days']['value'] == 30
    rows = [fixture_row(1, '1000.00', '9000.00', '1000.00') for _ in range(5)]
    capped = statistics(rows, uncertainty_book())['suggestions']
    assert capped['hidden_damage_percent']['1']['value'] == '100'
    rows = [fixture_row(1, '1000.00', '1000.00', '1000.00') for _ in range(5)]
    zero = statistics(rows, uncertainty_book())['suggestions']
    assert zero['hidden_damage_percent']['1']['value'] == '0'


def test_the_cushion_method_suggests_the_first_percent_over_all_closed_jobs():
    book = uncertainty_book(range_method='cushion')
    result = statistics(closed_jobs(), book)
    assert result['method'] == 'cushion'
    assert set(result['suggestions']) == {'first_percent'}
    # 14 closed jobs have labor and materials. Overruns in percent, sorted:
    # 0 0 0 1 5 7 8 10 11 12 18 20 40 50; element ceil(11.2) - 1 = 11 is 20.
    assert result['suggestions']['first_percent'] == dict(value='20', jobs=14)
    assert (
        'Range cushion: 20% on labor and materials would have covered 4 of 5 of your 14 closed jobs.'
        in result['sentences']
    )


def cushion_book(beyond='20'):
    book = uncertainty_book(range_method='cushion')
    book['policy']['range']['beyond_percent'] = beyond
    return book


def cushion_rows(overruns):
    return [
        fixture_row(1, '1000.00', f'{1000 + percent * 10}.00', '1000.00') for percent in overruns
    ]


@pytest.mark.parametrize(
    'overruns', [(0, 3, 6, 9, 11, 12), (0, 0, 0, 0, 0), (12, 12, 12, 12, 12), tuple(range(13))]
)
@pytest.mark.parametrize('beyond', ['20', '22.5', '100'])
def test_a_cushion_suggestion_for_overruns_of_0_to_12_percent_can_always_be_published(
    overruns, beyond
):
    book = cushion_book(beyond)
    result = statistics(cushion_rows(overruns), book)
    assert result['suggestions']['first_percent'] == dict(value=beyond, jobs=len(overruns))
    assert (
        f'The suggestion is {beyond}%, because this cushion cannot be less than your '
        f'{beyond}% cushion beyond the first square feet.' in result['sentences']
    )
    policy = deepcopy(book['policy'])
    policy['range']['first_percent'] = result['suggestions']['first_percent']['value']
    assert price_table.normalize_policy(policy)['range']['first_percent'] == beyond


def test_a_floored_cushion_still_says_what_would_have_covered_the_jobs():
    result = statistics(cushion_rows((0, 3, 6, 9, 11, 12)), cushion_book())
    assert (
        'Range cushion: 15% on labor and materials would have covered 4 of 5 of your 6 closed jobs.'
        in result['sentences']
    )


def test_a_cushion_suggestion_at_or_above_the_cushion_beyond_is_not_floored():
    rows = cushion_rows((0, 3, 6, 9, 11, 12))
    for beyond in ('10', '15'):
        result = statistics(rows, cushion_book(beyond))
        assert result['suggestions']['first_percent'] == dict(value='15', jobs=6)
        assert not any('cannot be less than' in sentence for sentence in result['sentences'])


def test_a_cushion_with_too_few_jobs_stays_null_whatever_the_cushion_beyond():
    result = statistics(cushion_rows((0, 3, 6, 9)), cushion_book())
    assert result['suggestions']['first_percent'] == dict(value=None, jobs=4)
    assert not any('cannot be less than' in sentence for sentence in result['sentences'])


def test_a_single_price_company_gets_no_range_suggestions():
    table = uncertainty_book()
    table['policy']['estimate_mode'] = 'single'
    rows = [dict(fixture_row(1, '1000.00', '900.00', '1000.00'), high=None) for _ in range(5)]
    for row in rows:
        row['landed'] = landed(row['final'], row)
    result = statistics(rows, table)
    assert result['suggestions'] is None
    assert result['reason'] == 'single_price'
    assert result['headline'] == '5 of 5 closed jobs landed at or under the price · 0 above'
    assert outcomes.REASONS['single_price'] in result['sentences']


def test_no_closed_jobs_says_how_to_start():
    result = statistics([dict(signed_at='2026-10-02')], uncertainty_book())
    assert result['closed'] == 0 and result['inside_percent'] is None
    assert result['suggestions'] is None
    assert result['headline'] == 'Close a signed job to start tracking.'


def test_accuracy_for_a_rate_book_company_has_statistics_and_no_suggestions(api, enabled, assist):
    client, current, store = api
    signed_job(client, current, store)
    assert close(client, current).status_code == 200
    current['uid'] = 'owner'
    answer = client.get('/api/companies/adr/estimate-accuracy')
    assert answer.status_code == 200, answer.text
    assert answer.headers['Cache-Control'] == 'private, no-store'
    result = answer.json()
    assert result['closed'] == 1
    assert result['suggestions'] is None
    assert result['reason'] == 'rate_book'
    assert 'Suggestions apply to your own price table.' in result['sentences']
    assert result['days']['jobs'] == 1


def test_accuracy_is_owner_only_and_isolated(api, enabled, assist):
    client, current, store = api
    signed_job(client, current, store)
    for uid, status in (
        ('owner', 200),
        ('estimator', 403),
        ('office', 403),
        ('admin', 403),
        ('other-owner', 404),
    ):
        current['uid'] = uid
        assert client.get('/api/companies/adr/estimate-accuracy').status_code == status, uid


def test_one_companys_rows_never_reach_another_company(api, enabled, assist):
    client, current, store = api
    signed_job(client, current, store)
    assert close(client, current).status_code == 200
    current['uid'] = 'other-owner'
    result = client.get('/api/companies/other/estimate-accuracy').json()
    assert result['signed'] == 0 and result['closed'] == 0
    assert '_estimate_history/other' not in store.db.records


def test_accuracy_uses_the_quota_the_owner_already_has(api, enabled, assist):
    client, current, store = api
    current['uid'] = 'owner'
    assert client.get('/api/companies/adr/estimate-accuracy').status_code == 200
    assert 'price_calculate' in str(store.db.records['_limits/owner'])


def test_accuracy_reads_the_published_table_and_changes_nothing(api, enabled, assist):
    client, current, store = api
    signed_v2(client, current, store, [dict(name='Kitchen', category=2, finished_sf=100)])
    rows = store.db.records[HISTORY]['rows']
    for index in range(5):
        rows[f'ADR-INS-{index:032d}'] = fixture_row(2, '1000.00', '1200.00', '1000.00')
    current['uid'] = 'owner'
    book = deepcopy(store.db.records['_company_price_books/adr'])
    result = client.get('/api/companies/adr/estimate-accuracy').json()
    assert result['method'] == 'uncertainty'
    assert result['suggestions']['hidden_damage_percent']['2'] == dict(value='20', jobs=5)
    # Nothing is applied until the owner publishes: reading changes no table.
    assert store.db.records['_company_price_books/adr'] == book


def test_the_close_and_the_history_never_reach_documents_links_or_the_model(api, assist):
    client, current, store = api
    signed_job(client, current, store)
    agreement = deepcopy(store.db.records['authorizations/' + SIGNED])
    job = deepcopy(store.db.records['_workspace_jobs/' + ID])
    link = link_documents(agreement['documents'])
    prompt = audit_prompt(agreement['inspection'], agreement['photos'], [])
    pack = insights.fact_pack(job, agreement, {}, None, None)
    assert close(client, current, note='Private synthetic close note').status_code == 200
    after = store.db.records['authorizations/' + SIGNED]
    assert after == agreement
    assert store.db.records['_workspace_jobs/' + ID] == job
    assert link_documents(after['documents']) == link
    assert audit_prompt(after['inspection'], after['photos'], []) == prompt
    assert insights.fact_pack(job, after, {}, None, None) == pack
    assert 'Private synthetic close note' not in str(pack)


def test_the_close_never_logs_an_amount_or_a_note(api, assist, caplog, capsys):
    client, current, store = api
    signed_job(client, current, store)
    caplog.clear()
    capsys.readouterr()
    assert (
        close(client, current, final='987654.32', note='Private synthetic note').status_code == 200
    )
    captured = capsys.readouterr()
    for text in (caplog.text, captured.out, captured.err):
        assert '987654.32' not in text
        assert 'Private synthetic note' not in text


def test_history_row_takes_the_low_from_the_signed_body_not_a_repricing():
    body = dict(
        auth_id='ADR-AUTH-x',
        created_at='2026-10-01T00:00:00+00:00',
        proposed_cost=3495.5,
        proposed_cost_low=2950,
        documents=dict(
            xactimate_scope=[dict(code='ADR-DEMO', total=1570.0), dict(code='X', total=9)]
        ),
    )
    inspection = dict(rooms=[dict(category=2, finished_sf=500)], drying_days=3)
    row = history_row_at_signing(dict(job_id='j'), body, inspection, None)
    assert row['low'] == '2950.00' and row['high'] == '3495.50'
    assert row['labor_material_low'] == '1570.00'
    assert row['sf'] == '500.00' and row['planned_days'] == 3


def test_the_index_override_keeps_the_rows_map_out_of_the_single_field_indexes():
    import json
    from pathlib import Path

    indexes = json.loads((Path(__file__).parents[1] / 'firestore.indexes.json').read_text())
    assert {'collectionGroup': '_estimate_history', 'fieldPath': 'rows', 'indexes': []} in indexes[
        'fieldOverrides'
    ]
