"""Draft archiving, company archiving, estimator customer details and role checks over the API."""

import pytest

from tests.fakes import png
from tests.test_workspaces import ID, OTHER, api, data, store  # noqa: F401  (fixtures)


def events(store, action):
    return [
        r
        for k, r in store.db.records.items()
        if k.startswith('_admin_events/') and r['action'] == action
    ]


def version(client):
    return client.get('/api/jobs/' + ID + '/coordination').json()['version']


def sign(client):
    record = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1}).json()
    payload = dict(
        inspection_id=ID,
        expected_revision=1,
        auth_id='ADR-AUTH-archive123456',
        proposal_hash=record['audit']['proposal_hash'],
        signature_png=png(),
        documents_confirmed=True,
    )
    assert client.post('/api/authorize', json=payload).status_code == 200


def test_estimator_records_and_corrects_the_customer_on_their_job(api):
    client, current, store = api
    current['uid'] = 'estimator'
    assert (
        client.post('/api/inspections', json={'inspection_id': ID, 'data': data()}).status_code
        == 200
    )
    first = client.put(
        '/api/jobs/' + ID + '/customer',
        json={
            'expected_version': version(client),
            'customer_name': 'Pat Doe ',
            'customer_phone': '555-0101',
        },
    )
    assert first.status_code == 200, first.text
    assert (first.json()['customer_name'], first.json()['customer_phone']) == (
        'Pat Doe',
        '555-0101',
    )
    # A stale version is refused rather than overwriting someone else's change.
    stale = client.put(
        '/api/jobs/' + ID + '/customer',
        json={'expected_version': 1, 'customer_name': 'Wrong', 'customer_phone': ''},
    )
    assert stale.status_code == 409
    # Generated documents name the customer, so a corrected name clears them.
    assert (
        client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1}).status_code
        == 200
    )
    assert store.get_inspection('estimator', ID)['audit'] is not None
    fixed = client.put(
        '/api/jobs/' + ID + '/customer',
        json={
            'expected_version': version(client),
            'customer_name': 'Pat Smith',
            'customer_phone': '555-0101',
        },
    )
    assert fixed.status_code == 200
    assert store.get_inspection('estimator', ID)['audit'] is None
    listed = client.get('/api/inspections').json()['inspections']
    assert [row['customer_name'] for row in listed] == ['Pat Smith']
    current['uid'] = 'office'
    assert client.get('/api/jobs/' + ID + '/coordination').json()['customer_phone'] == '555-0101'
    assert len(events(store, 'job_customer')) == 2


@pytest.mark.parametrize(
    'uid,codes',
    [('office', {403}), ('estimator2', {404}), ('other-owner', {403, 404}), ('admin', {403, 404})],
)
def test_customer_details_need_scope_access_to_the_job(api, uid, codes):
    client, current, store = api
    store.create_inspection('estimator', ID, data())
    current['uid'] = uid
    response = client.put(
        '/api/jobs/' + ID + '/customer',
        json={'expected_version': 1, 'customer_name': 'Intruder', 'customer_phone': ''},
    )
    assert response.status_code in codes
    assert store.db.records['_workspace_jobs/' + ID]['customer_name'] == ''


def test_signed_job_keeps_its_customer(api):
    client, current, store = api
    current['uid'] = 'estimator'
    client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    sign(client)
    response = client.put(
        '/api/jobs/' + ID + '/customer',
        json={
            'expected_version': version(client),
            'customer_name': 'Changed',
            'customer_phone': '',
        },
    )
    assert response.status_code == 409


def test_owner_archives_a_draft_and_it_disappears_for_everyone(api):
    client, current, store = api
    store.create_inspection('estimator', ID, data())
    store.create_inspection('owner', OTHER, data('Kept job'))
    current['uid'] = 'owner'
    response = client.post(
        '/api/jobs/' + ID + '/archive', json={'expected_version': version(client)}
    )
    assert response.status_code == 200, response.text
    # The source record stays for the record; the job leaves the lists and stops opening.
    assert 'inspections/' + ID in store.db.records
    assert store.db.records['_workspace_jobs/' + ID]['archived_by_uid'] == 'owner'
    assert len(events(store, 'job_archived')) == 1
    for uid in ('owner', 'office', 'estimator'):
        current['uid'] = uid
        listed = [
            row['inspection_id'] for row in client.get('/api/inspections').json()['inspections']
        ]
        assert ID not in listed
        assert client.get('/api/inspections/' + ID).status_code == 410
    current['uid'] = 'owner'
    assert OTHER in [
        row['inspection_id'] for row in client.get('/api/inspections').json()['inspections']
    ]
    current['uid'] = 'estimator'
    assert (
        client.put(
            '/api/inspections/' + ID, json={'expected_revision': 1, 'data': data()}
        ).status_code
        == 410
    )
    # A phone still holding the draft cannot bring it back by recreating it.
    assert (
        client.post('/api/inspections', json={'inspection_id': ID, 'data': data()}).status_code
        == 410
    )
    current['uid'] = 'admin'
    support = client.get('/api/admin/companies/adr/jobs').json()['inspections']
    assert ID not in [row['inspection_id'] for row in support]


