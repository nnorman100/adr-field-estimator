"""Binary photo uploads and the full-size original that follows later (on Wi-Fi).

The phone uploads a copy of at most 2,560 px first, as a multipart binary body, and keeps the
original. The copy's upload records the original's hash; the original arrives later on its own
route, must match that hash, and is stored beside the copy without changing the job record.
"""

import hashlib, io, json
from copy import deepcopy
import pytest
from fastapi.testclient import TestClient
from google.api_core.exceptions import PreconditionFailed
from PIL import Image
import backend.main as bm
from backend.contracts import AIResult, InspectionData
from backend.inspection_store import Conflict
from backend.workspaces import AccessDenied, JobArchived
from tests.adr_pricing import make_documents
from tests.fakes import Blob, Bucket, FakeCompanyStore, FakeStore
from tests.test_backend import ID, context, data, sign_payload  # noqa: F401 (context is a fixture)
from tests.test_workspaces import data as company_data, seed

PHOTO = 'c' * 32


def jpeg(size, color='white'):
    output = io.BytesIO()
    Image.new('RGB', size, color).save(output, format='JPEG', quality=85)
    return output.getvalue()


ORIGINAL = jpeg((4032, 3024), 'gray')
COPY = jpeg((2560, 1920), 'gray')


def pending(raw=ORIGINAL, content_type='image/jpeg'):
    return {'sha256': hashlib.sha256(raw).hexdigest(), 'content_type': content_type}


def metadata(revision, **changes):
    fields = dict(
        expected_revision=revision,
        photo_id=PHOTO,
        room='Bathroom',
        captured_at='2026-10-06T19:00:00Z',
        original=pending(),
    )
    return {**fields, **changes}


def binary(client, revision, raw=COPY, content_type='image/jpeg', **changes):
    return client.post(
        '/api/inspections/' + ID + '/photos',
        files={
            'metadata': (None, json.dumps(metadata(revision, **changes)), 'application/json'),
            'file': ('photo.jpg', raw, content_type),
        },
    )


def send_original(client, raw=ORIGINAL, content_type='image/jpeg', photo_id=PHOTO):
    return client.post(
        f'/api/inspections/{ID}/photos/{photo_id}/original',
        content=raw,
        headers={'Content-Type': content_type},
    )


def originals(store):
    return {k: v for k, v in store.bucket.objects.items() if '/original-' in k}


def test_a_binary_upload_stores_the_copy_and_records_the_original_it_stands_for(context):
    client, store = context
    record = client.post('/api/inspections', json={'inspection_id': ID, 'data': data()}).json()
    r = binary(client, record['revision'])
    assert r.status_code == 200, r.text
    (photo,) = store.get_inspection('owner', ID)['photos']
    # The copy is the photo's evidence file; the original is only promised, by hash.
    assert store.bucket.objects[photo['file']['path']] == (COPY, 'image/jpeg')
    assert (photo['width'], photo['height']) == (2560, 1920)
    assert photo['original'] == pending()
    # The model copy is still made from the uploaded file, exactly as before.
    model_raw, _ = store.bucket.objects[photo['model_file']['path']]
    with Image.open(io.BytesIO(model_raw)) as image:
        assert image.size == (1600, 1200)
    assert not originals(store)
    # A retry of the same upload is accepted and changes nothing.
    assert binary(client, record['revision']).status_code == 200
    assert store.get_inspection('owner', ID)['photos'] == [photo]


def test_binary_uploads_keep_the_server_type_size_and_decode_checks(context):
    client, store = context
    record = client.post('/api/inspections', json={'inspection_id': ID, 'data': data()}).json()
    revision = record['revision']
    r = binary(client, revision, content_type='image/gif')
    assert r.status_code == 400 and 'JPEG, PNG or WebP' in r.json()['detail']
    r = binary(client, revision, content_type='image/png')
    assert r.status_code == 400 and 'does not match its file type' in r.json()['detail']
    r = binary(client, revision, raw=b'\xff\xd8\xff' + b'0' * (8 * 1024 * 1024))
    assert r.status_code == 400 and 'photo limit is 8 MB' in r.json()['detail']
    r = binary(client, revision, raw=COPY[:200])
    assert r.status_code == 400 and 'damaged' in r.json()['detail']
    r = client.post(
        '/api/inspections/' + ID + '/photos',
        files={'metadata': (None, json.dumps(metadata(revision)), 'application/json')},
    )
    assert r.status_code == 400
    r = binary(client, revision, room='')
    assert r.status_code == 422
    assert all('input' not in error for error in r.json()['detail'])
    r = binary(client, revision, original={'sha256': 'x', 'content_type': 'image/jpeg'})
    assert r.status_code == 422
    assert not store.bucket.objects
    assert store.get_inspection('owner', ID)['photos'] == []


def test_older_app_versions_still_upload_base64_json_and_promise_no_original(context):
    client, store = context
    record = client.post('/api/inspections', json={'inspection_id': ID, 'data': data()}).json()
    import base64

    r = client.post(
        '/api/inspections/' + ID + '/photos',
        json=dict(
            expected_revision=record['revision'],
            photo_id=PHOTO,
            room='Bathroom',
            captured_at='2026-10-06T19:00:00Z',
            data_url='data:image/jpeg;base64,' + base64.b64encode(ORIGINAL).decode(),
        ),
    )
    assert r.status_code == 200, r.text
    (photo,) = store.get_inspection('owner', ID)['photos']
    assert 'original' not in photo
    r = send_original(client)
    assert r.status_code == 409 and 'no full-size original' in r.json()['detail']


