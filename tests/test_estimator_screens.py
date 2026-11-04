"""Estimator screens for company price tables: session version, create-time pin, audit pre-check, readiness."""

import json
import subprocess
from pathlib import Path

import anyio
import pytest
import backend.main as bm
from backend import ai_features, price_books, price_table
from backend.contracts import CreateInspection, InspectionData, UpdateInspection
from pydantic import ValidationError
from backend.readiness import readiness
from tests.test_backend import sign_payload
from tests.test_price_books import _publish_v2, _v2_table, enabled, publish, rates  # noqa: F401
from tests.test_price_cutover import switch
from tests.test_workspaces import ID, OTHER, api, data, store  # noqa: F401

ROOT = Path(__file__).resolve().parents[1]
V2 = price_table.CALCULATION_VERSION


def session(client, current, uid):
    current['uid'] = uid
    response = client.get('/api/session')
    assert response.status_code == 200, response.text
    return response.json()


def test_session_reports_pricing_version(api, enabled):  # noqa: F811
    client, current, store = api
    # Nothing published for the company: the screen must not assume a v2 item list.
    assert session(client, current, 'estimator')['pricing_version'] != V2
    current['uid'] = 'owner'
    _publish_v2(client, _v2_table('30.00'))
    for uid in ('owner', 'estimator', 'office'):
        assert session(client, current, uid)['pricing_version'] == V2, uid
        # The app's periodic access refresh must learn of a first publish too.
        assert client.get('/api/access').json()['pricing_version'] == V2, uid
    # Another company's table never leaks to this one's session.
    assert session(client, current, 'other-owner')['pricing_version'] != V2


def test_session_reports_the_table_version_so_a_republish_is_noticed(api, enabled):  # noqa: F811
    client, current, store = api
    assert session(client, current, 'estimator')['pricing_table_version'] is None
    current['uid'] = 'owner'
    first = _publish_v2(client, _v2_table('30.00'))
    assert session(client, current, 'estimator')['pricing_table_version'] == first['version_id']
    current['uid'] = 'owner'
    second = _publish_v2(client, _v2_table('45.00'), 'Raise every price')
    current['uid'] = 'estimator'
    assert client.get('/api/access').json()['pricing_table_version'] == second['version_id']
    assert session(client, current, 'other-owner')['pricing_table_version'] is None


def test_session_pricing_version_is_absent_with_the_flag_off(api):
    client, current, store = api
    assert price_books.price_books_enabled() is False
    assert session(client, current, 'estimator')['pricing_version'] is None
    assert session(client, current, 'estimator')['pricing_table_version'] is None


def test_create_pins_v2_drafts_and_skips_companies_without_prices(api, enabled):  # noqa: F811
    client, current, store = api
    # No published table yet: the draft saves, nothing is pinned.
    current['uid'] = 'estimator'
    made = client.post('/api/inspections', json={'inspection_id': OTHER, 'data': data()})
    assert made.status_code == 200, made.text
    assert '_job_pricing/' + OTHER not in store.db.records

    current['uid'] = 'owner'
    first = _publish_v2(client, _v2_table('30.00'))
    current['uid'] = 'estimator'
    made = client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    assert made.status_code == 200, made.text
    pin = store.db.records['_job_pricing/' + ID]
    assert pin['calculation_version'] == V2
    assert pin['version_id'] == first['version_id']
    assert pin['items'] and pin['policy'] and 'rates' not in pin

    # A later publication leaves the draft on the table it started with.
    current['uid'] = 'owner'
    second = _publish_v2(client, _v2_table('45.00'), 'Raise every price')
    assert second['version_id'] != first['version_id']
    assert store.db.records['_job_pricing/' + ID]['version_id'] == first['version_id']

    # What the screen reads is that pinned table, not the newer one.
    current['uid'] = 'estimator'
    view = client.get('/api/inspections/' + ID + '/pricing').json()
    assert view['calculation_version'] == V2
    assert view['table']['version_id'] == first['version_id']
    assert view['newer_available'] is True
    assert {i['unit_price'] for i in view['table']['items'] if i['unit_price']} == {'30.00'}


