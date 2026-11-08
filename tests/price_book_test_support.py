"""Company price books. ADR's output matches its workbook while the feature is off."""

import csv
import io
import logging
from copy import deepcopy
from decimal import Decimal

import pytest
from backend import ai_features, price_books
from backend.claims import PRETEST, proposal_range
from tests.adr_pricing import make_documents, price_scope
from backend.contracts import AIResult, InspectionData
from backend.adr_price_book import adr_rates
from backend.price_book_import import export_csv, parse_upload
from tests.fakes import ADR_PROFILE
from tests.test_backend import sign_payload
from tests.test_workspaces import ID, api, data, store

COPY = 'ADR-INS-' + 'b' * 32


AI = AIResult(summary='Confirmed scope.', suggestions=[], unpriced_work=[])


@pytest.fixture
def enabled():
    price_books.set_enabled(True)
    yield
    price_books.set_enabled(None)


def rates(**changes):
    book = adr_rates()
    book.update(changes)
    return book


def publish(client, book, reason='Trip charge for this company'):
    preview = client.post(
        '/api/companies/adr/prices/preview',
        json={'rates': book, 'acknowledgements': [], 'change_reason': reason},
    )
    assert preview.status_code == 200, preview.text
    body = preview.json()
    if body['no_changes']:
        return body
    saved = client.post(
        '/api/companies/adr/prices/publish',
        json={'preview_id': body['preview_id'], 'expected_generation': body['generation']},
    )
    assert saved.status_code == 200, saved.text
    return saved.json()


STANDALONE = """
import json, sys
import price_books, price_book_store
from workspaces import AccessDenied

price_books.set_enabled(True)
record = json.loads(sys.stdin.read())
from adr_price_book import adr_rates

seed = adr_rates()
pin = dict(
    rates=seed,
    version_id='seed',
    content_sha256=price_books.content_hash(seed),
    calculation_version=price_books.CALCULATION_VERSION,
)


class Workspaces:
    role = 'estimator'

    def company_actor(self, uid, company_id, manage=False, tx=None):
        caps = ['prices_read', 'prices_manage'] if self.role == 'owner' else ['prices_read']
        return dict(company={'company_id': company_id}, capabilities=caps)

    def job_access(self, uid, record, need, tx=None):
        return {'company_id': 'adr'}, {'role': self.role}

    def read(self, collection, key, tx=None):
        if collection == '_job_pricing':
            return pin
        if collection == '_companies':
            return {'company_id': key}
        return None


ws = Workspaces()
books = price_book_store.PriceBookStore(ws)
outcomes = []
for call in (
    lambda: books.preview('u', 'adr', {'rates': seed}),
    lambda: books.reprice_preview('u', record),
):
    try:
        call()
    except AccessDenied:
        outcomes.append('denied')
ws.role = 'owner'
try:
    books.preview('u', 'adr', {'rates': {**seed, 'emergency_call': '1.234'}})
except ValueError:
    outcomes.append('invalid')
outcomes.append(books.reprice_preview('u', record)['after']['itemized'])
print(json.dumps(outcomes))
"""


def counting(monkeypatch):
    import backend.main as bm

    calls = []

    async def generate(schema, *args, **kwargs):
        if schema is AIResult:
            calls.append(schema)
        return AI

    monkeypatch.setattr(bm, 'generate', generate)
    return calls


def daily_audits(store, uid='estimator'):
    return store.db.records.get('_limits/' + uid, {}).get('audit_day', {}).get('count', 0)


def new_window(store, uid='estimator'):
    store.db.records.get('_limits/' + uid, {}).pop('audit_attempt', None)


def _v2_table(unit_price='25.00', extras=False):
    from backend import price_table

    table = price_table.starter_table()
    for item in table['items']:
        if item['enabled']:
            item['unit_price'] = unit_price
        if item['group'] == 'extras':
            item['enabled'] = extras
    return table


@pytest.fixture
def extras_on(monkeypatch):
    monkeypatch.setattr(ai_features, 'AI_FEATURES', {'priced_extras'})


