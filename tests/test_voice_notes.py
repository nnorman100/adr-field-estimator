"""Synthetic tests for offline voice notes: transcribed into the walkthrough, audio never stored."""

import base64
import json
from types import SimpleNamespace
import pytest
import backend.main as bm
from backend.inspection_store import DAILY_LIMITS
from tests.test_backend import context, data, ID

NOTE = 'b' * 32
# A minimal ISO-BMFF header as iPhone Safari records it; the provider is faked, so only the
# signature matters here.
MP4 = b'\x00\x00\x00\x18ftypM4A \x00\x00\x00\x00M4A mp42isom' + b'\x00' * 64


def note(**changes):
    return {
        'note_id': NOTE,
        'room': 'Bedroom 2',
        'recorded_at': '2026-10-16T21:05:00Z',
        'utc_offset_minutes': -420,
        'duration_seconds': 42.5,
        'mime_type': 'audio/mp4',
        'audio_base64': base64.b64encode(MP4).decode(),
        **changes,
    }


def transcriber(monkeypatch, text='Bedroom 2 category 1, 120 square feet of drywall.', fail=False):
    calls = []

    async def respond(**kwargs):
        calls.append(kwargs)
        if fail:
            raise RuntimeError('provider down')
        return SimpleNamespace(text=json.dumps(dict(text=text)))

    monkeypatch.setattr(
        bm,
        'get_ai_client',
        lambda: SimpleNamespace(
            aio=SimpleNamespace(models=SimpleNamespace(generate_content=respond))
        ),
    )
    return calls


def prepared(client, **extra):
    return client.post('/api/inspections', json={'inspection_id': ID, 'data': data(**extra)}).json()


def send(client, body=None):
    return client.post('/api/inspections/' + ID + '/voice-notes', json=body or note())


def test_voice_note_is_transcribed_into_the_walkthrough_and_audio_is_not_stored(
    context, monkeypatch
):
    client, store = context
    record = prepared(client, technician_transcript='Kitchen category 1.')
    calls = transcriber(monkeypatch)
    result = send(client)
    assert result.status_code == 200, result.text
    saved = result.json()
    assert saved['revision'] == record['revision'] + 1 and saved['status'] == 'draft'
    assert saved['data']['technician_transcript'] == (
        'Kitchen category 1.\n'
        '[Offline voice note bbbbbbbb · Bedroom 2 · recorded Oct 16, 2:05 PM · transcribed later]\n'
        'Bedroom 2 category 1, 120 square feet of drywall.\n'
    )
    # Every other field is untouched, and nothing was written to the evidence bucket.
    assert {k: v for k, v in saved['data'].items() if k != 'technician_transcript'} == {
        k: v for k, v in record['data'].items() if k != 'technician_transcript'
    }
    assert store.bucket.objects == {}
    assert 'audio' not in json.dumps(store.get_inspection('owner', ID))
    [call] = calls
    audio, prompt = call['contents']
    assert audio.inline_data.mime_type == 'audio/mp4' and audio.inline_data.data == MP4
    assert prompt == bm.TRANSCRIBE_INSTRUCTIONS
    assert call['config'].response_schema is bm.TranscriptionResult
    assert call['config'].thinking_config.thinking_level == bm.SCOPE_THINKING_LEVEL
    assert result.headers['Cache-Control'] == 'private, no-store'


def test_retried_voice_note_is_not_transcribed_or_appended_twice(context, monkeypatch):
    client, store = context
    prepared(client)
    calls = transcriber(monkeypatch)
    first = send(client).json()
    second = send(client)
    assert second.status_code == 200
    assert second.json() == first
    assert len(calls) == 1


def test_voice_note_appends_after_the_revision_moved_on(context, monkeypatch):
    # A finished OCR raises the revision while the note uploads; an append is still safe.
    client, store = context
    prepared(client)
    client.put(
        '/api/inspections/' + ID,
        json={'expected_revision': 1, 'data': data(labor_hours=5)},
    )
    transcriber(monkeypatch)
    saved = send(client).json()
    assert saved['revision'] == 3
    assert saved['data']['labor_hours'] == 5
    assert saved['data']['technician_transcript'].startswith('[Offline voice note bbbbbbbb')


def test_silent_voice_note_is_still_marked_processed(context, monkeypatch):
    client, store = context
    prepared(client)
    transcriber(monkeypatch, text='  ')
    saved = send(client, note(room='')).json()
    assert saved['data']['technician_transcript'] == (
        '[Offline voice note bbbbbbbb · no room chosen · recorded Oct 16, 2:05 PM · '
        'transcribed later]\n(No speech recognized.)\n'
    )


@pytest.mark.parametrize(
    'changes',
    [
        dict(mime_type='audio/webm'),
        dict(audio_base64=base64.b64encode(b'not audio at all').decode()),
        dict(audio_base64='!!!'),
        dict(mime_type='audio/mpeg'),
        dict(note_id='not-a-note'),
        dict(duration_seconds=900),
        dict(room='x' * 101),
    ],
)
def test_invalid_voice_notes_are_refused_without_a_model_call(context, monkeypatch, changes):
    client, store = context
    record = prepared(client)
    calls = transcriber(monkeypatch)
    assert send(client, note(**changes)).status_code in (400, 422)
    assert calls == []
    assert bm.public_record(store.get_inspection('owner', ID)) == record


def test_oversized_voice_note_is_refused(context, monkeypatch):
    client, store = context
    prepared(client)
    calls = transcriber(monkeypatch)
    big = MP4 + b'\x00' * (bm.VOICE_NOTE_BYTES)
    assert send(client, note(audio_base64=base64.b64encode(big).decode())).status_code in (
        400,
        413,
        422,
    )
    assert calls == []


def test_provider_failure_leaves_the_transcript_unchanged(context, monkeypatch):
    client, store = context
    record = prepared(client)
    transcriber(monkeypatch, fail=True)
    assert send(client).status_code == 502
    assert bm.public_record(store.get_inspection('owner', ID)) == record


def test_full_transcript_refuses_the_note(context, monkeypatch):
    client, store = context
    prepared(client, technician_transcript='x' * 79990)
    transcriber(monkeypatch)
    result = send(client)
    assert result.status_code == 400
    assert 'Transcript storage is full' in result.json()['detail']


def test_signed_or_foreign_inspections_refuse_voice_notes(context, monkeypatch):
    client, store = context
    prepared(client)
    calls = transcriber(monkeypatch)
    store.db.records['inspections/' + ID]['status'] = 'signed'
    assert send(client).status_code == 409
    store.db.records['inspections/' + ID]['status'] = 'draft'
    store.db.records['inspections/' + ID]['owner_uid'] = 'someone-else'
    assert send(client).status_code == 404
    assert calls == []


def test_voice_notes_have_a_daily_cap_and_a_per_minute_limit(context, monkeypatch):
    client, store = context
    assert DAILY_LIMITS['transcribe'] == 200
    prepared(client)
    transcriber(monkeypatch)
    for i in range(10):
        assert send(client, note(note_id=str(i) * 32)).status_code == 200
    limited = send(client, note(note_id='c' * 32))
    assert limited.status_code == 429 and limited.headers['Retry-After']