def test_copying_a_signed_job_pins_the_copy_like_any_new_v2_draft(api, enabled):  # noqa: F811
    client, current, store = api
    current['uid'] = 'estimator'
    record = client.post('/api/inspections', json={'inspection_id': ID, 'data': data()}).json()
    record = client.post(
        '/api/audit', json={'inspection_id': ID, 'expected_revision': record['revision']}
    ).json()
    current['uid'] = 'owner'
    signed = client.post('/api/authorize', json=sign_payload(record))
    assert signed.status_code == 200, signed.text
    first = _publish_v2(client, _v2_table('30.00'))
    current['uid'] = 'estimator'
    copied = client.post(
        '/api/authorizations/' + signed.json()['auth_id'] + '/copy',
        json={'inspection_id': OTHER},
    )
    assert copied.status_code == 200, copied.text
    assert store.db.records['_job_pricing/' + OTHER]['version_id'] == first['version_id']
    # A later publication leaves the copy on the table it started with.
    current['uid'] = 'owner'
    _publish_v2(client, _v2_table('45.00'), 'Raise every price')
    current['uid'] = 'estimator'
    view = client.get('/api/inspections/' + OTHER + '/pricing').json()
    assert view['table']['version_id'] == first['version_id']


def test_seed_quantities_are_the_table_defaults_and_no_sheet_charge_it_lacks():
    table = {
        'version_id': 'version-1',
        'items': [
            dict(
                item_id=item_id,
                group=group,
                quantity_source=source,
                default_quantity=default,
                enabled=enabled,
            )
            for item_id, group, source, default, enabled in (
                ('service_call', 'job_charges', 'field:emergency_calls', '2', True),
                ('monitoring', 'job_charges', 'field:monitoring_hours', '9999', True),
                ('hepa', 'job_charges', 'field:hepa_filters', '4', False),
                ('fans', 'drying_equipment', 'count_days:air_movers*drying_days', '3', True),
                ('setup', 'job_charges', 'typed', '2.5', True),
                ('zero', 'job_charges', 'typed', '0', True),
                ('crew', 'labor', 'typed_count_days', '2', True),
            )
        ],
    }
    start = bm.inspection_payload(InspectionData(address='Office intake'))
    before = json.dumps(start, sort_keys=True)
    seeded = price_table.seed_quantities(start, table)
    assert json.dumps(start, sort_keys=True) == before, 'the input is not changed'
    assert seeded['seeded_from_version'] == 'version-1'
    assert seeded['emergency_calls'] == 2
    assert seeded['monitoring_hours'] == 500
    assert seeded['air_movers'] == 3
    assert (seeded['haul_loads'], seeded['air_scrubbers'], seeded['hepa_filters']) == (0, 0, 0)
    assert seeded['scope_items'] == {
        'setup': {'quantity': '2.5', 'count': 0, 'days': 0},
        'crew': {'quantity': '0', 'count': 2, 'days': 3},
    }
    # The stored shape is what the contract accepts and saves back unchanged.
    assert bm.inspection_payload(InspectionData.model_validate(seeded)) == seeded


def test_office_create_is_seeded_by_the_server_only_on_a_v2_table(api, enabled):  # noqa: F811
    client, current, store = api
    empty = bm.inspection_payload(InspectionData(address='Office intake'))
    current['uid'] = 'office'
    made = client.post('/api/inspections', json={'inspection_id': OTHER, 'data': empty})
    assert made.status_code == 200, made.text
    assert made.json()['data'] == empty, 'no v2 table, nothing to seed'

    current['uid'] = 'owner'
    published = _publish_v2(client, _v2_table('30.00'))
    current['uid'] = 'office'
    made = client.post('/api/inspections', json={'inspection_id': ID, 'data': empty})
    assert made.status_code == 200, made.text
    saved = made.json()['data']
    assert saved['seeded_from_version'] == published['version_id']
    assert saved['monitoring_hours'] != empty['monitoring_hours']
    assert saved['address'] == 'Office intake'
    assert store.db.records['inspections/' + ID]['data'] == saved
    # An office job still has to start empty: a client cannot send its own quantities.
    worked = {**empty, 'air_movers': 3}
    refused = client.post(
        '/api/inspections', json={'inspection_id': 'ADR-INS-' + 'e' * 32, 'data': worked}
    )
    assert refused.status_code == 403, refused.text


