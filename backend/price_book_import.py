"""Fixed-template CSV and XLSX price import and export.

The workbook is data, not a program. Formulas, macros, external links and extra
sheets are rejected. Prices stay strings until the catalog normalizes them.
"""

import csv
import io
import re
import zipfile
from xml.etree import ElementTree

try:
    from .price_books import BY_KEY, COLUMNS, CURRENCY, ITEMS, KEYS, TEMPLATE_VERSION
except ImportError:
    from price_books import BY_KEY, COLUMNS, CURRENCY, ITEMS, KEYS, TEMPLATE_VERSION

CSV_LIMIT = 256 * 1024
XLSX_LIMIT = 1024 * 1024
UNZIPPED_LIMIT = 5 * 1024 * 1024
ENTRY_LIMIT = 100
ROW_LIMIT = 100
COLUMN_LIMIT = 12
CELL_LIMIT = 256
NS = {
    'm': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
    'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    'pr': 'http://schemas.openxmlformats.org/package/2006/relationships',
    'ct': 'http://schemas.openxmlformats.org/package/2006/content-types',
}
FORMULA_LEAD = re.compile(r'^[=+\-@]')


class SizeLimit(ValueError):
    """The upload or saved book exceeds its byte cap. The API answers 413."""


def export_csv(company_id, base_version_id, base_generation, rates):
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=COLUMNS, lineterminator='\n')
    writer.writeheader()
    for item in ITEMS:
        writer.writerow(_row(company_id, base_version_id, base_generation, item, rates))
    return ('\ufeff' + buffer.getvalue()).encode('utf-8')


