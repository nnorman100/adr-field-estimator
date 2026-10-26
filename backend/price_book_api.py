"""Owner price-book routes. They exist while the feature is off and answer 404, the same way drying watch does."""

import hashlib
import logging
import re

from fastapi import Depends, HTTPException, Query, Request, Response, Security
from pydantic import Field

try:
    from .cloud_log import event
    from .contracts import StrictModel
    from .price_books import price_books_enabled
    from .price_book_import import export_csv, export_xlsx, parse_upload
except ImportError:
    from cloud_log import event
    from contracts import StrictModel
    from price_books import price_books_enabled
    from price_book_import import export_csv, export_xlsx, parse_upload


XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
PRIVATE = {'Cache-Control': 'private, no-store'}


class PricePreviewBody(StrictModel):
    rates: dict[str, str]
    acknowledgements: list[str] = Field(default_factory=list)
    change_reason: str = Field(min_length=1, max_length=500)
    source: str = 'manual'


class PricePublishBody(StrictModel):
    preview_id: str = Field(pattern=r'^[a-f0-9]{16,64}$')
    expected_generation: int = Field(ge=0)


class PriceRestoreBody(StrictModel):
    change_reason: str = Field(min_length=1, max_length=500)


class JobRepriceBody(StrictModel):
    expected_revision: int = Field(ge=1)
    expected_pin_hash: str = Field(pattern=r'^[a-f0-9]{64}$')
    destination_version_id: str = Field(min_length=1, max_length=128)
    destination_hash: str = Field(pattern=r'^[a-f0-9]{64}$')


def _workspaces_on():
    try:
        from . import main as backend_main
    except ImportError:
        import main as backend_main
    return backend_main.WORKSPACES_ENABLED


