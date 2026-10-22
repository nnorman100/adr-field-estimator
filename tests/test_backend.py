import asyncio, json, time
from threading import Timer
from types import SimpleNamespace
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
import backend.main as bm
from backend.contracts import InspectionData
from tests.fakes import FakeStore, png

ID = 'ADR-INS-' + 'a' * 32
MB = bm.MB


def data(**changes):
    payload = InspectionData(
        address='Synthetic test property',
        year_built=1960,
        rooms=[{'name': 'Bathroom', 'category': 1, 'finished_sf': 10}],
        air_movers=3,
        dehumidifiers=1,
        scope_confirmed=True,
        technician_notes='Localized clean water damage. Proposed drying and drywall removal.',
        **changes,
    ).model_dump(mode='json')
    # The app sends the tag-scan list only once a tag was scanned, as the server stores it.
    if not payload['equipment_scans']:
        payload.pop('equipment_scans')
    return payload


@pytest.fixture
def context(monkeypatch):
    store = FakeStore()
    bm.app.dependency_overrides[bm.current_staff] = lambda: {
        'uid': 'owner',
        'email': 'owner@example.invalid',
    }
    bm.app.dependency_overrides[bm.get_job_store] = lambda: store

    async def generate(**kwargs):
        schema = kwargs['config'].response_schema
        # Audit requests use LOW thinking so the 55-second deadline holds; OCR keeps the default.
        thinking = kwargs['config'].thinking_config
        if schema is bm.AIResult:
            assert thinking.thinking_level == bm.AUDIT_THINKING_LEVEL
            assert thinking.thinking_budget is None
        else:
            assert thinking is None
        value = (
            {
                'summary': 'The technician confirmed a localized bathroom scope.',
                'suggestions': ['Confirm drying progress.'],
                'unpriced_work': [],
            }
            if schema is bm.AIResult
            else {
                'meter_detected': False,
                'meter_type': 'Inspection Photo',
                'value': '',
                'classification': 'No readable meter',
                'notes': 'No physical display visible.',
            }
        )
        return SimpleNamespace(text=json.dumps(value))

    monkeypatch.setattr(
        bm,
        'get_ai_client',
        lambda: SimpleNamespace(
            aio=SimpleNamespace(models=SimpleNamespace(generate_content=generate))
        ),
    )
    yield TestClient(bm.app, headers={'Authorization': 'Bearer synthetic'}), store
    bm.app.dependency_overrides.clear()


def inspect(client):
    r = client.post('/api/inspections', json={'inspection_id': ID, 'data': data()})
    assert r.status_code == 200, r.text
    return r.json()


def audit(client, record):
    r = client.post(
        '/api/audit', json={'inspection_id': ID, 'expected_revision': record['revision']}
    )
    assert r.status_code == 200, r.text
    return r.json()


def sign_payload(record):
    return dict(
        inspection_id=ID,
        expected_revision=record['revision'],
        auth_id='ADR-AUTH-test123456',
        proposal_hash=record['audit']['proposal_hash'],
        signature_png=png(),
        documents_confirmed=True,
    )


def photo(client, record, photo_id='b' * 32):
    r = client.post(
        '/api/inspections/' + ID + '/photos',
        json=dict(
            expected_revision=record['revision'],
            photo_id=photo_id,
            room='Bathroom',
            captured_at='2026-10-06T19:00:00Z',
            data_url=png(),
        ),
    )
    assert r.status_code == 200, r.text
    return r.json()


NO_METER = {
    'meter_detected': False,
    'meter_type': 'Inspection Photo',
    'value': '',
    'classification': 'No readable meter',
    'notes': 'No physical display visible.',
}


def test_audit_waits_for_pending_ocr_and_rejects_real_input_changes(context):
    client, store = context
    record = photo(client, inspect(client))
    Timer(0.2, store.set_ocr, ('owner', ID, 'b' * 32, NO_METER)).start()
    saved = audit(client, record)
    assert (
        saved['photos'][0]['ocr_status'] == 'no_meter'
        and saved['audit']['revision'] == saved['revision'] == record['revision'] + 1
    )
    record = photo(client, saved, 'c' * 32)
    changed = data()
    changed['address'] = 'Changed while waiting'
    Timer(0.2, store.update_inspection, ('owner', ID, record['revision'], changed)).start()
    response = client.post(
        '/api/audit', json={'inspection_id': ID, 'expected_revision': record['revision']}
    )
    assert response.status_code == 409 and 'changed while waiting' in response.json()['detail']


def test_authenticated_durable_flow_and_immutable_retry(context):
    client, store = context
    record = audit(client, inspect(client))
    docs = record['audit']['documents']
    assert docs['xactimate_total'] == 1775
    assert docs['adr_estimate']['proposed_cost_low'] == 1775
    assert docs['adr_estimate']['proposed_cost'] == 1788.9
    assert docs['schema_version'] == 3
    assert docs['adr_estimate']['lead_notice_required'] and docs['signable']
    payload = sign_payload(record)
    saved = client.post('/api/authorize', json=payload)
    assert saved.status_code == 200, saved.text
    assert client.post('/api/authorize', json=payload).json() == saved.json()
    loaded = client.get('/api/authorizations/' + payload['auth_id']).json()
    assert loaded['documents'] == docs and 'owner_uid' not in loaded
    assert (
        client.get('/api/authorizations/' + payload['auth_id'] + '/evidence/signature').status_code
        == 200
    )
    assert (
        client.put(
            '/api/inspections/' + ID, json={'expected_revision': record['revision'], 'data': data()}
        ).status_code
        == 409
    )
    assert len(store.bucket.objects) == 1


