"""The pricing oracle's scalar coercion probes: tricky JSON values set into one field at a time.

Each target names a reference model, a valid template and the path of one field. Every probe value
is written into a copy of the template, read back through JSON as a client sends it, validated by
the model (pydantic lax mode, as the backend reads it) and stored with whether it was accepted and
the value the model dumps at that path. A port must accept and reject the same values and dump the
same value for each. No customer record is used.
"""

import copy
import json

from pydantic import ValidationError

from backend import claims, price_table
from backend.contracts import (
    ClaimDetails,
    CompanyIdentity,
    InspectionData,
    PhotoLog,
    distinct_rooms,
)
from backend.main import inspection_payload
from scripts.pricing_oracle_cases_v2 import table

HEX = '0123456789abcdef' * 2
NUMBERS = [
    *(True, False, None, 0, 1, 2, 3, 4, -1, 100, 101, 1000, 1001, 1800, 1799, 2026, 2**63, 2**64),
    *(0.0, -0.0, 0.5, 1.0, 1.25, 1.255, 3.0, 3.5, 13.25, 0.1, 1e-07, 1e20, 2026.0, 1.125),
    *('0', '1', '2', '3', ' 3 ', ' 3', '　3', '\x1c3', '\x853', '​3', '03', '+3', '-0'),
    *('3.0', '3.00', '3.5', '-1.5', '1.0', '0.0', '-0.0', '+0.0', '0.000', '3.0_0', '1_000.00'),
    *('1_000', '1__0', '_1', '1_', '1_0.5_5', '+_1', '1._5', '1_.5', '1.5_', '1_e5', '1e_5'),
    *('1e3', '1E+2', '100E-2', '1e-2', '1E-3', '1e', '1e0x2', '1e+', '0x10', '1,5', '1 0'),
    *('', ' ', '.', '1.', '.5', '+.5', '5.e1', '0e5', '0E-1000', '1e999999', '1.00e1'),
    *('inf', 'nan', 'Infinity', 'NaN', '1e400', '1.250', '1.2500', '1.255', '13.25', '2026'),
    *('١٢', '١.٥', '\U0001d7cf', '½', '1 ', '\t3\n'),
    *('true', 'True', 'TRUE', 'yes', 'no', 'on', 'off', 't', 'f', 'y', 'n', ' true ', 'x'),
    *('water', 'Water', 'mold', 'both', 'manual', 'complete', 'verified', 'device'),
    [],
    {},
]
TEXT = [
    *('', 'a', 'ab', 'abc', 'Kitchen', ' Kitchen ', 'Ki tchen', 'x' * 100, 'x' * 101),
    *('\U0001f4a7' * 100, '\U0001f4a7' * 101, 'é' * 50, 'é' * 51, '​', 'a\x00b'),
    *(None, 0, 3, 1.5, True, [], {}, 'x' * 150, 'x' * 151, 'Example  Mutual\n'),
]
DATES = [
    *('2026-10-15T12:00:00Z', '2026-10-15T12:00:00+00:00', '2026-10-15T12:00:00-00:00'),
    *('2026-10-15T05:00:00.5-07:00', '2026-10-15 12:00:00z', '2026-10-15t12:00:00Z'),
    *('2026-10-15_12:00:00Z', '2026-10-15', '2026-10-15T12:00', '2026-10-15T12:00Z'),
    *('2026-10-15T17:30:00+0530', '2026-10-15T12:00:00,1234567Z', '2026-10-15T12:00:00.9999999Z'),
    *('2026-10-15T12:00:00.000000Z', '2026-10-15T12:00:00.000001Z', '2026-10-15T12:00:00+23:59'),
    *('2026-10-15T12:00:00+24:00', '2026-10-15T12:00:00+07', '2026-10-15T12:00:00+07:00:30'),
    *('2026-10-15T12', '2026-10-15T12:00.5Z', '2026-10-15Z', '2026-10-15T12:00:00 Z'),
    *('2026-10-15T24:00:00Z', '2026-10-15T12:00:60Z', '2026-02-29T00:00:00', '2024-02-29T00:00:00'),
    *('2026-13-01T00:00:00', '0000-01-01T00:00:00', '0001-01-01T00:00:00', '9999-12-31T23:59:59'),
    *(' 2026-10-15T12:00:00Z', '2026-10-15T12:00:00Z ', '2026-1-15T12:00:00', '20261015T120000'),
    *('2026-10-15T12:00:00.Z', '+2026-10-15T12:00:00', 'yesterday', '', '٢026-10-15'),
    *('1700000000', '-1', '0', '+5', '00005', '-0', ' 5', '5_0', '1e3', '2e10', '1.5e10'),
    *('1700000000.123456789', '1700000000.1234565', '1.9999995', '0.0000005', '.5', '-.5', '-5.'),
    *('20000000000', '20000000001', '20000000000.5', '253402300799999', '253402300800000'),
    *('-62135596800000', '-62135596801000', '99999999999999999999', '.', '-', '1.2.3'),
    *(1700000000, -1, 0, 20000000000, 20000000001, 253402300799999, 253402300800000, 2**63),
    *(-62135596800000, -62135596801000, 1700000000.123456, 1.0000005, -1.25, -0.0, 3.0),
    *(20000000001.5, -20000000001.5, 19999999999.9999, 1e15, 1e20, 0.0000015),
    *(True, False, None, [], {}),
]
CLAIM_DATES = [
    *('2026-10-10', '2026-02-30', '2024-02-29', '2025-02-29', ' 2026-10-10', '2026-10-10 '),
    *('', '2026-1-10', '20261010', '2026/10/10', '2099-01-01', '0000-01-01', '0001-01-01'),
    *('٢٠٢٦-١٠-١٠', None, 5, True),
]

