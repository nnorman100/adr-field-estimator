import asyncio, base64, time
from contextlib import asynccontextmanager
from types import SimpleNamespace as NS
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from google.genai import _live_converters, types
import backend.main as bm
from backend.contracts import InspectionData
from backend.live_support import live_config, scope_fingerprint
from tests.fakes import FakeStore

ID='ADR-INS-'+'d'*32
CAP='e'*32

def test_vertex_configuration_and_standalone_launch():
    import subprocess,sys
    code="import main; assert main.OCR_INSTRUCTIONS; assert main.LIVE_VOICE=='Charon'"
    subprocess.run([sys.executable,'-c',code],cwd='backend',check=True)
    parent={}
    _live_converters._LiveConnectConfig_to_vertex(None,live_config('Synthetic','Charon'),parent)
    setup=parent['setup']
    assert setup['generationConfig']['speechConfig']['voiceConfig']['prebuiltVoiceConfig'].voice_name=='Charon'
    assert setup['contextWindowCompression'].trigger_tokens==64000
    assert setup['contextWindowCompression'].sliding_window.target_tokens==32000
    assert 'sessionResumption' in setup
    assert _live_converters._LiveSendRealtimeInputParameters_to_vertex({'audio_stream_end':True})['audioStreamEnd'] is True


def test_checkpoint_owner_capture_expiry_scope_and_stale_cleanup(monkeypatch):
    store=FakeStore();lease=store.live_lease('owner');fp='scope'
    assert store.live_resume('owner',CAP,ID,fp,lease,'open') is None
    store.live_resume('owner',CAP,ID,fp,lease,'save','private-handle',True)
    assert store.live_resume('owner',CAP,ID,fp,lease,'open')=='private-handle'
    assert store.live_resume('owner',CAP,ID,'changed',lease,'open') is None
    store.live_resume('owner',CAP,ID,'changed',lease,'save','second',True)
    store.db.records['_live_resume/owner']['expires']=time.time()-1
    assert store.live_resume('owner',CAP,ID,'changed',lease,'open') is None
    store.live_resume('owner',CAP,ID,'changed',lease,'save','third',True)
    store.live_resume('owner',CAP,ID,'changed','stale','delete')
    assert store.db.records['_live_resume/owner']['handle']=='third'
    other=store.live_lease('other')
    assert store.live_resume('other',CAP,ID,'changed',other,'open') is None
    store.live_resume('owner',CAP,ID,'changed',lease,'save',None,False)
    assert store.live_resume('owner',CAP,ID,'changed',lease,'open') is None
    with pytest.raises(Exception):store.live_lease('owner')
    a=InspectionData().model_dump();b={**a,'technician_transcript':'updated','scope_confirmed':True}
    assert scope_fingerprint(a)==scope_fingerprint(b)
    assert scope_fingerprint(a)!=scope_fingerprint({**a,'air_movers':2})


def test_protocol2_control_events_resume_fallback_pause_and_final_drain(monkeypatch):
    store=FakeStore();store.create_inspection('owner',ID,InspectionData().model_dump())
    configs=[];sent=[];sessions=[];rejected=[]
    class Session:
        def __init__(self):self.queue=asyncio.Queue();sessions.append(self)
        async def send_realtime_input(self,**kw):
            sent.append(kw)
            if kw.get('audio_stream_end'):
                await self.queue.put(NS(server_content=NS(interrupted=False,input_transcription=NS(text='room',finished=True),output_transcription=None,model_turn=None,turn_complete=True)))
            elif 'video' in kw:
                await self.queue.put(NS(server_content=None,go_away=NS(time_left=1)))
        async def receive(self):yield await self.queue.get()
    @asynccontextmanager
    async def connect(**kw):
        configs.append(kw['config'])
        if kw['config'].session_resumption.handle and not rejected:
            rejected.append(True);raise RuntimeError('Synthetic expired provider handle')
        session=Session()
        await session.queue.put(NS(server_content=None,session_resumption_update=NS(new_handle='synthetic-private',resumable=True)))
        await session.queue.put(NS(server_content=None,usage_metadata=NS(total_token_count=17)))
        yield session
    async def close():pass
    async def identity(token):return {'uid':'owner','exp':time.time()+600}
    monkeypatch.setattr(bm,'verify_staff',identity);monkeypatch.setattr(bm,'get_job_store',lambda:store)
    monkeypatch.setattr(bm.genai,'Client',lambda **kw:NS(aio=NS(live=NS(connect=connect),aclose=close)))
    def auth(resume=False):return dict(type='authenticate',token='synthetic',inspection_id=ID,protocol_version=2,capture_id=CAP,resume=resume)
    with TestClient(bm.app) as client:
        with client.websocket_connect('/api/live',headers={'origin':bm.ORIGINS[0]}) as socket:
            socket.send_json(auth());ready=socket.receive_json();assert ready['voice']=='Charon' and ready['recovery']=='new'
            assert socket.receive_json()=={'type':'usage','total_tokens':17}
            assert store.db.records['_live_resume/owner']['handle']=='synthetic-private'
            socket.send_json({'type':'video','data':base64.b64encode(b'\xff\xd8\xffsynthetic').decode()})
            assert socket.receive_json()['type']=='recovery'
            with pytest.raises(WebSocketDisconnect):socket.receive_json()
            assert '_live_sessions/owner' not in store.db.records
        with client.websocket_connect('/api/live',headers={'origin':bm.ORIGINS[0]}) as socket:
            socket.send_json(auth(True));response=socket.receive_json();assert response.get('recovery')=='restarted',response
            assert socket.receive_json()['type']=='usage'
            socket.send_json({'type':'audio','data':base64.b64encode(b'\0'*3200).decode()})
            socket.send_json({'type':'pause'})
            text=socket.receive_json();assert text['text']=='room' and text['finished'] is True and text['sequence']==1
            assert socket.receive_json()['type']=='turn_complete'
            socket.send_json({'type':'end'})
            while True:
                result=socket.receive_json()
                if result['type']=='finished':assert result['complete'];break
            with pytest.raises(WebSocketDisconnect):socket.receive_json()
    assert rejected and len(configs)==3 and any(item.get('audio_stream_end') for item in sent)
    assert '_live_resume/owner' not in store.db.records and '_live_sessions/owner' not in store.db.records
