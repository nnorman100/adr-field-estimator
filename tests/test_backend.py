import asyncio, json, time
from types import SimpleNamespace
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
import backend.main as bm
from backend.contracts import InspectionData
from tests.fakes import FakeStore,png

ID='ADR-INS-'+'a'*32

def data(**changes):
    return InspectionData(address='Synthetic test property',year_built=1960,
        rooms=[{'name':'Bathroom','category':1,'finished_sf':10}],air_movers=3,dehumidifiers=1,
        scope_confirmed=True,technician_notes='Localized clean water damage. Proposed drying and drywall removal.',**changes).model_dump(mode='json')

@pytest.fixture
def context(monkeypatch):
    store=FakeStore()
    bm.app.dependency_overrides[bm.current_staff]=lambda:{'uid':'owner','email':'owner@example.invalid'}
    bm.app.dependency_overrides[bm.get_job_store]=lambda:store
    async def generate(**kwargs):
        schema=kwargs['config'].response_schema
        value={'summary':'The technician confirmed a localized bathroom scope.','suggestions':['Confirm drying progress.'],'unpriced_work':[]} if schema is bm.AIResult else {'meter_detected':False,'meter_type':'Inspection Photo','value':'','classification':'No readable meter','notes':'No physical display visible.'}
        return SimpleNamespace(text=json.dumps(value))
    monkeypatch.setattr(bm,'get_ai_client',lambda:SimpleNamespace(aio=SimpleNamespace(models=SimpleNamespace(generate_content=generate))))
    yield TestClient(bm.app),store
    bm.app.dependency_overrides.clear()

def inspect(client):
    r=client.post('/api/inspections',json={'inspection_id':ID,'data':data()});assert r.status_code==200,r.text
    return r.json()
def audit(client,record):
    r=client.post('/api/audit',json={'inspection_id':ID,'expected_revision':record['revision']});assert r.status_code==200,r.text
    return r.json()
def sign_payload(record):
    return dict(inspection_id=ID,expected_revision=record['revision'],auth_id='ADR-AUTH-test123456',proposal_hash=record['audit']['proposal_hash'],signature_png=png(),documents_confirmed=True)

def test_authenticated_durable_flow_and_immutable_retry(context):
    client,store=context
    record=audit(client,inspect(client));docs=record['audit']['documents']
    assert docs['xactimate_total']==1775
    assert docs['adr_estimate']['proposed_cost_low']==1775
    assert docs['adr_estimate']['proposed_cost']==1788.9
    assert docs['schema_version']==3
    assert docs['adr_estimate']['lead_notice_required'] and docs['signable']
    payload=sign_payload(record)
    saved=client.post('/api/authorize',json=payload);assert saved.status_code==200,saved.text
    assert client.post('/api/authorize',json=payload).json()==saved.json()
    loaded=client.get('/api/authorizations/'+payload['auth_id']).json()
    assert loaded['documents']==docs and 'owner_uid' not in loaded
    assert client.get('/api/authorizations/'+payload['auth_id']+'/evidence/signature').status_code==200
    assert client.put('/api/inspections/'+ID,json={'expected_revision':record['revision'],'data':data()}).status_code==409
    assert len(store.bucket.objects)==1

def test_stale_revision_changed_scope_and_forged_prices(context):
    client,_=context
    record=audit(client,inspect(client));payload=sign_payload(record)
    revised=data();revised['address']='Different address'
    assert client.put('/api/inspections/'+ID,json={'expected_revision':record['revision'],'data':revised}).status_code==200
    assert client.post('/api/authorize',json=payload).status_code==409
    payload['proposed_cost']=1
    assert client.post('/api/authorize',json=payload).status_code==422
    assert client.post('/api/authorize',json={'auth_id':'ADR-AUTH-never-saved','signature_png':png(),'proposed_cost':-1}).status_code==409

def test_old_package_selection_requires_app_update(context):
    client,_=context
    record=client.post('/api/inspections',json={'inspection_id':ID,'data':data(package_price='2049.99')}).json()
    response=client.post('/api/audit',json={'inspection_id':ID,'expected_revision':record['revision']})
    assert response.status_code==409
    assert 'Update the app' in response.json()['detail']

