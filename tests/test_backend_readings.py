import pytest
from fastapi.testclient import TestClient
import backend.main as bm
from backend.contracts import InspectionData
from tests.fakes import FakeStore
from tests.test_backend import ID, as_user, audit, context, data, inspect, revocation, sign_payload


def test_signing_evidence_and_administration_routes_always_check_revocation_live(revocation):
    store = FakeStore()
    bm.app.dependency_overrides[bm.get_job_store] = lambda: store
    try:
        client = TestClient(bm.app, headers={'Authorization': 'Bearer owner.a'})
        for _ in range(2):
            assert client.get('/api/inspections/' + ID).status_code == 404
        assert revocation.calls == [True, False]
        for _ in range(2):
            assert client.post('/api/authorize', json={'auth_id': 'missing'}).status_code == 409
            assert client.get('/api/authorizations/missing/evidence/signature').status_code == 404
        assert revocation.calls == [True, False, True, True, True, True]
    finally:
        bm.app.dependency_overrides.clear()
    live = {
        (method, route.path)
        for route in bm.app.routes
        if getattr(route, 'dependant', None)
        for dependency in route.dependant.dependencies
        if bm.LIVE_REVOCATION[0] in (dependency.own_oauth_scopes or [])
        for method in route.methods
    }
    assert live == {
        ('POST', '/api/authorize'),
        ('POST', '/api/inspections/{inspection_id}/signing-links'),
        ('POST', '/api/inspections/{inspection_id}/extras/{extra_id}/approve'),
        ('POST', '/api/inspections/{inspection_id}/signing-links/revoke'),
        ('GET', '/api/authorizations/{auth_id}/evidence/{name}'),
        ('GET', '/api/admin/companies'),
        ('POST', '/api/admin/companies'),
        ('PUT', '/api/admin/companies/{company_id}/status'),
        ('POST', '/api/admin/companies/{company_id}/owner-login'),
        ('POST', '/api/account/password'),
        ('GET', '/api/admin/companies/{company_id}/jobs'),
        ('GET', '/api/admin/companies/{company_id}/jobs/{inspection_id}'),
        ('GET', '/api/admin/companies/{company_id}/jobs/{inspection_id}/photos/{photo_id}'),
        ('GET', '/api/admin/companies/{company_id}/authorizations'),
        ('GET', '/api/admin/companies/{company_id}/authorizations/{auth_id}'),
        ('GET', '/api/admin/companies/{company_id}/authorizations/{auth_id}/evidence/{name}'),
        ('GET', '/api/companies/{company_id}'),
        ('PUT', '/api/companies/{company_id}'),
        ('GET', '/api/companies/{company_id}/team'),
        ('GET', '/api/companies/{company_id}/team/{member_uid}/signing-links'),
        ('PUT', '/api/companies/{company_id}/team/{member_uid}'),
        ('GET', '/api/companies/{company_id}/invitations'),
        ('POST', '/api/companies/{company_id}/invitations'),
        ('POST', '/api/companies/{company_id}/invitations/clear'),
        ('GET', '/api/companies/{company_id}/retention'),
        ('PUT', '/api/companies/{company_id}/retention'),
        ('POST', '/api/companies/{company_id}/invitations/{invitation_id}/{action}'),
        ('POST', '/api/invitations/{invitation_id}/accept'),
        ('PUT', '/api/jobs/{inspection_id}/coordination'),
        ('GET', '/api/jobs/{inspection_id}/outcome'),
        ('POST', '/api/jobs/{inspection_id}/close'),
        ('GET', '/api/companies/{company_id}/estimate-accuracy'),
        ('PUT', '/api/jobs/{inspection_id}/claim'),
        ('PUT', '/api/jobs/{inspection_id}/customer'),
        ('POST', '/api/jobs/{inspection_id}/archive'),
        ('POST', '/api/jobs/{inspection_id}/restore'),
        ('GET', '/api/archived-jobs'),
        ('GET', '/api/admin/companies/{company_id}/archived-jobs'),
        ('POST', '/api/admin/companies/{company_id}/jobs/{inspection_id}/archive'),
        ('POST', '/api/admin/companies/{company_id}/jobs/{inspection_id}/restore'),
        ('POST', '/api/jobs/{inspection_id}/delivery/resend'),
        ('GET', '/api/jobs/{job_id}/insight'),
        ('GET', '/api/admin/companies/{company_id}/jobs/{job_id}/insight'),
        ('GET', '/api/companies/{company_id}/ai-usage'),
        ('GET', '/api/companies/{company_id}/ai-spending'),
        ('GET', '/api/admin/companies/{company_id}/ai-usage'),
        ('GET', '/api/companies/{company_id}/drying-watch'),
        ('GET', '/api/jobs/drying-watch'),
        ('GET', '/api/jobs/{inspection_id}/drying-watch'),
        ('GET', '/api/admin/companies/{company_id}/drying-watch'),
        ('POST', '/api/jobs/{inspection_id}/drying-watch/summary'),
        ('POST', '/api/jobs/{inspection_id}/drying-watch/state'),
        ('POST', '/api/jobs/{inspection_id}/drying-watch/remind'),
        ('GET', '/api/companies/{company_id}/prices'),
        ('PUT', '/api/companies/{company_id}/prices/working-copy'),
        ('DELETE', '/api/companies/{company_id}/prices/working-copy'),
        ('POST', '/api/companies/{company_id}/prices/working-copy/discard'),
        ('POST', '/api/companies/{company_id}/prices/start-v2'),
        ('POST', '/api/companies/{company_id}/prices/calculate'),
        ('GET', '/api/companies/{company_id}/prices/versions'),
        ('GET', '/api/companies/{company_id}/prices/versions/{version_id}'),
        ('GET', '/api/companies/{company_id}/prices/history'),
        ('GET', '/api/companies/{company_id}/prices/export'),
        ('POST', '/api/companies/{company_id}/prices/preview'),
        ('POST', '/api/companies/{company_id}/prices/import-preview'),
        ('POST', '/api/companies/{company_id}/prices/publish'),
        ('POST', '/api/companies/{company_id}/prices/versions/{version_id}/restore'),
        ('GET', '/api/admin/companies/{company_id}/prices'),
        ('GET', '/api/admin/companies/{company_id}/prices/versions'),
        ('GET', '/api/admin/companies/{company_id}/prices/versions/{version_id}'),
        ('GET', '/api/admin/companies/{company_id}/prices/history'),
        ('GET', '/api/admin/companies/{company_id}/prices/export'),
        ('GET', '/api/inspections/{inspection_id}/pricing'),
        ('POST', '/api/inspections/{inspection_id}/pricing/reprice-preview'),
        ('POST', '/api/inspections/{inspection_id}/pricing/reprice'),
    }


