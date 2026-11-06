"""Regressions for the independent review's false charges and relay ordering."""

import asyncio
import json
import threading
import time
from contextlib import asynccontextmanager
from types import SimpleNamespace as NS

import pytest
from fastapi import HTTPException
from google.genai import errors

from backend import ai_spending, live_spending, main as bm
from backend.ai_spending import CompanySpending, LIVE_MARGIN
from backend.live_spending import LiveSpending
from tests.test_workspaces import store, api, data, ID

GENERATE = bm.generate


def fake_provider(monkeypatch, respond, count=100):
    async def count_tokens(**kwargs):
        return NS(total_tokens=count)

    monkeypatch.setattr(bm, 'WORKSPACES_ENABLED', True)
    monkeypatch.setattr(
        bm,
        'get_ai_client',
        lambda: NS(aio=NS(models=NS(generate_content=respond, count_tokens=count_tokens))),
    )


def invoke(store, operation='audit'):
    return asyncio.run(
        GENERATE(
            bm.AIResult,
            ['observations'],
            bm.AUDIT_MODEL,
            operation,
            ID,
            spending=(store, 'owner'),
        )
    )


def test_never_opened_live_connections_settle_zero(store):
    ledger = CompanySpending(store, 'adr')
    for _ in range(4):
        live = LiveSpending.start(store, 'owner', True, bm.LIVE_MODEL)
        live.finish()
    assert ledger.summary()['spent_microusd'] == 0
    assert ledger.summary()['reserved_microusd'] == 0


def test_connected_unreported_live_uses_only_connected_time_floor(store, monkeypatch):
    clock = [0.0]
    monkeypatch.setattr(live_spending.time, 'monotonic', lambda: clock[0])
    ledger = CompanySpending(store, 'adr')
    for _ in range(4):
        live = LiveSpending.start(store, 'owner', True, bm.LIVE_MODEL)
        clock[0] += 30  # Connection setup is not billable session time.
        live.opened()
        clock[0] += 60
        live.finish()
    assert ledger.summary()['spent_microusd'] == 400_000
    assert ledger.summary()['reserved_microusd'] == 0


def test_live_cleanup_time_is_excluded_from_unreported_floor(store, monkeypatch):
    clock = [0]
    monkeypatch.setattr(LiveSpending, 'now', staticmethod(lambda: clock[0]))
    live = LiveSpending.start(store, 'owner', True, bm.LIVE_MODEL)
    live.opened()
    clock[0] = 60
    live.closed()
    clock[0] = 3600
    live.finish()
    assert CompanySpending(store, 'adr').summary()['spent_microusd'] == 100_000


@pytest.mark.parametrize('tail, expected', [(0, 1500), (60, 101500)])
def test_live_reported_cost_replaces_elapsed_floor_and_only_tail_is_estimated(
    store,
    monkeypatch,
    tail,
    expected,
):
    clock = [0.0]
    monkeypatch.setattr(live_spending.time, 'monotonic', lambda: clock[0])
    live = LiveSpending.start(store, 'owner', True, bm.LIVE_MODEL)
    live.opened()
    clock[0] = 3600
    live.observe(NS(prompt_token_count=100, total_token_count=200))
    clock[0] += tail
    live.finish()
    assert CompanySpending(store, 'adr').summary()['spent_microusd'] == expected


@pytest.mark.parametrize('code', [429, 500, 503])
def test_provider_http_errors_release_hold(store, monkeypatch, code):
    async def respond(**kwargs):
        raise errors.APIError(code, {'error': {'code': code, 'message': 'synthetic'}})

    fake_provider(monkeypatch, respond)
    for _ in range(4):
        with pytest.raises(HTTPException) as error:
            invoke(store)
        assert error.value.status_code == 502
    usage = CompanySpending(store, 'adr').summary()
    assert usage['spent_microusd'] == usage['reserved_microusd'] == 0


