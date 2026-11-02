"""Calculation dispatch between v1 rate books and v2 owner-defined price tables."""

from dataclasses import dataclass, field
from typing import Any

try:
    from . import claims, price_books
    from .contracts import InspectionData
    from .price_table import CALCULATION_VERSION as V2_CALCULATION_VERSION
except ImportError:
    import claims
    import price_books
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

    def __getitem__(self, key: str) -> Any:
        return getattr(self, key)

    def get(self, key: str, default: Any = None) -> Any:
        return getattr(self, key, default)


def _is_known_v1(version: str | None) -> bool:
    if not version:
        return False
    known = getattr(price_books, 'known_calculation_version', None)
    if callable(known):
        return bool(known(version))
    return version == price_books.CALCULATION_VERSION


def price_and_range(data: InspectionData, pin: dict[str, Any]) -> PricedJob:
    """Dispatch pricing by pin['calculation_version']."""
    if not isinstance(pin, dict):
        raise ValueError('A pricing pin dictionary is required.')
    version = pin.get('calculation_version') or price_books.CALCULATION_VERSION
    if version == V2_CALCULATION_VERSION:
        raise NotImplementedError('dryscope-v2 pricing is not available yet')
    if not _is_known_v1(version):
        raise ValueError(f'Unsupported calculation version: {version!r}')

    rates = pin.get('rates')
    try:
        lines, total = claims.price_scope(data, rates, calculation_version=version)
    except TypeError:
        lines, total = claims.price_scope(data, rates)
    try:
        low, high = claims.proposal_range(data, lines, calculation_version=version)
    except TypeError:
        low, high = claims.proposal_range(data, lines)

    return PricedJob(
        lines=lines,
        totals=None,
        warnings=[],
        calculation_version=version,
        xactimate_total=total,
        low=low,
        high=high,
    )
