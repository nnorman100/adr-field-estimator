"""docs/ai-inventory.md pins what each AI call path of the legacy Python backend sends; this drives every path and compares.

Every REST path runs through its real route and the real generate() with a recording stand-in for the
Gen AI client, and the Live relay runs through its real WebSocket route with a recording Live session.
The pinned rows are what those calls emitted: the model, client, config, parts, quota charges and the
prompt text with each server-added JSON data line replaced by <json>. No model is called.
"""

import argparse
import asyncio
import base64
import hashlib
import importlib.util
import inspect
import io
import json
import math
import time
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace as NS

import pytest
from fastapi.testclient import TestClient
from PIL import Image

import backend.main as bm
from backend import ai_features, ai_spending, inspection_store, workspace_api
from backend.contracts import AIResult, InspectionData
from scripts import deploy_backend
from tests.fakes import FakeCompanyStore, FakeStore, genai_models
from tests.test_voice_notes import note
from tests.test_workspaces import data as company_data, identity, seed, signed_job

ROOT = Path(__file__).resolve().parents[1]
INVENTORY = ROOT / 'docs' / 'ai-inventory.md'
ID = 'ADR-INS-' + 'a' * 32
LATER = 'ADR-INS-' + 'e' * 32
PHOTO = 'b' * 32
CAPTURE = 'd' * 32
# Quota actions charged before a paid model call; the others guard drafts, links and signing.
AI_QUOTAS = (
    'ocr',
    'scope',
    'transcribe',
    'audit_attempt',
    'audit',
    'job_summary',
    'drying_summary',
    'live',
)
REAL_GENERATE = bm.generate
UPDATE = (
    'If the change is intended, replace the two tables under "Pinned requests" in '
    'docs/ai-inventory.md with the rows printed above, and say in the pull request why the AI '
    'behaviour should change.'
)


def normalized(text):
    """The prompt text a path owns: each line the server fills with JSON data becomes <json>."""
    lines = []
    for line in text.split('\n'):
        try:
            value = json.loads(line)
        except ValueError:
            value = None
        lines.append('<json>' if isinstance(value, (dict, list)) else line)
    return '\n'.join(lines)


def digest(text):
    return hashlib.sha256(text.encode('utf8')).hexdigest()


def pieces(items):
    """(kinds, text) of the emitted parts, in order; text parts are joined with a newline."""
    kinds, texts = [], []
    for item in [items] if isinstance(items, str) else items:
        if isinstance(item, str):
            kinds.append('text')
            texts.append(item)
        elif item.text is not None:
            kinds.append('text')
            texts.append(item.text)
        else:
            kinds.append(item.inline_data.mime_type)
    return kinds, '\n'.join(texts)


def schema_digest(schema):
    """sha256 of the response schema the request carried, as sorted JSON Schema content."""
    content = schema.model_json_schema() if isinstance(schema, type) else schema
    return digest(json.dumps(content, sort_keys=True))


def image_size(items):
    for item in [] if isinstance(items, str) else items:
        if not isinstance(item, str) and item.inline_data is not None:
            if item.inline_data.mime_type.startswith('image/'):
                with Image.open(io.BytesIO(item.inline_data.data)) as image:
                    return f'; image={image.format} {image.width}x{image.height}'
    return ''


def jpeg_data_url(width, height):
    output = io.BytesIO()
    Image.new('RGB', (width, height), (90, 120, 150)).save(output, format='JPEG')
    return 'data:image/jpeg;base64,' + base64.b64encode(output.getvalue()).decode()


