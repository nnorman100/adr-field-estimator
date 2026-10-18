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
        assert kwargs['config'].thinking_config.thinking_level == bm.SCOPE_THINKING_LEVEL
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


def captured_configs(monkeypatch, reply):
    configs = []

    async def respond(**kwargs):
        configs.append(kwargs['config'])
        return SimpleNamespace(text=json.dumps(reply))

    monkeypatch.setattr(
        bm,
        'get_ai_client',
        lambda: SimpleNamespace(
            aio=SimpleNamespace(models=SimpleNamespace(generate_content=respond))
        ),
    )
    return configs


def suggest(client, revision=1):
    return client.post(
        '/api/inspections/' + ID + '/scope-suggestions',
        json=dict(inspection_id=ID, expected_revision=revision),
    )


def test_scope_request_uses_low_thinking_so_the_55_second_deadline_holds(context, monkeypatch):
    # Measured 2026-10-13: a 4096-token budget still let staged scope calls reach the deadline.
    client, store = context
    prepared(client)
    configs = captured_configs(monkeypatch, dict(changes=[], questions=[]))
    assert suggest(client).status_code == 200
    assert bm.SCOPE_THINKING_LEVEL == bm.types.ThinkingLevel.LOW
    assert [c.thinking_config.thinking_level for c in configs] == [bm.types.ThinkingLevel.LOW]
    assert configs[0].thinking_config.thinking_budget is None


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


@pytest.mark.parametrize(
    'transcript,proposed',
    [
        (
            'Office, mold. Drywall, 20 square feet of finished demolition.',
            [
                change('category', 3, quote='Office, mold.', room='Office'),
                change(
                    'finished_sf',
                    20,
                    quote='Drywall, 20 square feet of finished demolition.',
                    room='Office',
                ),
            ],
        ),
        (
            'Office is both water and mold, 20 square feet of finished drywall demolition.',
            [
                change(
                    'category',
                    3,
                    quote='Office is both water and mold',
                    room='Office',
                ),
                change(
                    'finished_sf',
                    20,
                    quote='20 square feet of finished drywall demolition.',
                    room='Office',
                ),
            ],
        ),
        (
            'Office: water, mold, or both? Both. 20 square feet of finished drywall demolition.',
            [
                change('category', 3, quote='Office: water, mold, or both? Both.', room='Office'),
                change(
                    'finished_sf',
                    20,
                    quote='20 square feet of finished drywall demolition.',
                    room='Office',
                ),
            ],
        ),
    ],
)
def test_scope_maps_mold_alone_or_with_water_to_category_3(
    context, monkeypatch, transcript, proposed
):
    from backend.scope import scope_prompt

    prompt = scope_prompt(InspectionData(technician_transcript=transcript))
    assert (
        'When the technician explicitly states a room has mold, or both water and mold, for a room with demolition, map that room category to 3 ("Contaminated / mold")'
        in prompt
    )
    assert 'never diagnose mold' in prompt
    client, _ = context
    prepared(client, rooms=[], technician_transcript=transcript)
    provider(monkeypatch, proposed)
    response = suggest(client)
    assert response.status_code == 200, response.text
    assert {(c['room'], c['field']): c['value'] for c in response.json()['changes']} == {
        ('Office', 'category'): 3,
        ('Office', 'finished_sf'): 20,
    }


