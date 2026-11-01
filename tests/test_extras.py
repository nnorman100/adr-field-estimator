"""Priced extras: actual policy, pricing, revision and signing boundaries."""

from copy import deepcopy
from decimal import Decimal
import pytest
from pydantic import ValidationError
from backend import ai_features
from backend.claims import make_documents, price_scope, proposal_range
from backend.contracts import Extra, ExtraApprove, InspectionData, AIResult
from backend.cloud_log import LOG_FIELDS
from backend.inspection_store import Conflict, Limited
from backend.workspaces import CompanyProfile, ProfileUpdate
from tests.test_workspaces import api, store, data, ID
from tests.test_backend import sign_payload

EXTRA_ID = 'e' * 32
TASK = 'Move and reset toilet'


def proposed(**changes):
    return dict(
        id=EXTRA_ID,
        description=TASK,
        hours='2.5',
        origin='manual',
        unpriced_item=TASK,
        approval=None,
        **changes,
    )


def approved():
    extra = proposed()
    extra['approval'] = dict(
        accepted_by_uid='owner',
        accepted_by_name='Test Owner',
        accepted_at='2026-10-25T12:00:00Z',
        rate='47.46',
        total='118.65',
        company_id='adr',
        company_version=1,
    )
    return extra


@pytest.mark.parametrize('hours', ['0', '0.24', '201', 'NaN', 'Infinity', '1.001'])
def test_extra_hours_bounds(hours):
    extra = proposed()
    extra['hours'] = hours
    with pytest.raises(ValidationError):
        Extra.model_validate(extra)


def test_extra_disallows_ai_hours_and_client_prices():
    for key, value in [('origin', 'ai_accepted'), ('unit_price', '0.01')]:
        extra = proposed()
        extra[key] = value
        with pytest.raises(ValidationError):
            Extra.model_validate(extra)


@pytest.mark.parametrize(
    'after_hours,sf', [(False, 10), (True, 10), (False, 1001), (True, 1001)]
)
def test_decimal_price_range_exact_wording_and_unpriced_coverage(after_hours, sf):
    values = data()
    values['rooms'][0]['finished_sf'] = sf
    values['is_after_hours'] = after_hours
    original = InspectionData.model_validate(values)
    values['extras'] = [approved()]
    scope = InspectionData.model_validate(values)
    lines, total = price_scope(scope)
    assert lines[-1]['code'] == 'ADR-EXTRA'
    assert lines[-1]['total'] == 118.65
    assert Decimal(str(total)) - Decimal(str(price_scope(original)[1])) == Decimal('118.65')
    old_low, old_high = proposal_range(original, price_scope(original)[0])
    low, high = proposal_range(scope, lines)
    # Approved extras are job-charge-like: the exact approved amount, unmarked, in both bounds.
    assert low - old_low == Decimal('118.65')
    assert high - old_high == Decimal('118.65')
    ai = AIResult(summary='Proposed work', suggestions=[], unpriced_work=[TASK])
    docs = make_documents(
        scope,
        [],
        ai,
        dict(
            company_id='adr',
            version=1,
            name='Test Co',
            address='Office',
            phone='',
            email='',
            license='1',
            signoff='Estimator',
        ),
    )
    sentence = 'Additional work, not in Test Co price sheet: Move and reset toilet, 2.5 h at $47.46/h, approved by Test Owner on 2026-10-25.'
    assert docs['adr_estimate']['recommendations'].count(sentence) == 1
    assert docs['xactimate_scope'][-1]['description'] == sentence
    assert docs['iicrc_defense_letter'].count(sentence) == 1
    assert docs['signable'] and docs['unpriced_work'] == []
    ai.unpriced_work.append('Unrelated cabinet work')
    assert not make_documents(scope, [], ai)['signable']
    values['extras'].append(dict(proposed(), id='f' * 32))
    pending = make_documents(
        InspectionData.model_validate(values),
        [],
        AIResult(summary='OK', suggestions=[], unpriced_work=[]),
    )
    assert pending['pending_extras'] == 1 and not pending['signable']