def test_stale_revision_changed_scope_and_forged_prices(context):
    client, _ = context
    record = audit(client, inspect(client))
    payload = sign_payload(record)
    revised = data()
    revised['address'] = 'Different address'
    assert (
        client.put(
            '/api/inspections/' + ID,
            json={'expected_revision': record['revision'], 'data': revised},
        ).status_code
        == 200
    )
    assert client.post('/api/authorize', json=payload).status_code == 409
    payload['proposed_cost'] = 1
    assert client.post('/api/authorize', json=payload).status_code == 422
    assert (
        client.post(
            '/api/authorize',
            json={'auth_id': 'ADR-AUTH-never-saved', 'signature_png': png(), 'proposed_cost': -1},
        ).status_code
        == 409
    )


def test_room_loss_type_is_saved_only_when_set_and_old_rooms_keep_their_shape(context):
    client, _ = context
    legacy = data()
    legacy.pop('capture_metadata')
    legacy.pop('dehumidifier_ppd')
    for room in legacy['rooms']:
        for key in ('loss', 'floor_sf', 'wet_floor_sf', 'ceiling_height_ft', 'water_class'):
            room.pop(key, None)
    assert 'loss' not in legacy['rooms'][0]
    record = client.post('/api/inspections', json={'inspection_id': ID, 'data': legacy}).json()
    assert record['data'] == legacy and 'loss' not in record['data']['rooms'][0]
    # An older app that never sends the field saves the same shape it loaded; nothing is re-shaped.
    labelled = json.loads(json.dumps(legacy))
    labelled['rooms'][0]['loss'] = 'both'
    saved = client.put(
        '/api/inspections/' + ID, json={'expected_revision': record['revision'], 'data': labelled}
    ).json()
    assert saved['data']['rooms'][0]['loss'] == 'both' and saved['revision'] == 2
    cleared = json.loads(json.dumps(labelled))
    cleared['rooms'][0]['loss'] = None
    saved = client.put(
        '/api/inspections/' + ID, json={'expected_revision': 2, 'data': cleared}
    ).json()
    assert 'loss' not in saved['data']['rooms'][0] and saved['revision'] == 3
    cleared['rooms'][0]['loss'] = 'fire'
    assert (
        client.put(
            '/api/inspections/' + ID, json={'expected_revision': 3, 'data': cleared}
        ).status_code
        == 422
    )


def test_old_package_selection_requires_app_update(context):
    client, _ = context
    record = client.post(
        '/api/inspections', json={'inspection_id': ID, 'data': data(package_price='2049.99')}
    ).json()
    response = client.post(
        '/api/audit', json={'inspection_id': ID, 'expected_revision': record['revision']}
    )
    assert response.status_code == 409
    assert 'Update the app' in response.json()['detail']


def test_model_output_missing_and_provider_error_never_produces_documents(context, monkeypatch):
    client, store = context
    record = inspect(client)

    async def malformed(**kwargs):
        return SimpleNamespace(text='{"proposed_cost":-999}')

    monkeypatch.setattr(
        bm,
        'get_ai_client',
        lambda: SimpleNamespace(
            aio=SimpleNamespace(models=SimpleNamespace(generate_content=malformed))
        ),
    )
    response = client.post(
        '/api/audit', json={'inspection_id': ID, 'expected_revision': record['revision']}
    )
    assert response.status_code == 502 and store.get_inspection('owner', ID)['audit'] is None


def test_audit_request_uses_low_thinking_so_the_55_second_deadline_holds(context, monkeypatch):
    # Measured 2026-10-15: default-thinking audits reached the 55-second deadline in production.
    client, _ = context
    configs = []

    async def generate(**kwargs):
        configs.append(kwargs['config'])
        return SimpleNamespace(
            text=json.dumps({'summary': 'Scope confirmed.', 'suggestions': [], 'unpriced_work': []})
        )

    monkeypatch.setattr(
        bm,
        'get_ai_client',
        lambda: SimpleNamespace(
            aio=SimpleNamespace(models=SimpleNamespace(generate_content=generate))
        ),
    )
    audit(client, inspect(client))
    assert bm.AUDIT_THINKING_LEVEL == bm.types.ThinkingLevel.LOW
    assert [c.thinking_config.thinking_level for c in configs] == [bm.types.ThinkingLevel.LOW]
    assert configs[0].thinking_config.thinking_budget is None


