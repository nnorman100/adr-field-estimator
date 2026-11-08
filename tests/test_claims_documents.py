from decimal import Decimal
import logging
import pytest
from pydantic import ValidationError
from backend.claims import (
    proposal_range,
    technician_statement,
    ADDITIONAL,
    PRETEST,
    PHOTO_LOCATION_PRIVACY,
    ADDRESS_LOCATION_PRIVACY,
    REPRICE,
    TESTING,
    VALIDITY,
)
from tests.adr_pricing import make_documents, price_scope
from backend.contracts import InspectionData, AIResult
from backend import claims
from backend.claims import plain, states_price
from backend.prompts import audit_prompt
from tests.fakes import ADR_PROFILE
from tests.test_claims import scoped, photo, acme


# The engine is a separate unit: these tests give make_documents the spec's worked example D as
# the engine's answer, then check what the documents print and keep.

import json  # noqa: E402
from pathlib import Path  # noqa: E402
from backend import pricing  # noqa: E402
from backend.claims import EXCLUSIONS, PROTECTION  # noqa: E402
from backend import document_links, price_table  # noqa: E402
from backend.claims import end_summary  # noqa: E402
from backend.contracts import EstimateEnd  # noqa: E402
from backend.price_table import STARTER_ITEMS  # noqa: E402

V1_GOLDEN = Path(__file__).parent / 'golden' / 'v1-documents.json'
FIXED_DATE = '11-02-2026'


def v1_golden_documents(monkeypatch):
    monkeypatch.setattr('backend.claims.proposal_date', lambda: FIXED_DATE)
    values = dict(
        address='12 Test Lane',
        year_built=1960,
        is_after_hours=True,
        air_movers=3,
        dehumidifiers=1,
        labor_hours=2,
        technician_notes='Water under the sink.',
        scope_confirmed=True,
        rooms=[
            {'name': 'Kitchen', 'category': 3, 'finished_sf': 40, 'custom_cabinetry': True},
            {'name': 'Hall', 'category': 1, 'unfinished_sf': 80, 'waste_percent': 10},
        ],
        extras=[
            dict(
                id='e' * 32,
                description='Move and reset toilet',
                hours='2.5',
                origin='manual',
                unpriced_item='Move and reset toilet',
                approval=dict(
                    accepted_by_uid='owner',
                    accepted_by_name='Test Owner',
                    accepted_at='2026-10-25T12:00:00Z',
                    rate='47.46',
                    total='118.65',
                    company_id='adr',
                    company_version=1,
                ),
            )
        ],
    )
    ai = AIResult(summary='Reviewed', suggestions=['Check subfloor'], unpriced_work=[])
    return make_documents(
        InspectionData.model_validate(values),
        [photo('a' * 32, 'Kitchen', '31.4% WME')],
        ai,
        dict(
            company_id='adr',
            version=1,
            name='Test Co',
            address='Office',
            phone='555',
            email='',
            license='1',
            signoff='Estimator',
        ),
    )


def test_v1_documents_are_byte_identical(monkeypatch):
    docs = v1_golden_documents(monkeypatch)
    # Nothing added for company price tables leaks into a document priced on the v1 rate book.
    for key in ('estimate', 'quantity_notes'):
        assert key not in docs
    assert 'estimate_mode' not in docs['adr_estimate']
    for line in docs['xactimate_scope']:
        assert not V2_ONLY & set(line)
    assert json.dumps(docs, sort_keys=True, indent=2) == V1_GOLDEN.read_text().rstrip('\n')


V2_ONLY = {'item_id', 'group', 'bucket', 'taxable', 'xactimate_code', 'room'}


def d_line(code, item_id, group, bucket, description, quantity, unit, price, total, **more):
    return dict(
        code=code,
        item_id=item_id,
        group=group,
        bucket=bucket,
        description=description,
        quantity=quantity,
        unit=unit,
        unit_price=price,
        waste_percent=0.0,
        total=total,
        taxable=False,
        xactimate_code=None,
        room=None,
        area=None,
        **more,
    )