SPACES = (
    '\t\n\x0b\x0c\r\x1c\x1d\x1e\x1f \x85\xa0\u1680\u2003\u2028\u2029\u202f\u205f\u3000\ufeff\u200b'
)
UNICODE_TEXT = [
    *(f'Water{space}extraction' for space in SPACES),
    *(f'{space}Water extraction{space}' for space in SPACES),
    *(
        '\U0001f4a7' * 80,
        '\U0001f4a7' * 81,
        'e\u0301' * 40,
        'e\u0301' * 41,
        '\U0001d7cf\u0661\uff11',
    ),
    *('Wa\u00adter', 'Wa\u200dter', 'Wa\ue000ter', 'Wa\U000e0001ter', 'Wa\u0378ter', '=SUM', ' -1'),
    *(
        'K\u0130TCHEN',
        'k\u0131tchen',
        'Kitchen',
        ' kitchen ',
        'KITCHEN',
        'kitche\u0274',
        'ki\u0307tchen',
    ),
    *('a@b.co', ' A@B.CO ', 'a\u00a0b@c.de', 'a@b\u2003.de', 'a\x1c@b.de', '\u0130@x.io', 'a@b'),
]
AI_TEXT = [
    *(
        'The cost is \uff11\uff10\uff10.',
        'The cost is \u0663.',
        'The cost is \u2460.',
        'Price five.',
    ),
    *('The pr\u0131ce is 5.', 'The PR\u0130CE is 5.', 'Co\u017ft 5.', 'Fee \u00bd.', 'Fees: two.'),
    *(
        'Total \U0001d7d1 rooms.',
        'Totals\u0301 3.',
        '\u00e9total 3.',
        'total\u00e9 3.',
        'ztotal 3.',
    ),
    *('Costs ten\u0301 dollars.', 'It is \u20ac5.', 'It is 5 USD.', 'It is 5 \uff35\uff33\uff24.'),
    *(
        'Five bucks.',
        'Five BUCKS.',
        'Ninety-nine cents.',
        'cents\u00e9 apply.',
        '\u00e9cents apply.',
    ),
    *('caf\u00e9_bar metadata.', '\u00e9x_y field.', 'snake_case_ok here.', 'x_\u00e9y here.'),
    *(
        'JSON data here.',
        'JSON\u00a0data here.',
        'The\u2003inspection JSON record.',
        'json\u0301 data.',
    ),
    *(
        '\u0130nspection JSON payload starts.',
        'inspect\u0131on JSON.',
        'The ſaved JSON.',
        'METADATA.',
    ),
    *(
        'One.\u2028Two dollars.',
        'Line one\x1cLine two cost 5.',
        'A.\u00a0B costs 4.',
        'A.\x85B costs 4.',
    ),
    *('A.\u3000B costs 4.', 'A.\ufeffB costs 4.', 'A.\x0bB costs 4.', 'A.\x0cB.\rC price 9.'),
    *('  Padded.\u00a0', '\u2028', 'Quote\u00a0three.', 'Budget ‒ \u0967.', 'Ch\u0430rge 5.'),
]
TRANSCRIPTS = [
    *(
        'Okay. Water under sink.',
        'OKAY!',
        'o\u212a.',
        '\u017fure.',
        'H\u0131.',
        'H\u0130.',
        'Hi\u0345.',
    ),
    *(
        'Thanks\u2028Moisture high.',
        'Hello\x0bWet drywall.',
        '\ufb01ne.',
        'Great. Great.',
        '  Hello  ',
    ),
    *(
        'Good morning.\u00a0Wet.',
        'Good morning.\u3000Wet.',
        'Good morning.\ufeffWet.',
        'Bye\x1cWet.',
    ),
    *('Thank you very much. Wet\x85Dry.', 'ok\u00a0ok', 'ok\u2003ok.', 'Um, uh. Wet.', '\u1e96mm.'),
    *(
        'Gr\u00e9at.',
        'GREAT\u0301.',
        'can I add a photo',
        'Can I add a ph\u00f6to?',
        'Stra\u00dfe.',
    ),
]
TABLE_DECIMALS = [
    *(
        '12.50',
        ' 12.50 ',
        '\u00a012.50',
        '\x1c12.50',
        '\ufeff12.50',
        '\u0661\u0662.\u0665',
        '\U0001d7cf2',
    ),
    *('\uff11\uff12', '12.505', '12.\u0665\u0660\u0660', '1_2', '+12', '-12', '12.', '.5', '1e1'),
    *(12, 0, -1, 12.5, True, None, '', ' ', '0', '0.00', '9' * 30),
]

