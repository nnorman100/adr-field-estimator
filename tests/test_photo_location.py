import pytest
from backend.inspection_store import Conflict
from tests.fakes import FakeStore, png
from tests.test_backend import context, data, inspect, audit, photo, sign_payload, ID

PHOTO = 'b' * 32
FIX = dict(source='device', latitude=35.373292, longitude=-119.018712, accuracy_m=12.5)


def upload(client, record, location=None, photo_id=PHOTO):
    body = dict(
        expected_revision=record['revision'],
        photo_id=photo_id,
        room='Bathroom',
        captured_at='2026-10-06T19:00:00Z',
        data_url=png(),
    )
    if location is not None:
        body['location'] = location
    return client.post('/api/inspections/' + ID + '/photos', json=body)


def test_a_device_fix_is_saved_with_the_photo_and_appears_in_the_photo_log(context):
    client, _ = context
    r = upload(client, inspect(client), FIX)
    assert r.status_code == 200, r.text
    assert r.json()['photos'][0]['location'] == FIX
    signable = client.post('/api/inspections/' + ID + '/photos/' + PHOTO + '/ocr', json={}).json()
    assert audit(client, signable)['audit']['documents']['photo_audit_log'][0]['location'] == FIX


@pytest.mark.parametrize('source', ['not_available', 'not_shared'])
def test_a_missing_fix_is_kept_as_missing_with_its_reason_and_no_coordinates(context, source):
    client, _ = context
    r = upload(client, inspect(client), {'source': source})
    assert r.status_code == 200, r.text
    assert r.json()['photos'][0]['location'] == {'source': source}


@pytest.mark.parametrize(
    'location',
    [
        {'source': 'device'},
        {'source': 'device', 'latitude': 35.0, 'longitude': -119.0},
        {'source': 'device', 'latitude': 91, 'longitude': 0, 'accuracy_m': 5},
        {'source': 'device', 'latitude': 0, 'longitude': 181, 'accuracy_m': 5},
        {'source': 'device', 'latitude': 0, 'longitude': 0, 'accuracy_m': -1},
        {'source': 'not_shared', 'latitude': 35.0, 'longitude': -119.0, 'accuracy_m': 5},
        {'source': 'guessed', 'latitude': 35.0, 'longitude': -119.0, 'accuracy_m': 5},
        {**FIX, 'altitude': 100},
    ],
)
def test_invalid_or_invented_locations_are_refused_without_echoing_the_input(context, location):
    client, _ = context
    r = upload(client, inspect(client), location)
    assert r.status_code == 422
    assert '35.0' not in r.text and '-119' not in r.text
    assert client.get('/api/inspections/' + ID).json()['photos'] == []


def test_photos_saved_before_location_stamps_have_no_location_and_stay_valid(context):
    client, _ = context
    record = photo(client, inspect(client))
    assert 'location' not in record['photos'][0]
    ocr = client.post('/api/inspections/' + ID + '/photos/' + PHOTO + '/ocr', json={}).json()
    log = audit(client, ocr)['audit']['documents']['photo_audit_log'][0]
    assert log.get('location') is None


def test_a_photo_retry_cannot_substitute_or_add_a_location():
    store = FakeStore()
    store.create_inspection('owner', ID, data())
    base = dict(
        expected_revision=1,
        photo_id=PHOTO,
        room='Bathroom',
        captured_at='2026-10-06T19:00:00Z',
        data_url=png(),
    )
    first = store.add_photo('owner', ID, {**base, 'location': FIX})
    assert store.add_photo('owner', ID, {**base, 'location': FIX}) == first
    for changed in (None, {**FIX, 'latitude': 36.0}, {'source': 'not_shared'}):
        with pytest.raises(Conflict):
            store.add_photo('owner', ID, {**base, 'location': changed})
    assert store.get_inspection('owner', ID)['photos'][0]['location'] == FIX


def test_a_signed_record_keeps_its_photo_location(context):
    client, _ = context
    record = upload(client, inspect(client), FIX).json()
    ocr = client.post('/api/inspections/' + ID + '/photos/' + PHOTO + '/ocr', json={}).json()
    signed = audit(client, ocr)
    assert client.post('/api/authorize', json=sign_payload(signed)).status_code == 200
    after = client.get('/api/inspections/' + ID).json()
    assert after['photos'][0]['location'] == FIX
    agreement = client.get('/api/authorizations/ADR-AUTH-test123456').json()
    assert agreement['photos'][0]['location'] == FIX
    # No route edits a location, and a signed record accepts no new photo, with or without one.
    other = upload(client, {'revision': after['revision']}, {'source': 'not_shared'}, 'c' * 32)
    assert other.status_code == 409
    assert client.get('/api/inspections/' + ID).json()['photos'] == after['photos']
    assert record['photos'][0]['location'] == FIX


def test_coordinates_never_reach_the_logs(context, capsys, caplog):
    client, _ = context
    upload(client, inspect(client), FIX)
    upload(client, {'revision': 1}, {**FIX, 'latitude': 99}, 'c' * 32)
    captured = capsys.readouterr()
    output = captured.out + captured.err + caplog.text
    for text in ('35.373292', '-119.018712', '35.37', '119.01'):
        assert text not in output
