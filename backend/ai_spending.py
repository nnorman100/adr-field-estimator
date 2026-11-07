"""Private company/month AI ledger. Money is integer micro-USD, never job pricing.

Uncertain calls retain their entire reservation. No TTL or elapsed lease can prove
that a provider did not bill a call, so abandoned reservations are never refunded.
"""

import time
from datetime import datetime, timezone
from uuid import uuid4

from fastapi import HTTPException
from google.api_core.exceptions import Aborted

DEFAULT_CAP = 10_000_000
LIVE_MARGIN = 2_000_000
RETRY_SECONDS = 3600
HELD_RETRY_SECONDS = 60
REST_INPUT_LIMIT = 1_048_576
REST_OUTPUT_LIMIT = 65_536
REST_OUTPUT_LIMITS = dict(
    audit=16_384, scope=16_384, ocr=8192, transcribe=8192, job_summary=2048, drying_watch=2048
)
# Standard non-global list prices, without promotional credits, checked 2026-11-06.
# https://cloud.google.com/model-garden/pricing
REST_INPUT_RATE = 165  # hundredths of one micro-USD per token
REST_OUTPUT_RATE = 825
REST_RESERVE = (
    REST_INPUT_LIMIT * REST_INPUT_RATE + REST_OUTPUT_LIMIT * REST_OUTPUT_RATE + 99
) // 100
CAP_MESSAGE = (
    "This AI request does not fit your company's remaining monthly AI spending limit. "
    'The allowance resets next month (UTC). '
    'Your field work, drafts and agreements are saved; you can keep working without AI.'
)
HELD_MESSAGE = (
    "Your company's remaining AI allowance this month is held by AI requests in progress or "
    'awaiting confirmation. Retry in a minute. '
    'Your field work, drafts and agreements are saved; you can keep working without AI.'
)


class SpendingError(HTTPException):
    """An expected budget refusal, safe for the API to return verbatim."""


def limited(exhausted):
    if exhausted:
        return SpendingError(429, CAP_MESSAGE, headers={'Retry-After': str(RETRY_SECONDS)})
    return SpendingError(429, HELD_MESSAGE, headers={'Retry-After': str(HELD_RETRY_SECONDS)})


def rest_output_limit(model, operation):
    if model != 'gemini-3.8-flash':
        raise SpendingError(503, 'AI spending rates for this model have not been verified.')
    if operation not in REST_OUTPUT_LIMITS:
        raise SpendingError(503, 'AI output limits for this operation have not been verified.')
    return REST_OUTPUT_LIMITS[operation]


def rest_allowance(model, input_tokens, operation):
    output = rest_output_limit(model, operation)
    if type(input_tokens) is not int or not 0 <= input_tokens <= REST_INPUT_LIMIT:
        raise SpendingError(503, 'AI could not be prepared. Retry; your saved work is unchanged.')
    return (input_tokens * REST_INPUT_RATE + output * REST_OUTPUT_RATE + 99) // 100


def rest_cost(response):
    usage = getattr(response, 'usage_metadata', None)
    prompt = getattr(usage, 'prompt_token_count', None)
    total = getattr(usage, 'total_token_count', None)
    if type(prompt) is not int or type(total) is not int or not 0 <= prompt <= total:
        return None
    # total includes output and thinking; cached input is charged at the full rate.
    return (prompt * REST_INPUT_RATE + (total - prompt) * REST_OUTPUT_RATE + 99) // 100


