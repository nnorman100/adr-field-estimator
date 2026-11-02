"""ADR's prices for tests of ADR's estimate. The app has no default price book, so these pass one."""

from backend import claims
from backend.adr_price_book import adr_rates


def price_scope(data, rates=None):
    return claims.price_scope(data, rates or adr_rates())


def make_documents(
    data, photos, ai, identity=None, customer_name='', claim=None, rates=None, *more, **kw
):
    return claims.make_documents(
        data, photos, ai, identity, customer_name, claim, rates or adr_rates(), *more, **kw
    )
