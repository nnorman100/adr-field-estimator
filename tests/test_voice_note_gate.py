"""Voice notes must be transcribed and reviewed before an estimate is generated or signed."""

from tests.fakes import genai_models
import json
from types import SimpleNamespace
import backend.main as bm
from tests.test_backend import audit, context, inspect, sign_payload, ID
from tests.test_signing_links import mint
from tests.test_voice_notes import NOTE, prepared, send, transcriber


HOLD = 'Finish voice notes and review their transcripts before continuing.'


def pending(client, note_id=NOTE):
    return client.post('/api/inspections/' + ID + '/voice-notes/pending', json={'note_id': note_id})


def review(client, note_id=NOTE):
    return client.post('/api/inspections/' + ID + '/voice-notes/' + note_id + '/review')


def resolve(client, note_id=NOTE):
    return client.post('/api/inspections/' + ID + '/voice-notes/' + note_id + '/resolve')


def audit_at(client, record):
    return client.post(
        '/api/audit',
        json={'inspection_id': ID, 'expected_revision': record['revision']},
    )


def reconfirm(client, record):
    payload = dict(record['data'], scope_confirmed=True)
    saved = client.put(
        '/api/inspections/' + ID,
        json={'expected_revision': record['revision'], 'data': payload},
    )
    assert saved.status_code == 200, saved.text
    return saved.json()


def test_desk_estimate_without_voice_notes_still_audits(context):
    client, _store = context
    audited = audit(client, inspect(client))
    assert audited['status'] == 'audited'
    assert not audited.get('voice_notes')


def test_pending_failed_and_unreviewed_notes_block_the_estimate(context, monkeypatch):
    client, store = context
    audited = audit(client, prepared(client))
    link = mint(client, audited)
    assert link.status_code == 200, link.text
    reserved = pending(client)
    assert reserved.status_code == 200, reserved.text
    body = reserved.json()
    assert body['data']['scope_confirmed'] is False
    assert body['audit'] is None and body['revision'] == audited['revision'] + 1
    assert body['voice_notes'] == [{'id': NOTE, 'status': 'pending', 'reviewed': False}]
    assert client.get('/api/inspections/' + ID + '/signing-links').json()['status'] == 'revoked'
    assert audit_at(client, body).status_code == 409
    assert HOLD in audit_at(client, body).json()['detail']
    assert client.post('/api/authorize', json=sign_payload(audited)).status_code == 409
    assert mint(client, audited).status_code == 409
    # A second reserve is idempotent and does not move the revision again.
    again = pending(client)
    assert again.status_code == 200 and again.json()['revision'] == body['revision']
    failed = client.post(
        '/api/inspections/' + ID + '/voice-notes/' + NOTE + '/review',
    )
    assert failed.status_code == 409
    # The model is not called while the note is only reserved.
    audit_model = bm.get_ai_client
    calls = transcriber(monkeypatch, fail=True)
    assert send(client).status_code == 502 and calls
    saved = client.get('/api/inspections/' + ID).json()
    assert saved['voice_notes'] == [{'id': NOTE, 'status': 'failed', 'reviewed': False}]
    assert audit_at(client, saved).status_code == 409
    stored = json.dumps(saved)
    assert 'Bedroom 2 category' not in stored and 'ftyp' not in stored
    cleared = resolve(client)
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()['voice_notes'] == [{'id': NOTE, 'status': 'resolved', 'reviewed': False}]
    monkeypatch.setattr(bm, 'get_ai_client', audit_model)
    assert audit_at(client, cleared.json()).status_code == 400
    assert audit(client, reconfirm(client, cleared.json()))['status'] == 'audited'


def test_a_legacy_transcript_without_a_ledger_still_audits(context):
    client, _store = context
    record = prepared(
        client,
        technician_transcript='[Offline voice note '
        + NOTE[:8]
        + ' · Room]\nAlready transcribed.\n',
    )
    audited = audit(client, record)
    assert audited['status'] == 'audited' and not audited.get('voice_notes')
    reviewed = review(client)
    assert reviewed.status_code == 200, reviewed.text
    assert reviewed.json()['voice_notes'] == [
        {'id': NOTE, 'status': 'transcribed', 'reviewed': True}
    ]
    assert reviewed.json()['revision'] == audited['revision']
    assert reviewed.json()['audit']['revision'] == audited['revision']


def test_a_transcribed_note_blocks_until_its_transcript_is_reviewed(context, monkeypatch):
    client, _store = context
    prepared(client)
    reserved = pending(client).json()
    assert reserved['data']['scope_confirmed'] is False
    reconfirm(client, reserved)
    audit_model = bm.get_ai_client
    transcriber(monkeypatch)
    saved = send(client)
    assert saved.status_code == 200, saved.text
    record = saved.json()
    assert record['voice_notes'] == [{'id': NOTE, 'status': 'transcribed', 'reviewed': False}]
    refused = audit_at(client, record)
    assert refused.status_code == 409 and 'voice note' in refused.json()['detail']
    blocked = client.post(
        '/api/inspections/' + ID + '/signing-links',
        json=dict(expected_revision=record['revision'], proposal_hash='ab' * 32),
        headers={'Origin': bm.ORIGINS[0]},
    )
    assert blocked.status_code == 409
    reviewed = review(client)
    assert reviewed.status_code == 200, reviewed.text
    assert reviewed.json()['revision'] == record['revision']
    assert reviewed.json()['voice_notes'] == [
        {'id': NOTE, 'status': 'transcribed', 'reviewed': True}
    ]
    monkeypatch.setattr(bm, 'get_ai_client', audit_model)
    assert reviewed.json()['data']['scope_confirmed'] is False
    assert audit_at(client, reviewed.json()).status_code == 400
    confirmed = reconfirm(client, reviewed.json())
    assert audit(client, confirmed)['status'] == 'audited'
    assert review(client).json()['revision'] == confirmed['revision']


def test_transcription_failure_logs_no_transcript_or_audio(context, monkeypatch, capsys):
    secret = 'Bedroom 2 category 1 secret transcript'
    client, store = context
    prepared(client)

    async def respond(**_kwargs):
        raise RuntimeError(secret)

    monkeypatch.setattr(
        bm,
        'get_ai_client',
        lambda: SimpleNamespace(aio=SimpleNamespace(models=genai_models(respond))),
    )
    capsys.readouterr()
    assert send(client).status_code == 502
    output = capsys.readouterr().out
    assert secret not in output and 'ftyp' not in output
    saved = store.get_inspection('owner', ID)
    assert saved['voice_notes'] == [{'id': NOTE, 'status': 'failed', 'reviewed': False}]


def test_a_missing_note_cannot_be_resolved_or_reviewed(context):
    client, _store = context
    prepared(client)
    missing = 'd' * 32
    resolved = resolve(client, missing)
    assert resolved.status_code == 409 and 'not waiting' in resolved.json()['detail']
    reviewed = review(client, missing)
    assert reviewed.status_code == 409 and 'not waiting' in reviewed.json()['detail']
    assert 'voice_notes' not in client.get('/api/inspections/' + ID).json()


def test_empty_reserved_recording_can_be_explicitly_removed(context):
    client, _store = context
    prepared(client)
    assert pending(client).status_code == 200
    cleared = resolve(client)
    assert cleared.status_code == 200
    assert cleared.json()['voice_notes'][0]['status'] == 'resolved'