ROOM = {'name': 'Kitchen'}
EXTRA = {'id': HEX, 'description': 'Detach dishwasher', 'hours': '1.25'}
APPROVAL = {
    'accepted_by_uid': 'owner-uid',
    'accepted_by_name': 'Olive Owner',
    'accepted_at': '2026-10-25T12:00:00Z',
    'rate': '55.00',
    'total': '68.75',
    'company_id': 'oracle-co',
    'company_version': 1,
}
SEGMENT = {'speaker': 'technician', 'connection_id': 'c-1', 'sequence': 1, 'text': 'Wet.'}
CAPTURE = {'capture_id': HEX, 'segments': [SEGMENT]}
SCAN = {
    'id': HEX,
    'kind': 'air_mover',
    'asset_id': 'AM-1',
    'room': 'Kitchen',
    'scanned_at': '2026-10-15T12:00:00Z',
}
PHOTO = {
    'id': HEX,
    'room': 'Kitchen',
    'captured_at': '2026-10-15T12:00:00Z',
    'width': 1600,
    'height': 1200,
    'ocr_status': 'verified',
    'ocr': {
        'meter_detected': True,
        'meter_type': 'Extech MO290',
        'value': '22.0% WME',
        'classification': '',
        'notes': '',
    },
    'location': {'source': 'device', 'latitude': 35.1, 'longitude': -119.2, 'accuracy_m': 12.5},
}
IDENTITY = {
    'company_id': 'oracle-co',
    'version': 1,
    'name': 'Oracle Restoration',
    'address': '1 Synthetic Way, Testville',
    'phone': '555-0100',
    'email': 'office@example.invalid',
    'license': '000001',
    'signoff': 'Pat Example',
}
OVERRIDE = {'measured': '2', 'entered': '2', 'reason': 'Counted again'}

