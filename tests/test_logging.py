"""Structured Cloud Logging lines for provider calls and Live sessions carry no customer content."""

import asyncio, json, time
from contextlib import asynccontextmanager
from types import SimpleNamespace as NS
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from google.genai import errors
from websockets.exceptions import ConnectionClosedError
from websockets.frames import Close
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


def test_draft_save_logs_revision_and_changed_field_names_never_values(context, capsys):
    client, _ = context
    record = inspect(client)
    secrets = [
        'Synthetic 4417 Larkspur Ct',
        'Homeowner Quill reported a burst supply line',
        'Zephyr den',
    ]
    changed = {
        **data(),
        'address': secrets[0],
        'technician_notes': secrets[1],
        'rooms': [{'name': secrets[2], 'category': 2, 'finished_sf': 10}],
        'dehumidifiers': 7,
        'scope_confirmed': False,
    }
    capsys.readouterr()
    for body in (changed, changed):
        r = client.put(
            '/api/inspections/' + ID,
            json={'expected_revision': record['revision'], 'data': body},
        )
        assert r.status_code == 200, r.text
        record = r.json()
    output = capsys.readouterr().out
    first, repeat = [
        e
        for e in map(json.loads, filter(lambda line: line.startswith('{'), output.splitlines()))
        if e['message'] == 'Inspection saved'
    ]
    assert first == {
        'severity': 'INFO',
        'message': 'Inspection saved',
        'operation': 'save',
        'inspection_id': ID,
        'revision': 2,
        'changed_fields': [
            'address',
            'dehumidifiers',
            'rooms',
            'scope_confirmed',
            'technician_notes',
        ],
    }
    # An unchanged save keeps its revision and names no field.
    assert repeat['revision'] == 2 and repeat['changed_fields'] == []
    for secret in secrets + ['Larkspur', 'Quill', 'Zephyr', 'owner']:
        assert secret not in output
    assert '7' not in json.dumps({k: v for k, v in first.items() if k != 'inspection_id'})


def test_creation_logs_fields_set_from_empty_default_never_values(context, capsys):
    client, _ = context
    secrets = [
        'Synthetic 9083 Wrenfield Way',
        'Owner Thistle saw water under the sink',
        'Juniper nook',
    ]
    body = {
        'inspection_id': ID,
        'data': {
            'address': secrets[0],
            'technician_notes': secrets[1],
            'rooms': [{'name': secrets[2], 'category': 2, 'finished_sf': 10}],
            'dehumidifiers': 7,
            'drying_days': 3,
        },
    }
    capsys.readouterr()
    for _ in range(2):
        r = client.post('/api/inspections', json=body)
        assert r.status_code == 200, r.text
    output = capsys.readouterr().out
    created, replay = [
        e
        for e in map(json.loads, filter(lambda line: line.startswith('{'), output.splitlines()))
        if e['message'] == 'Inspection saved'
    ]
    assert created == {
        'severity': 'INFO',
        'message': 'Inspection saved',
        'operation': 'save',
        'inspection_id': ID,
        'revision': 1,
        'changed_fields': ['address', 'dehumidifiers', 'rooms', 'technician_notes'],
    }
    # A retried creation of the same draft commits nothing new.
    assert replay['revision'] == 1 and replay['changed_fields'] == []
    for secret in secrets + ['Wrenfield', 'Thistle', 'Juniper', 'owner']:
        assert secret not in output
    assert '7' not in json.dumps({k: v for k, v in created.items() if k != 'inspection_id'})


def test_live_session_end_logs_duration_outcome_and_usage(monkeypatch, capsys):
    store = FakeStore()
    store.create_inspection('owner', ID, InspectionData().model_dump())

    class Session:
        def __init__(self):
            self.queue = asyncio.Queue()

        async def send_client_content(self, **kw):
            pass

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


@pytest.mark.parametrize(
    'failure, outcome, provider_code',
    [
        # Vertex closed the Live socket: its close code is the provider code.
        (
            ConnectionClosedError(Close(1011, 'internal error'), None, None),
            'ConnectionClosedError',
            1011,
        ),
        # The SDK closed it (for example its own keepalive timeout) or the link dropped: no frame, 1006.
        (
            ConnectionClosedError(None, Close(1011, 'keepalive ping timeout'), None),
            'ConnectionClosedError',
            1006,
        ),
        # google-genai 2.29 turns a close seen while receiving into an API error carrying the code.
        (errors.APIError(1008, {'error': {'message': 'policy violation'}}, None), 'APIError', 1008),
    ],
)
def test_live_session_end_logs_the_provider_close_code(
    monkeypatch, capsys, failure, outcome, provider_code
):
    store = FakeStore()
    store.create_inspection('owner', ID, InspectionData().model_dump())

    class Session:
        async def send_client_content(self, **kw):
            pass

        async def send_realtime_input(self, **kw):
            pass

        async def receive(self):
            raise failure
            yield  # pragma: no cover - keeps receive() an async generator like the SDK's

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
        message = socket.receive_json()
        assert message['type'] == 'error' and 'status' not in message
        assert message['message'].startswith('Live coaching disconnected.')
        with pytest.raises(WebSocketDisconnect):
            while True:
                socket.receive_json()
    output = capsys.readouterr().out
    [entry] = [
        json.loads(line)
        for line in output.splitlines()
        if line.startswith('{') and '"live"' in line
    ]
    assert entry['message'] == 'Live session ended' and entry['severity'] == 'WARNING'
    assert entry['outcome'] == outcome and entry['provider_code'] == provider_code
    for secret in (
        'secret-id-token',
        'internal error',
        'keepalive ping timeout',
        'policy violation',
    ):
        assert secret not in output
