"""Claim and loss details: the private job sidecar, document snapshots, Live intake and walkthrough fill."""

from datetime import date, timedelta

import pytest
from pydantic import ValidationError

import backend.main as bm
from backend.claims import make_documents
from backend.contracts import AIResult, ClaimDetails, InspectionData
from backend.prompts import live_prompt
from backend.scope import CLAIM_LABELS, ScopeSuggestions, scope_prompt, validate_suggestions
from tests.fakes import png
from tests.test_workspaces import ID, api, data, store  # noqa: F401

CLAIM = dict(
    carrier='Synthetic Mutual',
    claim_number='CLM-0042-77',
    policy_number='POL 991',
    date_of_loss='2026-10-12',
    loss_cause='Supply line under kitchen sink',
    adjuster_name='Avery Quinn',
    adjuster_email='Avery@Example.invalid',
    adjuster_phone='(555) 010-0199',
    deductible='$1,000',
)
EMPTY = ClaimDetails().model_dump()
GENERIC = 'TO: Insurance Claims Examiner / Adjuster'


def save_claim(client, claim, version=None):
    if version is None:
        version = client.get('/api/jobs/' + ID + '/claim').json()['claim_version']
    return client.put(
        '/api/jobs/' + ID + '/claim', json={'expected_version': version, 'claim': claim}
    )


def started(client, current, uid='estimator'):
    current['uid'] = uid
    response = client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    assert response.status_code == 200
    return response.json()


def audit(client):
    return client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1}).json()


def signing(record, auth_id):
    return dict(
        inspection_id=ID,
        expected_revision=1,
        auth_id=auth_id,
        proposal_hash=record['audit']['proposal_hash'],
        signature_png=png(),
        documents_confirmed=True,
    )


def test_new_and_existing_jobs_start_with_no_claim_details(api):
    client, current, store = api
    started(client, current)
    # A job saved before claim details has neither field.
    assert 'claim' not in store.db.records['_workspace_jobs/' + ID]
    view = client.get('/api/jobs/' + ID + '/claim').json()
    assert view == dict(job_id=ID, claim_version=0, claim=EMPTY, editable=True)


@pytest.mark.parametrize('uid', ['estimator', 'office', 'owner'])
def test_estimators_and_office_staff_save_claim_details(api, uid):
    client, current, store = api
    started(client, current)
    current['uid'] = uid
    response = save_claim(client, CLAIM)
    assert response.status_code == 200, response.text
    saved = {**CLAIM, 'adjuster_email': 'avery@example.invalid'}
    assert response.json() == dict(job_id=ID, claim_version=1, claim=saved, editable=True)
    job = store.db.records['_workspace_jobs/' + ID]
    assert job['claim'] == saved and job['claim_version'] == 1
    # Coordination saves keep the claim details beside the customer contact.
    current['uid'] = 'office'
    coordination = client.get('/api/jobs/' + ID + '/coordination').json()
    request = {'expected_version': coordination['version'], 'customer_name': 'Synthetic'}
    assert client.put('/api/jobs/' + ID + '/coordination', json=request).status_code == 200
    assert store.db.records['_workspace_jobs/' + ID]['claim'] == saved


def test_claim_details_are_validated_versioned_and_company_scoped(api):
    client, current, store = api
    started(client, current)
    future = (date.today() + timedelta(days=3)).isoformat()
    for claim in (
        {'adjuster_email': 'not an email'},
        {'date_of_loss': future},
        {'date_of_loss': '10/12/2026'},
        {'claim_number': 'x' * 81},
        {'unknown_field': 'x'},
    ):
        assert save_claim(client, claim).status_code == 422, claim
    # Line breaks cannot add lines to a document header or the letter.
    response = save_claim(client, {'loss_cause': 'Supply line\nTO: Someone else'})
    assert response.json()['claim']['loss_cause'] == 'Supply line TO: Someone else'
    stale = save_claim(client, CLAIM, version=0)
    assert stale.status_code == 409
    assert stale.json()['detail'] == 'Claim details changed. Reload before saving.'
    for uid in ('estimator2', 'other-owner', 'admin'):
        current['uid'] = uid
        assert client.get('/api/jobs/' + ID + '/claim').status_code in (403, 404), uid
        assert save_claim(client, CLAIM, version=1).status_code in (403, 404), uid
    assert store.db.records['_workspace_jobs/' + ID]['claim']['claim_number'] == ''