def test_office_create_is_not_seeded_with_the_flag_off(api):
    client, current, store = api
    empty = bm.inspection_payload(InspectionData(address='Office intake'))
    current['uid'] = 'office'
    made = client.post('/api/inspections', json={'inspection_id': ID, 'data': empty})
    assert made.status_code == 200, made.text
    assert made.json()['data'] == empty


def test_the_seed_version_never_reaches_a_model():
    from backend import prompts
    from backend.scope import scope_prompt

    draft = bm.inspection_payload(
        InspectionData(address='300 Elm St', year_built=1990, seeded_from_version='version-secret')
    )
    assert draft['seeded_from_version'] == 'version-secret'
    for prompt in (
        prompts.audit_prompt(draft, [], {}),
        prompts.live_prompt(draft),
        scope_prompt(InspectionData.model_validate(draft), None),
    ):
        assert 'version-secret' not in prompt


def test_create_leaves_office_and_v1_companies_unpinned(api, enabled):  # noqa: F811
    client, current, store = api
    current['uid'] = 'owner'
    _publish_v2(client, _v2_table('30.00'))
    # Office staff cannot audit, so their empty-scope draft is pinned at its first audit instead.
    current['uid'] = 'office'
    empty = bm.inspection_payload(bm.InspectionData(address='Office intake'))
    made = client.post('/api/inspections', json={'inspection_id': OTHER, 'data': empty})
    assert made.status_code == 200, made.text
    assert '_job_pricing/' + OTHER not in store.db.records
    # A company whose head is still the v1 rate book keeps pinning at its first audit.
    current['uid'] = 'other-owner'
    made = client.post(
        '/api/inspections', json={'inspection_id': 'ADR-INS-' + 'f' * 32, 'data': data()}
    )
    assert made.status_code in (200, 403), made.text
    assert '_job_pricing/ADR-INS-' + 'f' * 32 not in store.db.records


def audit(client):
    return client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})


def test_audit_returns_409_when_prices_are_not_set(api, enabled):  # noqa: F811
    client, current, store = api
    current['uid'] = 'other-owner'
    made = client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    assert made.status_code == 200, made.text
    response = audit(client)
    assert response.status_code == 409, response.text
    assert 'prices' in response.json()['detail'].lower()
    assert '_job_pricing/' + ID not in store.db.records


def test_v1_audit_still_prices_through_the_dispatch(api, enabled):  # noqa: F811
    client, current, store = api
    current['uid'] = 'estimator'
    made = client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    assert made.status_code == 200, made.text
    audited = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
    assert audited.status_code == 200, audited.text
    documents = audited.json()['audit']['documents']
    assert documents['price_basis']['calculation_version'] == price_books.CALCULATION_VERSION
    assert documents['adr_estimate']['proposed_cost_low'] > 0


# Cases the device mirror (public/core.js) must answer exactly like backend/readiness.py.
READINESS_CASES = [
    ('no pricing context', None, []),
    ('v2 table with demolition basis', {'prices_set': True, 'area_basis': 'demolition'}, []),
    (
        'wet floor basis names only a room with neither area',
        {'prices_set': True, 'area_basis': 'wet_floor'},
        ['area_basis:Hall'],
    ),
    ('company prices not set up', {'prices_set': False}, ['prices']),
]
READINESS_DATA = {
    'address': 'Synthetic property',
    'year_built': 2000,
    'rooms': [
        {'name': 'Hall', 'loss': 'mold', 'category': 3, 'finished_sf': 5},
        {'name': 'Den', 'loss': 'mold', 'category': 3, 'finished_sf': 5, 'wet_floor_sf': 20},
        # A deliberate 0 (only the walls are wet) and a whole-floor room are both answers.
        {'name': 'Bath', 'loss': 'mold', 'category': 3, 'finished_sf': 5, 'wet_floor_sf': 0},
        {'name': 'Attic', 'loss': 'mold', 'category': 3, 'finished_sf': 5, 'floor_sf': 30},
    ],
    'air_movers': 1,
    'scope_confirmed': True,
}


