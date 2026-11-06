"""Company spending behavior through transactional storage and the real generation helper."""

from tests.fakes import genai_models
import asyncio
import json
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from types import SimpleNamespace as NS
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException

from backend import ai_features, main as bm
from backend.ai_spending import (
    CompanySpending,
    DEFAULT_CAP,
    HELD_RETRY_SECONDS,
    LIVE_MARGIN,
    REST_RESERVE,
    REST_OUTPUT_LIMITS,
    RETRY_SECONDS,
    ReservedCall,
    rest_cost,
    rest_allowance,
)
from backend.live_spending import LiveSpending
from tests.fakes import FakeCompanyStore, png
from tests.test_workspaces import store, api, seed, data, ID, PHOTO, signed_job
from tests.test_voice_notes import note

GENERATE = bm.generate


def cap(store, amount=DEFAULT_CAP, company='adr'):
    store.db.records['_company_ai_budgets/' + company] = dict(
        company_id=company, monthly_cap_microusd=amount
    )


def test_parallel_members_and_features_share_one_hard_cap(store):
    def reserve(i):
        ledger = CompanySpending.actor(store, 'owner' if i % 2 else 'estimator')
        try:
            return ledger.reserve(['audit', 'ocr', 'scope', 'transcribe'][i % 4], 1_000_000)
        except HTTPException as error:
            assert error.status_code == 429
            return None

    with ThreadPoolExecutor(max_workers=32) as pool:
        ids = list(pool.map(reserve, range(100)))
    ledger = CompanySpending(store, 'adr')
    assert len(set(filter(None, ids))) == DEFAULT_CAP // 1_000_000
    assert ledger.summary()['reserved_microusd'] == DEFAULT_CAP
    # Repeated settlements racing on multiple instances must refund exactly once.
    identifier = next(filter(None, ids))
    with ThreadPoolExecutor(max_workers=16) as pool:
        list(
            pool.map(lambda _: CompanySpending(store, 'adr').settle(identifier, 250_000), range(30))
        )
    assert ledger.summary()['spent_microusd'] == 250_000
    assert ledger.summary()['reserved_microusd'] == DEFAULT_CAP - 1_000_000
    assert ledger.reserve('ocr', 750_000)
    with pytest.raises(HTTPException):
        ledger.reserve('audit', 1)
    assert CompanySpending(store, 'other').reserve('audit', DEFAULT_CAP)


def test_crash_holds_survive_new_instances_and_month_rollover(store, monkeypatch):
    import backend.ai_spending as spending

    clock = [datetime(2026, 11, 1, tzinfo=timezone.utc).timestamp()]
    monkeypatch.setattr(spending.time, 'time', lambda: clock[0])
    ledger = CompanySpending(store, 'adr')
    identifier = ledger.reserve('audit', DEFAULT_CAP)
    # A worker vanished after acquiring the reservation, possibly after sending its request.
    restarted = seed(FakeCompanyStore(db=store.db, bucket=store.bucket))
    other_worker = CompanySpending(restarted, 'adr')
    with pytest.raises(HTTPException):
        other_worker.reserve('scope', 1)
    clock[0] += 86400
    with pytest.raises(HTTPException):
        other_worker.reserve('ocr', 1)
    clock[0] = datetime(2026, 12, 1, tzinfo=timezone.utc).timestamp()
    assert other_worker.summary()['reserved_microusd'] == 0
    next_id = other_worker.reserve('ocr', 1_000_000)
    # A late completion settles against its original month; it cannot refund this month's calls.
    other_worker.settle(identifier, 5_000)
    assert other_worker.summary()['reserved_microusd'] == 1_000_000
    other_worker.settle(next_id, 100)
    assert other_worker.summary()['spent_microusd'] == 100


