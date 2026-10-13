"""Synthetic batch-three prompt checks; no source PDF text/images or persisted jobs."""

import asyncio
import base64
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.contracts import InspectionData, AIResult, OcrResult
from backend.claims import price_scope, make_documents, GRANITE
from backend.main import generate, get_ai_client, AUDIT_MODEL, OCR_MODEL, PROJECT_ID
from backend.prompts import audit_prompt, OCR_INSTRUCTIONS
from backend.scope import (
    ScopeSuggestions,
    scope_prompt,
    scope_response_schema,
    validate_suggestions,
)
from google.genai import types
from tests.fakes import png


async def scope_case(label, words, expected, questions=False):
    data = InspectionData(rooms=[{'name': 'Kitchen'}], technician_transcript=words)
    result = await generate(
        ScopeSuggestions, [scope_prompt(data)], AUDIT_MODEL, wire_schema=scope_response_schema()
    )
    result = validate_suggestions(data, result)
    actual = {(c.room, c.field): c.value for c in result.changes}
    assert actual == expected, (label, result)
    if questions:
        assert result.questions, (label, 'Clarification missing')
    if actual.get((None, 'granite_removal')):
        reviewed = InspectionData(
            address='Synthetic property',
            year_built=2020,
            granite_removal=True,
            rooms=[{'name': 'Kitchen', 'category': 2, 'finished_sf': 28}],
            scope_confirmed=True,
        )
        docs = make_documents(
            reviewed,
            [],
            AIResult(
                summary='Proposed cabinet removal beneath retained granite.',
                suggestions=[],
                unpriced_work=[
                    'Kitchen: cabinet removal and countertop support need explicit pricing.'
                ],
            ),
        )
        assert GRANITE in docs['adr_estimate']['disclaimers'] and not docs['signable']
    print('PASS:', label, flush=True)


async def health_case():
    data = InspectionData(
        address='Synthetic property',
        year_built=2020,
        rooms=[{'name': 'Kitchen'}],
        scope_confirmed=True,
        technician_notes=(
            'Kitchen: technician observed dark discoloration, recorded as suspected microbial growth. '
            'The owner asks whether it proves toxic black mold and explains reported headaches. A generic brochure claims '
            'dark color identifies the most dangerous mold and neurological illness. No species, health cause or occupancy clearance is established.'
        ),
    )
    result = await generate(
        AIResult,
        [audit_prompt(data.model_dump(mode='json'), [], price_scope(data)[0])],
        AUDIT_MODEL,
    )
    text = (result.summary + ' ' + ' '.join(result.suggestions)).casefold()
    assert 'suspect' in result.summary.casefold(), result
    assert any(
        x in text
        for x in ['healthcare', 'health care', 'physician', 'clinician', 'medical professional']
    ), result
    assert not any(
        x in text
        for x in [
            'confirmed toxic black mold',
            'safe to occupy',
            'is stachybotrys',
            'most dangerous variety',
        ]
    ), result
    print(
        'PASS: reported health concern stays separate from suspected growth; personal symptoms referred to healthcare',
        flush=True,
    )
    print('Synthetic health summary:', result.summary, flush=True)


async def evidence_case():
    data = InspectionData(
        address='Synthetic property',
        year_built=2020,
        rooms=[{'name': 'Kitchen'}],
        scope_confirmed=True,
        technician_notes=(
            'Kitchen: the legacy moisture album contains a physical thermal-camera photo. '
            'The report upload date is October 6; capture date is unknown. No physical moisture-meter value is verified. '
            'The administrative loss category is a mitigation budget band, not a confirmed water category.'
        ),
        assistant_transcript='The color pattern suggests 999 percent moisture and category 3.',
    )
    photos = [
        dict(
            id='synthetic-thermal',
            room='Kitchen',
            captured_at=None,
            ocr_status='no_meter',
            ocr=dict(
                meter_detected=False,
                meter_type='Thermal camera',
                value='',
                classification='No moisture value',
                notes='Temperature-pattern image only; upload date is not the capture date.',
            ),
        )
    ]
    result = await generate(
        AIResult,
        [audit_prompt(data.model_dump(mode='json'), photos, price_scope(data)[0])],
        AUDIT_MODEL,
    )
    text = (result.summary + ' ' + ' '.join(result.suggestions)).casefold()
    assert '999' not in text and 'thermal' in text, result
    assert any(
        x in text
        for x in [
            'not verified',
            'unverified',
            'no verified',
            'no physical',
            'does not',
            'cannot',
            'temperature',
        ]
    ), result
    print(
        'PASS: thermal album and assistant guesses do not become verified moisture or water-category evidence',
        flush=True,
    )