@pytest.mark.parametrize('case', READINESS_CASES, ids=lambda c: c[0])
def test_readiness_prices_and_area_basis_gaps(case):
    name, pricing, expected = case
    result = readiness(READINESS_DATA, [], {}, [], pricing)
    found = [
        g['code'] + (':' + g['room'] if g['room'] else '')
        for g in result['gaps']
        if g['code'] in ('prices', 'area_basis')
    ]
    assert found == expected
    script = (
        "const c=require('./public/core.js');const f=JSON.parse(process.argv[1]);"
        'console.log(JSON.stringify({state:c.readiness(f.data,[],{},[],f.pricing),'
        'list:c.missingItems(f.data,[],{},[],f.pricing)}));'
    )
    shown = json.loads(
        subprocess.run(
            ['node', '-e', script, json.dumps({'data': READINESS_DATA, 'pricing': pricing})],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=True,
        ).stdout
    )
    assert shown['state'] == result
    assert shown['list'] == [
        (g['room'] + ': ' if g['room'] else '') + g['text'] for g in result['gaps']
    ]


def test_saved_readiness_reports_a_wet_floor_basis_gap(api, enabled, monkeypatch):  # noqa: F811
    client, current, store = api
    monkeypatch.setattr(ai_features, 'AI_FEATURES', frozenset({'readiness'}))
    current['uid'] = 'owner'
    table = _v2_table('30.00')
    table['policy']['area_basis'] = 'wet_floor'
    _publish_v2(client, table)
    current['uid'] = 'estimator'
    made = client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    assert made.status_code == 200, made.text
    gaps = client.get('/api/inspections/' + ID).json()['readiness']['gaps']
    codes = [g['code'] for g in gaps]
    assert 'area_basis' in codes and 'prices' not in codes
    # A company on the demolition basis is never asked for a wet floor area.
    current['uid'] = 'owner'
    demolition = _v2_table('31.00')
    _publish_v2(client, demolition, 'Back to demolition area')
    current['uid'] = 'estimator'
    again = client.post('/api/inspections', json={'inspection_id': OTHER, 'data': data()})
    assert again.status_code == 200, again.text
    codes = [g['code'] for g in client.get('/api/inspections/' + OTHER).json()['readiness']['gaps']]
    assert 'area_basis' not in codes


def test_saved_readiness_flags_a_company_with_no_published_prices(api, enabled):  # noqa: F811
    client, current, store = api
    current['uid'] = 'other-owner'
    made = client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    assert made.status_code == 200, made.text
    record = store.get_inspection('other-owner', ID)
    assert anyio.run(bm.readiness_pricing, store, 'other-owner', record) == {'prices_set': False}
    # ADR always has its own prices, and a published v2 table reports its area basis.
    current['uid'] = 'estimator'
    made = client.post('/api/inspections', json={'inspection_id': OTHER, 'data': data()})
    assert made.status_code == 200, made.text
    record = store.get_inspection('estimator', OTHER)
    assert anyio.run(bm.readiness_pricing, store, 'estimator', record) is None
    current['uid'] = 'owner'
    _publish_v2(client, _v2_table('30.00'))
    assert anyio.run(bm.readiness_pricing, store, 'estimator', record) == {
        'prices_set': True,
        'area_basis': 'demolition',
    }


def test_saved_readiness_flags_no_prices_with_the_price_editor_flag_off(api):
    client, current, store = api
    assert price_books.price_books_enabled() is False
    current['uid'] = 'other-owner'
    made = client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    assert made.status_code == 200, made.text
    record = store.get_inspection('other-owner', ID)
    assert anyio.run(bm.readiness_pricing, store, 'other-owner', record) == {'prices_set': False}


def overridden(**override):
    job = data()
    job['air_movers'] = 5
    job['quantity_overrides'] = {'air_movers': override}
    return job


