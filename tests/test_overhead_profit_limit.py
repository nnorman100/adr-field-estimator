"""Overhead and profit may be set from 0 to 100 percent; the calculation is unchanged.

The limit was 30. An owner needs more, so it is 100 as a typo guard. Prices here are the made-up
round ones of the calculation-v2 tests, and the worked totals are the spec's example D.
"""

from decimal import Decimal as D

import pytest

from backend import price_table
from tests.test_pricing_v2 import EXAMPLE_D, job, run, table

TAX = {'enabled': True, 'percent': '8'}


def _policy(percent):
    return price_table.normalize_policy(
        dict(price_table.starter_table()['policy'], overhead_profit_percent=percent)
    )


def test_default_stays_off():
    assert price_table.starter_table()['policy']['overhead_profit_percent'] == '0'
    policy = dict(price_table.starter_table()['policy'])
    del policy['overhead_profit_percent']
    assert price_table.normalize_policy(policy)['overhead_profit_percent'] == '0'


@pytest.mark.parametrize('percent', ['0', '30', '30.01', '31', '50', '99.99', '100', '100.00'])
def test_values_up_to_100_are_accepted(percent):
    assert D(_policy(percent)['overhead_profit_percent']) == D(percent)


@pytest.mark.parametrize('percent', ['100.01', '101', '1000', '-0.01', '12.345', 'abc', ''])
def test_values_above_100_or_malformed_are_refused(percent):
    with pytest.raises(ValueError, match='overhead_profit_percent'):
        _policy(percent)


def test_the_refusal_names_the_new_limit():
    with pytest.raises(ValueError, match='between 0 and 100'):
        _policy('100.01')


def test_a_table_at_or_below_the_old_limit_keeps_its_hash():
    # Pinned before the limit moved: raising it must not change any stored table or pin.
    pinned = {
        '0': '004cfd4e0be1ebb1280a4dd4377a5b66b4936a2afd04ec8a158645934869811f',
        '10': '9dd4474bb6a77cf1e9e88976197b19fc70b344c4dbd97507ef85013fb5ab262c',
        '12.5': 'df0f35dee5a9984ca9ba0531e0df7052a055164b3603af207e8fab644d6ad854',
        '30': 'ac2ce67c9a854174d12da730eb9a127838738520c9c1fb1dc1248f1ca2a87a0a',
    }
    for percent, digest in pinned.items():
        assert price_table.content_hash(table(overhead_profit_percent=percent)) == digest


def _ends(**policy):
    _, result, _ = run(job(**EXAMPLE_D), table(**policy))
    return result['low'], result['high']


def test_worked_totals_above_30_percent():
    # Example D: subtotal 6,640.00 + after hours 1,030.00 = 7,670.00 at the low end;
    # 9,215.00 + 1,545.00 = 10,760.00 at the high end.
    low, high = _ends(overhead_profit_percent='50')
    assert low['overhead_profit'] == D('3835.00') and low['total'] == D('11505.00')
    assert high['overhead_profit'] == D('5380.00') and high['total'] == D('16140.00')

    low, high = _ends(overhead_profit_percent='100')
    assert low['overhead_profit'] == D('7670.00') and low['total'] == D('15340.00')
    assert high['overhead_profit'] == D('10760.00') and high['total'] == D('21520.00')


def test_cents_stay_exact_above_30_percent():
    # 33.33% of 7,670.00 = 2,556.411 and of 10,760.00 = 3,586.308, each half-up to the cent.
    low, high = _ends(overhead_profit_percent='33.33')
    assert low['overhead_profit'] == D('2556.41') and low['total'] == D('10226.41')
    assert high['overhead_profit'] == D('3586.31') and high['total'] == D('14346.31')


def test_sales_tax_still_follows_overhead_and_profit_above_30_percent():
    # Taxable base 660.00 at the low end carries its 50% share: 990.00, and 8% of that is 79.20.
    low, high = _ends(overhead_profit_percent='50', sales_tax=TAX)
    assert low['tax'] == D('79.20') and low['total'] == D('11584.20')
    assert high['tax'] == D('90.00') and high['total'] == D('16230.00')