async def open_extent_case():
    data = InspectionData(
        address='Synthetic property',
        year_built=2020,
        rooms=[{'name': 'Living Room', 'category': 2, 'finished_sf': 20}],
        scope_confirmed=True,
        technician_notes=(
            'Living Room: proposed laminate removal until dry planks are reached. '
            'Its actual extent has not been measured. The entered 20 square feet is for drywall only and does not include this flooring work.'
        ),
    )
    result = await generate(
        AIResult,
        [audit_prompt(data.model_dump(mode='json'), [], price_scope(data)[0])],
        AUDIT_MODEL,
    )
    assert any(
        'floor' in x.casefold() or 'laminate' in x.casefold() for x in result.unpriced_work
    ), result
    assert not make_documents(data, [], result)['signable']
    print(
        'PASS: requested open-ended flooring outside priced quantities blocks signing', flush=True
    )


async def ocr_case():
    image = types.Part.from_bytes(
        data=base64.b64decode(png().split(',', 1)[1]), mime_type='image/png'
    )
    result = await generate(OcrResult, [image, OCR_INSTRUCTIONS], OCR_MODEL)
    assert not result.meter_detected and result.value == '', result
    print('PASS: synthetic non-meter fixture does not produce a verified reading', flush=True)


async def check():
    cases = [
        scope_case(
            'cabinet removal under retained/propped granite sets notice flag',
            'Kitchen, water category 2. I measured 28 square feet of finished drywall demolition. '
            'Remove the lower cabinets beneath the granite countertop. Prop and preserve the granite while the cabinets are removed.',
            {
                ('Kitchen', 'category'): 2,
                ('Kitchen', 'finished_sf'): 28,
                (None, 'granite_removal'): True,
            },
        ),
        scope_case(
            'tile countertop presence does not set the granite flag',
            'Kitchen lower cabinets are to be removed. The countertop is tile, not granite, and the tile backsplash may break. '
            'No water category or demolition square footage has been confirmed.',
            {},
            True,
        ),
        scope_case(
            'until dry planks, perimeter cut and monetary loss band are not measured SF or water category',
            'Kitchen: remove flooring until dry planks. Perform a four-foot flood cut around the closet perimeter. '
            'The report loss category is a mitigation budget band. No measured area, perimeter length or water category has been stated.',
            {},
            True,
        ),
        health_case(),
        evidence_case(),
        open_extent_case(),
        ocr_case(),
    ]
    gate = asyncio.Semaphore(3)

    async def bounded(case):
        async with gate:
            await case

    results = await asyncio.gather(*(bounded(case) for case in cases), return_exceptions=True)
    errors = [error for error in results if isinstance(error, BaseException)]
    if errors:
        raise RuntimeError(str(errors))
    print('Project:', PROJECT_ID, 'audit/extraction model:', AUDIT_MODEL, 'OCR model:', OCR_MODEL)
    print(
        'All data/imagery synthetic. No customer PDF contents sent; no jobs, evidence, signatures or IAM changes.'
    )


async def main():
    try:
        await asyncio.wait_for(check(), 55)
    finally:
        await get_ai_client().aio.aclose()


if __name__ == '__main__':
    asyncio.run(main())