@pytest.mark.parametrize(
    'uid,codes',
    [('estimator', {403}), ('office', {403}), ('other-owner', {403, 404}), ('admin', {403, 404})],
)
def test_only_the_company_owner_can_archive(api, uid, codes):
    client, current, store = api
    store.create_inspection('estimator', ID, data())
    current['uid'] = uid
    response = client.post('/api/jobs/' + ID + '/archive', json={'expected_version': 1})
    assert response.status_code in codes
    assert not store.db.records['_workspace_jobs/' + ID].get('archived_at')


def test_signed_jobs_cannot_be_archived(api):
    client, current, store = api
    current['uid'] = 'estimator'
    client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    sign(client)
    current['uid'] = 'owner'
    response = client.post(
        '/api/jobs/' + ID + '/archive', json={'expected_version': version(client)}
    )
    assert response.status_code == 409
    assert not store.db.records['_workspace_jobs/' + ID].get('archived_at')


def test_superadmin_archives_and_restores_a_company(api):
    client, current, store = api
    current['uid'] = 'admin'
    company = client.get('/api/companies/other').json()
    early = client.put(
        '/api/admin/companies/other/status',
        json={'expected_version': company['version'], 'status': 'archived'},
    )
    assert early.status_code == 409
    suspended = client.put(
        '/api/admin/companies/other/status',
        json={'expected_version': company['version'], 'status': 'suspended'},
    )
    archived = client.put(
        '/api/admin/companies/other/status',
        json={'expected_version': suspended.json()['version'], 'status': 'archived'},
    )
    assert archived.status_code == 200, archived.text
    current['uid'] = 'other-owner'
    assert client.get('/api/companies/other').status_code == 403
    current['uid'] = 'admin'
    restored = client.put(
        '/api/admin/companies/other/status',
        json={'expected_version': archived.json()['version'], 'status': 'suspended'},
    )
    assert restored.status_code == 200
    # Company status stays a superadmin action.
    current['uid'] = 'other-owner'
    assert (
        client.put(
            '/api/admin/companies/other/status',
            json={'expected_version': restored.json()['version'], 'status': 'active'},
        ).status_code
        == 403
    )


@pytest.mark.parametrize('uid', ['estimator', 'office'])
def test_staff_tokens_cannot_call_owner_or_superadmin_endpoints(api, uid):
    client, current, store = api
    current['uid'] = uid
    company = store.db.records['_companies/adr']
    calls = [
        (
            'put',
            '/api/companies/adr',
            {'expected_version': company['version'], 'profile': company['profile']},
        ),
        (
            'put',
            '/api/companies/adr/team/estimator2',
            {'expected_version': 1, 'role': 'office', 'status': 'disabled'},
        ),
        (
            'post',
            '/api/companies/adr/invitations',
            {'email': 'new@example.invalid', 'role': 'estimator'},
        ),
        ('post', '/api/companies/adr/invitations/clear', None),
        ('get', '/api/admin/companies', None),
        ('post', '/api/admin/companies', {'name': 'Rogue', 'owner_email': 'rogue@example.invalid'}),
        (
            'put',
            '/api/admin/companies/adr/status',
            {'expected_version': company['version'], 'status': 'suspended'},
        ),
        ('get', '/api/admin/companies/adr/jobs', None),
    ]
    for method, path, body in calls:
        response = getattr(client, method)(path, **({'json': body} if body is not None else {}))
        assert response.status_code == 403, (method, path, response.status_code)
    assert store.db.records['_memberships/estimator2']['status'] == 'active'
    assert store.db.records['_companies/adr']['status'] == 'active'


def test_other_company_owner_cannot_reach_this_company(api):
    client, current, store = api
    store.create_inspection('estimator', ID, data())
    current['uid'] = 'other-owner'
    assert client.get('/api/companies/adr').status_code == 403
    assert client.get('/api/companies/adr/team').status_code == 403
    assert client.get('/api/inspections/' + ID).status_code == 404
    assert client.get('/api/jobs/' + ID + '/coordination').status_code == 404
    assert ID not in [
        row['inspection_id'] for row in client.get('/api/inspections').json()['inspections']
    ]