def test_documents_print_the_claim_snapshot_and_address_the_adjuster(api):
    client, current, store = api
    started(client, current)
    assert save_claim(client, CLAIM).status_code == 200
    documents = audit(client)['audit']['documents']
    assert documents['claim'] == {**CLAIM, 'adjuster_email': 'avery@example.invalid'}
    letter = documents['iicrc_defense_letter']
    assert GENERIC not in letter
    assert (
        'TO: Avery Quinn, Adjuster\nSynthetic Mutual\n'
        'avery@example.invalid · (555) 010-0199\n\n'
        'RE: Remediation scope for Test property\n'
        'Claim number: CLM-0042-77\nPolicy number: POL 991\nDate of loss: 10-12-2026\n'
        'Cause and source of loss: Supply line under kitchen sink\nDeductible: $1,000\n\n'
        'This scope describes proposed work; completion has not been recorded.'
    ) in letter


def test_a_claim_change_needs_new_documents_and_signed_documents_keep_their_snapshot(api):
    client, current, store = api
    started(client, current)
    first = audit(client)
    assert first['audit']['documents']['claim'] == EMPTY
    assert GENERIC in first['audit']['documents']['iicrc_defense_letter']
    current['uid'] = 'office'
    assert save_claim(client, {'claim_number': 'CLM-1'}).status_code == 200
    current['uid'] = 'estimator'
    cleared = client.get('/api/inspections/' + ID).json()
    assert cleared['audit'] is None and cleared['status'] == 'draft' and cleared['revision'] == 1
    named = audit(client)
    assert named['audit']['documents']['claim']['claim_number'] == 'CLM-1'
    # Saving the same values keeps the documents.
    assert save_claim(client, {'claim_number': 'CLM-1'}).status_code == 200
    assert client.get('/api/inspections/' + ID).json()['audit'] == named['audit']
    # Details saved while the audit was running no longer match the documents.
    store.db.records['_workspace_jobs/' + ID]['claim']['claim_number'] = 'CLM-2'
    payload = signing(named, 'ADR-AUTH-claim1234567')
    response = client.post('/api/authorize', json=payload)
    assert response.status_code == 409
    assert response.json()['detail'] == (
        'Claim details changed. Generate new documents before signing.'
    )
    store.db.records['_workspace_jobs/' + ID]['claim']['claim_number'] = 'CLM-1'
    assert client.post('/api/authorize', json=payload).status_code == 200
    signed = store.db.records['authorizations/' + payload['auth_id']]['documents']
    # The sidecar stays editable after signing, for the adjuster assigned later.
    current['uid'] = 'office'
    later = save_claim(client, {'claim_number': 'CLM-1', 'adjuster_email': 'late@example.invalid'})
    assert later.status_code == 200
    assert store.db.records['authorizations/' + payload['auth_id']]['documents'] == signed
    assert signed['claim']['adjuster_email'] == ''
    assert store.db.records['inspections/' + ID]['status'] == 'signed'