def test_extras_limit():
    with pytest.raises(ValidationError):
        InspectionData(extras=[proposed() for _ in range(31)])


def create(client, current):
    current['uid'] = 'estimator'
    result = client.post(
        '/api/inspections', json={'inspection_id': ID, 'data': dict(data(), extras=[proposed()])}
    )
    assert result.status_code == 200, result.text
    return result.json()


def approve(client, record, version=1):
    return client.post(
        f'/api/inspections/{ID}/extras/{EXTRA_ID}/approve',
        json=dict(
            expected_revision=record['revision'],
            expected_company_version=version,
            owner_name='Test Owner',
        ),
    )


def audit(client, record):
    result = client.post(
        '/api/audit', json=dict(inspection_id=ID, expected_revision=record['revision'])
    )
    assert result.status_code == 200, result.text
    return result.json()


def test_role_matrix_and_pending_signing(api, monkeypatch):
    client, current, db = api
    monkeypatch.setattr(ai_features, 'AI_FEATURES', {'priced_extras'})
    record = create(client, current)
    quote = client.post(f'/api/inspections/{ID}/extras/quote', json={'hours': '2.5'})
    assert quote.json() == {'rate': '47.46', 'total': '118.65', 'company_version': 1}
    record = audit(client, record)
    assert not record['audit']['documents']['signable']
    assert client.post('/api/authorize', json=sign_payload(record)).status_code == 409
    for uid in ('estimator', 'estimator2', 'office', 'admin', 'other-owner'):
        current['uid'] = uid
        assert approve(client, record).status_code in (403, 404)
    current['uid'] = 'owner'
    result = approve(client, record)
    assert result.status_code == 200, result.text
    accepted = result.json()
    assert accepted['revision'] == record['revision'] + 1 and accepted['audit'] is None
    assert accepted['data']['extras'][0]['approval']['accepted_by_uid'] == 'owner'
    assert any(
        e['action'] == 'extra_approved'
        for key, e in db.db.records.items()
        if key.startswith('_admin_events/')
    )
    record = audit(client, accepted)
    assert record['audit']['documents']['signable']
    signature = client.post('/api/authorize', json=sign_payload(record))
    assert signature.status_code == 200, signature.text
    before = deepcopy(db.db.records)
    assert approve(client, record).status_code == 409
    changed = dict(record['data'], extras=[])
    assert (
        client.put(
            '/api/inspections/' + ID, json=dict(expected_revision=record['revision'], data=changed)
        ).status_code
        == 409
    )
    for key in before:
        if key.startswith('authorizations/'):
            assert db.db.records[key] == before[key]


def test_rate_change_keeps_approved_rate_and_copies_require_approval(api, monkeypatch):
    client, current, db = api
    monkeypatch.setattr(ai_features, 'AI_FEATURES', {'priced_extras'})
    record = create(client, current)
    current['uid'] = 'owner'
    record = approve(client, record).json()
    profile = {**db.workspaces.company('owner', 'adr')['profile'], 'additional_work_rate': '80.01'}
    result = client.put('/api/companies/adr', json=dict(expected_version=1, profile=profile))
    assert result.status_code == 200, result.text
    record = audit(client, record)
    assert record['audit']['documents']['xactimate_scope'][-1]['total'] == 118.65
    assert client.post('/api/authorize', json=sign_payload(record)).status_code == 200
    payload = client.post(
        '/api/authorizations/' + sign_payload(record)['auth_id'] + '/copy',
        json={'inspection_id': 'ADR-INS-' + 'b' * 32},
    )
    assert payload.status_code == 200, payload.text
    assert payload.json()['data']['extras'][0]['approval'] is None
    assert db.get_inspection('owner', ID)['data']['extras'][0]['approval']['rate'] == '47.46'


