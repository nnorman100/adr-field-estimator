import asyncio, base64, time
from contextlib import asynccontextmanager
from types import SimpleNamespace as NS
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
import backend.main as bm
from backend.contracts import InspectionData
from backend.live_support import scope_fingerprint
from tests.fakes import FakeStore, FakeVertexLive, realtime

ID='ADR-INS-'+'d'*32
CAP='e'*32

def test_vertex_configuration_and_standalone_launch():
    import subprocess,sys
    code="import main; assert main.OCR_INSTRUCTIONS; assert main.LIVE_VOICE=='Charon'"
    subprocess.run([sys.executable,'-c',code],cwd='backend',check=True)


def wire_audio(text):
    return {'serverContent':{'modelTurn':{'parts':[{'inlineData':{'mimeType':'audio/pcm;rate=24000','data':base64.b64encode(b'\x01\x02').decode()}}]},
        'outputTranscription':{'text':text}}}


def test_real_sdk_wire_setup_events_interaction_status_and_resume(monkeypatch,tmp_path):
    # The real google-genai client talks to a local stand-in for Vertex, so SDK upgrades that change
    # the setup message, realtime input or server message parsing fail here instead of in the field.
    store=FakeStore();store.create_inspection('owner',ID,InspectionData().model_dump())
    async def identity(token):return {'uid':'owner','exp':time.time()+600}
    monkeypatch.setattr(bm,'verify_staff',identity);monkeypatch.setattr(bm,'get_job_store',lambda:store)
    def auth(resume=False):return dict(type='authenticate',token='synthetic',inspection_id=ID,protocol_version=2,capture_id=CAP,resume=resume)
    with FakeVertexLive(tmp_path) as vertex, TestClient(bm.app) as client:
        monkeypatch.setattr(bm.genai,'Client',vertex.client(bm.genai.Client))
        vertex.replies['setup']=[{'setupComplete':{}},{'sessionResumptionUpdate':{'newHandle':'wire-handle','resumable':True}},
            {'usageMetadata':{'totalTokenCount':17}}]
        # A completed turn still marked IN_PROGRESS no longer ends one SDK receive() pass; IDLE does.
        vertex.replies['audio']=[{'serverContent':{'inputTranscription':{'text':'moisture at the wall','finished':True}}},wire_audio('Noted'),
            {'serverContent':{'turnComplete':True,'interactionStatus':'IN_PROGRESS'}},{'serverContent':{'interrupted':True}},
            {'serverContent':{'interactionStatus':'IDLE'}},{'serverContent':{'outputTranscription':{'text':'after idle'}}}]
        vertex.replies['video']=[{'goAway':{'timeLeft':'1s'}}]
        with client.websocket_connect('/api/live',headers={'origin':bm.ORIGINS[0]}) as socket:
            socket.send_json(auth());assert socket.receive_json()['recovery']=='new'
            assert socket.receive_json()=={'type':'usage','total_tokens':17}
            socket.send_json({'type':'audio','data':pcm(3300)})
            events=[socket.receive_json() for _ in range(6)]
            assert [(e['type'],e.get('speaker'),e.get('text')) for e in events]==[('transcript','technician','moisture at the wall'),
                ('transcript','assistant','Noted'),('audio',None,None),('turn_complete',None,None),('interrupted',None,None),('transcript','assistant','after idle')]
            assert events[2]['data']==base64.b64encode(b'\x01\x02').decode() and events[0]['finished'] is True
            socket.send_json({'type':'video','data':base64.b64encode(b'\xff\xd8\xffsynthetic').decode()})
            assert socket.receive_json()=={'type':'recovery','reason':'rollover'}
            with pytest.raises(WebSocketDisconnect):socket.receive_json()
        assert store.db.records['_live_resume/owner']['handle']=='wire-handle'
        vertex.replies['setup']=[{'setupComplete':{}}]
        with client.websocket_connect('/api/live',headers={'origin':bm.ORIGINS[0]}) as socket:
            socket.send_json(auth(True));assert socket.receive_json()['recovery']=='resumed'
            socket.send_json({'type':'pause'})
            socket.send_json({'type':'end'});assert socket.receive_json()=={'type':'finished','complete':True}
            with pytest.raises(WebSocketDisconnect):socket.receive_json()
    first,second=vertex.connections
    assert all(c['path'].endswith('LlmBidiService/BidiGenerateContent') and c['authorization']=='Bearer synthetic-token' for c in vertex.connections)
    setup=first['received'][0]['setup']
    assert setup['model']==f'projects/{bm.PROJECT_ID}/locations/{bm.LIVE_LOCATION}/publishers/google/models/{bm.LIVE_MODEL}'
    assert setup['generationConfig']['responseModalities']==['AUDIO']
    # Nested config objects keep their field names on the wire, exactly as google-genai 2.8.0 sent them;
    # proto JSON accepts either spelling.
    assert setup['generationConfig']['speechConfig']=={'voiceConfig':{'prebuiltVoiceConfig':{'voice_name':'Charon'}}}
    assert setup['contextWindowCompression']=={'trigger_tokens':64000,'sliding_window':{'target_tokens':32000}}
    assert setup['sessionResumption']=={} and setup['inputAudioTranscription']=={} and setup['outputAudioTranscription']=={}
    assert setup['systemInstruction']['parts'][0]['text']
    # Bytes travel as URL-safe base64, as they did with 2.8.0.
    spoken=base64.urlsafe_b64encode(base64.b64decode(pcm(3300))).decode()
    assert realtime(first['received'][1])=={'audio':{'data':spoken,'mime_type':'audio/pcm;rate=16000'}}
    assert realtime(first['received'][2])['video']['mime_type']=='image/jpeg'
    assert second['received'][0]['setup']['sessionResumption']=={'handle':'wire-handle'}
    assert [realtime(m) for m in second['received'][1:]]==[{'audioStreamEnd':True}]*2


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
            # Provider events already in flight may follow the acknowledgement; the client closes on it.
            with pytest.raises(WebSocketDisconnect):
                while True:assert socket.receive_json()['type']!='finished'
    assert rejected and len(configs)==3 and any(item.get('audio_stream_end') for item in sent)
    assert '_live_resume/owner' not in store.db.records and '_live_sessions/owner' not in store.db.records