@pytest.mark.parametrize(
    'transcript,proposed',
    [
        (
            'Office, water category 1. There is also mold in the Office. 20 square feet of finished drywall demolition.',
            [
                change('category', 1, quote='Office, water category 1.', room='Office'),
                change(
                    'category',
                    3,
                    quote='There is also mold in the Office.',
                    room='Office',
                ),
                change(
                    'finished_sf',
                    20,
                    quote='20 square feet of finished drywall demolition.',
                    room='Office',
                ),
            ],
        ),
        (
            'Office has mold. Correction: Office has no mold, water category 1. 20 square feet of finished drywall demolition.',
            [
                change('category', 3, quote='Office has mold.', room='Office'),
                change(
                    'category',
                    1,
                    quote='Office has no mold, water category 1.',
                    room='Office',
                ),
            ],
        ),
        (
            'Office, mold. 20 square feet of finished drywall demolition.',
            [change('category', 'mold', quote='Office, mold.', room='Office')],
        ),
    ],
)
def test_conflicting_or_unmapped_mold_category_requires_clarification(transcript, proposed):
    values = InspectionData(
        technician_transcript=transcript, rooms=[{'name': 'Office', 'category': 1}]
    )
    with pytest.raises(ValueError):
        validate_suggestions(values, ScopeSuggestions(changes=proposed, questions=[]))


@pytest.mark.parametrize(
    'quote,category',
    [
        ('Bathroom, category 1 water; no evidence of mold.', 1),
        ('Bathroom, category 1 water; mold is not present.', 1),
        ('Bathroom, category: 3 water; no mold.', 3),
    ],
)
def test_explicit_numeric_category_is_kept_as_stated(quote, category):
    values = InspectionData(
        technician_transcript=quote, rooms=[{'name': 'Bathroom', 'category': 2}]
    )
    result = validate_suggestions(
        values,
        ScopeSuggestions(
            changes=[change('category', category, quote=quote, room='Bathroom')], questions=[]
        ),
    )
    assert [(c.room, c.field, c.value) for c in result.changes] == [
        ('Bathroom', 'category', category)
    ]


@pytest.mark.parametrize(
    'answer,loss,category',
    [('Water.', 'water', 3), ('Mold.', 'mold', 3), ('Both.', 'both', 3), ('Water.', 'water', 1)],
)
def test_scope_records_the_loss_type_answer_as_a_label_beside_the_category(
    context, monkeypatch, answer, loss, category
):
    from backend.scope import scope_prompt, scope_response_schema

    quote = 'Office: water, mold, or both? ' + answer
    transcript = quote + f' Category {category}. 20 square feet of finished drywall demolition.'
    prompt = scope_prompt(InspectionData(technician_transcript=transcript))
    assert 'set that room\'s loss to exactly "water", "mold" or "both"' in prompt
    assert 'loss' in scope_response_schema()['properties']['changes']['items']['properties'][
        'field'
    ]['enum']
    client, _ = context
    prepared(client, rooms=[], technician_transcript=transcript)
    provider(
        monkeypatch,
        [
            change('loss', loss, quote=quote, room='Office'),
            change('category', category, quote=f'Category {category}.', room='Office'),
            change(
                'finished_sf',
                20,
                quote='20 square feet of finished drywall demolition.',
                room='Office',
            ),
        ],
    )
    response = suggest(client)
    assert response.status_code == 200, response.text
    assert {(c['room'], c['field']): c['value'] for c in response.json()['changes']} == {
        ('Office', 'loss'): loss,
        ('Office', 'category'): category,
        ('Office', 'finished_sf'): 20,
    }


@pytest.mark.parametrize('proposed', ['black water', 3, True, 'Mold'])
def test_loss_type_must_be_water_mold_or_both(proposed):
    quote = 'Office: water, mold, or both? Mold.'
    values = InspectionData(technician_transcript=quote, rooms=[{'name': 'Office', 'category': 3}])
    with pytest.raises(ValueError, match='water, mold or both'):
        validate_suggestions(
            values,
            ScopeSuggestions(changes=[change('loss', proposed, quote=quote, room='Office')], questions=[]),
        )
    # A loss type alone does not make a new room; the category and area rule is unchanged.
    with pytest.raises(ValueError, match='water category'):
        validate_suggestions(
            InspectionData(technician_transcript=quote, rooms=[]),
            ScopeSuggestions(changes=[change('loss', 'mold', quote=quote, room='Office')], questions=[]),
        )