# Spec 3.13 example D: 300 sf category 3 wall demolition with cabinetry, after hours, 4 labor hours.
D_LINES = [
    d_line(
        'SVC', 'service_call', 'job_charges', 'fixed', 'Emergency service call', 1, 'each', 150, 150
    ),
    d_line(
        'MON',
        'monitoring_visit',
        'job_charges',
        'fixed',
        'Equipment monitoring',
        10,
        'hour',
        50,
        500,
    ),
    d_line(
        'HAUL',
        'debris_haul',
        'job_charges',
        'fixed',
        'Debris haul and disposal',
        1,
        'load',
        160,
        160,
    ),
    d_line(
        'AH',
        'after_hours_charge',
        'job_charges',
        'fixed',
        'After-hours response charge',
        1,
        'each',
        200,
        200,
    ),
    d_line(
        'DEMO3W',
        'demo_cat3_wall',
        'demolition',
        'labor_material',
        'Kitchen: Category 3 or mold drywall and trim removal',
        300,
        'sf',
        16,
        4800,
        **{},
    ),
    d_line(
        'ANTI',
        'antimicrobial',
        'treatment',
        'labor_material',
        'Kitchen: Antimicrobial application',
        300,
        'sf',
        0.5,
        150,
    ),
    d_line(
        'FAN', 'air_mover', 'drying_equipment', 'equipment', 'Air mover', 6, 'unit_day', 30, 180
    ),
    d_line(
        'DEHU',
        'lgr_dehumidifier',
        'drying_equipment',
        'equipment',
        'LGR dehumidifier',
        3,
        'unit_day',
        100,
        300,
    ),
    d_line(
        'LAB', 'technician_labor', 'labor', 'labor_material', 'Technician labor', 4, 'hour', 50, 200
    ),
]
D_LINES[4].update(room='Kitchen', area=300, xactimate_code='WTR DMO')
D_LINES[5].update(taxable=True, room='Kitchen', area=300)
D_LINES[6].update(taxable=True)
D_LINES[7].update(taxable=True)
D_LOW = dict(
    subtotal=6640, after_hours=1030, minimum_charge=0, overhead_profit=767, tax=52.80, total=8489.80
)
D_HIGH = dict(
    subtotal=9215,
    after_hours=1545,
    minimum_charge=0,
    overhead_profit=1076,
    tax=60.00,
    total=11896.00,
)
D_RANGE_SENTENCE = 'The high end allows 50% extra on the first 1,000 sq ft of work and 20% beyond, for hidden damage.'
D_EXPLANATION = (
    'The low amount is the itemized total. The high amount adds an allowance to labor and materials '
    'for conditions found during the work: 50% on the first 1000 square feet of area-priced work '
    '(highest-priced areas first), 20% on area beyond that, and 50% on labor hours.'
)
D_POLICY = {
    'estimate_mode': 'range',
    'area_basis': 'demolition',
    'range': {'first_sf': 1000, 'first_percent': '50', 'beyond_percent': '20'},
    'after_hours': {'multiplier': '1.200', 'label': 'After-hours adjustment'},
    'category_multipliers': {'1': '1.000', '2': '1.000', '3': '1.000'},
    'cabinetry': {'multiplier': '2.000', 'scope': 'finished_only'},
    'minimum_job_charge': '0',
    'overhead_profit_percent': '10',
    'sales_tax': {'enabled': True, 'percent': '8'},
    'show_line_breakdown': False,
}
D_PIN = {
    'calculation_version': 'dryscope-v2',
    'items': STARTER_ITEMS,
    'policy': D_POLICY,
}


def d_totals(mode='range', **more):
    totals = dict(
        mode=mode,
        low=dict(D_LOW),
        high=dict(D_HIGH) if mode == 'range' else None,
        labor_material_low=5150,
        labor_material_high=7725,
        explanation=D_EXPLANATION
        if mode == 'range'
        else 'The price covers the itemized scope below.',
        range_explanation=D_RANGE_SENTENCE if mode == 'range' else None,
    )
    totals.update(more)
    return totals


def v2_documents(monkeypatch, lines=None, totals=None, policy=None, data=None, price_basis=None):
    priced = pricing.PricedJob(
        lines=[dict(line) for line in (D_LINES if lines is None else lines)],
        totals=totals or d_totals(),
        calculation_version='dryscope-v2',
    )
    monkeypatch.setattr(pricing, 'price_and_range', lambda inspection, pin: priced)
    pin = dict(D_PIN, policy=policy or D_POLICY)
    ai = AIResult(summary='Reviewed', suggestions=[], unpriced_work=[])
    return make_documents(
        data or scoped(rooms=[{'name': 'Kitchen', 'category': 3, 'finished_sf': 300}]),
        [],
        ai,
        dict(
            company_id='c1',
            version=1,
            name='Test Co',
            address='Office',
            phone='',
            email='',
            license='1',
            signoff='Estimator',
        ),
        pin=pin,
        price_basis=price_basis,
    )


