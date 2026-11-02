"""Immutable company price books, job pins and owner publication.

Client Firestore access stays denied. Every check here is server authorization.
Publication does not change the company identity version.
"""

import copy
from datetime import datetime, timedelta, timezone
from decimal import Decimal
import json
import logging
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
        known_calculation_version,
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
    from .price_table import (
        CALCULATION_VERSION as V2_CALCULATION_VERSION,
        SCHEMA_VERSION as V2_SCHEMA_VERSION,
        content_hash as v2_content_hash,
        diff_tables,
        normalize_table,
        public_diff,
        public_table,
        locked_extras_problems,
        publish_problems,
        starter_table,
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
        known_calculation_version,
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
    from price_table import (
        CALCULATION_VERSION as V2_CALCULATION_VERSION,
        SCHEMA_VERSION as V2_SCHEMA_VERSION,
        content_hash as v2_content_hash,
        diff_tables,
        normalize_table,
        public_diff,
        public_table,
        locked_extras_problems,
        publish_problems,
        starter_table,
    )
    from workspaces import AccessDenied

PREVIEW_MINUTES = 30
HEAD = '_company_price_books'
VERSIONS = '_price_book_versions'
PINS = '_job_pricing'
PREVIEWS = '_price_book_previews'
PROFILE_RATE_MAX = Decimal('10000')
DRAFTS = '_price_book_drafts'
DOMAIN = 'pricing'
V1_SIZE_LIMIT = 32768
V2_SIZE_LIMIT = 200 * 1024
V2_PRICING_UNAVAILABLE = 'v2 pricing is not available yet.'
STARTER_VERSION = 'starter'


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


def _is_v2(doc) -> bool:
    return bool(isinstance(doc, dict) and doc.get('calculation_version') == V2_CALCULATION_VERSION)


def _head_calculation(head) -> str:
    # The Oct 26 2026 production migration wrote ADR's head before this field existed.
    return (head or {}).get('calculation_version', CALCULATION_VERSION)


def _refuse_v1_to_v2(head):
    if head and head.get('latest_version_id') and _head_calculation(head) == CALCULATION_VERSION:
        raise Conflict(
            'This company uses the previous calculation. '
            'It cannot move to an owner price table until the cutover is available.'
        )


def _valid_v2_doc(doc) -> tuple[bool, dict | None]:
    if (
        not isinstance(doc, dict)
        or doc.get('calculation_version') != V2_CALCULATION_VERSION
        or not isinstance(doc.get('items'), list)
        or not isinstance(doc.get('policy'), dict)
        or doc.get('rates') is not None
    ):
        return False, None
    acked = [
        it.get('item_id')
        for it in doc['items']
        if isinstance(it, dict) and it.get('allow_zero') and isinstance(it.get('item_id'), str)
    ]
    try:
        normalized = normalize_table(
            {'items': doc['items'], 'policy': doc['policy']},
            publish=True,
            acknowledgements=acked,
        )
    except ValueError:
        return False, None
    if v2_content_hash(normalized) != doc.get('content_sha256'):
        return False, None
    return True, normalized


def _valid_v1_doc(doc) -> bool:
    if (
        not isinstance(doc, dict)
        or doc.get('calculation_version') != CALCULATION_VERSION
        or not isinstance(doc.get('rates'), dict)
        or set(doc['rates']) != set(KEYS)
        or doc.get('items') is not None
        or doc.get('policy') is not None
    ):
        return False
    return content_hash(doc['rates']) == doc.get('content_sha256')


def _raise_size_limit():
    try:
        from .price_book_import import SizeLimit
    except ImportError:
        from price_book_import import SizeLimit
    raise SizeLimit('The price book is too large.')


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

    def _draft(self, company_id, tx=None):
        return self.ws.read(DRAFTS, company_id, tx)

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
            if not version or version.get('company_id') != company_id:
                raise Conflict('This company price book cannot be used. Contact support.')
            if version.get('calculation_version') != _head_calculation(head):
                raise Conflict('This company price book cannot be used. Contact support.')
            if _is_v2(version):
                ok, _ = _valid_v2_doc(version)
                if not ok:
                    raise Conflict('This company price book cannot be used. Contact support.')
                return {**version, 'generation': head['generation']}
            if not _valid_v1_doc(version):
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
        if _is_v2(book):
            return {**view, 'prices_set': True}
        return {**view, 'prices_set': True, 'price_display': price_display(book['rates'])}

    def _actor_name(self, company_id, uid, tx=None):
        member = self.ws.read('_memberships', uid, tx) if uid else None
        if member and member.get('company_id') == company_id and member.get('status') == 'active':
            return {'owner': 'Owner', 'estimator': 'Estimator', 'office': 'Office staff'}.get(
                member.get('role'), 'Former member'
            )
        return 'Former member'

    def _working_copy_view(self, draft):
        if not draft:
            return None
        pub = public_table({'items': draft['items'], 'policy': draft['policy']}, manage=True)
        return {
            'working_version': draft['working_version'],
            'base_generation': draft['base_generation'],
            'base_version_id': draft.get('base_version_id'),
            'items': pub['items'],
            'policy': pub['policy'],
            'updated_at': draft.get('updated_at'),
        }

    def _starts_from_catalog(self, company_id):
        if company_id == ADR_COMPANY_ID:
            return False
        return not (self._head(company_id) or {}).get('latest_version_id')

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
        draft = self._draft(company['company_id']) if manage else None
        if _is_v2(book):
            pub = public_table(book, manage=manage)
            return {
                'company_id': company['company_id'],
                'company_name': (company.get('profile') or {}).get('name', ''),
                'calculation_version': V2_CALCULATION_VERSION,
                'starter': False,
                'prices_set': True,
                'generation': book['generation'],
                'version_id': book['version_id'],
                'sequence': book['sequence'],
                'label': label_for(book['sequence'], company['company_id']),
                'published_at': book.get('published_at'),
                'effective_from': book.get('effective_from'),
                'source': book.get('source', 'manual'),
                'change_reason': reason if manage or support else '',
                'items': pub['items'],
                'policy': pub['policy'],
                'working_copy': self._working_copy_view(draft),
                'can_manage': manage,
                'priced_extras': extras,
                'used_for': 'New pricing uses these rates. Existing jobs keep their saved rates.',
            }
        view = {
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
            'calculation': calculation_policy(book['calculation_version']),
            'priced_extras': extras,
            'can_manage': manage,
            'rates': public_rates(book['rates'], editable_additional_work=extras),
            'used_for': _not_set_message(actor.get('role') if not support else None)
            if unset
            else 'New pricing uses these rates. Existing jobs keep their saved rates.',
        }
        if self._starts_from_catalog(company['company_id']):
            # The blank rows stay beside the starter table, which is what the editor reads today.
            pub = public_table(starter_table(), manage=manage)
            view.update(
                starter=True,
                calculation_version=None,
                items=pub['items'],
                policy=pub['policy'],
                working_copy=self._working_copy_view(draft),
            )
        elif draft:
            view['working_copy'] = self._working_copy_view(draft)
        return view

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

    def save_working_copy(self, uid, company_id, payload):
        self._require()
        actor = self.ws.company_actor(uid, company_id, manage=True)
        if 'prices_manage' not in actor['capabilities']:
            raise AccessDenied('Only the company owner can change prices.')
        table = normalize_table(
            payload,
            publish=False,
            acknowledgements=payload.get('acknowledgements') or [],
        )
        problems = self._publish_problems(table, payload.get('acknowledgements') or [])
        expected_wv = payload.get('expected_working_version')
        expected_gen = payload.get('expected_generation')

        def save(tx):
            tx_actor = self.ws.company_actor(uid, company_id, manage=True, tx=tx)
            if 'prices_manage' not in tx_actor['capabilities']:
                raise AccessDenied('Only the company owner can change prices.')
            company = self.ws.read('_companies', company_id, tx)
            if not company or company.get('status') != 'active':
                raise Conflict('Company prices cannot be changed while the company is suspended.')
            head = self._head(company_id, tx)
            head_gen = head['generation'] if head else 0
            head_ver = head.get('latest_version_id') if head else None
            if expected_gen is not None and expected_gen != head_gen:
                raise Conflict('Prices changed on another device. Reload.')
            existing = self._draft(company_id, tx)
            current_wv = existing['working_version'] if existing else 0
            if expected_wv is not None and expected_wv != current_wv:
                raise Conflict('Prices changed on another device. Reload.')
            new_wv = current_wv + 1
            doc = {
                'company_id': company_id,
                'working_version': new_wv,
                'base_generation': head_gen,
                'base_version_id': head_ver,
                'items': table['items'],
                'policy': table['policy'],
                'updated_by_uid': uid,
                'updated_at': now(),
            }
            if len(json.dumps(doc).encode('utf-8')) > V2_SIZE_LIMIT:
                _raise_size_limit()
            tx.set(self.ws.ref(DRAFTS, company_id), doc)
            return doc

        saved = self._run(save)
        event(
            'Price working copy saved',
            logging.INFO,
            operation='price_book',
            outcome='working_copy',
        )
        return {
            'working_version': saved['working_version'],
            'base_generation': saved['base_generation'],
            'base_version_id': saved['base_version_id'],
            'problems': problems,
            'working_copy': self._working_copy_view(saved),
        }

    def discard_working_copy(self, uid, company_id):
        self._require()
        actor = self.ws.company_actor(uid, company_id, manage=True)
        if 'prices_manage' not in actor['capabilities']:
            raise AccessDenied('Only the company owner can change prices.')

        def discard(tx):
            tx_actor = self.ws.company_actor(uid, company_id, manage=True, tx=tx)
            if 'prices_manage' not in tx_actor['capabilities']:
                raise AccessDenied('Only the company owner can change prices.')
            company = self.ws.read('_companies', company_id, tx)
            if not company or company.get('status') != 'active':
                raise Conflict('Company prices cannot be changed while the company is suspended.')
            existing = self._draft(company_id, tx)
            if existing:
                tx.delete(self.ws.ref(DRAFTS, company_id))
            return bool(existing)

        existed = self._run(discard)
        event(
            'Price working copy discarded',
            logging.INFO,
            operation='price_book',
            outcome='discarded',
        )
        return {'discarded': existed, 'working_copy': None}

    def calculate(self, uid, company_id, payload):
        self._require()
        actor = self.ws.company_actor(uid, company_id, manage=True)
        if 'prices_manage' not in actor['capabilities']:
            raise AccessDenied('Only the company owner can change prices.')
        table = normalize_table(
            payload,
            publish=False,
            acknowledgements=payload.get('acknowledgements') or [],
        )
        return {
            'samples': [],
            'problems': self._publish_problems(table, payload.get('acknowledgements') or []),
        }

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

    def _publish_problems(self, table, acknowledgements):
        return publish_problems(table, acknowledgements, extras_locked=bool(self._locked_keys()))

    def _refuse_locked_extras(self, table):
        if self._locked_keys():
            problems = locked_extras_problems(table)
            if problems:
                raise ValueError(problems[0]['message'])

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
        if 'items' in payload or 'policy' in payload:
            return self._preview_v2(uid, company_id, company, payload)

        if _is_v2(self.effective(company)):
            raise Conflict('This company uses an owner price table. Send items and policy.')
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
            'sample_before': None
            if _is_unset(book)
            else sample_totals(book['rates'], book['calculation_version']),
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

    def _preview_v2(self, uid, company_id, company, payload):
        acks = list(payload.get('acknowledgements') or [])
        table = normalize_table(payload, publish=True, acknowledgements=acks)
        reason = reason_text(payload.get('change_reason', ''))
        head = self._head(company_id)
        _refuse_v1_to_v2(head)
        self._refuse_locked_extras(table)
        if head and head.get('latest_version_id'):
            current = self._version(head['latest_version_id'])
            base_generation = head['generation']
            base_version_id = head['latest_version_id']
            next_seq = head.get('next_sequence') or ((current or {}).get('sequence', 0) + 1)
        else:
            current = None
            base_generation = 0
            base_version_id = None
            next_seq = 1
        before_table = current if (current and _is_v2(current)) else None
        diff, warnings = diff_tables(before_table, table)
        digest = v2_content_hash(table)
        no_changes = bool(before_table and before_table.get('content_sha256') == digest)
        preview_id = uuid4().hex
        body = {
            'preview_id': preview_id,
            'company_id': company['company_id'],
            'actor_uid': uid,
            'base_generation': base_generation,
            'base_version_id': base_version_id,
            'sequence': next_seq,
            'schema_version': V2_SCHEMA_VERSION,
            'calculation_version': V2_CALCULATION_VERSION,
            'items': table['items'],
            'policy': table['policy'],
            'content_sha256': digest,
            'acknowledgements': acks,
            'change_reason': reason,
            'warnings': warnings,
            'diff': diff,
            'no_changes': no_changes,
            'sample_before': [],
            'sample_after': [],
            'source': payload.get('source') or 'manual',
            'import_digest': payload.get('import_digest'),
            'created_at': now(),
            'expires': (
                datetime.now(timezone.utc) + timedelta(minutes=PREVIEW_MINUTES)
            ).isoformat(),
        }
        if len(json.dumps(body).encode('utf-8')) > V2_SIZE_LIMIT:
            _raise_size_limit()

        def create(tx):
            self.ws.company_actor(uid, company_id, manage=True, tx=tx)
            tx.create(self.ws.ref(PREVIEWS, preview_id), body)

        self._run(create)
        event('Price preview stored', logging.INFO, operation='price_book', outcome='preview')
        return self._preview_response(body, {'sequence': next_seq - 1 if next_seq > 1 else 0})

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
                'calculation_version': CALCULATION_VERSION,
                'generation': 0,
                'latest_version_id': None,
                'next_sequence': 1,
            }
            if head['generation'] != expected_generation:
                raise Conflict('Prices changed. Review the new published values before publishing.')
            if _is_v2(preview):
                return self._commit_v2_publish(
                    tx, uid, company_id, company, head, preview_id, preview
                )
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
            if len(json.dumps(version).encode()) > V1_SIZE_LIMIT:
                _raise_size_limit()
            tx.create(self.ws.ref(VERSIONS, preview_id), version)
            head.setdefault('started_at', published)
            head.update(
                generation=head['generation'] + 1,
                latest_version_id=preview_id,
                next_sequence=sequence + 1,
                schema_version=1,
                calculation_version=CALCULATION_VERSION,
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

    def _commit_v2_publish(self, tx, uid, company_id, company, head, preview_id, preview):
        _refuse_v1_to_v2(head)
        current_version = (
            self._version(head['latest_version_id'], tx) if head.get('latest_version_id') else None
        )
        existing_draft = self._draft(company_id, tx)
        table = normalize_table(
            {'items': preview['items'], 'policy': preview['policy']},
            publish=True,
            acknowledgements=preview.get('acknowledgements') or [],
        )
        self._refuse_locked_extras(table)
        digest = v2_content_hash(table)
        if digest != preview.get('content_sha256'):
            raise Conflict('This price review no longer matches its prices. Review them again.')
        if preview.get('no_changes') or (
            current_version
            and _is_v2(current_version)
            and current_version.get('content_sha256') == digest
        ):
            return {'no_changes': True, 'version': current_version}

        sequence = head.get('next_sequence') or 1
        published = now()
        version = {
            'version_id': preview_id,
            'company_id': company_id,
            'sequence': sequence,
            'parent_version_id': head.get('latest_version_id'),
            'schema_version': V2_SCHEMA_VERSION,
            'calculation_version': V2_CALCULATION_VERSION,
            'currency': CURRENCY,
            'items': table['items'],
            'policy': table['policy'],
            'content_sha256': digest,
            'published_by_uid': uid,
            'published_at': published,
            'effective_from': published,
            'source': preview.get('source') or 'manual',
            'change_reason': preview['change_reason'],
            'import_digest': preview.get('import_digest'),
        }
        if len(json.dumps(version).encode('utf-8')) > V2_SIZE_LIMIT:
            _raise_size_limit()
        tx.create(self.ws.ref(VERSIONS, preview_id), version)
        head.setdefault('started_at', published)
        head.update(
            generation=head['generation'] + 1,
            latest_version_id=preview_id,
            next_sequence=sequence + 1,
            schema_version=V2_SCHEMA_VERSION,
            calculation_version=V2_CALCULATION_VERSION,
            company_id=company_id,
            updated_at=published,
        )
        tx.set(self.ws.ref(HEAD, company_id), head)
        if existing_draft:
            tx.delete(self.ws.ref(DRAFTS, company_id))
        profile = dict(company.get('profile') or {})
        profile.pop('additional_work_rate', None)
        for item in table['items']:
            if (
                item['group'] == 'extras'
                and item['enabled']
                and item['unit_price'] != ''
                and 0 < Decimal(item['unit_price']) <= PROFILE_RATE_MAX
            ):
                profile['additional_work_rate'] = item['unit_price']
        company['profile'] = profile
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
                'calculation_version': V2_CALCULATION_VERSION,
                'source': version['source'],
                'change_reason': version['change_reason'],
                'diff': preview.get('diff') or {},
            },
            'prices/' + preview_id,
        )
        return {'version': version, 'idempotent': False}

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
                'calculation_version': version.get('calculation_version', CALCULATION_VERSION),
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
        if not _is_v2(version):
            _refuse_adr_rates(company_id, version['rates'])
        return self._version_detail(version, manage)

    def _version_detail(self, version, manage):
        parent = None
        if version.get('parent_version_id'):
            parent = self._version(version['parent_version_id'])
        company_id = version['company_id']
        if _is_v2(version):
            before = parent if (parent and _is_v2(parent)) else None
            diff, warnings = (diff_tables if manage else public_diff)(before, version)
            pub = public_table(version, manage=manage)
            detail = {
                'version_id': version['version_id'],
                'sequence': version.get('sequence', 0),
                'label': label_for(version.get('sequence', 0), company_id),
                'calculation_version': V2_CALCULATION_VERSION,
                'published_at': version.get('published_at'),
                'source': version.get('source', 'manual'),
                'diff': diff,
                'warnings': warnings,
                'items': pub['items'],
                'policy': pub['policy'],
            }
            if manage:
                detail['change_reason'] = _shown_reason(version)
            return detail
        before = adr_rates() if company_id == ADR_COMPANY_ID else blank_rates()
        if parent and 'rates' in parent and not foreign_adr_rates(company_id, parent['rates']):
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
        manage = support or actor['role'] == 'owner'
        if version_id and version_id != 'seed':
            version = self._version(version_id)
            if not version or version.get('company_id') != company_id:
                raise LookupError('Price version not found.')
            if not _is_v2(version):
                _refuse_adr_rates(company_id, version['rates'])
            book = version
            head = self._head(company_id)
            generation = head['generation'] if head else 0
            # Historical exports are viewable. Restoring one still requires a current-base preview.
            base_generation = generation
            base_version = (head or {}).get('latest_version_id') or 'seed'
        elif self._starts_from_catalog(company_id):
            book = {**starter_table(), 'calculation_version': V2_CALCULATION_VERSION}
            base_generation = 0
            base_version = STARTER_VERSION
        else:
            book = self.effective(company)
            base_generation = book['generation']
            base_version = book['version_id']
        if _is_v2(book):
            items = public_table(book, manage=manage)['items']
            return company_id, base_version, base_generation, items
        return company_id, base_version, base_generation, book['rates']

    def ensure_pin(self, uid, inspection_id, priceable_only=False):
        """Create the job pin once. Later audits reuse it. A signed job is never pinned again.

        priceable_only refuses a v2 pin, before any write, for callers that price the job now.
        """

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
                if priceable_only and _is_v2(existing):
                    raise Conflict(V2_PRICING_UNAVAILABLE)
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
            if _is_v2(chosen):
                if priceable_only:
                    raise Conflict(V2_PRICING_UNAVAILABLE)
                body = {
                    'inspection_id': inspection_id,
                    'company_id': job['company_id'],
                    'pin_version': 1,
                    'version_id': chosen['version_id'],
                    'sequence': chosen.get('sequence', 1),
                    'content_sha256': chosen['content_sha256'],
                    'calculation_version': V2_CALCULATION_VERSION,
                    'items': copy.deepcopy(chosen['items']),
                    'policy': copy.deepcopy(chosen['policy']),
                    'priced_at': now(),
                    'reason': reason,
                }
                if len(json.dumps(body).encode('utf-8')) > V2_SIZE_LIMIT:
                    _raise_size_limit()
                tx.create(self.ws.ref(PINS, inspection_id), body)
                return body
            body = {
                'inspection_id': inspection_id,
                'company_id': job['company_id'],
                'pin_version': 1,
                'version_id': chosen['version_id'],
                'sequence': chosen.get('sequence', 0),
                'content_sha256': chosen['content_sha256'],
                'calculation_version': chosen['calculation_version'],
                'rates': dict(chosen['rates']),
                'priced_at': now(),
                'reason': reason,
            }
            tx.create(self.ws.ref(PINS, inspection_id), body)
            return body

        return self._run(pin)

    def basis_for(self, pin, company_id):
        if not pin or pin.get('company_id') != company_id:
            raise Conflict("This draft's saved prices are missing. Contact support.")
        version_id = pin.get('version_id')
        if version_id and version_id not in ('seed', 'unset'):
            stored_version = self._version(version_id)
            if stored_version and stored_version.get('calculation_version') != pin.get(
                'calculation_version'
            ):
                raise Conflict("This draft's saved prices are missing. Contact support.")
        if _is_v2(pin):
            ok, normalized = _valid_v2_doc(pin)
            if not ok or normalized is None:
                raise Conflict("This draft's saved prices are missing. Contact support.")
            return {
                'company_id': company_id,
                'version_id': pin['version_id'],
                'sequence': pin.get('sequence', 1),
                'content_sha256': pin['content_sha256'],
                'calculation_version': V2_CALCULATION_VERSION,
                'priced_at': pin['priced_at'],
                'policy': normalized['policy'],
                'item_count': len(normalized['items']),
            }
        if not _valid_v1_doc(pin):
            raise Conflict("This draft's saved prices are missing. Contact support.")
        _refuse_adr_rates(company_id, pin['rates'])
        return {
            'company_id': company_id,
            'version_id': pin['version_id'],
            'sequence': pin.get('sequence', 0),
            'content_sha256': pin['content_sha256'],
            'calculation_version': pin['calculation_version'],
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
        if pin and not _is_v2(pin) and record.get('status') != 'signed':
            _refuse_adr_rates(job['company_id'], pin['rates'])
        manage = actor['role'] == 'owner' and record.get('status') != 'signed'
        unset = _is_unset(book)
        newer = bool(
            pin
            and not unset
            and book['version_id'] != pin.get('version_id')
            and book['content_sha256'] != pin.get('content_sha256')
        )
        active = pin if pin else book
        if _is_v2(active):
            pub = public_table(active, manage=False)
            return {
                'calculation_version': V2_CALCULATION_VERSION,
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
                'can_reprice': False,
                'table': {
                    'version_id': active['version_id'],
                    'content_sha256': active['content_sha256'],
                    'sequence': active.get('sequence', 0),
                    'label': label_for(active.get('sequence', 0), job['company_id']),
                    'items': pub['items'],
                    'policy': pub['policy'],
                },
                'pending_note': None if pin else 'Prices are confirmed at the first online save.',
            }
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
            'can_reprice': bool(manage and newer and not _is_v2(book)),
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
        if not _is_v2(pin):
            _refuse_adr_rates(job['company_id'], pin['rates'])
        company = self.ws.read('_companies', job['company_id'])
        book = self.effective(company)
        if _is_unset(book):
            raise Conflict(_not_set_message(actor['role']))
        if _is_v2(pin) or _is_v2(book):
            raise Conflict(V2_PRICING_UNAVAILABLE)

        data = InspectionData.model_validate(record['data'])
        old_version = pin.get('calculation_version')
        if not known_calculation_version(old_version):
            raise Conflict("This draft's saved prices are missing. Contact support.")
        new_version = book['calculation_version']
        old_items, old_total = price_scope(data, pin['rates'], old_version)
        new_items, new_total = price_scope(data, book['rates'], new_version)
        old_low, old_high = proposal_range(data, old_items, old_version)
        new_low, new_high = proposal_range(data, new_items, new_version)
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
            if _is_v2(pin) or _is_v2(book):
                raise Conflict(V2_PRICING_UNAVAILABLE)
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
                'calculation_version': book.get('calculation_version', CALCULATION_VERSION),
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
        head_calc = _head_calculation(self._head(company_id))
        version = self._version(version_id)
        if (
            not version
            or version.get('company_id') != company_id
            or (company_id != ADR_COMPANY_ID and not version.get('sequence'))
        ):
            raise LookupError('Price version not found.')
        if version.get('calculation_version', CALCULATION_VERSION) != head_calc:
            raise Conflict(
                'This version uses the previous calculation. Start from the current table.'
            )

        if _is_v2(version):
            acknowledgements = [
                it['item_id']
                for it in version['items']
                if it.get('allow_zero') and it.get('unit_price') in ('0', '0.0', '0.00')
            ]
            return self.preview(
                uid,
                company_id,
                {
                    'items': version['items'],
                    'policy': version['policy'],
                    'acknowledgements': acknowledgements,
                    'change_reason': reason,
                    'source': 'restore',
                },
            )
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
        book = self.effective(company, tx)
        if _is_v2(book):
            raise Conflict(V2_PRICING_UNAVAILABLE)
        return book if price_books_enabled() else None


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