@pytest.mark.parametrize('failure', [TimeoutError, asyncio.CancelledError, ConnectionError])
def test_uncertain_transport_outcomes_still_charge_the_exact_hold(store, monkeypatch, failure):
    reservations = []

    async def respond(**kwargs):
        reservations.append(CompanySpending(store, 'adr').summary()['reserved_microusd'])
        raise failure()

    fake_provider(monkeypatch, respond)
    with pytest.raises((HTTPException, asyncio.CancelledError)):
        invoke(store)
    usage = CompanySpending(store, 'adr').summary()
    assert reservations[0] > 0
    assert usage['spent_microusd'] == reservations[0]
    assert usage['reserved_microusd'] == 0


def test_hold_without_time_left_is_released_without_dispatch(store, monkeypatch):
    calls = []

    async def respond(**kwargs):
        calls.append(kwargs)
        return NS(text='{}')

    fake_provider(monkeypatch, respond)
    held = asyncio.run(
        bm.reserve_generation(
            ['observations'],
            bm.AUDIT_MODEL,
            'transcribe',
            bm.generation_config(bm.TranscriptionResult, bm.AUDIT_MODEL, 'transcribe'),
            (store, 'owner'),
            time.monotonic() + 15,
        )
    )
    assert CompanySpending(store, 'adr').summary()['reserved_microusd'] > 0
    with pytest.raises(HTTPException) as error:
        asyncio.run(
            GENERATE(
                bm.TranscriptionResult,
                ['observations'],
                bm.AUDIT_MODEL,
                'transcribe',
                ID,
                timeout=0,
                spending=held,
            )
        )
    assert error.value.status_code == 504 and calls == []
    held.release_unused()
    usage = CompanySpending(store, 'adr').summary()
    assert usage['spent_microusd'] == usage['reserved_microusd'] == 0


def test_settlement_failure_returns_paid_result_and_preserves_hold(store, monkeypatch, capsys):
    async def respond(**kwargs):
        return NS(
            text=json.dumps(
                dict(summary='Private paid observation.', suggestions=[], unpriced_work=[])
            ),
            usage_metadata=NS(prompt_token_count=100, total_token_count=200),
        )

    fake_provider(monkeypatch, respond)

    def broken(*args, **kwargs):
        raise RuntimeError('Private provider text must never be logged')

    monkeypatch.setattr(CompanySpending, 'settle', broken)
    assert invoke(store).summary == 'Private paid observation.'
    usage = CompanySpending(store, 'adr').summary()
    assert usage['spent_microusd'] == 0
    assert usage['reserved_microusd'] > 0
    logs = capsys.readouterr().out
    assert 'Private paid observation' not in logs
    assert 'Private provider text' not in logs
    assert 'AI spending settlement failed' in logs
    assert 'Vertex AI call' in logs


def paid_reply():
    async def respond(**kwargs):
        return NS(
            text=json.dumps(dict(summary='Scope confirmed.', suggestions=[], unpriced_work=[])),
            usage_metadata=NS(prompt_token_count=100, total_token_count=200),
        )

    return respond


def timed(store, timeout):
    started = time.monotonic()
    try:
        return asyncio.run(
            GENERATE(
                bm.AIResult,
                ['observations'],
                bm.AUDIT_MODEL,
                'audit',
                ID,
                timeout=timeout,
                spending=(store, 'owner'),
            )
        ), time.monotonic() - started
    except HTTPException as error:
        return error, time.monotonic() - started


def test_slow_settlement_returns_paid_result_by_the_deadline(store, monkeypatch, capsys):
    fake_provider(monkeypatch, paid_reply())
    settle, done = CompanySpending.settle, threading.Event()

    def slow(self, *args):
        time.sleep(1.5)
        settle(self, *args)
        done.set()

    monkeypatch.setattr(CompanySpending, 'settle', slow)
    result, elapsed = timed(store, 0.5)
    assert result.summary == 'Scope confirmed.' and elapsed < 1.0
    assert CompanySpending(store, 'adr').summary()['reserved_microusd'] > 0
    assert 'AI spending settlement failed' in capsys.readouterr().out
    assert done.wait(5)


