"""Synthetic tests for transcript-derived, review-only form suggestions."""

import json
from types import SimpleNamespace
import pytest
import backend.main as bm
from tests.test_backend import context, data, ID
from backend.contracts import InspectionData
from backend.scope import ScopeSuggestions, validate_suggestions

WORDS = 'Bathroom, category 2, 80 square feet of drywall. Use 3 fans and 1 dehumidifier for 3 days.'


def change(field, value, quote=WORDS, room=None):
    return dict(field=field, value=value, room=room, source_quote=quote)


def prepared(client, **extra):
    values = data()
    values.update({'technician_transcript': WORDS, **extra})
    return client.post('/api/inspections', json={'inspection_id': ID, 'data': values}).json()


def provider(monkeypatch, changes, callback=None, questions=None):
    async def respond(**kwargs):
        assert kwargs['config'].response_schema == bm.scope_response_schema()
        assert 'assistant_transcript' not in str(kwargs['contents'])
        if callback:
            callback()
        return SimpleNamespace(text=json.dumps(dict(changes=changes, questions=questions or [])))

    monkeypatch.setattr(
        bm,
        'get_ai_client',
        lambda: SimpleNamespace(
            aio=SimpleNamespace(models=SimpleNamespace(generate_content=respond))
        ),
    )


def suggest(client, revision=1):
    return client.post(
        '/api/inspections/' + ID + '/scope-suggestions',
        json=dict(inspection_id=ID, expected_revision=revision),
    )


def test_scope_suggestions_are_grounded_read_only_and_preserve_confirmation(context, monkeypatch):
    client, store = context
    record = prepared(client)
    provider(
        monkeypatch,
        [
            change('category', 2, room='Bathroom'),
            change('finished_sf', 80, room='Bathroom'),
            change('air_movers', 3),
        ],
    )
    result = suggest(client)
    assert result.status_code == 200, result.text
    assert [c['field'] for c in result.json()['changes']] == ['category', 'finished_sf']
    assert bm.public_record(store.get_inspection('owner', ID)) == record
    assert result.headers['Cache-Control'] == 'private, no-store'


@pytest.mark.parametrize(
    'proposal',
    [
        change('air_movers', 99, quote='Invented statement'),
        change('scope_confirmed', True),
        change('unit_price', 1),
        change('work_performed', True),
        change('has_crawl_space', True),
        change('granite_removal', True),
        change('water_heater_loss', True),
        change('labor_hours', -1),
        change('air_movers', 3.5),
        change('air_movers', '3'),
        change('year_built', 9999),
        change('finished_sf', 80),
        change('address', 'Other address', room='Bathroom'),
        change('air_movers', 3, quote='   '),
        change('category', True, room='Bathroom'),
    ],
)
def test_invalid_or_ungrounded_suggestions_do_not_change_draft(context, monkeypatch, proposal):
    client, store = context
    record = prepared(client)
    provider(monkeypatch, [proposal])
    assert suggest(client).status_code == 502
    assert bm.public_record(store.get_inspection('owner', ID)) == record


def test_new_room_requires_explicit_category_and_demolition_area(context, monkeypatch):
    client, store = context
    record = prepared(client, rooms=[])
    provider(monkeypatch, [change('finished_sf', 80, room='Bathroom')])
    assert suggest(client).status_code == 502
    provider(
        monkeypatch,
        [change('category', 2, room='Bathroom'), change('finished_sf', 80, room='Bathroom')],
    )
    response = suggest(client)
    assert response.status_code == 200, response.text
    assert (
        len(response.json()['changes']) == 2
        and bm.public_record(store.get_inspection('owner', ID)) == record
    )


def test_assistant_only_and_stale_or_cross_owner_requests_rejected(context, monkeypatch):
    client, store = context
    record = prepared(
        client, technician_transcript='', technician_notes='', assistant_transcript=WORDS
    )
    provider(monkeypatch, [change('air_movers', 3)])
    assert suggest(client).status_code == 400
    assert suggest(client, 2).status_code == 409
    bm.app.dependency_overrides[bm.current_staff] = lambda: {'uid': 'other'}
    assert suggest(client).status_code == 404
    bm.app.dependency_overrides.pop(bm.current_staff)
    assert suggest(client).status_code == 401
    assert bm.public_record(store.get_inspection('owner', ID)) == record


def test_changes_during_provider_request_reject_result(context, monkeypatch):
    client, store = context
    record = prepared(client)
    revised = dict(record['data'], air_movers=4)
    provider(
        monkeypatch,
        [change('category', 2, room='Bathroom')],
        lambda: store.update_inspection('owner', ID, 1, revised),
    )
    assert suggest(client).status_code == 409
    assert store.get_inspection('owner', ID)['data']['air_movers'] == 4


def test_signed_draft_and_provider_outage_cannot_apply_changes(context, monkeypatch):
    client, store = context
    record = prepared(client)

    async def unavailable(**kwargs):
        raise RuntimeError('Synthetic provider outage')

    monkeypatch.setattr(
        bm,
        'get_ai_client',
        lambda: SimpleNamespace(
            aio=SimpleNamespace(models=SimpleNamespace(generate_content=unavailable))
        ),
    )
    assert suggest(client).status_code == 502
    assert bm.public_record(store.get_inspection('owner', ID)) == record
    store.db.records['inspections/' + ID]['status'] = 'signed'
    assert suggest(client).status_code == 409


def test_duplicate_room_names_and_conflicting_changes_need_clarification():
    values = InspectionData(
        technician_transcript=WORDS, rooms=[{'name': 'Bathroom'}, {'name': 'bathroom'}]
    )
    with pytest.raises(ValueError):
        validate_suggestions(
            values, ScopeSuggestions(changes=[change('category', 2, room='Bathroom')], questions=[])
        )
    values.rooms = []
    with pytest.raises(ValueError):
        validate_suggestions(
            values,
            ScopeSuggestions(
                changes=[change('air_movers', 3), change('air_movers', 4)], questions=[]
            ),
        )


def test_scope_extraction_has_its_own_quota(context, monkeypatch):
    client, _ = context
    prepared(client)
    provider(monkeypatch, [])
    for _ in range(6):
        assert suggest(client).status_code == 200
    response = suggest(client)
    assert response.status_code == 429 and response.headers['Retry-After']


def test_scope_extraction_daily_cap_returns_retry_after(context, monkeypatch):
    import backend.inspection_store as module

    client, _ = context
    prepared(client)
    provider(monkeypatch, [])
    monkeypatch.setitem(module.DAILY_LIMITS, 'scope', 1)
    assert suggest(client).status_code == 200
    response = suggest(client)
    assert response.status_code == 429 and int(response.headers['Retry-After']) > 3600
