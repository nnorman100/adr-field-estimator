import asyncio, json, time
from threading import Timer
from types import SimpleNamespace
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
import backend.main as bm
from backend.contracts import InspectionData
from tests.fakes import FakeStore,png

ID='ADR-INS-'+'a'*32
MB=bm.MB

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
    yield TestClient(bm.app,headers={'Authorization':'Bearer synthetic'}),store
    bm.app.dependency_overrides.clear()

def inspect(client):
    r=client.post('/api/inspections',json={'inspection_id':ID,'data':data()});assert r.status_code==200,r.text
    return r.json()
def audit(client,record):
    r=client.post('/api/audit',json={'inspection_id':ID,'expected_revision':record['revision']});assert r.status_code==200,r.text
    return r.json()
def sign_payload(record):
    return dict(inspection_id=ID,expected_revision=record['revision'],auth_id='ADR-AUTH-test123456',proposal_hash=record['audit']['proposal_hash'],signature_png=png(),documents_confirmed=True)
def photo(client,record,photo_id='b'*32):
    r=client.post('/api/inspections/'+ID+'/photos',json=dict(expected_revision=record['revision'],photo_id=photo_id,room='Bathroom',captured_at='2026-10-06T19:00:00Z',data_url=png()));assert r.status_code==200,r.text
    return r.json()
NO_METER={'meter_detected':False,'meter_type':'Inspection Photo','value':'','classification':'No readable meter','notes':'No physical display visible.'}

def test_audit_waits_for_pending_ocr_and_rejects_real_input_changes(context):
    client,store=context;record=photo(client,inspect(client))
    Timer(0.2,store.set_ocr,('owner',ID,'b'*32,NO_METER)).start()
    saved=audit(client,record)
    assert saved['photos'][0]['ocr_status']=='no_meter' and saved['audit']['revision']==saved['revision']==record['revision']+1
    record=photo(client,saved,'c'*32)
    changed=data();changed['address']='Changed while waiting'
    Timer(0.2,store.update_inspection,('owner',ID,record['revision'],changed)).start()
    response=client.post('/api/audit',json={'inspection_id':ID,'expected_revision':record['revision']})
    assert response.status_code==409 and 'changed while waiting' in response.json()['detail']

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

def test_zero_work_audit_is_rejected_before_the_model_runs(context,monkeypatch):
    client,_=context;calls=[]
    async def generate(**kwargs):calls.append(kwargs);return SimpleNamespace(text=json.dumps({'summary':'Nothing priced.','suggestions':[],'unpriced_work':[]}))
    monkeypatch.setattr(bm,'get_ai_client',lambda:SimpleNamespace(aio=SimpleNamespace(models=SimpleNamespace(generate_content=generate))))
    empty=data(emergency_calls=0,monitoring_hours=0,haul_loads=0,air_scrubbers=0,hepa_filters=0);empty.update(air_movers=0,dehumidifiers=0);empty['rooms'][0]['finished_sf']=0
    record=client.post('/api/inspections',json={'inspection_id':ID,'data':empty}).json()
    response=client.post('/api/audit',json={'inspection_id':ID,'expected_revision':record['revision']})
    assert response.status_code==400 and 'Add measured work' in response.json()['detail'] and calls==[]

def test_non_meter_and_failed_ocr_remain_unverified(context,monkeypatch):
    client,store=context;record=photo(client,inspect(client))
    result=client.post('/api/inspections/'+ID+'/photos/'+'b'*32+'/ocr',json={})
    assert result.status_code==200 and result.json()['photos'][0]['ocr_status']=='no_meter'
    photo(client,result.json(),'c'*32)
    async def unavailable(**kwargs):raise RuntimeError('provider unavailable')
    monkeypatch.setattr(bm,'get_ai_client',lambda:SimpleNamespace(aio=SimpleNamespace(models=SimpleNamespace(generate_content=unavailable))))
    result=client.post('/api/inspections/'+ID+'/photos/'+'c'*32+'/ocr',json={})
    assert result.status_code==502 and store.get_inspection('owner',ID)['photos'][1]['ocr_status']=='failed'
    assert client.post('/api/inspections/'+ID+'/photos/'+'b'*32+'/ocr',json={}).status_code==502
    assert store.get_inspection('owner',ID)['photos'][0]['ocr_status']=='no_meter'