def test_slow_prechecks_shorten_token_counting(store, monkeypatch):
    calls = []

    async def respond(**kwargs):
        calls.append(kwargs)

    async def count_tokens(**kwargs):
        await asyncio.sleep(3)

    fake_provider(monkeypatch, respond)
    monkeypatch.setattr(
        bm,
        'get_ai_client',
        lambda: NS(aio=NS(models=NS(generate_content=respond, count_tokens=count_tokens))),
    )
    check = CompanySpending.check_available

    def slow(self, *args):
        time.sleep(0.6)
        return check(self, *args)

    monkeypatch.setattr(CompanySpending, 'check_available', slow)
    error, elapsed = timed(store, 1.0)
    assert error.status_code == 504 and elapsed < 1.4 and calls == []
    usage = CompanySpending(store, 'adr').summary()
    assert usage['spent_microusd'] == usage['reserved_microusd'] == 0


def test_missing_company_override_follows_platform_default(store, monkeypatch):
    ledger = CompanySpending(store, 'adr')
    ledger.settle(ledger.reserve('ocr', 100), 10)
    assert '_company_ai_budgets/adr' not in store.db.records
    monkeypatch.setattr(ai_spending, 'DEFAULT_CAP', 12_000_000)
    assert ledger.summary()['monthly_cap_microusd'] == 12_000_000
    store.db.records['_company_ai_budgets/adr'] = dict(monthly_cap_microusd=7_000_000)
    ledger.reserve('ocr', 100)
    assert ledger.summary()['monthly_cap_microusd'] == 7_000_000


def test_counted_request_and_operation_output_limit_determine_hold(store, monkeypatch):
    seen = []

    async def count_tokens(**kwargs):
        seen.append('count')
        assert kwargs['contents'] == ['observations']
        schema = kwargs['config'].generation_config.response_schema
        assert set(schema.properties) == set(bm.AIResult.model_fields)
        assert schema.required == ['summary', 'suggestions', 'unpriced_work']
        assert schema.additional_properties is False
        return NS(total_tokens=100)

    async def respond(**kwargs):
        assert seen == ['count']
        limit = kwargs['config'].max_output_tokens
        assert 0 < limit < ai_spending.REST_OUTPUT_LIMIT
        expected = (
            100 * ai_spending.REST_INPUT_RATE + limit * ai_spending.REST_OUTPUT_RATE + 99
        ) // 100
        held = CompanySpending(store, 'adr').summary()['reserved_microusd']
        assert held == expected
        assert held < 200_000
        return NS(
            text=json.dumps(dict(summary='Counted.', suggestions=[], unpriced_work=[])),
            usage_metadata=NS(prompt_token_count=100, total_token_count=200),
        )

    fake_provider(monkeypatch, respond)
    client = bm.get_ai_client()
    client.aio.models.count_tokens = count_tokens
    monkeypatch.setattr(bm, 'get_ai_client', lambda: client)
    assert invoke(store).summary == 'Counted.'


def test_small_counted_calls_share_last_allowance_under_concurrency(store, monkeypatch):
    from backend.ai_spending import rest_allowance

    bound = rest_allowance(bm.AUDIT_MODEL, 100, 'ocr')
    store.db.records['_company_ai_budgets/adr'] = dict(monthly_cap_microusd=3 * bound)
    active = []
    release = asyncio.Event()

    async def respond(**kwargs):
        active.append(True)
        await release.wait()
        return NS(
            text=json.dumps(dict(summary='Small request.', suggestions=[], unpriced_work=[])),
            usage_metadata=NS(prompt_token_count=100, total_token_count=200),
        )

    fake_provider(monkeypatch, respond)

    async def concurrent():
        calls = [
            asyncio.create_task(
                GENERATE(
                    bm.AIResult,
                    ['observations'],
                    bm.AUDIT_MODEL,
                    'ocr',
                    ID,
                    spending=(store, 'owner'),
                )
            )
            for _ in range(10)
        ]
        try:
            async with asyncio.timeout(5):
                while len(active) < 3 or sum(task.done() for task in calls) < 7:
                    await asyncio.sleep(0.01)
            assert CompanySpending(store, 'adr').summary()['reserved_microusd'] == 3 * bound
        finally:
            release.set()
        return await asyncio.gather(*calls, return_exceptions=True)

    results = asyncio.run(concurrent())
    assert len(active) == 3
    assert sum(isinstance(result, bm.AIResult) for result in results) == 3
    refusals = [result for result in results if isinstance(result, HTTPException)]
    assert len(refusals) == 7 and all(error.status_code == 429 for error in refusals)
    assert CompanySpending(store, 'adr').summary()['reserved_microusd'] == 0