def export_xlsx(company_id, base_version_id, base_generation, rates):
    rows = [
        list(COLUMNS),
        *[
            [
                _safe(value)
                for value in _row(
                    company_id, base_version_id, base_generation, item, rates
                ).values()
            ]
            for item in ITEMS
        ],
    ]
    sheet = _sheet_xml(rows)
    package = io.BytesIO()
    with zipfile.ZipFile(package, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('[Content_Types].xml', _CONTENT_TYPES)
        archive.writestr('_rels/.rels', _ROOT_RELS)
        archive.writestr('xl/workbook.xml', _WORKBOOK)
        archive.writestr('xl/_rels/workbook.xml.rels', _WORKBOOK_RELS)
        archive.writestr('xl/worksheets/sheet1.xml', sheet)
    return package.getvalue()


def parse_upload(raw, content_type, company_id, base_version_id, base_generation):
    if not isinstance(raw, (bytes, bytearray)):
        raise ValueError('Upload a CSV or XLSX file.')
    kind = (content_type or '').split(';', 1)[0].strip().lower()
    if kind in ('text/csv', 'application/csv', 'text/plain'):
        if len(raw) > CSV_LIMIT:
            raise SizeLimit('The CSV file is too large.')
        table = _parse_csv(raw)
    elif (
        kind
        in (
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/octet-stream',
        )
        or raw[:2] == b'PK'
    ):
        if len(raw) > XLSX_LIMIT:
            raise SizeLimit('The spreadsheet is too large.')
        table = _parse_xlsx(raw)
    else:
        raise ValueError('Upload a CSV or XLSX file.')
    return _table_to_rates(table, company_id, str(base_version_id), str(base_generation))


def _row(company_id, base_version_id, base_generation, item, rates):
    return {
        'template_version': TEMPLATE_VERSION,
        'company_id': company_id,
        'base_version_id': base_version_id or 'seed',
        'base_generation': str(base_generation),
        'item_key': item['key'],
        'description': item['description'],
        'unit': item['unit'],
        'currency': CURRENCY,
        'unit_price': rates[item['key']],
    }


def _safe(value):
    text = '' if value is None else str(value)
    if FORMULA_LEAD.match(text):
        return "'" + text
    return text


def _parse_csv(raw):
    try:
        text = raw.decode('utf-8-sig')
    except UnicodeError as error:
        raise ValueError('The CSV file must be UTF-8.') from error
    if '\x00' in text:
        raise ValueError('The CSV file could not be read.')
    reader = csv.DictReader(io.StringIO(text), dialect='excel')
    if reader.fieldnames is None or [name.strip() for name in reader.fieldnames] != list(COLUMNS):
        raise ValueError('The file must use the DryScope price template columns.')
    rows = []
    for index, row in enumerate(reader, start=2):
        if row is None:
            continue
        values = [(row.get(column) or '').strip() for column in COLUMNS]
        if not any(values):
            continue
        if index - 1 > ROW_LIMIT:
            raise ValueError('The file has too many rows.')
        rows.append(values)
    return rows


def _parse_xlsx(raw):
    try:
        archive = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile as error:
        raise ValueError('The spreadsheet could not be read.') from error
    with archive:
        infos = archive.infolist()
        if len(infos) > ENTRY_LIMIT:
            raise ValueError('The spreadsheet has too many parts.')
        total = 0
        names = []
        for info in infos:
            if info.flag_bits & 0x1:
                raise ValueError('Encrypted spreadsheets are not accepted.')
            name = info.filename
            if name.startswith('/') or '..' in name.split('/'):
                raise ValueError('The spreadsheet could not be read.')
            if info.file_size > UNZIPPED_LIMIT:
                raise SizeLimit('The spreadsheet is too large.')
            total += info.file_size
            if total > UNZIPPED_LIMIT:
                raise SizeLimit('The spreadsheet is too large.')
            names.append(name)
        lowered = [name.lower() for name in names]
        if any(
            name.endswith('.bin') or 'vbaproject' in name or 'macro' in name for name in lowered
        ):
            raise ValueError('Spreadsheets with macros are not accepted.')
        required = {
            '[Content_Types].xml',
            'xl/workbook.xml',
            'xl/_rels/workbook.xml.rels',
            'xl/worksheets/sheet1.xml',
        }
        if not required <= set(names):
            raise ValueError('The spreadsheet must contain one Prices sheet.')
        _reject_external(archive)
        _reject_extra_sheets(archive)
        strings = []
        if 'xl/sharedStrings.xml' in names:
            root = _xml(archive.read('xl/sharedStrings.xml'))
            strings = [
                ''.join(node.text or '' for node in item.findall('.//m:t', NS))
                for item in root.findall('m:si', NS)
            ]
        return _cells(archive.read('xl/worksheets/sheet1.xml'), strings)


def _xml(raw):
    if b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper():
        raise ValueError('The spreadsheet contains unsupported content.')
    if len(raw) > UNZIPPED_LIMIT:
        raise SizeLimit('The spreadsheet is too large.')
    try:
        return ElementTree.fromstring(raw)
    except ElementTree.ParseError as error:
        raise ValueError('The spreadsheet could not be read.') from error


def _reject_external(archive):
    for name in archive.namelist():
        if not name.endswith('.rels'):
            continue
        root = _xml(archive.read(name))
        for node in root:
            target = node.attrib.get('Target', '')
            mode = node.attrib.get('TargetMode', '')
            if mode.lower() == 'external' or target.lower().startswith(('http://', 'https://')):
                raise ValueError('Spreadsheets with external links are not accepted.')


def _reject_extra_sheets(archive):
    root = _xml(archive.read('xl/workbook.xml'))
    sheets = list(root.findall('m:sheets/m:sheet', NS))
    if len(sheets) != 1 or sheets[0].attrib.get('name') != 'Prices':
        raise ValueError('The spreadsheet must contain one Prices sheet.')
    if sheets[0].attrib.get('state', 'visible') != 'visible':
        raise ValueError('Hidden sheets are not accepted.')
    types = _xml(archive.read('[Content_Types].xml'))
    for node in types:
        content = node.attrib.get('ContentType', '')
        part = node.attrib.get('PartName', '')
        if 'macro' in content.lower():
            raise ValueError('Spreadsheets with macros are not accepted.')
        if part.startswith('/xl/worksheets/') and part != '/xl/worksheets/sheet1.xml':
            raise ValueError('The spreadsheet must contain one Prices sheet.')


def _cells(raw, strings):
    root = _xml(raw)
    rows = []
    for row in root.findall('m:sheetData/m:row', NS):
        number = int(row.attrib.get('r') or len(rows) + 1)
        if number > ROW_LIMIT + 1:
            raise ValueError('The file has too many rows.')
        values = [''] * len(COLUMNS)
        seen = False
        for cell in row.findall('m:c', NS):
            if cell.find('m:f', NS) is not None:
                raise ValueError('Spreadsheet formulas are not accepted.')
            ref = cell.attrib.get('r', 'A1')
            column = ''.join(ch for ch in ref if ch.isalpha())
            index = _column_index(column)
            if index is None or index >= COLUMN_LIMIT:
                raise ValueError('The file has too many columns.')
            if index >= len(COLUMNS):
                raise ValueError('The file must use the DryScope price template columns.')
            text = _cell_text(cell, strings)
            if len(text) > CELL_LIMIT:
                raise ValueError(f'Row {number} has a value that is too long.')
            values[index] = text.strip()
            seen = True
        if seen and any(values):
            rows.append(values)
    if not rows:
        raise ValueError('The file has no price rows.')
    header, body = rows[0], rows[1:]
    if header != list(COLUMNS):
        raise ValueError('The file must use the DryScope price template columns.')
    return body


def _column_index(letters):
    if not letters or len(letters) > 2:
        return None
    index = 0
    for letter in letters:
        if not letter.isalpha():
            return None
        index = index * 26 + (ord(letter.upper()) - 64)
    return index - 1


def _cell_text(cell, strings):
    kind = cell.attrib.get('t')
    if kind == 's':
        node = cell.find('m:v', NS)
        value = '' if node is None else node.text or ''
        if not value.isascii() or not value.isdigit() or int(value) >= len(strings):
            raise ValueError('The spreadsheet has an invalid shared string.')
        return strings[int(value)]
    if kind in ('b', 'e', 'str'):
        raise ValueError('Spreadsheet formulas and non-numeric prices are not accepted.')
    if kind == 'inlineStr':
        node = cell.find('m:is/m:t', NS)
        return '' if node is None or node.text is None else node.text
    if kind not in (None, 'n'):
        raise ValueError('Spreadsheet formulas and non-numeric prices are not accepted.')
    node = cell.find('m:v', NS)
    if node is None or node.text is None:
        return ''
    return node.text


def _table_to_rates(rows, company_id, base_version_id, base_generation):
    found = {}
    for offset, values in enumerate(rows, start=2):
        record = dict(zip(COLUMNS, values, strict=True))
        key = record['item_key']
        item = BY_KEY.get(key)
        if item is None:
            raise ValueError(f'Row {offset}, item_key: unknown price row.')
        if key in found:
            raise ValueError(f'Row {offset}, item_key: duplicate price row.')
        if record['template_version'] != TEMPLATE_VERSION:
            raise ValueError(f'Row {offset}: this file is not the current DryScope price template.')
        if record['company_id'] != company_id:
            raise ValueError(f'Row {offset}: this file belongs to a different company.')
        if (
            record['base_version_id'] != base_version_id
            or record['base_generation'] != base_generation
        ):
            raise ValueError(f'Row {offset}: company prices changed. Download a new template.')
        if record['description'] != item['description'] or record['unit'] != item['unit']:
            raise ValueError(f'Row {offset}: description and unit must match the template.')
        if record['currency'] != CURRENCY:
            raise ValueError(f'Row {offset}: currency must be USD.')
        found[key] = record['unit_price']
    missing = [key for key in KEYS if key not in found]
    if missing:
        raise ValueError('The file is missing a price row.')
    return found


def _sheet_xml(rows):
    body = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>']
    body.append(
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
    )
    for r, row in enumerate(rows, start=1):
        body.append(f'<row r="{r}">')
        for c, value in enumerate(row):
            ref = f'{_letters(c)}{r}'
            text = str(value).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
            body.append(f'<c r="{ref}" t="inlineStr"><is><t>{text}</t></is></c>')
        body.append('</row>')
    body.append('</sheetData></worksheet>')
    return ''.join(body)


def _letters(index):
    return chr(ord('A') + index)


_CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>"""

_ROOT_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"""

_WORKBOOK = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Prices" sheetId="1" r:id="rId1"/></sheets>
</workbook>"""

_WORKBOOK_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>"""