class Recorder:
    """Stands in for google.genai.Client and for the Live session, keeping everything sent to it."""

    def __init__(self):
        self.clients = []
        self.requests = []
        self.connects = []
        self.session = []
        self.timeouts = []
        self.counted = 0

    def client(self, **kwargs):
        self.clients.append(kwargs)
        recorder = self

        async def generate_content(**request):
            recorder.requests.append(request)
            if request['config'].response_schema is AIResult:
                return NS(
                    text=json.dumps(
                        dict(summary='Confirmed scope.', suggestions=[], unpriced_work=[])
                    )
                )
            raise RuntimeError('recorded, no model behind this stand-in')

        class Session:
            async def send_client_content(self, **content):
                recorder.session.append(content)

            async def send_realtime_input(self, **_):
                pass

            async def receive(self):
                await asyncio.Event().wait()
                yield

        @asynccontextmanager
        async def connect(**request):
            recorder.connects.append(request)
            yield Session()

        async def aclose():
            pass

        return NS(
            aio=NS(
                models=genai_models(generate_content),
                live=NS(connect=connect),
                aclose=aclose,
            )
        )

    def one_call(self, response):
        """The single model request a route made, with the timeout generate() applied to it."""
        assert response.status_code in (200, 502), response.text
        assert len(self.requests) == self.counted + 1
        self.counted += 1
        return self.requests[-1], self.timeouts[-1]

    async def generate(self, *args, **kwargs):
        bound = inspect.signature(REAL_GENERATE).bind(*args, **kwargs)
        bound.apply_defaults()
        # OCR, scope and transcription pass what is left of a fixed budget; pin the budget itself.
        self.timeouts.append(math.ceil(bound.arguments['timeout']))
        return await REAL_GENERATE(*args, **kwargs)


def record_quota(store, charges):
    quota = store.quota

    def charged(uid, action, maximum=None, ttl=None):
        if action in AI_QUOTAS:
            charges.setdefault(action, maximum)
        return quota(uid, action, maximum, ttl)

    store.quota = charged


def client_row(kwargs):
    return (
        f'enterprise={kwargs["enterprise"]}; project={kwargs["project"]}; '
        f'location={kwargs["location"]}; http_timeout_ms={kwargs["http_options"].timeout}'
    )


@pytest.fixture
def recorder(monkeypatch):
    recorder = Recorder()
    monkeypatch.setattr(bm.genai, 'Client', recorder.client)
    monkeypatch.setattr(bm, 'genai_client', None)
    monkeypatch.setattr(bm, 'generate', recorder.generate)
    yield recorder
    bm.app.dependency_overrides.clear()


def rest_calls(recorder, monkeypatch, charges):
    """OCR, scope, audit (both age rules) and voice-note transcription, without company workspaces."""
    monkeypatch.setattr(bm, 'WORKSPACES_ENABLED', False)
    monkeypatch.setattr(ai_features, 'AI_FEATURES', frozenset())
    store = FakeStore()
    record_quota(store, charges)
    bm.app.dependency_overrides[bm.current_staff] = lambda: {
        'uid': 'owner',
        'email': 'owner@example.invalid',
    }
    bm.app.dependency_overrides[bm.get_job_store] = lambda: store
    client = TestClient(bm.app, headers={'Authorization': 'Bearer synthetic'})
    calls = {}

    def capture(name, response):
        calls[name] = recorder.one_call(response)

    def inspection(inspection_id, year):
        form = InspectionData(
            address='Synthetic test property',
            year_built=year,
            rooms=[{'name': 'Bathroom', 'category': 1, 'finished_sf': 10}],
            air_movers=3,
            dehumidifiers=1,
            scope_confirmed=True,
            technician_notes='Bathroom category 1, 10 square feet of drywall removed.',
        ).model_dump(mode='json')
        form.pop('equipment_scans')
        form.pop('coordinates')
        response = client.post(
            '/api/inspections', json={'inspection_id': inspection_id, 'data': form}
        )
        assert response.status_code == 200, response.text
        return response.json()

    def revision(inspection_id):
        return {
            'inspection_id': inspection_id,
            'expected_revision': store.get_inspection('owner', inspection_id)['revision'],
        }

    record = inspection(ID, 1977)
    response = client.post(
        f'/api/inspections/{ID}/photos',
        json=dict(
            expected_revision=record['revision'],
            photo_id=PHOTO,
            room='Bathroom',
            captured_at='2026-10-06T19:00:00Z',
            data_url=jpeg_data_url(3200, 2400),
        ),
    )
    assert response.status_code == 200, response.text
    capture('ocr', client.post(f'/api/inspections/{ID}/photos/{PHOTO}/ocr', json={}))
    capture('scope', client.post(f'/api/inspections/{ID}/scope-suggestions', json=revision(ID)))
    capture('audit_pre_1978', client.post('/api/audit', json=revision(ID)))
    inspection(LATER, 1978)
    capture('audit_1978_plus', client.post('/api/audit', json=revision(LATER)))
    capture('transcribe', client.post(f'/api/inspections/{ID}/voice-notes', json=note()))
    bm.app.dependency_overrides.clear()
    return calls


