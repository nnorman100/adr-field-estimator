"""Fixed-template CSV and XLSX: attacks are refused and a round trip keeps cents."""

import io
import zipfile

import pytest
from backend.price_book_import import export_csv, export_xlsx, parse_upload
from backend.adr_price_book import adr_rates
from backend.price_books import normalize_rates

XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'


def parsed(raw, kind='text/csv'):
    return parse_upload(raw, kind, 'adr', 'seed', 0)


def test_csv_and_xlsx_round_trip_preserves_cents():
    book = adr_rates()
    book['emergency_call'] = '0.00'
    book['additional_work_hourly'] = '10000.00'
    csv_rates = parsed(export_csv('adr', 'seed', 0, book))
    xlsx_rates = parsed(export_xlsx('adr', 'seed', 0, book), XLSX)
    assert csv_rates == book and xlsx_rates == book
    assert normalize_rates(csv_rates, ['emergency_call']) == {
        key: f'{__import__("decimal").Decimal(value):.2f}' for key, value in book.items()
    }


def test_csv_rejects_a_wrong_template_company_or_formula():
    raw = export_csv('adr', 'seed', 0, adr_rates())
    with pytest.raises(ValueError, match='columns'):
        parsed(raw.replace(b'unit_price', b'price', 1))
    with pytest.raises(ValueError, match='different company'):
        parse_upload(raw, 'text/csv', 'other', 'seed', 0)
    with pytest.raises(ValueError, match='changed'):
        parse_upload(raw, 'text/csv', 'adr', 'seed', 1)
    changed = raw.replace(b'133.95', b'=133.95', 1)
    with pytest.raises(ValueError):
        normalize_rates(parsed(changed))
    with pytest.raises(ValueError, match='UTF-8'):
        parsed('price'.encode('utf-16'))
    with pytest.raises(ValueError, match='too large'):
        parsed(b'x' * (256 * 1024 + 1))


def _patch(raw, name, data):
    source = zipfile.ZipFile(io.BytesIO(raw))
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w') as archive:
        for info in source.infolist():
            archive.writestr(info.filename, data if info.filename == name else source.read(info))
    return output.getvalue()


def test_xlsx_rejects_formulas_macros_links_entities_and_extra_sheets():
    raw = export_xlsx('adr', 'seed', 0, adr_rates())
    sheet = zipfile.ZipFile(io.BytesIO(raw)).read('xl/worksheets/sheet1.xml')
    formula = sheet.replace(
        b't="inlineStr"><is><t>133.95</t></is>',
        b'><f>SUM(1,1)</f><v>2</v>',
        1,
    )
    with pytest.raises(ValueError, match='formula'):
        parsed(_patch(raw, 'xl/worksheets/sheet1.xml', formula), XLSX)
    doctype = sheet.replace(b'<worksheet', b'<!DOCTYPE sheet [<!ENTITY x "x">]><worksheet', 1)
    with pytest.raises(ValueError, match='unsupported'):
        parsed(_patch(raw, 'xl/worksheets/sheet1.xml', doctype), XLSX)
    cached = sheet.replace(b't="inlineStr"', b't="str"', 1)
    with pytest.raises(ValueError, match='non-numeric'):
        parsed(_patch(raw, 'xl/worksheets/sheet1.xml', cached), XLSX)
    workbook = zipfile.ZipFile(io.BytesIO(raw)).read('xl/workbook.xml')
    hidden = workbook.replace(b'<sheet ', b'<sheet state="hidden" ', 1)
    with pytest.raises(ValueError, match='Hidden'):
        parsed(_patch(raw, 'xl/workbook.xml', hidden), XLSX)
    renamed = workbook.replace(b'name="Prices"', b'name="Secret"', 1)
    with pytest.raises(ValueError, match='Prices'):
        parsed(_patch(raw, 'xl/workbook.xml', renamed), XLSX)
    output = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(raw)) as source, zipfile.ZipFile(output, 'w') as archive:
        for info in source.infolist():
            archive.writestr(info.filename, source.read(info))
        archive.writestr('xl/vbaProject.bin', b'not a macro')
    with pytest.raises(ValueError, match='macro'):
        parsed(output.getvalue(), XLSX)
    rels = zipfile.ZipFile(io.BytesIO(raw)).read('xl/_rels/workbook.xml.rels')
    external = rels.replace(
        b'/>',
        b'/><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLink" Target="https://evil.example/x" TargetMode="External"/>',
        1,
    )
    with pytest.raises(ValueError, match='external'):
        parsed(_patch(raw, 'xl/_rels/workbook.xml.rels', external), XLSX)
    bomb = io.BytesIO()
    with zipfile.ZipFile(bomb, 'w') as archive:
        archive.writestr('xl/worksheets/sheet1.xml', b'x' * (5 * 1024 * 1024 + 1))
    with pytest.raises(ValueError, match='too large'):
        parsed(bomb.getvalue(), XLSX)