def test_refusal_distinguishes_held_allowance_from_settled_exhaustion(store):
    ledger = CompanySpending(store, 'adr')
    busy = ledger.reserve('ocr', DEFAULT_CAP - REST_RESERVE + 1)
    with pytest.raises(HTTPException) as error:
        ledger.reserve('audit', REST_RESERVE)
    assert error.value.status_code == 429
    assert error.value.headers['Retry-After'] == str(HELD_RETRY_SECONDS)
    assert 'next month' not in error.value.detail
    assert 'in progress' in error.value.detail
    ledger.settle(busy, 1_000)
    ledger.settle(ledger.reserve('audit', DEFAULT_CAP - 1_000))
    with pytest.raises(HTTPException) as error:
        ledger.reserve('ocr', 1)
    assert error.value.headers['Retry-After'] == str(RETRY_SECONDS)
    assert 'resets next month' in error.value.detail


def test_live_refusal_wording_follows_settled_spending(store):
    ledger = CompanySpending(store, 'adr')
    other = ledger.reserve('audit', DEFAULT_CAP - LIVE_MARGIN)
    with pytest.raises(HTTPException) as error:
        LiveSpending.start(store, 'owner', True, bm.LIVE_MODEL)
    assert 'in progress' in error.value.detail
    ledger.settle(other, 0)
    live = LiveSpending.start(store, 'owner', True, bm.LIVE_MODEL)
    other = ledger.reserve('audit', DEFAULT_CAP - LIVE_MARGIN)
    with pytest.raises(HTTPException) as error:
        live.check()
    assert error.value.headers['Retry-After'] == str(HELD_RETRY_SECONDS)
    ledger.settle(other)
    with pytest.raises(HTTPException) as error:
        live.check()
    assert 'resets next month' in error.value.detail
    live.finish()


def test_unknown_outcome_charged_and_proven_unused_call_released(store):
    ledger = CompanySpending(store, 'adr')
    held = ReservedCall.start(store, 'owner', True, bm.AUDIT_MODEL, 'audit', 100)
    assert ledger.summary()['reserved_microusd'] == rest_allowance(bm.AUDIT_MODEL, 100, 'audit')
    held.release_unused()
    held.release_unused()
    assert ledger.summary()['reserved_microusd'] == 0
    uncertain = ledger.reserve('audit', REST_RESERVE)
    ledger.settle(uncertain)
    ledger.settle(uncertain, 0)
    assert ledger.summary()['spent_microusd'] == REST_RESERVE


def provider(monkeypatch, callback):
    monkeypatch.setattr(bm, 'get_ai_client', lambda: NS(aio=NS(models=genai_models(callback))))


def test_real_helper_reserves_before_dispatch_and_settles_thinking_tokens(store, monkeypatch):
    monkeypatch.setattr(bm, 'WORKSPACES_ENABLED', True)
    ledger = CompanySpending(store, 'adr')

    async def respond(**kwargs):
        assert ledger.summary()['reserved_microusd'] == rest_allowance(bm.AUDIT_MODEL, 100, 'audit')
        assert kwargs['config'].max_output_tokens == REST_OUTPUT_LIMITS['audit']
        return NS(
            text=json.dumps(dict(summary='Saved observations.', suggestions=[], unpriced_work=[])),
            usage_metadata=NS(
                prompt_token_count=100, total_token_count=140, thoughts_token_count=30
            ),
        )

    provider(monkeypatch, respond)
    result = asyncio.run(
        GENERATE(
            bm.AIResult, ['observations'], bm.AUDIT_MODEL, 'audit', ID, spending=(store, 'owner')
        )
    )
    assert result.summary == 'Saved observations.'
    assert ledger.summary()['spent_microusd'] == 495
    assert ledger.summary()['reserved_microusd'] == 0
    assert '_company_ai_budgets/adr' not in store.db.records


