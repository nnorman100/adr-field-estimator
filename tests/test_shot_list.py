import json, shutil, subprocess, time
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
import backend.main as bm
from backend.claims import make_documents
from backend.contracts import AIResult, InspectionData, Room
from backend.live_support import scope_fingerprint
from backend.prompts import SHOT_STATUS_UPDATE, live_prompt, prompt_inspection
from backend.shot_list import ROOM_COUNTS, ROOM_FIELDS, ROOM_FLAGS, SHOT_LIST, room_shot_status
from tests.fakes import FakeStore, FakeVertexLive, client_content, png
from tests.test_backend import context, data, inspect, audit, photo, sign_payload, ID
from tests.test_claims import scoped
from tests.test_live_reliability import pcm, wire_audio

ROOT = Path(__file__).resolve().parents[1]
PHOTO = 'b' * 32


@pytest.mark.skipif(not shutil.which('node'), reason='needs node')
def test_app_and_server_carry_the_same_shot_list():
    script = (
        "const c = require('./public/core.js');"
        'console.log(JSON.stringify('
        '{list: c.SHOT_LIST, flags: c.ROOM_SHOT_FLAGS, counts: c.ROOM_SHOT_COUNTS}))'
    )
    shown = json.loads(
        subprocess.run(
            ['node', '-e', script], cwd=ROOT, capture_output=True, text=True, check=True
        ).stdout
    )
    assert shown['list'] == [
        {k: shot[k] for k in ('id', 'label', 'when', 'per')} for shot in SHOT_LIST
    ]
    assert shown['flags'] == ROOM_FLAGS and shown['counts'] == ROOM_COUNTS
    # Every conditional or counted shot names a room answer the app can set.
    assert {shot['when'] for shot in SHOT_LIST} - {None} == set(ROOM_FLAGS)
    assert {shot['per'] for shot in SHOT_LIST} - {None} == set(ROOM_COUNTS)
    assert set(ROOM_FIELDS) <= set(Room.model_fields)


