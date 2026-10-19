from decimal import Decimal
import pytest
from pydantic import ValidationError
from backend.claims import (
    price_scope,
    proposal_range,
    technician_statement,
    make_documents,
    ADDITIONAL,
    PRETEST,
    REPRICE,
    TESTING,
    VALIDITY,
)
from backend.contracts import InspectionData, AIResult
from backend.prompts import audit_prompt


def scoped(**kwargs):
    values = dict(
        address='Synthetic',
        year_built=1960,
        rooms=[{'name': 'Bathroom', 'finished_sf': 10}],
        scope_confirmed=True,
    )
    values.update(kwargs)
    return InspectionData(**values)


def test_exact_baseline_equipment_and_waste():
    items, total = price_scope(scoped(rooms=[], air_movers=3, dehumidifiers=1))
    assert sum(Decimal(str(i['total'])) for i in items[:5]) == Decimal('1180.20')
    assert sum(i['total'] for i in items[5:]) == 567
    assert total == 1747.2
    items, _ = price_scope(
        scoped(rooms=[{'name': 'Room', 'category': 1, 'finished_sf': 36, 'waste_percent': 10}])
    )
    assert items[5]['total'] == 110.09


@pytest.mark.parametrize(
    'category,unfinished,finished', [(1, 1.21, 2.78), (2, 1.52, 2.89), (3, 2.48, 8.39)]
)
def test_category_and_cabinet_rates(category, unfinished, finished):
    items, _ = price_scope(
        scoped(
            rooms=[
                {
                    'name': 'Room',
                    'category': category,
                    'unfinished_sf': 1,
                    'finished_sf': 1,
                    'custom_cabinetry': True,
                }
            ]
        )
    )
    assert items[5]['total'] == unfinished and items[6]['total'] == finished * (
        2 if category == 3 else 1
    )


def test_disclaimers_age_planned_work_and_estimate_range():
    ai = AIResult(summary='<img src=x onerror=alert(1)>', suggestions=[], unpriced_work=[])
    docs = make_documents(scoped(), [], ai)
    assert docs['schema_version'] == 3
    assert docs['adr_estimate']['proposed_cost_low'] == 1208
    assert docs['adr_estimate']['proposed_cost'] == 1221.90
    assert docs['xactimate_total'] == 1208
    assert PRETEST in docs['adr_estimate']['disclaimers']
    assert 'completion has not been recorded' in docs['iicrc_defense_letter']
    modern = make_documents(scoped(year_built=2000), [], ai)
    assert (
        not modern['adr_estimate']['lead_notice_required']
        and PRETEST not in modern['adr_estimate']['disclaimers']
    )


def test_standard_estimate_clauses_follow_property_age():
    ai = AIResult(summary='Reviewed', suggestions=[], unpriced_work=[])
    old = make_documents(scoped(), [], ai)
    proposal = old['adr_estimate']
    assert proposal['recommendations'] == [
        TESTING,
        'Per IICRC and EPA protocols, Alert Disaster Restoration technicians will don appropriate personal protective equipment during mitigation/remediation services. The technicians will set containments as needed.',
        'Bathroom: category 1 finished/drywall/trim demolition',
        ADDITIONAL,
    ]
    assert proposal['disclaimers'] == [
        PRETEST,
        'NOTE: This estimate does NOT include reconstruction after remediation. Demolition is a highly unpredictable procedure. As such, any collateral damage resulting from the demolition prescribed herein will NOT be the responsibility of Alert Disaster Restoration. This estimate does not include testing of any kind.',
        REPRICE,
        VALIDITY,
    ]
    assert proposal['findings'][0] == (
        'Due to property age (1960), California State Law requires third-party lead and asbestos testing prior to destructive demolition.'
    )
    assert all(text in old['iicrc_defense_letter'] for text in [TESTING, ADDITIONAL, VALIDITY])
    modern = make_documents(scoped(year_built=1990), [], ai)['adr_estimate']
    assert modern['findings'][0] == (
        'The home was built in 1990. Therefore, no lead or asbestos testing is required prior to the start of work.'
    )
    assert TESTING not in modern['recommendations'] and PRETEST not in modern['disclaimers']
    assert modern['disclaimers'][-2:] == [REPRICE, VALIDITY]


def test_retired_job_condition_flags_load_but_print_nothing():
    ai = AIResult(summary='Reviewed', suggestions=[], unpriced_work=[])
    legacy = scoped(
        has_crawl_space=True, granite_removal=True, water_heater_loss=True, work_performed=True
    )
    docs = make_documents(legacy, [], ai)
    assert docs == make_documents(scoped(), [], ai)
    text = str(docs)
    for retired in ['crawl space', 'granite', 'water heater', 'Can Do Crew', 'was performed']:
        assert retired not in text
    assert 'This scope describes proposed work; completion has not been recorded.' in text