def company_calls(recorder, monkeypatch, charges):
    """The company-workspace paths: an audit with company identity, scope with claim details,
    the job summary and the drying-watch summary."""
    monkeypatch.setattr(bm, 'WORKSPACES_ENABLED', True)
    monkeypatch.setattr(
        ai_features, 'AI_FEATURES', frozenset({'readiness', 'job_summary', 'drying_watch'})
    )
    store = seed(FakeCompanyStore())
    record_quota(store, charges)
    current = {'uid': 'owner'}
    monkeypatch.setattr(bm, 'get_job_store', lambda: store)
    for endpoint in (bm.current_staff, bm.current_identity, bm.account_identity):
        bm.app.dependency_overrides[endpoint] = lambda: identity(current['uid'])
    for route in bm.app.routes:
        for dependency in getattr(getattr(route, 'dependant', None), 'dependencies', ()):
            if getattr(dependency.call, '__name__', '') == 'get_job_store':
                bm.app.dependency_overrides[dependency.call] = lambda: store
    calls = {}

    with TestClient(
        bm.app, headers={'X-ADR-Workspace-Protocol': '1', 'Authorization': 'Bearer synthetic'}
    ) as client:
        signed_job(client, current, store)
        calls['audit_company'] = recorder.one_call(NS(status_code=200))
        store.db.records['_companies/adr']['profile'].update(
            drying_reminders=True,
            email='office@example.invalid',
            crew_lead_email='crew@example.invalid',
        )
        store.db.records['_workspace_jobs/' + ID]['assigned_estimator_uid'] = 'estimator'
        current['uid'] = 'office'
        calls['drying_summary'] = recorder.one_call(
            client.post(f'/api/jobs/{ID}/drying-watch/summary')
        )
        current['uid'] = 'owner'
        calls['job_summary'] = recorder.one_call(client.get(f'/api/jobs/{ID}/insight'))
        current['uid'] = 'estimator'
        draft = store.create_inspection(
            'estimator',
            LATER,
            {
                **company_data(),
                'technician_notes': 'Bathroom category 1, carrier Synthetic Mutual.',
            },
        )
        calls['scope_with_claim'] = recorder.one_call(
            client.post(
                f'/api/inspections/{LATER}/scope-suggestions',
                json={'inspection_id': LATER, 'expected_revision': draft['revision']},
            )
        )
    bm.app.dependency_overrides.clear()
    return calls


def live_session(recorder, monkeypatch, charges):
    """A new walkthrough with the baseline readiness switch: the setup, the greeting and one
    photo-shot update sent between replies."""
    monkeypatch.setattr(bm, 'WORKSPACES_ENABLED', False)
    monkeypatch.setattr(ai_features, 'AI_FEATURES', frozenset({'readiness'}))
    # The relay holds context updates while a reply is expected; no reply comes from the stand-in.
    monkeypatch.setattr(bm, 'LIVE_REPLY_WAIT_SECONDS', 0)
    store = FakeStore()
    record_quota(store, charges)
    store.create_inspection('owner', ID, InspectionData().model_dump(mode='json'))

    async def verified(token, **_):
        return {'uid': 'owner', 'exp': time.time() + 600}

    monkeypatch.setattr(bm, 'verify_staff', verified)
    monkeypatch.setattr(bm, 'get_job_store', lambda: store)
    with TestClient(bm.app) as client:
        with client.websocket_connect('/api/live', headers={'origin': bm.ORIGINS[0]}) as socket:
            socket.send_json(
                dict(
                    type='authenticate',
                    token='synthetic',
                    inspection_id=ID,
                    protocol_version=2,
                    capture_id=CAPTURE,
                )
            )
            assert socket.receive_json()['type'] == 'ready'
            socket.send_json({'type': 'shots'})
            deadline = time.monotonic() + 10
            while len(recorder.session) < 2 and time.monotonic() < deadline:
                time.sleep(0.02)
    assert len(recorder.session) == 2 and len(recorder.connects) == 1
    return recorder.connects[0], recorder.session