VERIFIED={'meter_detected':True,'meter_type':'Pin moisture meter','value':'18.5','classification':'Wet','notes':'Readable display.'}

def test_failed_ocr_retry_keeps_verified_reading_revision_and_audit(context,monkeypatch):
    client,store=context;photo(client,inspect(client))
    store.set_ocr('owner',ID,'b'*32,VERIFIED)
    audited=audit(client,client.get('/api/inspections/'+ID).json())
    async def unavailable(**kwargs):raise RuntimeError('provider unavailable')
    monkeypatch.setattr(bm,'get_ai_client',lambda:SimpleNamespace(aio=SimpleNamespace(models=SimpleNamespace(generate_content=unavailable))))
    assert client.post('/api/inspections/'+ID+'/photos/'+'b'*32+'/ocr',json={}).status_code==502
    current=store.get_inspection('owner',ID)
    assert current['photos'][0]['ocr']==VERIFIED and current['photos'][0]['ocr_status']=='verified'
    assert current['revision']==audited['revision'] and current['audit']==audited['audit']

def test_cancelled_ocr_request_does_not_leave_the_photo_pending(context,monkeypatch):
    client,store=context;photo(client,inspect(client))
    async def hang(*args,**kwargs):await asyncio.Event().wait()
    monkeypatch.setattr(bm,'generate',hang)
    async def deadline():
        with pytest.raises(asyncio.TimeoutError):await asyncio.wait_for(bm.ocr_photo.__wrapped__(ID,'b'*32,{'uid':'owner'},store),0.2)
    asyncio.run(deadline())
    assert store.get_inspection('owner',ID)['photos'][0]['ocr_status']=='failed'

def test_auth_ownership_limits_and_invalid_inputs(context):
    client,_=context;inspect(client)
    bm.app.dependency_overrides[bm.current_staff]=lambda:{'uid':'other'}
    assert client.get('/api/inspections/'+ID).status_code==404
    assert client.post('/api/inspections/'+ID+'/photos',json=dict(expected_revision=1,photo_id='b'*32,room='Room',captured_at='2026-10-06T19:00:00Z',data_url=png())).status_code==404
    bm.app.dependency_overrides.pop(bm.current_staff)
    for path in ['/api/inspections','/api/authorizations','/api/authorizations/ADR-AUTH-test123456']:
        assert client.get(path,headers={'Authorization':''}).status_code==401
    assert client.get('/api/health').status_code==200
    bm.app.dependency_overrides[bm.current_staff]=lambda:{'uid':'owner'}
    invalid=data();invalid['labor_hours']=-1
    assert client.put('/api/inspections/'+ID,json={'expected_revision':1,'data':invalid}).status_code==422
    # The transaction-backed per-user limit applies to API calls.
    for _ in range(3):client.post('/api/audit',json={'inspection_id':ID,'expected_revision':1})
    response=client.post('/api/audit',json={'inspection_id':ID,'expected_revision':1})
    assert response.status_code==429 and response.headers['Retry-After']

def send_raw(method,path,headers,receive):
    """Drive the ASGI app directly so the test controls, and observes, every body read."""
    sent=[]
    async def send(message):sent.append(message)
    scope={'type':'http','asgi':{'version':'3.0'},'http_version':'1.1','method':method,'scheme':'http','path':path,'raw_path':path.encode(),
           'query_string':b'','root_path':'','headers':[(k.lower().encode(),v.encode()) for k,v in headers.items()],'client':('test',1),'server':('test',80)}
    asyncio.run(bm.app(scope,receive,send))
    return next(m['status'] for m in sent if m['type']=='http.response.start')

def test_unauthenticated_upload_is_rejected_before_the_body_is_read(context):
    reads=[]
    async def receive():reads.append(1);return {'type':'http.request','body':b'x'*MB,'more_body':True}
    for headers in ({'content-length':str(19*MB)},{'content-length':str(19*MB),'authorization':'Basic abc'},{'authorization':'Bearer '}):
        assert send_raw('POST','/api/inspections/'+ID+'/photos',headers,receive)==401
    assert reads==[]