def real_engine_documents(**policy):
    """Documents from the real engine and a table normalized by the real publish rules."""
    table = price_table.starter_table()
    for item in table['items']:
        item.update(unit_price='10.00', taxable=True)
    table['policy'].update(
        after_hours=dict(table['policy']['after_hours'], multiplier='1.200'),
        overhead_profit_percent='10',
        sales_tax=dict(enabled=True, percent='8'),
        **policy,
    )
    table = price_table.normalize_table(table, publish=True)
    data = InspectionData.model_validate(
        dict(
            address='Synthetic',
            year_built=1990,
            rooms=[{'name': 'Kitchen', 'category': 3, 'finished_sf': 1200}],
            air_movers=3,
            dehumidifiers=1,
            labor_hours=4,
            is_after_hours=True,
            scope_confirmed=True,
        )
    )
    basis = dict(
        company_id='c1',
        version_id='v4',
        sequence=4,
        content_sha256='a' * 64,
        calculation_version='dryscope-v2',
        priced_at='2026-11-01T12:00:00Z',
        policy=table['policy'],
        item_count=len(table['items']),
    )
    return make_documents(
        data,
        [],
        AIResult(summary='Reviewed', suggestions=[], unpriced_work=[]),
        dict(
            company_id='c1',
            version=1,
            name='Test Co',
            address='Office',
            phone='',
            email='',
            license='1',
            signoff='Estimator',
        ),
        pin=dict(table, calculation_version='dryscope-v2'),
        price_basis=basis,
    )


def assert_adds_up(end):
    parts = ('subtotal', 'after_hours', 'minimum_charge', 'overhead_profit', 'tax')
    assert sum(end[part] for part in parts) == pytest.approx(end['total'])


def test_real_engine_range_documents_add_up_and_name_the_cushion_tiers():
    # The starter table now starts on the uncertainty method; this one chooses the cushion.
    docs = real_engine_documents(
        estimate_mode='range',
        assist=dict(price_table.starter_table()['policy']['assist'], range_method='cushion'),
    )
    estimate, proposal = docs['estimate'], docs['adr_estimate']
    assert_adds_up(estimate['low'])
    assert_adds_up(estimate['high'])
    assert estimate['high']['total'] > estimate['low']['total']
    assert proposal['proposed_cost_low'] == docs['xactimate_total'] == estimate['low']['total']
    assert proposal['proposed_cost'] == estimate['high']['total']
    assert proposal['estimate_mode'] == 'range'
    assert sum(line['total'] for line in docs['xactimate_scope']) == pytest.approx(
        estimate['low']['subtotal']
    )
    assert estimate['explanation'].startswith('The high end allows 50% extra on the first 1,000')
    assert estimate['explanation'] in docs['iicrc_defense_letter']
    assert 'Customer estimate range:' in docs['iicrc_defense_letter']
    assert estimate['low']['after_hours'] > 0 and estimate['low']['tax'] > 0
    assert docs['signable']
    for line in docs['xactimate_scope']:
        assert not {'item_id', 'group', 'bucket', 'taxable', 'room', 'area'} & set(line)


def test_real_engine_single_documents_add_up_and_omit_the_low():
    docs = real_engine_documents(estimate_mode='single')
    estimate, proposal = docs['estimate'], docs['adr_estimate']
    assert_adds_up(estimate['low'])
    assert 'high' not in estimate and 'proposed_cost_low' not in proposal
    assert proposal['proposed_cost'] == docs['xactimate_total'] == estimate['low']['total']
    assert estimate['explanation'] == 'The price covers the itemized scope below.'
    assert estimate['explanation'] not in docs['iicrc_defense_letter']
    assert docs['signable']


def test_real_engine_minimum_charge_reaches_the_printed_lines():
    docs = real_engine_documents(estimate_mode='single', minimum_job_charge='100000')
    low = docs['estimate']['low']
    assert low['minimum_charge'] > 0
    assert_adds_up(low)