def test_zero_work_audit_is_rejected_before_the_model_runs(context, monkeypatch):
    client, _ = context
    calls = []

    async def generate(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(
            text=json.dumps({'summary': 'Nothing priced.', 'suggestions': [], 'unpriced_work': []})
        )

    monkeypatch.setattr(
        bm,
        'get_ai_client',
        lambda: SimpleNamespace(
            aio=SimpleNamespace(models=SimpleNamespace(generate_content=generate))
        ),
    )
    empty = data(
        emergency_calls=0, monitoring_hours=0, haul_loads=0, air_scrubbers=0, hepa_filters=0
    )
    empty.update(air_movers=0, dehumidifiers=0)
    empty['rooms'][0]['finished_sf'] = 0
    record = client.post('/api/inspections', json={'inspection_id': ID, 'data': empty}).json()
    response = client.post(
        '/api/audit', json={'inspection_id': ID, 'expected_revision': record['revision']}
    )
    assert (
        response.status_code == 400
        and 'Add measured work' in response.json()['detail']
        and calls == []
    )


def test_non_meter_and_failed_ocr_remain_unverified(context, monkeypatch):
    client, store = context
    record = photo(client, inspect(client))
    result = client.post('/api/inspections/' + ID + '/photos/' + 'b' * 32 + '/ocr', json={})
    assert result.status_code == 200 and result.json()['photos'][0]['ocr_status'] == 'no_meter'
    photo(client, result.json(), 'c' * 32)

    async def unavailable(**kwargs):
        raise RuntimeError('provider unavailable')

    monkeypatch.setattr(
        bm,
        'get_ai_client',
        lambda: SimpleNamespace(
            aio=SimpleNamespace(models=SimpleNamespace(generate_content=unavailable))
        ),
    )
    result = client.post('/api/inspections/' + ID + '/photos/' + 'c' * 32 + '/ocr', json={})
    assert (
        result.status_code == 502
        and store.get_inspection('owner', ID)['photos'][1]['ocr_status'] == 'failed'
    )
    assert (
        client.post('/api/inspections/' + ID + '/photos/' + 'b' * 32 + '/ocr', json={}).status_code
        == 502
    )
    assert store.get_inspection('owner', ID)['photos'][0]['ocr_status'] == 'no_meter'


VERIFIED = {
    'meter_detected': True,
    'meter_type': 'Pin moisture meter',
    'value': '18.5',
    'classification': 'Wet',
    'notes': 'Readable display.',
}


def test_failed_ocr_retry_keeps_verified_reading_revision_and_audit(context, monkeypatch):
    client, store = context
    photo(client, inspect(client))
    store.set_ocr('owner', ID, 'b' * 32, VERIFIED)
    audited = audit(client, client.get('/api/inspections/' + ID).json())

    async def unavailable(**kwargs):
        raise RuntimeError('provider unavailable')

    monkeypatch.setattr(
        bm,
        'get_ai_client',
        lambda: SimpleNamespace(
            aio=SimpleNamespace(models=SimpleNamespace(generate_content=unavailable))
        ),
    )
    assert (
        client.post('/api/inspections/' + ID + '/photos/' + 'b' * 32 + '/ocr', json={}).status_code
        == 502
    )
    current = store.get_inspection('owner', ID)
    assert (
        current['photos'][0]['ocr'] == VERIFIED and current['photos'][0]['ocr_status'] == 'verified'
    )
    assert current['revision'] == audited['revision'] and current['audit'] == audited['audit']


def test_cancelled_ocr_request_does_not_leave_the_photo_pending(context, monkeypatch):
    client, store = context
    photo(client, inspect(client))

    async def hang(*args, **kwargs):
        await asyncio.Event().wait()

    monkeypatch.setattr(bm, 'generate', hang)

    async def deadline():
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(
                bm.ocr_photo.__wrapped__(ID, 'b' * 32, {'uid': 'owner'}, store), 0.2
            )

    asyncio.run(deadline())
    assert store.get_inspection('owner', ID)['photos'][0]['ocr_status'] == 'failed'


def test_auth_ownership_limits_and_invalid_inputs(context):
    client, _ = context
    inspect(client)
    bm.app.dependency_overrides[bm.current_staff] = lambda: {'uid': 'other'}
    assert client.get('/api/inspections/' + ID).status_code == 404
    assert (
        client.post(
            '/api/inspections/' + ID + '/photos',
            json=dict(
                expected_revision=1,
                photo_id='b' * 32,
                room='Room',
                captured_at='2026-10-06T19:00:00Z',
                data_url=png(),
            ),
        ).status_code
        == 404
    )
    bm.app.dependency_overrides.pop(bm.current_staff)
    for path in [
        '/api/inspections',
        '/api/authorizations',
        '/api/authorizations/ADR-AUTH-test123456',
    ]:
        assert client.get(path, headers={'Authorization': ''}).status_code == 401
    assert client.get('/api/health').status_code == 200
    bm.app.dependency_overrides[bm.current_staff] = lambda: {'uid': 'owner'}
    invalid = data()
    invalid['labor_hours'] = -1
    assert (
        client.put(
            '/api/inspections/' + ID, json={'expected_revision': 1, 'data': invalid}
        ).status_code
        == 422
    )
    # The transaction-backed per-user limit applies to API calls.
    for _ in range(3):
        client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
    response = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1})
    assert response.status_code == 429 and response.headers['Retry-After']


def test_production_origins_exclude_local_development():
    # The browser harness appends its own origins at runtime.
    assert bm.ORIGINS == [
        'https://alert-disaster-field-2026.web.app',
        'https://alert-disaster-field-2026.firebaseapp.com',
    ]
    preflight = TestClient(bm.app).options(
        '/api/session',
        headers={'Origin': 'http://localhost:8765', 'Access-Control-Request-Method': 'GET'},
    )
    assert 'access-control-allow-origin' not in preflight.headers


def test_health_discloses_configuration_only_to_staff(context):
    client, _ = context
    assert client.get('/api/health').json() == {
        'status': 'healthy',
        'schema_version': 3,
        'source_commit': 'unknown',
    }
    details = client.get('/api/health/details').json()
    assert (
        details['project'] == bm.PROJECT_ID
        and details['evidence_bucket'] == bm.BUCKET
        and details['live_model'] == bm.LIVE_MODEL
    )
    assert details['source_commit'] == 'unknown'
    bm.app.dependency_overrides.pop(bm.current_staff)
    assert client.get('/api/health/details', headers={'Authorization': ''}).status_code == 401


def test_source_commit_comes_only_from_a_well_formed_deploy_stamp(tmp_path):
    stamp = tmp_path / 'SOURCE_COMMIT'
    assert bm.read_source_commit(str(stamp)) == 'unknown'
    for value in ['a' * 40, 'a' * 40 + '-dirty']:
        stamp.write_text(value + '\n')
        assert bm.read_source_commit(str(stamp)) == value
    for value in ['', 'abc123', 'A' * 40, 'a' * 40 + '-other', 'a' * 40 + '\n<script>']:
        stamp.write_text(value)
        assert bm.read_source_commit(str(stamp)) == 'unknown'


