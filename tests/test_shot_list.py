import json, shutil, subprocess, time
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
import backend.main as bm
from backend.claims import make_documents
from backend.contracts import AIResult, InspectionData, Room
from backend.live_support import scope_fingerprint
from backend.prompts import SHOT_STATUS_UPDATE, audit_prompt, live_prompt
from backend.shot_list import ROOM_FLAGS, SHOT_LIST, room_shot_status
from tests.fakes import FakeStore, FakeVertexLive, client_content, png
from tests.test_backend import context, data, inspect, audit, photo, sign_payload, ID
from tests.test_claims import photo as log_photo, scoped
from tests.test_live_reliability import pcm, wire_audio

ROOT = Path(__file__).resolve().parents[1]
PHOTO = 'b' * 32


@pytest.mark.skipif(not shutil.which('node'), reason='needs node')
def test_app_and_server_carry_the_same_shot_list():
    script = (
        "const c = require('./public/core.js');"
        'console.log(JSON.stringify({list: c.SHOT_LIST, flags: c.ROOM_SHOT_FLAGS}))'
    )
    shown = json.loads(
        subprocess.run(
            ['node', '-e', script], cwd=ROOT, capture_output=True, text=True, check=True
        ).stdout
    )
    assert shown['list'] == [{k: shot[k] for k in ('id', 'label', 'when')} for shot in SHOT_LIST]
    assert shown['flags'] == ROOM_FLAGS
    # Every conditional shot names a room answer the app can set.
    assert {shot['when'] for shot in SHOT_LIST} - {None} == set(ROOM_FLAGS)
    assert set(ROOM_FLAGS) <= set(Room.model_fields)


def test_shot_status_counts_only_tagged_photos_for_the_shots_each_room_needs():
    rooms = [
        {'name': 'Kitchen', 'source_of_loss': True, 'contents_present': False},
        {'name': 'Hall Bath', 'equipment_placed': True},
    ]
    photos = [
        {'room': ' kitchen ', 'shot': 'overview'},
        {'room': 'Kitchen', 'shot': 'source'},
        {'room': 'Kitchen', 'shot': 'contents'},
        {'room': 'Kitchen'},
        {'room': 'hall  bath', 'shot': 'equipment'},
    ]
    kitchen, hall = room_shot_status({'rooms': rooms}, photos)
    assert kitchen == {
        'room': 'Kitchen',
        'required': ['Room overview', 'Source of loss', 'Affected wall or floor', 'Meter reading'],
        'tagged': ['Room overview', 'Source of loss', 'Contents before moving'],
        'missing': ['Affected wall or floor', 'Meter reading'],
        'untagged_photos': 1,
    }
    assert hall['missing'] == ['Room overview', 'Affected wall or floor', 'Meter reading']
    assert hall['tagged'] == ['Equipment as placed'] and hall['untagged_photos'] == 0
    # Photos saved before the shot list existed have no tag and count toward nothing.
    assert room_shot_status({'rooms': rooms[:1]}, [{'room': 'Kitchen'}])[0]['tagged'] == []


def test_tagging_a_photo_saves_its_shot_type_and_invalidates_the_audit(context):
    client, _ = context
    photo(client, inspect(client))
    record = audit(client, client.post(f'/api/inspections/{ID}/photos/{PHOTO}/ocr', json={}).json())
    assert 'shot' not in record['photos'][0]
    path = '/api/inspections/' + ID + '/photos/' + PHOTO + '/shot'
    tagged = client.put(path, json={'expected_revision': record['revision'], 'shot': 'meter'})
    assert tagged.status_code == 200, tagged.text
    tagged = tagged.json()
    assert tagged['photos'][0]['shot'] == 'meter'
    assert tagged['photos'][0]['file'] == record['photos'][0]['file']
    assert tagged['revision'] == record['revision'] + 1 and tagged['audit'] is None
    # The same tag again changes nothing; unknown shot types, stale revisions and photos are refused.
    again = client.put(path, json={'expected_revision': tagged['revision'], 'shot': 'meter'})
    assert again.json()['revision'] == tagged['revision']
    bad = client.put(path, json={'expected_revision': tagged['revision'], 'shot': 'selfie'})
    assert bad.status_code == 422
    assert client.put(path, json={'expected_revision': 1, 'shot': 'overview'}).status_code == 409
    missing = path.replace(PHOTO, 'c' * 32)
    assert (
        client.put(missing, json={'expected_revision': tagged['revision'], 'shot': 'overview'})
    ).status_code == 404
    # Clearing the tag leaves no key, so the photo reads like one saved before the shot list.
    cleared = client.put(path, json={'expected_revision': tagged['revision'], 'shot': None})
    assert cleared.status_code == 200 and 'shot' not in cleared.json()['photos'][0]
    record = client.put(
        path, json={'expected_revision': cleared.json()['revision'], 'shot': 'overview'}
    ).json()
    # Missing shots never block signing; the tagged photo log is signed and then immutable.
    signed = audit(client, record)
    assert signed['audit']['documents']['signable'] is True
    log = signed['audit']['documents']['photo_audit_log']
    assert log[0]['shot'] == 'overview' and log[0]['shot_label'] == 'Room overview'
    assert client.post('/api/authorize', json=sign_payload(signed)).status_code == 200
    after = client.get('/api/inspections/' + ID).json()
    locked = client.put(path, json={'expected_revision': after['revision'], 'shot': 'meter'})
    assert locked.status_code == 409
    assert client.get('/api/inspections/' + ID).json()['photos'][0]['shot'] == 'overview'