def register_price_book_routes(app, identity, get_store, stored, live):
    live_identity = Security(identity, scopes=live)

    def books(store):
        if (
            not _workspaces_on()
            or not price_books_enabled()
            or not getattr(store, 'workspaces', None)
        ):
            raise HTTPException(404, 'Company prices are not enabled.')
        return store.workspaces.prices

    def support_then(store, uid, company_id):
        if not getattr(store, 'workspaces', None):
            raise HTTPException(404, 'Company prices are not enabled.')
        return store.workspaces

    @app.get('/api/companies/{company_id}/prices')
    async def company_prices(company_id: str, claims=live_identity, store=Depends(get_store)):
        return await stored(books(store).read_company, claims['uid'], company_id)

    @app.get('/api/companies/{company_id}/prices/versions')
    async def company_versions(company_id: str, claims=live_identity, store=Depends(get_store)):
        return await stored(books(store).versions, claims['uid'], company_id)

    @app.get('/api/companies/{company_id}/prices/versions/{version_id}')
    async def company_version(
        company_id: str, version_id: str, claims=live_identity, store=Depends(get_store)
    ):
        return await stored(books(store).one_version, claims['uid'], company_id, version_id)

    @app.get('/api/companies/{company_id}/prices/history')
    async def company_history(company_id: str, claims=live_identity, store=Depends(get_store)):
        return await stored(books(store).history, claims['uid'], company_id)

    @app.get('/api/companies/{company_id}/prices/export')
    async def company_export(
        company_id: str,
        format: str = Query(default='csv', pattern='^(csv|xlsx)$'),
        version_id: str | None = Query(default=None, max_length=128),
        claims=live_identity,
        store=Depends(get_store),
    ):
        return await _export(
            books(store), claims['uid'], company_id, format, version_id, False, stored
        )

    @app.post('/api/companies/{company_id}/prices/preview')
    async def company_preview(
        company_id: str, body: PricePreviewBody, claims=live_identity, store=Depends(get_store)
    ):
        await stored(store.quota, claims['uid'], 'price_preview')
        payload = body.model_dump()
        payload['source'] = 'manual'
        return await stored(books(store).preview, claims['uid'], company_id, payload)

    @app.post('/api/companies/{company_id}/prices/import-preview')
    async def company_import(
        company_id: str, request: Request, claims=live_identity, store=Depends(get_store)
    ):
        await stored(store.quota, claims['uid'], 'price_preview')
        return await stored(
            _import_preview, books(store), claims['uid'], company_id, await _upload(request)
        )

    @app.post('/api/companies/{company_id}/prices/publish')
    async def company_publish(
        company_id: str, body: PricePublishBody, claims=live_identity, store=Depends(get_store)
    ):
        return await stored(
            books(store).publish,
            claims['uid'],
            company_id,
            body.preview_id,
            body.expected_generation,
        )

    @app.post('/api/companies/{company_id}/prices/versions/{version_id}/restore')
    async def company_restore(
        company_id: str,
        version_id: str,
        body: PriceRestoreBody,
        claims=live_identity,
        store=Depends(get_store),
    ):
        await stored(store.quota, claims['uid'], 'price_preview')
        return await stored(
            books(store).restore_preview, claims['uid'], company_id, version_id, body.change_reason
        )

    @app.get('/api/admin/companies/{company_id}/prices')
    async def support_prices(company_id: str, claims=live_identity, store=Depends(get_store)):
        await stored(
            support_then(store, claims['uid'], company_id).support_company,
            claims['uid'],
            company_id,
        )
        return await stored(books(store).read_company, claims['uid'], company_id)

    @app.get('/api/admin/companies/{company_id}/prices/versions')
    async def support_versions(company_id: str, claims=live_identity, store=Depends(get_store)):
        await stored(
            support_then(store, claims['uid'], company_id).support_company,
            claims['uid'],
            company_id,
        )
        return await stored(books(store).versions, claims['uid'], company_id, True)

    @app.get('/api/admin/companies/{company_id}/prices/versions/{version_id}')
    async def support_version(
        company_id: str, version_id: str, claims=live_identity, store=Depends(get_store)
    ):
        await stored(
            support_then(store, claims['uid'], company_id).support_company,
            claims['uid'],
            company_id,
        )
        return await stored(books(store).one_version, claims['uid'], company_id, version_id, True)

    @app.get('/api/admin/companies/{company_id}/prices/history')
    async def support_history(company_id: str, claims=live_identity, store=Depends(get_store)):
        await stored(
            support_then(store, claims['uid'], company_id).support_company,
            claims['uid'],
            company_id,
        )
        return await stored(books(store).history, claims['uid'], company_id, True)

    @app.get('/api/admin/companies/{company_id}/prices/export')
    async def support_export(
        company_id: str,
        format: str = Query(default='csv', pattern='^(csv|xlsx)$'),
        version_id: str | None = Query(default=None, max_length=128),
        claims=live_identity,
        store=Depends(get_store),
    ):
        await stored(
            support_then(store, claims['uid'], company_id).support_company,
            claims['uid'],
            company_id,
        )
        return await _export(
            books(store), claims['uid'], company_id, format, version_id, True, stored
        )

    @app.get('/api/inspections/{inspection_id}/pricing')
    async def job_pricing(inspection_id: str, claims=live_identity, store=Depends(get_store)):
        record = await stored(store.get_inspection, claims['uid'], inspection_id)
        return await stored(books(store).job_view, claims['uid'], record)

    @app.post('/api/inspections/{inspection_id}/pricing/reprice-preview')
    async def job_reprice_preview(
        inspection_id: str, claims=live_identity, store=Depends(get_store)
    ):
        record = await stored(store.get_inspection, claims['uid'], inspection_id)
        return await stored(books(store).reprice_preview, claims['uid'], record)

    @app.post('/api/inspections/{inspection_id}/pricing/reprice')
    async def job_reprice(
        inspection_id: str, body: JobRepriceBody, claims=live_identity, store=Depends(get_store)
    ):
        record = await stored(books(store).reprice, claims['uid'], inspection_id, body.model_dump())
        try:
            from .main import draft_record
        except ImportError:
            from main import draft_record
        return await draft_record(store, claims['uid'], record)


