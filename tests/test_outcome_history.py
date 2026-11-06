"""Outcome history recovery and malformed-record tests."""

import json
from copy import deepcopy
from decimal import Decimal

import pytest
from google.api_core.exceptions import Aborted, ServiceUnavailable

from backend import outcomes, signing_links
from backend.contracts import InspectionData
from backend.estimate_warnings import _typical_warning
from backend.outcomes import ROW_LIMIT, history_row_at_signing, statistics
from tests.fakes import png
from tests.test_backend import sign_payload
from tests.test_outcomes import HISTORY, assist, close, row_of  # noqa: F401
from tests.test_price_books import enabled  # noqa: F401
from tests.test_workspaces import ID, SIGNED, api, data, signed_job, store  # noqa: F401


# A history failure never stops a signature, and closing the job rebuilds the missing row.

PRIVATE_FAILURE = 'synthetic failure naming 1234 Private Street and $98,765.43'


def audited_job(client, current):
    current['uid'] = 'estimator'
    created = client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    assert created.status_code == 200, created.text
    record = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
    assert record.status_code == 200, record.text
    return record.json()


def assert_fully_signed(store, payload):
    """Every record of the signature committed: the failure rolled nothing back."""
    auth_id = payload['auth_id']
    agreement = store.db.records['authorizations/' + auth_id]
    assert agreement['status'] == 'saved'
    assert agreement['proposal_hash'] == payload['proposal_hash']
    assert store.db.records['inspections/' + ID]['status'] == 'signed'
    job = store.db.records['_workspace_jobs/' + ID]
    assert (job['auth_exists'], job['auth_id'], job['status']) == (True, auth_id, 'signed')
    assert job['signed_at'] == agreement['created_at']
    assert store.db.records['_workspace_authorizations/' + auth_id]['job_id'] == ID
    assert store.db.records['_job_deliveries/' + ID]['job_id'] == ID
    return agreement


def assert_close_rebuilds_the_row(client, current, store, agreement):
    answer = close(client, current)
    assert answer.status_code == 200, answer.text
    assert answer.json()['closed'] is True
    row = row_of(store)
    assert row['auth_id'] == agreement['auth_id']
    assert row['signed_at'] == agreement['created_at']
    assert row['low'] == f'{Decimal(str(agreement["proposed_cost_low"])):.2f}'
    assert row['high'] == f'{Decimal(str(agreement["proposed_cost"])):.2f}'
    assert Decimal(row['labor_material_low']) > 0
    assert row['final'] == '3310.00' and row['landed']


def builder_raises(error):
    def broken(*args):
        raise error

    return lambda monkeypatch, store: monkeypatch.setattr(
        outcomes, 'history_row_at_signing', broken
    )


def history_read_raises(error):
    def broken(*args):
        raise error

    return lambda monkeypatch, store: monkeypatch.setattr(store.outcomes, '_rows', broken)


@pytest.mark.parametrize(
    'failure',
    [
        builder_raises(RuntimeError(PRIVATE_FAILURE)),
        builder_raises(KeyError(PRIVATE_FAILURE)),
        builder_raises(ValueError(outcomes.NO_AMOUNTS)),
        history_read_raises(ServiceUnavailable(PRIVATE_FAILURE)),
        history_read_raises(ValueError(PRIVATE_FAILURE)),
    ],
    ids=['bug', 'missing_key', 'no_amounts', 'read_unavailable', 'unreadable'],
)
def test_a_history_failure_at_signing_keeps_the_signature_and_close_rebuilds_the_row(
    api, assist, monkeypatch, failure
):
    client, current, store = api
    payload = sign_payload(audited_job(client, current))
    with monkeypatch.context() as patch:
        failure(patch, store)
        answer = client.post('/api/authorize', json=payload)
    assert answer.status_code == 200, answer.text
    agreement = assert_fully_signed(store, payload)
    assert HISTORY not in store.db.records
    assert_close_rebuilds_the_row(client, current, store, agreement)


def test_a_history_failure_keeps_a_link_signature_and_consumes_the_link(api, monkeypatch):
    client, current, store = api
    record = audited_job(client, current)
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
    with monkeypatch.context() as patch:
        builder_raises(RuntimeError(PRIVATE_FAILURE))(patch, store)
        receipt = signing_links.sign(store, token, signer, dict(ip_address='', user_agent=''))
    assert store.db.records['authorizations/' + receipt['auth_id']]['status'] == 'saved'
    assert HISTORY not in store.db.records
    # The link is spent: the same signer gets the same receipt and no second agreement.
    again = signing_links.sign(store, token, signer, dict(ip_address='', user_agent=''))
    assert again['auth_id'] == receipt['auth_id']