@pytest.mark.parametrize('failure', ['timeout', 'invalid', 'cancelled'])
def test_uncertain_or_invalid_provider_outcome_never_refunds_unreported_work(
    store, monkeypatch, failure
):
    monkeypatch.setattr(bm, 'WORKSPACES_ENABLED', True)

    async def respond(**kwargs):
        if failure == 'timeout':
            raise TimeoutError()
        if failure == 'cancelled':
            raise asyncio.CancelledError()
        return NS(text='invalid JSON')

    provider(monkeypatch, respond)
    with pytest.raises((HTTPException, asyncio.CancelledError)):
        asyncio.run(
            GENERATE(
                bm.AIResult,
                ['observations'],
                bm.AUDIT_MODEL,
                'audit',
                ID,
                spending=(store, 'owner'),
            )
        )
    assert CompanySpending(store, 'adr').summary()['spent_microusd'] == rest_allowance(
        bm.AUDIT_MODEL, 100, 'audit'
    )


def test_custom_cap_and_unknown_model_fail_before_provider_dispatch(store, monkeypatch):
    monkeypatch.setattr(bm, 'WORKSPACES_ENABLED', True)
    cap(store, 0)

    async def forbidden(**kwargs):
        pytest.fail('Provider called without company budget')

    provider(monkeypatch, forbidden)
    for model, status in [(bm.AUDIT_MODEL, 429), ('unreviewed-model', 503)]:
        with pytest.raises(HTTPException) as error:
            asyncio.run(
                GENERATE(
                    bm.AIResult, ['observations'], model, 'audit', ID, spending=(store, 'owner')
                )
            )
        assert error.value.status_code == status
    assert not any(k.startswith('_company_ai_reservations/') for k in store.db.records)


@pytest.mark.parametrize('operation', ['audit', 'scope', 'ocr', 'voice', 'summary'])
def test_cap_refuses_paid_routes_without_changing_draft(api, monkeypatch, operation):
    client, actor, store = api
    monkeypatch.setattr(bm, 'generate', GENERATE)
    monkeypatch.setattr(ai_features, 'AI_FEATURES', frozenset({'readiness', 'job_summary'}))
    payload = data()
    payload['technician_transcript'] = 'Bathroom category 1. Wet drywall 10 square feet.'
    store.create_inspection('owner', ID, payload)
    if operation == 'ocr':
        store.add_photo(
            'owner',
            ID,
            dict(
                photo_id=PHOTO,
                expected_revision=1,
                room='Bathroom',
                captured_at='2026',
                data_url=png(),
            ),
        )
    before = deepcopy(store.db.records['inspections/' + ID])
    cap(store, 0)

    async def forbidden(**kwargs):
        pytest.fail('Provider called after the cap')

    provider(monkeypatch, forbidden)
    if operation == 'audit':
        response = client.post(
            '/api/audit', json=dict(inspection_id=ID, expected_revision=before['revision'])
        )
    elif operation == 'scope':
        response = client.post(
            f'/api/inspections/{ID}/scope-suggestions',
            json=dict(inspection_id=ID, expected_revision=before['revision']),
        )
    elif operation == 'ocr':
        response = client.post(f'/api/inspections/{ID}/photos/{PHOTO}/ocr')
    elif operation == 'voice':
        response = client.post(f'/api/inspections/{ID}/voice-notes', json=note())
    else:
        response = client.get(f'/api/jobs/{ID}/insight')
    assert response.status_code == 429, response.text
    assert 'spending limit' in response.json()['detail']
    assert response.headers['retry-after'] == str(RETRY_SECONDS)
    assert store.db.records['inspections/' + ID] == before
    assert client.get(f'/api/inspections/{ID}').status_code == 200
    assert client.get(f'/api/jobs/{ID}/insight?facts_only=true').status_code == 200


@pytest.mark.parametrize(
    'uid,company',
    [
        ('owner', 'adr'),
        ('estimator', None),
        ('office', None),
        ('admin', None),
        ('other-owner', 'other'),
    ],
)
def test_owner_spending_available_without_count_feature_and_is_private(api, uid, company):
    client, actor, store = api
    actor['uid'] = uid
    session = client.get('/api/session')
    assert session.status_code == 200
    assert 'ai_spending' not in session.json()
    for target in ('adr', 'other'):
        response = client.get(f'/api/companies/{target}/ai-spending')
        if target == company:
            assert response.status_code == 200
            assert response.json()['monthly_cap_microusd'] == DEFAULT_CAP
            assert response.json()['company_id'] == company
            assert response.headers['cache-control'] == 'private, no-store'
        else:
            assert response.status_code == 403
            assert 'monthly_cap_microusd' not in response.text
    assert not any(k.startswith('_company_ai_budgets/') for k in store.db.records)