def test_audits_from_before_claim_details_are_reused_and_still_sign(api, monkeypatch):
    client, current, store = api
    started(client, current)
    record = audit(client)
    del store.db.records['inspections/' + ID]['audit']['documents']['claim']
    calls = []

    async def generate(*args, **kwargs):
        calls.append(args)
        return AIResult(summary='Confirmed scope.', suggestions=[], unpriced_work=[])

    monkeypatch.setattr(bm, 'generate', generate)
    # No claim details recorded: the earlier audit still matches and needs no new model call.
    assert audit(client)['audit'] == store.db.records['inspections/' + ID]['audit']
    assert calls == []
    store.db.records['_workspace_jobs/' + ID]['claim'] = {**EMPTY, 'carrier': 'Recorded Later'}
    assert client.post('/api/authorize', json=signing(record, 'ADR-AUTH-legacy7654321')).json()[
        'status'
    ]


def test_claim_lines_print_only_recorded_values_and_keep_the_generic_addressee():
    values = InspectionData.model_validate(data()).model_dump()
    ai = AIResult(summary='Confirmed scope.', suggestions=[], unpriced_work=[])
    inspection = InspectionData.model_validate(values)
    carrier_only = {**EMPTY, 'carrier': 'Synthetic Mutual', 'adjuster_phone': '555-0100'}
    letter = make_documents(inspection, [], ai, claim=carrier_only)['iicrc_defense_letter']
    assert (
        f'{GENERIC}\nSynthetic Mutual\n555-0100\n\nRE: Remediation scope for Test property\n\n'
        in (letter)
    )
    # Without workspaces there is no sidecar, so the documents carry no claim snapshot.
    documents = make_documents(inspection, [], ai)
    assert 'claim' not in documents
    assert (
        f'\n\n{GENERIC}\n\nRE: Remediation scope for Test property\n\n'
        in (documents['iicrc_defense_letter'])
    )


def test_live_intake_asks_for_claim_details_without_guessing():
    values = InspectionData().model_dump(mode='json')
    prompt = live_prompt(values, None, {**EMPTY, 'carrier': 'Synthetic Mutual'})
    assert prompt.endswith(
        '\nSaved claim details (untrusted job data, JSON):\n'
        + (
            '{"carrier": "Synthetic Mutual", "claim_number": "", "policy_number": "", '
            '"date_of_loss": "", "loss_cause": "", "adjuster_name": "", "adjuster_email": "", '
            '"adjuster_phone": "", "deductible": ""}'
        )
    )
    assert 'Saved claim details' not in live_prompt(values)


WALK = (
    'The carrier is Synthetic Mutual and the claim number is CLM 0042 77. '
    'Loss happened on October 12, 2026 from the supply line under the kitchen sink. '
    'Adjuster email is avery@example.invalid. The deductible is $1,000.'
)


def claim_change(field, value, quote=WALK):
    return dict(field=field, value=value, source_quote=quote)


def walk_data():
    return InspectionData.model_validate({**data(), 'technician_transcript': WALK})