def test_v2_documents_range_mode_print_summary_lines_and_explanation(monkeypatch):
    docs = v2_documents(monkeypatch)
    proposal, estimate = docs['adr_estimate'], docs['estimate']
    assert (proposal['proposed_cost_low'], proposal['proposed_cost']) == (8489.80, 11896.00)
    assert proposal['estimate_mode'] == 'range'
    assert docs['xactimate_total'] == 8489.80
    assert estimate['mode'] == 'range' and 'calculation_version' not in estimate
    assert estimate['low'] == dict(
        subtotal=6640,
        after_hours=1030,
        minimum_charge=0,
        overhead_profit=767,
        tax=52.80,
        total=8489.80,
    )
    assert estimate['high']['total'] == 11896.00 and estimate['high']['tax'] == 60.00
    assert (
        estimate['after_hours_label'],
        estimate['after_hours_percent'],
        estimate['overhead_profit_percent'],
        estimate['sales_tax_percent'],
    ) == ('After-hours adjustment', '20', '10', '8')
    for unused in ('labor_material_low', 'labor_material_high', 'minimum_job_charge', 'range_rule'):
        assert unused not in estimate
    assert estimate['explanation'] == D_RANGE_SENTENCE
    assert (
        'Itemized total: $8,489.80. Customer estimate range: $8,489.80 to $11,896.00. '
        + D_RANGE_SENTENCE
        in docs['iicrc_defense_letter']
    )
    assert 'estimating sheet' not in docs['iicrc_defense_letter']


def test_v2_documents_single_mode_omit_the_low(monkeypatch):
    docs = v2_documents(monkeypatch, totals=d_totals('single'))
    assert 'proposed_cost_low' not in docs['adr_estimate']
    assert docs['adr_estimate']['proposed_cost'] == 8489.80
    assert docs['adr_estimate']['estimate_mode'] == 'single'
    assert 'high' not in docs['estimate'] and docs['estimate']['mode'] == 'single'
    assert docs['xactimate_total'] == 8489.80
    assert docs['estimate']['explanation'] == 'The price covers the itemized scope below.'
    assert 'Itemized total: $8,489.80.\n\nSincerely,' in docs['iicrc_defense_letter']
    assert 'Customer estimate range' not in docs['iicrc_defense_letter']


def test_mandatory_clauses_unchanged_in_v2(monkeypatch):
    docs = v2_documents(monkeypatch)
    proposal, letter = docs['adr_estimate'], docs['iicrc_defense_letter']
    company = 'Test Co'
    for clause in (
        PRETEST,
        EXCLUSIONS.format(company=company),
        REPRICE,
        VALIDITY,
        PHOTO_LOCATION_PRIVACY,
        ADDRESS_LOCATION_PRIVACY,
    ):
        assert clause in proposal['disclaimers'], clause
        assert clause in letter or clause in (PHOTO_LOCATION_PRIVACY, ADDRESS_LOCATION_PRIVACY)
    for clause in (TESTING, PROTECTION.format(company=company), ADDITIONAL):
        assert clause in proposal['recommendations'] and clause in letter, clause
    # The same wording as the v1 document for the same property age and company.
    v1 = make_documents(
        scoped(),
        [],
        AIResult(summary='Reviewed', suggestions=[], unpriced_work=[]),
        dict(
            company_id='c1',
            version=1,
            name=company,
            address='Office',
            phone='',
            email='',
            license='1',
            signoff='Estimator',
        ),
    )
    assert proposal['disclaimers'] == v1['adr_estimate']['disclaimers']
    assert (
        proposal['lead_notice_required']
        and proposal['findings'][0] == v1['adr_estimate']['findings'][0]
    )


def test_line_breakdown_flag_and_xactimate_codes_flow_to_documents(monkeypatch):
    docs = v2_documents(monkeypatch, policy=dict(D_POLICY, show_line_breakdown=True))
    assert docs['estimate']['show_line_breakdown'] is True
    assert v2_documents(monkeypatch)['estimate']['show_line_breakdown'] is False
    demo = next(line for line in docs['xactimate_scope'] if line['code'] == 'DEMO3W')
    assert demo['xactimate_code'] == 'WTR DMO'
    antimicrobial = next(
        line for line in docs['xactimate_scope'] if 'Antimicrobial' in line['description']
    )
    assert 'xactimate_code' not in antimicrobial
    # The engine's working keys never reach a stored document, a link or a scope export.
    for line in docs['xactimate_scope']:
        assert not {'item_id', 'group', 'bucket', 'taxable', 'room', 'area'} & set(line)
    # Job charges are priced and itemized but are not scope the customer reads as work to perform.
    assert 'Emergency service call' in [line['description'] for line in docs['xactimate_scope']]
    assert 'Emergency service call' not in docs['adr_estimate']['recommendations']
    assert 'Kitchen: Antimicrobial application' in docs['adr_estimate']['recommendations']


