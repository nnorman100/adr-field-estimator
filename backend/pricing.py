"""Calculation dispatch between v1 rate books and v2 owner-defined price tables."""

from dataclasses import dataclass, field
from typing import Any

try:
    from . import claims, price_books, pricing_v2
    from .contracts import InspectionData
    from .price_table import CALCULATION_VERSION as V2_CALCULATION_VERSION
except ImportError:
    import claims
    import price_books
    import pricing_v2
    from contracts import InspectionData
    from price_table import CALCULATION_VERSION as V2_CALCULATION_VERSION


@dataclass
class PricedJob:
    lines: list[dict[str, Any]]
    totals: dict[str, Any] | None
    warnings: list[dict[str, Any]] = field(default_factory=list)
    calculation_version: str = price_books.CALCULATION_VERSION
    xactimate_total: Any = None
    low: Any = None
    high: Any = None


def price_and_range(data: InspectionData, pin: dict[str, Any]) -> PricedJob:
    """Dispatch pricing by pin['calculation_version']."""
    version = pin.get('calculation_version')
    if version == V2_CALCULATION_VERSION:
        lines, warnings = pricing_v2.price_scope(data, pin)
        estimate = pricing_v2.totals(data, lines, pin['policy'])
        low = estimate['low']['total']
        return PricedJob(
            lines=lines,
            totals=estimate,
            warnings=warnings,
            calculation_version=version,
            xactimate_total=float(low),
            low=low,
            high=estimate['high']['total'] if estimate['high'] else None,
        )
    if not price_books.known_calculation_version(version):
        raise ValueError(f'Unsupported calculation version: {version!r}')
    rates = pin.get('rates')
    if not rates:
        raise ValueError('A v1 pricing pin must carry its rates.')

    lines, total = claims.price_scope(data, rates, version)
    low, high = claims.proposal_range(data, lines, version)

    return PricedJob(
        lines=lines,
        totals=None,
        warnings=[],
        calculation_version=version,
        xactimate_total=total,
        low=low,
        high=high,
    )