def test_approval_cannot_be_forged_or_changed_in_draft(api, monkeypatch):
    client, current, db = api
    monkeypatch.setattr(ai_features, 'AI_FEATURES', {'priced_extras'})
    current['uid'] = 'owner'
    result = client.post(
        '/api/inspections', json={'inspection_id': ID, 'data': dict(data(), extras=[approved()])}
    )
    assert result.status_code == 400
    record = create(client, current)
    current['uid'] = 'owner'
    record = approve(client, record).json()
    current['uid'] = 'estimator'
    for field, value in [('hours', '1'), ('description', 'Other work')]:
        payload = deepcopy(record['data'])
        payload['extras'][0][field] = value
        assert (
            client.put(
                '/api/inspections/' + ID,
                json=dict(expected_revision=record['revision'], data=payload),
            ).status_code
            == 400
        )
    # Unrelated edits retain the exact approval, including after Pydantic's timestamp serialization.
    payload = dict(record['data'], technician_notes='Another observation')
    result = client.put(
        '/api/inspections/' + ID, json=dict(expected_revision=record['revision'], data=payload)
    )
    assert result.status_code == 200, result.text
    record = result.json()
    older = {key: value for key, value in record['data'].items() if key != 'extras'}
    assert (
        client.put(
            '/api/inspections/' + ID, json=dict(expected_revision=record['revision'], data=older)
        ).status_code
        == 409
    )
    payload = deepcopy(record['data'])
    payload['extras'][0].update(hours='3', approval=None)
    updated = client.put(
        '/api/inspections/' + ID, json=dict(expected_revision=record['revision'], data=payload)
    )
    assert updated.status_code == 200
    assert not audit(client, updated.json())['audit']['documents']['signable']


def test_flag_rate_roles_unconfigured_company_and_rate_conflict(api, monkeypatch):
    client, current, db = api
    monkeypatch.setattr(ai_features, 'AI_FEATURES', set())
    result = client.post(
        '/api/inspections', json={'inspection_id': ID, 'data': dict(data(), extras=[proposed()])}
    )
    assert result.status_code == 404
    assert (
        client.post(f'/api/inspections/{ID}/extras/quote', json={'hours': 2.5}).status_code == 404
    )
    monkeypatch.setattr(ai_features, 'AI_FEATURES', {'priced_extras'})
    record = create(client, current)
    profile = dict(db.workspaces.company('owner', 'adr')['profile'], additional_work_rate='80')
    for uid in ('estimator', 'office', 'admin', 'other-owner'):
        current['uid'] = uid
        assert client.put(
            '/api/companies/adr', json=dict(expected_version=1, profile=profile)
        ).status_code in (403, 404)
    current['uid'] = 'owner'
    assert (
        client.put('/api/companies/adr', json=dict(expected_version=1, profile=profile)).status_code
        == 200
    )
    assert approve(client, record).status_code == 409
    assert approve(client, record, 2).json()['data']['extras'][0]['approval']['total'] == '200.00'
    current['uid'] = 'other-owner'
    other = 'ADR-INS-' + 'f' * 32
    assert (
        client.post('/api/inspections', json=dict(inspection_id=other, data=data())).status_code
        == 200
    )
    assert (
        client.post(f'/api/inspections/{other}/extras/quote', json={'hours': 2.5}).status_code
        == 400
    )


def test_approval_logs_only_allowlisted_fields(api, monkeypatch, capsys):
    import json

    client, current, db = api
    monkeypatch.setattr(ai_features, 'AI_FEATURES', {'priced_extras'})
    record = create(client, current)
    current['uid'] = 'owner'
    capsys.readouterr()
    assert approve(client, record).status_code == 200
    output = capsys.readouterr().out
    for line in output.splitlines():
        if line.startswith('{'):
            entry = json.loads(line)
            assert set(entry) <= LOG_FIELDS | {'severity', 'message'}
    assert TASK not in output and 'Test Owner' not in output and '47.46' not in output
    monkeypatch.setattr(db, 'quota', lambda *args: (_ for _ in ()).throw(Limited(30)))
    response = client.post(f'/api/inspections/{ID}/extras/quote', json={'hours': 2.5})
    assert response.status_code == 429 and response.headers['Retry-After'] == '30'


