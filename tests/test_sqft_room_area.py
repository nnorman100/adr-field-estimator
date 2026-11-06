"""Whole-job bands count each room once using its priced square-foot sources."""

import copy
from decimal import Decimal as D

import pytest

from backend import price_table, pricing_v2
from backend.contracts import InspectionData
from tests.test_sqft_brackets import estimate, table


def book_for(source, basis='demolition'):
    book = table('whole-job')
    book['items'][0]['quantity_source'] = source
    book['policy']['area_basis'] = basis
    book['policy']['range']['brackets'] = [
        dict(up_to_sf=500, percent='50'),
        dict(up_to_sf=None, percent='10'),
    ]
    return price_table.normalize_table(book, publish=True)


@pytest.mark.parametrize(
    'source,room,basis,footage,low,high',
    [
        ('room:floor', dict(floor_sf=600, wet_floor_sf=900), 'demolition', '600', '3000', '3300'),
        (
            'room:wet_floor',
            dict(wet_floor_sf=600, floor_sf=900),
            'demolition',
            '600',
            '3000',
            '3300',
        ),
        (
            'room:demolition:finished',
            dict(finished_sf=400, unfinished_sf=400),
            'wet_floor',
            '800',
            '2000',
            '2200',
        ),
        (
            'room:floor',
            dict(floor_sf=600, finished_sf=1000, unfinished_sf=1000),
            'demolition',
            '600',
            '3000',
            '3300',
        ),
        (
            'room:basis',
            dict(finished_sf=400, unfinished_sf=400),
            'demolition',
            '800',
            '4000',
            '4400',
        ),
        ('room:basis', dict(wet_floor_sf=600, floor_sf=900), 'wet_floor', '600', '3000', '3300'),
    ],
    ids=[
        'floor-only',
        'wet-floor-only',
        'demolition-only',
        'unread-basis',
        'basis-demo',
        'basis-wet',
    ],
)
def test_whole_job_uses_the_area_figure_its_priced_item_reads(
    source, room, basis, footage, low, high
):
    book = book_for(source, basis)
    job = InspectionData(rooms=[dict(name='Room', **room)])
    assert pricing_v2._job_sf(job, book['items'], book['policy']) == D(footage)
    totals = estimate(book, job)
    assert (totals['low']['total'], totals['high']['total']) == (D(low), D(high))


def test_mixed_room_uses_largest_source_figure_for_every_rate_and_cushion():
    book = book_for('room:demolition:finished')
    book['items'][0]['price_brackets'] = [
        dict(up_to_sf=850, unit_price='10'),
        dict(up_to_sf=None, unit_price='5'),
    ]
    for item_id, source in [
        ('unfinished_work', 'room:demolition:unfinished'),
        ('floor_work', 'room:floor'),
        ('wet_work', 'room:wet_floor'),
    ]:
        item = copy.deepcopy(book['items'][0])
        item.update(item_id=item_id, code=item_id.upper().replace('_', '-'), quantity_source=source)
        book['items'].append(item)
    book['policy']['range']['brackets'][0]['up_to_sf'] = 850
    book = price_table.normalize_table(book, publish=True)
    job = InspectionData(
        rooms=[
            dict(name='Mixed', finished_sf=400, unfinished_sf=400, floor_sf=600, wet_floor_sf=900)
        ]
    )
    assert pricing_v2._job_sf(job, book['items'], book['policy']) == D('900')
    lines, _ = pricing_v2.price_scope(job, book)
    assert len(lines) == 4 and all(line['unit_price'] == 5 for line in lines)
    totals = estimate(book, job)
    assert (totals['low']['total'], totals['high']['total']) == (D('11500'), D('12650'))


def test_flat_floor_item_contributes_its_figure_to_shared_whole_job_selectors():
    book = book_for('room:demolition:finished')
    flat = copy.deepcopy(book['items'][0])
    flat.update(item_id='floor_work', code='FLOOR', quantity_source='room:floor', unit_price='1')
    del flat['price_brackets']
    book['items'].append(flat)
    job = InspectionData(rooms=[dict(name='Room', finished_sf=400, floor_sf=900)])
    assert pricing_v2._job_sf(job, book['items'], book['policy']) == D('900')
    totals = estimate(book, job)
    assert (totals['low']['total'], totals['high']['total']) == (D('2900'), D('3190'))