def test_live_margin_shared_with_rest_and_resumed_calls(store):
    ledger = CompanySpending(store, 'adr')
    rest = ledger.reserve('audit', DEFAULT_CAP - LIVE_MARGIN)
    with pytest.raises(HTTPException):
        LiveSpending.start(store, 'owner', True, bm.LIVE_MODEL)
    ledger.settle(rest, 0)
    first = LiveSpending.start(store, 'owner', True, bm.LIVE_MODEL)
    second = LiveSpending.start(store, 'estimator', True, bm.LIVE_MODEL)
    first.opened()
    second.opened()
    assert ledger.summary()['reserved_microusd'] == 2 * LIVE_MARGIN
    first.observe(NS(total_token_count=100))
    first.observe(NS(total_token_count=200))
    first.finish()
    first.finish()
    assert ledger.summary()['spent_microusd'] >= 4950
    # Even a resumed provider connection needs a new company hold; user quota is separate.
    resumed = LiveSpending.start(store, 'owner', True, bm.LIVE_MODEL)
    assert ledger.summary()['reserved_microusd'] == 2 * LIVE_MARGIN
    second.finish()
    resumed.finish()


def test_live_estimate_crossing_cap_is_recorded_before_session_is_ended(store, monkeypatch):
    monkeypatch.setattr(LiveSpending, 'now', staticmethod(lambda: 0))
    ledger = CompanySpending(store, 'adr')
    live = LiveSpending.start(store, 'owner', True, bm.LIVE_MODEL)
    live.opened()
    with pytest.raises(HTTPException) as error:
        live.observe(NS(total_token_count=4_000_000))
    assert error.value.status_code == 429
    assert ledger.summary()['reserved_microusd'] == 66_000_000
    with pytest.raises(HTTPException):
        ledger.reserve('ocr', 1)
    live.finish()
    assert ledger.summary()['spent_microusd'] == 66_000_000
    assert ledger.summary()['reserved_microusd'] == 0


def test_live_crash_retains_margin_but_an_undispatched_connection_releases_it(store):
    live = LiveSpending.start(store, 'owner', True, bm.LIVE_MODEL)
    restarted = CompanySpending(FakeCompanyStore(db=store.db, bucket=store.bucket), 'adr')
    assert restarted.summary()['reserved_microusd'] == LIVE_MARGIN
    live.finish()
    assert restarted.summary()['spent_microusd'] == 0
    assert restarted.summary()['reserved_microusd'] == 0


@pytest.mark.parametrize('initial_cap', [0, 3_000_000])
def test_live_relay_refuses_before_connect_or_closes_on_reported_limit(
    api, monkeypatch, initial_cap
):
    from contextlib import asynccontextmanager
    import time

    client, actor, store = api
    monkeypatch.setattr(LiveSpending, 'now', staticmethod(lambda: 0))
    store.create_inspection('owner', ID, data())
    before = deepcopy(store.db.records['inspections/' + ID])
    cap(store, initial_cap)
    connects = []
    closes = []

    async def identity(token, **kwargs):
        return dict(uid='owner', exp=time.time() + 600)

    class Session:
        async def send_client_content(self, **kwargs):
            pass

        async def receive(self):
            yield NS(usage_metadata=NS(total_token_count=200_000))

    @asynccontextmanager
    async def connect(**kwargs):
        connects.append(True)
        yield Session()

    async def close():
        closes.append(True)

    def client_factory(**kwargs):
        assert initial_cap > 0, 'Provider client opened after a cap refusal'
        return NS(aio=NS(live=NS(connect=connect), aclose=close))

    monkeypatch.setattr(bm, 'verify_staff', identity)
    monkeypatch.setattr(bm.genai, 'Client', client_factory)
    with client.websocket_connect('/api/live', headers={'origin': bm.ORIGINS[0]}) as socket:
        socket.send_json(
            dict(
                type='authenticate',
                token='synthetic',
                inspection_id=ID,
                protocol_version=2,
                capture_id='f' * 32,
                workspace_protocol_version=1,
            )
        )
        reply = socket.receive_json()
        if initial_cap:
            assert reply['type'] == 'ready'
            reply = socket.receive_json()
        assert reply['type'] == 'error' and reply['status'] == 429
        assert 'spending limit' in reply['message']
        from starlette.websockets import WebSocketDisconnect

        with pytest.raises(WebSocketDisconnect):
            socket.receive_json()
    assert len(connects) == len(closes) == int(initial_cap > 0)
    assert '_live_sessions/owner' not in store.db.records
    assert store.db.records['inspections/' + ID] == before
    if initial_cap:
        assert CompanySpending(store, 'adr').summary()['spent_microusd'] == 3_300_000


