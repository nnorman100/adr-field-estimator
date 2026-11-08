"""Shared helpers for price table tests."""

from backend import price_table


def _priced_starter():
    table = price_table.starter_table()
    for item in table['items']:
        if item['enabled']:
            item['unit_price'] = '25.00'
    return table