def test_model_output_missing_and_provider_error_never_produces_documents(context,monkeypatch):
    client,store=context;record=inspect(client)
    async def malformed(**kwargs):return SimpleNamespace(text='{"proposed_cost":-999}')
    monkeypatch.setattr(bm,'get_ai_client',lambda:SimpleNamespace(aio=SimpleNamespace(models=SimpleNamespace(generate_content=malformed))))
    response=client.post('/api/audit',json={'inspection_id':ID,'expected_revision':record['revision']})
    assert response.status_code==502 and store.get_inspection('owner',ID)['audit'] is None

def test_non_meter_and_failed_ocr_remain_unverified(context,monkeypatch):
    client,store=context;record=inspect(client)
    r=client.post('/api/inspections/'+ID+'/photos',json=dict(expected_revision=record['revision'],photo_id='b'*32,room='Bathroom',captured_at='2026-10-06T19:00:00Z',data_url=png()))
    assert r.status_code==200,r.text
    result=client.post('/api/inspections/'+ID+'/photos/'+'b'*32+'/ocr',json={})
    assert result.status_code==200 and result.json()['photos'][0]['ocr_status']=='no_meter'
    async def unavailable(**kwargs):raise RuntimeError('provider unavailable')
    monkeypatch.setattr(bm,'get_ai_client',lambda:SimpleNamespace(aio=SimpleNamespace(models=SimpleNamespace(generate_content=unavailable))))
    result=client.post('/api/inspections/'+ID+'/photos/'+'b'*32+'/ocr',json={})
    assert result.status_code==502 and store.get_inspection('owner',ID)['photos'][0]['ocr_status']=='failed'

def test_auth_ownership_limits_and_invalid_inputs(context):
    client,_=context;inspect(client)
    bm.app.dependency_overrides[bm.current_staff]=lambda:{'uid':'other'}
    assert client.get('/api/inspections/'+ID).status_code==404
    assert client.post('/api/inspections/'+ID+'/photos',json=dict(expected_revision=1,photo_id='b'*32,room='Room',captured_at='2026-10-06T19:00:00Z',data_url=png())).status_code==404
    bm.app.dependency_overrides.pop(bm.current_staff)
    for path in ['/api/inspections','/api/authorizations','/api/authorizations/ADR-AUTH-test123456']:
        assert client.get(path).status_code==401
    assert client.get('/api/health').status_code==200
    bm.app.dependency_overrides[bm.current_staff]=lambda:{'uid':'owner'}
    invalid=data();invalid['labor_hours']=-1
    assert client.put('/api/inspections/'+ID,json={'expected_revision':1,'data':invalid}).status_code==422
    # The transaction-backed per-user limit applies to API calls.
    for _ in range(3):client.post('/api/audit',json={'inspection_id':ID,'expected_revision':1})
    response=client.post('/api/audit',json={'inspection_id':ID,'expected_revision':1})
    assert response.status_code==429 and response.headers['Retry-After']

def test_live_rejects_origins_and_unauthorized_before_vertex(context,monkeypatch):
    client,_=context
    with pytest.raises(Exception):
        with client.websocket_connect('/api/live',headers={'origin':'https://attacker.invalid'}):pass
    async def reject(token):raise HTTPException(401,'Sign in again.')
    monkeypatch.setattr(bm,'verify_staff',reject)
    with client.websocket_connect('/api/live',headers={'origin':bm.ORIGINS[0]}) as socket:
        socket.send_json({'type':'authenticate','token':'invalid','inspection_id':ID})
        assert socket.receive_json()['type']=='error'

def test_staff_verification_checks_revoked_and_disabled_sessions(monkeypatch):
    monkeypatch.setattr(bm.firebase_admin,'get_app',lambda name:object())
    calls=[]
    def verify(token,**kwargs):
        calls.append(kwargs)
        if token=='revoked':raise ValueError('Revoked or disabled')
        return {'uid':'owner','email':next(iter(bm.STAFF_EMAILS)),'email_verified':True}
    monkeypatch.setattr(bm.firebase_auth,'verify_id_token',verify)
    assert asyncio.run(bm.verify_staff('approved'))['uid']=='owner'
    with pytest.raises(HTTPException) as error:asyncio.run(bm.verify_staff('revoked'))
    assert error.value.status_code==401 and all(c['check_revoked'] is True for c in calls)