def test_excel_shared_strings_round_trip_and_edited_price():
    from xml.etree import ElementTree as ET
    from backend.price_book_import import NS

    book = adr_rates()
    raw = export_xlsx('adr', 'seed', 0, book)
    output = io.BytesIO()
    strings = ET.Element('sst', xmlns=NS['m'])
    with zipfile.ZipFile(io.BytesIO(raw)) as source, zipfile.ZipFile(output, 'w') as archive:
        sheet = ET.fromstring(source.read('xl/worksheets/sheet1.xml'))
        for index, cell in enumerate(sheet.findall('.//m:c', NS)):
            text = cell.find('m:is/m:t', NS).text
            if text == '133.95':
                text = '150.25'
            ET.SubElement(ET.SubElement(strings, 'si'), 't').text = text
            cell.clear()
            cell.set('r', f'{chr(65 + index % 9)}{index // 9 + 1}')
            cell.set('t', 's')
            ET.SubElement(cell, '{' + NS['m'] + '}v').text = str(index)
        for info in source.infolist():
            archive.writestr(
                info.filename,
                ET.tostring(sheet)
                if info.filename == 'xl/worksheets/sheet1.xml'
                else source.read(info),
            )
        archive.writestr('xl/sharedStrings.xml', ET.tostring(strings))
    book['emergency_call'] = '150.25'
    assert parsed(output.getvalue(), XLSX) == book


def test_v2_template_csv_xlsx_round_trip_and_rejects_v1_template():
    from backend import price_table

    table = price_table.starter_table()
    for item in table['items']:
        if item['enabled']:
            item['unit_price'] = '25.00'
    # Test multi-category pipe format ('1|3') and blank categories, plus yes/no booleans
    table['items'][0]['categories'] = [1, 3]
    table['items'][0]['taxable'] = True
    table['items'][0]['allow_zero'] = True
    normalized = price_table.normalize_table(table, publish=True)
    items = normalized['items']

    csv_bytes = export_csv('adr', 'v2-ver-1', 2, items)
    assert b'dryscope-prices-v2' in csv_bytes
    assert b'1|3' in csv_bytes
    assert b',yes,' in csv_bytes and b',no,' in csv_bytes

    csv_round_trip = parse_upload(
        csv_bytes,
        'text/csv',
        'adr',
        'v2-ver-1',
        2,
        calculation_version=price_table.CALCULATION_VERSION,
    )
    assert price_table.normalize_items(csv_round_trip, publish=True) == items

    xlsx_bytes = export_xlsx('adr', 'v2-ver-1', 2, items)
    xlsx_round_trip = parse_upload(
        xlsx_bytes,
        XLSX,
        'adr',
        'v2-ver-1',
        2,
        calculation_version=price_table.CALCULATION_VERSION,
    )
    assert price_table.normalize_items(xlsx_round_trip, publish=True) == items

    # A v1 template uploaded to a v2 company is rejected
    v1_csv = export_csv('adr', 'v2-ver-1', 2, adr_rates())
    with pytest.raises(ValueError, match='this file is not the current DryScope price template'):
        parse_upload(
            v1_csv,
            'text/csv',
            'adr',
            'v2-ver-1',
            2,
            calculation_version=price_table.CALCULATION_VERSION,
        )

    v1_xlsx = export_xlsx('adr', 'v2-ver-1', 2, adr_rates())
    with pytest.raises(ValueError, match='this file is not the current DryScope price template'):
        parse_upload(
            v1_xlsx,
            XLSX,
            'adr',
            'v2-ver-1',
            2,
            calculation_version=price_table.CALCULATION_VERSION,
        )


def test_v2_text_round_trips_unchanged_through_csv_and_xlsx():
    from backend import price_table

    table = price_table.starter_table()
    for item in table['items']:
        if item['enabled']:
            item['unit_price'] = '25.00'
    table['items'][0]['name'] = 'Call-out, "emergency" & after 5 pm'
    items = price_table.normalize_table(table, publish=True)['items']
    version = price_table.CALCULATION_VERSION
    assert (
        parse_upload(export_csv('adr', 'v', 1, items), 'text/csv', 'adr', 'v', 1, version) == items
    )
    assert parse_upload(export_xlsx('adr', 'v', 1, items), XLSX, 'adr', 'v', 1, version) == items
