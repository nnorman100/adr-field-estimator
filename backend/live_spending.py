"""Soft Live spending threshold; provider automatic speech detection is preserved.

Unlike REST, Live has no provider-enforced session dollar bound. A margin is held
before connecting and usage expands that hold. Delayed usage can overshoot the
cap by roughly an in-flight session; this is explicitly not a hard billing cap.
"""

import math
import threading
import time
from datetime import datetime, timezone

try:
    from .ai_spending import CompanySpending, LIVE_MARGIN, SpendingError, limited
except ImportError:
    from ai_spending import CompanySpending, LIVE_MARGIN, SpendingError, limited


def live_cost(usage):
    """List-price estimate with conservative fallbacks for incomplete provider metadata."""
    total = getattr(usage, 'total_token_count', None)
    prompt = getattr(usage, 'prompt_token_count', None)
    if type(total) is not int or total < 0:
        return None
    if type(prompt) is not int or not 0 <= prompt <= total:
        # Without a reliable split, allow the highest rate plus transcription overhead.
        return (total * 165 + 9) // 10

    def units(details, count, rates, fallback):
        used = cost = 0
        for detail in details or []:
            tokens = getattr(detail, 'token_count', None)
            if type(tokens) is not int or tokens < 0 or used + tokens > count:
                return count * fallback
            modality = getattr(detail, 'modality', '')
            name = str(getattr(modality, 'value', modality)).upper()
            cost += tokens * rates.get(name, fallback)
            used += tokens
        return cost + (count - used) * fallback

    # Rates are hundredths of a micro-USD/token. Unclassified input uses audio's
    # rate; output/thinking/transcription without modality detail uses audio output.
    cost = units(
        getattr(usage, 'prompt_tokens_details', None),
        prompt,
        dict(TEXT=75, IMAGE=100, VIDEO=100, AUDIO=300),
        300,
    )
    cost += units(
        getattr(usage, 'response_tokens_details', None),
        total - prompt,
        dict(TEXT=450, AUDIO=1200),
        1200,
    )
    return (cost + 99) // 100


class LiveSpending:
    def __init__(self, ledger, reservation, month):
        self.ledger = ledger
        self.reservation = reservation
        self.started = time.monotonic()
        self.month = month
        self.cost = 0
        self.reported = False
        self.finished = False
        self.lock = threading.RLock()

    @classmethod
    def start(cls, store, uid, workspaces, model):
        if model != 'gemini-3.8-live':
            raise SpendingError(503, 'AI spending rates for this model have not been verified.')
        ledger = CompanySpending.actor(store, uid, workspaces)
        # Capture before reservation so a month change while the transaction returns
        # cannot make an old-month hold appear to cover a new-month connection.
        month = datetime.fromtimestamp(time.time(), timezone.utc).strftime('%Y-%m')
        return cls(ledger, ledger.reserve('live', LIVE_MARGIN, live=True), month)

    def estimate(self):
        # Each usage report includes that turn's context;
        # sum reports rather than treating context length as a session cumulative total.
        # A time floor ($0.10/min) also advances if provider usage is absent or delayed.
        return max(
            self.cost,
            math.ceil((time.monotonic() - self.started) * 100_000 / 60),
        )

    def observe(self, usage):
        with self.lock:
            cost = live_cost(usage)
            if cost is not None:
                self.cost += cost
                self.reported = True
            self.check()

    def check(self):
        with self.lock:
            if self.finished:
                return
            if datetime.fromtimestamp(time.time(), timezone.utc).strftime('%Y-%m') != self.month:
                # Reconnect creates a reservation on the new month, including resumed sessions.
                raise SpendingError(409, 'A new UTC month has started. Reconnect the walkthrough.')
            exhausted = self.ledger.live_usage(self.reservation, self.estimate())
            if exhausted is not None:
                raise limited(exhausted)

    def finish(self):
        with self.lock:
            if self.finished:
                return
            # An absent usage report is ambiguous, including connect/cancellation failures.
            cost = self.estimate() if self.reported else max(LIVE_MARGIN, self.estimate())
            self.ledger.settle(self.reservation, cost)
            self.finished = True
