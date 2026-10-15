import asyncio, base64, json, time
from contextlib import asynccontextmanager
from types import SimpleNamespace as NS
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
import backend.main as bm
from backend.contracts import InspectionData
from tests.fakes import FakeStore

ID = 'ADR-INS-' + 'c' * 32


def test_authenticated_relay_pcm_frames_interruption_and_release(monkeypatch):
    store = FakeStore()
    store.create_inspection('owner', ID, InspectionData().model_dump(mode='json'))
    sent = []
    closed = []
    gate = asyncio.Event()

    class Session:
        async def send_realtime_input(self, **kwargs):
            sent.append(kwargs)
            gate.set()

        async def receive(self):
            await gate.wait()
            gate.clear()
            yield NS(
                server_content=NS(
                    interrupted=True,
                    input_transcription=NS(text='Observed condition'),
                    output_transcription=NS(text='Check the meter'),
                    model_turn=NS(parts=[NS(inline_data=NS(data=b'\x00\x00' * 240))]),
                    turn_complete=True,
                )
            )

    @asynccontextmanager
    async def connect(**kwargs):
        yield Session()

    async def close():
        closed.append(True)

    async def identity(token, **_):
        assert token == 'synthetic'
        return {'uid': 'owner', 'exp': time.time() + 600}

    monkeypatch.setattr(bm, 'verify_staff', identity)
    monkeypatch.setattr(bm, 'get_job_store', lambda: store)
    monkeypatch.setattr(
        bm.genai, 'Client', lambda **kwargs: NS(aio=NS(live=NS(connect=connect), aclose=close))
    )
    with TestClient(bm.app) as client:
        with client.websocket_connect('/api/live', headers={'origin': bm.ORIGINS[0]}) as socket:
            socket.send_json({'type': 'authenticate', 'token': 'synthetic', 'inspection_id': ID})
            assert socket.receive_json()['type'] == 'ready'
            socket.send_json(
                {'type': 'audio', 'data': base64.b64encode(b'\x00\x00' * 1600).decode()}
            )
            messages = [socket.receive_json() for _ in range(5)]
            assert [m['type'] for m in messages] == [
                'interrupted',
                'transcript',
                'transcript',
                'audio',
                'turn_complete',
            ]
            assert [m['speaker'] for m in messages if m['type'] == 'transcript'] == [
                'technician',
                'assistant',
            ]
            assert (
                messages[3]['rate'] == 24000
                and sent[0]['audio'].mime_type == 'audio/pcm;rate=16000'
            )
            frame = base64.b64encode(b'\xff\xd8\xff' + b'frame').decode()
            socket.send_json({'type': 'video', 'data': frame})
            socket.send_json({'type': 'video', 'data': frame})
            # Send invalid odd-length PCM after frames; the relay must close and release its lease.
            socket.send_json({'type': 'audio', 'data': base64.b64encode(b'x').decode()})
            while socket.receive_json()['type'] != 'error':
                pass
    assert sum('video' in item for item in sent) == 1
    assert closed and '_live_sessions/owner' not in store.db.records


def test_live_owner_check_precedes_model_connection(monkeypatch):
    store = FakeStore()
    store.create_inspection('other', ID, InspectionData().model_dump(mode='json'))

    async def identity(token, **_):
        return {'uid': 'owner', 'exp': time.time() + 600}

    monkeypatch.setattr(bm, 'verify_staff', identity)
    monkeypatch.setattr(bm, 'get_job_store', lambda: store)

    def forbidden(**kwargs):
        pytest.fail('Vertex must not connect for another owner')

    monkeypatch.setattr(bm.genai, 'Client', forbidden)
    with TestClient(bm.app).websocket_connect(
        '/api/live', headers={'origin': bm.ORIGINS[0]}
    ) as socket:
        socket.send_json({'type': 'authenticate', 'token': 'synthetic', 'inspection_id': ID})
        assert socket.receive_json()['type'] == 'error'
    assert '_live_sessions/owner' not in store.db.records


def test_live_rechecks_revocation_and_releases_resources(monkeypatch):
    store = FakeStore()
    store.create_inspection('owner', ID, InspectionData().model_dump(mode='json'))
    calls = []
    closed = []

    async def identity(token, **kwargs):
        calls.append((token, kwargs))
        if len(calls) > 1:
            raise bm.HTTPException(401, 'Session revoked')
        return {'uid': 'owner', 'exp': time.time() + 600}

    class Session:
        async def receive(self):
            await asyncio.Event().wait()
            yield None

    @asynccontextmanager
    async def connect(**kwargs):
        yield Session()

    async def close():
        await asyncio.sleep(0.02)
        closed.append(True)

    monkeypatch.setattr(bm, 'verify_staff', identity)
    monkeypatch.setattr(bm, 'get_job_store', lambda: store)
    monkeypatch.setattr(bm, 'LIVE_RECHECK_SECONDS', 0.01)
    monkeypatch.setattr(
        bm.genai, 'Client', lambda **kwargs: NS(aio=NS(live=NS(connect=connect), aclose=close))
    )
    with TestClient(bm.app) as test_client:
        with test_client.websocket_connect(
            '/api/live', headers={'origin': bm.ORIGINS[0]}
        ) as socket:
            socket.send_json({'type': 'authenticate', 'token': 'synthetic', 'inspection_id': ID})
            assert socket.receive_json()['type'] == 'ready'
            assert socket.receive_json() == {'type': 'error', 'message': 'Session revoked'}
            # The error reports revocation; server close acknowledges resource cleanup.
            with pytest.raises(WebSocketDisconnect):
                socket.receive_json()
    # The start and every heartbeat repeat the revocation lookup.
    assert (
        calls == [('synthetic', {'live': True}), ('synthetic', {'live': True})]
        and closed
        and '_live_sessions/owner' not in store.db.records
    )


def test_live_prompt_does_not_ask_about_crawl_space():
    from backend.prompts import live_prompt

    data = InspectionData().model_dump(mode='json')
    identity = {'name': 'Other Restoration Co', 'signoff': 'Pat Lee'}
    for prompt in (live_prompt(data), live_prompt(data, identity)):
        instructions, context = prompt.split('\nCurrent inspection context (JSON):\n')
        assert 'crawl' not in instructions.lower() and json.loads(context) == data