def test_minimum_job_charge_and_after_hours_label_print_from_the_policy(monkeypatch):
    policy = dict(
        D_POLICY,
        minimum_job_charge='9000.00',
        after_hours=dict(D_POLICY['after_hours'], label='Night work'),
    )
    low = dict(D_LOW, minimum_charge=510.20, total=9000.00)
    totals = d_totals(low=low, high=dict(D_HIGH))
    docs = v2_documents(monkeypatch, totals=totals, policy=policy)
    estimate = docs['estimate']
    assert estimate['after_hours_label'] == 'Night work'
    assert estimate['low']['minimum_charge'] == 510.20 and estimate['high']['minimum_charge'] == 0
    assert docs['adr_estimate']['proposed_cost_low'] == 9000.00 == docs['xactimate_total']
    assert docs['adr_estimate']['proposed_cost'] >= docs['adr_estimate']['proposed_cost_low']


def test_signable_requires_a_priced_line_in_v2(monkeypatch):
    assert v2_documents(monkeypatch)['signable']
    assert not v2_documents(monkeypatch, lines=[])['signable']


def priced_line(item_id, group):
    return d_line('X', item_id, group, 'fixed', item_id, 1, 'each', 100, 100)


JOB_CHARGES_ONLY = [
    priced_line('service_call', 'job_charges'),
    priced_line('monitoring_visit', 'job_charges'),
    priced_line('debris_haul', 'job_charges'),
    priced_line('setup_documentation', 'job_charges'),
    priced_line('after_hours_charge', 'job_charges'),
    priced_line('air_scrubber', 'drying_equipment'),
    priced_line('hepa_filter', 'drying_equipment'),
]


def scope_quantity(**items):
    return InspectionData.model_validate(
        dict(
            address='Synthetic',
            year_built=1960,
            rooms=[{'name': 'Kitchen', 'category': 1}],
            scope_confirmed=True,
            scope_items=items,
        )
    )


def test_baseline_charges_on_a_room_with_no_area_do_not_make_v2_signable(monkeypatch):
    data = scope_quantity()
    assert not v2_documents(monkeypatch, lines=JOB_CHARGES_ONLY, data=data)['signable']


@pytest.mark.parametrize(
    'line',
    [
        priced_line('demo_cat1_wall', 'demolition'),
        priced_line('air_mover', 'drying_equipment'),
        priced_line('technician_labor', 'labor'),
        priced_line('scan_3d', 'optional_services'),
        d_line('EXTRA', None, 'extras', 'fixed', 'Move toilet', 1, 'hour', 100, 100),
    ],
    ids=['room_area', 'equipment', 'labor', 'optional', 'approved_extra'],
)
def test_real_work_makes_v2_signable(monkeypatch, line):
    data = scope_quantity()
    assert v2_documents(monkeypatch, lines=[*JOB_CHARGES_ONLY, line], data=data)['signable']


def test_a_typed_item_counts_as_work_only_when_entered_outside_job_charges(monkeypatch):
    typed = priced_line('supervisor_labor', 'labor')
    containment = priced_line('containment', 'job_charges')
    entered = dict(quantity=1)
    assert not v2_documents(monkeypatch, lines=[typed], data=scope_quantity())['signable']
    assert v2_documents(monkeypatch, lines=[typed], data=scope_quantity(supervisor_labor=entered))[
        'signable'
    ]
    assert not v2_documents(
        monkeypatch, lines=[containment], data=scope_quantity(containment=entered)
    )['signable']


# One end of an estimate as pricing_v2.totals returns it.
ENGINE_END = dict(
    subtotal=Decimal('8489.80'),
    after_hours=Decimal('0.00'),
    minimum_charge=Decimal('510.20'),
    overhead_profit=Decimal('900.00'),
    tax=Decimal('52.80'),
    total=Decimal('9952.80'),
)


def test_estimate_end_takes_exactly_the_engine_keys():
    assert set(EstimateEnd.model_fields) == set(ENGINE_END)
    summary = end_summary(ENGINE_END)
    assert summary['minimum_charge'] == 510.20
    assert EstimateEnd.model_validate(summary).minimum_charge == 510.20
    with pytest.raises(ValidationError):
        EstimateEnd.model_validate(dict(summary, minimum_adjustment=0))
    for key in ENGINE_END:
        with pytest.raises(KeyError):
            end_summary({k: v for k, v in ENGINE_END.items() if k != key})


