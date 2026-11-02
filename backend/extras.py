"""Manual additional work. Prices and approval provenance are always server owned."""

from decimal import Decimal, ROUND_HALF_UP

try:
    from .adr_price_book import ADR_COMPANY_ID, adr_rates
except ImportError:
    from adr_price_book import ADR_COMPANY_ID, adr_rates


def _source_rate(source):
    """A price-book source's hourly rate: the v2 enabled extras item, or the v1 rate key."""
    if 'items' not in source:
        return source['rates'].get('additional_work_hourly')
    for item in source['items']:
        if item['group'] == 'extras' and item['enabled']:
            # A blank or zero price is not a rate an owner can approve work at.
            price = item['unit_price']
            return price if price and Decimal(price) > 0 else None
    return None


def rate_for(company, source=None):
    """The hourly rate for a new approval. A price-book source wins over the profile projection."""
    if source is not None:
        value = _source_rate(source)
        if not value:
            raise ValueError(
                'The company owner must set an additional-work hourly rate in Company prices.'
            )
        return Decimal(str(value))
    value = company['profile'].get('additional_work_rate')
    if value is None and company['company_id'] == ADR_COMPANY_ID:
        value = adr_rates()['additional_work_hourly']
    if value is None:
        raise ValueError(
            'The company owner must set an additional-work hourly rate in Company settings.'
        )
    return Decimal(str(value))


def quote(company, hours, source=None):
    rate = rate_for(company, source)
    total = (Decimal(str(hours)) * rate).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
    priced = dict(rate=f'{rate:.2f}', total=f'{total:.2f}', company_version=company['version'])
    if source is not None:
        try:
            from .price_books import rate_fingerprint
            from .price_table import rate_fingerprint as table_fingerprint
        except ImportError:
            from price_books import rate_fingerprint
            from price_table import rate_fingerprint as table_fingerprint
        fingerprint = (
            table_fingerprint(source) if 'items' in source else rate_fingerprint(source['rates'])
        )
        priced.update(
            price_version_id=source['version_id'],
            price_content_sha256=source['content_sha256'],
            price_rate_fingerprint=fingerprint,
        )
    return priced


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