def test_declared_and_streamed_bodies_are_capped_per_route(context):
    client,_=context
    async def unread():raise AssertionError('The body must not be read.')
    auth={'authorization':'Bearer synthetic'}
    for path,limit in [('/api/inspections/'+ID+'/photos',13*MB),('/api/authorize',int(3.5*MB)),('/api/inspections',MB),('/api/audit',MB)]:
        assert send_raw('POST',path,{**auth,'content-length':str(limit+1)},unread)==413
    assert send_raw('PUT','/api/inspections/'+ID,{**auth,'content-length':str(MB+1)},unread)==413
    assert send_raw('POST','/api/inspections',{**auth,'content-length':'1e9'},unread)==400
    # Under its own ceiling, a body above the default reaches validation.
    big=client.post('/api/authorize',json={'auth_id':'ADR-AUTH-never-saved','signature_png':'a'*(2*MB)})
    assert big.status_code==409
    # Chunked bodies without Content-Length keep the streaming cap.
    chunks=iter([b'{"x":"'+b'a'*MB,b'a'*MB])
    assert client.post('/api/inspections',content=chunks,headers={'content-type':'application/json'}).status_code==413

def test_slow_body_hits_the_read_deadline(context,monkeypatch):
    monkeypatch.setattr(bm,'BODY_READ_SECONDS',0.2)
    async def trickle():await asyncio.sleep(0.1);return {'type':'http.request','body':b'x','more_body':True}
    assert send_raw('POST','/api/inspections',{'authorization':'Bearer synthetic'},trickle)==408

def test_authenticated_full_size_photo_upload_still_works(context):
    client,_=context;record=inspect(client)
    # Whitespace pads a valid upload to near the photo ceiling, far above the 1 MB default.
    padded=json.dumps(dict(expected_revision=record['revision'],photo_id='b'*32,room='Bathroom',captured_at='2026-10-06T19:00:00Z',data_url=png()))
    padded=padded[:-1]+' '*(12*MB-len(padded))+'}'
    r=client.post('/api/inspections/'+ID+'/photos',content=padded,headers={'content-type':'application/json'})
    assert r.status_code==200,r.text
    assert r.json()['photos'][0]['id']=='b'*32

def as_user(uid):
    bm.app.dependency_overrides[bm.current_staff]=lambda:{'uid':uid,'email':uid+'@example.invalid'}

def test_other_user_cannot_reach_any_owned_unsigned_inspection(context):
    client,_=context
    record=photo(client,inspect(client))
    as_user('other')
    responses=[
        client.put('/api/inspections/'+ID,json={'expected_revision':record['revision'],'data':{**data(),'technician_notes':'Overwritten by another user.'}}),
        client.get('/api/inspections/'+ID+'/photos/'+'b'*32),
        client.post('/api/inspections/'+ID+'/photos/'+'b'*32+'/ocr'),
        client.post('/api/inspections/'+ID+'/scope-suggestions',json={'inspection_id':ID,'expected_revision':record['revision']}),
        client.post('/api/audit',json={'inspection_id':ID,'expected_revision':record['revision']}),
    ]
    assert [r.status_code for r in responses]==[404]*len(responses),[r.text for r in responses]
    assert ID not in json.dumps(client.get('/api/inspections').json())
    as_user('owner');assert client.get('/api/inspections/'+ID).json()['data']['technician_notes']==data()['technician_notes']

def test_other_user_cannot_sign_read_or_download_a_signed_record(context):
    client,_=context
    record=audit(client,inspect(client));payload=sign_payload(record)
    as_user('other')
    # A refused attempt must not reserve the authorization reference for the owner.
    assert client.post('/api/authorize',json=payload).status_code==404
    as_user('owner');assert client.post('/api/authorize',json=payload).status_code==200
    as_user('other')
    assert client.get('/api/authorizations/'+payload['auth_id']).status_code==404
    assert client.get('/api/authorizations/'+payload['auth_id']+'/evidence/signature').status_code==404
    assert payload['auth_id'] not in json.dumps(client.get('/api/authorizations').json())

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
