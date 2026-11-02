"""Changing what the documents print clears them and moves the revision, so a second phone
holding the old documents gets a conflict instead of signing stale ones."""

import pytest

from tests.fakes import png
from tests.test_workspaces import ID, api, data, store  # noqa: F401  (fixtures)

JOB = '/api/jobs/' + ID


def audited(client, current):
    current['uid'] = 'estimator'
    assert (
        client.post('/api/inspections', json={'inspection_id': ID, 'data': data()}).status_code
        == 200
    )
    response = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
    assert response.status_code == 200
    assert response.json()['audit'] is not None
    return response.json()


def version(client, kind='coordination'):
    key = 'claim_version' if kind == 'claim' else 'version'
    return client.get(f'{JOB}/{kind}').json()[key]


def change_claim(client, current):
    current['uid'] = 'office'
    return client.put(
        JOB + '/claim',
        json={'expected_version': version(client, 'claim'), 'claim': {'claim_number': 'CLM-9'}},
    )


def change_customer(client, current):
    return client.put(
        JOB + '/customer',
        json={
            'expected_version': version(client),
            'customer_name': 'Pat Smith',
            'customer_phone': '',
        },
    )


def change_coordination(client, current):
    current['uid'] = 'office'
    return client.put(
        JOB + '/coordination',
        json={'expected_version': version(client), 'customer_name': 'Pat Smith'},
    )


@pytest.mark.parametrize(
    'change', [change_claim, change_customer, change_coordination], ids=lambda f: f.__name__
)
def test_a_change_to_the_documents_clears_them_and_moves_the_revision(api, change):
    client, current, store = api
    audited(client, current)
    assert change(client, current).status_code == 200
    current['uid'] = 'estimator'
    record = client.get('/api/inspections/' + ID).json()
    assert record['audit'] is None and record['status'] == 'draft' and record['revision'] == 2
    assert store.db.records['_workspace_jobs/' + ID]['status'] == 'draft'


@pytest.mark.parametrize(
    'change', [change_claim, change_customer, change_coordination], ids=lambda f: f.__name__
)
def test_a_second_phone_on_the_old_revision_gets_a_conflict(api, change):
    client, current, store = api
    audited(client, current)
    assert change(client, current).status_code == 200
    current['uid'] = 'estimator'
    stale_audit = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
    assert stale_audit.status_code == 409
    stale_save = client.put('/api/inspections/' + ID, json={'expected_revision': 1, 'data': data()})
    assert stale_save.status_code == 409
    stale_sign = client.post(
        '/api/authorize',
        json=dict(
            inspection_id=ID,
            expected_revision=1,
            auth_id='ADR-AUTH-stale1234567',
            proposal_hash='0' * 64,
            signature_png=png(),
            documents_confirmed=True,
        ),
    )
    assert stale_sign.status_code == 409
    # The current revision regenerates the documents.
    assert (
        client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 2}).status_code
        == 200
    )


@pytest.mark.parametrize(
    'change', [change_claim, change_customer, change_coordination], ids=lambda f: f.__name__
)
def test_a_change_with_no_documents_yet_leaves_the_revision_alone(api, change):
    client, current, store = api
    current['uid'] = 'estimator'
    assert (
        client.post('/api/inspections', json={'inspection_id': ID, 'data': data()}).status_code
        == 200
    )
    assert change(client, current).status_code == 200
    assert store.db.records['inspections/' + ID]['revision'] == 1


def test_an_address_and_customer_change_together_move_the_revision_once(api):
    client, current, store = api
    audited(client, current)
    current['uid'] = 'office'
    response = client.put(
        JOB + '/coordination',
        json={
            'expected_version': version(client),
            'customer_name': 'Pat Smith',
            'address': '12 Other Street, Bakersfield, CA',
        },
    )
    assert response.status_code == 200, response.text
    record = store.db.records['inspections/' + ID]
    assert record['revision'] == 2 and record['audit'] is None
    assert record['data']['address'] == '12 Other Street, Bakersfield, CA'