def test_shot_status_counts_only_tagged_photos_for_the_shots_each_room_needs():
    rooms = [
        {
            'name': 'Kitchen',
            'source_of_loss': True,
            'contents_present': False,
            'affected_surfaces': 1,
            'wet_materials': 1,
        },
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
    one = lambda *labels: [{'shot': label, 'photos_needed': 1} for label in labels]
    assert kitchen == {
        'room': 'Kitchen',
        'required': one(
            'Room overview', 'Source of loss', 'Affected wall or floor', 'Meter reading'
        ),
        'tagged': [
            {'shot': 'Room overview', 'photos': 1},
            {'shot': 'Source of loss', 'photos': 1},
            {'shot': 'Contents before moving', 'photos': 1},
        ],
        'missing': [
            {'shot': 'Affected wall or floor', 'photos_missing': 1},
            {'shot': 'Meter reading', 'photos_missing': 1},
        ],
        'counts_not_set': [],
        'untagged_photos': 1,
    }
    assert [m['shot'] for m in hall['missing']] == [
        'Room overview',
        'Affected wall or floor',
        'Meter reading',
    ]
    assert hall['tagged'] == [{'shot': 'Equipment as placed', 'photos': 1}]
    assert hall['untagged_photos'] == 0
    # Unset counts still ask for one photo each and are named so Live asks for them.
    assert hall['counts_not_set'] == ['Affected walls or floors', 'Wet materials']
    # Photos saved before the shot list existed have no tag and count toward nothing.
    assert room_shot_status({'rooms': rooms[:1]}, [{'room': 'Kitchen'}])[0]['tagged'] == []


def test_counted_shots_need_one_tagged_photo_per_surface_or_wet_material():
    room = {'name': 'Kitchen', 'affected_surfaces': 3, 'wet_materials': 0}
    photos = [{'room': 'Kitchen', 'shot': 'surface'}, {'room': 'Kitchen', 'shot': 'overview'}]
    (status,) = room_shot_status({'rooms': [room]}, photos)
    # One wall photo no longer covers three walls, and no wet material asks for no meter shot.
    assert status['required'] == [
        {'shot': 'Room overview', 'photos_needed': 1},
        {'shot': 'Affected wall or floor', 'photos_needed': 3},
    ]
    assert status['missing'] == [{'shot': 'Affected wall or floor', 'photos_missing': 2}]
    assert status['tagged'][1] == {'shot': 'Affected wall or floor', 'photos': 1}
    photos += [{'room': 'Kitchen', 'shot': 'surface'}] * 2
    assert room_shot_status({'rooms': [room]}, photos)[0]['missing'] == []


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
    # Missing shots never block signing; once signed, the tag is immutable.
    signed = audit(client, record)
    assert signed['audit']['documents']['signable'] is True
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
    answered['rooms'][0].update(source_of_loss=True, contents_present=False, affected_surfaces=2)
    saved = client.put(
        '/api/inspections/' + ID, json={'expected_revision': record['revision'], 'data': answered}
    ).json()
    # The server echoes exactly what the app sent, so a reload never reads as a conflict.
    assert saved['data'] == answered
    assert not {'equipment_placed', 'wet_materials'} & set(saved['data']['rooms'][0])
    for key, value in [
        ('contents_present', 'maybe'),
        ('wet_materials', -1),
        ('wet_materials', 51),
        ('affected_surfaces', 1.5),
    ]:
        bad = json.loads(json.dumps(answered))
        bad['rooms'][0][key] = value
        assert (
            client.put(
                '/api/inspections/' + ID,
                json={'expected_revision': saved['revision'], 'data': bad},
            ).status_code
            == 422
        ), (key, value)


def test_room_shot_answers_change_neither_pricing_nor_the_live_scope():
    plain = scoped()
    answered = scoped(
        rooms=[
            {
                'name': 'Bathroom',
                'finished_sf': 10,
                'source_of_loss': True,
                'affected_surfaces': 2,
                'wet_materials': 3,
            }
        ]
    )
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


def test_live_prompt_coaches_the_shot_list_from_tagged_photos_only():
    payload = InspectionData(
        rooms=[{'name': 'Kitchen', 'source_of_loss': True, 'affected_surfaces': 2}]
    ).model_dump(mode='json')
    photos = [{'room': 'Kitchen', 'shot': 'overview'}, {'room': 'Kitchen'}]
    prompt = live_prompt(payload, None, photos=photos)
    instructions, rest = prompt.split('\nCurrent inspection context (JSON):\n')
    context_json, status = rest.split('\nPhoto shot status at walkthrough start (JSON):\n')
    assert json.loads(context_json) == prompt_inspection(payload)
    assert json.loads(status) == room_shot_status(payload, photos)
    assert 'PHOTO SHOT LIST' in instructions
    for shot in SHOT_LIST:
        assert shot['label'] in instructions and shot['ask'] in instructions
    assert 'never call a shot complete while that status lists it as missing' in instructions
    assert 'one tagged photo per affected wall or floor, or per wet material' in instructions
    assert '"Affected walls or floors", "Wet materials"' in instructions
    assert 'never count surfaces or materials from video' in instructions
    assert json.loads(status)[0]['counts_not_set'] == ['Wet materials']
    assert (
        "Before moving on to another room, ask for that room's missing photo shots" in instructions
    )
    assert 'untagged photos count toward no shot' in instructions
    assert 'Missing shots do not block signing' in instructions
    # The shot list sits inside the instructions, before the inspection data boundary.
    assert instructions.index('PHOTO SHOT LIST') < instructions.index('DATA BOUNDARY')


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
            assert status(first[0])[0]['tagged'] == [{'shot': 'Room overview', 'photos': 1}]
            assert [m['shot'] for m in status(first[0])[0]['missing']] == [
                'Affected wall or floor',
                'Meter reading',
            ]
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
            assert len(second) == 2
            assert status(second[1])[0]['tagged'] == [{'shot': 'Meter reading', 'photos': 1}]
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


def test_live_relay_holds_shot_updates_while_a_reply_is_expected(monkeypatch, tmp_path):
    store = FakeStore()
    store.create_inspection(
        'owner', ID, InspectionData(rooms=[{'name': 'Kitchen'}]).model_dump(mode='json')
    )

    async def identity(token, **_):
        return {'uid': 'owner', 'exp': time.time() + 600}

    monkeypatch.setattr(bm, 'verify_staff', identity)
    monkeypatch.setattr(bm, 'get_job_store', lambda: store)
    monkeypatch.setattr(bm, 'LIVE_REPLY_WAIT_SECONDS', 2.5)

    def updates(connection):
        sent = [client_content(m) for m in connection['received'] if client_content(m)]
        return [c for c in sent if c['turns'][0]['parts'][0]['text'].startswith(SHOT_STATUS_UPDATE)]

    def settle(connection, seconds):
        time.sleep(seconds)
        return len(updates(connection))

    with FakeVertexLive(tmp_path) as vertex, TestClient(bm.app) as client:
        monkeypatch.setattr(bm.genai, 'Client', vertex.client(bm.genai.Client))
        vertex.replies['setup'] = [{'setupComplete': {}}]
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
            assert socket.receive_json()['type'] == 'ready'
            connection = vertex.connections[0]
            # The greeting reply has not started speaking, so the update waits for it.
            socket.send_json({'type': 'shots'})
            assert settle(connection, 1.5) == 0
            # A reply that never comes holds the update only for the short bound.
            assert settle(connection, 2) == 1
            # Once the technician speaks, a reply is expected before any audio arrives.
            time.sleep(1.1)
            vertex.replies['audio'] = [
                {'serverContent': {'inputTranscription': {'text': 'What is next?'}}}
            ]
            socket.send_json({'type': 'audio', 'data': pcm(3300)})
            assert socket.receive_json()['type'] == 'transcript'
            socket.send_json({'type': 'shots'})
            assert settle(connection, 1.5) == 1
            vertex.replies['audio'] = [
                {'serverContent': {'turnComplete': True, 'interactionStatus': 'IDLE'}}
            ]
            socket.send_json({'type': 'audio', 'data': pcm(0)})
            assert socket.receive_json()['type'] == 'turn_complete'
            assert settle(connection, 0.5) == 2
            socket.send_json({'type': 'end'})
            assert socket.receive_json()['type'] == 'finished'