# (target id, model, template, path, probe values)
TARGETS = [
    ('inspection-int', 'inspection', {}, ['air_movers'], NUMBERS),
    ('inspection-float', 'inspection', {}, ['labor_hours'], NUMBERS),
    ('inspection-bool', 'inspection', {}, ['is_after_hours'], NUMBERS),
    ('inspection-optional-int', 'inspection', {}, ['dehumidifier_ppd'], NUMBERS),
    ('inspection-year', 'inspection', {}, ['year_built'], NUMBERS),
    ('inspection-text', 'inspection', {}, ['address'], TEXT),
    ('inspection-optional-text', 'inspection', {}, ['seeded_from_version'], TEXT),
    ('room-name', 'inspection', {'rooms': [ROOM]}, ['rooms', 0, 'name'], TEXT),
    ('room-category', 'inspection', {'rooms': [ROOM]}, ['rooms', 0, 'category'], NUMBERS),
    ('room-loss', 'inspection', {'rooms': [ROOM]}, ['rooms', 0, 'loss'], NUMBERS),
    ('room-float', 'inspection', {'rooms': [ROOM]}, ['rooms', 0, 'finished_sf'], NUMBERS),
    ('room-floor', 'inspection', {'rooms': [ROOM]}, ['rooms', 0, 'floor_sf'], NUMBERS),
    ('room-water-class', 'inspection', {'rooms': [ROOM]}, ['rooms', 0, 'water_class'], NUMBERS),
    ('room-surfaces', 'inspection', {'rooms': [ROOM]}, ['rooms', 0, 'affected_surfaces'], NUMBERS),
    ('room-answer', 'inspection', {'rooms': [ROOM]}, ['rooms', 0, 'source_of_loss'], NUMBERS),
    ('extra-hours', 'inspection', {'extras': [EXTRA]}, ['extras', 0, 'hours'], NUMBERS),
    ('extra-description', 'inspection', {'extras': [EXTRA]}, ['extras', 0, 'description'], TEXT),
    ('extra-origin', 'inspection', {'extras': [EXTRA]}, ['extras', 0, 'origin'], NUMBERS),
    *(
        (
            f'approval-{label}',
            'inspection',
            {'extras': [dict(EXTRA, approval=APPROVAL)]},
            ['extras', 0, 'approval', field],
            probes,
        )
        for label, field, probes in (
            ('rate', 'rate', NUMBERS),
            ('total', 'total', NUMBERS),
            ('version', 'company_version', NUMBERS),
            ('time', 'accepted_at', DATES),
            ('name', 'accepted_by_name', TEXT),
            ('price-version', 'price_version_id', TEXT),
        )
    ),
    *(
        (
            f'scope-{field}',
            'inspection',
            {'scope_items': {'odor_treatment': {}}},
            ['scope_items', 'odor_treatment', field],
            probes,
        )
        for field, probes in (('quantity', NUMBERS), ('count', NUMBERS), ('override_reason', TEXT))
    ),
    *(
        (
            f'override-{field}',
            'inspection',
            {'quantity_overrides': {'air_movers': OVERRIDE}},
            ['quantity_overrides', 'air_movers', field],
            probes,
        )
        for field, probes in (('entered', NUMBERS), ('reason', TEXT))
    ),
    *(
        (
            f'coordinates-{field}',
            'inspection',
            {'coordinates': {'latitude': 35.1, 'longitude': -119.2, 'address': 'A'}},
            ['coordinates', field],
            probes,
        )
        for field, probes in (('latitude', NUMBERS), ('address', TEXT))
    ),
    *(
        (f'capture-{label}', 'inspection', {'capture_metadata': CAPTURE}, path, probes)
        for label, path, probes in (
            ('gap-count', ['capture_metadata', 'gap_count'], NUMBERS),
            ('edited', ['capture_metadata', 'technician_edited'], NUMBERS),
            ('status', ['capture_metadata', 'status'], NUMBERS),
            ('sequence', ['capture_metadata', 'segments', 0, 'sequence'], NUMBERS),
            ('finished', ['capture_metadata', 'segments', 0, 'finished'], NUMBERS),
            ('connection', ['capture_metadata', 'segments', 0, 'connection_id'], TEXT),
        )
    ),
    (
        'scan-time',
        'inspection',
        {'equipment_scans': [SCAN]},
        ['equipment_scans', 0, 'scanned_at'],
        DATES,
    ),
    ('scan-room', 'inspection', {'equipment_scans': [SCAN]}, ['equipment_scans', 0, 'room'], TEXT),
    ('photo-width', 'photo', PHOTO, ['width'], NUMBERS),
    ('photo-status', 'photo', PHOTO, ['ocr_status'], NUMBERS),
    ('photo-room', 'photo', PHOTO, ['room'], TEXT),
    ('photo-meter', 'photo', PHOTO, ['ocr', 'meter_detected'], NUMBERS),
    ('photo-reading', 'photo', PHOTO, ['ocr', 'value'], TEXT),
    ('photo-latitude', 'photo', PHOTO, ['location', 'latitude'], NUMBERS),
    ('photo-accuracy', 'photo', PHOTO, ['location', 'accuracy_m'], NUMBERS),
    ('photo-source', 'photo', PHOTO, ['location', 'source'], NUMBERS),
    ('identity-version', 'identity', IDENTITY, ['version'], NUMBERS),
    ('identity-name', 'identity', IDENTITY, ['name'], TEXT),
    ('claim-carrier', 'claim', {}, ['carrier'], TEXT),
    ('claim-date', 'claim', {}, ['date_of_loss'], CLAIM_DATES),
    ('unicode-room-name', 'inspection', {'rooms': [ROOM]}, ['rooms', 0, 'name'], UNICODE_TEXT),
    (
        'unicode-room-key',
        'rooms',
        {'rooms': [ROOM, {'name': 'Hall'}]},
        ['rooms', 1, 'name'],
        UNICODE_TEXT,
    ),
    (
        'unicode-extra-description',
        'inspection',
        {'extras': [EXTRA]},
        ['extras', 0, 'description'],
        UNICODE_TEXT,
    ),
    (
        'unicode-override-reason',
        'inspection',
        {'quantity_overrides': {'air_movers': OVERRIDE}},
        ['quantity_overrides', 'air_movers', 'reason'],
        UNICODE_TEXT,
    ),
    ('unicode-claim-carrier', 'claim', {}, ['carrier'], UNICODE_TEXT),
    ('unicode-claim-email', 'claim', {}, ['adjuster_email'], UNICODE_TEXT),
    ('unicode-table-name', 'table', table(), ['items', 0, 'name'], UNICODE_TEXT),
    (
        'unicode-table-description',
        'table',
        table(),
        ['items', 0, 'customer_description'],
        UNICODE_TEXT,
    ),
    ('unicode-table-code', 'table', table(), ['items', 0, 'code'], UNICODE_TEXT),
    ('unicode-table-label', 'table', table(), ['policy', 'after_hours', 'label'], UNICODE_TEXT),
    ('unicode-table-price', 'table', table(), ['items', 0, 'unit_price'], TABLE_DECIMALS),
    ('unicode-ai-note', 'ai_note', {'text': ''}, ['text'], AI_TEXT),
    ('unicode-statement', 'statement', {'text': ''}, ['text'], TRANSCRIPTS),
]


