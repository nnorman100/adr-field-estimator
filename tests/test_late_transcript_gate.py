"""A transcript that arrives after a voice note was resolved must be reviewed before money moves."""

import json
from types import SimpleNamespace
import backend.main as bm
from tests.test_backend import audit, context, sign_payload, ID
from tests.test_voice_note_gate import (
    HOLD,
    audit_at,
    pending,
    reconfirm,
    resolve,
    review,
)
from tests.test_voice_notes import NOTE, prepared, send, transcriber

SIGNING_HOLD = 'Finish voice notes and review their transcripts before signing.'
LATE = 'Late water in the closet.'


def mint(client, record):
    return client.post(
        '/api/inspections/' + ID + '/signing-links',
        json=dict(
            expected_revision=record['revision'],
            proposal_hash=record['audit']['proposal_hash'],
        ),
        headers={'Origin': bm.ORIGINS[0]},
    )


def authorize(client, record):
    return client.post('/api/authorize', json=sign_payload(record))


def assert_blocked(client, current, signed_against):
    refused = audit_at(client, current)
    assert refused.status_code == 409 and HOLD in refused.json()['detail']
    scope = client.post(
        '/api/inspections/' + ID + '/scope-suggestions',
        json={'inspection_id': ID, 'expected_revision': current['revision']},
    )
    assert scope.status_code == 409 and HOLD in scope.json()['detail']
    signed = authorize(client, signed_against)
    assert signed.status_code == 409 and SIGNING_HOLD in signed.json()['detail']
    link = mint(client, signed_against)
    assert link.status_code == 409 and SIGNING_HOLD in link.json()['detail']
    assert client.get('/api/inspections/' + ID).json()['status'] != 'signed'


def test_late_transcript_on_a_resolved_note_blocks_until_it_is_reviewed(context, monkeypatch):
    client, _store = context
    audit_model = bm.get_ai_client
    prepared(client)
    assert pending(client).status_code == 200
    cleared = resolve(client)
    assert cleared.status_code == 200, cleared.text
    audited = audit(client, reconfirm(client, cleared.json()))
    transcriber(monkeypatch, text=LATE)
    landed = send(client)
    assert landed.status_code == 200, landed.text
    body = landed.json()
    assert LATE in body['data']['technician_transcript']
    assert_blocked(client, body, audited)

    reviewed = review(client)
    assert reviewed.status_code == 200, reviewed.text
    monkeypatch.setattr(bm, 'get_ai_client', audit_model)
    still_unconfirmed = audit_at(client, reviewed.json())
    assert still_unconfirmed.status_code == 400
    assert HOLD not in still_unconfirmed.json()['detail']
    confirmed = audit(client, reconfirm(client, reviewed.json()))
    assert confirmed['status'] == 'audited'
    assert mint(client, confirmed).status_code == 200


def test_repeated_transcript_on_a_reviewed_note_does_not_reblock(context, monkeypatch):
    client, _store = context
    audit_model = bm.get_ai_client
    prepared(client)
    transcriber(monkeypatch)
    assert send(client).status_code == 200
    reviewed = review(client)
    assert reviewed.status_code == 200, reviewed.text
    monkeypatch.setattr(bm, 'get_ai_client', audit_model)
    audited = audit(client, reconfirm(client, reviewed.json()))
    again = send(client)
    assert again.status_code == 200, again.text
    assert again.json()['revision'] == audited['revision']
    assert again.json()['data']['technician_transcript'] == audited['data']['technician_transcript']
    opened = audit_at(client, again.json())
    assert opened.status_code == 200, opened.text
    assert opened.json()['status'] == 'audited'
    assert mint(client, opened.json()).status_code == 200


def test_repeated_transcript_on_a_resolved_note_does_not_reblock(context, monkeypatch):
    client, _store = context
    marker = '[Offline voice note ' + NOTE[:8]
    prepared(
        client,
        technician_transcript=marker + ' · Room]\nAlready transcribed.\n',
    )
    assert pending(client).status_code == 200
    cleared = resolve(client)
    assert cleared.status_code == 200, cleared.text
    audited = audit(client, reconfirm(client, cleared.json()))
    calls = transcriber(monkeypatch)
    again = send(client)
    assert again.status_code == 200, again.text
    assert calls == []
    assert again.json()['revision'] == audited['revision']
    assert again.json()['data']['technician_transcript'].count(marker) == 1
    opened = audit_at(client, again.json())
    assert opened.status_code == 200, opened.text
    assert opened.json()['status'] == 'audited'
    assert authorize(client, opened.json()).status_code == 200


def test_resolving_during_transcription_still_blocks_when_the_transcript_lands(
    context, monkeypatch
):
    client, store = context
    audited = audit(client, prepared(client))
    late = 'Water appeared while the note was being transcribed.'

    async def respond(**_kwargs):
        store.update_voice_note('owner', ID, NOTE, 'resolve')
        return SimpleNamespace(text=json.dumps({'text': late}))

    monkeypatch.setattr(
        bm,
        'get_ai_client',
        lambda: SimpleNamespace(
            aio=SimpleNamespace(models=SimpleNamespace(generate_content=respond))
        ),
    )
    landed = send(client)
    assert landed.status_code == 200, landed.text
    body = landed.json()
    assert late in body['data']['technician_transcript']
    assert_blocked(client, body, audited)


def test_signing_recheck_blocks_a_note_that_reopens_during_authorization(context):
    client, store = context
    prepared(client)
    assert pending(client).status_code == 200
    cleared = resolve(client)
    assert cleared.status_code == 200, cleared.text
    audited = audit(client, reconfirm(client, cleared.json()))
    original = store.bucket.blob
    started_upload = False

    def blob(path):
        result = original(path)
        upload = result.upload_from_string

        def upload_and_reopen(*args, **kwargs):
            nonlocal started_upload
            upload(*args, **kwargs)
            if started_upload:
                return
            started_upload = True
            marker = bm.voice_note_marker(NOTE)
            store.append_transcript(
                'owner',
                ID,
                marker,
                marker
                + ' · Closet · recorded Oct 16, 2:05 PM · transcribed later]\n'
                + LATE
                + '\n',
                NOTE,
            )

        result.upload_from_string = upload_and_reopen
        return result

    store.bucket.blob = blob
    refused = authorize(client, audited)
    assert started_upload
    assert refused.status_code == 409 and SIGNING_HOLD in refused.json()['detail']
    saved = client.get('/api/inspections/' + ID).json()
    assert saved['status'] != 'signed'
    assert LATE in saved['data']['technician_transcript']
    again = authorize(client, audited)
    assert again.status_code == 409 and SIGNING_HOLD in again.json()['detail']