def _publish_v2(client, table, reason='Initial v2 price table', acknowledgements=None):
    preview = client.post(
        '/api/companies/adr/prices/preview',
        json={
            'items': table['items'],
            'policy': table['policy'],
            'acknowledgements': acknowledgements or [],
            'change_reason': reason,
        },
    )
    assert preview.status_code == 200, preview.text
    body = preview.json()
    if body['no_changes']:
        return body
    saved = client.post(
        '/api/companies/adr/prices/publish',
        json={'preview_id': body['preview_id'], 'expected_generation': body['generation']},
    )
    assert saved.status_code == 200, saved.text
    return saved.json()


def _v2_csv(base, generation):
    from backend import price_table

    items = price_table.normalize_table(_v2_table(), publish=True)['items']
    return export_csv('adr', base, generation, items)


def _upload(client, raw):
    return client.post(
        '/api/companies/adr/prices/import-preview',
        files={'file': ('prices.csv', raw, 'text/csv')},
        data={'change_reason': 'Upload owner table'},
    )


def _table_body(table, reason='Move to the owner table'):
    return {'items': table['items'], 'policy': table['policy'], 'change_reason': reason}


def _other_owner_export(client, fmt='csv'):
    exported = client.get(
        '/api/companies/other/prices/export', params={'format': fmt, 'version_id': 'starter'}
    )
    assert exported.status_code == 200, exported.text
    return exported


def _template_rows(raw):
    return list(csv.DictReader(io.StringIO(raw.decode('utf-8-sig'))))


def _priced_template(rows):
    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=list(rows[0]), lineterminator='\n')
    writer.writeheader()
    for row in rows:
        priced = {**row, 'unit_price': '40.00'} if row['enabled'] == 'yes' else row
        if row['group'] == 'extras':
            priced = {**priced, 'enabled': 'no'}
        writer.writerow(priced)
    return out.getvalue().encode('utf-8')


def _working_copy_body(table):
    return {'expected_working_version': 0, 'items': table['items'], 'policy': table['policy']}


def _approved_extra(store):
    from backend.contracts import ExtraApprove

    extra = {'id': 'e' * 32, 'description': 'More drywall', 'hours': '2.00', 'origin': 'manual'}
    record = store.db.records['inspections/' + ID]
    record['data']['extras'] = [extra]
    company = store.db.records['_companies/adr']
    return extra['id'], ExtraApprove(
        expected_revision=record['revision'],
        expected_company_version=company['version'],
        owner_name='Owner',
    )


def _calculate(client, table):
    answer = client.post(
        '/api/companies/adr/prices/calculate',
        json={'items': table['items'], 'policy': table['policy']},
    )
    assert answer.status_code == 200, answer.text
    return {sample['key']: sample for sample in answer.json()['samples']}


def _engine_total(table, key, end):
    from backend import price_table, pricing_v2

    sample = next(row for row in pricing_v2.SAMPLE_JOBS if row['key'] == key)
    data = InspectionData.model_validate(sample['data'])
    normal = price_table.normalize_table(table, publish=False)
    lines, _ = pricing_v2.price_scope(data, normal)
    return pricing_v2.totals(data, lines, normal['policy'], normal['items'])[end]['total']


def _save_working_policy(client, company_id, generation):
    table = _v2_table('25.00')
    table['policy']['overhead_profit_percent'] = '30'
    saved = client.put(
        f'/api/companies/{company_id}/prices/working-copy',
        json={
            'expected_working_version': 0,
            'expected_generation': generation,
            'items': table['items'],
            'policy': table['policy'],
        },
    )
    assert saved.status_code == 200, saved.text


def _wc_body(table, **extra):
    return {
        'items': table['items'],
        'policy': table['policy'],
        'expected_working_version': 0,
        'expected_generation': 0,
        **extra,
    }


def _import_body(raw, boundary, **fields):
    parts = [
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="p.csv"\r\n'
        f'Content-Type: text/csv\r\n\r\n'.encode()
        + raw
        + b'\r\n'
    ]
    parts += [
        f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
        for name, value in fields.items()
    ]
    return b''.join(parts) + f'--{boundary}--\r\n'.encode()