def test_homeowner_link_carries_the_printed_lines_only_when_the_breakdown_is_on(monkeypatch):
    tabs = document_links.SETS['homeowner']
    plain_docs = v2_documents(monkeypatch)
    delivered = document_links.delivered_documents(plain_docs, tabs)
    assert 'lines' not in delivered['estimate'] and delivered['xactimate_scope'] == []
    assert delivered['estimate'] == plain_docs['estimate']

    docs = v2_documents(monkeypatch, policy=dict(D_POLICY, show_line_breakdown=True))
    delivered = document_links.delivered_documents(docs, tabs)
    assert delivered['xactimate_scope'] == []
    assert delivered['estimate']['lines'] == [
        {key: line[key] for key in ('description', 'quantity', 'unit', 'total')}
        for line in docs['xactimate_scope']
    ]
    assert delivered['estimate']['lines']
    assert 'lines' not in docs['estimate']


@pytest.mark.parametrize('mode', ['range', 'single'])
def test_adjuster_link_carries_the_amounts_that_add_up_to_its_claim(monkeypatch, mode):
    docs = v2_documents(
        monkeypatch,
        totals=d_totals(mode),
        policy=dict(D_POLICY, show_line_breakdown=True),
    )
    delivered = document_links.delivered_documents(docs, document_links.SETS['adjuster'])
    assert delivered['estimate'] == dict(
        low=D_LOW,
        after_hours_label='After-hours adjustment',
        after_hours_percent='20',
        overhead_profit_percent='10',
        sales_tax_percent='8',
    )
    low = delivered['estimate']['low']
    assert low['total'] == delivered['xactimate_total']
    parts = ('subtotal', 'after_hours', 'minimum_charge', 'overhead_profit', 'tax')
    assert sum(low[part] for part in parts) == pytest.approx(low['total'])
    assert delivered['adr_estimate'].keys() <= {'customer_name', 'property_address', 'date'}
    assert delivered['xactimate_scope'] == docs['xactimate_scope']


def test_v1_documents_gain_no_estimate_on_either_link():
    documents = dict(adr_estimate=dict(date='x'), xactimate_scope=[])
    for tabs in document_links.SETS.values():
        assert 'estimate' not in document_links.delivered_documents(documents, tabs)


def test_v2_basis_without_the_saved_table_is_refused_not_priced_as_v1():
    basis = dict(calculation_version='dryscope-v2')
    with pytest.raises(ValueError, match='saved price table'):
        make_documents(
            scoped(), [], AIResult(summary='x', suggestions=[], unpriced_work=[]), price_basis=basis
        )


def test_quantity_overrides_become_an_estimator_only_note(monkeypatch):
    override = dict(measured='650', entered='400', reason='Hall carpet already removed')
    values = dict(
        address='Synthetic',
        year_built=1960,
        rooms=[{'name': 'Kitchen', 'category': 3, 'finished_sf': 300}],
        scope_confirmed=True,
        quantity_overrides={
            'Kitchen:finished_sf': override,
            'labor_hours': dict(measured='8', entered='6', reason='Crew finished early'),
            'air_movers': dict(measured='3', entered='3', reason='Same'),
            'Attic:finished_sf': dict(measured='9', entered='1', reason='No such room'),
            'not_a_quantity': dict(measured='9', entered='1', reason='Engine ignores it'),
        },
    )
    docs = v2_documents(monkeypatch, data=InspectionData.model_validate(values))
    assert docs['quantity_notes'] == [
        dict(
            label='Finished area',
            room='Kitchen',
            measured=650.0,
            entered=400.0,
            reason='Hall carpet already removed',
        ),
        dict(
            label='Labor hours',
            measured=8.0,
            entered=6.0,
            reason='Crew finished early',
        ),
    ]
    # Document links deliver the documents to people outside the company: the note is held back.
    assert 'quantity_notes' in document_links.ESTIMATOR_ONLY
    delivered = document_links.delivered_documents(docs, ('proposal', 'photos'))
    assert 'quantity_notes' not in delivered
    assert 'quantity_notes' not in v2_documents(monkeypatch)


def test_first_tier_of_zero_prints_no_cushion_sentence(monkeypatch):
    docs = v2_documents(monkeypatch, totals=d_totals(range_explanation=None))
    assert 'explanation' not in docs['estimate']
    assert '0% on the first' not in docs['iicrc_defense_letter']
    assert (
        'Customer estimate range: $8,489.80 to $11,896.00.\n\nSincerely,'
        in docs['iicrc_defense_letter']
    )