def test_year_built_bound_follows_the_clock_on_a_warm_instance(monkeypatch):
    import backend.contracts as contracts

    year = contracts.datetime.now().year
    with pytest.raises(ValueError):
        InspectionData(year_built=year + 1)

    class NewYear(contracts.datetime):
        @classmethod
        def now(cls, tz=None):
            return contracts.datetime(year + 1, 1, 1)

    monkeypatch.setattr(contracts, 'datetime', NewYear)
    assert InspectionData(year_built=year + 1).year_built == year + 1
    with pytest.raises(ValueError):
        InspectionData(year_built=1799)


def send_raw(method, path, headers, receive, app=None):
    """Drive the ASGI app directly so the test controls, and observes, every body read."""
    sent = []

    async def send(message):
        sent.append(message)

    scope = {
        'type': 'http',
        'asgi': {'version': '3.0'},
        'http_version': '1.1',
        'method': method,
        'scheme': 'http',
        'path': path,
        'raw_path': path.encode(),
        'query_string': b'',
        'root_path': '',
        'headers': [(k.lower().encode(), v.encode()) for k, v in headers.items()],
        'client': ('test', 1),
        'server': ('test', 80),
    }
    asyncio.run((app or bm.app)(scope, receive, send))
    return next(m['status'] for m in sent if m['type'] == 'http.response.start')


def test_unauthenticated_upload_is_rejected_before_the_body_is_read(context):
    reads = []

    async def receive():
        reads.append(1)
        return {'type': 'http.request', 'body': b'x' * MB, 'more_body': True}

    for headers in (
        {'content-length': str(19 * MB)},
        {'content-length': str(19 * MB), 'authorization': 'Basic abc'},
        {'authorization': 'Bearer '},
    ):
        assert send_raw('POST', '/api/inspections/' + ID + '/photos', headers, receive) == 401
    assert reads == []


def test_declared_and_streamed_bodies_are_capped_per_route(context):
    client, _ = context

    async def unread():
        raise AssertionError('The body must not be read.')

    auth = {'authorization': 'Bearer synthetic'}
    for path, limit in [
        ('/api/inspections/' + ID + '/photos', 13 * MB),
        ('/api/authorize', int(3.5 * MB)),
        ('/api/inspections', MB),
        ('/api/audit', MB),
    ]:
        assert send_raw('POST', path, {**auth, 'content-length': str(limit + 1)}, unread) == 413
    assert (
        send_raw('PUT', '/api/inspections/' + ID, {**auth, 'content-length': str(MB + 1)}, unread)
        == 413
    )
    assert send_raw('POST', '/api/inspections', {**auth, 'content-length': '1e9'}, unread) == 400
    # Under its own ceiling, a body above the default reaches validation.
    big = client.post(
        '/api/authorize', json={'auth_id': 'ADR-AUTH-never-saved', 'signature_png': 'a' * (2 * MB)}
    )
    assert big.status_code == 409
    # Chunked bodies without Content-Length keep the streaming cap.
    chunks = iter([b'{"x":"' + b'a' * MB, b'a' * MB])
    assert (
        client.post(
            '/api/inspections', content=chunks, headers={'content-type': 'application/json'}
        ).status_code
        == 413
    )


def test_slow_body_hits_the_read_deadline(context, monkeypatch):
    monkeypatch.setattr(bm, 'BODY_READ_SECONDS', 0.2)

    async def trickle():
        await asyncio.sleep(0.1)
        return {'type': 'http.request', 'body': b'x', 'more_body': True}

    assert (
        send_raw('POST', '/api/inspections', {'authorization': 'Bearer synthetic'}, trickle) == 408
    )


def test_capped_body_reaches_a_plain_asgi_app_through_receive():
    # A bare ASGI app has no Starlette request to carry a cached body; it sees only receive().
    seen = []

    async def downstream(scope, receive, send):
        seen.extend([await receive(), await receive()])
        await send({'type': 'http.response.start', 'status': 204, 'headers': []})
        await send({'type': 'http.response.body', 'body': b''})

    messages = iter(
        [
            {'type': 'http.request', 'body': b'{"a":', 'more_body': True},
            {'type': 'http.request', 'body': b'1}', 'more_body': False},
            {'type': 'http.disconnect'},
        ]
    )

    async def receive():
        return next(messages)

    assert (
        send_raw(
            'POST',
            '/api/audit',
            {'authorization': 'Bearer synthetic'},
            receive,
            bm.LimitPayload(downstream),
        )
        == 204
    )
    assert seen == [
        {'type': 'http.request', 'body': b'{"a":1}', 'more_body': False},
        {'type': 'http.disconnect'},
    ]


def test_authenticated_full_size_photo_upload_still_works(context):
    client, _ = context
    record = inspect(client)
    # Whitespace pads a valid upload to near the photo ceiling, far above the 1 MB default.
    padded = json.dumps(
        dict(
            expected_revision=record['revision'],
            photo_id='b' * 32,
            room='Bathroom',
            captured_at='2026-10-06T19:00:00Z',
            data_url=png(),
        )
    )
    padded = padded[:-1] + ' ' * (12 * MB - len(padded)) + '}'
    r = client.post(
        '/api/inspections/' + ID + '/photos',
        content=padded,
        headers={'content-type': 'application/json'},
    )
    assert r.status_code == 200, r.text
    assert r.json()['photos'][0]['id'] == 'b' * 32