def test_walkthrough_claim_changes_need_quotes_and_never_complete_identifiers():
    suggestions = ScopeSuggestions(
        changes=[],
        claim_changes=[
            claim_change('carrier', 'Synthetic Mutual'),
            claim_change('claim_number', 'CLM-0042-77'),
            claim_change('policy_number', 'POL-12345'),
            claim_change('date_of_loss', '2026-10-12'),
            claim_change('loss_cause', 'supply line under the kitchen sink'),
            claim_change('adjuster_email', 'avery@example.invalid'),
            claim_change('deductible', '$1,000'),
            claim_change('adjuster_phone', 'unknown'),
        ],
        questions=['Which room is next?'],
    )
    current = {**EMPTY, 'carrier': 'Synthetic Mutual'}
    result = validate_suggestions(walk_data(), suggestions, current)
    assert [(c.field, c.value) for c in result.claim_changes] == [
        ('claim_number', 'CLM-0042-77'),
        ('date_of_loss', '2026-10-12'),
        ('loss_cause', 'supply line under the kitchen sink'),
        ('adjuster_email', 'avery@example.invalid'),
        ('deductible', '$1,000'),
    ]
    assert result.questions == [
        'Confirm the policy number; the walkthrough value does not match what was said.',
        'Confirm the adjuster phone; the walkthrough value does not match what was said.',
        'Which room is next?',
    ]
    bad_date = ScopeSuggestions(
        changes=[], claim_changes=[claim_change('date_of_loss', 'October 12')], questions=[]
    )
    assert validate_suggestions(walk_data(), bad_date, EMPTY).questions == [
        'Confirm the date of loss; the walkthrough value could not be used.'
    ]
    unusable = ScopeSuggestions(
        changes=[{'field': 'drying_days', 'value': 5, 'source_quote': WALK}],
        claim_changes=[
            claim_change('carrier', 'Other Mutual', quote='The carrier is Other Mutual.'),
            claim_change('claim_number', 'CLM-0042-77'),
            claim_change('claim_number', 'CLM-0042'),
            claim_change('claim_number', 'CLM-0042-77'),
            claim_change('deductible', '$1,000'),
        ],
        questions=[],
    )
    result = validate_suggestions(walk_data(), unusable, EMPTY)
    assert [(c.field, c.value) for c in result.changes] == [('drying_days', 5)]
    assert [(c.field, c.value) for c in result.claim_changes] == [('deductible', '$1,000')]
    assert result.questions == [
        'Confirm the insurance carrier; the walkthrough value has no matching technician quote.',
        'Confirm the claim number; the walkthrough gave more than one value.',
    ]
    # Without a sidecar to store them, claim changes are dropped.
    assert validate_suggestions(walk_data(), suggestions).claim_changes == []


@pytest.mark.parametrize(
    'field,value,quote',
    [
        ('carrier', 'synthetic  mutual', 'The carrier is Synthetic Mutual.'),
        ('adjuster_name', 'Avery Quinn', 'Adjuster: AVERY QUINN'),
        ('adjuster_email', 'Avery@Example.invalid', 'Adjuster email is avery@example.invalid.'),
        ('claim_number', 'CLM-0042-77', 'Claim number is CLM 0042 77.'),
        ('claim_number', 'CLM-0042-77', 'Claim number is clm 0042 77'),
        ('claim_number', 'A-0042-77', 'Claim number is A 0042 77.'),
        ('claim_number', '0042-77-A', 'Claim number is 0042-77-A.'),
        ('adjuster_email', 'avery@example.com.au', 'Email avery@example.com.au.'),
        ('policy_number', 'POL12345', 'Policy POL-12345, renewed in 2025.'),
        ('adjuster_phone', '(661) 555-0100', 'Call the adjuster at 661.555.0100 today.'),
        ('date_of_loss', '2026-10-12', 'Loss happened on October 12th, 2026.'),
        ('date_of_loss', '2026-10-12', 'Date of loss 10/12/2026.'),
        ('date_of_loss', '2026-03-04', 'It flooded on 4 March 2026.'),
        ('loss_cause', 'Supply line, kitchen sink', 'From the supply line kitchen sink.'),
        ('deductible', '$1,000', 'The deductible is 1000 dollars.'),
        ('deductible', '1,000.00', 'The deductible is $1,000.'),
        ('deductible', '$500', 'The deductible of 500.'),
        ('deductible', '$1,000', 'Deductible is 1000 dollars on the policy.'),
        ('deductible', '$1,000', 'The deductible is 1000.'),
        ('deductible', '$1,000', 'Loss happened October 12 2026 deductible is $1,000.'),
        ('deductible', '2%', 'The deductible is 2%.'),
        ('deductible', '5 percent', 'The deductible is 5 percent of the dwelling.'),
        ('deductible', '2%', 'Deductible 2 percent.'),
        ('deductible', '2 percent', 'The deductible is 2 percent.'),
        ('deductible', '1.5%', 'The deductible is 1.5 per cent.'),
        ('adjuster_phone', '661-555-0100', 'Adjuster phone 661-555-0100. 2 rooms wet.'),
        ('adjuster_phone', '661-555-0100', 'Adjuster phone is 1 (661) 555-0100.'),
        ('adjuster_phone', '555-0100', 'Call the adjuster at 555 0100.'),
    ],
)
def test_walkthrough_claim_values_match_their_quote(field, value, quote):
    suggestions = ScopeSuggestions(
        changes=[], claim_changes=[claim_change(field, value, quote)], questions=[]
    )
    inspection = InspectionData.model_validate({**data(), 'technician_transcript': quote})
    result = validate_suggestions(inspection, suggestions, EMPTY)
    assert [c.field for c in result.claim_changes] == [field] and result.questions == []