async def _upload(request: Request):
    """Reads one multipart file without python-multipart. The catalog still validates the bytes."""
    content_type = request.headers.get('content-type', '')
    if 'multipart/form-data' not in content_type.lower():
        raise HTTPException(400, 'Upload a CSV or XLSX file.')
    parts = _multipart_parts(content_type, await request.body())
    files = [part for part in parts if part['name'] == 'file']
    if len(files) != 1 or not files[0]['body']:
        raise HTTPException(400, 'Upload a CSV or XLSX file.')
    acknowledgements = [part['text'] for part in parts if part['name'] == 'acknowledgements']
    if len(acknowledgements) == 1 and ',' in acknowledgements[0]:
        acknowledgements = [part.strip() for part in acknowledgements[0].split(',') if part.strip()]
    reasons = [part['text'] for part in parts if part['name'] == 'change_reason']
    return {
        'raw': files[0]['body'],
        'content_type': files[0]['content_type'],
        'change_reason': reasons[0] if reasons else '',
        'acknowledgements': acknowledgements,
    }


def _multipart_parts(content_type, body):
    match = re.search(r'boundary="?([^";]+)"?', content_type, re.IGNORECASE)
    if match is None:
        raise HTTPException(400, 'Upload a CSV or XLSX file.')
    boundary = match.group(1).encode('ascii', 'strict')
    if not boundary or len(boundary) > 200:
        raise HTTPException(400, 'Upload a CSV or XLSX file.')
    marker = b'--' + boundary
    if not body.startswith(marker):
        raise HTTPException(400, 'Upload a CSV or XLSX file.')
    parts = []
    cursor = len(marker)
    while len(parts) <= 8:
        if body[cursor : cursor + 2] == b'--':
            return parts
        if body[cursor : cursor + 2] != b'\r\n':
            raise HTTPException(400, 'Upload a CSV or XLSX file.')
        cursor += 2
        end = body.find(b'\r\n' + marker, cursor)
        if end < 0:
            raise HTTPException(400, 'Upload a CSV or XLSX file.')
        header_blob, separator, content = body[cursor:end].partition(b'\r\n\r\n')
        if not separator:
            raise HTTPException(400, 'Upload a CSV or XLSX file.')
        headers = {}
        for line in header_blob.split(b'\r\n'):
            name, found, value = line.partition(b':')
            if found:
                headers[name.decode('latin1').strip().lower()] = value.decode('latin1').strip()
        disposition = headers.get('content-disposition', '')
        field = _disposition_param(disposition, 'name')
        if field:
            parts.append(
                {
                    'name': field,
                    'content_type': headers.get('content-type', '').split(';', 1)[0].strip(),
                    'body': content,
                    'text': content.decode('utf-8', 'replace').strip(),
                }
            )
        cursor = end + 2 + len(marker)
    raise HTTPException(400, 'The upload has too many parts.')


def _disposition_param(header, name):
    match = re.search(rf'(?:^|;)\s*{name}\s*=\s*"([^"]*)"', header, re.IGNORECASE)
    if match:
        return match.group(1)
    match = re.search(rf'(?:^|;)\s*{name}\s*=\s*([^;]+)', header, re.IGNORECASE)
    return match.group(1).strip() if match else ''


def _import_preview(book, uid, company_id, upload):
    company, base_version, generation, _rates = book.export_rows(uid, company_id)
    try:
        rates = parse_upload(
            upload['raw'], upload['content_type'], company, base_version, generation
        )
    except ValueError:
        event('Price import rejected', logging.INFO, operation='price_book', outcome='rejected')
        raise
    event('Price import parsed', logging.INFO, operation='price_book', outcome='parsed')
    return book.preview(
        uid,
        company_id,
        {
            'rates': rates,
            'acknowledgements': upload['acknowledgements'],
            'change_reason': upload['change_reason'],
            'source': 'import',
            'import_digest': hashlib.sha256(upload['raw']).hexdigest(),
        },
    )


async def _export(book, uid, company_id, fmt, version_id, support, stored):
    company, base_version, generation, rates = await stored(
        book.export_rows, uid, company_id, version_id, support
    )
    if fmt == 'xlsx':
        body, media, name = (
            export_xlsx(company, base_version, generation, rates),
            XLSX_TYPE,
            'company-prices.xlsx',
        )
    else:
        body, media, name = (
            export_csv(company, base_version, generation, rates),
            'text/csv; charset=utf-8',
            'company-prices.csv',
        )
    return Response(
        body,
        media_type=media,
        headers={**PRIVATE, 'Content-Disposition': f'attachment; filename="{name}"'},
    )
