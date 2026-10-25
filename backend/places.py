"""Address suggestions and the job map through Google Places API (New) and Static Maps.

The browser never calls Google. These functions run on the server with the key from MAPS_API_KEY
(Secret Manager secret dryscope-maps-api-key, bound when the backend is deployed); without it
nothing here is configured and the app keeps a plain address box. The typed address and the
coordinates reach the backend only in request bodies and are never logged. The server's Static
Maps request includes coordinates in Google's query string; provider errors are not passed on
because a provider message can echo the request.
"""

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from pydantic import Field

try:
    from .cloud_log import event
    from .contracts import StrictModel
except ImportError:
    from cloud_log import event
    from contracts import StrictModel

PLACES_URL = 'https://places.googleapis.com/v1'
STATIC_MAP_URL = 'https://maps.googleapis.com/maps/api/staticmap'
TIMEOUT_SECONDS = 6
IMAGE_LIMIT = 1_500_000
SUGGESTION_LIMIT = 5
# Google bills one autocomplete session from its first keystroke to the details call that ends it.
SESSION_TOKEN = r'^[A-Za-z0-9_-]{8,64}$'


class ProviderError(Exception):
    """The lookup failed or answered something unusable; carries no provider text."""


class SuggestRequest(StrictModel):
    input: str = Field(min_length=3, max_length=200)
    session: str = Field(pattern=SESSION_TOKEN)


class DetailsRequest(StrictModel):
    place_id: str = Field(pattern=r'^[A-Za-z0-9_-]{10,300}$')
    session: str = Field(pattern=SESSION_TOKEN)


class MapRequest(StrictModel):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)


def api_key():
    return os.getenv('MAPS_API_KEY', '').strip()


def configured():
    return bool(api_key())


def send(request):
    """The only network call: (content type, body). Tests replace it."""
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            body = response.read(IMAGE_LIMIT + 1)
            kind = response.headers.get_content_type()
    except urllib.error.HTTPError as error:
        raise ProviderError(error.code)
    except (urllib.error.URLError, OSError):
        raise ProviderError(None)
    if len(body) > IMAGE_LIMIT:
        raise ProviderError(None)
    return kind, body


def lookup(operation, request, expect):
    started = time.monotonic()
    outcome, status = 'error', None
    try:
        kind, body = send(request)
        if not kind.startswith(expect):
            raise ProviderError(None)
        outcome = 'ok'
        return body
    except ProviderError as error:
        status = error.args[0] if error.args else None
        raise
    finally:
        # Allowlisted fields only (cloud_log): never the typed address, coordinates or place.
        event(
            'Places lookup',
            operation=operation,
            outcome=outcome,
            status=status,
            elapsed_ms=int((time.monotonic() - started) * 1000),
        )


def parsed(body):
    try:
        return json.loads(body)
    except ValueError:
        raise ProviderError(None)


def suggest(text, session):
    request = urllib.request.Request(
        PLACES_URL + '/places:autocomplete',
        data=json.dumps(
            {'input': text, 'sessionToken': session, 'includedRegionCodes': ['us']}
        ).encode(),
        headers={'Content-Type': 'application/json', 'X-Goog-Api-Key': api_key()},
        method='POST',
    )
    result = []
    for entry in parsed(lookup('places_suggest', request, 'application/json')).get(
        'suggestions', []
    ):
        prediction = entry.get('placePrediction') or {}
        place, label = prediction.get('placeId'), (prediction.get('text') or {}).get('text')
        if isinstance(place, str) and isinstance(label, str) and label:
            result.append({'place_id': place, 'text': label})
    return result[:SUGGESTION_LIMIT]


def component(parts, kind, key='longText'):
    for part in parts:
        if kind in part.get('types', []) and isinstance(part.get(key), str):
            return part[key]
    return ''


def details(place_id, session):
    request = urllib.request.Request(
        f'{PLACES_URL}/places/{place_id}?sessionToken={session}',
        headers={
            'X-Goog-Api-Key': api_key(),
            'X-Goog-FieldMask': 'formattedAddress,location,addressComponents',
        },
    )
    place = parsed(lookup('places_details', request, 'application/json'))
    location, address = place.get('location') or {}, place.get('formattedAddress')
    latitude, longitude = location.get('latitude'), location.get('longitude')
    numbers = all(type(n) in (int, float) for n in (latitude, longitude))
    if not isinstance(address, str) or not address or not numbers:
        raise ProviderError(None)
    if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
        raise ProviderError(None)
    parts = place.get('addressComponents') or []
    return {
        'address': address.removesuffix(', USA')[:500],
        'latitude': round(latitude, 6),
        'longitude': round(longitude, 6),
        'city': component(parts, 'locality') or component(parts, 'postal_town'),
        'state': component(parts, 'administrative_area_level_1', 'shortText'),
        'zip': component(parts, 'postal_code'),
    }


def static_map(latitude, longitude):
    point = f'{latitude:.6f},{longitude:.6f}'
    query = urllib.parse.urlencode(
        {
            'center': point,
            'zoom': 17,
            'size': '600x300',
            'scale': 2,
            'maptype': 'roadmap',
            'markers': 'color:red|' + point,
            'key': api_key(),
        }
    )
    return lookup('places_map', urllib.request.Request(STATIC_MAP_URL + '?' + query), 'image/')