@pytest.mark.parametrize(
    'override',
    [
        {'measured': '3', 'entered': '5'},
        {'measured': '3', 'entered': '5', 'reason': None},
        {'measured': '3', 'entered': '5', 'reason': '     '},
        {'measured': '3', 'entered': '5', 'reason': 'no'},
        {'measured': '3', 'entered': '4', 'reason': 'Stale entered value'},
    ],
    ids=['no reason', 'null reason', 'blank reason', 'short reason', 'stale entered'],
)
def test_saves_refuse_a_changed_walkthrough_value_without_a_current_reason(api, override):
    client, current, store = api
    current['uid'] = 'estimator'
    refused = client.post(
        '/api/inspections', json={'inspection_id': ID, 'data': overridden(**override)}
    )
    assert refused.status_code == 422, refused.text
    assert ID not in str(list(store.db.records))
    made = client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    assert made.status_code == 200, made.text
    refused = client.put(
        '/api/inspections/' + ID,
        json={'expected_revision': 1, 'data': overridden(**override)},
    )
    assert refused.status_code == 422, refused.text
    assert store.get_inspection('estimator', ID)['revision'] == 1


def test_measured_value_is_stored_with_the_job_and_round_trips_unchanged(api):
    client, current, store = api
    current['uid'] = 'estimator'
    job = data()
    job['air_movers'] = 3
    job['quantity_overrides'] = {'air_movers': {'measured': '3', 'entered': '3'}}
    made = client.post('/api/inspections', json={'inspection_id': ID, 'data': job})
    assert made.status_code == 200, made.text
    # No reason key appears: the phone's copy and the server's must compare equal.
    assert made.json()['data']['quantity_overrides'] == job['quantity_overrides']
    job = overridden(measured='3', entered='5', reason='  Two more   fans ')
    saved = client.put('/api/inspections/' + ID, json={'expected_revision': 1, 'data': job})
    assert saved.status_code == 200, saved.text
    assert saved.json()['data']['quantity_overrides']['air_movers'] == {
        'measured': '3',
        'entered': '5',
        'reason': 'Two more fans',
    }


def test_room_overrides_must_name_a_room_and_a_measured_field():
    room = dict(name='Kitchen: east', finished_sf=95, wet_floor_sf=None)
    good = {'measured': '80', 'entered': '95', 'reason': 'Wet behind the pantry'}

    def build(key, value=good):
        return InspectionData(rooms=[room], quantity_overrides={key: value})

    # The room name may itself hold a colon.
    CreateInspection(inspection_id=ID, data=build('Kitchen: east:finished_sf'))
    UpdateInspection(expected_revision=1, data=build('Kitchen: east:finished_sf'))
    # A blank area reads as 0, so clearing a measured value needs a reason too.
    blanked = {'measured': '80', 'entered': '0', 'reason': 'Whole floor after all'}
    CreateInspection(inspection_id=ID, data=build('Kitchen: east:wet_floor_sf', blanked))
    for key in ('Pantry:finished_sf', 'Kitchen: east:category', 'not_a_field', 'address'):
        with pytest.raises(ValidationError):
            CreateInspection(inspection_id=ID, data=build(key))


def test_audit_refuses_a_saved_override_that_no_longer_matches_the_job(api, enabled):  # noqa: F811
    client, current, store = api
    current['uid'] = 'estimator'
    made = client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    assert made.status_code == 200, made.text
    stale = overridden(measured='3', entered='4', reason='Stale entered value')
    stored = next(
        value
        for value in store.db.records.values()
        if isinstance(value, dict) and value.get('inspection_id') == ID and 'data' in value
    )
    stored['data'] = bm.inspection_payload(InspectionData.model_validate(stale))
    response = audit(client)
    assert response.status_code == 400, response.text
    assert 'does not match the entered value' in response.json()['detail']


def test_whole_number_items_refuse_a_fractional_default_quantity():
    def row(source, default):
        return {
            'item_id': 'sample_item',
            'group': 'job_charges',
            'name': 'Sample item',
            'unit': 'each',
            'quantity_source': source,
            'unit_price': '10.00',
            'default_quantity': default,
        }

    for field in (
        'emergency_calls',
        'haul_loads',
        'air_scrubbers',
        'hepa_filters',
        'matterport_scans',
        'dump_truck_loads',
        'equipment_decon',
        'power_distribution',
    ):
        with pytest.raises(ValueError, match='whole number'):
            price_table.normalize_items([row('field:' + field, '1.5')], publish=True)
        assert price_table.normalize_items([row('field:' + field, '2')], publish=True)
    for source in ('count_days:air_movers*drying_days', 'typed_count_days'):
        with pytest.raises(ValueError, match='whole number'):
            price_table.normalize_items([row(source, '1.5')], publish=True)
        assert price_table.normalize_items([row(source, '2')], publish=True)
    for source, default in (
        ('field:monitoring_hours', '13.25'),
        ('field:labor_hours', '1.5'),
        ('typed', '2.5'),
    ):
        normalized = price_table.normalize_items([row(source, default)], publish=True)
        assert normalized[0]['default_quantity'] == default