def test_extra_wording_skips_a_catalog_line_the_owner_coded_extra(monkeypatch):
    extra = dict(
        id='e' * 32,
        description='Move and reset toilet',
        hours='2.5',
        origin='manual',
        unpriced_item='Move and reset toilet',
        approval=dict(
            accepted_by_uid='owner',
            accepted_by_name='Test Owner',
            accepted_at='2026-10-25T12:00:00Z',
            rate='50',
            total='125.00',
            company_id='c1',
            company_version=1,
        ),
    )
    lines = [
        d_line(
            'EXTRA', 'supervisor_labor', 'labor', 'labor_material', 'Supervisor', 1, 'hour', 80, 80
        ),
        d_line('EXTRA', None, 'extras', 'fixed', 'Move and reset toilet', 2.5, 'hour', 50, 125),
    ]
    data = InspectionData.model_validate(
        dict(
            address='Synthetic',
            year_built=1960,
            rooms=[{'name': 'Kitchen', 'category': 3, 'finished_sf': 300}],
            scope_confirmed=True,
            extras=[extra],
        )
    )
    catalog, approved = v2_documents(monkeypatch, lines=lines, data=data)['xactimate_scope']
    assert catalog['description'] == 'Supervisor'
    assert approved['description'].startswith('Additional work, not in Test Co price sheet:')


def test_extra_wording_replaces_the_description_on_v2_extra_lines(monkeypatch):
    extra = dict(
        id='e' * 32,
        description='Move and reset toilet',
        hours='2.5',
        origin='manual',
        unpriced_item='Move and reset toilet',
        approval=dict(
            accepted_by_uid='owner',
            accepted_by_name='Test Owner',
            accepted_at='2026-10-25T12:00:00Z',
            rate='50',
            total='125.00',
            company_id='c1',
            company_version=1,
        ),
    )
    lines = D_LINES + [
        d_line('EXTRA', None, 'extras', 'fixed', 'Move and reset toilet', 2.5, 'hour', 50, 125)
    ]
    data = InspectionData.model_validate(
        dict(
            address='Synthetic',
            year_built=1960,
            rooms=[{'name': 'Kitchen', 'category': 3, 'finished_sf': 300}],
            scope_confirmed=True,
            extras=[extra],
        )
    )
    docs = v2_documents(monkeypatch, lines=lines, data=data)
    sentence = 'Additional work, not in Test Co price sheet: Move and reset toilet, 2.5 h at $50.00/h, approved by Test Owner on 2026-10-25.'
    assert docs['xactimate_scope'][-1]['description'] == sentence


CLEAN_AI = AIResult(
    summary='Office has drywall removal.\nHallway is inspected only.',
    suggestions=['Confirm the laminate area.', 'Document drying progress.'],
    unpriced_work=[],
    testing_advice=['Lead and asbestos testing may be required before demolition.'],
)
PRICED_AI = AIResult(
    summary='Office has drywall removal. Estimated cost $500.\n'
    'Hallway is inspected only. Budget $750 for paint.',
    suggestions=[
        'Confirm the laminate area. Repairs should run about five hundred dollars.',
        'Total 1,200 for the room.',
        'Document drying progress.',
    ],
    unpriced_work=[],
    testing_advice=[
        'Lead and asbestos testing may be required before demolition. Testing runs $300.'
    ],
)


def test_a_model_written_price_never_reaches_the_documents(monkeypatch):
    logged = []
    monkeypatch.setattr(claims, 'event', lambda *args, **fields: logged.append((args, fields)))
    docs = make_documents(acme(year_built=1960), [], PRICED_AI)
    # The audit still succeeds: only the offending sentences go, and only from the model's notes.
    assert docs == make_documents(acme(year_built=1960), [], CLEAN_AI)
    assert docs['ai_summary'] == 'Office has drywall removal.\nHallway is inspected only.'
    assert docs['ai_suggestions'] == [
        'Confirm the laminate area.',
        'Document drying progress.',
        'Lead and asbestos testing may be required before demolition.',
    ]
    for figure in ['$500', '$750', '$300', '1,200', 'five hundred']:
        assert figure not in str(docs)
    # A code only: the dropped words never reach the log.
    assert logged and all(
        args == ('Audit note sentence dropped', logging.WARNING) for args, _ in logged
    )
    assert all(fields == dict(operation='audit', outcome='price_text') for _, fields in logged)


