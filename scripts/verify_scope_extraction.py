"""Read-only, explicitly synthetic Vertex scope-extraction check; no saved jobs or IAM changes."""

import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.contracts import InspectionData
from backend.main import generate, AUDIT_MODEL, PROJECT_ID
from backend.scope import (
    ScopeSuggestions,
    scope_prompt,
    validate_suggestions,
    scope_response_schema,
)


async def check():
    data = InspectionData(
        rooms=[{'name': 'Bathroom'}],
        technician_transcript=(
            'Bathroom, water category 2. I measured 80 square feet of drywall to remove. '
            'For this job use 3 fans and 1 dehumidifier for 4 days.'
        ),
    )
    result = await generate(
        ScopeSuggestions, [scope_prompt(data)], AUDIT_MODEL, wire_schema=scope_response_schema()
    )
    checked = validate_suggestions(data, result)
    actual = {(c.room, c.field): c.value for c in checked.changes}
    expected = {
        ('Bathroom', 'category'): 2,
        ('Bathroom', 'finished_sf'): 80,
        (None, 'air_movers'): 3,
        (None, 'dehumidifiers'): 1,
        (None, 'drying_days'): 4,
    }
    assert actual == expected, actual
    print(
        'PASS: synthetic Vertex extraction produced the explicit room/category/area and job equipment totals, with technician quotes.'
    )
    print('Project:', PROJECT_ID, 'model:', AUDIT_MODEL)
    print('No inspections, evidence, signatures or IAM permissions were created or changed.')


if __name__ == '__main__':
    asyncio.run(asyncio.wait_for(check(), 55))