def test_a_history_failure_logs_only_the_allowlisted_event(api, monkeypatch, caplog, capsys):
    client, current, store = api
    payload = sign_payload(audited_job(client, current))
    caplog.clear()
    capsys.readouterr()
    with monkeypatch.context() as patch:
        builder_raises(RuntimeError(PRIVATE_FAILURE))(patch, store)
        assert client.post('/api/authorize', json=payload).status_code == 200
    out = capsys.readouterr().out
    lines = [line for line in out.splitlines() if '"estimate_history"' in line]
    assert len(lines) == 1
    entry = json.loads(lines[0])
    assert entry['severity'] == 'WARNING'
    assert (entry['operation'], entry['outcome']) == ('estimate_history', 'RuntimeError')
    agreement = store.db.records['authorizations/' + payload['auth_id']]
    secrets = (
        'Private Street',
        '98,765',
        agreement['address'],
        f'{Decimal(str(agreement["proposed_cost"])):.2f}',
        str(agreement['proposed_cost']),
    )
    for text in (out, caplog.text):
        for secret in secrets:
            assert secret not in text


def test_firestore_contention_on_the_history_read_still_belongs_to_the_transaction(
    api, monkeypatch
):
    client, current, store = api
    payload = sign_payload(audited_job(client, current))
    with monkeypatch.context() as patch:
        history_read_raises(Aborted('synthetic contention'))(patch, store)
        answer = client.post('/api/authorize', json=payload)
    assert answer.status_code == 503
    assert 'authorizations/' + payload['auth_id'] not in store.db.records
    assert store.db.records['inspections/' + ID]['status'] != 'signed'
    # The signer's retry goes through once the contention clears.
    assert client.post('/api/authorize', json=payload).status_code == 200
    assert row_of(store)['auth_id'] == payload['auth_id']


def test_contention_on_the_pin_read_is_raised_through_record_signing(api):
    _, _, store = api
    job = dict(job_id=ID, company_id='adr')

    class Contended:
        def __getattr__(self, name):
            raise Aborted('synthetic contention')

    store.outcomes.ws.prices = Contended()
    with pytest.raises(Aborted):
        store.outcomes.record_signing(job, {}, object())


def full_history_with_a_number_for_a_date():
    rows = {
        f'ADR-INS-{i:032d}': dict(signed_at='2026-01-01T00:00:00+00:00', auth_id='kept')
        for i in range(ROW_LIMIT)
    }
    rows['ADR-INS-' + '0' * 32]['signed_at'] = 1234
    return dict(company_id='adr', rows=rows)


VALID_OTHER_ROW = dict(signed_at='2026-02-02T00:00:00+00:00', auth_id='kept', low='10.00')
OTHER_JOB = 'ADR-INS-' + 'e' * 32


@pytest.mark.parametrize(
    'corrupt',
    [
        dict(rows='not a map'),
        dict(rows=['not', 'a', 'map']),
        dict(rows=7),
        dict(rows={OTHER_JOB: 'not a row'}),
        dict(rows={OTHER_JOB: None}),
        dict(rows={OTHER_JOB: ['not', 'a', 'row']}),
    ],
    ids=['text', 'list', 'number', 'text_row', 'null_row', 'list_row'],
)
def test_a_corrupt_history_document_never_stops_a_signature_or_a_close(api, assist, corrupt):
    client, current, store = api
    payload = sign_payload(audited_job(client, current))
    store.db.records[HISTORY] = dict(company_id='adr', **deepcopy(corrupt))
    answer = client.post('/api/authorize', json=payload)
    assert answer.status_code == 200, answer.text
    agreement = assert_fully_signed(store, payload)
    # Signing the corrupt document leaves a readable one with this job's row.
    assert row_of(store)['auth_id'] == payload['auth_id']

    # The same document arriving after the signature cannot block the close either.
    store.db.records[HISTORY] = dict(company_id='adr', **deepcopy(corrupt))
    current['uid'] = 'owner'
    assert client.get(f'/api/jobs/{ID}/outcome').status_code == 200
    assert_close_rebuilds_the_row(client, current, store, agreement)


def test_a_corrupt_row_does_not_lose_the_companys_good_rows(api, assist):
    client, current, store = api
    payload = sign_payload(audited_job(client, current))
    good = dict(VALID_OTHER_ROW)
    store.db.records[HISTORY] = dict(
        company_id='adr', rows={OTHER_JOB: good, 'ADR-INS-' + 'd' * 32: 'not a row'}
    )
    assert client.post('/api/authorize', json=payload).status_code == 200
    rows = store.db.records[HISTORY]['rows']
    assert set(rows) == {ID, OTHER_JOB}
    assert rows[OTHER_JOB] == good


def test_a_full_history_with_an_unreadable_date_still_trims_at_signing_and_at_close(api, assist):
    client, current, store = api
    payload = sign_payload(audited_job(client, current))
    store.db.records[HISTORY] = full_history_with_a_number_for_a_date()
    assert client.post('/api/authorize', json=payload).status_code == 200
    agreement = assert_fully_signed(store, payload)
    assert row_of(store)['auth_id'] == payload['auth_id']
    assert len(store.db.records[HISTORY]['rows']) == ROW_LIMIT

    store.db.records[HISTORY] = full_history_with_a_number_for_a_date()
    assert_close_rebuilds_the_row(client, current, store, agreement)
    assert len(store.db.records[HISTORY]['rows']) == ROW_LIMIT


