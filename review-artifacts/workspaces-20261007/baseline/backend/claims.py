"""ADR rate book and document construction, independent of model-supplied prices."""
from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP
from zoneinfo import ZoneInfo
try:
    from .contracts import InspectionData, AIResult, AuditDocuments
except ImportError:
    from contracts import InspectionData, AIResult, AuditDocuments

CENT = Decimal('0.01')
RATES = {1: ('1.21','2.78'), 2: ('1.52','2.89'), 3: ('2.48','8.39')}
BASELINE = [('ADR-TRIP','Emergency call / trip charge','emergency_calls','EA','133.95'),
            ('ADR-MON','Equipment monitoring','monitoring_hours','HR','47.46'),
            ('ADR-HAUL','Haul debris & disposal','haul_loads','load','159.53'),
            ('ADR-SCRUB','Air scrubber daily rental','air_scrubbers','day','74.75'),
            ('ADR-HEPA','HEPA replacement filter','hepa_filters','EA','183.12')]
AFTER_HOURS_CHARGE = '200.00'
OPTIONAL_CHARGES = [('ADR-MATTERPORT', 'Matterport scan', 'matterport_scans', '250.00'),
                    ('ADR-DUMP', 'Single-axle dump truck load', 'dump_truck_loads', '286.78'),
                    ('ADR-DECON', 'Drying equipment decontamination', 'equipment_decon', '27.72'),
                    ('ADR-POWER', 'Power distribution', 'power_distribution', '66.74')]
JOB_CODES = {code for code, _, _, _, _ in BASELINE} | {'ADR-AFTER'} | {code for code, _, _, _ in OPTIONAL_CHARGES}
SCOPE_EXCLUDED = {code for code, _, _, _, _ in BASELINE} | {'ADR-AFTER'}
GRANITE = 'The technician will prop the granite countertop as the cabinets are removed. The granite and backsplash can break during the removal process.'
HEATER = 'Alert Disaster will coordinate with Can Do Crew to put the water heater in a temporary state... Homeowner to hire competent professional to reset.'
PRETEST = '(this does not include the pretest for lead/asbestos)'

def amount(value):
    return Decimal(str(value)).quantize(CENT, rounding=ROUND_HALF_UP)

def line(code, description, quantity, unit, rate, waste=0):
    qty, price, factor = Decimal(str(quantity)), Decimal(str(rate)), Decimal(str(waste))
    total = (qty * price * (1 + factor / 100)).quantize(CENT, rounding=ROUND_HALF_UP)
    return dict(code=code, description=description, quantity=float(qty), unit=unit,
                unit_price=float(price), waste_percent=float(factor), total=float(total))

def price_scope(data: InspectionData):
    items = [line(code, text, getattr(data, field), unit, rate)
             for code, text, field, unit, rate in BASELINE if getattr(data, field)]
    if data.is_after_hours:
        items.append(line('ADR-AFTER', 'After-hours job charge', 1, 'EA', AFTER_HOURS_CHARGE))
    for code, description, field, rate in OPTIONAL_CHARGES:
        quantity = getattr(data, field)
        if quantity:
            items.append(line(code, description, quantity, 'EA', rate))
    for room in data.rooms:
        rates = RATES[room.category]
        for qty, rate, finish in [(room.unfinished_sf, rates[0], 'unfinished/subfloor'),
                                  (room.finished_sf, rates[1], 'finished/drywall/trim')]:
            if qty:
                price = Decimal(rate) * (2 if finish.startswith('finished') and room.category == 3 and room.custom_cabinetry else 1)
                items.append(line('ADR-DEMO', f'{room.name}: category {room.category} {finish} demolition', qty, 'SF', price, room.waste_percent))
    if data.air_movers:
        items.append(line('ADR-FAN', 'Axial air movers', data.air_movers * data.drying_days, 'unit-day', '29.25'))
    if data.dehumidifiers:
        items.append(line('ADR-DEHU', 'Commercial LGR dehumidifiers', data.dehumidifiers * data.drying_days, 'unit-day', '101.25'))
    if data.wood_floor_systems:
        items.append(line('ADR-WOOD', 'Wood-floor drying system / heater', data.wood_floor_systems * data.wood_floor_days, 'unit-day', '180.00'))
    if data.labor_hours:
        items.append(line('ADR-LABOR', 'Content manipulation / additional labor', data.labor_hours, 'HR', '47.46'))
    return items, float(sum((amount(i['total']) for i in items), Decimal(0)))