def test_moving_a_photo_between_rooms_relabels_it_and_invalidates_the_audit(context):
    client, _ = context
    payload = data()
    payload['rooms'].append({**payload['rooms'][0], 'name': 'Hallway', 'finished_sf': 5})
    r = client.post('/api/inspections', json={'inspection_id': ID, 'data': payload})
    assert r.status_code == 200, r.text
    record = audit(client, photo(client, r.json()))
    path = '/api/inspections/' + ID + '/photos/' + 'b' * 32 + '/room'
    moved = client.put(path, json={'expected_revision': record['revision'], 'room': 'Hallway'})
    assert moved.status_code == 200, moved.text
    moved = moved.json()
    assert moved['photos'][0]['room'] == 'Hallway'
    assert moved['photos'][0]['file'] == record['photos'][0]['file']
    assert moved['revision'] == record['revision'] + 1 and moved['audit'] is None
    # Same room again: nothing changes, and a stale revision or unknown room is refused.
    again = client.put(path, json={'expected_revision': moved['revision'], 'room': 'Hallway'})
    assert again.status_code == 200 and again.json()['revision'] == moved['revision']
    assert client.put(path, json={'expected_revision': 1, 'room': 'Bathroom'}).status_code == 409
    unknown = client.put(path, json={'expected_revision': moved['revision'], 'room': 'Attic'})
    assert unknown.status_code == 400
    missing = '/api/inspections/' + ID + '/photos/' + 'c' * 32 + '/room'
    assert (
        client.put(missing, json={'expected_revision': moved['revision'], 'room': 'Bathroom'})
    ).status_code == 404
    # A verified reading makes the draft signable; a signed agreement then keeps its photo rooms.
    ocr = client.post('/api/inspections/' + ID + '/photos/' + 'b' * 32 + '/ocr', json={})
    assert ocr.status_code == 200, ocr.text
    signed = audit(client, ocr.json())
    r = client.post('/api/authorize', json=sign_payload(signed))
    assert r.status_code == 200, r.text
    after = client.get('/api/inspections/' + ID).json()
    locked = client.put(path, json={'expected_revision': after['revision'], 'room': 'Bathroom'})
    assert locked.status_code == 409
    assert client.get('/api/inspections/' + ID).json()['photos'][0]['room'] == 'Hallway'


def as_user(uid):
    bm.app.dependency_overrides[bm.current_staff] = lambda: {
        'uid': uid,
        'email': uid + '@example.invalid',
    }


def test_other_user_cannot_reach_any_owned_unsigned_inspection(context):
    client, _ = context
    record = photo(client, inspect(client))
    as_user('other')
    responses = [
        client.put(
            '/api/inspections/' + ID,
            json={
                'expected_revision': record['revision'],
                'data': {**data(), 'technician_notes': 'Overwritten by another user.'},
            },
        ),
        client.get('/api/inspections/' + ID + '/photos/' + 'b' * 32),
        client.post('/api/inspections/' + ID + '/photos/' + 'b' * 32 + '/ocr'),
        client.post(
            '/api/inspections/' + ID + '/scope-suggestions',
            json={'inspection_id': ID, 'expected_revision': record['revision']},
        ),
        client.post(
            '/api/audit', json={'inspection_id': ID, 'expected_revision': record['revision']}
        ),
    ]
    assert [r.status_code for r in responses] == [404] * len(responses), [r.text for r in responses]
    assert ID not in json.dumps(client.get('/api/inspections').json())
    as_user('owner')
    assert (
        client.get('/api/inspections/' + ID).json()['data']['technician_notes']
        == data()['technician_notes']
    )


def test_other_user_cannot_sign_read_or_download_a_signed_record(context):
    client, _ = context
    record = audit(client, inspect(client))
    payload = sign_payload(record)
    as_user('other')
    # A refused attempt must not reserve the authorization reference for the owner.
    assert client.post('/api/authorize', json=payload).status_code == 404
    as_user('owner')
    assert client.post('/api/authorize', json=payload).status_code == 200
    as_user('other')
    assert client.get('/api/authorizations/' + payload['auth_id']).status_code == 404
    assert (
        client.get('/api/authorizations/' + payload['auth_id'] + '/evidence/signature').status_code
        == 404
    )
    assert payload['auth_id'] not in json.dumps(client.get('/api/authorizations').json())


def test_live_rejects_origins_and_unauthorized_before_vertex(context, monkeypatch):
    client, _ = context
    for origin in ['https://attacker.invalid', 'http://localhost:8765', 'http://127.0.0.1:8765']:
        with pytest.raises(Exception):
            with client.websocket_connect('/api/live', headers={'origin': origin}):
                pass

    async def reject(token, **_):
        raise HTTPException(401, 'Sign in again.')

    monkeypatch.setattr(bm, 'verify_staff', reject)
    with client.websocket_connect('/api/live', headers={'origin': bm.ORIGINS[0]}) as socket:
        socket.send_json({'type': 'authenticate', 'token': 'invalid', 'inspection_id': ID})
        assert socket.receive_json()['type'] == 'error'


def test_staff_verification_checks_revoked_and_disabled_sessions(monkeypatch):
    monkeypatch.setattr(bm.firebase_admin, 'get_app', lambda name: object())
    calls = []

    def verify(token, **kwargs):
        calls.append(kwargs)
        if token == 'revoked':
            raise ValueError('Revoked or disabled')
        return {'uid': 'owner', 'email': next(iter(bm.STAFF_EMAILS)), 'email_verified': True}

    monkeypatch.setattr(bm.firebase_auth, 'verify_id_token', verify)
    assert asyncio.run(bm.verify_staff('approved'))['uid'] == 'owner'
    with pytest.raises(HTTPException) as error:
        asyncio.run(bm.verify_staff('revoked'))
    assert error.value.status_code == 401 and all(c['check_revoked'] is True for c in calls)


