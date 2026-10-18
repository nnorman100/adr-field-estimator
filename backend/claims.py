"""ADR rate book and document construction, independent of model-supplied prices."""

import re
from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP
from zoneinfo import ZoneInfo

try:
    from .contracts import InspectionData, AIResult, AuditDocuments
except ImportError:
    from contracts import InspectionData, AIResult, AuditDocuments

CENT = Decimal('0.01')
RATES = {1: ('1.21', '2.78'), 2: ('1.52', '2.89'), 3: ('2.48', '8.39')}
BASELINE = [
    ('ADR-TRIP', 'Emergency call / trip charge', 'emergency_calls', 'EA', '133.95'),
    ('ADR-MON', 'Equipment monitoring', 'monitoring_hours', 'HR', '47.46'),
    ('ADR-HAUL', 'Haul debris & disposal', 'haul_loads', 'load', '159.53'),
    ('ADR-SCRUB', 'Air scrubber daily rental', 'air_scrubbers', 'day', '74.75'),
    ('ADR-HEPA', 'HEPA replacement filter', 'hepa_filters', 'EA', '183.12'),
]
AFTER_HOURS_CHARGE = '200.00'
OPTIONAL_CHARGES = [
    ('ADR-MATTERPORT', 'Matterport scan', 'matterport_scans', '250.00'),
    ('ADR-DUMP', 'Single-axle dump truck load', 'dump_truck_loads', '286.78'),
    ('ADR-DECON', 'Drying equipment decontamination', 'equipment_decon', '27.72'),
    ('ADR-POWER', 'Power distribution', 'power_distribution', '66.74'),
]
JOB_CODES = (
    {code for code, _, _, _, _ in BASELINE}
    | {'ADR-AFTER'}
    | {code for code, _, _, _ in OPTIONAL_CHARGES}
)
SCOPE_EXCLUDED = {code for code, _, _, _, _ in BASELINE} | {'ADR-AFTER'}
PRETEST = '(this does not include the pretest for lead/asbestos)'
# Standard estimate wording; {company} is the issuing company's name.
TESTING = "Testing is required under California State Law due to the home's construction year. A third-party company will conduct lead and asbestos testing to determine their presence. If the results are negative, remediation can proceed as outlined below. However, if lead or asbestos is detected, we will discuss the necessary abatement steps with the homeowner, and a price adjustment will be made accordingly."
PROTECTION = 'Per IICRC and EPA protocols, {company} technicians will don appropriate personal protective equipment during mitigation/remediation services. The technicians will set containments as needed.'
ADDITIONAL = 'If technicians encounter additional affected building materials beyond the quantities previously described, the project manager will contact the property owner to discuss any additional course of action necessary and the associated cost.'
EXCLUSIONS = 'NOTE: This estimate does NOT include reconstruction after remediation. Demolition is a highly unpredictable procedure. As such, any collateral damage resulting from the demolition prescribed herein will NOT be the responsibility of {company}. This estimate does not include testing of any kind.'
REPRICE = 'If the work proceeds through an insurance claim, we will reprice the estimate according to industry standards using Xactimate.'
VALIDITY = 'Estimate is valid for 30 days from date of inspection.'
# Walkthrough sentences made only of these words are conversation, not technician evidence.
FILLER_WORDS = set(
    'ok okay alright all right thanks thank you very much so um uh hmm got it but get cool great'
    ' perfect hello hi hey bye goodbye sounds good'.split()
)
APP_QUESTION = re.compile(
    r'(can|could|may|should) (i|we) (add|take|attach|send|upload) (a |an |another |the |this |more )?'
    r'(picture|photo|image)s?|can you hear me|are you (there|listening)|did you (get|catch) (that|it)'
)
# The age finding is the app's lead/asbestos rule, so AI text may not restate or contradict it.
TESTING_TOPIC = re.compile(
    r'asbestos|\blead\b[\s/-]*(and\b|or\b|&)?[\s/-]*(based|paint|test|pre-?test|abatement|hazard|exposure)',
    re.IGNORECASE,
)
JSON_TERM = re.compile(
    r'\b(the\s+)?(inspection\s+)?JSON(\s+(metadata|data|payload|record|evidence|input|object))?\b',
    re.IGNORECASE,
)
FIELD_NAME = re.compile(r'\b[a-z]+(?:_[a-z]+)+\b')


def amount(value):
    return Decimal(str(value)).quantize(CENT, rounding=ROUND_HALF_UP)


def line(code, description, quantity, unit, rate, waste=0):
    qty, price, factor = Decimal(str(quantity)), Decimal(str(rate)), Decimal(str(waste))
    total = (qty * price * (1 + factor / 100)).quantize(CENT, rounding=ROUND_HALF_UP)
    return dict(
        code=code,
        description=description,
        quantity=float(qty),
        unit=unit,
        unit_price=float(price),
        waste_percent=float(factor),
        total=float(total),
    )