def test_cap_preserves_prepared_agreement_signing_and_manual_draft_saves(api):
    client, actor, store = api
    store.create_inspection('owner', ID, data())
    audited = client.post('/api/audit', json=dict(inspection_id=ID, expected_revision=1))
    assert audited.status_code == 200, audited.text
    saved = audited.json()
    documents = deepcopy(saved['audit']['documents'])
    cap(store, 0)
    signed = client.post(
        '/api/authorize',
        json=dict(
            inspection_id=ID,
            expected_revision=1,
            auth_id='ADR-AUTH-budget12345',
            proposal_hash=saved['audit']['proposal_hash'],
            signature_png=png(),
            documents_confirmed=True,
        ),
    )
    assert signed.status_code == 200, signed.text
    assert store.db.records['authorizations/ADR-AUTH-budget12345']['documents'] == documents
    opened = client.get('/api/authorizations/ADR-AUTH-budget12345')
    assert opened.status_code == 200
    draft_id = 'ADR-INS-' + 'c' * 32
    store.create_inspection('owner', draft_id, data())
    edited = data()
    edited['technician_notes'] = 'Continue measuring and saving without AI.'
    response = client.put(
        f'/api/inspections/{draft_id}', json=dict(expected_revision=1, data=edited)
    )
    assert response.status_code == 200, response.text
    assert response.json()['data']['technician_notes'] == edited['technician_notes']


def test_spending_read_failure_does_not_block_session_or_disclose_another_company(api, monkeypatch):
    client, actor, store = api

    def unavailable(self):
        raise RuntimeError('Synthetic ledger unavailable')

    monkeypatch.setattr(CompanySpending, 'summary', unavailable)
    response = client.get('/api/session')
    assert response.status_code == 200
    assert 'ai_spending' not in response.json()
    assert response.json()['company_id'] == 'adr'
    refused = client.get('/api/companies/adr/ai-spending')
    assert refused.status_code == 503
    assert 'Synthetic' not in refused.text


def test_live_modality_cost_includes_rebilled_context_and_text_transcriptions():
    from google.genai import types
    from backend.live_spending import live_cost

    usage = types.UsageMetadata(
        prompt_token_count=300,
        total_token_count=400,
        prompt_tokens_details=[
            types.ModalityTokenCount(modality='TEXT', token_count=100),
            types.ModalityTokenCount(modality='IMAGE', token_count=100),
            types.ModalityTokenCount(modality='AUDIO', token_count=100),
        ],
        response_tokens_details=[
            types.ModalityTokenCount(modality='TEXT', token_count=50),
            types.ModalityTokenCount(modality='AUDIO', token_count=50),
        ],
    )
    assert live_cost(usage) == 1300
    # Unknown modality/split never treats billable tokens as free.
    assert live_cost(NS(prompt_token_count=300, total_token_count=400)) == 2100
    assert live_cost(NS(total_token_count=400)) == 6600
    assert live_cost(NS()) is None


