"""Structured Cloud Logging lines for provider calls and Live sessions carry no customer content."""

import asyncio, json, time
from contextlib import asynccontextmanager
from types import SimpleNamespace as NS
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from google.genai import errors
import backend.main as bm
from backend.contracts import InspectionData
from tests.fakes import FakeStore, Blob, png
from tests.test_backend import context, inspect, audit, data, ID
from tests.test_scope import prepared, suggest, WORDS

EMAIL = 'owner@example.invalid'


def entries(capsys):
    return [
        json.loads(line) for line in capsys.readouterr().out.splitlines() if line.startswith('{')
    ]


def test_failing_provider_call_logs_error_class_and_no_sensitive_fields(
    context, monkeypatch, capsys
):
    client, _ = context
    prepared(client)

    async def rejected(**kwargs):
        raise errors.ClientError(
            429,
            {
                'error': {
                    'code': 429,
                    'status': 'RESOURCE_EXHAUSTED',
                    'message': f'Echo: {WORDS} {EMAIL}',
                }
            },
        )

    monkeypatch.setattr(
        bm, 'get_ai_client', lambda: NS(aio=NS(models=NS(generate_content=rejected)))
    )
    capsys.readouterr()
    assert suggest(client).status_code == 502
    output = capsys.readouterr().out
    [entry] = [
        e
        for e in map(json.loads, filter(lambda line: line.startswith('{'), output.splitlines()))
        if e['message'] == 'Vertex AI call'
    ]
    assert entry['severity'] == 'ERROR' and entry['message'] == 'Vertex AI call'
    assert (
        entry['operation'] == 'scope'
        and entry['model'] == bm.AUDIT_MODEL
        and entry['inspection_id'] == ID
    )
    assert (
        entry['outcome'] == 'ClientError'
        and entry['provider_status'] == 'RESOURCE_EXHAUSTED'
        and entry['provider_code'] == 429
    )
    assert isinstance(entry['elapsed_ms'], int)
    assert set(entry) == {
        'severity',
        'message',
        'model',
        'operation',
        'elapsed_ms',
        'outcome',
        'provider_status',
        'provider_code',
        'inspection_id',
    }
    for secret in ('Echo', 'Bathroom', EMAIL, 'owner'):
        assert secret not in output


def test_successful_audit_logs_model_operation_and_inspection(context, capsys):
    client, _ = context
    record = inspect(client)
    capsys.readouterr()
    audit(client, record)
    [entry] = [e for e in entries(capsys) if e['message'] == 'Vertex AI call']
    assert (
        entry['severity'] == 'INFO'
        and entry['outcome'] == 'ok'
        and entry['operation'] == 'audit'
        and entry['inspection_id'] == ID
    )


def test_live_session_end_logs_duration_outcome_and_usage(monkeypatch, capsys):
    store = FakeStore()
    store.create_inspection('owner', ID, InspectionData().model_dump())

    class Session:
        def __init__(self):
            self.queue = asyncio.Queue()

        async def send_realtime_input(self, **kw):
            if 'audio' in kw:
                await self.queue.put(
                    NS(
                        server_content=NS(
                            interrupted=False,
                            input_transcription=NS(text='private observation', finished=True),
                            output_transcription=None,
                            model_turn=None,
                            turn_complete=False,
                        ),
                        usage_metadata=NS(total_token_count=321),
                    )
                )

        async def receive(self):
            yield await self.queue.get()

    @asynccontextmanager
    async def connect(**kw):
        yield Session()

    async def close():
        pass

    async def identity(token, **_):
        return {'uid': 'owner', 'email': EMAIL, 'exp': time.time() + 600}

    monkeypatch.setattr(bm, 'verify_staff', identity)
    monkeypatch.setattr(bm, 'get_job_store', lambda: store)
    monkeypatch.setattr(
        bm.genai, 'Client', lambda **kw: NS(aio=NS(live=NS(connect=connect), aclose=close))
    )
    with (
        TestClient(bm.app) as client,
        client.websocket_connect('/api/live', headers={'origin': bm.ORIGINS[0]}) as socket,
    ):
        socket.send_json(
            dict(
                type='authenticate',
                token='secret-id-token',
                inspection_id=ID,
                protocol_version=2,
                capture_id='e' * 32,
            )
        )
        assert socket.receive_json()['type'] == 'ready'
        socket.send_json({'type': 'audio', 'data': 'AAAAAA=='})
        while socket.receive_json()['type'] != 'transcript':
            pass
        socket.send_json({'type': 'end'})
        while socket.receive_json()['type'] != 'finished':
            pass
        with pytest.raises(WebSocketDisconnect):
            while True:
                socket.receive_json()
    output = capsys.readouterr().out
    [entry] = [
        json.loads(line)
        for line in output.splitlines()
        if line.startswith('{') and '"live"' in line
    ]
    assert (
        entry['message'] == 'Live session ended'
        and entry['outcome'] == 'finished'
        and entry['total_tokens'] == 321
    )
    assert (
        entry['model'] == bm.LIVE_MODEL
        and entry['inspection_id'] == ID
        and isinstance(entry['duration_ms'], int)
    )
    for secret in ('secret-id-token', 'private observation', EMAIL):
        assert secret not in output


def test_failed_upload_cleanup_logs_operation_and_error_class_without_uid_or_path(
    monkeypatch, capsys, caplog
):
    store = FakeStore()
    store.create_inspection('uid-7f3a', ID, data())

    def lost(*args):
        raise RuntimeError('Commit response lost.')

    def refused(blob, **kwargs):
        raise PermissionError(f'403 DELETE gs://evidence/{blob.name}')

    monkeypatch.setattr(store, '_change', lost)
    monkeypatch.setattr(Blob, 'delete', refused)
    capsys.readouterr()
    with pytest.raises(RuntimeError):
        store.add_photo(
            'uid-7f3a',
            ID,
            dict(
                expected_revision=1,
                photo_id='b' * 32,
                room='Bathroom',
                captured_at='2026-10-06T19:00:00Z',
                data_url=png(),
            ),
        )
    captured = capsys.readouterr()
    output = captured.out + captured.err + caplog.text
    [entry] = [json.loads(line) for line in captured.out.splitlines() if line.startswith('{')]
    assert entry == {
        'severity': 'ERROR',
        'message': 'Upload cleanup could not be confirmed; private object retained',
        'operation': 'upload_cleanup',
        'outcome': 'PermissionError',
    }
    for secret in ('uid-7f3a', 'users/', 'gs://'):
        assert secret not in output
