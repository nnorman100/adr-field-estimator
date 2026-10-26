"""Seed one price book per named company and pin unsigned drafts. Dry-run writes nothing.

Signed inspections, authorizations, evidence and company identity versions are not written.
A draft that still carries a legacy package price is left unpinned.
"""

import hashlib
import json

try:
    from .inspection_store import now
    from .price_books import (
        CALCULATION_VERSION,
        CATALOG_VERSION,
        CURRENCY,
        content_hash,
        seed_rates,
    )
except ImportError:
    from inspection_store import now
    from price_books import CALCULATION_VERSION, CATALOG_VERSION, CURRENCY, content_hash, seed_rates

HEAD = '_company_price_books'
VERSIONS = '_price_book_versions'
PINS = '_job_pricing'


def _two(value):
    text = f'{value}'.strip()
    if not text:
        return ''
    if '.' not in text:
        return text + '.00'
    whole, fraction = text.split('.', 1)
    return whole + '.' + (fraction + '00')[:2]


def planned_rates(company):
    rates = seed_rates()
    profile_rate = (company.get('profile') or {}).get('additional_work_rate')
    if profile_rate:
        rates['additional_work_hourly'] = _two(profile_rate)
    elif company.get('company_id') != 'adr':
        rates['additional_work_hourly'] = ''
    return rates


def _read(db, collection, identifier):
    snapshot = db.collection(collection).document(identifier).get()
    return snapshot.to_dict() if snapshot.exists else None


def build_plan(db, company_ids):
    if not company_ids:
        raise ValueError('Name at least one company.')
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
                    current.get('sequence', 1),
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
            pin_version, pin_rates, pin_hash, pin_sequence = version_id, rates, digest, 1
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
            pins.append(
                {
                    'inspection_id': inspection_id,
                    'action': 'create',
                    'company_id': company_id,
                    'version_id': pin_version,
                    'sequence': pin_sequence,
                    'content_sha256': pin_hash,
                    'rates': pin_rates,
                }
            )
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
        for row in plan['companies']:
            if row['action'] != 'create':
                continue
            company_id = row['company_id']
            head = ws.read(HEAD, company_id, tx)
            if head and head.get('latest_version_id'):
                continue
            published = now()
            version = {
                'version_id': row['version_id'],
                'company_id': company_id,
                'sequence': 1,
                'parent_version_id': None,
                'catalog_version': CATALOG_VERSION,
                'calculation_version': CALCULATION_VERSION,
                'currency': CURRENCY,
                'rates': row['rates'],
                'content_sha256': row['content_sha256'],
                'published_by_uid': '',
                'published_at': published,
                'effective_from': published,
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
                    'generation': 1,
                    'latest_version_id': row['version_id'],
                    'next_sequence': 2,
                    'updated_at': published,
                },
            )
        for row in plan['pins']:
            if row['action'] != 'create':
                continue
            if ws.read(PINS, row['inspection_id'], tx):
                continue
            tx.create(
                ws.ref(PINS, row['inspection_id']),
                {
                    'inspection_id': row['inspection_id'],
                    'company_id': row['company_id'],
                    'pin_version': 1,
                    'version_id': row['version_id'],
                    'sequence': row.get('sequence') or 1,
                    'content_sha256': row['content_sha256'],
                    'calculation_version': CALCULATION_VERSION,
                    'rates': dict(row['rates']),
                    'priced_at': now(),
                    'reason': 'legacy_rollout',
                },
            )

    ws._run(commit)
    return summary(plan)
