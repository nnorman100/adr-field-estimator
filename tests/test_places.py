"""Address suggestions and the job map: the server-side Places proxy, its gate and caps, the
coordinates saved with a draft, and the guarantee that neither the key, the typed address nor the
coordinates reach a log or a model. Google is never called; places.send is replaced."""

import json
import logging
import pytest
import backend.inspection_store as inspection_store
import backend.main as bm
from backend import places
from backend.contracts import InspectionData
from backend.live_support import scope_fingerprint
from backend.prompts import audit_prompt, live_prompt
from backend.scope import scope_prompt
from tests.adr_pricing import price_scope
from tests.test_backend import context, data, inspect, ID  # noqa: F401
from tests.test_workspaces import api, store  # noqa: F401

KEY = 'synthetic-maps-key-0001'
TYPED = '4821 Zephyr Hollow Lane, Bakersfield'
PLACE = 'ChIJsynthetic_place_id_0001'
SESSION = 'session_token_0001'
LATITUDE, LONGITUDE = 35.373292, -119.018712
SUGGEST = {
    'suggestions': [
        {
            'placePrediction': {
                'placeId': PLACE,
                'text': {'text': '4821 Zephyr Hollow Lane, Bakersfield, CA, USA'},
            }
        },
        {'queryPrediction': {'text': {'text': 'not a place'}}},
    ]
}
DETAILS = {
    'formattedAddress': '4821 Zephyr Hollow Lane, Bakersfield, CA 93301, USA',
    'location': {'latitude': LATITUDE, 'longitude': LONGITUDE},
    'addressComponents': [
        {'longText': 'Bakersfield', 'shortText': 'Bakersfield', 'types': ['locality']},
        {
            'longText': 'California',
            'shortText': 'CA',
            'types': ['administrative_area_level_1'],
        },
        {'longText': '93301', 'shortText': '93301', 'types': ['postal_code']},
    ],
}
PNG = b'\x89PNG\r\n\x1a\nsynthetic'


class Google:
    """Stands in for the network: records each request and answers by its URL."""

    def __init__(self):
        self.requests = []
        self.fail = None

    def __call__(self, request):
        self.requests.append(request)
        if self.fail:
            raise places.ProviderError(self.fail)
        url = request.full_url
        if url.endswith('places:autocomplete'):
            return 'application/json', json.dumps(SUGGEST).encode()
        if '/places/' in url:
            return 'application/json', json.dumps(DETAILS).encode()
        return 'image/png', PNG


@pytest.fixture
def google(monkeypatch):
    fake = Google()
    monkeypatch.setenv('MAPS_API_KEY', KEY)
    monkeypatch.setattr(places, 'send', fake)
    return fake


def suggest(client, text=TYPED):
    return client.post('/api/places/autocomplete', json={'input': text, 'session': SESSION})


def details(client):
    return client.post('/api/places/details', json={'place_id': PLACE, 'session': SESSION})


def map_image(client):
    return client.post('/api/places/map', json={'latitude': LATITUDE, 'longitude': LONGITUDE})


def test_suggestions_details_and_map_come_back_in_the_apps_shape(context, google):  # noqa: F811
    client, _ = context
    found = suggest(client)
    assert found.status_code == 200
    assert found.json() == {
        'suggestions': [
            {'place_id': PLACE, 'text': '4821 Zephyr Hollow Lane, Bakersfield, CA, USA'}
        ]
    }
    chosen = details(client)
    assert chosen.json() == {
        'address': '4821 Zephyr Hollow Lane, Bakersfield, CA 93301',
        'latitude': LATITUDE,
        'longitude': LONGITUDE,
        'city': 'Bakersfield',
        'state': 'CA',
        'zip': '93301',
    }
    image = map_image(client)
    assert image.status_code == 200 and image.content == PNG
    assert image.headers['content-type'] == 'image/png'
    assert image.headers['cache-control'] == 'private, no-store'


def test_requests_to_google_carry_the_key_in_headers_or_the_map_query_only(context, google):  # noqa: F811
    client, _ = context
    suggest(client), details(client), map_image(client)
    autocomplete, place, picture = google.requests
    assert autocomplete.get_header('X-goog-api-key') == KEY
    body = json.loads(autocomplete.data)
    assert body == {'input': TYPED, 'sessionToken': SESSION, 'includedRegionCodes': ['us']}
    assert place.get_header('X-goog-api-key') == KEY
    assert place.get_header('X-goog-fieldmask') == 'formattedAddress,location,addressComponents'
    assert KEY not in autocomplete.full_url and KEY not in place.full_url
    assert place.full_url.startswith('https://places.googleapis.com/v1/places/' + PLACE)
    assert picture.full_url.startswith('https://maps.googleapis.com/maps/api/staticmap?')
    assert 'key=' + KEY in picture.full_url and '35.373292%2C-119.018712' in picture.full_url


