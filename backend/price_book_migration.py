"""Write ADR's own rates as ADR's price book and pin ADR's unsigned drafts. Dry-run writes nothing.

Only ADR has a starting book: every other company publishes its own prices, and naming one here
is refused. Signed inspections, authorizations, evidence and company identity versions are not written.
A draft that still carries a legacy package price is left unpinned. An audited draft keeps its
documents and proposal hash; the seed basis is recorded beside them so the draft stays signable.
"""

import hashlib
import json

try:
    from .adr_price_book import ADR_COMPANY_ID, adr_rates
    from .inspection_store import now
    from .price_books import (
        CALCULATION_VERSION,
        CATALOG_VERSION,
        CURRENCY,
        content_hash,
        saved_basis,
    )
except ImportError:
    from adr_price_book import ADR_COMPANY_ID, adr_rates
    from inspection_store import now
    from price_books import (
        CALCULATION_VERSION,
        CATALOG_VERSION,
        CURRENCY,
        content_hash,
        saved_basis,
    )

HEAD = '_company_price_books'
VERSIONS = '_price_book_versions'
PINS = '_job_pricing'
MIGRATION_ID = 'price-books-v1'


def _two(value):
    text = f'{value}'.strip()
    if not text:
        return ''
    if '.' not in text:
        return text + '.00'
    whole, fraction = text.split('.', 1)
    return whole + '.' + (fraction + '00')[:2]


def planned_rates(company):
    if company.get('company_id') != ADR_COMPANY_ID:
        raise ValueError('Only ADR has a starting price book. Other companies set their own.')
    rates = adr_rates()
    profile_rate = (company.get('profile') or {}).get('additional_work_rate')
    if profile_rate:
        rates['additional_work_hourly'] = _two(profile_rate)
    return rates


def _read(db, collection, identifier):
    snapshot = db.collection(collection).document(identifier).get()
    return snapshot.to_dict() if snapshot.exists else None


def _legacy_audit(inspection):
    audit = inspection.get('audit')
    return bool(audit) and not saved_basis(audit)


def build_plan(db, company_ids):
    if not company_ids:
        raise ValueError('Name at least one company.')
    if set(company_ids) != {ADR_COMPANY_ID}:
        raise ValueError('Only ADR has a starting price book. Other companies set their own.')
    priced_at = now()
    companies = []
    pins = []
    ambiguous = []
    signed = 0
    for company_id in company_ids:
        company = _read(db, '_companies', company_id)
        if not company:
            raise LookupError('Company not found.')
        rates = planned_rates(company)
        digest = content_hash(rates)
        head = _read(db, HEAD, company_id)
        version_id = f'migrate-{company_id}-v1'
        current = None
        if head and head.get('latest_version_id'):
            current = _read(db, VERSIONS, head['latest_version_id'])
            if not current:
                raise RuntimeError('The company price book is incomplete.')
            published = current.get('rates', {}).get('additional_work_hourly')
            if published != rates['additional_work_hourly']:
                raise RuntimeError(
                    'The company additional-work rate changed after its price book was published.'
                )
            companies.append(
                {
                    'company_id': company_id,
                    'action': 'noop',
                    'version_id': head['latest_version_id'],
                    'content_sha256': current.get('content_sha256', ''),
                }
            )
            if current.get('content_sha256') == digest:
                pin_version, pin_rates, pin_hash, pin_sequence = (
                    head['latest_version_id'],
                    current['rates'],
                    digest,
                    current.get('sequence', 0),
                )
            else:
                # A later price change stays on the book. Existing drafts keep the base values.
                pin_version, pin_rates, pin_hash, pin_sequence = 'seed', rates, digest, 0
        else:
            companies.append(
                {
                    'company_id': company_id,
                    'action': 'create',
                    'version_id': version_id,
                    'content_sha256': digest,
                    'rates': rates,
                }
            )
            pin_version, pin_rates, pin_hash, pin_sequence = version_id, rates, digest, 0
        for snapshot in db.collection('_workspace_jobs').stream():
            job = snapshot.to_dict() or {}
            if job.get('company_id') != company_id or job.get('kind') not in (None, 'inspection'):
                continue
            inspection_id = job.get('job_id')
            if not inspection_id:
                continue
            if job.get('auth_exists') or job.get('status') == 'signed':
                signed += 1
                continue
            inspection = _read(db, 'inspections', inspection_id)
            if not inspection or inspection.get('status') == 'signed':
                signed += 1
                continue
            if (inspection.get('data') or {}).get('package_price') is not None:
                ambiguous.append(inspection_id)
                continue
            pin = _read(db, PINS, inspection_id)
            if pin:
                pins.append({'inspection_id': inspection_id, 'action': 'noop'})
                continue
            row = {
                'inspection_id': inspection_id,
                'action': 'create',
                'company_id': company_id,
                'version_id': pin_version,
                'sequence': pin_sequence,
                'content_sha256': pin_hash,
                'rates': pin_rates,
                'priced_at': priced_at,
                'audit_basis': None,
            }
            if _legacy_audit(inspection):
                row['audit_basis'] = {
                    'company_id': company_id,
                    'version_id': pin_version,
                    'sequence': pin_sequence,
                    'content_sha256': pin_hash,
                    'calculation_version': CALCULATION_VERSION,
                    'priced_at': priced_at,
                    'rates': dict(pin_rates),
                }
            pins.append(row)
    return {
        'companies': companies,
        'pins': pins,
        'ambiguous': ambiguous,
        'signed_left_untouched': signed,
    }