class CompanySpending:
    def __init__(self, store, company_id):
        self.store = store
        self.company_id = company_id

    @classmethod
    def actor(cls, store, uid, workspaces=True):
        company_id = store.workspaces.company_actor(uid)['company_id'] if workspaces else 'adr'
        return cls(store, company_id)

    def ref(self, collection, identifier):
        return self.store.db.collection(collection).document(identifier)

    def _atomic(self, callback):
        try:
            return self.store._atomic(callback)
        except (Aborted, ValueError) as error:
            # Firestore wraps exhausted commit retries in ValueError from Aborted.
            # Keep ordinary validation errors and other storage failures distinct.
            if isinstance(error, Aborted) or isinstance(error.__cause__, Aborted):
                raise limited(False) from error
            raise

    @staticmethod
    def read(ref, tx):
        snapshot = ref.get(transaction=tx)
        return snapshot.to_dict() if snapshot.exists else None

    def monthly(self, tx, month=None):
        month = month or datetime.fromtimestamp(time.time(), timezone.utc).strftime('%Y-%m')
        ref = self.ref('_company_ai_months', self.company_id + '_' + month)
        row = self.read(ref, tx) or dict(
            company_id=self.company_id, month=month, spent_microusd=0, reserved_microusd=0
        )
        return ref, row

    def settings(self, tx):
        ref = self.ref('_company_ai_budgets', self.company_id)
        row = self.read(ref, tx) or dict(
            company_id=self.company_id, monthly_cap_microusd=DEFAULT_CAP
        )
        cap = row.get('monthly_cap_microusd')
        if type(cap) is not int or cap < 0:
            raise SpendingError(503, 'The company AI spending limit is unavailable.')
        return ref, row

    def reserve(self, operation, amount, live=False):
        if type(amount) is not int or amount <= 0:
            raise ValueError('A positive reservation is required.')
        identifier = uuid4().hex
        reservation = self.ref('_company_ai_reservations', identifier)

        def acquire(tx):
            _settings_ref, settings = self.settings(tx)
            month_ref, month = self.monthly(tx)
            cap = settings['monthly_cap_microusd']

            def refused(total):
                return total + amount > cap or (live and total >= cap - LIVE_MARGIN)

            if refused(month['spent_microusd'] + month['reserved_microusd']):
                raise limited(refused(month['spent_microusd']))
            hold = dict(
                company_id=self.company_id,
                month=month['month'],
                operation=operation,
                amount_microusd=amount,
                state='reserved',
                live=live,
            )
            month['reserved_microusd'] += amount
            tx.set(month_ref, month)
            tx.create(reservation, hold)
            return identifier

        return self._atomic(acquire)

    def check_available(self, amount):
        """Avoid token-count calls for an already refused request; reserve still checks atomically."""
        row = self.summary()
        cap = row['monthly_cap_microusd']
        if row['spent_microusd'] + row['reserved_microusd'] + amount > cap:
            raise limited(row['spent_microusd'] + amount > cap)

    def settle(self, identifier, cost=None):
        """Idempotent settlement. None means unknown, so charge the full hold."""
        ref = self.ref('_company_ai_reservations', identifier)

        def finish(tx):
            hold = self.read(ref, tx)
            if not hold or hold['company_id'] != self.company_id:
                raise LookupError('AI reservation not found.')
            if hold['state'] != 'reserved':
                return
            month_ref, month = self.monthly(tx, hold['month'])
            charge = hold['amount_microusd'] if cost is None else cost
            if type(charge) is not int or charge < 0:
                raise ValueError('Invalid AI cost.')
            # Live is deliberately a soft threshold. REST never settles above its bound;
            # unexpected provider metadata leaves the entire reservation in place.
            if not hold['live'] and charge > hold['amount_microusd']:
                raise ValueError('AI usage exceeded its verified reservation bound.')
            month['reserved_microusd'] -= hold['amount_microusd']
            month['spent_microusd'] += charge
            hold.update(state='settled', cost_microusd=charge)
            tx.set(month_ref, month)
            tx.set(ref, hold)

        self._atomic(finish)

    def live_usage(self, identifier, estimate):
        """Account before reporting exhaustion; raising inside the transaction would undo it.

        Returns None under the cap, else whether settled spending plus this session alone reach it.
        """
        ref = self.ref('_company_ai_reservations', identifier)

        def update(tx):
            hold = self.read(ref, tx)
            if not hold or hold['company_id'] != self.company_id or not hold['live']:
                raise LookupError('AI reservation not found.')
            if hold['state'] != 'reserved':
                raise ValueError('AI reservation already settled.')
            settings_ref, settings = self.settings(tx)
            month_ref, month = self.monthly(tx, hold['month'])
            amount = max(hold['amount_microusd'], estimate)
            month['reserved_microusd'] += amount - hold['amount_microusd']
            hold['amount_microusd'] = amount
            tx.set(month_ref, month)
            tx.set(ref, hold)
            cap = settings['monthly_cap_microusd']
            if month['spent_microusd'] + month['reserved_microusd'] < cap:
                return None
            return month['spent_microusd'] + amount >= cap

        return self._atomic(update)

    def summary(self):
        def view(tx):
            settings_ref, settings = self.settings(tx)
            month_ref, month = self.monthly(tx)
            return dict(
                **month,
                monthly_cap_microusd=settings['monthly_cap_microusd'],
                live_margin_microusd=LIVE_MARGIN,
            )

        return self._atomic(view)


def owner_spending(store, uid, company_id):
    # Do not grant edit access to superadmin support or rely on a caller's company ID.
    store.workspaces.company_actor(uid, company_id, manage=True)
    result = CompanySpending(store, company_id).summary()
    store.workspaces.company_actor(uid, company_id, manage=True)
    return result


class ReservedCall:
    """A pre-call hold, used when a route must lock its draft before provider dispatch."""

    def __init__(self, ledger, identifier):
        self.ledger = ledger
        self.identifier = identifier
        self.dispatched = False

    @classmethod
    def start(cls, store, uid, workspaces, model, operation, input_tokens):
        allowance = rest_allowance(model, input_tokens, operation)
        ledger = CompanySpending.actor(store, uid, workspaces)
        return cls(ledger, ledger.reserve(operation, allowance))

    def release_unused(self):
        if not self.dispatched:
            self.ledger.settle(self.identifier, 0)
