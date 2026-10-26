"""Manual additional work. Prices and approval provenance are always server owned."""

from decimal import Decimal, ROUND_HALF_UP


def rate_for(company):
    value = company['profile'].get('additional_work_rate')
    if value is None and company['company_id'] == 'adr':
        value = '47.46'  # Residential Estimate Tool E24; existing ADR profile seed.
    if value is None:
        raise ValueError(
            'The company owner must set an additional-work hourly rate in Company settings.'
        )
    return Decimal(str(value))


def quote(company, hours):
    rate = rate_for(company)
    total = (Decimal(str(hours)) * rate).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
    return dict(rate=f'{rate:.2f}', total=f'{total:.2f}', company_version=company['version'])


def validate_edits(previous, incoming):
    """Clients may retain unchanged approval, or remove it to request fresh approval."""
    try:
        from .contracts import Extra
    except ImportError:
        from contracts import Extra
    canonical = lambda extra: Extra.model_validate(extra).model_dump(mode='json')
    old = {extra['id']: canonical(extra) for extra in previous}
    if len({extra['id'] for extra in incoming}) != len(incoming):
        raise ValueError('Each extra needs a unique ID.')
    for extra in incoming:
        if extra.get('approval') and canonical(extra) != old.get(extra['id']):
            raise ValueError(
                'Only the company owner approval action can price or approve an extra.'
            )


def wording(extra, company_name):
    approval = extra.approval
    hours = format(extra.hours.normalize(), 'f')
    return (
        f'Additional work, not in {company_name} price sheet: {extra.description}, '
        f'{hours} h at ${approval.rate:.2f}/h, approved by '
        f'{approval.accepted_by_name} on {approval.accepted_at.date().isoformat()}.'
    )