def feature_switches(monkeypatch):
    def parsed(value):
        monkeypatch.setenv('AI_FEATURES', value)
        spec = importlib.util.spec_from_file_location('ai_features_probe', ai_features.__file__)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return sorted(module.AI_FEATURES)

    flag = next(
        arg
        for arg in deploy_backend.command('on', 'tag', 'commit')
        if arg.startswith('--update-env-vars=')
    )
    deployed = dict(item.split('=', 1) for item in flag.split('^|^', 1)[1].split('|'))
    with pytest.raises(argparse.ArgumentTypeError) as unknown:
        deploy_backend.ai_features_value('not-a-feature')
    return {
        'ai_features.parse': f"unset -> {parsed('')}; ' Job_Summary,,readiness ' -> {parsed(' Job_Summary,,readiness ')}",
        'deploy.AI_FEATURES': f'default deploy sets {deployed["AI_FEATURES"]!r}; {str(unknown.value).split("; ", 1)[1]}',
    }


def observed(recorder, monkeypatch):
    settings = {
        f'main.{name}': str(getattr(bm, name))
        for name in (
            'REST_DEADLINE_SECONDS',
            'AUDIT_ATTEMPT_SECONDS',
            'AUDIT_RETRY_MIN_SECONDS',
            'AUDIT_SAVE_RESERVE_SECONDS',
            'AUDIT_PHOTO_DOWNLOADS',
            'VOICE_NOTE_BYTES',
            'LIVE_RECHECK_SECONDS',
            'LIVE_REPLY_WAIT_SECONDS',
        )
    }
    settings['inspection_store.TRANSCRIPT_LIMIT'] = str(inspection_store.TRANSCRIPT_LIMIT)
    charges = {}
    calls = {
        **rest_calls(recorder, monkeypatch, charges),
        **company_calls(recorder, monkeypatch, charges),
    }
    connect, session = live_session(recorder, monkeypatch, charges)
    rest_clients = [kwargs for kwargs in recorder.clients if kwargs['location'] == bm.LOCATION]
    live_clients = [kwargs for kwargs in recorder.clients if kwargs['location'] == bm.LIVE_LOCATION]

    prompts = {}
    settings['client.rest'] = client_row(rest_clients[0])
    settings['client.live'] = client_row(live_clients[-1])
    for name, (request, timeout) in sorted(calls.items()):
        config = request['config']
        kinds, text = pieces(request['contents'])
        prompts[f'{name}.request'] = text
        thinking = (
            config.thinking_config.thinking_level.value
            if config.thinking_config
            else 'provider default'
        )
        schema = config.response_schema
        settings[f'call.{name}'] = (
            f'model={request["model"]}; thinking={thinking}; timeout={timeout}; '
            f'response={config.response_mime_type} {getattr(schema, "__name__", "wire schema")}; '
            f'parts={", ".join(kinds)}{image_size(request["contents"])}'
        )
        settings[f'schema.{name}'] = schema_digest(schema)
    live = connect['config']
    prompts['live.system_instruction'] = live.system_instruction
    for name, content in zip(('live.greeting', 'live.shot_update'), session):
        prompts[name] = pieces(content['turns'].parts)[1]
        settings[f'{name}.turn_complete'] = str(content['turn_complete'])
    settings['live.connect'] = f'model={connect["model"]}; config=' + json.dumps(
        live.model_dump(mode='json', exclude_none=True, exclude={'system_instruction'}),
        sort_keys=True,
    )
    for action, maximum in charges.items():
        daily = inspection_store.DAILY_LIMITS.get(action)
        settings[f'quota.{action}'] = (
            f'{maximum} a minute' if maximum else 'no per-minute limit'
        ) + (f', {daily} a day' if daily else ', no daily limit')
    settings.update(feature_switches(monkeypatch))
    return (
        {key: digest(normalized(text)) for key, text in sorted(prompts.items())},
        dict(sorted(settings.items())),
    )