@pytest.mark.parametrize(
    'field,value,quote',
    [
        ('adjuster_email', 'avery@example.com', 'Adjuster email is avery@example.invalid.'),
        ('carrier', 'Synthetic Mutual Insurance', 'The carrier is Synthetic Mutual.'),
        ('adjuster_name', 'Avery Quinn', 'The adjuster is Avery.'),
        ('claim_number', '0042-77', 'Claim number is CLM 0042 77.'),
        ('claim_number', 'CLM 0042', 'Claim number is CLM 0042 77.'),
        ('policy_number', '12345', 'Policy POL 12345.'),
        ('claim_number', '0042-77', 'Claim number is clm 0042 77'),
        ('claim_number', '0042-77', 'Claim number is A 0042 77'),
        ('claim_number', '0042-77', 'Claim number is 0042-77-A'),
        ('adjuster_email', 'avery@example.com', 'Adjuster email is avery@example.com.au'),
        ('adjuster_email', 'avery@example.com', 'Adjuster email is mavery@example.com'),
        ('policy_number', 'POL-1234', 'Policy POL-12345.'),
        ('adjuster_phone', '555-0100', 'Call the adjuster at 661 555 0100.'),
        ('date_of_loss', '2026-10-12', 'Loss happened on October 12.'),
        ('date_of_loss', '2026-10-13', 'Loss happened on October 12, 2026.'),
        ('loss_cause', 'burst pipe in the attic', 'Water came through the ceiling.'),
        ('deductible', '$2,500', 'The deductible is $1,000.'),
        ('deductible', '$1,000 per claim', 'The deductible is $1,000.'),
        ('carrier', ' ', 'The carrier is unknown.'),
        ('deductible', '$77', WALK),
        ('deductible', '42', WALK),
        ('deductible', '$2,026', WALK),
        ('deductible', '12', WALK),
        ('deductible', '$500', 'Policy HO500. The deductible is $1,000.'),
        ('deductible', '$500', 'A 500 deductible on policy HO500.'),
        ('deductible', '$2,026', 'Loss happened October 12 2026 deductible is $1,000.'),
        ('deductible', '$77', 'Claim CLM 0042 77 deductible is $1,000'),
        ('deductible', '$100', 'Call 661 555 0100 deductible $1,000'),
        ('deductible', '$12', 'The deductible is 12 October 2026.'),
        ('deductible', '$500', 'The deductible is HO-500.'),
        ('deductible', '$2', 'The deductible is 2%.'),
        ('deductible', '$5', 'The deductible is 5 percent of the dwelling.'),
        ('deductible', '5', 'The deductible is 5 percent of the dwelling.'),
        ('deductible', '2%', 'The deductible is $2.'),
        ('deductible', '2%', 'The deductible is 2 dollars.'),
        ('deductible', '$2%', 'The deductible is 2%.'),
        ('deductible', '$2', 'The deductible is 2 pct.'),
        ('deductible', '$1.5', 'The deductible is 1.5 per cent.'),
        ('deductible', '$2', 'Deductible is 2 percentage points.'),
        ('deductible', '$2', 'The deductible is $2 pct.'),
        ('deductible', '2%', 'The deductible is 2 percentage points.'),
        ('deductible', '$500', 'The deductible of 500 on policy HO500.'),
        ('deductible', '$1,000', 'The deductible 1000.'),
        ('deductible', '$1,000', 'The deductible is $ 1,000.'),
        ('deductible', '$5', 'The deductible is $5 thousand.'),
        ('deductible', '$1', 'The deductible is $1 million.'),
        ('deductible', '$2.5', 'deductible is $2.5 million'),
        ('deductible', '$5', 'deductible is $5 hundred'),
        ('deductible', '$2', 'The deductible is 2 dollars and 50 cents.'),
        ('deductible', '$10', 'deductible is $10.000'),
        ('deductible', '$10.000', 'deductible is $10.000'),
        ('adjuster_phone', '0042-77', WALK),
        ('adjuster_phone', '123-4567', 'Policy number HO-123-4567.'),
        ('adjuster_phone', '555-0100', 'Claim number CLM-555-0100.'),
        ('adjuster_phone', '555-0100', 'Claim 555-0100-A is open.'),
        ('adjuster_phone', '555-0100', 'Policy HO5550100.'),
        ('adjuster_phone', '661-555-0100', 'On October 12, 2026 call 661 555 0100 2.'),
    ],
)
def test_walkthrough_claim_values_not_in_their_quote_are_asked_about(field, value, quote):
    suggestions = ScopeSuggestions(
        changes=[], claim_changes=[claim_change(field, value, quote)], questions=[]
    )
    inspection = InspectionData.model_validate({**data(), 'technician_transcript': quote})
    result = validate_suggestions(inspection, suggestions, EMPTY)
    assert result.claim_changes == []
    assert result.questions == [
        f'Confirm the {CLAIM_LABELS[field]}; the walkthrough value does not match what was said.'
    ]