@pytest.mark.parametrize('count', [None, -1, '100', 1_048_577])
def test_invalid_token_count_never_dispatches_generation_or_creates_hold(store, monkeypatch, count):
    async def forbidden(**kwargs):
        pytest.fail('Generation dispatched without a verified input count')

    fake_provider(monkeypatch, forbidden, count=count)
    with pytest.raises(HTTPException) as error:
        invoke(store)
    assert error.value.status_code == 503
    assert not any(key.startswith('_company_ai_reservations/') for key in store.db.records)


def test_live_audio_is_forwarded_before_usage_transaction(api, monkeypatch):
    import time

    client, _actor, store = api
    store.create_inspection('owner', ID, data())
    store.db.records['_company_ai_budgets/adr'] = dict(monthly_cap_microusd=3_000_000)

    async def identity(token, **kwargs):
        return dict(uid='owner', exp=time.time() + 600)

    class Session:
        async def send_client_content(self, **kwargs):
            pass

        async def receive(self):
            yield NS(
                usage_metadata=NS(total_token_count=200_000),
                server_content=NS(
                    interrupted=False,
                    input_transcription=None,
                    output_transcription=None,
                    turn_complete=False,
                    model_turn=NS(parts=[NS(inline_data=NS(data=b'\0\0'))]),
                ),
            )

    @asynccontextmanager
    async def connect(**kwargs):
        yield Session()

    async def close():
        pass

    monkeypatch.setattr(bm, 'verify_staff', identity)
    monkeypatch.setattr(
        bm.genai, 'Client', lambda **kw: NS(aio=NS(live=NS(connect=connect), aclose=close))
    )
    with client.websocket_connect('/api/live', headers={'origin': bm.ORIGINS[0]}) as socket:
        socket.send_json(
            dict(
                type='authenticate',
                token='synthetic',
                inspection_id=ID,
                protocol_version=2,
                capture_id='e' * 32,
                workspace_protocol_version=1,
            )
        )
        assert socket.receive_json()['type'] == 'ready'
        assert socket.receive_json()['type'] == 'audio'
        refusal = socket.receive_json()
        assert refusal['type'] == 'error' and refusal['status'] == 429
        assert refusal['retry_after'] > 0
        assert f'{refusal["retry_after"]} seconds' in refusal['message']


@pytest.mark.parametrize('http_code', [None, 429])
def test_failed_live_provider_open_releases_hold_and_relays_quota_retry(
    api, monkeypatch, http_code
):
    import time

    client, _actor, store = api
    store.create_inspection('owner', ID, data())

    async def identity(token, **kwargs):
        return dict(uid='owner', exp=time.time() + 600)

    @asynccontextmanager
    async def connect(**kwargs):
        if http_code:
            raise errors.APIError(http_code, {'error': {'code': http_code, 'message': 'synthetic'}})
        raise ConnectionError('synthetic connection failure')
        yield  # Makes this a provider context manager; it never opens.

    async def close():
        pass

    monkeypatch.setattr(bm, 'verify_staff', identity)
    monkeypatch.setattr(
        bm.genai, 'Client', lambda **kw: NS(aio=NS(live=NS(connect=connect), aclose=close))
    )
    with client.websocket_connect('/api/live', headers={'origin': bm.ORIGINS[0]}) as socket:
        socket.send_json(
            dict(
                type='authenticate',
                token='synthetic',
                inspection_id=ID,
                protocol_version=2,
                capture_id='d' * 32,
                workspace_protocol_version=1,
            )
        )
        reply = socket.receive_json()
        assert reply['type'] == 'error'
        if http_code:
            assert reply['status'] == 429 and reply['retry_after'] == 60
            assert 'Retry in 60 seconds' in reply['message']
    usage = CompanySpending(store, 'adr').summary()
    assert usage['spent_microusd'] == usage['reserved_microusd'] == 0
    assert '_live_sessions/owner' not in store.db.records
