"""Immutable company price books, job pins and owner publication.

Client Firestore access stays denied. Every check here is server authorization.
Publication does not change the company identity version.
"""

import logging
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from google.cloud import firestore

try:
    from .adr_price_book import ADR_COMPANY_ID, adr_rates, foreign_adr_rates
    from .claims import price_scope, proposal_range
    from .cloud_log import event
    from .contracts import InspectionData
    from .inspection_store import Conflict, now
    from .price_books import (
        CALCULATION_VERSION,
        CATALOG_VERSION,
        CURRENCY,
        KEYS,
        blank_rates,
        calculation_policy,
        content_hash,
        diff_rates,
        label_for,
        normalize_rates,
        price_books_enabled,
        price_display,
        public_rates,
        reason_text,
        sample_totals,
        saved_basis,
    )
    from .workspaces import AccessDenied
except ImportError:
    from adr_price_book import ADR_COMPANY_ID, adr_rates, foreign_adr_rates
    from claims import price_scope, proposal_range
    from cloud_log import event
    from contracts import InspectionData
    from inspection_store import Conflict, now
    from price_books import (
        CALCULATION_VERSION,
        CATALOG_VERSION,
        CURRENCY,
        KEYS,
        blank_rates,
        calculation_policy,
        content_hash,
        diff_rates,
        label_for,
        normalize_rates,
        price_books_enabled,
        price_display,
        public_rates,
        reason_text,
        sample_totals,
        saved_basis,
    )
    from workspaces import AccessDenied

PREVIEW_MINUTES = 30
HEAD = '_company_price_books'
VERSIONS = '_price_book_versions'
PINS = '_job_pricing'
PREVIEWS = '_price_book_previews'
DOMAIN = 'pricing'


class Expired(Exception):
    """A price preview can no longer be published."""


def _not_set_message(role):
    if role != 'owner':
        return 'Ask your company owner to set company prices before the first estimate.'
    if price_books_enabled():
        return (
            'Set your company prices before your first estimate. Open Company prices from the menu.'
        )
    return 'Set your company prices before your first estimate. Contact support to turn on Company prices.'


def _refuse_adr_rates(company_id, rates):
    if foreign_adr_rates(company_id, rates):
        raise Conflict('These saved prices cannot be used for this company. Contact support.')


def _shown_reason(version):
    """Only an owner's publication has a reason to show. The label names a starting book."""
    return version.get('change_reason', '') if version.get('sequence') else ''


def _is_unset(book):
    return book.get('source') == 'unset'


def _profile_rate(company, rates):
    """An additional-work rate the company set on its profile is its own, so it is kept."""
    profile_rate = (company.get('profile') or {}).get('additional_work_rate')
    if profile_rate:
        rates['additional_work_hourly'] = _two(profile_rate)
    return rates


def _adr_starting_rates(company):
    """ADR's starting book for ADR's unpublished and legacy records. No other company has one."""
    if company.get('company_id') != ADR_COMPANY_ID:
        raise LookupError('Price version not found.')
    return _profile_rate(company, adr_rates())