def pcm(amplitude,samples=1600):
    # A 16 kHz PCM16 square wave; its RMS equals the amplitude.
    return base64.b64encode(b''.join(int(amplitude*(1 if i%40<20 else -1)).to_bytes(2,'little',signed=True) for i in range(samples))).decode()


def finishing_relay(monkeypatch,store):
    class Session:
        def __init__(self):self.queue=asyncio.Queue();self.spoken=False
        async def send_realtime_input(self,**kw):
            if 'audio' in kw and not self.spoken:
                self.spoken=True
                await self.queue.put(NS(server_content=NS(interrupted=False,input_transcription=NS(text='moisture at the wall',finished=True),output_transcription=None,model_turn=None,turn_complete=False)))
        async def receive(self):yield await self.queue.get()
    @asynccontextmanager
    async def connect(**kw):yield Session()
    async def close():pass
    async def identity(token):return {'uid':'owner','exp':time.time()+600}
    monkeypatch.setattr(bm,'verify_staff',identity);monkeypatch.setattr(bm,'get_job_store',lambda:store)
    monkeypatch.setattr(bm.genai,'Client',lambda **kw:NS(aio=NS(live=NS(connect=connect),aclose=close)))


def test_trailing_silence_after_final_transcript_still_finishes_complete(monkeypatch):
    store=FakeStore();store.create_inspection('owner',ID,InspectionData().model_dump())
    finishing_relay(monkeypatch,store)
    with TestClient(bm.app) as client, client.websocket_connect('/api/live',headers={'origin':bm.ORIGINS[0]}) as socket:
        socket.send_json(dict(type='authenticate',token='synthetic',inspection_id=ID,protocol_version=2,capture_id=CAP))
        assert socket.receive_json()['type']=='ready'
        # Conversational speech after browser AGC sits near -20 dBFS (RMS ~3300).
        socket.send_json({'type':'audio','data':pcm(3300)})
        assert socket.receive_json()['finished'] is True
        # The open microphone keeps streaming: digital silence and a suppressed noise floor near -50 dBFS (RMS ~100).
        for amplitude in (0,100,0,100):socket.send_json({'type':'audio','data':pcm(amplitude)})
        started=time.monotonic();socket.send_json({'type':'end'})
        assert socket.receive_json()=={'type':'finished','complete':True}
        assert time.monotonic()-started<1