def test_room_shot_answers_save_only_when_set(context):
    client, _ = context
    record = inspect(client)
    assert not set(ROOM_FLAGS) & set(record['data']['rooms'][0])
    answered = json.loads(json.dumps(record['data']))
    answered['rooms'][0].update(source_of_loss=True, contents_present=False)
    saved = client.put(
        '/api/inspections/' + ID, json={'expected_revision': record['revision'], 'data': answered}
    ).json()
    # The server echoes exactly what the app sent, so a reload never reads as a conflict.
    assert saved['data'] == answered and 'equipment_placed' not in saved['data']['rooms'][0]
    answered['rooms'][0]['contents_present'] = 'maybe'
    assert (
        client.put(
            '/api/inspections/' + ID,
            json={'expected_revision': saved['revision'], 'data': answered},
        ).status_code
        == 422
    )


def test_room_shot_answers_change_neither_pricing_nor_the_live_scope():
    plain = scoped()
    answered = scoped(rooms=[{'name': 'Bathroom', 'finished_sf': 10, 'source_of_loss': True}])
    ai = AIResult(summary='Reviewed', suggestions=[], unpriced_work=[])
    before, after = make_documents(plain, [], ai), make_documents(answered, [], ai)
    for docs in (before, after):
        docs['adr_estimate'].pop('date')
    assert before == after
    a = plain.model_dump(mode='json')
    b = answered.model_dump(mode='json')
    # A walkthrough is not restarted for a room answer; Live hears it in a shot status update.
    assert scope_fingerprint(a) == scope_fingerprint(b)
    assert scope_fingerprint(a) != scope_fingerprint(
        {**b, 'rooms': [{**b['rooms'][0], 'name': 'X'}]}
    )


def test_photo_log_carries_the_shot_type_only_for_tagged_photos():
    ai = AIResult(summary='Reviewed', suggestions=[], unpriced_work=[])
    photos = [
        {**log_photo('a' * 32, 'Bathroom'), 'shot': 'overview'},
        log_photo('b' * 32, 'Bathroom', '31.4% WME'),
        {**log_photo('c' * 32, 'Bathroom', '18.0% WME'), 'shot': 'meter'},
    ]
    docs = make_documents(scoped(), photos, ai)
    log = docs['photo_audit_log']
    assert [(p.get('shot'), p.get('shot_label')) for p in log] == [
        ('overview', 'Room overview'),
        (None, None),
        ('meter', 'Meter reading'),
    ]
    assert 'shot' not in log[1] and 'shot_label' not in log[1]
    # The log keeps photo order, so the findings' photo numbers are unchanged by tags.
    assert [p['id'] for p in log] == ['a' * 32, 'b' * 32, 'c' * 32]
    untagged = make_documents(scoped(), [{**p, 'shot': None} for p in photos], ai)
    assert docs['adr_estimate']['findings'] == untagged['adr_estimate']['findings']
    assert docs['iicrc_defense_letter'] == untagged['iicrc_defense_letter']


def test_live_prompt_coaches_the_shot_list_from_tagged_photos_only():
    payload = InspectionData(rooms=[{'name': 'Kitchen', 'source_of_loss': True}]).model_dump(
        mode='json'
    )
    photos = [{'room': 'Kitchen', 'shot': 'overview'}, {'room': 'Kitchen'}]
    prompt = live_prompt(payload, None, photos)
    instructions, rest = prompt.split('\nCurrent inspection context (JSON):\n')
    context_json, status = rest.split('\nPhoto shot status at walkthrough start (JSON):\n')
    assert json.loads(context_json) == payload
    assert json.loads(status) == room_shot_status(payload, photos)
    assert 'PHOTO SHOT LIST' in instructions
    for shot in SHOT_LIST:
        assert shot['label'] in instructions and shot['ask'] in instructions
    assert (
        'Never say a shot is taken, tagged or complete unless the latest photo shot status lists it as tagged for that room'
        in instructions
    )
    assert (
        "Before moving on to another room, ask for that room's missing photo shots" in instructions
    )
    assert 'untagged photos count toward no shot' in instructions
    assert 'Missing shots do not block signing' in instructions
    # The shot list sits inside the instructions, before the inspection data boundary.
    assert instructions.index('PHOTO SHOT LIST') < instructions.index('DATA BOUNDARY')
    audit_photo = {'id': 'x', 'room': 'Kitchen', 'shot': 'meter', 'ocr_status': 'no_meter'}
    evidence = audit_prompt({**payload, 'year_built': 1990}, [audit_photo], []).split(
        '\nInspection evidence (JSON):\n'
    )[1]
    assert json.loads(evidence)['photo_log'][0]['shot'] == 'meter'