def test_real_sdk_serializes_response_schemas_for_vertex(monkeypatch):
    # The real google-genai client builds each request; only the HTTP transport is synthetic.
    import httpx
    from google.oauth2.credentials import Credentials
    from backend.scope import ScopeSuggestions, scope_response_schema

    requests = []
    replies = {
        'changes': {'changes': [], 'questions': ['Which wall?']},
        'meter_detected': {
            'meter_detected': False,
            'meter_type': 'Inspection Photo',
            'value': '',
            'classification': 'No readable meter',
            'notes': 'None.',
        },
        'summary': {'summary': 'Synthetic summary.', 'suggestions': [], 'unpriced_work': []},
    }

    def respond(request):
        body = json.loads(request.content)
        requests.append((request.url.path, request.headers.get('authorization'), body))
        value = next(
            v
            for k, v in replies.items()
            if k in body['generationConfig']['responseSchema']['properties']
        )
        return httpx.Response(
            200,
            json={
                'candidates': [
                    {
                        'content': {'role': 'model', 'parts': [{'text': json.dumps(value)}]},
                        'finishReason': 'STOP',
                    }
                ]
            },
        )

    relay = bm.genai.Client

    def client(**kw):
        options = kw.pop('http_options').model_copy(
            update=dict(
                httpx_async_client=httpx.AsyncClient(transport=httpx.MockTransport(respond))
            )
        )
        return relay(credentials=Credentials(token='synthetic-token'), http_options=options, **kw)

    monkeypatch.setattr(bm, 'genai_client', None)
    monkeypatch.setattr(bm.genai, 'Client', client)

    async def run():
        return [
            await bm.generate(
                bm.AIResult,
                ['Synthetic audit'],
                bm.AUDIT_MODEL,
                'audit',
                ID,
                thinking_level=bm.AUDIT_THINKING_LEVEL,
            ),
            await bm.generate(bm.OcrResult, ['Synthetic photo'], bm.OCR_MODEL, 'ocr', ID),
            await bm.generate(
                ScopeSuggestions,
                ['Synthetic scope'],
                bm.AUDIT_MODEL,
                'scope',
                ID,
                wire_schema=scope_response_schema(),
                thinking_level=bm.SCOPE_THINKING_LEVEL,
            ),
        ]

    audited, read, scoped = asyncio.run(run())
    assert (
        audited.summary == 'Synthetic summary.'
        and read.classification == 'No readable meter'
        and scoped.questions == ['Which wall?']
    )
    # These requests match what google-genai 2.8.0 sent, byte for byte.
    for path, authorization, body in requests:
        assert path.endswith(
            f'/projects/{bm.PROJECT_ID}/locations/{bm.LOCATION}/publishers/google/models/{bm.AUDIT_MODEL}:generateContent'
        )
        assert (
            authorization == 'Bearer synthetic-token'
            and body['generationConfig']['responseMimeType'] == 'application/json'
        )
    generation = [body['generationConfig'] for _, _, body in requests]
    assert 'thinkingConfig' not in generation[1]
    # google-genai 2.8.0 and 2.29.0 both send the snake_case field; Vertex's proto-JSON parser
    # accepts it (LOW calls reported no thought tokens on 2026-10-13).
    assert (
        generation[0]['thinkingConfig']
        == generation[2]['thinkingConfig']
        == {'thinking_level': 'LOW'}
    )
    schemas = [body['generationConfig']['responseSchema'] for _, _, body in requests]
    assert schemas[0]['required'] == ['summary', 'suggestions', 'unpriced_work']
    assert schemas[0]['property_ordering'] == [
        'summary',
        'suggestions',
        'unpriced_work',
        'testing_advice',
    ]
    assert schemas[0]['properties']['suggestions'] == {
        'type': 'ARRAY',
        'items': {'type': 'STRING', 'max_length': 1000},
        'max_items': 30,
        'title': 'Suggestions',
    }
    assert (
        schemas[1]['required']
        == schemas[1]['property_ordering']
        == ['meter_detected', 'meter_type', 'value', 'classification', 'notes']
    )
    change = schemas[2]['properties']['changes']['items']['properties']
    assert (
        change['field']['enum']
        == scope_response_schema()['properties']['changes']['items']['properties']['field']['enum']
    )
    assert change['room'] == {'type': 'STRING', 'nullable': True}
    assert change['value'] == {
        'any_of': [{'type': 'BOOLEAN'}, {'type': 'NUMBER'}, {'type': 'STRING'}]
    }


@pytest.fixture
def revocation(monkeypatch):
    """Firebase verification against a controllable clock; records whether each call looked up revocation."""
    clock = SimpleNamespace(now=1_000_000.0, revoked=set(), calls=[])

    def verify(token, **kwargs):
        clock.calls.append(kwargs['check_revoked'])
        claims = {
            'uid': token.split('.')[0],
            'email': next(iter(bm.STAFF_EMAILS)),
            'email_verified': True,
            'exp': clock.now + 3000,
        }
        if token.endswith('.short'):
            claims['exp'] = 1_000_010
        if kwargs['check_revoked'] and claims['uid'] in clock.revoked:
            raise ValueError('Revoked or disabled')
        return claims

    monkeypatch.setattr(bm.firebase_admin, 'get_app', lambda name: object())
    monkeypatch.setattr(bm.firebase_auth, 'verify_id_token', verify)
    monkeypatch.setattr(
        bm, 'time', SimpleNamespace(time=lambda: clock.now, monotonic=time.monotonic)
    )
    monkeypatch.setattr(bm, 'revocation_checked', bm.OrderedDict())
    monkeypatch.setattr(bm, 'REVOCATION_CACHE_SECONDS', 45)
    return clock