def test_scope_prompt_accepts_company_price_quantities_and_never_offers_them_to_the_model():
    from backend.scope import scope_prompt

    job = InspectionData.model_validate(
        {
            'address': 'Synthetic property',
            'scope_items': {'setup_documentation': {'quantity': 2.5}},
            'quantity_overrides': {
                'air_movers': {'measured': 3, 'entered': 5, 'reason': 'Two more in the hall'}
            },
        }
    )
    prompt = scope_prompt(job, None)
    assert 'setup_documentation' not in prompt and 'Two more in the hall' not in prompt


def test_scope_suggestions_validate_on_a_job_with_company_price_quantities():
    from backend.scope import ScopeChange, ScopeSuggestions, validate_suggestions

    job = InspectionData.model_validate(
        {
            'address': 'Synthetic property',
            'technician_notes': 'Use 3 fans.',
            'scope_items': {'setup_documentation': {'quantity': 2.5}},
            'quantity_overrides': {
                'air_movers': {'measured': 3, 'entered': 5, 'reason': 'Two more in the hall'}
            },
        }
    )
    checked = validate_suggestions(
        job,
        ScopeSuggestions(
            changes=[ScopeChange(field='air_movers', value=3, source_quote='Use 3 fans.')],
            questions=[],
        ),
    )
    assert [c.field for c in checked.changes] == ['air_movers']


SIZED_ROOM = {
    'name': 'Kitchen',
    'category': 2,
    'loss': 'water',
    'unfinished_sf': 0,
    'finished_sf': 80,
    'floor_sf': 140,
    'ceiling_height_ft': 8,
    'water_class': 2,
}


def sized_job(**values):
    job = data()
    job.update(
        rooms=[dict(SIZED_ROOM)],
        technician_notes='Kitchen drywall is wet. Use 3 fans.',
        air_movers=0,
        dehumidifiers=0,
        dehumidifier_ppd=70,
    )
    job.update(values)
    return job


def fill(client, monkeypatch, changes=(), revision=1):
    async def generate(schema, *args, check=None, **kwargs):
        assert schema is bm.ScopeSuggestions
        result = bm.ScopeSuggestions(changes=list(changes), questions=[])
        if check:
            check(result)
        return result

    monkeypatch.setattr(bm, 'generate', generate)
    response = client.post(
        '/api/inspections/' + ID + '/scope-suggestions',
        json={'inspection_id': ID, 'expected_revision': revision},
    )
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture
def assist_on(monkeypatch):
    monkeypatch.setattr(ai_features, 'AI_FEATURES', {'estimate_assist'})


def on_table(client, current, job=None):
    current['uid'] = 'owner'
    _publish_v2(client, _v2_table('30.00'))
    current['uid'] = 'estimator'
    made = client.post('/api/inspections', json={'inspection_id': ID, 'data': job or sized_job()})
    assert made.status_code == 200, made.text


def test_scope_suggestions_carry_suggested_counts_only_with_the_flag_and_a_v2_table(
    api,
    enabled,  # noqa: F811
    assist_on,
    monkeypatch,
):
    client, current, store = api
    on_table(client, current)
    body = fill(client, monkeypatch)
    assert [(row['field'], row['value']) for row in body['suggested']] == [
        ('air_movers', 3),
        ('dehumidifiers', 1),
    ]
    assert body['suggested'][0]['basis'] == (
        'IICRC S500 minimum for 140 sq ft of wet floor across 1 room; the maximum is 4.'
    )
    # Nothing is written: the phone applies them and the technician reviews them.
    assert store.get_inspection('estimator', ID)['data']['air_movers'] == 0

    monkeypatch.setattr(ai_features, 'AI_FEATURES', set())
    assert fill(client, monkeypatch)['suggested'] == []
    assert 'estimate_assist' not in session(client, current, 'estimator')['ai_features']
    monkeypatch.setattr(ai_features, 'AI_FEATURES', {'estimate_assist'})
    assert 'estimate_assist' in session(client, current, 'estimator')['ai_features']