@pytest.mark.parametrize('category', [1, 2, 3])
def test_loss_type_is_a_label_that_never_changes_pricing_or_documents(category):
    ai = AIResult(summary='Reviewed', suggestions=[], unpriced_work=[])
    room = {'name': 'Bathroom', 'category': category, 'finished_sf': 10, 'unfinished_sf': 4}
    legacy = make_documents(scoped(rooms=[room]), [], ai)
    for loss in ['water', 'mold', 'both']:
        labelled = scoped(rooms=[{**room, 'loss': loss}])
        assert labelled.rooms[0].loss == loss
        assert price_scope(labelled) == price_scope(scoped(rooms=[room]))
        items, _ = price_scope(labelled)
        assert proposal_range(labelled, items) == proposal_range(scoped(rooms=[room]), items)
        assert make_documents(labelled, [], ai) == legacy
    assert f'category {category}' in str(legacy)
    assert scoped(rooms=[room]).rooms[0].loss is None
    with pytest.raises(ValidationError):
        scoped(rooms=[{**room, 'loss': 'sewage'}])


def test_pending_evidence_and_unpriced_work_block_signature():
    ai = AIResult(
        summary='Review', suggestions=[], unpriced_work=['Plumbing reset lacks an ADR rate.']
    )
    docs = make_documents(
        scoped(),
        [
            {
                'id': 'a',
                'room': 'Bathroom',
                'captured_at': '2026-10-06T19:00:00Z',
                'width': 120,
                'height': 60,
                'ocr_status': 'pending',
                'ocr': None,
            }
        ],
        ai,
    )
    assert not docs['signable']
    with pytest.raises(ValueError):
        make_documents(scoped(year_built=None), [], ai)


def test_workbook_afterhours_range_and_legacy_tier_rejection():
    scope = scoped(
        rooms=[{'name': 'Room', 'category': 2, 'unfinished_sf': 140, 'finished_sf': 5}],
        air_movers=3,
        dehumidifiers=1,
        is_after_hours=True,
    )
    items, total = price_scope(scope)
    assert total == 2174.45
    assert next(item for item in items if item['code'] == 'ADR-AFTER')['total'] == 200
    docs = make_documents(scope, [], AIResult(summary='Reviewed', suggestions=[], unpriced_work=[]))
    assert docs['adr_estimate']['proposed_cost_low'] == 2219.90
    assert docs['adr_estimate']['proposed_cost'] == 2356.25
    assert '2,219.90' in docs['iicrc_defense_letter']
    with pytest.raises(ValueError, match='old package-tier'):
        make_documents(
            scoped(package_price='2049.99'),
            [],
            AIResult(summary='Reviewed', suggestions=[], unpriced_work=[]),
        )


def test_afterhours_added_labor_mirrors_workbook_formula():
    items, _ = price_scope(scoped(is_after_hours=True, labor_hours=2))
    labor = next(item for item in items if item['code'] == 'ADR-LABOR')
    assert labor['unit_price'] == 47.46 and labor['total'] == 94.92


def test_optional_sheet_charges_and_wood_floor_daily_rate():
    items, total = price_scope(
        scoped(
            rooms=[],
            matterport_scans=1,
            dump_truck_loads=2,
            equipment_decon=1,
            power_distribution=1,
            wood_floor_systems=1,
            wood_floor_days=7,
        )
    )
    charges = {item['code']: item['total'] for item in items}
    assert charges['ADR-MATTERPORT'] == 250
    assert charges['ADR-DUMP'] == 573.56
    assert charges['ADR-DECON'] == 27.72
    assert charges['ADR-POWER'] == 66.74
    assert charges['ADR-WOOD'] == 1260
    assert total == 3358.22


def test_sheet_job_charge_quantities_are_confirmed_inputs():
    items, total = price_scope(
        scoped(
            rooms=[],
            emergency_calls=0,
            monitoring_hours=0,
            haul_loads=2,
            air_scrubbers=0,
            hepa_filters=0,
        )
    )
    assert [item['code'] for item in items] == ['ADR-HAUL']
    assert total == 319.06
    with pytest.raises(ValidationError):
        scoped(monitoring_hours=float('nan'))
    with pytest.raises(ValidationError):
        scoped(dump_truck_loads=-1)
    with pytest.raises(ValidationError):
        scoped(labor_hours=float('nan'))


def photo(photo_id, room, value=None):
    return dict(
        id=photo_id,
        room=room,
        captured_at='2026-10-15T12:00:00Z',
        width=10,
        height=10,
        ocr_status='verified' if value else 'no_meter',
        ocr=dict(
            meter_detected=True, meter_type='Extech MO290', value=value, classification='', notes=''
        )
        if value
        else None,
    )