class PriceBookStore:
    def __init__(self, workspaces):
        self.ws = workspaces
        # Tests set this to raise after the transaction has staged writes.
        self._before_event = None

    def _require(self):
        if not price_books_enabled():
            raise LookupError('Company prices are not enabled.')

    def _run(self, callback):
        return self.ws._run(callback)

    def _head(self, company_id, tx=None):
        return self.ws.read(HEAD, company_id, tx)

    def _version(self, version_id, tx=None):
        if not version_id:
            return None
        return self.ws.read(VERSIONS, version_id, tx)

    def _pin(self, inspection_id, tx=None):
        return self.ws.read(PINS, inspection_id, tx)

    def effective(self, company, tx=None):
        """The book used for a new pin or a new additional-work approval.

        A company with no published book has no prices: every row is blank and pricing is
        blocked. ADR alone starts from its own book in adr_price_book.py until its migrated
        version exists.
        """
        company_id = company['company_id']
        head = self._head(company_id, tx)
        generation = 0
        if head and head.get('latest_version_id'):
            version = self._version(head['latest_version_id'], tx)
            if (
                not version
                or version.get('company_id') != company_id
                or version.get('calculation_version') != CALCULATION_VERSION
                or version.get('content_sha256') != content_hash(version['rates'])
            ):
                raise Conflict('This company price book cannot be used. Contact support.')
            # ADR's rates held by another company do not count as that company's prices.
            if not foreign_adr_rates(company_id, version['rates']):
                return {**version, 'generation': head['generation']}
            generation = head['generation']
        if company_id != ADR_COMPANY_ID:
            rates = _profile_rate(company, blank_rates())
            return {
                'version_id': 'unset',
                'company_id': company_id,
                'sequence': 0,
                'rates': rates,
                'content_sha256': content_hash(rates),
                'calculation_version': CALCULATION_VERSION,
                'generation': generation,
                'published_at': None,
                'effective_from': None,
                'source': 'unset',
            }
        rates = _adr_starting_rates(company)
        return {
            'version_id': 'seed',
            'company_id': company_id,
            'sequence': 0,
            'rates': rates,
            'content_sha256': content_hash(rates),
            'calculation_version': CALCULATION_VERSION,
            'generation': 0,
            'published_at': None,
            'effective_from': None,
            'source': 'seed',
        }

    def session_view(self, actor):
        """What the app shows a member outside the price editor, for their own company only."""
        view = {'prices_set': None, 'price_display': None, 'prices_not_set_message': None}
        if not actor.get('company'):
            return view
        try:
            book = self.effective(actor['company'])
        except Conflict:
            # The audit reports a damaged book. It must not stop the whole app from loading.
            return {**view, 'prices_set': True}
        if _is_unset(book):
            return {
                **view,
                'prices_set': False,
                'prices_not_set_message': _not_set_message(actor.get('role')),
            }
        return {**view, 'prices_set': True, 'price_display': price_display(book['rates'])}

    def _actor_name(self, company_id, uid, tx=None):
        member = self.ws.read('_memberships', uid, tx) if uid else None
        if member and member.get('company_id') == company_id and member.get('status') == 'active':
            return {'owner': 'Owner', 'estimator': 'Estimator', 'office': 'Office staff'}.get(
                member.get('role'), 'Former member'
            )
        return 'Former member'

    def _view(self, actor, company, support=False):
        book = self.effective(company)
        manage = (not support) and actor.get('role') == 'owner'
        try:
            from . import ai_features
        except ImportError:
            import ai_features
        extras = ai_features.enabled('priced_extras')
        reason = _shown_reason(book)
        unset = _is_unset(book)
        return {
            'company_id': company['company_id'],
            'company_name': (company.get('profile') or {}).get('name', ''),
            'generation': book['generation'],
            'version_id': book['version_id'],
            'sequence': book['sequence'],
            'prices_set': not unset,
            'label': label_for(book['sequence'], company['company_id']),
            'published_at': book.get('published_at'),
            'effective_from': book.get('effective_from'),
            'source': book.get('source', 'seed'),
            'change_reason': reason if manage or support else '',
            'calculation': calculation_policy(),
            'priced_extras': extras,
            'can_manage': manage,
            'rates': public_rates(book['rates'], editable_additional_work=extras),
            'used_for': _not_set_message(actor.get('role') if not support else None)
            if unset
            else 'New pricing uses these rates. Existing jobs keep their saved rates.',
        }

    def read_company(self, uid, company_id):
        self._require()
        actor = self.ws.principal(uid)
        support = self.ws.supported(actor, company_id)
        if support:
            company = self.ws.support_company(uid, company_id)
            self._support_read(uid, company_id, 'view_prices')
            view = self._view(actor, company, support=True)
            view['can_manage'] = False
            return view
        actor = self.ws.company_actor(uid, company_id)
        if 'prices_read' not in actor['capabilities']:
            raise AccessDenied('Your role cannot view company prices.')
        company = self.ws.read('_companies', company_id)
        return self._view(actor, company)

    def _support_read(self, uid, company_id, action):
        def audit(tx):
            self.ws.support_company(uid, company_id, tx)
            self._event(tx, uid, 'support_' + action, company_id, {})

        self._run(audit)

    def _event(self, tx, uid, action, company_id, details, target=None):
        if self._before_event:
            self._before_event()
        identifier = uuid4().hex
        entry = dict(
            event_id=identifier,
            actor_uid=uid,
            action=action,
            company_id=company_id,
            domain=DOMAIN,
            details=details,
            created_at=now(),
        )
        if target:
            entry['target'] = target
        tx.create(self.ws.ref('_admin_events', identifier), entry)
        return entry

    def _locked_keys(self):
        try:
            from . import ai_features
        except ImportError:
            import ai_features
        if ai_features.enabled('priced_extras'):
            return ()
        return ('additional_work_hourly',)

    def _normalize(self, company, incoming, acknowledgements):
        current = self.effective(company)['rates']
        return normalize_rates(
            incoming,
            acknowledgements,
            locked=self._locked_keys(),
            current=current,
        )

    def preview(self, uid, company_id, payload):
        self._require()
        actor = self.ws.company_actor(uid, company_id, manage=True)
        company = actor['company']
        if 'prices_manage' not in actor['capabilities']:
            raise AccessDenied('Only the company owner can change prices.')
        rates = self._normalize(company, payload['rates'], payload.get('acknowledgements') or [])
        _refuse_adr_rates(company['company_id'], rates)
        reason = reason_text(payload.get('change_reason', ''))
        book = self.effective(company)
        rows, warnings = diff_rates(book['rates'], rates)
        preview_id = uuid4().hex
        body = {
            'preview_id': preview_id,
            'company_id': company['company_id'],
            'actor_uid': uid,
            'base_generation': book['generation'],
            'base_version_id': book['version_id'],
            'rates': rates,
            'content_sha256': content_hash(rates),
            'acknowledgements': list(payload.get('acknowledgements') or []),
            'change_reason': reason,
            'warnings': warnings,
            'diff': rows,
            'no_changes': not rows,
            'sample_before': None if _is_unset(book) else sample_totals(book['rates']),
            'sample_after': sample_totals(rates),
            'source': payload.get('source') or 'manual',
            'import_digest': payload.get('import_digest'),
            'created_at': now(),
            'expires': (
                datetime.now(timezone.utc) + timedelta(minutes=PREVIEW_MINUTES)
            ).isoformat(),
        }

        def create(tx):
            self.ws.company_actor(uid, company_id, manage=True, tx=tx)
            tx.create(self.ws.ref(PREVIEWS, preview_id), body)

        self._run(create)
        event('Price preview stored', logging.INFO, operation='price_book', outcome='preview')
        return self._preview_response(body, book)

    def _preview_response(self, body, book):
        return {
            'preview_id': None if body['no_changes'] else body['preview_id'],
            'no_changes': body['no_changes'],
            'generation': body['base_generation'],
            'base_version_id': body['base_version_id'],
            'expires': body['expires'],
            'diff': body['diff'],
            'warnings': body['warnings'],
            'sample_before': body['sample_before'],
            'sample_after': body['sample_after'],
            'label': label_for(book['sequence'], body['company_id']),
            'effect': 'New pricing uses these rates from the time of publication. Existing jobs keep their saved rates.',
        }

    def _load_preview(self, preview_id, company_id, uid, tx):
        preview = self.ws.read(PREVIEWS, preview_id, tx)
        if (
            not preview
            or preview.get('company_id') != company_id
            or preview.get('actor_uid') != uid
        ):
            raise LookupError('Price preview not found.')
        return preview

    def publish(self, uid, company_id, preview_id, expected_generation):
        self._require()

        def commit(tx):
            actor = self.ws.company_actor(uid, company_id, manage=True, tx=tx)
            if 'prices_manage' not in actor['capabilities']:
                raise AccessDenied('Only the company owner can change prices.')
            company = self.ws.read('_companies', company_id, tx)
            if not company or company.get('status') != 'active':
                raise Conflict('Company prices cannot be published while the company is suspended.')
            existing = self._version(preview_id, tx)
            if existing:
                if existing.get('company_id') != company_id:
                    raise LookupError('Price preview not found.')
                return {'version': existing, 'idempotent': True}
            preview = self._load_preview(preview_id, company_id, uid, tx)
            if preview.get('result_version_id'):
                saved = self._version(preview['result_version_id'], tx)
                if saved:
                    return {'version': saved, 'idempotent': True}
            expires = datetime.fromisoformat(preview['expires'])
            if expires < datetime.now(timezone.utc):
                raise Expired('This price review expired. Review the prices again.')
            if preview['base_generation'] != expected_generation:
                raise Conflict('Prices changed. Review the new published values before publishing.')
            head = self._head(company_id, tx) or {
                'company_id': company_id,
                'schema_version': 1,
                'generation': 0,
                'latest_version_id': None,
                'next_sequence': 1,
            }
            if head['generation'] != expected_generation:
                raise Conflict('Prices changed. Review the new published values before publishing.')
            book = self.effective(company, tx)
            if book['generation'] != head['generation']:
                raise Conflict('Prices changed. Review the new published values before publishing.')
            rates = preview['rates']
            _refuse_adr_rates(company_id, rates)
            # Repeat the guardrails inside the commit, against the rates stored at preview time.
            rates = normalize_rates(
                rates,
                preview.get('acknowledgements') or [],
                locked=self._locked_keys(),
                current=book['rates'],
            )
            if rates == book['rates'] or preview.get('no_changes'):
                return {'no_changes': True, 'version': book}
            if content_hash(rates) != preview['content_sha256']:
                raise Conflict('This price review no longer matches its prices. Review them again.')
            sequence = head.get('next_sequence') or 1
            published = now()
            version = {
                'version_id': preview_id,
                'company_id': company_id,
                'sequence': sequence,
                'parent_version_id': head.get('latest_version_id'),
                'catalog_version': CATALOG_VERSION,
                'calculation_version': CALCULATION_VERSION,
                'currency': CURRENCY,
                'rates': rates,
                'content_sha256': content_hash(rates),
                'published_by_uid': uid,
                'published_at': published,
                'effective_from': published,
                'source': preview.get('source') or 'manual',
                'change_reason': preview['change_reason'],
                'import_digest': preview.get('import_digest'),
            }
            import json

            if len(json.dumps(version).encode()) > 32768:
                try:
                    from .price_book_import import SizeLimit
                except ImportError:
                    from price_book_import import SizeLimit
                raise SizeLimit('The price book is too large.')
            tx.create(self.ws.ref(VERSIONS, preview_id), version)
            head.setdefault('started_at', published)
            head.update(
                generation=head['generation'] + 1,
                latest_version_id=preview_id,
                next_sequence=sequence + 1,
                schema_version=1,
                company_id=company_id,
                updated_at=published,
            )
            tx.set(self.ws.ref(HEAD, company_id), head)
            profile = dict(company.get('profile') or {})
            profile['additional_work_rate'] = rates['additional_work_hourly']
            company['profile'] = profile
            # Identity version stays put. Unsigned proposals do not go stale for a price-only change.
            tx.set(self.ws.ref('_companies', company_id), company)
            preview['result_version_id'] = preview_id
            tx.set(self.ws.ref(PREVIEWS, preview_id), preview)
            self._event(
                tx,
                uid,
                'price_published',
                company_id,
                {
                    'version_id': preview_id,
                    'sequence': sequence,
                    'generation': head['generation'],
                    'source': version['source'],
                    'change_reason': version['change_reason'],
                    'diff': preview.get('diff') or [],
                },
                'prices/' + preview_id,
            )
            return {'version': version, 'idempotent': False}

        result = self._run(commit)
        if result.get('no_changes'):
            return {'no_changes': True, 'message': 'No changes'}
        version = result['version']
        event(
            'Price book published',
            logging.INFO,
            operation='price_book',
            outcome='idempotent' if result.get('idempotent') else 'published',
        )
        return {
            'no_changes': False,
            'idempotent': bool(result.get('idempotent')),
            'version_id': version['version_id'],
            'sequence': version['sequence'],
            'label': label_for(version['sequence'], version['company_id']),
            'generation': self._head(version['company_id'])['generation'],
            'published_at': version['published_at'],
            'effective_from': version['effective_from'],
        }

    def versions(self, uid, company_id, support=False):
        self._require()
        if support:
            self.ws.support_company(uid, company_id)
            self._support_read(uid, company_id, 'view_price_history')
            actor = self.ws.principal(uid)
            manage = True
        else:
            actor = self.ws.company_actor(uid, company_id)
            manage = actor['role'] == 'owner'
        rows = self._versions(company_id)
        listed = []
        for version in rows:
            item = {
                'version_id': version['version_id'],
                'sequence': version['sequence'],
                'label': label_for(version['sequence'], company_id),
                'published_at': version['published_at'],
                'source': version['source'],
                'actor': self._actor_name(company_id, version.get('published_by_uid')),
            }
            if manage:
                item['change_reason'] = _shown_reason(version)
            listed.append(item)
        return {'versions': listed}

    def _versions(self, company_id):
        rows = [
            snap.to_dict()
            for snap in self.ws.db.collection(VERSIONS)
            .where(filter=firestore.FieldFilter('company_id', '==', company_id))
            .limit(200)
            .stream()
        ]
        rows.sort(key=lambda row: row.get('sequence', 0), reverse=True)
        if company_id != ADR_COMPANY_ID:
            return [row for row in rows if row.get('sequence')]
        return rows

    def one_version(self, uid, company_id, version_id, support=False):
        self._require()
        if support:
            self.ws.support_company(uid, company_id)
            self._support_read(uid, company_id, 'view_price_version')
            manage = True
        else:
            actor = self.ws.company_actor(uid, company_id)
            manage = actor['role'] == 'owner'
        if version_id == 'seed':
            company = self.ws.read('_companies', company_id)
            rates = _adr_starting_rates(company)
            if (self._head(company_id) or {}).get('latest_version_id'):
                rates = adr_rates()
            return self._version_detail(
                {
                    'version_id': 'seed',
                    'company_id': company_id,
                    'sequence': 0,
                    'rates': rates,
                    'source': 'seed',
                    'change_reason': '',
                    'published_at': None,
                },
                manage,
            )
        version = self._version(version_id)
        if not version or version.get('company_id') != company_id:
            raise LookupError('Price version not found.')
        _refuse_adr_rates(company_id, version['rates'])
        return self._version_detail(version, manage)

    def _version_detail(self, version, manage):
        parent = None
        if version.get('parent_version_id'):
            parent = self._version(version['parent_version_id'])
        company_id = version['company_id']
        before = adr_rates() if company_id == ADR_COMPANY_ID else blank_rates()
        if parent and not foreign_adr_rates(company_id, parent['rates']):
            before = parent['rates']
        rows, warnings = diff_rates(before, version['rates'])
        detail = {
            'version_id': version['version_id'],
            'sequence': version.get('sequence', 0),
            'label': label_for(version.get('sequence', 0), company_id),
            'published_at': version.get('published_at'),
            'source': version.get('source', 'seed'),
            'diff': rows,
            'warnings': warnings,
            'rates': public_rates(version['rates'], editable_additional_work=False),
        }
        if manage:
            detail['change_reason'] = _shown_reason(version)
        return detail

    def history(self, uid, company_id, support=False):
        """Owners and support see price events. Estimators and office staff see version labels only."""
        listing = self.versions(uid, company_id, support=support)
        owner = support or self.ws.company_actor(uid, company_id)['role'] == 'owner'
        if not owner:
            listing['events'] = []
            return listing
        events = []
        for snap in (
            self.ws.db.collection('_admin_events')
            .where(filter=firestore.FieldFilter('company_id', '==', company_id))
            .where(filter=firestore.FieldFilter('domain', '==', DOMAIN))
            .order_by('created_at', direction=firestore.Query.DESCENDING)
            .limit(200)
            .stream()
        ):
            entry = snap.to_dict()
            if entry.get('domain') == DOMAIN:
                events.append(entry)
        events.sort(key=lambda row: row.get('created_at', ''), reverse=True)
        listing['events'] = []
        for entry in events:
            shown = {
                'action': entry['action'],
                'created_at': entry['created_at'],
                'actor': self._actor_name(company_id, entry.get('actor_uid')),
                'target': entry.get('target', ''),
            }
            diff = (entry.get('details') or {}).get('diff')
            if diff:
                shown['diff'] = diff
            listing['events'].append(shown)
        return listing

    def export_rows(self, uid, company_id, version_id=None, support=False):
        self._require()
        if support:
            company = self.ws.support_company(uid, company_id)
            self._support_read(uid, company_id, 'export_prices')
        else:
            actor = self.ws.company_actor(uid, company_id)
            if 'prices_read' not in actor['capabilities']:
                raise AccessDenied('Your role cannot view company prices.')
            company = self.ws.read('_companies', company_id)
        if version_id and version_id != 'seed':
            version = self._version(version_id)
            if not version or version.get('company_id') != company_id:
                raise LookupError('Price version not found.')
            _refuse_adr_rates(company_id, version['rates'])
            book = version
            generation = self._head(company_id)['generation'] if self._head(company_id) else 0
            # Historical exports are viewable. Restoring one still requires a current-base preview.
            base_generation = generation
            base_version = (self._head(company_id) or {}).get('latest_version_id') or 'seed'
        else:
            book = self.effective(company)
            base_generation = book['generation']
            base_version = book['version_id']
        return company_id, base_version, base_generation, book['rates']

    def ensure_pin(self, uid, inspection_id):
        """Create the job pin once. Later audits reuse it. A signed job is never pinned again."""

        def pin(tx):
            record = (
                self.ws.db.collection('inspections').document(inspection_id).get(transaction=tx)
            )
            current = record.to_dict() if record.exists else None
            if not current:
                raise LookupError('Inspection not found.')
            job, actor = self.ws.job_access(uid, current, 'audit', tx)
            if current.get('status') == 'signed':
                existing = self._pin(inspection_id, tx)
                if existing:
                    return existing
                raise Conflict('Signed inspections keep the prices they were signed with.')
            existing = self._pin(inspection_id, tx)
            if existing:
                self.basis_for(existing, job['company_id'])
                basis = saved_basis(current.get('audit'))
                if basis:
                    self.assert_pin(current, basis, tx)
                return existing
            if saved_basis(current.get('audit')):
                raise Conflict("This draft's saved prices are missing. Contact support.")
            company = self.ws.read('_companies', job['company_id'], tx)
            book = self.effective(company, tx)
            if _is_unset(book):
                raise Conflict(_not_set_message(actor.get('role')))
            created = _stamp(current.get('created_at'))
            started = _stamp((self._head(job['company_id'], tx) or {}).get('started_at'))
            grandfather = bool(current.get('audit')) or (
                started is not None and (created is None or created < started)
            )
            if job['company_id'] == ADR_COMPANY_ID and grandfather and book.get('source') != 'seed':
                rates = _adr_starting_rates(company)
                chosen = {
                    'version_id': 'seed',
                    'sequence': 0,
                    'rates': rates,
                    'content_sha256': content_hash(rates),
                    'calculation_version': CALCULATION_VERSION,
                    'source': 'seed',
                }
                reason = 'legacy_rollout'
            else:
                chosen = book
                reason = 'first_price' if not current.get('audit') else 'legacy_rollout'
            body = {
                'inspection_id': inspection_id,
                'company_id': job['company_id'],
                'pin_version': 1,
                'version_id': chosen['version_id'],
                'sequence': chosen.get('sequence', 0),
                'content_sha256': chosen['content_sha256'],
                'calculation_version': CALCULATION_VERSION,
                'rates': dict(chosen['rates']),
                'priced_at': now(),
                'reason': reason,
            }
            tx.create(self.ws.ref(PINS, inspection_id), body)
            return body

        return self._run(pin)

    def basis_for(self, pin, company_id):
        if (
            not pin
            or pin.get('company_id') != company_id
            or pin.get('calculation_version') != CALCULATION_VERSION
            or not isinstance(pin.get('rates'), dict)
            or set(pin['rates']) != set(KEYS)
            or content_hash(pin['rates']) != pin.get('content_sha256')
        ):
            raise Conflict("This draft's saved prices are missing. Contact support.")
        _refuse_adr_rates(company_id, pin['rates'])
        return {
            'company_id': company_id,
            'version_id': pin['version_id'],
            'sequence': pin.get('sequence', 0),
            'content_sha256': pin['content_sha256'],
            'calculation_version': CALCULATION_VERSION,
            'priced_at': pin['priced_at'],
            'rates': {key: pin['rates'][key] for key in KEYS},
        }

    def assert_pin(self, record, basis, tx=None):
        pin = self._pin(record['inspection_id'], tx)
        if not basis:
            if pin:
                raise Conflict(
                    'Run Finish & review again to price this draft from its saved prices.'
                )
            return
        self.basis_for(pin, basis.get('company_id'))
        if (
            pin.get('content_sha256') != basis.get('content_sha256')
            or pin.get('calculation_version') != basis.get('calculation_version')
            or pin.get('version_id') != basis.get('version_id')
        ):
            raise Conflict('The saved prices no longer match this draft. Review before signing.')

    def job_view(self, uid, record):
        self._require()
        job, actor = self.ws.job_access(uid, record, 'read')
        company = self.ws.read('_companies', job['company_id'])
        book = self.effective(company)
        pin = self._pin(record['inspection_id'])
        if pin and record.get('status') != 'signed':
            _refuse_adr_rates(job['company_id'], pin['rates'])
        manage = actor['role'] == 'owner' and record.get('status') != 'signed'
        unset = _is_unset(book)
        newer = bool(
            pin
            and not unset
            and book['version_id'] != pin.get('version_id')
            and book['content_sha256'] != pin.get('content_sha256')
        )
        display = pin['rates'] if pin else book['rates']
        adr_book = adr_rates()
        display_rates = {
            'after_hours_job_charge': display['after_hours_job_charge'],
            'sheet_labor_hourly': display['sheet_labor_hourly'],
        }
        if pin or not unset:
            display_rates['standard_job_charges'] = price_display(display)['standard_job_charges']
        return {
            'pinned': None
            if not pin
            else {
                'label': label_for(pin.get('sequence', 0), job['company_id']),
                'sequence': pin.get('sequence', 0),
                'version_id': pin['version_id'],
                'priced_at': pin.get('priced_at'),
                'reason': pin.get('reason'),
            },
            'latest': {
                'label': label_for(book.get('sequence', 0), job['company_id']),
                'sequence': book.get('sequence', 0),
                'version_id': book['version_id'],
            },
            'newer_available': newer,
            'can_reprice': bool(manage and newer),
            'sheet_rates': job['company_id'] == ADR_COMPANY_ID
            and display['after_hours_job_charge'] == adr_book['after_hours_job_charge']
            and display['sheet_labor_hourly'] == adr_book['sheet_labor_hourly'],
            'display_rates': display_rates,
            'pending_note': None
            if pin
            else (
                _not_set_message(actor['role'])
                if unset
                else 'Rates are confirmed at the first online pricing.'
            ),
        }

    def reprice_preview(self, uid, record):
        self._require()
        job, actor = self.ws.job_access(uid, record, 'read')
        if actor['role'] != 'owner':
            raise AccessDenied('Only the company owner can apply new prices to a draft.')
        if record.get('status') == 'signed':
            raise Conflict('Signed inspections keep the prices they were signed with.')
        pin = self._pin(record['inspection_id'])
        if not pin:
            raise Conflict('This draft has no saved prices yet. Finish and review it first.')
        _refuse_adr_rates(job['company_id'], pin['rates'])
        company = self.ws.read('_companies', job['company_id'])
        book = self.effective(company)
        if _is_unset(book):
            raise Conflict(_not_set_message(actor['role']))

        data = InspectionData.model_validate(record['data'])
        old_items, old_total = price_scope(data, pin['rates'])
        new_items, new_total = price_scope(data, book['rates'])
        old_low, old_high = proposal_range(data, old_items)
        new_low, new_high = proposal_range(data, new_items)
        return {
            'revision': record['revision'],
            'from_version_id': pin['version_id'],
            'from_hash': pin['content_sha256'],
            'to_version_id': book['version_id'],
            'to_hash': book['content_sha256'],
            'to_label': label_for(book.get('sequence', 0), job['company_id']),
            'diff': diff_rates(pin['rates'], book['rates'])[0],
            'before': {
                'itemized': f'{old_total:.2f}',
                'low': f'{old_low:.2f}',
                'high': f'{old_high:.2f}',
            },
            'after': {
                'itemized': f'{new_total:.2f}',
                'low': f'{new_low:.2f}',
                'high': f'{new_high:.2f}',
            },
        }

    def reprice(self, uid, inspection_id, expected):
        self._require()

        def apply(tx):
            snapshot = (
                self.ws.db.collection('inspections').document(inspection_id).get(transaction=tx)
            )
            record = snapshot.to_dict() if snapshot.exists else None
            if not record:
                raise LookupError('Inspection not found.')
            job, actor = self.ws.job_access(uid, record, 'scope', tx)
            if actor['role'] != 'owner' or 'prices_manage' not in actor['capabilities']:
                raise AccessDenied('Only the company owner can apply new prices to a draft.')
            if (
                record.get('status') == 'signed'
                or record['revision'] != expected['expected_revision']
            ):
                raise Conflict('Restore the latest unsigned draft before applying new prices.')
            pin = self._pin(inspection_id, tx)
            if not pin or pin.get('content_sha256') != expected['expected_pin_hash']:
                raise Conflict("This draft's prices changed. Review them again.")
            company = self.ws.read('_companies', job['company_id'], tx)
            book = self.effective(company, tx)
            if _is_unset(book):
                raise Conflict(_not_set_message(actor['role']))
            if (
                book['version_id'] != expected['destination_version_id']
                or book['content_sha256'] != expected['destination_hash']
            ):
                raise Conflict('Company prices changed. Review the latest prices again.')
            if book['content_sha256'] == pin.get('content_sha256'):
                return record
            replacement = {
                **pin,
                'version_id': book['version_id'],
                'sequence': book.get('sequence', 0),
                'content_sha256': book['content_sha256'],
                'rates': dict(book['rates']),
                'priced_at': now(),
                'reason': 'explicit_reprice',
                'pin_version': pin.get('pin_version', 1) + 1,
                'calculation_version': CALCULATION_VERSION,
            }
            record['revision'] = record['revision'] + 1
            record['audit'] = None
            record['status'] = 'draft'
            record['data']['scope_confirmed'] = False
            record['updated_at'] = now()
            tx.set(self.ws.db.collection('inspections').document(inspection_id), record)
            tx.set(self.ws.ref(PINS, inspection_id), replacement)
            self.ws.sync_job(record, tx)
            self._event(
                tx,
                uid,
                'job_repriced',
                job['company_id'],
                {
                    'inspection_id': inspection_id,
                    'revision': record['revision'],
                    'version_id': book['version_id'],
                },
                'job/' + inspection_id,
            )
            return record

        result = self._run(apply)
        event('Job repriced', logging.INFO, operation='price_book', outcome='reprice')
        return result

    def restore_preview(self, uid, company_id, version_id, reason):
        """A preview of one saved version. Publishing it still needs the owner to confirm."""
        self._require()
        self.ws.company_actor(uid, company_id, manage=True)
        version = self._version(version_id)
        if (
            not version
            or version.get('company_id') != company_id
            or (company_id != ADR_COMPANY_ID and not version.get('sequence'))
        ):
            raise LookupError('Price version not found.')
        rates = version['rates']
        acknowledgements = [
            key
            for key in ('emergency_call', 'after_hours_job_charge')
            if rates.get(key) in ('0', '0.0', '0.00')
        ]
        return self.preview(
            uid,
            company_id,
            {
                'rates': rates,
                'acknowledgements': acknowledgements,
                'change_reason': reason,
                'source': 'restore',
            },
        )

    def approval_source(self, company, tx=None):
        """The book a new additional-work approval is priced from, when price books are on."""
        if not price_books_enabled():
            return None
        return self.effective(company, tx)


def _stamp(value):
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    text = str(value).replace('Z', '+00:00')
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _two(value):
    text = str(value)
    if '.' not in text:
        return text + '.00'
    whole, fraction = text.split('.', 1)
    return whole + '.' + (fraction + '00')[:2]
