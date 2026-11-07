"""Actual SDK serialization for counted and funded AI requests."""

import asyncio
import json
from backend import main as bm
from tests.fakes import FakeStore
from tests.test_backend import ID


def test_real_sdk_serializes_response_schemas_for_vertex(monkeypatch):
    # The real google-genai client builds each request; only the HTTP transport is synthetic.
    import httpx
    from google.oauth2.credentials import Credentials
    from backend.scope import ScopeSuggestions, scope_response_schema

    requests = []
    counts = []
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
        if request.url.path.endswith(':countTokens'):
            counts.append(body)
            return httpx.Response(200, json={'totalTokens': 100})
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

    spending = (FakeStore(), 'tech')

    async def run():
        return [
            await bm.generate(
                bm.AIResult,
                ['Synthetic audit'],
                bm.AUDIT_MODEL,
                'audit',
                ID,
                thinking_level=bm.AUDIT_THINKING_LEVEL,
                spending=spending,
            ),
            await bm.generate(
                bm.OcrResult, ['Synthetic photo'], bm.OCR_MODEL, 'ocr', ID, spending=spending
            ),
            await bm.generate(
                ScopeSuggestions,
                ['Synthetic scope'],
                bm.AUDIT_MODEL,
                'scope',
                ID,
                wire_schema=scope_response_schema(),
                thinking_level=bm.SCOPE_THINKING_LEVEL,
                spending=spending,
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
    assert len(counts) == 3
    assert [body['generationConfig'] for body in counts] == generation
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