def _dump(model, data):
    if model == 'inspection':
        return inspection_payload(InspectionData.model_validate(data))
    if model == 'rooms':
        return inspection_payload(distinct_rooms(InspectionData.model_validate(data)))
    if model == 'table':
        return price_table.normalize_table(data, publish=True, acknowledgements=[])
    if model == 'ai_note':
        return {'text': claims.ai_note(data['text'])}
    if model == 'statement':
        transcript = InspectionData(technician_transcript=data['text'])
        return {'text': claims.technician_statement(transcript)}
    if model == 'photo':
        return PhotoLog.model_validate(data).model_dump(mode='json', exclude_none=True)
    if model == 'identity':
        return CompanyIdentity.model_validate(data).model_dump(mode='json')
    return ClaimDetails.model_validate(data).model_dump(mode='json')


def _set(data, path, value):
    target = data
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = value


def _get(data, path):
    for key in path:
        if isinstance(data, dict) and key in data:
            data = data[key]
        elif isinstance(data, list) and isinstance(key, int) and key < len(data):
            data = data[key]
        else:
            return {'missing': True}
    return {'value': data}


def probe(model, template, path, value):
    data = copy.deepcopy(template)
    _set(data, path, value)
    data = json.loads(json.dumps(data))
    try:
        dumped = _dump(model, data)
    except (ValidationError, ValueError):
        return {'input': value, 'accepted': False}
    return {'input': value, 'accepted': True, **_get(dumped, path)}


def coercion_files(render):
    """One file per target: the template, the path and every probe's expected outcome."""
    files = {}
    for target, model, template, path, values in TARGETS:
        body = {
            'id': target,
            'model': model,
            'template': template,
            'path': path,
            'probes': [probe(model, template, path, value) for value in values],
        }
        files[f'{target}.json'] = (render(body, inline=2) + '\n').encode('ascii')
    return files
