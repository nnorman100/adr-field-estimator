from decimal import Decimal
import pytest
from pydantic import ValidationError
from backend.claims import price_scope,make_documents,GRANITE,HEATER,PRETEST
from backend.contracts import InspectionData,AIResult

def scoped(**kwargs):
    values=dict(address='Synthetic',year_built=1960,rooms=[{'name':'Bathroom','finished_sf':10}],scope_confirmed=True)
    values.update(kwargs);return InspectionData(**values)

def test_exact_baseline_equipment_and_waste():
    items,total=price_scope(scoped(rooms=[],air_movers=3,dehumidifiers=1))
    assert sum(Decimal(str(i['total'])) for i in items[:5])==Decimal('1180.20')
    assert sum(i['total'] for i in items[5:])==567
    assert total==1747.2
    items,_=price_scope(scoped(rooms=[{'name':'Room','category':1,'finished_sf':36,'waste_percent':10}]))
    assert items[5]['total']==110.09

@pytest.mark.parametrize('category,unfinished,finished',[(1,1.21,2.78),(2,1.52,2.89),(3,2.48,8.39)])
def test_category_and_cabinet_rates(category,unfinished,finished):
    items,_=price_scope(scoped(rooms=[{'name':'Room','category':category,'unfinished_sf':1,'finished_sf':1,'custom_cabinetry':True}]))
    assert items[5]['total']==unfinished and items[6]['total']==finished*(2 if category==3 else 1)

def test_disclaimers_age_planned_work_and_estimate_range():
    ai=AIResult(summary='<img src=x onerror=alert(1)>',suggestions=[],unpriced_work=[])
    docs=make_documents(scoped(granite_removal=True,water_heater_loss=True,has_crawl_space=True),[],ai)
    assert docs['schema_version']==3
    assert docs['adr_estimate']['proposed_cost_low']==1208
    assert docs['adr_estimate']['proposed_cost']==1221.90
    assert docs['xactimate_total']==1208
    assert all(text in docs['adr_estimate']['disclaimers'] for text in [GRANITE,HEATER,PRETEST,'There is a crawl space'])
    assert 'completion has not been recorded' in docs['iicrc_defense_letter']
    modern=make_documents(scoped(year_built=2000),[],ai)
    assert not modern['adr_estimate']['lead_notice_required'] and PRETEST not in modern['adr_estimate']['disclaimers']

def test_pending_evidence_and_unpriced_work_block_signature():
    ai=AIResult(summary='Review',suggestions=[],unpriced_work=['Plumbing reset lacks an ADR rate.'])
    docs=make_documents(scoped(),[{'id':'a','room':'Bathroom','captured_at':'2026-10-06T19:00:00Z','width':120,'height':60,'ocr_status':'pending','ocr':None}],ai)
    assert not docs['signable']
    with pytest.raises(ValueError):make_documents(scoped(year_built=None),[],ai)

def test_workbook_afterhours_range_and_legacy_tier_rejection():
    scope=scoped(rooms=[{'name':'Room','category':2,'unfinished_sf':140,'finished_sf':5}],
                 air_movers=3,dehumidifiers=1,is_after_hours=True)
    items,total=price_scope(scope)
    assert total==2174.45
    assert next(item for item in items if item['code']=='ADR-AFTER')['total']==200
    docs=make_documents(scope,[],AIResult(summary='Reviewed',suggestions=[],unpriced_work=[]))
    assert docs['adr_estimate']['proposed_cost_low']==2219.90
    assert docs['adr_estimate']['proposed_cost']==2356.25
    assert '2,219.90' in docs['iicrc_defense_letter']
    with pytest.raises(ValueError,match='old package-tier'):
        make_documents(scoped(package_price='2049.99'),[],AIResult(summary='Reviewed',suggestions=[],unpriced_work=[]))

def test_afterhours_added_labor_mirrors_workbook_formula():
    items,_=price_scope(scoped(is_after_hours=True,labor_hours=2))
    labor=next(item for item in items if item['code']=='ADR-LABOR')
    assert labor['unit_price']==47.46 and labor['total']==94.92

def test_optional_sheet_charges_and_wood_floor_daily_rate():
    items,total=price_scope(scoped(rooms=[],matterport_scans=1,dump_truck_loads=2,
                                   equipment_decon=1,power_distribution=1,wood_floor_systems=1,wood_floor_days=7))
    charges={item['code']:item['total'] for item in items}
    assert charges['ADR-MATTERPORT']==250
    assert charges['ADR-DUMP']==573.56
    assert charges['ADR-DECON']==27.72
    assert charges['ADR-POWER']==66.74
    assert charges['ADR-WOOD']==1260
    assert total==3358.22

def test_sheet_job_charge_quantities_are_confirmed_inputs():
    items,total=price_scope(scoped(rooms=[],emergency_calls=0,monitoring_hours=0,
                                   haul_loads=2,air_scrubbers=0,hepa_filters=0))
    assert [item['code'] for item in items]==['ADR-HAUL']
    assert total==319.06
    with pytest.raises(ValidationError):scoped(monitoring_hours=float('nan'))
    with pytest.raises(ValidationError):scoped(dump_truck_loads=-1)
    with pytest.raises(ValidationError):scoped(labor_hours=float('nan'))