def test_findings_cite_photos_by_their_photo_log_number():
    ai = AIResult(summary='Reviewed', suggestions=[], unpriced_work=[])
    photos = [
        photo('a' * 32, 'Hallway'),
        photo('b' * 32, 'Kitchen', '31.4% WME'),
        photo('c' * 32, 'Bathroom', '18.0% WME'),
    ]
    docs = make_documents(scoped(), photos, ai)
    cited = [text for text in docs['adr_estimate']['findings'] if text.startswith('Photo ')]
    assert cited == [
        'Photo 1 (Hallway) — supporting photo; no verified meter reading.',
        'Photo 2 (Kitchen) — Extech MO290: 31.4% WME',
        'Photo 3 (Bathroom) — Extech MO290: 18.0% WME',
    ]
    # The photo log keeps internal IDs in the order the numbers count.
    assert [entry['id'] for entry in docs['photo_audit_log']] == ['a' * 32, 'b' * 32, 'c' * 32]
    assert all(text in docs['iicrc_defense_letter'] for text in cited)
    assert not any(
        'b' * 32 in text or 'c' * 32 in text
        for text in docs['adr_estimate']['findings'] + [docs['iicrc_defense_letter']]
    )


@pytest.mark.parametrize('name', ['', '   '])
def test_documents_without_a_customer_name_omit_it(name):
    ai = AIResult(summary='Reviewed', suggestions=[], unpriced_work=[])
    docs = make_documents(scoped(), [], ai, customer_name=name)
    assert docs['adr_estimate']['customer_name'] == ''
    assert 'Customer:' not in docs['iicrc_defense_letter']
    named = make_documents(scoped(), [], ai, customer_name=' Pat Example ')
    assert named['adr_estimate']['customer_name'] == 'Pat Example'
    assert (
        'RE: Remediation scope for Synthetic\nCustomer: Pat Example\n\n'
        in named['iicrc_defense_letter']
    )


# Modeled on the 2026-10-17 "1234 Acme St" phone test: speaker echo of the greeting, chatter,
# two Office photos without a meter, a 1978 home and model text with internal terms.
ACME_TECHNICIAN = '\n'.join(
    [
        'Welcome to the',
        'Office, category 1.',
        'The corner, southwest corner of the office.',
        'Can I add a picture?',
        'Laminate flooring, 10 linear feet, remove. Drywall, 20 square feet, remove.',
        'But you get it?',
        "I'll be using a dryer.",
        'One dehumidifier for three days. All right, thanks.',
    ]
)
ACME_ASSISTANT = '\n'.join(
    [
        'Welcome to the walkthrough. What is the year built?',
        'Got it. Which room are we in, and do you have a water category for it?',
        'Do you mean a dehumidifier? How many, and for how many days?',
    ]
)


def acme(**kwargs):
    values = dict(
        address='1234 Acme St',
        year_built=1978,
        rooms=[{'name': 'Office', 'unfinished_sf': 20, 'finished_sf': 20, 'waste_percent': 10}],
        technician_transcript=ACME_TECHNICIAN,
        assistant_transcript=ACME_ASSISTANT,
    )
    return scoped(**{**values, **kwargs})


def test_documents_use_the_technician_statement_without_echo_or_chatter():
    ai = AIResult(summary='Reviewed', suggestions=[], unpriced_work=[])
    docs = make_documents(acme(), [], ai)
    statement = (
        'Office, category 1.\n'
        'The corner, southwest corner of the office.\n'
        'Laminate flooring, 10 linear feet, remove. Drywall, 20 square feet, remove.\n'
        "I'll be using a dryer.\n"
        'One dehumidifier for three days.'
    )
    assert technician_statement(acme()) == statement
    finding = 'Technician walkthrough statement: ' + statement
    assert finding in docs['adr_estimate']['findings']
    assert finding in docs['iicrc_defense_letter']
    for text in [str(docs['adr_estimate']), docs['iicrc_defense_letter']]:
        for chatter in ['Welcome to the', 'Can I add', 'you get it', 'All right', 'transcript']:
            assert chatter not in text


@pytest.mark.parametrize(
    'turn',
    [
        # A short confirmation, a number or a fact the assistant never said stays technician evidence.
        'Category 1.',
        'Finished drywall.',
        'Water category for it is 2.',
        'Yes.',
        'Okay, the bathroom vanity is wet.',
        'To the right.',
        'Right side.',
        '右侧墙面潮湿。',
        'Okay, 好的.',
        'Thanks, la pared está mojada.',
    ],
)
def test_technician_facts_survive_cleaning(turn):
    data = scoped(
        technician_transcript=turn,
        assistant_transcript='Is it finished drywall? What water category for it, 1 or 2?',
    )
    assert technician_statement(data) == turn


