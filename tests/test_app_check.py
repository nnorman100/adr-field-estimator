"""App Check monitor step: every outcome is recorded and no request is ever rejected for it."""
import asyncio, json, runpy, time
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import patch
import pytest
from fastapi.testclient import TestClient
import backend.main as bm
from backend.contracts import InspectionData
from tests.fakes import FakeStore
from tests.test_backend import context, inspect, ID

ROOT=Path(__file__).resolve().parents[1]
TOKEN='synthetic-app-check-token'
ADMIN_APP=object()

def records(capsys):
    lines=[json.loads(line) for line in capsys.readouterr().out.splitlines() if line.startswith('{')]
    return [e for e in lines if e['message']=='App Check']

@pytest.fixture
def verifier(monkeypatch):
    calls=[];result={'raise':None,'delay':0}
    def verify_token(token,app=None):
        calls.append((token,app))
        if result['delay']:time.sleep(result['delay'])
        if result['raise']:raise result['raise']
        return {'sub':'1:545776254070:web:c380c2ee35398689143357','app_id':'1:545776254070:web:c380c2ee35398689143357'}
    monkeypatch.setattr(bm.app_check,'verify_token',verify_token)
    monkeypatch.setattr(bm,'admin_app',lambda:ADMIN_APP)
    return calls,result

@pytest.mark.parametrize('header,failure,outcome',[(TOKEN,None,'valid'),(None,None,'missing'),(TOKEN,ValueError('The provided App Check token has expired.'),'invalid')])
def test_rest_records_each_outcome_and_never_rejects(context,verifier,capsys,header,failure,outcome):
    client,_=context;inspect(client);calls,result=verifier;result['raise']=failure;capsys.readouterr()
    response=client.get('/api/inspections/'+ID,headers={'X-Firebase-AppCheck':header} if header else {})
    assert response.status_code==200 and response.json()['inspection_id']==ID
    output=capsys.readouterr().out
    [entry]=[e for e in map(json.loads,filter(lambda line:line.startswith('{'),output.splitlines())) if e['message']=='App Check']
    assert entry=={'severity':'INFO','message':'App Check','outcome':outcome,'method':'GET','route':'/api/inspections/{inspection_id}','status':200}
    assert calls==([(TOKEN,ADMIN_APP)] if header else [])
    for secret in (TOKEN,ID,'owner'):assert secret not in output

def test_request_rejected_before_its_body_is_read_is_still_recorded(verifier,capsys):
    calls,_=verifier;capsys.readouterr()
    response=TestClient(bm.app).post('/api/inspections',headers={'X-Firebase-AppCheck':TOKEN},json={})
    assert response.status_code==401
    [entry]=records(capsys)
    assert entry['outcome']=='valid' and entry['method']=='POST' and entry['status']==401 and calls==[(TOKEN,ADMIN_APP)]

def test_slow_verification_is_bounded_and_recorded_as_unverified(context,verifier,monkeypatch,capsys):
    client,_=context;_,result=verifier;result['delay']=.5
    monkeypatch.setattr(bm,'APPCHECK_SECONDS',.05);capsys.readouterr()
    started=time.monotonic()
    assert client.get('/api/health',headers={'X-Firebase-AppCheck':TOKEN}).status_code==200
    assert time.monotonic()-started<.45
    [entry]=records(capsys)
    assert entry['outcome']=='unverified' and entry['route']=='/api/health' and entry['status']==200

def test_oversized_token_is_invalid_without_verification(context,verifier,capsys):
    client,_=context;calls,_=verifier;capsys.readouterr()
    assert client.get('/api/health',headers={'X-Firebase-AppCheck':'x'*(bm.APPCHECK_TOKEN_LIMIT+1)}).status_code==200
    assert [e['outcome'] for e in records(capsys)]==['invalid'] and calls==[]

def test_off_mode_neither_verifies_nor_records(context,verifier,monkeypatch,capsys):
    client,_=context;calls,_=verifier;monkeypatch.setattr(bm,'APPCHECK_MODE','off');capsys.readouterr()
    assert client.get('/api/health',headers={'X-Firebase-AppCheck':TOKEN}).status_code==200
    assert records(capsys)==[] and calls==[]

def test_static_assets_are_not_recorded(verifier,capsys):
    capsys.readouterr()
    TestClient(bm.app).get('/health',headers={'X-Firebase-AppCheck':TOKEN})
    assert records(capsys)==[] and verifier[0]==[]

def run_main(monkeypatch,mode):
    monkeypatch.syspath_prepend(str(ROOT/'backend'))
    monkeypatch.delenv('GOOGLE_CLOUD_PROJECT',raising=False)
    if mode is None:monkeypatch.delenv('APPCHECK_MODE',raising=False)
    else:monkeypatch.setenv('APPCHECK_MODE',mode)
    with patch('google.genai.Client'):
        return runpy.run_path(str(ROOT/'backend'/'main.py'))

def test_monitor_is_the_default_and_enforcement_cannot_be_configured(monkeypatch):
    assert run_main(monkeypatch,None)['APPCHECK_MODE']=='monitor'
    assert run_main(monkeypatch,'off')['APPCHECK_MODE']=='off'
    for mode in ('enforce','ENFORCE','on'):
        with pytest.raises(RuntimeError,match='enforcement is not available'):run_main(monkeypatch,mode)

@pytest.mark.parametrize('token,failure,outcome',[(TOKEN,None,'valid'),(None,None,'missing'),(TOKEN,ValueError('The provided App Check token has an invalid signature.'),'invalid')])
def test_live_authentication_records_app_check_and_still_connects(monkeypatch,verifier,capsys,token,failure,outcome):
    store=FakeStore();store.create_inspection('owner',ID,InspectionData().model_dump(mode='json'))
    calls,result=verifier;result['raise']=failure;identities=[]
    class Session:
        async def receive(self):
            await asyncio.Event().wait()
            yield None
    @asynccontextmanager
    async def connect(**kwargs):yield Session()
    async def close():pass
    async def identity(value):identities.append(value);return {'uid':'owner','exp':time.time()+600}
    monkeypatch.setattr(bm,'verify_staff',identity);monkeypatch.setattr(bm,'get_job_store',lambda:store)
    monkeypatch.setattr(bm.genai,'Client',lambda **kwargs:NS(aio=NS(live=NS(connect=connect),aclose=close)))
    capsys.readouterr()
    with TestClient(bm.app) as client, client.websocket_connect('/api/live',headers={'origin':bm.ORIGINS[0]}) as socket:
        socket.send_json({'type':'authenticate','token':'synthetic','inspection_id':ID,**({'app_check':token} if token else {})})
        assert socket.receive_json()['type']=='ready'
    output=capsys.readouterr().out
    [entry]=[e for e in map(json.loads,filter(lambda line:line.startswith('{'),output.splitlines())) if e['message']=='App Check']
    assert entry=={'severity':'INFO','message':'App Check','outcome':outcome,'method':'WEBSOCKET','route':'/api/live'}
    assert identities==['synthetic'] and calls==([(TOKEN,ADMIN_APP)] if token else [])
    assert TOKEN not in output
