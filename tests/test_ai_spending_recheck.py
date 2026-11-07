"""Output headroom and retryable ledger contention from the independent re-check."""

import asyncio
import json
from copy import deepcopy
from types import SimpleNamespace as NS
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from google.api_core.exceptions import Aborted, ServiceUnavailable
from google.cloud import firestore

from backend import main as bm
from backend.ai_spending import CompanySpending, HELD_MESSAGE
from tests.fakes import png
from tests.test_workspaces import store, api, data, ID, PHOTO

GENERATE = bm.generate


def photo_draft(store):
    form = data()
    form['technician_notes'] = 'Bathroom walls are wet.'
    store.create_inspection('owner', ID, form)
    store.add_photo(
        'owner',
        ID,
        dict(
            photo_id=PHOTO, expected_revision=1, room='Bathroom', captured_at='2026', data_url=png()
        ),
    )
    return deepcopy(store.db.records['inspections/' + ID])


def provider(monkeypatch, respond, counted=None):
    async def count_tokens(**kwargs):
        if counted is not None:
            counted.append(kwargs['config'].generation_config)
        return NS(total_tokens=100)

    monkeypatch.setattr(bm, 'generate', GENERATE)
    monkeypatch.setattr(
        bm,
        'get_ai_client',
        lambda: NS(aio=NS(models=NS(count_tokens=count_tokens, generate_content=respond))),
    )


@pytest.mark.parametrize('operation, maximum', [('ocr', 8192), ('scope', 16384)])
def test_endpoint_output_headroom_is_counted_and_reserved_without_changing_thinking(
    api,
    monkeypatch,
    operation,
    maximum,
):
    client, _, store = api
    record = photo_draft(store)
    counted = []
    generated = []

    async def respond(**kwargs):
        config = kwargs['config']
        generated.append(config)
        assert config.max_output_tokens == maximum
        assert counted[0].max_output_tokens == maximum
        if operation == 'ocr':
            assert config.thinking_config is counted[0].thinking_config is None
            result = dict(
                meter_detected=True,
                meter_type='moisture',
                value='17',
                classification='wet',
                notes='',
            )
        else:
            assert config.thinking_config.thinking_level == bm.SCOPE_THINKING_LEVEL
            assert counted[0].thinking_config.thinking_level == bm.SCOPE_THINKING_LEVEL
            result = dict(changes=[], questions=[])
        assert (
            CompanySpending(store, 'adr').summary()['reserved_microusd']
            == (100 * 165 + maximum * 825 + 99) // 100
        )
        return NS(
            text=json.dumps(result),
            usage_metadata=NS(prompt_token_count=100, total_token_count=200),
        )

    provider(monkeypatch, respond, counted)
    if operation == 'ocr':
        response = client.post(f'/api/inspections/{ID}/photos/{PHOTO}/ocr')
    else:
        response = client.post(
            f'/api/inspections/{ID}/scope-suggestions',
            json=dict(inspection_id=ID, expected_revision=record['revision']),
        )
    assert response.status_code == 200, response.text
    assert len(counted) == len(generated) == 1
    assert CompanySpending(store, 'adr').summary()['reserved_microusd'] == 0


def commit_contention(wrapped):
    error = Aborted('Synthetic private transaction details')
    if not wrapped:
        raise error
    # Exercise the installed Firestore SDK's actual exhausted-retry exception chain.
    transaction = Mock(_read_only=False, _max_attempts=1, _id=b'synthetic')
    transaction._commit.side_effect = error
    return firestore.transactional(lambda tx: None)(transaction)


def ledger_fault(monkeypatch, store, attempt, fail):
    calls = []

    def atomic(callback):
        calls.append(callback)
        if len(calls) == attempt:
            return fail()
        return store._atomic(callback)

    ledger = CompanySpending(NS(db=store.db, _atomic=atomic), 'adr')
    monkeypatch.setattr(CompanySpending, 'actor', classmethod(lambda cls, *args: ledger))
    return ledger


@pytest.mark.parametrize('wrapped', [False, True])
@pytest.mark.parametrize('attempt', [1, 2])
def test_contended_precheck_or_reservation_returns_retryable_429_and_preserves_photo(
    api,
    monkeypatch,
    wrapped,
    attempt,
):
    client, _, store = api
    before = photo_draft(store)
    evidence = deepcopy(store.bucket.objects)
    counted = []
    ledger = ledger_fault(monkeypatch, store, attempt, lambda: commit_contention(wrapped))

    async def forbidden(**kwargs):
        pytest.fail('Generation dispatched after ledger contention')

    provider(monkeypatch, forbidden, counted)
    response = client.post(f'/api/inspections/{ID}/photos/{PHOTO}/ocr')
    assert response.status_code == 429, response.text
    assert response.headers['retry-after'] == '60'
    assert response.json()['detail'] == HELD_MESSAGE
    assert len(counted) == attempt - 1
    assert store.db.records['inspections/' + ID] == before
    assert store.bucket.objects == evidence
    assert ledger.summary()['reserved_microusd'] == 0


def test_contended_settlement_preserves_paid_ocr_result_and_durable_hold(api, monkeypatch):
    client, _, store = api
    photo_draft(store)
    ledger = ledger_fault(monkeypatch, store, 3, lambda: commit_contention(True))

    async def respond(**kwargs):
        return NS(
            text=json.dumps(
                dict(
                    meter_detected=True,
                    meter_type='moisture',
                    value='17',
                    classification='wet',
                    notes='',
                )
            ),
            usage_metadata=NS(prompt_token_count=100, total_token_count=200),
        )

    provider(monkeypatch, respond)
    response = client.post(f'/api/inspections/{ID}/photos/{PHOTO}/ocr')
    assert response.status_code == 200, response.text
    photo, _ = store.photo('owner', ID, PHOTO)
    assert photo['ocr_status'] == 'verified'
    assert photo['ocr']['value'] == '17'
    usage = ledger.summary()
    assert usage['spent_microusd'] == 0
    assert usage['reserved_microusd'] > 0


@pytest.mark.parametrize(
    'error, status',
    [
        (ValueError('Failed to commit transaction in 5 attempts.'), 400),
        (ServiceUnavailable('Synthetic outage'), 503),
    ],
)
def test_noncontention_ledger_errors_keep_their_existing_mapping(api, monkeypatch, error, status):
    _, _, store = api

    def fail():
        raise error

    ledger = ledger_fault(monkeypatch, store, 1, fail)
    with pytest.raises(HTTPException) as result:
        asyncio.run(bm.stored(ledger.summary))
    assert result.value.status_code == status
    assert not result.value.headers or 'Retry-After' not in result.value.headers
