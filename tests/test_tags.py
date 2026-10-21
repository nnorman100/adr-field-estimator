"""QR room and equipment tags: the shared code format, the printed-sheet QR route and the
equipment-scan records saved with a draft without touching pricing or documents."""

from decimal import Decimal
import json
import pytest
from pydantic import ValidationError
from backend import tags
from backend.claims import price_scope, make_documents, proposal_range
from backend.contracts import InspectionData, AIResult
from backend.prompts import audit_prompt, live_prompt
from backend.scope import scope_prompt
from tests.test_backend import context, data, inspect, ID  # noqa: F401

JOB = ID[8:16]
SCAN = {
    'id': 'c' * 32,
    'kind': 'dehumidifier',
    'asset_id': 'DH-0042',
    'room': 'Bathroom',
    'scanned_at': '2026-10-21T14:41:00Z',
}


def test_tag_codes_parse_rooms_and_equipment_and_nothing_else():
    assert tags.parse_tag('DS1-RM-' + JOB + '-Master  Bath ') == {
        'type': 'room',
        'job': JOB,
        'room': 'Master Bath',
    }
    assert tags.parse_tag('ds1-eq-dh-dh-0042') == {
        'type': 'equipment',
        'kind': 'dehumidifier',
        'asset_id': 'DH-0042',
    }
    assert tags.parse_tag('DS1-EQ-AM-7')['kind'] == 'air_mover'
    assert tags.parse_tag('DS1-EQ-AS-A/1.2')['kind'] == 'air_scrubber'
    for code in [
        '',
        'DS1-RM-' + JOB + '-',
        'DS1-RM-' + JOB + '-   ',
        'DS1-RM-xyz-Kitchen',
        'DS1-EQ-WF-1',  # no wood-floor tags yet
        'DS1-EQ-AM-',
        'DS1-EQ-AM-' + 'A' * 33,
        'DS1-EQ-AM-A B',
        'https://example.invalid/asset?sn=1',
        '{"type":"room","roomName":"Kitchen"}',
        'DEHU-108: Phoenix',
    ]:
        assert tags.parse_tag(code) is None, code


def test_qr_tag_route_renders_only_dryscope_codes(context):
    client, _ = context
    codes = ['DS1-RM-' + JOB + '-Kitchen', 'DS1-EQ-AM-AM-12']
    r = client.post('/api/qr-tags', json={'codes': codes})
    assert r.status_code == 200, r.text
    rendered = r.json()['tags']
    assert [t['code'] for t in rendered] == codes
    for tag in rendered:
        assert tag['qr_svg'].startswith('data:image/svg+xml;base64,')
    r = client.post('/api/qr-tags', json={'codes': ['DS1-EQ-AM-1', 'DEHU-108: Phoenix']})
    assert r.status_code == 422
    assert 'Not a DryScope tag code: DEHU-108' in r.text
    assert client.post('/api/qr-tags', json={'codes': []}).status_code == 422
    assert client.post('/api/qr-tags', json={'codes': ['DS1-EQ-AM-1'] * 61}).status_code == 422
    assert client.post('/api/qr-tags', json={'codes': ['x' * 161]}).status_code == 422


def test_equipment_scans_save_with_the_draft_and_older_drafts_keep_their_shape(context):
    client, store = context
    record = inspect(client)
    assert 'equipment_scans' not in record['data']
    tagged = data(equipment_scans=[SCAN])
    saved = client.put(
        '/api/inspections/' + ID, json={'expected_revision': record['revision'], 'data': tagged}
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()['data']['equipment_scans'] == [SCAN]
    # Removing the last scan returns the draft to the shape an older app saved.
    cleared = data(equipment_scans=[])
    saved = client.put('/api/inspections/' + ID, json={'expected_revision': 2, 'data': cleared})
    assert saved.status_code == 200 and 'equipment_scans' not in saved.json()['data']
    for bad in [
        {**SCAN, 'kind': 'wood_floor_system'},
        {**SCAN, 'asset_id': 'dh 42'},
        {**SCAN, 'room': ''},
        {**SCAN, 'id': 'short'},
        {**SCAN, 'notes': 'extra'},
    ]:
        with pytest.raises(ValidationError):
            InspectionData(equipment_scans=[bad])
    with pytest.raises(ValidationError):
        InspectionData(equipment_scans=[{**SCAN, 'id': f'{i:032x}'} for i in range(201)])


def test_scans_change_no_price_document_or_model_input():
    base = InspectionData(
        address='Synthetic',
        year_built=1960,
        rooms=[{'name': 'Bathroom', 'finished_sf': 10}],
        air_movers=3,
        dehumidifiers=1,
        scope_confirmed=True,
    )
    tagged = InspectionData.model_validate(
        {**base.model_dump(mode='json'), 'equipment_scans': [SCAN, {**SCAN, 'id': 'd' * 32}]}
    )
    assert price_scope(base) == price_scope(tagged)
    items, _ = price_scope(base)
    assert proposal_range(base, items) == proposal_range(tagged, items)
    ai = AIResult(summary='Localized scope.', suggestions=[], unpriced_work=[])
    plain, scanned = make_documents(base, [], ai), make_documents(tagged, [], ai)
    for documents in (plain, scanned):
        documents['adr_estimate'].pop('date')
    assert plain == scanned
    assert Decimal(str(plain['xactimate_total'])) == Decimal(str(scanned['xactimate_total']))
    # Scans are stored and shown only; no model prompt sees them until documents wire them in.
    scanned_data = tagged.model_dump(mode='json')
    for prompt in (
        audit_prompt(scanned_data, [], items),
        live_prompt(scanned_data),
        scope_prompt(tagged),
    ):
        assert 'equipment_scans' not in prompt and 'DH-0042' not in prompt
    assert (
        json.loads(audit_prompt(base.model_dump(mode='json'), [], items).split('(JSON):\n')[1])[
            'inspection'
        ]
        == json.loads(audit_prompt(scanned_data, [], items).split('(JSON):\n')[1])['inspection']
    )