def test_a_photo_that_is_already_its_own_original_promises_nothing(context):
    client, store = context
    record = client.post('/api/inspections', json={'inspection_id': ID, 'data': data()}).json()
    r = binary(client, record['revision'], raw=ORIGINAL)
    assert r.status_code == 200, r.text
    assert 'original' not in store.get_inspection('owner', ID)['photos'][0]


def test_the_original_arrives_later_beside_the_copy_and_the_record_does_not_change(context):
    client, store = context
    record = client.post('/api/inspections', json={'inspection_id': ID, 'data': data()}).json()
    assert binary(client, record['revision']).status_code == 200
    before = deepcopy(store.get_inspection('owner', ID))
    r = send_original(client)
    assert r.status_code == 200, r.text
    assert r.json() == {'photo_id': PHOTO, 'original': 'stored'}
    ((path, stored),) = originals(store).items()
    assert stored == (ORIGINAL, 'image/jpeg')
    folder = before['photos'][0]['file']['path'].rpartition('/')[0]
    assert path == f'{folder}/original-{pending()["sha256"]}.jpeg'
    # Same revision, same audit, same documents: the original is evidence beside the job.
    assert store.get_inspection('owner', ID) == before
    # The evidence and model copies the app and the audit read are still the 2,560 px copy.
    photo, raw = store.photo('owner', ID, PHOTO)
    assert raw == COPY


def test_only_the_promised_original_is_accepted(context):
    client, store = context
    record = client.post('/api/inspections', json={'inspection_id': ID, 'data': data()}).json()
    assert binary(client, record['revision']).status_code == 200
    other = jpeg((4032, 3024), 'black')
    r = send_original(client, raw=other)
    assert r.status_code == 409 and 'not the original' in r.json()['detail']
    r = send_original(client, content_type='image/png')
    assert r.status_code == 400
    r = send_original(client, content_type='image/gif')
    assert r.status_code == 400
    r = send_original(client, photo_id='d' * 32)
    assert r.status_code == 404
    r = send_original(client, raw=b'\xff\xd8\xff' + b'0' * (8 * 1024 * 1024))
    assert r.status_code == 413
    assert not originals(store)


def test_a_retried_original_that_is_already_stored_succeeds():
    class ExistingBlob(Blob):
        def upload_from_string(self, raw, content_type, **kwargs):
            if kwargs.get('if_generation_match') == 0 and self.key in self.bucket.objects:
                raise PreconditionFailed('exists')
            super().upload_from_string(raw, content_type, **kwargs)

    class StrictBucket(Bucket):
        def blob(self, key):
            return ExistingBlob(self, key)

    store = FakeStore(bucket=StrictBucket())
    record = store.create_inspection('owner', ID, data())
    store.add_photo(
        'owner', ID, {**metadata(record['revision']), 'raw': COPY, 'content_type': 'image/jpeg'}
    )
    store.add_original('owner', ID, PHOTO, ORIGINAL, 'jpeg')
    store.add_original('owner', ID, PHOTO, ORIGINAL, 'jpeg')
    assert len(originals(store)) == 1


def test_an_original_arriving_after_signing_leaves_the_signed_agreement_unchanged():
    store = FakeStore()
    record = store.create_inspection('owner', ID, data())
    store.add_photo(
        'owner', ID, {**metadata(record['revision']), 'raw': COPY, 'content_type': 'image/jpeg'}
    )
    # A recorded reading keeps the photo from blocking signing on recognition.
    reading = dict(
        meter_detected=True, meter_type='Moisture meter', value='12', classification='', notes=''
    )
    record = store.set_ocr('owner', ID, PHOTO, reading)
    documents = make_documents(
        InspectionData.model_validate(record['data']),
        record['photos'],
        AIResult(summary='Confirmed', suggestions=[], unpriced_work=[]),
    )
    record = store.save_audit('owner', ID, record['revision'], documents)
    agreement = store.authorize('owner', sign_payload(record))
    # The signed record carries the promise, so it already names the original by hash.
    assert agreement['photos'][0]['original'] == pending()
    signed = deepcopy(store.db.records)
    store.add_original('owner', ID, PHOTO, ORIGINAL, 'jpeg')
    assert store.db.records == signed
    assert len(originals(store)) == 1
    with pytest.raises(Conflict):
        store.add_original('owner', ID, PHOTO, COPY, 'jpeg')


def test_only_people_who_may_add_photos_to_the_job_can_send_its_original():
    store = seed(FakeCompanyStore())
    store.create_inspection('estimator', ID, company_data())
    store.add_photo('estimator', ID, {**metadata(1), 'raw': COPY, 'content_type': 'image/jpeg'})
    # Office has no photo capability; superadmin support is read-only; another estimator of the
    # company cannot see the job; another company cannot see it at all.
    with pytest.raises(AccessDenied):
        store.add_original('office', ID, PHOTO, ORIGINAL, 'jpeg')
    for uid in ('admin', 'estimator2', 'other-owner'):
        with pytest.raises((AccessDenied, LookupError)):
            store.add_original(uid, ID, PHOTO, ORIGINAL, 'jpeg')
    assert not originals(store)
    # The owner may, as may the estimator who took it.
    store.add_original('owner', ID, PHOTO, ORIGINAL, 'jpeg')
    store.add_original('estimator', ID, PHOTO, ORIGINAL, 'jpeg')
    assert len(originals(store)) == 1
    # An archived job refuses it (410), and the phone keeps the original for a restore.
    store.db.records['_workspace_jobs/' + ID]['archived_at'] = '2026-10-07T00:00:00Z'
    with pytest.raises(JobArchived):
        store.add_original('estimator', ID, PHOTO, ORIGINAL, 'jpeg')