def reading(**changes):
    return {
        'reading': {
            'kind': 'air',
            'room': 'Bathroom',
            'zone': 'affected',
            'temperature_f': 74,
            'relative_humidity': 72,
            'taken_at': '2026-10-21T15:00:00Z',
            **changes,
        }
    }


def test_drying_readings_sit_beside_the_revision_and_outlive_signing(context):
    client, store = context
    record = audit(client, inspect(client))
    assert client.get('/api/inspections/' + ID + '/readings').json() == {
        'inspection_id': ID,
        'readings': [],
        'updated_at': None,
    }
    saved = client.post('/api/inspections/' + ID + '/readings', json=reading())
    assert saved.status_code == 200, saved.text
    [air] = saved.json()['readings']
    assert air['recorded_by'] == 'owner@example.invalid' and len(air['id']) == 32
    assert (air['gpp'], air['dew_point_f'], air['vapor_pressure_inhg']) == (91, 64, 0.609)
    assert air['taken_at'] == '2026-10-21T15:00:00Z' and air['recorded_at'] > '2026'
    # The reading changed nothing the proposal hash or signature binds to.
    current = client.get('/api/inspections/' + ID).json()
    assert current['revision'] == record['revision'] and current['audit'] == record['audit']
    assert client.post('/api/authorize', json=sign_payload(record)).status_code == 200
    # Monitoring visits continue after signing; material and thermal readings carry no computed values.
    material = reading(
        kind='material', material='Drywall', moisture=28, unit='%MC', dry_standard=12, zone=None
    )
    del material['reading']['zone'], material['reading']['temperature_f']
    del material['reading']['relative_humidity']
    thermal = reading(kind='thermal', delta_t_f=-6.4, boundary='Up 3 ft of exterior wall')
    for key in ('zone', 'temperature_f', 'relative_humidity'):
        del thermal['reading'][key]
    for body in (material, thermal):
        response = client.post('/api/inspections/' + ID + '/readings', json=body)
        assert response.status_code == 200, response.text
    log = client.get('/api/inspections/' + ID + '/readings').json()
    assert [r['kind'] for r in log['readings']] == ['air', 'material', 'thermal']
    assert 'gpp' not in log['readings'][1] and log['readings'][2]['pattern'] == 'cold_anomaly'
    assert client.get('/api/inspections/' + ID).json()['status'] == 'signed'
    removed = client.delete('/api/inspections/' + ID + '/readings/' + air['id'])
    assert removed.status_code == 200 and len(removed.json()['readings']) == 2
    assert client.delete('/api/inspections/' + ID + '/readings/' + air['id']).status_code == 404
    assert store.db.records['inspections/' + ID]['status'] == 'signed'