def test_kitchen_replaces_placeholder_in_validation_and_saved_photo_labels(context, monkeypatch):
    from backend.contracts import Room
    from tests.fakes import png
    from copy import deepcopy

    client, store = context
    words = 'Kitchen, category 2, 80 SF drywall'
    initial = prepared(
        client,
        rooms=[Room(name='Room 1').model_dump(mode='json')],
        technician_transcript=words,
        scope_confirmed=False,
    )
    upload = dict(
        photo_id='b' * 32,
        expected_revision=initial['revision'],
        room='Room 1',
        captured_at='2026-10-17T19:00:00Z',
        data_url=png(),
    )
    photo_record = store.add_photo('owner', ID, upload)
    provider(
        monkeypatch,
        [
            change('category', 2, quote=words, room='Kitchen'),
            change('finished_sf', 80, quote=words, room='Kitchen'),
        ],
    )
    result = suggest(client, photo_record['revision'])
    assert result.status_code == 200, result.text
    assert [(c['room'], c['field'], c['value']) for c in result.json()['changes']] == [
        ('Kitchen', 'category', 2),
        ('Kitchen', 'finished_sf', 80),
    ]
    # Suggestions remain read-only; the client explicitly saves the autofilled draft.
    assert store.get_inspection('owner', ID)['data'] == initial['data']
    filled = deepcopy(initial['data'])
    filled['rooms'][0].update(name='Kitchen', category=2, finished_sf=80)
    saved = store.update_inspection('owner', ID, photo_record['revision'], filled)
    assert saved['data']['rooms'] == filled['rooms']
    assert saved['photos'][0]['room'] == 'Kitchen'
    assert saved['photos'][0]['file'] == photo_record['photos'][0]['file']
    assert saved['data']['scope_confirmed'] is False
    # Undo restores the placeholder and its photo labels through the same revisioned save.
    renamed = deepcopy(filled)
    renamed['rooms'][0]['name'] = 'Room 1'
    undone = store.update_inspection('owner', ID, saved['revision'], renamed)
    assert undone['data']['rooms'][0]['finished_sf'] == 80
    assert undone['photos'][0]['room'] == 'Room 1'
    assert undone['photos'][0]['file'] == photo_record['photos'][0]['file']


def test_default_photo_rename_follows_name_undo_combined_with_room_removal():
    from backend.scope import default_photo_rename

    kitchen = {'name': 'Kitchen', 'unfinished_sf': 0, 'finished_sf': 80, 'custom_cabinetry': False}
    hall = {'name': 'Hall', 'unfinished_sf': 20, 'finished_sf': 0, 'custom_cabinetry': False}
    undone = {**kitchen, 'name': 'Room 1'}
    assert default_photo_rename({'rooms': [kitchen, hall]}, {'rooms': [undone]}) == (
        'Kitchen',
        'Room 1',
    )
    assert default_photo_rename({'rooms': [kitchen, undone]}, {'rooms': [undone]}) is None


def test_default_replacement_still_requires_category_and_area_and_validates_room_limit():
    from backend.contracts import Room

    words = 'Kitchen, category 2, 80 SF drywall'
    values = InspectionData(rooms=[Room(name='Room 1')], technician_transcript=words)
    with pytest.raises(ValueError, match='water category'):
        validate_suggestions(
            values,
            ScopeSuggestions(
                changes=[change('finished_sf', 80, quote=words, room='Kitchen')], questions=[]
            ),
        )
    changes = []
    for i in range(30):
        name = f'Kitchen {i}'
        values.technician_transcript += f' {name} category 2, 80 SF drywall.'
        changes.extend(
            [
                change('category', 2, quote=name, room=name),
                change('finished_sf', 80, quote=name, room=name),
            ]
        )
    assert (
        len(validate_suggestions(values, ScopeSuggestions(changes=changes, questions=[])).changes)
        == 60
    )