def test_scope_suggestions_stay_empty_on_a_rate_book_draft(api, assist_on, monkeypatch):
    client, current, store = api
    current['uid'] = 'estimator'
    made = client.post('/api/inspections', json={'inspection_id': ID, 'data': sized_job()})
    assert made.status_code == 200, made.text
    assert fill(client, monkeypatch)['suggested'] == []


def test_a_draft_held_on_the_rate_book_gets_no_suggestions_after_its_company_switches(
    api,
    enabled,  # noqa: F811
    assist_on,
    monkeypatch,
):
    client, current, store = api
    current['uid'] = 'owner'
    publish(client, rates(emergency_call='150.00'))
    current['uid'] = 'estimator'
    made = client.post('/api/inspections', json={'inspection_id': ID, 'data': sized_job()})
    assert made.status_code == 200, made.text
    current['uid'] = 'owner'
    switch(client)
    current['uid'] = 'estimator'
    assert session(client, current, 'estimator')['pricing_version'] == V2
    held = store.workspaces.prices.job_view('estimator', store.get_inspection('estimator', ID))
    assert held['calculation_version'] != V2
    assert fill(client, monkeypatch)['suggested'] == []


def test_a_spoken_count_wins_over_the_suggestion(api, enabled, assist_on, monkeypatch):  # noqa: F811
    from backend.scope import ScopeChange

    client, current, store = api
    on_table(client, current)
    spoken = ScopeChange(field='air_movers', value=2, source_quote='Use 3 fans.')
    body = fill(client, monkeypatch, [spoken])
    assert [change['value'] for change in body['changes']] == [2]
    assert [row['field'] for row in body['suggested']] == ['dehumidifiers']


def test_a_spoken_count_already_on_the_form_stays_too(api, enabled, assist_on, monkeypatch):  # noqa: F811
    from backend.scope import ScopeChange

    client, current, store = api
    on_table(client, current, sized_job(air_movers=2))
    same = ScopeChange(field='air_movers', value=2, source_quote='Use 3 fans.')
    body = fill(client, monkeypatch, [same])
    # Validation drops the no-op change, and the technician still said the number.
    assert body['changes'] == []
    assert [row['field'] for row in body['suggested']] == ['dehumidifiers']


def test_a_count_an_earlier_fill_raised_rises_again_when_a_room_is_added(
    api,
    enabled,  # noqa: F811
    assist_on,
    monkeypatch,
):
    from backend.scope import ScopeChange

    client, current, store = api
    on_table(client, current, sized_job(air_movers=1))
    first = {row['field']: row['value'] for row in fill(client, monkeypatch)['suggested']}
    raised = first['air_movers']
    # What the phone saves after that fill, and then a second room on the job.
    recorded = {'air_movers': {'measured': str(raised), 'entered': str(raised)}}
    saved = client.put(
        '/api/inspections/' + ID,
        json={
            'expected_revision': 1,
            'data': sized_job(
                air_movers=raised,
                quantity_overrides=recorded,
                rooms=[SIZED_ROOM, {**SIZED_ROOM, 'name': 'Hall'}],
            ),
        },
    )
    assert saved.status_code == 200, saved.text
    second = fill(client, monkeypatch, revision=2)['suggested']
    assert [row['field'] for row in second][0] == 'air_movers'
    assert second[0]['value'] > raised
    # The technician saying the count in this fill still wins over the larger minimum.
    said = ScopeChange(field='air_movers', value=raised, source_quote='Use 3 fans.')
    held = fill(client, monkeypatch, [said], revision=2)
    assert 'air_movers' not in [row['field'] for row in held['suggested']]


