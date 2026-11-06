"""Owner price-book routes. They exist while the feature is off and answer 404, the same way drying watch does."""

import hashlib
import logging
import re

from fastapi import Depends, HTTPException, Query, Request, Response, Security
from pydantic import Field, model_validator

try:
    from .cloud_log import event
    from .contracts import StrictModel
    from .price_books import price_books_enabled
    from .price_book_import import export_csv, export_xlsx, parse_upload
    from .price_table import starter_table, bracket_mode_of, cushion_brackets_of
except ImportError:
    from cloud_log import event
    from contracts import StrictModel
    from price_books import price_books_enabled
    from price_book_import import export_csv, export_xlsx, parse_upload
    from price_table import starter_table, bracket_mode_of, cushion_brackets_of


XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
PRIVATE = {'Cache-Control': 'private, no-store'}


class PricePreviewBody(StrictModel):
    rates: dict[str, str] | None = None
    items: list[dict] | None = None
    policy: dict | None = None
    acknowledgements: list[str] = Field(default_factory=list)
    change_reason: str = Field(min_length=1, max_length=500)
    source: str = 'manual'

    @model_validator(mode='after')
    def check_payload_shape(self):
        has_v1 = self.rates is not None
        has_v2 = self.items is not None or self.policy is not None
        if has_v1 == has_v2:
            raise ValueError('Send either v1 rates or v2 items and policy.')
        if has_v2 and (self.items is None or self.policy is None):
            raise ValueError('Send both items and policy.')
        return self


class PriceWorkingCopyBody(StrictModel):
    items: list[dict]
    policy: dict
    expected_working_version: int | None = Field(default=None, ge=0)
    expected_generation: int | None = Field(default=None, ge=0)
    acknowledgements: list[str] = Field(default_factory=list)


class PriceCalculateBody(StrictModel):
    items: list[dict]
    policy: dict
    acknowledgements: list[str] = Field(default_factory=list)


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

    @app.put('/api/companies/{company_id}/prices/working-copy')
    async def company_save_working_copy(
        company_id: str,
        body: PriceWorkingCopyBody,
        claims=live_identity,
        store=Depends(get_store),
    ):
        return await stored(
            books(store).save_working_copy, claims['uid'], company_id, body.model_dump()
        )

    @app.post('/api/companies/{company_id}/prices/start-v2')
    async def company_start_v2(company_id: str, claims=live_identity, store=Depends(get_store)):
        return await stored(books(store).start_v2, claims['uid'], company_id)

    @app.delete('/api/companies/{company_id}/prices/working-copy')
    async def company_discard_working_copy(
        company_id: str, claims=live_identity, store=Depends(get_store)
    ):
        return await stored(books(store).discard_working_copy, claims['uid'], company_id)

    @app.post('/api/companies/{company_id}/prices/working-copy/discard')
    async def company_post_discard_working_copy(
        company_id: str, claims=live_identity, store=Depends(get_store)
    ):
        return await stored(books(store).discard_working_copy, claims['uid'], company_id)

    @app.post('/api/companies/{company_id}/prices/calculate')
    async def company_calculate(
        company_id: str,
        body: PriceCalculateBody,
        claims=live_identity,
        store=Depends(get_store),
    ):
        await stored(store.quota, claims['uid'], 'price_calculate')
        return await stored(books(store).calculate, claims['uid'], company_id, body.model_dump())

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
        payload = body.model_dump(exclude_none=True)
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
    acknowledgements = [_text(part) for part in parts if part['name'] == 'acknowledgements']
    if len(acknowledgements) == 1 and ',' in acknowledgements[0]:
        acknowledgements = [part.strip() for part in acknowledgements[0].split(',') if part.strip()]
    reasons = [_text(part) for part in parts if part['name'] == 'change_reason']
    return {
        'raw': files[0]['body'],
        'content_type': files[0]['content_type'],
        'change_reason': reasons[0] if reasons else '',
        'acknowledgements': acknowledgements,
        'confirm_zero_prices': any(
            part['name'] == 'confirm_zero_prices' and _text(part) == 'yes' for part in parts
        ),
    }