def test_without_a_key_nothing_is_called_and_no_quota_is_used(context, monkeypatch):  # noqa: F811
    client, store = context
    monkeypatch.delenv('MAPS_API_KEY', raising=False)

    def forbidden(request):
        raise AssertionError('Google must not be called without a key')

    monkeypatch.setattr(places, 'send', forbidden)
    for call in (suggest, details, map_image):
        response = call(client)
        assert response.status_code == 503
        assert response.json() == {'detail': 'Address suggestions are not set up.'}
    assert not store.db.records.get('_limits/owner')
    monkeypatch.setenv('MAPS_API_KEY', '   ')
    assert suggest(client).status_code == 503


def test_calls_need_a_sign_in(context, google):  # noqa: F811
    client, _ = context
    for path, body in (
        ('/api/places/autocomplete', {'input': TYPED, 'session': SESSION}),
        ('/api/places/details', {'place_id': PLACE, 'session': SESSION}),
        ('/api/places/map', {'latitude': 1, 'longitude': 2}),
    ):
        assert client.post(path, json=body, headers={'Authorization': ''}).status_code == 401
    assert google.requests == []


def test_daily_cap_stops_each_user_after_their_own_limit(context, google, monkeypatch):  # noqa: F811
    client, _ = context
    monkeypatch.setitem(inspection_store.DAILY_LIMITS, 'places_suggest', 2)
    assert suggest(client).status_code == 200 and suggest(client).status_code == 200
    blocked = suggest(client)
    assert blocked.status_code == 429 and int(blocked.headers['retry-after']) > 0
    assert len(google.requests) == 2
    # Details and the map count separately, and another user starts fresh.
    assert details(client).status_code == 200 and map_image(client).status_code == 200
    bm.app.dependency_overrides[bm.current_staff] = lambda: {
        'uid': 'second',
        'email': 'second@example.invalid',
    }
    assert suggest(client).status_code == 200


def test_the_minute_cap_limits_bursts(context, google):  # noqa: F811
    client, _ = context
    results = [suggest(client).status_code for _ in range(31)]
    assert results[:30] == [200] * 30 and results[30] == 429


def test_provider_failures_read_the_same_and_pass_nothing_on(context, google):  # noqa: F811
    client, _ = context
    google.fail = 403
    for call in (suggest, details, map_image):
        response = call(client)
        assert response.status_code == 502
        assert response.json() == {
            'detail': 'Address lookup is unavailable. Type the address instead.'
        }


@pytest.mark.parametrize(
    'path, body',
    [
        ('/api/places/autocomplete', {'input': 'ab', 'session': SESSION}),
        ('/api/places/autocomplete', {'input': TYPED, 'session': 'short'}),
        ('/api/places/autocomplete', {'input': TYPED, 'session': SESSION, 'extra': 1}),
        ('/api/places/details', {'place_id': 'bad/place?id=1', 'session': SESSION}),
        ('/api/places/map', {'latitude': 91, 'longitude': 0}),
        ('/api/places/map', {'latitude': 0, 'longitude': -181}),
        ('/api/places/map', {'latitude': 'north', 'longitude': 0}),
    ],
)
def test_malformed_requests_are_refused_without_echoing_them(context, google, path, body):  # noqa: F811
    client, _ = context
    response = client.post(path, json=body)
    assert response.status_code == 422 and google.requests == []
    assert 'bad/place' not in response.text and TYPED not in response.text


def test_garbled_provider_answers_are_provider_errors(context, google, monkeypatch):  # noqa: F811
    client, _ = context
    for answer in (
        ('application/json', b'not json'),
        ('text/html', b'<html>'),
        ('application/json', json.dumps({'formattedAddress': 'x', 'location': {}}).encode()),
        (
            'application/json',
            json.dumps(
                {'formattedAddress': 'x', 'location': {'latitude': 95, 'longitude': 0}}
            ).encode(),
        ),
    ):
        monkeypatch.setattr(places, 'send', lambda request, answer=answer: answer)
        assert details(client).status_code == 502
    monkeypatch.setattr(places, 'send', lambda request: ('text/html', b'<html>'))
    assert map_image(client).status_code == 502


