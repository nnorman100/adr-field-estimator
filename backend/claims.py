"""Priced scope and document construction, independent of model-supplied prices."""

import re
from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP
from zoneinfo import ZoneInfo

try:
    from .extras import wording
    from .contracts import InspectionData, AIResult, AuditDocuments
    from .sizing import equipment_sizing, letter_paragraph
except ImportError:
    from extras import wording
    from contracts import InspectionData, AIResult, AuditDocuments
    from sizing import equipment_sizing, letter_paragraph

CENT = Decimal('0.01')
# Category -> (unfinished key, finished key). The numbers live in each company's price book.
RATES = {
    1: ('demo_cat1_unfinished', 'demo_cat1_finished'),
    2: ('demo_cat2_unfinished', 'demo_cat2_finished'),
    3: ('demo_cat3_unfinished', 'demo_cat3_finished'),
}
BASELINE = [
    ('ADR-TRIP', 'Emergency call / trip charge', 'emergency_calls', 'EA', 'emergency_call'),
    ('ADR-MON', 'Equipment monitoring', 'monitoring_hours', 'HR', 'monitoring_hourly'),
    ('ADR-HAUL', 'Haul debris & disposal', 'haul_loads', 'load', 'haul_pickup_load'),
    ('ADR-SCRUB', 'Air scrubber daily rental', 'air_scrubbers', 'day', 'air_scrubber_daily'),
    ('ADR-HEPA', 'HEPA replacement filter', 'hepa_filters', 'EA', 'hepa_filter'),
]
OPTIONAL_CHARGES = [
    ('ADR-MATTERPORT', 'Matterport scan', 'matterport_scans', 'matterport_scan'),
    ('ADR-DUMP', 'Single-axle dump truck load', 'dump_truck_loads', 'dump_truck_load'),
    (
        'ADR-DECON',
        'Drying equipment decontamination',
        'equipment_decon',
        'equipment_decontamination',
    ),
    ('ADR-POWER', 'Power distribution', 'power_distribution', 'power_distribution'),
]
JOB_CODES = (
    {code for code, _, _, _, _ in BASELINE}
    | {'ADR-AFTER', 'ADR-EXTRA'}
    | {code for code, _, _, _ in OPTIONAL_CHARGES}
)
LABOR_MATERIAL_CODES = {'ADR-DEMO', 'ADR-LABOR'}
EQUIPMENT_CODES = {'ADR-FAN', 'ADR-DEHU', 'ADR-WOOD'}
SCOPE_EXCLUDED = {code for code, _, _, _, _ in BASELINE} | {'ADR-AFTER'}
PHOTO_LOCATION_PRIVACY = "Photos taken during the inspection are stamped with the location reported by the technician's phone, when the technician allows it, and that location is part of the photo log."
ADDRESS_LOCATION_PRIVACY = 'When the job address is entered, the typed address is sent to Google Maps to suggest matching addresses, and the selected location is saved with the job.'
PRETEST = '(this does not include the pretest for lead/asbestos)'
# Standard estimate wording; {company} is the issuing company's name.
TESTING = "Testing is required under California State Law due to the home's construction year. A third-party company will conduct lead and asbestos testing to determine their presence. If the results are negative, remediation can proceed as outlined below. However, if lead or asbestos is detected, we will discuss the necessary abatement steps with the homeowner, and a price adjustment will be made accordingly."
PROTECTION = 'Per IICRC and EPA protocols, {company} technicians will don appropriate personal protective equipment during mitigation/remediation services. The technicians will set containments as needed.'
ADDITIONAL = 'If technicians encounter additional affected building materials beyond the quantities previously described, the project manager will contact the property owner to discuss any additional course of action necessary and the associated cost.'
EXCLUSIONS = 'NOTE: This estimate does NOT include reconstruction after remediation. Demolition is a highly unpredictable procedure. As such, any collateral damage resulting from the demolition prescribed herein will NOT be the responsibility of {company}. This estimate does not include testing of any kind.'
REPRICE = 'If the work proceeds through an insurance claim, we will reprice the estimate according to industry standards using Xactimate.'
VALIDITY = 'Estimate is valid for 30 days from date of inspection.'
# Walkthrough sentences made only of these complete phrases are conversation, not technician evidence.
CHATTER_PHRASE = (
    r'(ok|okay|alright|all right|um|uh|hmm|cool|great|perfect|got it|sounds good|thanks'
    r'|thank you( very much)?|hello|hi|hey|bye|goodbye|good (morning|afternoon|evening)'
    r'|welcome to the( walkthrough)?|(but )?you get it)'
)
CHATTER = re.compile(
    rf'{CHATTER_PHRASE}( {CHATTER_PHRASE})*'
    r'|(can|could|may|should) (i|we) (add|take|attach|send|upload) (a |an |another |the |this |more )?'
    r'(picture|photo|image)s?|can you hear me|are you (there|listening)|did you (get|catch) (that|it)'
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


def price_scope(data: InspectionData, rates):
    """Price saved quantities from the job's saved rates. There is no default price book."""
    if not rates:
        raise ValueError('Company prices are required to price this job.')
    book = rates
    items = [
        line(code, text, getattr(data, field), unit, book[key])
        for code, text, field, unit, key in BASELINE
        if getattr(data, field)
    ]
    if data.is_after_hours:
        items.append(
            line('ADR-AFTER', 'After-hours job charge', 1, 'EA', book['after_hours_job_charge'])
        )
    for code, description, field, key in OPTIONAL_CHARGES:
        quantity = getattr(data, field)
        if quantity:
            items.append(line(code, description, quantity, 'EA', book[key]))
    for room in data.rooms:
        keys = RATES[room.category]
        for qty, key, finish in [
            (room.unfinished_sf, keys[0], 'unfinished/subfloor'),
            (room.finished_sf, keys[1], 'finished/drywall/trim'),
        ]:
            if qty:
                price = Decimal(book[key]) * (
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
                book['air_mover_daily'],
            )
        )
    if data.dehumidifiers:
        items.append(
            line(
                'ADR-DEHU',
                'Commercial LGR dehumidifiers',
                data.dehumidifiers * data.drying_days,
                'unit-day',
                book['dehumidifier_daily'],
            )
        )
    if data.wood_floor_systems:
        items.append(
            line(
                'ADR-WOOD',
                'Wood-floor drying system / heater',
                data.wood_floor_systems * data.wood_floor_days,
                'unit-day',
                book['wood_floor_daily'],
            )
        )
    if data.labor_hours:
        items.append(
            line(
                'ADR-LABOR',
                'Content manipulation / additional labor',
                data.labor_hours,
                'HR',
                book['sheet_labor_hourly'],
            )
        )
    for extra in data.extras:
        if extra.approval:
            items.append(
                line('ADR-EXTRA', extra.description, extra.hours, 'HR', extra.approval.rate)
            )
    return items, float(sum((amount(i['total']) for i in items), Decimal(0)))