def test_a_note_made_only_of_prices_leaves_no_blank_entry():
    ai = AIResult(summary='Estimated cost $500.', suggestions=['Budget $750.'], unpriced_work=[])
    docs = make_documents(acme(), [], ai)
    assert docs['ai_summary'] == '' and docs['ai_suggestions'] == []


def test_a_price_word_in_an_unpriced_work_flag_still_blocks_signing():
    # Dropping a flag would unlock signing, so the check covers only the advisory notes.
    ai = AIResult(
        summary='Reviewed', suggestions=[], unpriced_work=['Cabinet removal has no price.']
    )
    docs = make_documents(acme(), [], ai)
    assert docs['unpriced_work'] == ['Cabinet removal has no price.'] and not docs['signable']


@pytest.mark.parametrize(
    'text',
    [
        '$500',
        '$ 500 for the room.',
        'Estimated cost $500.',
        'Budget $750.',
        'About 500 dollars.',
        'USD 500.',
        'Fee 500 plus tax.',
        'Price range 500 to 700.',
        'Budget band is 1200.',
        'Total 3 rooms.',
        'The cost is five hundred.',
        'Total 1,200 sq ft of drywall is affected.',
        'Total 2.5 hours of labor.',
        'Total: 1,200.',
        'The total comes to two hundred and fifty.',
        'Costs roughly 5k.',
        'Priced at 500-700.',
        'Charged 40 for the visit.',
        'The job totaled 900.',
        'Quoting 300 for paint.',
        'The priced_scope has 2 lines.',
    ],
)
def test_states_price_drops_currency_and_a_money_word_with_any_number(text):
    assert states_price(plain(text))


QUANTITY_NOTES = [
    'Estimated 120 sq ft of drywall is affected.',
    'Estimated drying time is 3 days.',
    'Moisture rate is 18 percent in room 2.',
]


@pytest.mark.parametrize(
    'text',
    QUANTITY_NOTES
    + [
        'Office has drywall removal.',
        'Confirm 120 sq ft of drywall.',
        'The estimate is five hundred.',
        'Estimate 40 hours of drying.',
        'A 12k BTU air mover is planned.',
        'The cost is high.',
        'Pricing depends on the carrier.',
        'The tenant asked about the cost.',
        'The priced scope does not cover the toilet reset.',
        'Check that the estimate covers the cabinets.',
        'The scope review lists 2 unpriced items.',
        'Room 2 needs a meter photo at 18 percent.',
    ],
)
def test_states_price_keeps_quantities_and_money_words_without_a_number(text):
    assert not states_price(plain(text))


def test_ordinary_quantities_stay_in_the_notes(monkeypatch):
    logged = []
    monkeypatch.setattr(claims, 'event', lambda *args, **fields: logged.append((args, fields)))
    ai = AIResult(
        summary=' '.join(QUANTITY_NOTES),
        suggestions=QUANTITY_NOTES,
        unpriced_work=[],
    )
    docs = make_documents(acme(), [], ai)
    assert docs['ai_summary'] == ' '.join(QUANTITY_NOTES)
    assert docs['ai_suggestions'] == QUANTITY_NOTES
    assert logged == []


def test_the_prompt_sent_to_the_model_keeps_the_notes_away_from_homeowners_and_prices():
    prompt = audit_prompt(acme().model_dump(mode='json'), [], [])
    assert 'shown to the homeowner' not in prompt
    assert 'never to the homeowner or adjuster' in prompt
    assert 'Never state a dollar amount' in prompt


def test_v2_documents_print_the_uncertainty_sentence_and_no_new_field():
    assist = dict(
        drying_days=3,
        range_method='uncertainty',
        extra_drying_days=1,
        hidden_damage_percent={'1': '10', '2': '15', '3': '25'},
    )
    docs = real_engine_documents(estimate_mode='range', assist=assist)
    estimate = docs['estimate']
    sentence = (
        'The high end allows for the equipment counts as entered for 4 drying days (1 more than '
        'planned), and hidden damage of 25% in category 3 or mold rooms.'
    )
    assert estimate['explanation'] == sentence
    assert sentence in docs['iicrc_defense_letter']
    assert estimate['high']['total'] > estimate['low']['total']
    assert_adds_up(estimate['high'])
    assert docs['signable']
    cushion = real_engine_documents(
        estimate_mode='range', assist=dict(assist, range_method='cushion')
    )
    assert set(estimate) == set(cushion['estimate'])
    assert cushion['estimate']['low'] == estimate['low']