def table(prompts, settings):
    lines = ['| Request id | sha256 of the normalized emitted text |', '| --- | --- |']
    lines += [f'| `{key}` | `{value}` |' for key, value in prompts.items()]
    lines += ['', '| Observed setting | Observed value |', '| --- | --- |']
    lines += [f'| `{key}` | `{value}` |' for key, value in settings.items()]
    return '\n'.join(lines)


def pinned(markdown, header):
    """The first table whose first header cell is `header`, as {first cell: last cell}."""
    lines = markdown.split('\n')
    start = next(i for i, line in enumerate(lines) if line.startswith(f'| {header} |'))
    rows = {}
    for line in lines[start + 2 :]:
        if not line.startswith('|'):
            break
        cells = [cell.strip().strip('`') for cell in line.strip('|').split(' | ')]
        rows[cells[0]] = cells[-1]
    return rows


def differences(markdown, prompts, settings):
    problems = []
    for header, facts in (('Request id', prompts), ('Observed setting', settings)):
        rows = pinned(markdown, header)
        for key, value in facts.items():
            if key not in rows:
                problems.append(f'{key} is not in the inventory.')
            elif rows[key] != value:
                problems.append(f'{key} changed: inventory {rows[key]!r}, emitted {value!r}.')
        problems += [f'{key} is no longer emitted.' for key in rows if key not in facts]
    return problems


def test_normalized_text_keeps_prompt_lines_and_hides_only_json_data_lines():
    text = 'Instructions {"not": "data"} here\n{"room": "Bathroom"}\n[1, 2]\n7\nEnd'
    assert normalized(text) == 'Instructions {"not": "data"} here\n<json>\n<json>\n7\nEnd'
    assert digest('abc') == 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'


def test_every_emitted_prompt_and_setting_matches_the_inventory(recorder, monkeypatch):
    prompts, settings = observed(recorder, monkeypatch)
    problems = differences(INVENTORY.read_text(encoding='utf8'), prompts, settings)
    assert not problems, '\n'.join(problems) + '\n\n' + table(prompts, settings) + '\n\n' + UPDATE


def test_a_changed_emitted_prompt_or_setting_is_reported(recorder, monkeypatch):
    monkeypatch.setattr(bm, 'OCR_INSTRUCTIONS', bm.OCR_INSTRUCTIONS + ' Changed.')
    monkeypatch.setattr(workspace_api, 'JOB_SUMMARY_INSTRUCTIONS', 'Replaced.')
    monkeypatch.setattr(bm, 'OCR_MODEL', 'another-model')
    # The inventory reports a model change; spending would otherwise refuse the unverified model.
    for module in (bm, ai_spending):
        monkeypatch.setattr(
            module,
            'rest_output_limit',
            lambda model, operation: ai_spending.REST_OUTPUT_LIMITS[operation],
        )
    wire = bm.scope_response_schema()
    wire['required'] = [*wire.get('required', []), 'extra']
    monkeypatch.setattr(bm, 'scope_response_schema', lambda: wire)
    monkeypatch.setattr(
        bm.OcrResult,
        'model_json_schema',
        classmethod(lambda cls: {'type': 'object', 'properties': {'changed': {'type': 'boolean'}}}),
    )
    prompts, settings = observed(recorder, monkeypatch)
    problems = '\n'.join(differences(INVENTORY.read_text(encoding='utf8'), prompts, settings))
    assert 'ocr.request changed' in problems
    assert 'job_summary.request changed' in problems
    assert 'call.ocr changed' in problems and 'another-model' in problems
    assert 'schema.scope changed' in problems and 'schema.scope_with_claim changed' in problems
    assert 'schema.ocr changed' in problems
    assert (
        'scope.request changed' not in problems and 'schema.audit_company changed' not in problems
    )