def standard_job_charges(rates):
    """The five baseline charges at the form's default quantities, in the company's prices."""
    return sum(
        (
            amount(
                line(code, text, InspectionData.model_fields[field].default, unit, rates[key])[
                    'total'
                ]
            )
            for code, text, field, unit, key in BASELINE
        ),
        Decimal(0),
    )


def proposal_range(data: InspectionData, items):
    """The estimating sheet's low/high labor-material allowances over priced scope."""
    unbucketed = (
        {item['code'] for item in items} - JOB_CODES - LABOR_MATERIAL_CODES - EQUIPMENT_CODES
    )
    if unbucketed:
        # A priced code outside every bucket would count in the itemized total but vanish from the range.
        raise RuntimeError(f'Priced codes missing from the estimate range: {sorted(unbucketed)}')
    # Approved extras are added at exactly the amount the owner approved, like job charges.
    job = sum((amount(item['total']) for item in items if item['code'] in JOB_CODES), Decimal(0))
    labor_material = sum(
        (amount(item['total']) for item in items if item['code'] in LABOR_MATERIAL_CODES),
        Decimal(0),
    )
    equipment = sum(
        (amount(item['total']) for item in items if item['code'] in EQUIPMENT_CODES),
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
    return re.findall(r"[\w']+", text.casefold())


def sentences(text):
    return [part for part in re.split(r'(?<=[.?!])\s+', text.strip()) if part]


def technician_statement(data: InspectionData):
    """The walkthrough transcript without greetings or conversational filler."""
    # A microphone that hears the phone speaker records the assistant's greeting as a technician turn.
    kept = []
    for turn in data.technician_transcript.splitlines():
        text = ' '.join(
            sentence
            for sentence in sentences(turn)
            if not CHATTER.fullmatch(' '.join(words(sentence)))
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
    """The AI summary in plain words."""
    lines = (' '.join(plain(text) for text in sentences(line)) for line in summary.splitlines())
    return '\n'.join(line for line in lines if line)


def claim_reference(claim):
    """The recorded claim reference lines, in document order; unrecorded fields are omitted."""
    loss = claim.get('date_of_loss', '')
    if loss:
        loss = datetime.strptime(loss, '%Y-%m-%d').strftime('%m-%d-%Y')
    return [
        f'{label}: {value}'
        for label, value in [
            ('Claim number', claim.get('claim_number', '')),
            ('Policy number', claim.get('policy_number', '')),
            ('Date of loss', loss),
            ('Cause and source of loss', claim.get('loss_cause', '')),
            ('Deductible', claim.get('deductible', '')),
        ]
        if value
    ]


def addressee(claim):
    """The letter's TO block: the recorded adjuster and carrier, or the generic examiner."""
    name, carrier = claim.get('adjuster_name', ''), claim.get('carrier', '')
    contact = ' · '.join(
        value
        for value in (claim.get('adjuster_email', ''), claim.get('adjuster_phone', ''))
        if value
    )
    return '\n'.join(
        value
        for value in (
            'TO: ' + (f'{name}, Adjuster' if name else 'Insurance Claims Examiner / Adjuster'),
            carrier,
            contact,
        )
        if value
    )


def make_documents(
    data: InspectionData,
    photos,
    ai: AIResult,
    identity=None,
    customer_name='',
    claim=None,
    rates=None,
    price_basis=None,
):
    # Company details come only from the issuing company's profile; empty fields print nothing.
    company = identity or {}
    company_name = company.get('name', '')
    company_address = company.get('address', '')
    company_license = company.get('license', '')
    company_phone = company.get('phone', '')
    signoff = company.get('signoff', '')
    # Standard clauses keep their meaning when no company name was supplied.
    clause_company = company_name.strip() or 'the contractor'
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
    items, total = price_scope(data, rates)
    approved = [extra for extra in data.extras if extra.approval]
    for item, extra in zip((i for i in items if i['code'] == 'ADR-EXTRA'), approved):
        item['description'] = wording(extra, clause_company)
    covered = {extra.description for extra in approved}
    unpriced = [text for text in ai.unpriced_work if plain(text) not in covered]
    pending = sum(extra.approval is None for extra in data.extras)
    estimate_low, estimate_high = proposal_range(data, items)
    if total <= 0:
        raise ValueError(
            'The priced scope totals $0.00. Enter at least one quantity or room measurement before auditing.'
        )
    before = data.year_built < 1978
    age = (
        f'Due to property age ({data.year_built}), California State Law requires third-party lead and asbestos testing prior to destructive demolition.'
        if before
        else f'The home was built in {data.year_built}. Therefore, no lead or asbestos testing is required prior to the start of work.'
    )
    clauses = ([PRETEST] if before else []) + [
        EXCLUSIONS.format(company=clause_company),
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
        + [PROTECTION.format(company=clause_company)]
        + [i['description'] for i in items if i['code'] not in SCOPE_EXCLUDED]
        + [ADDITIONAL]
    )
    customer = customer_name.strip()
    letterhead = ' · '.join(
        ' '.join(part.replace('•', '·').split())
        for part in (
            company_name,
            company_address,
            company_phone,
            f'CSLB #{company_license}' if company_license.strip() else '',
        )
        if part.strip()
    )
    # The sizing check is printed only when every water room has its confirmed inputs.
    sizing = letter_paragraph(equipment_sizing(data))
    letter = '\n\n'.join(
        ([letterhead] if letterhead else [])
        + [
            addressee(claim or {}),
            '\n'.join(
                [f'RE: Remediation scope for {data.address}']
                + ([f'Customer: {customer}'] if customer else [])
                + claim_reference(claim or {})
            ),
            'This scope describes proposed work; completion has not been recorded.',
            'The scope is prepared with reference to IICRC S500/S520 restoration practices. Project-specific conditions and evidence are recorded below; no unsupported section citation or completion claim is made.',
            '\n'.join(observations),
        ]
        + ([sizing] if sizing else [])
        + [
            'Scope:\n' + '\n'.join(recommendations),
            '\n'.join(clauses),
            f'Itemized charges at base rates: ${total:,.2f}. Customer estimate range: ${estimate_low:,.2f} to ${estimate_high:,.2f}. The range applies the estimating sheet labor/material allowance to the priced scope'
            + (
                '; approved additional work is added at its approved amount to both ends.'
                if any(item['code'] == 'ADR-EXTRA' for item in items)
                else '.'
            ),
            '\n'.join(line for line in ('Sincerely,', signoff, company_name) if line.strip()),
        ]
    )
    has_work = (
        any(r.unfinished_sf or r.finished_sf for r in data.rooms)
        or data.air_movers
        or data.dehumidifiers
        or data.wood_floor_systems
        or data.labor_hours
        or approved
        or any(getattr(data, field) for _, _, field, _ in OPTIONAL_CHARGES)
    )
    documents = AuditDocuments(
        company_identity=identity,
        company_setup_missing=setup,
        claim=claim,
        adr_estimate=dict(
            property_address=data.address,
            customer_name=customer,
            date=proposal_date(),
            proposed_cost=float(estimate_high),
            proposed_cost_low=float(estimate_low),
            lead_notice_required=before,
            findings=observations,
            recommendations=recommendations,
            disclaimers=[PHOTO_LOCATION_PRIVACY, ADDRESS_LOCATION_PRIVACY] + clauses,
        ),
        xactimate_scope=items,
        xactimate_total=total,
        iicrc_defense_letter=letter,
        compliance_notes=[age] + clauses,
        photo_audit_log=[
            {
                k: p.get(k)
                for k in (
                    'id',
                    'room',
                    'captured_at',
                    'width',
                    'height',
                    'ocr_status',
                    'ocr',
                    'location',
                )
            }
            for p in photos
        ],
        ai_summary=customer_text(ai.summary),
        ai_suggestions=[
            plain(text) for text in ai.suggestions + (ai.testing_advice if before else [])
        ],
        unpriced_work=[plain(text) for text in unpriced],
        pending_extras=pending,
        price_basis=price_basis,
        signable=bool(
            not setup
            and data.scope_confirmed
            and has_work
            and not unpriced
            and not pending
            and not any(p.get('ocr_status') == 'pending' for p in photos)
        ),
    )
    return documents.model_dump(mode='json', exclude_none=True)
