"""Estimator screens for company price tables: session version, create-time pin, audit pre-check, readiness."""

import json
import subprocess
from pathlib import Path

import pytest
import backend.main as bm
from backend import ai_features, price_books, price_table
from backend.inspection_store import Conflict
from backend.pricing import PricedJob
from backend.readiness import readiness
from tests.test_price_books import _publish_v2, _v2_table, enabled  # noqa: F401
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
    # Another company's table never leaks to this one's session.
    assert session(client, current, 'other-owner')['pricing_version'] != V2


def test_session_pricing_version_is_absent_with_the_flag_off(api):
    client, current, store = api
    assert price_books.price_books_enabled() is False
    assert session(client, current, 'estimator')['pricing_version'] is None


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


def prepare_audit(client, current, store):
    current['uid'] = 'owner'
    _publish_v2(client, _v2_table('30.00'))
    current['uid'] = 'estimator'
    made = client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    assert made.status_code == 200, made.text


def let_v2_pin_through(store, monkeypatch):
    """Until the engine PR, ensure_pin refuses a v2 pin to a pricing caller; let the pre-check see it."""
    prices = store.workspaces.prices
    original = prices.ensure_pin
    monkeypatch.setattr(
        prices,
        'ensure_pin',
        lambda uid, inspection_id, priceable_only=False: original(uid, inspection_id),
    )


def audit(client):
    return client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})


def test_audit_precheck_uses_price_and_range_on_the_pinned_table(api, enabled, monkeypatch):  # noqa: F811
    client, current, store = api
    prepare_audit(client, current, store)
    let_v2_pin_through(store, monkeypatch)
    seen = []

    def priced(inspection, pin):
        seen.append(pin)
        raise NotImplementedError('dryscope-v2 pricing is not available yet')

    monkeypatch.setattr(bm, 'price_and_range', priced)
    response = audit(client)
    assert response.status_code == 409, response.text
    assert 'price list' in response.json()['detail']
    # The pre-check priced the job from the pin made when the draft was created.
    assert seen and seen[0]['calculation_version'] == V2 and seen[0]['items']

    def too_small(inspection, pin):
        raise ValueError('The priced scope totals $0.00. Enter at least one quantity.')

    monkeypatch.setattr(bm, 'price_and_range', too_small)
    response = audit(client)
    assert response.status_code == 400, response.text
    assert response.json()['detail'].startswith('The priced scope totals $0.00')


def test_audit_precheck_refuses_a_job_that_prices_to_nothing(api, enabled, monkeypatch):  # noqa: F811
    client, current, store = api
    prepare_audit(client, current, store)
    let_v2_pin_through(store, monkeypatch)

    def free(inspection, pin):
        return PricedJob(lines=[], totals=None, calculation_version=V2, xactimate_total=0)

    monkeypatch.setattr(bm, 'price_and_range', free)
    response = audit(client)
    assert response.status_code == 400, response.text
    assert 'Add measured work' in response.json()['detail']


def test_audit_returns_409_when_prices_are_not_set(api, enabled, monkeypatch):  # noqa: F811
    client, current, store = api
    prepare_audit(client, current, store)
    seen = []

    def unset(uid, inspection_id, priceable_only=False):
        raise Conflict('Company prices are not set. The owner publishes prices under Prices first.')

    monkeypatch.setattr(store.workspaces.prices, 'ensure_pin', unset)
    monkeypatch.setattr(bm, 'price_and_range', lambda inspection, pin: seen.append(pin))
    response = audit(client)
    assert response.status_code == 409, response.text
    assert 'Company prices are not set' in response.json()['detail']
    assert not seen, 'nothing is priced without a table'


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
        'wet floor basis names each room without a wet area',
        {'prices_set': True, 'area_basis': 'wet_floor'},
        ['area_basis:Hall'],
    ),
    ('company prices not set up', {'prices_set': False}, ['prices']),
]
READINESS_DATA = {
    'address': 'Synthetic property',
    'year_built': 2000,
    'rooms': [
        {'name': 'Hall', 'loss': 'mold', 'category': 3, 'finished_sf': 5, 'wet_floor_sf': 0},
        {'name': 'Den', 'loss': 'mold', 'category': 3, 'finished_sf': 5, 'wet_floor_sf': 20},
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


def test_scope_prompt_accepts_company_price_quantities_and_never_offers_them_to_the_model():
    from backend.contracts import InspectionData
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
    from backend.contracts import InspectionData
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