def test_tiny_rate_rounding_is_still_a_valid_approval(api, monkeypatch):
    client, current, db = api
    monkeypatch.setattr(ai_features, 'AI_FEATURES', {'priced_extras'})
    values = dict(data(), extras=[dict(proposed(), hours='0.25')])
    response = client.post('/api/inspections', json=dict(inspection_id=ID, data=values))
    profile = dict(db.workspaces.company('owner', 'adr')['profile'], additional_work_rate='0.01')
    assert (
        client.put('/api/companies/adr', json=dict(expected_version=1, profile=profile)).status_code
        == 200
    )
    record = approve(client, response.json(), 2).json()
    assert record['data']['extras'][0]['approval']['total'] == '0.00'
    assert audit(client, record)['audit']['documents']['signable']


def test_signed_snapshot_unchanged_after_rate_edit_and_duplicate_ids_refused(api, monkeypatch):
    client, current, db = api
    monkeypatch.setattr(ai_features, 'AI_FEATURES', {'priced_extras'})
    values = dict(data(), extras=[proposed(), proposed()])
    assert (
        client.post('/api/inspections', json=dict(inspection_id=ID, data=values)).status_code == 400
    )
    record = create(client, current)
    pending = audit(client, record)
    current['uid'] = 'owner'
    record = audit(client, approve(client, pending).json())
    assert record['audit']['proposal_hash'] != pending['audit']['proposal_hash']
    assert client.post('/api/authorize', json=sign_payload(pending)).status_code == 409
    payload = sign_payload(record)
    assert client.post('/api/authorize', json=payload).status_code == 200
    before = deepcopy(db.get('owner', payload['auth_id']))
    profile = dict(db.workspaces.company('owner', 'adr')['profile'], additional_work_rate='125.50')
    assert (
        client.put('/api/companies/adr', json=dict(expected_version=1, profile=profile)).status_code
        == 200
    )
    assert db.get('owner', payload['auth_id']) == before


def test_manual_extra_without_link_covers_only_its_exact_description():
    extra = approved()
    extra['unpriced_item'] = ''
    scope = InspectionData.model_validate(dict(data(), extras=[extra]))
    ai = AIResult(summary='Proposed work', suggestions=[], unpriced_work=[TASK])
    assert make_documents(scope, [], ai)['signable']
    ai.unpriced_work = ['Move and reset toilet and replace plumbing']
    assert not make_documents(scope, [], ai)['signable']


@pytest.mark.parametrize(
    'source,description',
    [
        ('Move/reset toilet and replace supply line', 'Move/reset toilet'),
        ('Remove damaged cabinetry ' + 'x' * 300 + ' and replace supply line', None),
    ],
    ids=['narrowed-description', 'truncated-prefill'],
)
def test_source_item_cannot_clear_work_beyond_approved_description(source, description):
    extra = approved()
    extra.update(unpriced_item=source, description=description or source[:300])
    scope = InspectionData.model_validate(dict(data(), extras=[extra]))
    ai = AIResult(summary='Proposed work', suggestions=[], unpriced_work=[source])
    docs = make_documents(scope, [], ai)
    assert docs['unpriced_work'] == [source]
    assert not docs['signable']
    ai.unpriced_work = [extra['description'], source]
    docs = make_documents(scope, [], ai)
    assert docs['unpriced_work'] == [source]
    assert not docs['signable']
    ai.unpriced_work = [extra['description']]
    docs = make_documents(scope, [], ai)
    assert docs['unpriced_work'] == []
    assert docs['signable']


EXTRA_RANGE = 'approved additional work is added at its approved amount to both ends'


@pytest.mark.parametrize('with_extra', [True, False])
def test_range_mentions_approved_work_only_with_an_approved_extra(with_extra):
    values = dict(data(), extras=[approved()] if with_extra else [])
    docs = make_documents(
        InspectionData.model_validate(values),
        [],
        AIResult(summary='Proposed work', suggestions=[], unpriced_work=[]),
    )
    assert (EXTRA_RANGE in docs['iicrc_defense_letter']) is with_extra
    assert 'to the priced scope' in docs['iicrc_defense_letter']