def test_malformed_claim_entries_are_asked_about_without_losing_the_room_fill():
    raw = dict(
        changes=[{'field': 'drying_days', 'room': None, 'value': 5, 'source_quote': WALK}],
        claim_changes=[
            {'field': 'policy_number', 'value': '', 'source_quote': ''},
            {'field': 'deductible', 'value': 1000, 'source_quote': WALK},
            {'field': 'carrier', 'value': 'Synthetic Mutual', 'source_quote': WALK, 'note': 'x'},
            {'field': 'loss_cause', 'value': 'x' * 600, 'source_quote': WALK},
            {'field': 'roof_age', 'value': '10', 'source_quote': WALK},
            'claim_number: CLM 0042 77',
            *[claim_change('adjuster_email', 'avery@example.invalid')] * 21,
            claim_change('claim_number', 'CLM 0042 77'),
        ],
        questions=[],
    )
    # The provider response is checked against this model before validation.
    suggestions = ScopeSuggestions.model_validate(raw)
    result = validate_suggestions(walk_data(), suggestions, EMPTY)
    assert [(c.field, c.value) for c in result.changes] == [('drying_days', 5)]
    assert [(c.field, c.value) for c in result.claim_changes] == [('claim_number', 'CLM 0042 77')]
    assert result.questions == [
        'Confirm the policy number; the walkthrough value has no matching technician quote.',
        'Confirm the deductible; the walkthrough value could not be used.',
        'Confirm the insurance carrier; the walkthrough value could not be used.',
        'Confirm the cause and source of loss; the walkthrough value could not be used.',
        'Confirm the claim details; the walkthrough value could not be used.',
        'Confirm the adjuster email; the walkthrough gave more than one value.',
    ]


@pytest.mark.parametrize(
    'claim_changes,questions',
    [
        (None, []),
        (
            {'field': 'carrier'},
            ['Confirm the insurance carrier; the walkthrough value could not be used.'],
        ),
        (
            'carrier: Synthetic Mutual',
            ['Confirm the claim details; the walkthrough value could not be used.'],
        ),
    ],
)
def test_claim_changes_that_are_not_a_list_never_reject_the_response(claim_changes, questions):
    suggestions = ScopeSuggestions.model_validate(
        dict(
            changes=[{'field': 'drying_days', 'room': None, 'value': 5, 'source_quote': WALK}],
            claim_changes=claim_changes,
            questions=[],
        )
    )
    result = validate_suggestions(walk_data(), suggestions, EMPTY)
    assert [(c.field, c.value) for c in result.changes] == [('drying_days', 5)]
    assert result.claim_changes == [] and result.questions == questions