def test_rereading_never_undoes_an_explained_count(api, enabled, assist_on, monkeypatch):  # noqa: F811
    client, current, store = api
    on_table(
        client,
        current,
        sized_job(
            air_movers=2,
            quantity_overrides={
                'air_movers': {'measured': '3', 'entered': '2', 'reason': 'Small wet patch only'}
            },
        ),
    )
    assert [row['field'] for row in fill(client, monkeypatch)['suggested']] == ['dehumidifiers']


def test_suggested_counts_run_on_the_filled_job_not_the_saved_one(
    api,
    enabled,  # noqa: F811
    assist_on,
    monkeypatch,
):
    from backend.scope import ScopeChange

    client, current, store = api
    # The saved room has no sizing inputs; the walkthrough states them in the same fill.
    bare = {**SIZED_ROOM, 'floor_sf': None, 'ceiling_height_ft': None, 'water_class': None}
    on_table(client, current, sized_job(rooms=[bare]))
    quote = 'Kitchen drywall is wet.'
    changes = [
        ScopeChange(field='floor_sf', room='Kitchen', value=350, source_quote=quote),
        ScopeChange(field='ceiling_height_ft', room='Kitchen', value=8, source_quote=quote),
        ScopeChange(field='water_class', room='Kitchen', value=2, source_quote=quote),
    ]
    assert [
        (row['field'], row['value']) for row in fill(client, monkeypatch, changes)['suggested']
    ] == [
        ('air_movers', 6),
        ('dehumidifiers', 1),
    ]


def test_a_count_the_table_does_not_list_is_left_alone(api, enabled, assist_on, monkeypatch):  # noqa: F811
    client, current, store = api
    table = _v2_table('30.00')
    for item in table['items']:
        if 'air_movers' in item['quantity_source']:
            item['enabled'] = False
    current['uid'] = 'owner'
    _publish_v2(client, table)
    current['uid'] = 'estimator'
    made = client.post('/api/inspections', json={'inspection_id': ID, 'data': sized_job()})
    assert made.status_code == 200, made.text
    # The v2 form has no air mover input here, so a raised count could not be corrected.
    assert [row['field'] for row in fill(client, monkeypatch)['suggested']] == ['dehumidifiers']


def test_the_suggested_count_is_recorded_like_a_walkthrough_value(api, enabled):  # noqa: F811
    client, current, store = api
    # What the phone saves after applying a suggestion: measured and entered at the suggestion.
    recorded = {'air_movers': {'measured': '3', 'entered': '3'}}
    on_table(client, current, sized_job(air_movers=3, quantity_overrides=recorded))
    lowered = sized_job(air_movers=2, quantity_overrides=recorded)
    refused = client.put('/api/inspections/' + ID, json={'expected_revision': 1, 'data': lowered})
    assert refused.status_code == 422, refused.text
    no_reason = {'air_movers': {'measured': '3', 'entered': '2'}}
    refused = client.put(
        '/api/inspections/' + ID,
        json={
            'expected_revision': 1,
            'data': sized_job(air_movers=2, quantity_overrides=no_reason),
        },
    )
    assert refused.status_code == 422, refused.text
    assert store.get_inspection('estimator', ID)['revision'] == 1
    reason = {'air_movers': {'measured': '3', 'entered': '2', 'reason': 'Small wet patch only'}}
    saved = client.put(
        '/api/inspections/' + ID,
        json={'expected_revision': 1, 'data': sized_job(air_movers=2, quantity_overrides=reason)},
    )
    assert saved.status_code == 200, saved.text


def test_a_new_v2_draft_starts_at_the_tables_drying_days(api, enabled):  # noqa: F811
    client, current, store = api
    table = _v2_table('30.00')
    table['policy']['assist']['drying_days'] = 5
    current['uid'] = 'owner'
    _publish_v2(client, table)
    assert client.get('/api/companies/adr/prices').json()['policy']['assist']['drying_days'] == 5
    # An office-created job is seeded on the server, from the table, and holds no measured value.
    current['uid'] = 'office'
    empty = bm.inspection_payload(InspectionData(address='Office intake'))
    made = client.post('/api/inspections', json={'inspection_id': ID, 'data': empty})
    assert made.status_code == 200, made.text
    assert made.json()['data']['drying_days'] == 5
    assert not made.json()['data'].get('quantity_overrides')