def test_neither_key_address_nor_coordinates_reach_a_log(context, google, caplog, capsys):  # noqa: F811
    client, _ = context
    caplog.set_level(logging.DEBUG)
    suggest(client), details(client), map_image(client)
    google.fail = 500
    suggest(client), details(client), map_image(client)
    seen = capsys.readouterr().out + caplog.text
    assert 'Places lookup' in seen
    for secret in (KEY, 'Zephyr', PLACE, SESSION, '35.37', '119.01', '93301'):
        assert secret not in seen
    lines = [json.loads(line) for line in seen.splitlines() if line.startswith('{')]
    lookups = [line for line in lines if line['message'] == 'Places lookup']
    assert {line['operation'] for line in lookups} == {
        'places_suggest',
        'places_details',
        'places_map',
    }
    assert {line['outcome'] for line in lookups} == {'ok', 'error'}
    allowed = {'severity', 'message', 'operation', 'outcome', 'status', 'elapsed_ms'}
    assert all(set(line) <= allowed for line in lookups)


def test_roles_decide_who_may_look_up_addresses(api, google):  # noqa: F811
    client, current, _ = api
    expected = {
        'owner': 200,
        'estimator': 200,
        'estimator2': 200,
        # Office staff never edit the inspection's address field; superadmin support is read-only.
        'office': 403,
        'admin': 403,
        'stranger': 403,
    }
    for uid, status in expected.items():
        current['uid'] = uid
        for call in (suggest, details, map_image):
            assert call(client).status_code == status, (uid, call.__name__)
    # Another company's owner uses the lookup for their own company only: the call carries no job.
    current['uid'] = 'other-owner'
    assert suggest(client).status_code == 200
    assert len(google.requests) == 3 * 3 + 1


def test_session_capabilities_list_places_for_owner_and_estimator_only(api, google):  # noqa: F811
    client, current, _ = api
    for uid, listed in {
        'owner': True,
        'estimator': True,
        'office': False,
        'admin': False,
        'other-owner': True,
    }.items():
        current['uid'] = uid
        assert ('places' in client.get('/api/session').json()['capabilities']) is listed


def test_a_removed_member_loses_the_lookup(api, google):  # noqa: F811
    client, current, store = api
    current['uid'] = 'estimator'
    assert suggest(client).status_code == 200
    store.db.records['_memberships/estimator']['status'] = 'disabled'
    assert suggest(client).status_code == 403


COORDINATES = {'latitude': LATITUDE, 'longitude': LONGITUDE, 'address': DETAILS['formattedAddress']}


def test_coordinates_save_with_the_draft_and_older_drafts_keep_their_shape(context):  # noqa: F811
    client, _ = context
    record = inspect(client)
    assert 'coordinates' not in record['data']
    chosen = data(coordinates=COORDINATES)
    saved = client.put(
        '/api/inspections/' + ID, json={'expected_revision': record['revision'], 'data': chosen}
    )
    assert saved.status_code == 200 and saved.json()['data']['coordinates'] == COORDINATES
    assert client.get('/api/inspections/' + ID).json()['data']['coordinates'] == COORDINATES
    # Clearing the address choice removes the key again; no value is ever invented.
    again = client.put(
        '/api/inspections/' + ID,
        json={'expected_revision': saved.json()['revision'], 'data': data()},
    )
    assert again.status_code == 200 and 'coordinates' not in again.json()['data']


def test_new_manual_location_marker_survives_save_and_reload(context):
    client, _ = context
    record = inspect(client)
    saved = client.put(
        '/api/inspections/' + ID,
        json={'expected_revision': record['revision'], 'data': data(coordinates=None)},
    )
    assert saved.status_code == 200
    assert 'coordinates' in saved.json()['data']
    assert saved.json()['data']['coordinates'] is None
    reopened = client.get('/api/inspections/' + ID).json()
    assert 'coordinates' in reopened['data']
    assert reopened['data']['coordinates'] is None


@pytest.mark.parametrize(
    'changes',
    [
        {'latitude': 90.5},
        {'longitude': -180.5},
        {'address': ''},
        {'address': 'x' * 501},
        {'extra': True},
        {'latitude': float('nan')},
    ],
)
def test_coordinates_are_validated(changes):
    with pytest.raises(ValueError):
        InspectionData(coordinates={**COORDINATES, **changes})


def test_older_records_without_coordinates_still_load():
    old = InspectionData().model_dump(mode='json', exclude={'coordinates'})
    assert InspectionData.model_validate(old).coordinates is None


def test_coordinates_never_reach_a_model_or_count_as_a_scope_change():
    fields = dict(address='1 Main St', year_built=1990, rooms=[{'name': 'Hall'}])
    plain = InspectionData(**fields)
    placed = InspectionData(**fields, coordinates=COORDINATES)
    items, _ = price_scope(plain)
    for prompt in (
        audit_prompt(placed.model_dump(mode='json'), [], items),
        live_prompt(placed.model_dump(mode='json')),
        scope_prompt(placed),
    ):
        assert 'coordinates' not in prompt and '35.373292' not in prompt
    assert scope_fingerprint(plain.model_dump(mode='json')) == scope_fingerprint(
        placed.model_dump(mode='json')
    )
    assert price_scope(plain) == price_scope(placed)