def test_assistant_recap_of_a_technician_fact_keeps_the_technician_turn():
    data = scoped(
        technician_transcript='Welcome to the\nOne dehumidifier for three days.',
        assistant_transcript='Welcome to the walkthrough.\nOne dehumidifier for three days.',
    )
    assert technician_statement(data) == 'One dehumidifier for three days.'


def test_greeting_prefixed_technician_fact_is_kept():
    data = scoped(
        technician_transcript='Good morning, one dehumidifier for three days.',
        assistant_transcript='Good morning! One dehumidifier for three days. Which room?',
    )
    assert technician_statement(data) == 'Good morning, one dehumidifier for three days.'


def test_supporting_photos_are_cited_without_claiming_a_reading():
    ai = AIResult(summary='Reviewed', suggestions=[], unpriced_work=[])
    photos = [photo('a' * 32, 'Office'), photo('b' * 32, 'Office')]
    photos[1]['ocr_status'] = 'pending'
    docs = make_documents(acme(), photos, ai)
    cited = [
        'Photo 1 (Office) — supporting photo; no verified meter reading.',
        'Photo 2 (Office) — supporting photo; no verified meter reading.',
    ]
    assert [t for t in docs['adr_estimate']['findings'] if t.startswith('Photo ')] == cited
    assert all(text in docs['iicrc_defense_letter'] for text in cited)
    # Pending recognition still blocks signing; citing the photo does not verify it.
    assert [p['ocr_status'] for p in docs['photo_audit_log']] == ['no_meter', 'pending']
    assert not docs['signable']


def test_letterhead_heads_the_letter_with_one_separator_and_the_phone():
    ai = AIResult(summary='Reviewed', suggestions=[], unpriced_work=[])
    identity = dict(
        company_id='adr',
        version=1,
        name='Alert Disaster Restoration',
        address='3300 Patton Way · Bakersfield, CA 93308',
        phone='(661) 426-2151',
        email='',
        license='950983',
        signoff='Matthew Myers',
    )
    letter = make_documents(acme(), [], ai, identity)['iicrc_defense_letter']
    assert letter.startswith(
        'Alert Disaster Restoration · 3300 Patton Way · Bakersfield, CA 93308 · (661) 426-2151'
        ' · CSLB #950983\n\nTO: Insurance Claims Examiner / Adjuster\n\nRE: '
    )
    assert '•' not in letter
    other = dict(identity, name='Other Co', address='1 Main St •\n Fresno, CA', phone='')
    letter = make_documents(acme(), [], ai, other)['iicrc_defense_letter']
    assert letter.startswith('Other Co · 1 Main St · Fresno, CA · CSLB #950983\n\nTO: ')


ADVICE = 'This home was built in 1978. Lead and asbestos testing may be required before demolition.'
REPORTS = [
    'The homeowner supplied an asbestos report; cabinet removal remains conditional on its review.',
    'The homeowner supplied asbestos test results from 2020; the cabinet-removal plan needs review.',
]


@pytest.mark.parametrize('year', [1960, 1978])
def test_ai_testing_advice_follows_the_age_rule_and_text_uses_plain_terms(year):
    ai = AIResult(
        summary='Office has laminate and drywall removal. The JSON metadata lists no dehumidifier.',
        suggestions=[
            'The technician stated one dehumidifier for three days, whereas the JSON metadata'
            ' indicates 0 dehumidifiers and 1 air scrubber.',
            'Confirm laminate square footage; 10 linear feet is not an area.',
            *REPORTS,
        ],
        unpriced_work=['Office: one dehumidifier for three days is absent from priced_scope.'],
        testing_advice=[ADVICE],
    )
    docs = make_documents(acme(year_built=year), [], ai)
    assert docs['ai_suggestions'] == [
        'The technician stated one dehumidifier for three days, whereas the saved inspection'
        ' indicates 0 dehumidifiers and 1 air scrubber.',
        'Confirm laminate square footage; 10 linear feet is not an area.',
        *REPORTS,
    ] + ([ADVICE] if year < 1978 else [])
    assert docs['ai_summary'] == (
        'Office has laminate and drywall removal. The saved inspection lists no dehumidifier.'
    )
    shown = str(docs)
    assert ('testing may be required' in shown) == (year < 1978)
    assert docs['unpriced_work'] == [
        'Office: one dehumidifier for three days is absent from priced scope.'
    ]
    # The app's own age finding still prints, and unpriced work still blocks signing.
    assert docs['adr_estimate']['findings'][0].startswith(
        'Due to property age' if year < 1978 else 'The home was built in 1978.'
    )
    assert not docs['signable']


@pytest.mark.parametrize(
    'year, rule', [(1960, 'the app requires'), (1978, 'the app does not require')]
)
def test_audit_prompt_gives_the_model_the_app_age_rule(year, rule):
    prompt = audit_prompt(acme(year_built=year).model_dump(mode='json'), [], [])
    assert f'the home was built in {year}, so {rule} lead/asbestos testing' in prompt
