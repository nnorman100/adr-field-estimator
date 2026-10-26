"""Fixed-template CSV and XLSX: attacks are refused and a round trip keeps cents."""

import io
import zipfile

import pytest
from backend.price_book_import import export_csv, export_xlsx, parse_upload
from backend.price_books import normalize_rates, seed_rates

XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'


def parsed(raw, kind='text/csv'):
    return parse_upload(raw, kind, 'adr', 'seed', 0)


def test_csv_and_xlsx_round_trip_preserves_cents():
    book = seed_rates()
    book['emergency_call'] = '0.00'
    book['additional_work_hourly'] = '10000.00'
    csv_rates = parsed(export_csv('adr', 'seed', 0, book))
    xlsx_rates = parsed(export_xlsx('adr', 'seed', 0, book), XLSX)
    assert csv_rates == book and xlsx_rates == book
    assert normalize_rates(csv_rates, ['emergency_call']) == {
        key: f'{__import__("decimal").Decimal(value):.2f}' for key, value in book.items()
    }


def test_csv_rejects_a_wrong_template_company_or_formula():
    raw = export_csv('adr', 'seed', 0, seed_rates())
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
    raw = export_xlsx('adr', 'seed', 0, seed_rates())
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

    book = seed_rates()
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
                ET.tostring(sheet) if info.filename == 'xl/worksheets/sheet1.xml' else source.read(info),
            )
        archive.writestr('xl/sharedStrings.xml', ET.tostring(strings))
    book['emergency_call'] = '150.25'
    assert parsed(output.getvalue(), XLSX) == book