def summary(plan):
    """Counts and content hashes only. No addresses, names or prices."""
    return {
        'companies': len(plan['companies']),
        'books_to_create': sum(1 for row in plan['companies'] if row['action'] == 'create'),
        'books_unchanged': sum(1 for row in plan['companies'] if row['action'] == 'noop'),
        'pins_to_create': sum(1 for row in plan['pins'] if row['action'] == 'create'),
        'pins_unchanged': sum(1 for row in plan['pins'] if row['action'] == 'noop'),
        'audit_bases_to_record': sum(1 for row in plan['pins'] if row.get('audit_basis')),
        'ambiguous_drafts': len(plan['ambiguous']),
        'signed_left_untouched': plan['signed_left_untouched'],
        'content_hashes': sorted(
            {row['content_sha256'] for row in plan['companies'] if row.get('content_sha256')}
        ),
    }


def source_fingerprints(db):
    result = {}
    for collection in ('inspections', 'authorizations'):
        for snapshot in db.collection(collection).stream():
            data = snapshot.to_dict() or {}
            if collection == 'inspections' and isinstance(data.get('audit'), dict):
                audit = {key: value for key, value in data['audit'].items() if key != 'price_basis'}
                data = {**data, 'audit': audit}
            if getattr(snapshot, 'reference', None) is not None:
                key = snapshot.reference.path
            else:
                identifier = data.get('inspection_id') or data.get('auth_id')
                key = f'{collection}/{identifier}'
            encoded = json.dumps(data, sort_keys=True, separators=(',', ':'), default=str).encode()
            result[key] = hashlib.sha256(encoded).hexdigest()
    return result


def apply_plan(store, plan, write):
    """write False returns the summary and does not call the transaction.

    `store` is a CompanyInspectionStore or a WorkspaceStore.
    """
    if not write:
        return summary(plan)
    ws = store.workspaces if hasattr(store, 'workspaces') else store

    def commit(tx):
        heads = {}
        for row in plan['companies']:
            company_id = row['company_id']
            company = ws.read('_companies', company_id, tx)
            if not company:
                raise RuntimeError('The company no longer exists.')
            heads[company_id] = ws.read(HEAD, company_id, tx)
            current_version = (heads[company_id] or {}).get('latest_version_id')
            if current_version and current_version != row['version_id']:
                raise RuntimeError('The company price book changed after planning.')
            if (
                row['action'] == 'create'
                and content_hash(planned_rates(company)) != row['content_sha256']
            ):
                raise RuntimeError('The company additional-work rate changed after planning.')
        eligible = []
        for row in plan['pins']:
            if row['action'] != 'create':
                continue
            identifier = row['inspection_id']
            pin = ws.read(PINS, identifier, tx)
            job = ws.read('_workspace_jobs', identifier, tx)
            inspection = ws.read('inspections', identifier, tx)
            if pin:
                continue
            if (
                not job
                or not inspection
                or job.get('company_id') != row['company_id']
                or job.get('job_id') != identifier
                or job.get('kind') not in (None, 'inspection')
                or job.get('auth_exists')
                or job.get('status') == 'signed'
                or inspection.get('status') == 'signed'
                or (inspection.get('data') or {}).get('package_price') is not None
                or _legacy_audit(inspection) != bool(row.get('audit_basis'))
            ):
                raise RuntimeError('The draft changed after migration planning.')
            company = ws.read('_companies', row['company_id'], tx)
            if (
                planned_rates(company)['additional_work_hourly']
                != row['rates']['additional_work_hourly']
            ):
                raise RuntimeError('The company additional-work rate changed after planning.')
            eligible.append((row, inspection))
        for row in plan['companies']:
            if row['action'] != 'create':
                continue
            company_id = row['company_id']
            head = heads[company_id]
            if head and head.get('latest_version_id'):
                continue
            published = now()
            version = {
                'version_id': row['version_id'],
                'company_id': company_id,
                'sequence': 0,
                'parent_version_id': None,
                'catalog_version': CATALOG_VERSION,
                'calculation_version': CALCULATION_VERSION,
                'currency': CURRENCY,
                'rates': row['rates'],
                'content_sha256': row['content_sha256'],
                'published_by_uid': '',
                'published_at': None,
                'effective_from': None,
                'source': 'seed',
                'change_reason': 'Workbook seed',
                'import_digest': None,
            }
            tx.create(ws.ref(VERSIONS, row['version_id']), version)
            tx.set(
                ws.ref(HEAD, company_id),
                {
                    'company_id': company_id,
                    'schema_version': 1,
                    'generation': 0,
                    'latest_version_id': row['version_id'],
                    'next_sequence': 1,
                    'started_at': published,
                    'updated_at': published,
                },
            )
        for row, inspection in eligible:
            tx.create(
                ws.ref(PINS, row['inspection_id']),
                {
                    'inspection_id': row['inspection_id'],
                    'company_id': row['company_id'],
                    'pin_version': 1,
                    'version_id': row['version_id'],
                    'sequence': row.get('sequence', 0),
                    'content_sha256': row['content_sha256'],
                    'calculation_version': CALCULATION_VERSION,
                    'rates': dict(row['rates']),
                    'priced_at': row['priced_at'],
                    'reason': 'legacy_rollout',
                },
            )
            if row.get('audit_basis'):
                tx.update(
                    ws.ref('inspections', row['inspection_id']),
                    {'audit': {**inspection['audit'], 'price_basis': row['audit_basis']}},
                )

    ws._run(commit)
    return summary(plan)