def test_drying_readings_reject_bad_values_and_other_users(context):
    client, _ = context
    inspect(client)
    bad = [
        reading(relative_humidity=0),
        reading(temperature_f=200),
        reading(kind='bogus'),
        reading(extra='field'),
        {'reading': {'kind': 'material', 'room': 'Bathroom', 'taken_at': '2026-10-21T15:00:00Z'}},
        {'reading': {'kind': 'thermal', 'delta_t_f': 500, 'taken_at': '2026-10-21T15:00:00Z'}},
        reading(taken_at='yesterday'),
    ]
    for body in bad:
        assert client.post('/api/inspections/' + ID + '/readings', json=body).status_code == 422
    assert client.delete('/api/inspections/' + ID + '/readings/not-hex').status_code == 422
    as_user('other')
    assert client.get('/api/inspections/' + ID + '/readings').status_code == 404
    assert client.post('/api/inspections/' + ID + '/readings', json=reading()).status_code == 404
    assert client.delete('/api/inspections/' + ID + '/readings/' + 'f' * 32).status_code == 404
    as_user('owner')
    assert client.get('/api/inspections/' + ID + '/readings').json()['readings'] == []
    missing = 'ADR-INS-' + 'e' * 32
    assert client.get('/api/inspections/' + missing + '/readings').status_code == 404
    assert client.get('/api/inspections/not-an-id/readings').status_code == 404


def test_draft_records_carry_the_sizing_check_and_its_inputs_stay_absent_until_set(context):
    client, _ = context
    values = data()
    values.pop('capture_metadata')
    values.pop('dehumidifier_ppd')
    for key in (
        'loss',
        'floor_sf',
        'wet_floor_sf',
        'ceiling_height_ft',
        'water_class',
        'source_of_loss',
        'contents_present',
        'equipment_placed',
        'affected_surfaces',
        'wet_materials',
    ):
        values['rooms'][0].pop(key, None)
    record = client.post('/api/inspections', json={'inspection_id': ID, 'data': values}).json()
    assert record['data'] == values
    sizing = record['equipment_sizing']
    assert sizing['status'] == 'not_available'
    assert sizing['rooms'][0]['missing'] == ['floor area', 'ceiling height', 'water class']
    values['rooms'][0].update(floor_sf=140, ceiling_height_ft=8.5, water_class=3)
    values['dehumidifier_ppd'] = 70
    record = client.put(
        '/api/inspections/' + ID, json={'expected_revision': 1, 'data': values}
    ).json()
    # The client's values come back unchanged (140.0 parses as 140 in the browser), so a reloaded
    # draft is not a revision conflict.
    assert record['data'] == values
    sizing = client.get('/api/inspections/' + ID).json()['equipment_sizing']
    assert sizing['status'] == 'available'
    assert sizing['air_movers'] == {
        'entered': 3,
        'min': 3,
        'max': 4,
        'flag': 'within',
        'reason': 'Within the IICRC range of 3 to 4.',
    }
    assert sizing['dehumidifiers']['recommended_ppd'] == 30
    assert sizing['dehumidifiers']['flag'] == 'within'
    # The check is derived on each read and never stored with the draft.
    assert 'equipment_sizing' not in context[1].get_inspection('owner', ID)
    values['rooms'][0]['water_class'] = None
    values['dehumidifier_ppd'] = None
    record = client.put(
        '/api/inspections/' + ID, json={'expected_revision': 2, 'data': values}
    ).json()
    assert 'water_class' not in record['data']['rooms'][0]
    assert 'dehumidifier_ppd' not in record['data']


def test_year_built_2027_is_accepted_when_the_clock_reads_2027(monkeypatch):
    import backend.contracts as contracts

    class Clock2027(contracts.datetime):
        @classmethod
        def now(cls, tz=None):
            return contracts.datetime(2027, 1, 2)

    monkeypatch.setattr(contracts, 'datetime', Clock2027)
    assert InspectionData(year_built=2027).year_built == 2027
    with pytest.raises(ValueError):
        InspectionData(year_built=2028)


@pytest.mark.parametrize(
    'value, expected',
    [
        (None, set()),
        ('', set()),
        (' , ', set()),
        (' Owner@Example.com, ,staff@example.com', {'owner@example.com', 'staff@example.com'}),
    ],
)
def test_staff_emails_fail_closed_unless_set(value, expected):
    import os, subprocess, sys

    env = {k: v for k, v in os.environ.items() if k != 'STAFF_EMAILS'}
    if value is not None:
        env['STAFF_EMAILS'] = value
    out = subprocess.run(
        [sys.executable, '-c', 'import backend.main as m; print(sorted(m.STAFF_EMAILS))'],
        env={**env, 'PYTHONPATH': os.pathsep.join(sys.path)},
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    assert out.strip() == str(sorted(expected))