def test_finished_is_acknowledged_before_cleanup_writes(monkeypatch):
    import threading
    store=FakeStore();store.create_inspection('owner',ID,InspectionData().model_dump())
    finishing_relay(monkeypatch,store)
    acknowledged=threading.Event();releases=[];original=store.live_lease
    def lease(uid,lease_id=None,release=False):
        if release:releases.append(acknowledged.wait(5))
        return original(uid,lease_id,release)
    monkeypatch.setattr(store,'live_lease',lease)
    with TestClient(bm.app) as client, client.websocket_connect('/api/live',headers={'origin':bm.ORIGINS[0]}) as socket:
        socket.send_json(dict(type='authenticate',token='synthetic',inspection_id=ID,protocol_version=2,capture_id=CAP))
        assert socket.receive_json()['type']=='ready'
        socket.send_json({'type':'end'})
        assert socket.receive_json()['type']=='finished'
        acknowledged.set()
        with pytest.raises(WebSocketDisconnect):socket.receive_json()
    assert releases==[True] and '_live_sessions/owner' not in store.db.records


def test_daily_live_start_cap_rejects_before_vertex(monkeypatch):
    import backend.inspection_store as module
    store=FakeStore();store.create_inspection('owner',ID,InspectionData().model_dump())
    finishing_relay(monkeypatch,store);monkeypatch.setitem(module.DAILY_LIMITS,'live',1)
    opened=[];relay=bm.genai.Client
    monkeypatch.setattr(bm.genai,'Client',lambda **kw:opened.append(True) or relay(**kw))
    auth=dict(type='authenticate',token='synthetic',inspection_id=ID,protocol_version=2,capture_id=CAP)
    with TestClient(bm.app) as client:
        with client.websocket_connect('/api/live',headers={'origin':bm.ORIGINS[0]}) as socket:
            socket.send_json(auth);assert socket.receive_json()['type']=='ready'
            socket.send_json({'type':'end'});assert socket.receive_json()['type']=='finished'
            with pytest.raises(WebSocketDisconnect):socket.receive_json()
        assert '_live_sessions/owner' not in store.db.records
        with client.websocket_connect('/api/live',headers={'origin':bm.ORIGINS[0]}) as socket:
            socket.send_json(auth)
            assert socket.receive_json()=={'type':'error','message':'Too many requests. Please wait and retry.','status':429}
            with pytest.raises(WebSocketDisconnect):socket.receive_json()
    assert opened==[True] and '_live_sessions/owner' not in store.db.records


@pytest.mark.parametrize('protocol',[1,2])
def test_resume_flag_without_checkpoint_is_charged_as_a_new_start(monkeypatch,protocol):
    import backend.inspection_store as module
    store=FakeStore();store.create_inspection('owner',ID,InspectionData().model_dump())
    finishing_relay(monkeypatch,store);monkeypatch.setitem(module.DAILY_LIMITS,'live',1)
    opened=[];relay=bm.genai.Client
    monkeypatch.setattr(bm.genai,'Client',lambda **kw:opened.append(True) or relay(**kw))
    auth=dict(type='authenticate',token='synthetic',inspection_id=ID,protocol_version=protocol,resume=True)
    if protocol==2:auth['capture_id']=CAP
    with TestClient(bm.app) as client:
        with client.websocket_connect('/api/live',headers={'origin':bm.ORIGINS[0]}) as socket:
            socket.send_json(auth);assert socket.receive_json()['type']=='ready'
            socket.send_json({'type':'end'})
            if protocol==2:assert socket.receive_json()['type']=='finished'
            # The server closes only after releasing the lease, so the next 429 is the daily cap.
            with pytest.raises(WebSocketDisconnect):socket.receive_json()
        assert '_live_sessions/owner' not in store.db.records
        with client.websocket_connect('/api/live',headers={'origin':bm.ORIGINS[0]}) as socket:
            socket.send_json(auth)
            error=socket.receive_json();assert error['message']=='Too many requests. Please wait and retry.'
            with pytest.raises(WebSocketDisconnect):socket.receive_json()
    assert opened==[True] and '_live_sessions/owner' not in store.db.records