def test_live_month_change_during_reservation_return_ends_old_month_connection(store, monkeypatch):
    import backend.live_spending as live_spending

    clock = [datetime(2026, 11, 30, 23, 59, 59, tzinfo=timezone.utc).timestamp()]
    monkeypatch.setattr(live_spending.time, 'time', lambda: clock[0])
    reserve = CompanySpending.reserve

    def crosses_month(self, *args, **kwargs):
        result = reserve(self, *args, **kwargs)
        clock[0] += 2
        return result

    monkeypatch.setattr(CompanySpending, 'reserve', crosses_month)
    live = LiveSpending.start(store, 'owner', True, bm.LIVE_MODEL)
    with pytest.raises(HTTPException) as error:
        live.check()
    assert error.value.status_code == 409
    assert 'UTC month' in error.value.detail
    live.finish()
    assert CompanySpending(store, 'adr').summary()['reserved_microusd'] == 0
    assert CompanySpending(store, 'adr').summary()['spent_microusd'] == 0


def test_real_sdk_does_not_retry_billable_requests_inside_one_reservation(store, monkeypatch):
    import httpx
    from google.oauth2.credentials import Credentials

    monkeypatch.setattr(bm, 'WORKSPACES_ENABLED', True)
    monkeypatch.setattr(bm, 'genai_client', None)
    requests = []
    ledger = CompanySpending(store, 'adr')

    async def respond(request):
        requests.append((request.url.path, json.loads(request.content)))
        if request.url.path.endswith(':countTokens'):
            assert ledger.summary()['reserved_microusd'] == 0
            return httpx.Response(200, json={'totalTokens': 100})
        assert ledger.summary()['reserved_microusd'] == rest_allowance(bm.OCR_MODEL, 100, 'ocr')
        assert requests[0][1]['generationConfig'] == requests[-1][1]['generationConfig']
        return httpx.Response(
            503,
            json={
                'error': {
                    'code': 503,
                    'message': 'Synthetic transient error',
                    'status': 'UNAVAILABLE',
                }
            },
        )

    real_client = bm.genai.Client

    def client(**kwargs):
        options = kwargs.pop('http_options').model_copy(
            update={
                'httpx_async_client': httpx.AsyncClient(transport=httpx.MockTransport(respond)),
            }
        )
        return real_client(
            credentials=Credentials(token='synthetic-token'), http_options=options, **kwargs
        )

    monkeypatch.setattr(bm.genai, 'Client', client)

    async def invoke():
        try:
            with pytest.raises(HTTPException) as error:
                await GENERATE(
                    bm.OcrResult,
                    ['Synthetic photo'],
                    bm.OCR_MODEL,
                    'ocr',
                    ID,
                    spending=(store, 'owner'),
                )
            assert error.value.status_code == 502
        finally:
            await bm.get_ai_client().aio.aclose()

    asyncio.run(invoke())
    assert len(requests) == 2
    assert requests[0][0].endswith(':countTokens')
    assert requests[1][0].endswith(':generateContent')
    assert ledger.summary()['spent_microusd'] == 0


def test_budget_refusal_is_not_reported_as_a_provider_outage(store, monkeypatch, capsys):
    monkeypatch.setattr(bm, 'WORKSPACES_ENABLED', True)
    cap(store, 0)
    with pytest.raises(HTTPException) as error:
        asyncio.run(
            GENERATE(
                bm.AIResult,
                ['observations'],
                bm.AUDIT_MODEL,
                'audit',
                ID,
                spending=(store, 'owner'),
            )
        )
    assert error.value.status_code == 429
    rows = [
        json.loads(line) for line in capsys.readouterr().out.splitlines() if line.startswith('{')
    ]
    assert not any(row['message'] == 'Vertex AI call' for row in rows)
    refusal = next(row for row in rows if row['message'] == 'Company AI request refused')
    assert refusal['severity'] == 'INFO'
    assert refusal['status'] == 429