def _multipart_parts(content_type, body, error='Upload a CSV or XLSX file.'):
    match = re.search(r'boundary="?([^";]+)"?', content_type, re.IGNORECASE)
    if match is None:
        raise HTTPException(400, error)
    boundary = match.group(1).encode('ascii', 'strict')
    if not boundary or len(boundary) > 200:
        raise HTTPException(400, error)
    marker = b'--' + boundary
    if not body.startswith(marker):
        raise HTTPException(400, error)
    parts = []
    cursor = len(marker)
    while len(parts) <= 8:
        if body[cursor : cursor + 2] == b'--':
            return parts
        if body[cursor : cursor + 2] != b'\r\n':
            raise HTTPException(400, error)
        cursor += 2
        end = body.find(b'\r\n' + marker, cursor)
        if end < 0:
            raise HTTPException(400, error)
        header_blob, separator, content = body[cursor:end].partition(b'\r\n\r\n')
        if not separator:
            raise HTTPException(400, error)
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
                }
            )
        cursor = end + 2 + len(marker)
    raise HTTPException(400, 'The upload has too many parts.')


def _text(part):
    return part['body'].decode('utf-8', 'replace').strip()


def _disposition_param(header, name):
    match = re.search(rf'(?:^|;)\s*{name}\s*=\s*"([^"]*)"', header, re.IGNORECASE)
    if match:
        return match.group(1)
    match = re.search(rf'(?:^|;)\s*{name}\s*=\s*([^;]+)', header, re.IGNORECASE)
    return match.group(1).strip() if match else ''


def _import_preview(book, uid, company_id, upload):
    company, base_version, generation, exported = book.export_rows(uid, company_id)
    is_v2 = isinstance(exported, list) or 'items' in exported
    try:
        parsed = parse_upload(
            upload['raw'],
            upload['content_type'],
            company,
            base_version,
            generation,
            calculation_version='dryscope-v2' if is_v2 else None,
        )
    except ValueError:
        event('Price import rejected', logging.INFO, operation='price_book', outcome='rejected')
        raise
    event('Price import parsed', logging.INFO, operation='price_book', outcome='parsed')
    if isinstance(parsed, list) or 'items' in parsed:
        head = book._head(company_id)
        published = book._version(head.get('latest_version_id')) if head else None
        policy = (published or {}).get('policy') or starter_table()['policy']
        if isinstance(parsed, dict):
            policy = dict(policy, range=dict(policy['range']))
            settings = parsed['bracket_policy']
            if settings:
                # Export includes effective defaults. An unchanged round trip must not add
                # optional keys to an existing table and manufacture a new price version.
                if 'bracket_mode' in policy or settings['bracket_mode'] != bracket_mode_of(policy):
                    policy['bracket_mode'] = settings['bracket_mode']
                if 'brackets' in policy['range'] or settings['brackets'] != cushion_brackets_of(
                    policy
                ):
                    policy['range']['brackets'] = settings['brackets']
            parsed = parsed['items']
        zero_rows = [
            item['item_id']
            for item in parsed
            if item['unit_price'] == '0.00'
            or any(band['unit_price'] == '0.00' for band in item.get('price_brackets', []))
        ]
        return book.preview(
            uid,
            company_id,
            {
                'items': parsed,
                'policy': policy,
                'acknowledgements': upload['acknowledgements']
                + (zero_rows if upload['confirm_zero_prices'] else []),
                'change_reason': upload['change_reason'],
                'source': 'import',
                'import_digest': hashlib.sha256(upload['raw']).hexdigest(),
            },
        )
    return book.preview(
        uid,
        company_id,
        {
            'rates': parsed,
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
