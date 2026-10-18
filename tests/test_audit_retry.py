"""A stalled audit attempt is cancelled and retried once, always inside the REST deadline."""

import asyncio
import json
import time
from types import SimpleNamespace
import pytest
from fastapi import HTTPException
import backend.claims as claims
import backend.main as bm
from tests.test_backend import context, inspect, ID
from tests.test_logging import entries

REPLY = {'summary': 'Scope confirmed.', 'suggestions': [], 'unpriced_work': []}


@pytest.fixture
def budget(monkeypatch):
    # The production 55/25/10/5-second budget, scaled down so a stall costs about a second.
    monkeypatch.setattr(bm, 'REST_DEADLINE_SECONDS', 4.0)
    monkeypatch.setattr(bm, 'AUDIT_ATTEMPT_SECONDS', 1.0)
    monkeypatch.setattr(bm, 'AUDIT_RETRY_MIN_SECONDS', 0.8)
    monkeypatch.setattr(bm, 'AUDIT_SAVE_RESERVE_SECONDS', 0.4)


def provider(monkeypatch, delays):
    """Each call takes the next delay in seconds; records whether it finished or was cancelled."""
    calls = []

    async def respond(**kwargs):
        assert kwargs['config'].thinking_config.thinking_level == bm.AUDIT_THINKING_LEVEL
        call = dict(outcome='running')
        calls.append(call)
        try:
            await asyncio.sleep(delays[len(calls) - 1])
        except asyncio.CancelledError:
            call['outcome'] = 'cancelled'
            raise
        call['outcome'] = 'finished'
        return SimpleNamespace(text=json.dumps(REPLY))

    monkeypatch.setattr(
        bm,
        'get_ai_client',
        lambda: SimpleNamespace(
            aio=SimpleNamespace(models=SimpleNamespace(generate_content=respond))
        ),
    )
    return calls


def counted_saves(monkeypatch, store):
    saves = []
    save = store.save_audit

    def record(*args):
        saves.append(args[2])
        return save(*args)

    monkeypatch.setattr(store, 'save_audit', record)
    return saves


def post_audit(client, record):
    started = time.monotonic()
    response = client.post(
        '/api/audit', json={'inspection_id': ID, 'expected_revision': record['revision']}
    )
    return response, time.monotonic() - started


def messages(capsys, name):
    return [e for e in entries(capsys) if e['message'] == name]


def test_fast_audit_succeeds_on_the_first_attempt(context, budget, monkeypatch, capsys):
    client, store = context
    record = inspect(client)
    calls = provider(monkeypatch, [0])
    saves = counted_saves(monkeypatch, store)
    capsys.readouterr()
    response, _ = post_audit(client, record)
    assert response.status_code == 200, response.text
    assert [c['outcome'] for c in calls] == ['finished'] and saves == [record['revision']]
    assert not messages(capsys, 'Vertex AI retry')


def test_stalled_first_attempt_is_cancelled_and_retried_once(context, budget, monkeypatch, capsys):
    client, store = context
    record = inspect(client)
    calls = provider(monkeypatch, [30, 0])
    saves = counted_saves(monkeypatch, store)
    capsys.readouterr()
    response, elapsed = post_audit(client, record)
    assert response.status_code == 200, response.text
    assert response.json()['audit']['documents']['signable']
    # The stalled request was cancelled, not left running, and only the retry's result was saved.
    assert [c['outcome'] for c in calls] == ['cancelled', 'finished']
    assert saves == [record['revision']]
    assert bm.AUDIT_ATTEMPT_SECONDS <= elapsed < bm.REST_DEADLINE_SECONDS
    output = entries(capsys)
    assert [e['outcome'] for e in output if e['message'] == 'Vertex AI call'] == ['timeout', 'ok']
    [retry] = [e for e in output if e['message'] == 'Vertex AI retry']
    assert retry['severity'] == 'WARNING' and retry['operation'] == 'audit'
    assert retry['inspection_id'] == ID and 1600 <= retry['timeout_ms'] <= 2700
    assert set(retry) == {
        'severity',
        'message',
        'model',
        'operation',
        'elapsed_ms',
        'timeout_ms',
        'inspection_id',
    }