def test_scope_fill_with_a_malformed_claim_entry_still_returns_room_changes(api, monkeypatch):
    client, current, store = api
    values = {**data(), 'technician_transcript': WALK, 'scope_confirmed': False}
    current['uid'] = 'estimator'
    client.post('/api/inspections', json={'inspection_id': ID, 'data': values})

    async def generate(schema, *args, **kwargs):
        return schema.model_validate(
            dict(
                changes=[{'field': 'drying_days', 'room': None, 'value': 4, 'source_quote': WALK}],
                claim_changes=[{'field': 'policy_number', 'value': '', 'source_quote': ''}],
                questions=[],
            )
        )

    monkeypatch.setattr(bm, 'generate', generate)
    response = client.post(
        '/api/inspections/' + ID + '/scope-suggestions',
        json={'inspection_id': ID, 'expected_revision': 1},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert [(c['field'], c['value']) for c in body['changes']] == [('drying_days', 4)]
    assert body['claim_changes'] == []
    assert body['questions'] == [
        'Confirm the policy number; the walkthrough value has no matching technician quote.'
    ]


def test_claim_questions_survive_a_full_list_of_model_questions():
    quote = 'Adjuster email is avery@example.invalid.'
    suggestions = ScopeSuggestions(
        changes=[],
        claim_changes=[claim_change('adjuster_email', 'avery@example.com', quote)],
        questions=[f'Model question {i}?' for i in range(20)],
    )
    inspection = InspectionData.model_validate({**data(), 'technician_transcript': quote})
    result = validate_suggestions(inspection, suggestions, EMPTY)
    assert result.claim_changes == []
    assert len(result.questions) == 20
    assert result.questions[0] == (
        'Confirm the adjuster email; the walkthrough value does not match what was said.'
    )


def test_scope_prompt_includes_claim_details_only_with_a_sidecar():
    with_claim = scope_prompt(walk_data(), EMPTY)
    assert '"current_claim": {"carrier": ""' in with_claim
    without = scope_prompt(walk_data())
    assert 'current_claim' not in without


def test_scope_suggestions_return_claim_changes_for_the_job(api, monkeypatch):
    client, current, store = api
    values = {**data(), 'technician_transcript': WALK, 'scope_confirmed': False}
    current['uid'] = 'estimator'
    client.post('/api/inspections', json={'inspection_id': ID, 'data': values})
    assert save_claim(client, {'carrier': 'Synthetic Mutual'}).status_code == 200
    prompts = []

    async def generate(schema, contents, *args, **kwargs):
        prompts.append(contents[0])
        return ScopeSuggestions(
            changes=[],
            claim_changes=[
                claim_change('carrier', 'Synthetic Mutual'),
                claim_change('claim_number', 'CLM 0042 77'),
            ],
            questions=[],
        )

    monkeypatch.setattr(bm, 'generate', generate)
    response = client.post(
        '/api/inspections/' + ID + '/scope-suggestions',
        json={'inspection_id': ID, 'expected_revision': 1},
    )
    assert response.status_code == 200, response.text
    assert response.json()['claim_changes'] == [
        claim_change('claim_number', 'CLM 0042 77'),
    ]
    assert '"current_claim": {"carrier": "Synthetic Mutual"' in prompts[0]
    # Suggestions never write the sidecar; the technician's app saves what it applies.
    assert store.db.records['_workspace_jobs/' + ID]['claim']['claim_number'] == ''


def test_claim_details_reject_values_the_documents_cannot_print():
    with pytest.raises(ValidationError):
        ClaimDetails(date_of_loss='2026-02-30')
