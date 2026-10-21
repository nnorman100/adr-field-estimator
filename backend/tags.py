"""QR tag codes for rooms and equipment. The printed code is the QR payload and the text a
technician can type when the camera is unavailable; the app reads the same format in core.js."""

import re

try:
    from . import signing_links
except ImportError:  # pragma: no cover - flat import when run from backend/
    import signing_links

KINDS = {'AM': 'air_mover', 'DH': 'dehumidifier', 'AS': 'air_scrubber'}
# DS1-RM-<first 8 hex of the job id>-<room name> and DS1-EQ-<AM|DH|AS>-<asset id>.
ROOM_TAG = re.compile(r'^DS1-RM-([a-f0-9]{8})-([^\r\n]{1,100})$', re.I)
EQUIPMENT_TAG = re.compile(r'^DS1-EQ-(AM|DH|AS)-([A-Z0-9][A-Z0-9._/-]{0,31})$', re.I)


def parse_tag(code):
    """The tag a code names, or None when it is not a DryScope tag."""
    text = code.strip()
    match = ROOM_TAG.match(text)
    if match:
        room = ' '.join(match.group(2).split())
        return {'type': 'room', 'job': match.group(1).lower(), 'room': room} if room else None
    match = EQUIPMENT_TAG.match(text)
    if match:
        return {
            'type': 'equipment',
            'kind': KINDS[match.group(1).upper()],
            'asset_id': match.group(2).upper(),
        }
    return None


def qr_tags(codes):
    """One SVG data URL per code; an unrecognised code raises ValueError naming it."""
    tags = []
    for code in codes:
        if parse_tag(code) is None:
            raise ValueError('Not a DryScope tag code: ' + code.strip()[:60])
        tags.append({'code': code.strip(), 'qr_svg': signing_links.qr_data_url(code.strip())})
    return tags