def test_two_stalled_attempts_fail_before_the_deadline(context, budget, monkeypatch, capsys):
    client, store = context
    record = inspect(client)
    calls = provider(monkeypatch, [30, 30])
    saves = counted_saves(monkeypatch, store)
    capsys.readouterr()
    response, elapsed = post_audit(client, record)
    # The audit's own timeout answers before the REST deadline, and nothing was saved.
    assert response.status_code == 504
    assert response.json()['detail'].startswith('AI generation timed out.')
    assert elapsed < bm.REST_DEADLINE_SECONDS
    assert [c['outcome'] for c in calls] == ['cancelled', 'cancelled'] and saves == []
    assert client.get('/api/inspections/' + ID).json()['audit'] is None
    assert len(messages(capsys, 'Vertex AI retry')) == 1


def test_no_retry_when_too_little_of_the_deadline_remains(budget, monkeypatch, capsys):
    # As if an OCR wait used most of the deadline: 1.7 s remain, too little for a 0.8 s retry
    # after a 1 s attempt, so the only attempt gets all of it.
    def spent():
        return time.monotonic() - (bm.REST_DEADLINE_SECONDS - bm.AUDIT_SAVE_RESERVE_SECONDS - 1.7)

    calls = provider(monkeypatch, [1.25])
    result = asyncio.run(bm.generate_audit(['Synthetic audit'], ID, spent()))
    assert result.summary == 'Scope confirmed.' and [c['outcome'] for c in calls] == ['finished']

    calls = provider(monkeypatch, [30])
    capsys.readouterr()
    started = time.monotonic()
    with pytest.raises(HTTPException) as error:
        asyncio.run(bm.generate_audit(['Synthetic audit'], ID, spent()))
    assert error.value.status_code == 504 and time.monotonic() - started < 2.5
    assert [c['outcome'] for c in calls] == ['cancelled']
    assert not messages(capsys, 'Vertex AI retry')


def test_provider_errors_are_not_retried(context, budget, monkeypatch):
    client, _ = context
    record = inspect(client)
    calls = []

    async def rejected(**kwargs):
        calls.append(kwargs)
        raise RuntimeError('provider unavailable')

    monkeypatch.setattr(
        bm,
        'get_ai_client',
        lambda: SimpleNamespace(
            aio=SimpleNamespace(models=SimpleNamespace(generate_content=rejected))
        ),
    )
    response, _ = post_audit(client, record)
    assert response.status_code == 502 and len(calls) == 1


def test_unchanged_revision_reuses_the_saved_audit(context, budget, monkeypatch):
    client, store = context
    record = inspect(client)
    calls = provider(monkeypatch, [0, 0])
    saves = counted_saves(monkeypatch, store)
    first, _ = post_audit(client, record)
    again, _ = post_audit(client, record)
    assert first.status_code == again.status_code == 200, again.text
    # A second Finish & review on the same revision returns the saved audit without the model.
    assert again.json()['audit'] == first.json()['audit'] and len(calls) == 1
    assert saves == [record['revision']]
    # Any input edit clears the audit, so the next Finish & review runs the model again.
    edited = dict(record['data'], technician_notes='Edited notes.')
    saved = client.put(
        '/api/inspections/' + ID, json={'expected_revision': record['revision'], 'data': edited}
    ).json()
    rerun, _ = post_audit(client, saved)
    assert rerun.status_code == 200 and len(calls) == 2
    assert saves == [record['revision'], saved['revision']]


def test_a_new_proposal_date_regenerates_the_saved_audit(context, budget, monkeypatch):
    client, _ = context
    record = inspect(client)
    calls = provider(monkeypatch, [0, 0])
    post_audit(client, record)
    for module in (bm, claims):
        monkeypatch.setattr(module, 'proposal_date', lambda: '01-01-2099')
    dated, _ = post_audit(client, record)
    assert dated.json()['audit']['documents']['adr_estimate']['date'] == '01-01-2099'
    assert len(calls) == 2