def test_revocation_lookup_is_reused_within_the_ttl_while_signatures_are_always_verified(
    revocation,
):
    staff = lambda token, **kwargs: asyncio.run(bm.verify_staff(token, **kwargs))
    staff('owner.a')
    revocation.now += 44
    staff('owner.a')
    assert revocation.calls == [True, False]
    revocation.now += 1.5
    staff('owner.a')
    assert revocation.calls == [True, False, True]
    # Live callers, including each Live heartbeat, never reuse one.
    revocation.now += 30
    staff('owner.a')
    staff('owner.a', live=True)
    assert revocation.calls[3:] == [False, True]


def test_reused_revocation_check_never_outlasts_the_token_expiry(revocation):
    asyncio.run(bm.verify_staff('owner.short'))
    assert list(bm.revocation_checked.values()) == [1_000_010]
    revocation.now += 10
    asyncio.run(bm.verify_staff('owner.short'))
    assert revocation.calls == [True, True]


def test_revoked_user_is_refused_once_the_ttl_lapses(revocation):
    asyncio.run(bm.verify_staff('owner.a'))
    revocation.revoked.add('owner')
    revocation.now += 44
    # The documented bound: a revocation can take up to REVOCATION_CACHE_SECONDS to reach cached routes.
    assert asyncio.run(bm.verify_staff('owner.a'))['uid'] == 'owner'
    revocation.now += 2
    for _ in range(2):
        with pytest.raises(HTTPException) as error:
            asyncio.run(bm.verify_staff('owner.a'))
        assert error.value.status_code == 401
    assert revocation.calls == [True, False, True, True] and not bm.revocation_checked


def test_revocation_cache_keys_are_token_digests_and_bounded(revocation, monkeypatch):
    monkeypatch.setattr(bm, 'REVOCATION_CACHE_LIMIT', 2)
    tokens = ['owner.secret-one', 'owner.secret-two', 'owner.secret-three']
    for token in tokens:
        asyncio.run(bm.verify_staff(token))
    stored = repr(bm.revocation_checked)
    assert all(
        token not in stored and token.encode() not in bm.revocation_checked for token in tokens
    )
    assert list(bm.revocation_checked) == [
        bm.hashlib.sha256(t.encode()).digest() for t in tokens[1:]
    ]
    asyncio.run(bm.verify_staff(tokens[0]))
    assert revocation.calls == [True, True, True, True]


def test_signing_evidence_and_administration_routes_always_check_revocation_live(revocation):
    store = FakeStore()
    bm.app.dependency_overrides[bm.get_job_store] = lambda: store
    try:
        client = TestClient(bm.app, headers={'Authorization': 'Bearer owner.a'})
        for _ in range(2):
            assert client.get('/api/inspections/' + ID).status_code == 404
        assert revocation.calls == [True, False]
        for _ in range(2):
            assert client.post('/api/authorize', json={'auth_id': 'missing'}).status_code == 409
            assert client.get('/api/authorizations/missing/evidence/signature').status_code == 404
        assert revocation.calls == [True, False, True, True, True, True]
    finally:
        bm.app.dependency_overrides.clear()
    live = {
        (method, route.path)
        for route in bm.app.routes
        if getattr(route, 'dependant', None)
        for dependency in route.dependant.dependencies
        if bm.LIVE_REVOCATION[0] in (dependency.own_oauth_scopes or [])
        for method in route.methods
    }
    assert live == {
        ('POST', '/api/authorize'),
        ('POST', '/api/inspections/{inspection_id}/signing-links'),
        ('POST', '/api/inspections/{inspection_id}/signing-links/revoke'),
        ('GET', '/api/authorizations/{auth_id}/evidence/{name}'),
        ('GET', '/api/admin/companies'),
        ('POST', '/api/admin/companies'),
        ('PUT', '/api/admin/companies/{company_id}/status'),
        ('POST', '/api/admin/companies/{company_id}/owner-login'),
        ('POST', '/api/account/password'),
        ('GET', '/api/admin/companies/{company_id}/jobs'),
        ('GET', '/api/admin/companies/{company_id}/jobs/{inspection_id}'),
        ('GET', '/api/admin/companies/{company_id}/jobs/{inspection_id}/photos/{photo_id}'),
        ('GET', '/api/admin/companies/{company_id}/authorizations'),
        ('GET', '/api/admin/companies/{company_id}/authorizations/{auth_id}'),
        ('GET', '/api/admin/companies/{company_id}/authorizations/{auth_id}/evidence/{name}'),
        ('GET', '/api/companies/{company_id}'),
        ('PUT', '/api/companies/{company_id}'),
        ('GET', '/api/companies/{company_id}/team'),
        ('PUT', '/api/companies/{company_id}/team/{member_uid}'),
        ('GET', '/api/companies/{company_id}/invitations'),
        ('POST', '/api/companies/{company_id}/invitations'),
        ('POST', '/api/companies/{company_id}/invitations/{invitation_id}/{action}'),
        ('POST', '/api/invitations/{invitation_id}/accept'),
        ('PUT', '/api/jobs/{inspection_id}/coordination'),
    }


def reading(**changes):
    return {
        'reading': {
            'kind': 'air',
            'room': 'Bathroom',
            'zone': 'affected',
            'temperature_f': 74,
            'relative_humidity': 72,
            'taken_at': '2026-10-21T15:00:00Z',
            **changes,
        }
    }


