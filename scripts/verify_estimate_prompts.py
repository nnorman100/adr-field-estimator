"""Synthetic, read-only Vertex checks for estimate-derived prompts; no customer PDF data."""
import asyncio
import sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.contracts import AIResult, InspectionData
from backend.claims import price_scope, make_documents
from backend.main import generate, get_ai_client, AUDIT_MODEL, PROJECT_ID
from backend.prompts import audit_prompt
from backend.scope import ScopeSuggestions, scope_prompt, scope_response_schema, validate_suggestions

async def extract(label, data, expected, forbidden):
    result = await generate(ScopeSuggestions, [scope_prompt(data)], AUDIT_MODEL, wire_schema=scope_response_schema())
    result = validate_suggestions(data, result)
    actual = {(c.room, c.field): c.value for c in result.changes}
    assert actual == expected, (label, actual)
    assert not any(c.field in forbidden for c in result.changes), (label, actual)
    if not expected:
        assert result.questions, (label, 'Expected clarification')
    print('PASS:', label)

async def audit_specialty():
    data = InspectionData(address='Synthetic property', year_built=1962,
        rooms=[{'name':'Bathroom', 'category':2, 'finished_sf':30}], scope_confirmed=True,
        technician_notes=(
            'Bathroom: technician reports dry moisture readings but suspected microbial growth behind the toilet. '
            'Emergency response and equipment setup were performed yesterday. The proposed scope is 30 square feet of drywall removal '
            'on the south wall and moving and resetting the toilet. Cabinet removal is only a possibility after evaluating drying; '
            'it is not included in the requested work.'))
    result = await generate(AIResult, [audit_prompt(data.model_dump(mode='json'), [], price_scope(data)[0])], AUDIT_MODEL)
    assert any('toilet' in task.casefold() for task in result.unpriced_work), result
    assert not any('cabinet' in task.casefold() for task in result.unpriced_work), result
    assert 'suspect' in result.summary.casefold(), result.summary
    assert 'propos' in result.summary.casefold(), result.summary
    assert not make_documents(data, [], result)['signable']
    print('PASS: mixed completed/proposed work, suspected growth and unpriced toilet task; cabinet possibility remains conditional')

async def audit_cleaning_only():
    data = InspectionData(address='Synthetic new-build property', year_built=2026,
        rooms=[{'name':'Attic'}], scope_confirmed=True, labor_hours=2,
        technician_notes=(
            'The owner forwarded a third-party home inspection report describing suspected microbial growth in the attic. '
            'ADR has not independently verified those findings. The requested proposed work is HEPA vacuuming, '
            'cleaning/scrubbing, applying an antimicrobial solution, and encapsulation at up to six attic locations. '
            'No demolition or drying equipment is requested.'))
    result = await generate(AIResult, [audit_prompt(data.model_dump(mode='json'), [], price_scope(data)[0])], AUDIT_MODEL)
    unpriced = ' '.join(result.unpriced_work).casefold()
    assert 'hepa' in unpriced and ('clean' in unpriced or 'scrub' in unpriced), result
    assert 'antimicrob' in unpriced and 'encaps' in unpriced, result
    summary = result.summary.casefold()
    assert 'third-party' in summary or 'third party' in summary, result.summary
    assert 'suspect' in summary, result.summary
    assert not make_documents(data, [], result)['signable']
    print('PASS: cleaning-only services remain unpriced despite generic labor/filter charges; third-party findings stay attributed')

async def attic_extraction():
    await extract('attic spot cleaning does not create demolition, water category, filter/equipment or labor counts',
        InspectionData(rooms=[{'name':'Attic'}], technician_transcript=(
            'The owner says a third-party report lists suspected microbial growth in the attic. I have not verified it. '
            'Requested work is HEPA vacuuming, cleaning, antimicrobial treatment and encapsulation at up to six attic spots. '
            'This is cleaning only, not demolition. No water category, equipment counts or labor hours have been confirmed.')), {},
        {'category','finished_sf','unfinished_sf','air_movers','dehumidifiers','hepa_filters','labor_hours'})

async def check():
    await asyncio.gather(
        extract('flood-cut dimensions are not priced square feet', InspectionData(rooms=[{'name':'Bathroom'}], technician_transcript=(
            'Bathroom, water category 2. Proposed two-foot flood cut up to seven linear feet of the south wall to remove plaster and insulation. '
            'An existing three-by-three opening is already missing.')), {('Bathroom','category'):2}, {'finished_sf','unfinished_sf'}),
        extract('measured ceiling removal is extracted', InspectionData(rooms=[{'name':'Bedroom'}], technician_transcript=(
            'Bedroom water category 3. I measured eight square feet of ceiling drywall to remove, classified as finished demolition area. '
            'That is additional removal around the existing one-by-one opening, not including the opening.')), {('Bedroom','category'):3, ('Bedroom','finished_sf'):8}, set()),
        extract('conditional cabinets and equipment do not set form values', InspectionData(rooms=[{'name':'Kitchen'}], technician_transcript=(
            'Kitchen has a granite countertop. Lower cabinet removal may be needed depending on drying, but is not in the current scope. '
            'We may use fans and dehumidification. The meter was in the standard dry range and there is suspected microbial growth.')),
            {}, {'granite_removal','custom_cabinetry','category','air_movers','dehumidifiers','drying_days','finished_sf','unfinished_sf'}),
        audit_specialty(),
        extract('unit-qualified rooms retain separate measurements; inspected-only room is not priced',
            InspectionData(rooms=[{'name':'Suite A Bathroom'}, {'name':'Suite B Bathroom'}, {'name':'Suite A Walkway'}],
                technician_transcript=(
                    'Suite A Bathroom, water category 2, measured twelve square feet of finished drywall demolition. '
                    'Suite B Bathroom, water category 3, measured thirty square feet of finished drywall demolition. '
                    'Suite A Walkway was inspected only, dry readings, no removal proposed.')),
            {('Suite A Bathroom','category'):2, ('Suite A Bathroom','finished_sf'):12,
             ('Suite B Bathroom','category'):3, ('Suite B Bathroom','finished_sf'):30}, set()),
        extract('ambiguous bathroom/unit, full-height wall and other-inspection equipment require clarification',
            InspectionData(rooms=[{'name':'Suite A Bathroom'}, {'name':'Suite B Bathroom'}], technician_transcript=(
                'Bathroom, category 2, proposed floor-to-ceiling drywall removal up to seven linear feet. '
                'I have not specified which suite or a measured wall height. In a separate inspection at another property, '
                'five fans and two dehumidifiers were used. Those counts are not for this job.')), {},
            {'category','finished_sf','unfinished_sf','air_movers','dehumidifiers'}),
        attic_extraction(),
        audit_cleaning_only())
    print('Project:', PROJECT_ID, 'model:', AUDIT_MODEL)
    print('Synthetic prompt behavior only. No customer documents sent; no inspections, evidence, signatures or IAM changes.')

async def main():
    try:
        await asyncio.wait_for(attic_extraction() if '--attic-only' in sys.argv else check(), 55)
    finally:
        await get_ai_client().aio.aclose()

if __name__ == '__main__':
    asyncio.run(main())