def proposal_range(data: InspectionData, items):
    """The estimating sheet's low/high labor-material allowances over priced scope."""
    job = sum((amount(item['total']) for item in items if item['code'] in JOB_CODES), Decimal(0))
    labor_material = sum((amount(item['total']) for item in items if item['code'] in {'ADR-DEMO', 'ADR-LABOR'}), Decimal(0))
    equipment = sum((amount(item['total']) for item in items if item['code'] in {'ADR-FAN', 'ADR-DEHU', 'ADR-WOOD'}), Decimal(0))
    affected_sf = sum((Decimal(str(room.unfinished_sf)) + Decimal(str(room.finished_sf)) for room in data.rooms), Decimal(0))
    low_labor = labor_material * (Decimal('1.2') if data.is_after_hours else Decimal(1))
    high_labor = low_labor * (Decimal('1.5') if affected_sf < 1001 else Decimal('1.2'))
    return amount(job + equipment + low_labor), amount(job + equipment + high_labor)

def make_documents(data: InspectionData, photos, ai: AIResult):
    if not data.address.strip() or data.year_built is None or not data.rooms:
        raise ValueError('Enter the address, year built and rooms before auditing.')
    if data.package_price is not None:
        raise ValueError('Update the app and clear the old package-tier selection before auditing.')
    items, total = price_scope(data)
    estimate_low, estimate_high = proposal_range(data, items)
    before = data.year_built < 1978
    age = (f'Due to property age ({data.year_built}), California State Law requires third-party lead and asbestos testing prior to destructive demolition.'
           if before else f'The home was built in {data.year_built}. No pre-testing is required under the configured ADR property-age rule.')
    clauses = ([PRETEST] if before else []) + ([GRANITE] if data.granite_removal else []) + ([HEATER] if data.water_heater_loss else [])
    if data.has_crawl_space:
        clauses.append('There is a crawl space')
    observations = [age]
    if data.technician_notes.strip(): observations.append('Technician observations: ' + data.technician_notes.strip())
    if data.technician_transcript.strip(): observations.append('Technician transcript: ' + data.technician_transcript.strip())
    verified = [p for p in photos if p.get('ocr_status') == 'verified']
    observations.extend(f"{p['room']} — {p['ocr']['meter_type']}: {p['ocr']['value']} (photo {p['id']})" for p in verified)
    recommendations = [i['description'] for i in items if i['code'] not in SCOPE_EXCLUDED]
    status = 'Technician reports this work was performed.' if data.work_performed else 'This scope describes proposed work; completion has not been recorded.'
    letter = '\n\n'.join([
        'TO: Insurance Claims Examiner / Adjuster', f'RE: Remediation scope for {data.address}',
        'Alert Disaster Restoration • Bakersfield, CA • CSLB #950983', status,
        'The scope is prepared with reference to IICRC S500/S520 restoration practices. Project-specific conditions and evidence are recorded below; no unsupported section citation or completion claim is made.',
        '\n'.join(observations), 'Scope:\n' + '\n'.join(recommendations), '\n'.join(clauses),
        f'Itemized charges at base rates: ${total:,.2f}. Customer estimate range: ${estimate_low:,.2f} to ${estimate_high:,.2f}. The range applies the estimating sheet labor/material allowance to the priced scope.',
        'Sincerely,\nMatthew Myers\nAlert Disaster Restoration'])
    has_work = (any(r.unfinished_sf or r.finished_sf for r in data.rooms) or data.air_movers or data.dehumidifiers
                or data.wood_floor_systems or data.labor_hours or any(getattr(data, field) for _, _, field, _ in OPTIONAL_CHARGES))
    documents = AuditDocuments(
        adr_estimate=dict(property_address=data.address, date=datetime.now(ZoneInfo('America/Los_Angeles')).strftime('%m-%d-%Y'),
                          proposed_cost=float(estimate_high), proposed_cost_low=float(estimate_low), lead_notice_required=before,
                          findings=observations, recommendations=recommendations, disclaimers=clauses),
        xactimate_scope=items, xactimate_total=total, iicrc_defense_letter=letter,
        compliance_notes=[age] + clauses,
        photo_audit_log=[{k:p.get(k) for k in ('id','room','captured_at','width','height','ocr_status','ocr')} for p in photos],
        ai_summary=ai.summary, ai_suggestions=ai.suggestions, unpriced_work=ai.unpriced_work,
        signable=bool(data.scope_confirmed and has_work and not ai.unpriced_work and not any(p.get('ocr_status') == 'pending' for p in photos)))
    return documents.model_dump(mode='json')