def test_drying_readings_sit_beside_the_revision_and_outlive_signing(context):
    client, store = context
    record = audit(client, inspect(client))
    assert client.get('/api/inspections/' + ID + '/readings').json() == {
        'inspection_id': ID,
        'readings': [],
        'updated_at': None,
    }
    saved = client.post('/api/inspections/' + ID + '/readings', json=reading())
    assert saved.status_code == 200, saved.text
    [air] = saved.json()['readings']
    assert air['recorded_by'] == 'owner@example.invalid' and len(air['id']) == 32
    assert (air['gpp'], air['dew_point_f'], air['vapor_pressure_inhg']) == (91, 64, 0.609)
    assert air['taken_at'] == '2026-10-21T15:00:00Z' and air['recorded_at'] > '2026'
    # The reading changed nothing the proposal hash or signature binds to.
    current = client.get('/api/inspections/' + ID).json()
    assert current['revision'] == record['revision'] and current['audit'] == record['audit']
    assert client.post('/api/authorize', json=sign_payload(record)).status_code == 200
    # Monitoring visits continue after signing; material and thermal readings carry no computed values.
    material = reading(
        kind='material', material='Drywall', moisture=28, unit='%MC', dry_standard=12, zone=None
    )
    del material['reading']['zone'], material['reading']['temperature_f']
    del material['reading']['relative_humidity']
    thermal = reading(kind='thermal', delta_t_f=-6.4, boundary='Up 3 ft of exterior wall')
    for key in ('zone', 'temperature_f', 'relative_humidity'):
        del thermal['reading'][key]
    for body in (material, thermal):
        response = client.post('/api/inspections/' + ID + '/readings', json=body)
        assert response.status_code == 200, response.text
    log = client.get('/api/inspections/' + ID + '/readings').json()
    assert [r['kind'] for r in log['readings']] == ['air', 'material', 'thermal']
    assert 'gpp' not in log['readings'][1] and log['readings'][2]['pattern'] == 'cold_anomaly'
    assert client.get('/api/inspections/' + ID).json()['status'] == 'signed'
    removed = client.delete('/api/inspections/' + ID + '/readings/' + air['id'])
    assert removed.status_code == 200 and len(removed.json()['readings']) == 2
    assert client.delete('/api/inspections/' + ID + '/readings/' + air['id']).status_code == 404
    assert store.db.records['inspections/' + ID]['status'] == 'signed'


def test_drying_readings_reject_bad_values_and_other_users(context):
    client, _ = context
    inspect(client)
    bad = [
        reading(relative_humidity=0),
        reading(temperature_f=200),
        reading(kind='bogus'),
        reading(extra='field'),
        {'reading': {'kind': 'material', 'room': 'Bathroom', 'taken_at': '2026-10-21T15:00:00Z'}},
        {'reading': {'kind': 'thermal', 'delta_t_f': 500, 'taken_at': '2026-10-21T15:00:00Z'}},
        reading(taken_at='yesterday'),
    ]
    for body in bad:
        assert client.post('/api/inspections/' + ID + '/readings', json=body).status_code == 422
    assert client.delete('/api/inspections/' + ID + '/readings/not-hex').status_code == 422
    as_user('other')
    assert client.get('/api/inspections/' + ID + '/readings').status_code == 404
    assert client.post('/api/inspections/' + ID + '/readings', json=reading()).status_code == 404
    assert client.delete('/api/inspections/' + ID + '/readings/' + 'f' * 32).status_code == 404
    as_user('owner')
    assert client.get('/api/inspections/' + ID + '/readings').json()['readings'] == []
    missing = 'ADR-INS-' + 'e' * 32
    assert client.get('/api/inspections/' + missing + '/readings').status_code == 404
    assert client.get('/api/inspections/not-an-id/readings').status_code == 404


def test_draft_records_carry_the_sizing_check_and_its_inputs_stay_absent_until_set(context):
    client, _ = context
    values = data()
    values.pop('capture_metadata')
    values.pop('dehumidifier_ppd')
    for key in ('loss', 'floor_sf', 'wet_floor_sf', 'ceiling_height_ft', 'water_class'):
        values['rooms'][0].pop(key)
    record = client.post('/api/inspections', json={'inspection_id': ID, 'data': values}).json()
    assert record['data'] == values
    sizing = record['equipment_sizing']
    assert sizing['status'] == 'not_available'
    assert sizing['rooms'][0]['missing'] == ['floor area', 'ceiling height', 'water class']
    values['rooms'][0].update(floor_sf=140, ceiling_height_ft=8.5, water_class=3)
    values['dehumidifier_ppd'] = 70
    record = client.put(
        '/api/inspections/' + ID, json={'expected_revision': 1, 'data': values}
    ).json()
    # The client's values come back unchanged (140.0 parses as 140 in the browser), so a reloaded
    # draft is not a revision conflict.
    assert record['data'] == values
    sizing = client.get('/api/inspections/' + ID).json()['equipment_sizing']
    assert sizing['status'] == 'available'
    assert sizing['air_movers'] == {
        'entered': 3,
        'min': 3,
        'max': 4,
        'flag': 'within',
        'reason': 'Within the IICRC range of 3 to 4.',
    }
    assert sizing['dehumidifiers']['recommended_ppd'] == 30
    assert sizing['dehumidifiers']['flag'] == 'within'
    # The check is derived on each read and never stored with the draft.
    assert 'equipment_sizing' not in context[1].get_inspection('owner', ID)
    values['rooms'][0]['water_class'] = None
    values['dehumidifier_ppd'] = None
    record = client.put(
        '/api/inspections/' + ID, json={'expected_revision': 2, 'data': values}
    ).json()
    assert 'water_class' not in record['data']['rooms'][0]
    assert 'dehumidifier_ppd' not in record['data']
