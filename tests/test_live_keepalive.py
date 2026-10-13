"""The release verifier's Live client must keep answering the relay's keepalive pings."""

import asyncio
import base64
import socket
import threading
import time
import wave
from uuid import UUID

import uvicorn

import backend.main as bm
from backend.contracts import InspectionData
from scripts import verify_live_release as verifier
from tests.fakes import FakeStore, FakeVertexLive

ID = 'ADR-INS-' + 'c' * 32
CAPTURE = UUID('f' * 32)
# Real uvicorn keepalive, shortened from the 20 s / 20 s defaults Cloud Run serves with.
PING_INTERVAL = PING_TIMEOUT = 0.5


def wire_audio(text):
    return {
        'serverContent': {
            'modelTurn': {
                'parts': [
                    {
                        'inlineData': {
                            'mimeType': 'audio/pcm;rate=24000',
                            'data': base64.b64encode(b'\x01\x02').decode(),
                        }
                    }
                ]
            },
            'outputTranscription': {'text': text},
        }
    }


class Replies(dict):
    def pop(self, kind, default=None):
        return self[kind] if kind == 'setup' else super().pop(kind, default)


def test_slow_checkpoint_read_does_not_starve_the_relay_keepalive(monkeypatch, tmp_path):
    # On WSL2 the Windows gcloud wrapper takes ~30 s per token; the relay closes a socket whose
    # client cannot answer a ping within ping_interval + ping_timeout.
    store = FakeStore()
    store.create_inspection('owner', ID, InspectionData().model_dump())

    async def identity(token, **_):
        return {'uid': 'owner', 'exp': time.time() + 600}

    monkeypatch.setattr(bm, 'verify_staff', identity)
    monkeypatch.setattr(bm, 'get_job_store', lambda: store)

    with wave.open(str(tmp_path / 'live-prompt.wav'), 'wb') as recording:
        recording.setnchannels(1)
        recording.setsampwidth(2)
        recording.setframerate(16000)
        recording.writeframes(b'\x10\x00' * 4800)

    def slow_checkpoint(collection, uid):
        assert (collection, uid) == ('_live_resume', 'owner')
        time.sleep(3 * (PING_INTERVAL + PING_TIMEOUT))
        return {
            'capture_id': {'stringValue': CAPTURE.hex},
            'resumable': {'booleanValue': True},
            'handle': {'stringValue': 'wire-handle'},
        }

    listener = socket.socket()
    listener.bind(('127.0.0.1', 0))
    port = listener.getsockname()[1]
    # live() maps https: to wss:; a ws: service URL reaches the plain local listener unchanged.
    monkeypatch.setattr(verifier, 'SERVICE', f'ws://127.0.0.1:{port}')
    monkeypatch.setattr(verifier, 'URL', bm.ORIGINS[0])
    monkeypatch.setattr(verifier, 'FIXTURES', tmp_path)
    monkeypatch.setattr(verifier, 'uuid4', lambda: CAPTURE)
    monkeypatch.setattr(verifier, 'private_document', slow_checkpoint)
    monkeypatch.setattr(verifier, 'assert_capture_released', lambda uid: None)

    server = uvicorn.Server(
        uvicorn.Config(
            bm.app,
            ws_ping_interval=PING_INTERVAL,
            ws_ping_timeout=PING_TIMEOUT,
            log_level='warning',
        )
    )
    thread = threading.Thread(target=server.run, kwargs={'sockets': [listener]}, daemon=True)
    with FakeVertexLive(tmp_path) as vertex:
        monkeypatch.setattr(bm.genai, 'Client', vertex.client(bm.genai.Client))
        # The resumed second connection needs its own setup replies.
        vertex.replies = Replies()
        vertex.replies['setup'] = [
            {'setupComplete': {}},
            {'sessionResumptionUpdate': {'newHandle': 'wire-handle', 'resumable': True}},
            {'usageMetadata': {'totalTokenCount': 17}},
        ]
        vertex.replies['audio'] = [
            {
                'serverContent': {
                    'inputTranscription': {'text': 'moisture at the wall', 'finished': True}
                }
            },
            wire_audio('Noted'),
            {'serverContent': {'turnComplete': True}},
        ]
        thread.start()
        try:
            until = time.monotonic() + 5
            while not server.started:
                assert thread.is_alive() and time.monotonic() < until, 'uvicorn did not start'
                time.sleep(0.02)
            asyncio.run(verifier.live('synthetic', ID, 'owner'))
        finally:
            server.should_exit = True
            thread.join(5)
            listener.close()
    assert not thread.is_alive()
    assert len(vertex.connections) == 2