@pytest.mark.parametrize(
    'broken',
    [
        'not a row',
        dict(signed_at='2026-01-01T00:00:00+00:00'),
        dict(low='not money', high=None, estimate_mode='range'),
        dict(low='NaN', high=None, estimate_mode='range'),
        dict(low='10.00', high='not money', estimate_mode='range'),
        dict(low='10.00', high=None, estimate_mode='unknown'),
        dict(low=None, high=None, estimate_mode='single'),
    ],
    ids=['text', 'no_low', 'bad_low', 'nan_low', 'bad_high', 'bad_mode', 'null_low'],
)
def test_this_jobs_unreadable_row_is_rebuilt_from_the_agreement(api, assist, broken):
    client, current, store = api
    signed_job(client, current, store)
    agreement = store.db.records['authorizations/' + SIGNED]
    store.db.records[HISTORY]['rows'][ID] = deepcopy(broken)
    current['uid'] = 'owner'
    outcome = client.get(f'/api/jobs/{ID}/outcome')
    assert outcome.status_code == 200, outcome.text
    assert outcome.json()['closed'] is False
    assert_close_rebuilds_the_row(client, current, store, agreement)
    assert client.get(f'/api/jobs/{ID}/outcome').json()['closed'] is True


def test_a_good_row_is_kept_at_close_rather_than_rebuilt(api, assist):
    client, current, store = api
    signed_job(client, current, store)
    store.db.records[HISTORY]['rows'][ID]['planned_days'] = 11
    assert close(client, current).status_code == 200
    assert row_of(store)['planned_days'] == 11


def test_a_real_no_amounts_agreement_signs_and_close_says_why_it_cannot_compare(api, assist):
    client, current, store = api
    record = audited_job(client, current)
    documents = store.db.records['inspections/' + ID]['audit']['documents']
    documents['adr_estimate']['proposed_cost'] = None
    documents['adr_estimate']['proposed_cost_low'] = None
    payload = sign_payload(record)
    assert client.post('/api/authorize', json=payload).status_code == 200
    assert_fully_signed(store, payload)
    assert HISTORY not in store.db.records
    answer = close(client, current)
    assert answer.status_code == 400
    assert answer.json()['detail'] == outcomes.NO_AMOUNTS
    assert HISTORY not in store.db.records


def test_a_malformed_v1_scope_item_keeps_the_row_and_stays_out_of_the_overrun(api, assist):
    client, current, store = api
    record = audited_job(client, current)
    scope = store.db.records['inspections/' + ID]['audit']['documents']['xactimate_scope']
    demolition = next(item for item in scope if item['code'] == 'ADR-DEMO')
    del demolition['total']
    payload = sign_payload(record)
    assert client.post('/api/authorize', json=payload).status_code == 200
    assert_fully_signed(store, payload)
    row = row_of(store)
    assert row['labor_material_low'] == '0.00'
    assert (row['sf'], row['category'], row['single_category']) == ('10.00', 1, True)


@pytest.mark.parametrize(
    'inspection',
    [
        dict(rooms=[dict(category=None), dict(category=2, finished_sf=10)], drying_days=3),
        dict(rooms=[dict(category=1, finished_sf='not a number')], drying_days=3),
        dict(rooms='not a list', drying_days=3),
    ],
    ids=['mixed_categories', 'bad_area', 'bad_rooms'],
)
def test_an_older_agreement_shape_closes_and_counts_only_in_the_hit_rate(
    api, enabled, assist, inspection
):
    client, current, store = api
    signed_job(client, current, store)
    del store.db.records[HISTORY]
    store.db.records['authorizations/' + SIGNED]['inspection'] = deepcopy(inspection)
    answer = close(client, current)
    assert answer.status_code == 200, answer.text
    row = row_of(store)
    assert row['landed'] and row['low'] and row['final'] == '3310.00'
    assert (row['single_category'], row['planned_days']) == (False, None)
    assert row['labor_material_low'] == '0.00'

    numbers = statistics([row])
    assert numbers['closed'] == 1
    assert numbers['days']['jobs'] == 0
    assert not any(numbers['counts'].values())


def test_a_row_with_no_details_is_never_compared_with_a_draft():
    data_model = InspectionData(
        address='Synthetic property',
        year_built=2000,
        rooms=[dict(name='Room', category=1, finished_sf=0)],
        scope_confirmed=True,
    )
    bare = history_row_at_signing(
        dict(job_id=ID),
        dict(proposed_cost=500, documents='not a map'),
        dict(rooms=[], drying_days=3),
        None,
    )
    assert bare['category'] is None
    assert _typical_warning(data_model, None, Decimal('500'), [bare] * 6) == []