def price_scope(data: InspectionData):
    items = [
        line(code, text, getattr(data, field), unit, rate)
        for code, text, field, unit, rate in BASELINE
        if getattr(data, field)
    ]
    if data.is_after_hours:
        items.append(line('ADR-AFTER', 'After-hours job charge', 1, 'EA', AFTER_HOURS_CHARGE))
    for code, description, field, rate in OPTIONAL_CHARGES:
        quantity = getattr(data, field)
        if quantity:
            items.append(line(code, description, quantity, 'EA', rate))
    for room in data.rooms:
        rates = RATES[room.category]
        for qty, rate, finish in [
            (room.unfinished_sf, rates[0], 'unfinished/subfloor'),
            (room.finished_sf, rates[1], 'finished/drywall/trim'),
        ]:
            if qty:
                price = Decimal(rate) * (
                    2
                    if finish.startswith('finished')
                    and room.category == 3
                    and room.custom_cabinetry
                    else 1
                )
                items.append(
                    line(
                        'ADR-DEMO',
                        f'{room.name}: category {room.category} {finish} demolition',
                        qty,
                        'SF',
                        price,
                        room.waste_percent,
                    )
                )
    if data.air_movers:
        items.append(
            line(
                'ADR-FAN',
                'Axial air movers',
                data.air_movers * data.drying_days,
                'unit-day',
                '29.25',
            )
        )
    if data.dehumidifiers:
        items.append(
            line(
                'ADR-DEHU',
                'Commercial LGR dehumidifiers',
                data.dehumidifiers * data.drying_days,
                'unit-day',
                '101.25',
            )
        )
    if data.wood_floor_systems:
        items.append(
            line(
                'ADR-WOOD',
                'Wood-floor drying system / heater',
                data.wood_floor_systems * data.wood_floor_days,
                'unit-day',
                '180.00',
            )
        )
    if data.labor_hours:
        items.append(
            line(
                'ADR-LABOR',
                'Content manipulation / additional labor',
                data.labor_hours,
                'HR',
                '47.46',
            )
        )
    return items, float(sum((amount(i['total']) for i in items), Decimal(0)))


def proposal_range(data: InspectionData, items):
    """The estimating sheet's low/high labor-material allowances over priced scope."""
    job = sum((amount(item['total']) for item in items if item['code'] in JOB_CODES), Decimal(0))
    labor_material = sum(
        (amount(item['total']) for item in items if item['code'] in {'ADR-DEMO', 'ADR-LABOR'}),
        Decimal(0),
    )
    equipment = sum(
        (
            amount(item['total'])
            for item in items
            if item['code'] in {'ADR-FAN', 'ADR-DEHU', 'ADR-WOOD'}
        ),
        Decimal(0),
    )
    affected_sf = sum(
        (Decimal(str(room.unfinished_sf)) + Decimal(str(room.finished_sf)) for room in data.rooms),
        Decimal(0),
    )
    low_labor = labor_material * (Decimal('1.2') if data.is_after_hours else Decimal(1))
    high_labor = low_labor * (Decimal('1.5') if affected_sf < 1001 else Decimal('1.2'))
    return amount(job + equipment + low_labor), amount(job + equipment + high_labor)


def proposal_date():
    return datetime.now(ZoneInfo('America/Los_Angeles')).strftime('%m-%d-%Y')


def words(text):
    return re.findall(r"[a-z0-9']+", text.lower())


def sentences(text):
    return [part for part in re.split(r'(?<=[.?!])\s+', text.strip()) if part]


def technician_statement(data: InspectionData):
    """The walkthrough transcript without speaker echo of the assistant or conversational filler."""
    # A microphone that hears the phone speaker records the assistant's words as technician turns.
    spoken = [' ' + ' '.join(words(turn)) + ' ' for turn in data.assistant_transcript.splitlines()]
    kept = []
    for turn in data.technician_transcript.splitlines():
        heard = words(turn)
        if (
            len(heard) >= 3
            and not any(char.isdigit() for char in turn)
            and any(' ' + ' '.join(heard) + ' ' in text for text in spoken)
        ):
            continue
        text = ' '.join(
            sentence
            for sentence in sentences(turn)
            if not set(words(sentence)) <= FILLER_WORDS
            and not APP_QUESTION.fullmatch(' '.join(words(sentence)))
        )
        if text:
            kept.append(text)
    return '\n'.join(kept)


def plain(text):
    """Model text in customer words: no data-format or field names from the audit prompt."""
    text = JSON_TERM.sub(
        lambda m: (
            'The saved inspection'
            if m.group()[0].isupper() and m.start() == 0
            else 'the saved inspection'
        ),
        text,
    )
    text = re.sub(r'\bmetadata\b', 'record', text, flags=re.IGNORECASE)
    return FIELD_NAME.sub(lambda m: m.group().replace('_', ' '), text)


def customer_text(summary):
    """The AI summary in plain words, without sentences about the app's testing rule."""
    lines = (
        ' '.join(plain(text) for text in sentences(line) if not TESTING_TOPIC.search(text))
        for line in summary.splitlines()
    )
    return '\n'.join(line for line in lines if line)