def test_live_relay_reports_saved_shot_tags_between_replies(monkeypatch, tmp_path):
    store = FakeStore()
    store.create_inspection(
        'owner', ID, InspectionData(rooms=[{'name': 'Kitchen'}]).model_dump(mode='json')
    )
    record = store.add_photo(
        'owner',
        ID,
        dict(
            photo_id=PHOTO,
            expected_revision=1,
            room='Kitchen',
            captured_at='2026-10-21T19:00:00Z',
            data_url=png(),
        ),
    )

    async def identity(token, **_):
        return {'uid': 'owner', 'exp': time.time() + 600}

    monkeypatch.setattr(bm, 'verify_staff', identity)
    monkeypatch.setattr(bm, 'get_job_store', lambda: store)

    def updates(connection):
        sent = [client_content(m) for m in connection['received'] if client_content(m)]
        return [c for c in sent if c['turns'][0]['parts'][0]['text'].startswith(SHOT_STATUS_UPDATE)]

    def wait_for(connection, count):
        deadline = time.time() + 5
        while len(updates(connection)) < count and time.time() < deadline:
            time.sleep(0.02)
        return updates(connection)

    def status(update):
        return json.loads(update['turns'][0]['parts'][0]['text'][len(SHOT_STATUS_UPDATE) :])

    with FakeVertexLive(tmp_path) as vertex, TestClient(bm.app) as client:
        monkeypatch.setattr(bm.genai, 'Client', vertex.client(bm.genai.Client))
        vertex.replies['setup'] = [{'setupComplete': {}}]
        vertex.replies['client_content'] = [
            {'serverContent': {'turnComplete': True, 'interactionStatus': 'IDLE'}}
        ]
        with client.websocket_connect('/api/live', headers={'origin': bm.ORIGINS[0]}) as socket:
            socket.send_json(
                dict(
                    type='authenticate',
                    token='synthetic',
                    inspection_id=ID,
                    protocol_version=2,
                    capture_id='e' * 32,
                )
            )
            ready = socket.receive_json()
            assert ready['shot_updates'] is True
            assert socket.receive_json()['type'] == 'turn_complete'
            connection = vertex.connections[0]
            # The model is quiet, so a saved tag reaches it at once, read from the store.
            record = store.tag_photo_shot('owner', ID, record['revision'], PHOTO, 'overview')
            socket.send_json({'type': 'shots'})
            first = wait_for(connection, 1)
            assert len(first) == 1 and not first[0].get('turnComplete')
            assert status(first[0])[0]['tagged'] == ['Room overview']
            assert status(first[0])[0]['missing'] == ['Affected wall or floor', 'Meter reading']
            # While the model speaks, the update waits for its turn to end instead of cutting it off.
            vertex.replies['audio'] = [wire_audio('Now the meter reading, please.')]
            socket.send_json({'type': 'audio', 'data': pcm(3300)})
            assert [socket.receive_json()['type'] for _ in range(2)] == ['transcript', 'audio']
            store.tag_photo_shot('owner', ID, record['revision'], PHOTO, 'meter')
            # Past the relay's one-second spacing, so only the model's speech holds the update.
            time.sleep(1.1)
            socket.send_json({'type': 'shots'})
            vertex.replies['audio'] = [
                {'serverContent': {'turnComplete': True, 'interactionStatus': 'IDLE'}}
            ]
            socket.send_json({'type': 'audio', 'data': pcm(0)})
            assert socket.receive_json()['type'] == 'turn_complete'
            second = wait_for(connection, 2)
            assert len(second) == 2 and status(second[1])[0]['tagged'] == ['Meter reading']
            kinds = [
                'update' if m.get('clientContent', m.get('client_content')) in second else 'other'
                for m in connection['received']
            ]
            audio_at = [
                i
                for i, m in enumerate(connection['received'])
                if (m.get('realtimeInput') or m.get('realtime_input') or {}).get('audio')
            ]
            assert kinds.index('update', kinds.index('update') + 1) > audio_at[-1]
            socket.send_json({'type': 'end'})
            assert socket.receive_json()['type'] == 'finished'
