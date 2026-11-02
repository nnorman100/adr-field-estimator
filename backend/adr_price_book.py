"""Alert Disaster Restoration's own starting price book.

These numbers are ADR's proprietary rates. They are ADR's data, not a product default: no other
company may be priced from them, and they are never sent to a browser except to ADR's own members
as ADR's prices.
"""

ADR_COMPANY_ID = 'adr'

_RATES = {
    'demo_cat1_unfinished': '1.21',
    'demo_cat1_finished': '2.78',
    'demo_cat2_unfinished': '1.52',
    'demo_cat2_finished': '2.89',
    'demo_cat3_unfinished': '2.48',
    'demo_cat3_finished': '8.39',
    'emergency_call': '133.95',
    'monitoring_hourly': '47.46',
    'haul_pickup_load': '159.53',
    'air_scrubber_daily': '74.75',
    'hepa_filter': '183.12',
    'matterport_scan': '250.00',
    'dump_truck_load': '286.78',
    'equipment_decontamination': '27.72',
    'power_distribution': '66.74',
    'air_mover_daily': '29.25',
    'dehumidifier_daily': '101.25',
    'wood_floor_daily': '180.00',
    'sheet_labor_hourly': '47.46',
    'after_hours_job_charge': '200.00',
    'additional_work_hourly': '47.46',
}


def adr_rates():
    """A copy of ADR's starting rates. Callers must already know the company is ADR."""
    return dict(_RATES)


def foreign_adr_rates(company_id, rates):
    """Whether another company's saved rates are ADR's. Its own additional-work rate is ignored."""
    if company_id == ADR_COMPANY_ID:
        return False
    return all(
        rates.get(key) == value for key, value in _RATES.items() if key != 'additional_work_hourly'
    )