def make_documents(data: InspectionData, photos, ai: AIResult, identity=None, customer_name=''):
    company_name = identity['name'] if identity else 'Alert Disaster Restoration'
    company_address = identity['address'] if identity else 'Bakersfield, CA'
    company_license = identity['license'] if identity else '950983'
    company_phone = identity.get('phone', '') if identity else ''
    signoff = identity['signoff'] if identity else 'Matthew Myers'
    setup = []
    if identity:
        setup = [
            label
            for key, label in [
                ('name', 'Company name'),
                ('address', 'Company address'),
                ('license', 'CSLB license'),
                ('signoff', 'Document sign-off'),
            ]
            if not identity.get(key, '').strip()
        ]

    if not data.address.strip() or data.year_built is None or not data.rooms:
        raise ValueError('Enter the address, year built and rooms before auditing.')
    if data.package_price is not None:
        raise ValueError('Update the app and clear the old package-tier selection before auditing.')
    items, total = price_scope(data)
    estimate_low, estimate_high = proposal_range(data, items)
    before = data.year_built < 1978
    age = (
        f'Due to property age ({data.year_built}), California State Law requires third-party lead and asbestos testing prior to destructive demolition.'
        if before
        else f'The home was built in {data.year_built}. Therefore, no lead or asbestos testing is required prior to the start of work.'
    )
    clauses = ([PRETEST] if before else []) + [
        EXCLUSIONS.format(company=company_name),
        REPRICE,
        VALIDITY,
    ]
    observations = [age]
    if data.technician_notes.strip():
        observations.append('Technician observations: ' + data.technician_notes.strip())
    statement = technician_statement(data)
    if statement:
        observations.append('Technician walkthrough statement: ' + statement)
    # Photos are numbered in photo-log order, so an adjuster can match a finding to its picture.
    observations.extend(
        f'Photo {number} ({p["room"]}) — {p["ocr"]["meter_type"]}: {p["ocr"]["value"]}'
        if p.get('ocr_status') == 'verified'
        else f'Photo {number} ({p["room"]}) — supporting photo; no verified meter reading.'
        for number, p in enumerate(photos, 1)
    )
    recommendations = (
        ([TESTING] if before else [])
        + [PROTECTION.format(company=company_name)]
        + [i['description'] for i in items if i['code'] not in SCOPE_EXCLUDED]
        + [ADDITIONAL]
    )
    customer = customer_name.strip()
    letterhead = ' · '.join(
        ' '.join(part.replace('•', '·').split())
        for part in (company_name, company_address, company_phone, f'CSLB #{company_license}')
        if part.strip()
    )
    letter = '\n\n'.join(
        [
            letterhead,
            'TO: Insurance Claims Examiner / Adjuster',
            f'RE: Remediation scope for {data.address}'
            + (f'\nCustomer: {customer}' if customer else ''),
            'This scope describes proposed work; completion has not been recorded.',
            'The scope is prepared with reference to IICRC S500/S520 restoration practices. Project-specific conditions and evidence are recorded below; no unsupported section citation or completion claim is made.',
            '\n'.join(observations),
            'Scope:\n' + '\n'.join(recommendations),
            '\n'.join(clauses),
            f'Itemized charges at base rates: ${total:,.2f}. Customer estimate range: ${estimate_low:,.2f} to ${estimate_high:,.2f}. The range applies the estimating sheet labor/material allowance to the priced scope.',
            f'Sincerely,\n{signoff}\n{company_name}',
        ]
    )
    has_work = (
        any(r.unfinished_sf or r.finished_sf for r in data.rooms)
        or data.air_movers
        or data.dehumidifiers
        or data.wood_floor_systems
        or data.labor_hours
        or any(getattr(data, field) for _, _, field, _ in OPTIONAL_CHARGES)
    )
    documents = AuditDocuments(
        company_identity=identity,
        company_setup_missing=setup,
        adr_estimate=dict(
            property_address=data.address,
            customer_name=customer,
            date=proposal_date(),
            proposed_cost=float(estimate_high),
            proposed_cost_low=float(estimate_low),
            lead_notice_required=before,
            findings=observations,
            recommendations=recommendations,
            disclaimers=clauses,
        ),
        xactimate_scope=items,
        xactimate_total=total,
        iicrc_defense_letter=letter,
        compliance_notes=[age] + clauses,
        photo_audit_log=[
            {
                k: p.get(k)
                for k in ('id', 'room', 'captured_at', 'width', 'height', 'ocr_status', 'ocr')
            }
            for p in photos
        ],
        ai_summary=customer_text(ai.summary),
        ai_suggestions=[plain(text) for text in ai.suggestions if not TESTING_TOPIC.search(text)],
        unpriced_work=[plain(text) for text in ai.unpriced_work],
        signable=bool(
            not setup
            and data.scope_confirmed
            and has_work
            and not ai.unpriced_work
            and not any(p.get('ocr_status') == 'pending' for p in photos)
        ),
    )
    return documents.model_dump(mode='json', exclude_none=True)