def test_genuine_resume_with_saved_checkpoint_is_not_charged_again(monkeypatch):
    import backend.inspection_store as module
    store=FakeStore();store.create_inspection('owner',ID,InspectionData().model_dump())
    finishing_relay(monkeypatch,store);monkeypatch.setitem(module.DAILY_LIMITS,'live',1)
    fingerprint=scope_fingerprint(store.get_inspection('owner',ID)['data'])
    def auth(resume):return dict(type='authenticate',token='synthetic',inspection_id=ID,protocol_version=2,capture_id=CAP,resume=resume)
    with TestClient(bm.app) as client:
        with client.websocket_connect('/api/live',headers={'origin':bm.ORIGINS[0]}) as socket:
            socket.send_json(auth(False));assert socket.receive_json()['recovery']=='new'
            socket.send_json({'type':'end'});assert socket.receive_json()['type']=='finished'
            with pytest.raises(WebSocketDisconnect):socket.receive_json()
        # The provider handed out a resumption handle before the connection dropped.
        lease=store.live_lease('owner')
        store.live_resume('owner',CAP,ID,fingerprint,lease,'open')
        store.live_resume('owner',CAP,ID,fingerprint,lease,'save','synthetic-private',True)
        store.live_lease('owner',lease,True)
        with client.websocket_connect('/api/live',headers={'origin':bm.ORIGINS[0]}) as socket:
            socket.send_json(auth(True));assert socket.receive_json()['recovery']=='resumed'
            socket.send_json({'type':'end'});assert socket.receive_json()['type']=='finished'
            with pytest.raises(WebSocketDisconnect):socket.receive_json()
        with client.websocket_connect('/api/live',headers={'origin':bm.ORIGINS[0]}) as socket:
            socket.send_json(auth(False))
            error=socket.receive_json();assert error['type']=='error' and error['status']==429
            with pytest.raises(WebSocketDisconnect):socket.receive_json()


def token_relay(monkeypatch,store,claims):
    finishing_relay(monkeypatch,store);calls=[]
    async def identity(token):
        calls.append(token)
        if token not in claims:raise bm.HTTPException(401,'Your sign-in expired. Please sign in again.')
        return claims[token]
    monkeypatch.setattr(bm,'verify_staff',identity);monkeypatch.setattr(bm,'LIVE_RECHECK_SECONDS',.05)
    return calls


@pytest.mark.parametrize('refresh',[True,False])
def test_refreshed_token_keeps_the_session_open_past_the_original_expiry(monkeypatch,refresh):
    store=FakeStore();store.create_inspection('owner',ID,InspectionData().model_dump())
    calls=token_relay(monkeypatch,store,{'initial':{'uid':'owner','exp':time.time()+.5},'renewed':{'uid':'owner','exp':time.time()+3600}})
    with TestClient(bm.app) as client, client.websocket_connect('/api/live',headers={'origin':bm.ORIGINS[0]}) as socket:
        socket.send_json(dict(type='authenticate',token='initial',inspection_id=ID,protocol_version=2,capture_id=CAP))
        assert socket.receive_json()['token_refresh'] is True
        if refresh:socket.send_json({'type':'refresh','token':'renewed'})
        # The heartbeat runs several times after the initial token's exp has passed.
        time.sleep(1)
        socket.send_json({'type':'end'})
        if refresh:assert socket.receive_json()=={'type':'finished','complete':True}
        else:assert socket.receive_json()['type']=='error'
        with pytest.raises(WebSocketDisconnect):socket.receive_json()
    if refresh:
        # Only the newest token is re-verified once the refresh lands.
        assert calls[0]=='initial' and calls.count('renewed')>=5 and 'initial' not in calls[calls.index('renewed'):]
    assert '_live_sessions/owner' not in store.db.records


@pytest.mark.parametrize('token,status',[('intruder',None),('forged',401)])
def test_refresh_for_another_user_or_invalid_token_closes_without_switching_identity(monkeypatch,token,status):
    store=FakeStore();store.create_inspection('owner',ID,InspectionData().model_dump())
    calls=token_relay(monkeypatch,store,{'initial':{'uid':'owner','exp':time.time()+3600},'intruder':{'uid':'other','exp':time.time()+3600}})
    with TestClient(bm.app) as client, client.websocket_connect('/api/live',headers={'origin':bm.ORIGINS[0]}) as socket:
        socket.send_json(dict(type='authenticate',token='initial',inspection_id=ID,protocol_version=2,capture_id=CAP))
        assert socket.receive_json()['type']=='ready'
        assert '_live_resume/owner' in store.db.records
        socket.send_json({'type':'refresh','token':token})
        error=socket.receive_json()
        assert error['type']=='error' and error.get('status')==status
        with pytest.raises(WebSocketDisconnect):socket.receive_json()
    assert calls[0]=='initial' and token in calls
    # A rejected refresh is treated like revocation: no checkpoint survives to resume from.
    assert '_live_resume/owner' not in store.db.records and '_live_sessions/owner' not in store.db.records
