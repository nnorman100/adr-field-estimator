"""Job close and the estimate-accuracy statistics: a private sidecar, never part of a signed record.

`_estimate_history/{company_id}` holds one row per signed job. Every number here is server
arithmetic over the company's own rows; no model reads or writes any of it.
"""

import logging
import re
from decimal import ROUND_CEILING, ROUND_HALF_UP, Decimal
from typing import Any

from pydantic import Field

try:
    from . import ai_features
    from .claims import LABOR_MATERIAL_CODES
    from .cloud_log import event
    from .contracts import InspectionData, StrictModel
    from .inspection_store import Conflict, now
    from .price_books import CALCULATION_VERSION as RATE_BOOK_VERSION, saved_basis
    from .price_table import CALCULATION_VERSION as TABLE_VERSION, assist_of
    from .pricing import price_and_range
    from .workspaces import AccessDenied
except ImportError:
    import ai_features
    from claims import LABOR_MATERIAL_CODES
    from cloud_log import event
    from contracts import InspectionData, StrictModel
    from inspection_store import Conflict, now
    from price_books import CALCULATION_VERSION as RATE_BOOK_VERSION, saved_basis
    from price_table import CALCULATION_VERSION as TABLE_VERSION, assist_of
    from pricing import price_and_range
    from workspaces import AccessDenied

HISTORY = '_estimate_history'
ROW_LIMIT = 300
COVERAGE = Decimal('0.8')
MIN_JOBS = 5
CENT = Decimal('0.01')
MAX_FINAL = Decimal('2000000.00')
MAX_ACTUAL_DAYS = 365
CATEGORIES = (1, 2, 3)
FINISHED_WATCH = ('dry_standard_met', 'marked_dry', 'closed')
AMOUNT = re.compile(r'[0-9]{1,7}(\.[0-9]{1,2})?')

NOT_SIGNED = 'Close a job after it is signed.'
NOT_ALLOWED = 'Only the owner or office staff can close a job.'
STALE = 'Reload this job.'
BAD_AMOUNT = 'Enter the final invoiced amount as dollars and cents.'
BAD_DAYS = 'Actual drying days must be a whole number from 0 to 365.'
NO_AMOUNTS = 'This older agreement has no saved estimate to compare with.'
NO_CLOSED_JOBS = 'Close a signed job to start tracking.'
COVERAGE_NOTE = (
    'These numbers count everything that raised the invoice above the low end: hidden damage, '
    'more equipment, approved extras and more days. You decide what to change.'
)
REASONS = {
    'rate_book': 'Suggestions apply to your own price table.',
    'single_price': 'Suggestions apply to a low to high range. Your company prints one price.',
}
LANDED_TEXT = {
    'range': {
        'inside': 'inside the range',
        'below': 'below the low end',
        'above': 'above the high end',
    },
    'single': {'inside': 'at or under the price', 'above': 'above the price'},
}


class JobClose(StrictModel):
    # Any, so a malformed amount or day count gets the fixed message instead of a schema error.
    final_amount: Any = None
    actual_days: Any = None
    note: str = Field(default='', max_length=300)
    expected_signed_at: str = Field(min_length=1, max_length=64)


def _money(value):
    return str(Decimal(str(value)).quantize(CENT, rounding=ROUND_HALF_UP))


def _final_amount(value):
    if not isinstance(value, str) or not AMOUNT.fullmatch(value.strip()):
        raise ValueError(BAD_AMOUNT)
    amount = Decimal(value.strip())
    if not CENT <= amount <= MAX_FINAL:
        raise ValueError(BAD_AMOUNT)
    return _money(amount)


def _actual_days(value):
    if value is None:
        return None
    if type(value) is not int or not 0 <= value <= MAX_ACTUAL_DAYS:
        raise ValueError(BAD_DAYS)
    return value


def _labor_material_low(body, data, pin, version):
    """The low end's labor-and-material lines. A failure here never stops a signature: the job
    still counts in the hit rate, and without this number it stays out of the overrun."""
    if version != TABLE_VERSION:
        items = (body.get('documents') or {}).get('xactimate_scope') or []
        return sum(
            (
                Decimal(str(item['total']))
                for item in items
                if item.get('code') in LABOR_MATERIAL_CODES
            ),
            Decimal(0),
        )
    if not pin:
        return Decimal(0)
    try:
        lines = price_and_range(InspectionData.model_validate(data), pin).lines
        return sum(
            (Decimal(str(line['total'])) for line in lines if line['bucket'] == 'labor_material'),
            Decimal(0),
        )
    except (ValueError, KeyError, TypeError, ArithmeticError, RuntimeError) as error:
        event(
            'Estimate history could not price a signed job',
            logging.WARNING,
            operation='estimate_history',
            outcome=type(error).__name__,
        )
        return Decimal(0)


def room_area(room, wet_basis):
    """A room's area on its table's basis: the wet floor, or the demolition area."""
    if not wet_basis:
        return Decimal(str(room.get('unfinished_sf') or 0)) + Decimal(
            str(room.get('finished_sf') or 0)
        )
    wet = room.get('wet_floor_sf')
    return Decimal(str((room.get('floor_sf') or 0) if wet is None else wet))


def history_row_at_signing(job, body, data, pin):
    """One signed job's row, from the proposal it was signed on. Takes no price from the phone."""
    documents = body.get('documents') or {}
    version = (
        (pin or {}).get('calculation_version')
        or (saved_basis({'documents': documents}) or {}).get('calculation_version')
        or RATE_BOOK_VERSION
    )
    if body.get('proposed_cost') is None:
        raise ValueError(NO_AMOUNTS)
    single = body.get('proposed_cost_low') is None
    rooms = data.get('rooms') or []
    wet_basis = (
        version == TABLE_VERSION and ((pin or {}).get('policy') or {}).get('area_basis')
    ) == 'wet_floor'
    categories = {room.get('category', 1) for room in rooms}
    return dict(
        auth_id=body.get('auth_id') or job.get('auth_id'),
        signed_at=job.get('signed_at') or body.get('created_at'),
        calculation_version=version,
        estimate_mode='single' if single else 'range',
        sf=_money(sum((room_area(room, wet_basis) for room in rooms), Decimal(0))),
        category=max(categories, default=1),
        single_category=len(categories) == 1,
        low=_money(body['proposed_cost'] if single else body['proposed_cost_low']),
        high=None if single else _money(body['proposed_cost']),
        labor_material_low=_money(_labor_material_low(body, data, pin, version)),
        planned_days=data.get('drying_days'),
    )


def landed(final, row):
    final, low = Decimal(final), Decimal(row['low'])
    if row.get('high') is None:
        return 'inside' if final <= low else 'above'
    if final < low:
        return 'below'
    return 'inside' if final <= Decimal(row['high']) else 'above'


def _landed_text(row):
    return LANDED_TEXT[row['estimate_mode']][row['landed']]


def p80(values):
    """Nearest-rank 80th percentile: the smallest value that covers 4 of 5 of them."""
    ordered = sorted(values)
    rank = int((COVERAGE * len(ordered)).to_integral_value(rounding=ROUND_CEILING))
    return ordered[rank - 1]


def _up_to(value, step):
    return int((Decimal(value) / step).to_integral_value(rounding=ROUND_CEILING)) * step


def _percent_suggestion(rows):
    """The percent that would have covered 4 of 5 of these jobs, rounded up to the next 5."""
    overruns = [_overrun(row) for row in rows]
    overruns = [value for value in overruns if value is not None]
    if len(overruns) < MIN_JOBS:
        return dict(value=None, jobs=len(overruns))
    return dict(value=str(min(_up_to(p80(overruns) * 100, 5), 100)), jobs=len(overruns))


def _overrun(row):
    labor_material = Decimal(row.get('labor_material_low') or 0)
    if labor_material <= 0:
        return None
    return max(Decimal(0), Decimal(row['final']) - Decimal(row['low'])) / labor_material


def _extra_days(rows):
    extras = [
        max(0, row['actual_days'] - row['planned_days'])
        for row in rows
        if row.get('actual_days') is not None and row.get('planned_days') is not None
    ]
    if len(extras) < MIN_JOBS:
        return dict(value=None, jobs=len(extras))
    return dict(value=min(p80(extras), 30), jobs=len(extras))


def _plural(count, word):
    return f'{count} {word}' if count == 1 else f'{count} {word}s'


def _days_sentence(days):
    if not days['jobs']:
        return None
    jobs = _plural(days['jobs'], 'closed job') + ' with actual days'
    if days['value'] is None:
        return f'Drying days: {jobs} so far. A number needs at least {MIN_JOBS}.'
    if not days['value']:
        return f'Drying days: 4 of 5 of your {jobs} finished within the planned days.'
    extra = _plural(days['value'], 'extra day')
    return f'Drying days: {extra} would have covered 4 of 5 of your {jobs}.'


def _category_sentence(category, suggestion):
    if suggestion['value'] is None:
        if not suggestion['jobs']:
            return None
        jobs = _plural(suggestion['jobs'], 'single-category job')
        return f'Category {category} rooms: {jobs} so far. A suggestion needs at least {MIN_JOBS}.'
    return (
        f'Category {category} rooms: a {suggestion["value"]}% allowance would have covered '
        f'4 of 5 of your {_plural(suggestion["jobs"], "single-category job")}.'
    )


def _cushion_sentence(suggestion):
    if suggestion['value'] is None:
        if not suggestion['jobs']:
            return None
        jobs = _plural(suggestion['jobs'], 'closed job')
        return f'Range cushion: {jobs} so far. A suggestion needs at least {MIN_JOBS}.'
    return (
        f'Range cushion: {suggestion["value"]}% on labor and materials would have covered '
        f'4 of 5 of your {_plural(suggestion["jobs"], "closed job")}.'
    )


def statistics(rows, book=None):
    """The owner's numbers. book is the company's current table, or None for a rate book."""
    closed = [row for row in rows if row.get('closed_at')]
    counts = {
        name: sum(row.get('landed') == name for row in closed) for name in LANDED_TEXT['range']
    }
    per_category = {
        str(category): [
            row for row in closed if row.get('single_category') and row['category'] == category
        ]
        for category in CATEGORIES
    }
    policy = (
        book.get('policy') if book and book.get('calculation_version') == TABLE_VERSION else None
    )
    mode = policy['estimate_mode'] if policy else 'range'
    method = assist_of(policy)['range_method'] if policy else None
    place = LANDED_TEXT[mode]['inside']
    result = dict(
        signed=sum(bool(row.get('signed_at')) for row in rows),
        closed=len(closed),
        **counts,
        inside_percent=int(
            (Decimal(100 * counts['inside']) / len(closed)).quantize(1, rounding=ROUND_HALF_UP)
        )
        if closed
        else None,
        counts={category: len(jobs) for category, jobs in per_category.items()},
        method=method,
        estimate_mode=mode if policy else None,
        calculation_version=book.get('calculation_version') if book else None,
        suggestions=None,
        reason=None,
    )
    days = _extra_days(closed)
    if not closed:
        result.update(headline=NO_CLOSED_JOBS, days=days, sentences=[NO_CLOSED_JOBS])
        return result
    result.update(
        headline=(
            f'{counts["inside"]} of {_plural(len(closed), "closed job")} landed {place}'
            f' · {counts["above"]} above'
            + (f' · {counts["below"]} below' if mode == 'range' else '')
        ),
        days=days,
    )
    sentences = [
        f'In {counts["inside"]} of {_plural(len(closed), "closed job")} '
        f'the final invoice landed {place}.'
    ]
    if not policy:
        result['reason'] = 'rate_book'
    elif mode == 'single':
        result['reason'] = 'single_price'
    elif method == 'uncertainty':
        hidden = {name: _percent_suggestion(jobs) for name, jobs in per_category.items()}
        result['suggestions'] = dict(hidden_damage_percent=hidden, extra_drying_days=days)
        sentences += [_category_sentence(int(name), hidden[name]) for name in hidden]
    else:
        cushion = _percent_suggestion(closed)
        sentences.append(_cushion_sentence(cushion))
        beyond = policy['range']['beyond_percent']
        if cushion['value'] is not None and Decimal(cushion['value']) < Decimal(beyond):
            cushion['value'] = beyond
            sentences.append(
                f'The suggestion is {beyond}%, because this cushion cannot be less than your '
                f'{beyond}% cushion beyond the first square feet.'
            )
        result['suggestions'] = dict(first_percent=cushion)
    sentences.append(_days_sentence(days))
    sentences.append(COVERAGE_NOTE if result['suggestions'] else REASONS[result['reason']])
    result['sentences'] = [sentence for sentence in sentences if sentence]
    return result


class Outcomes:
    def __init__(self, workspaces):
        self.ws = workspaces

    def ref(self, company_id):
        return self.ws.ref(HISTORY, company_id)

    def _rows(self, company_id, tx=None):
        return (self.ws.read(HISTORY, company_id, tx) or {}).get('rows') or {}

    def _write(self, tx, company_id, rows, job_id, row):
        """The job being written always stays; past the limit the oldest other row goes."""
        rows = {**rows, job_id: row}
        while len(rows) > ROW_LIMIT:
            others = [key for key in rows if key != job_id]
            del rows[min(others, key=lambda key: rows[key].get('signed_at') or '')]
        tx.set(self.ref(company_id), dict(company_id=company_id, updated_at=now(), rows=rows))

    def record_signing(self, job, body, tx):
        """Inside the signing transaction, before its first write: this reads."""
        pin = self.ws.prices._pin(job['job_id'], tx)
        rows = self._rows(job['company_id'], tx)
        row = history_row_at_signing(job, body, body.get('inspection') or {}, pin)
        self._write(tx, job['company_id'], rows, job['job_id'], row)

    def close(self, uid, job_id, req):
        def commit(tx):
            job, actor = self.ws.job_access(uid, {'inspection_id': job_id}, 'read', tx)
            if 'coordination' not in actor['capabilities']:
                raise AccessDenied(NOT_ALLOWED)
            if not job.get('auth_exists'):
                raise Conflict(NOT_SIGNED)
            if job.get('signed_at') != req.expected_signed_at:
                raise Conflict(STALE)
            final = _final_amount(req.final_amount)
            days = _actual_days(req.actual_days)
            company_id = job['company_id']
            rows = self._rows(company_id, tx)
            row = rows.get(job_id) or self._row_from_agreement(job, tx)
            row = dict(
                row,
                closed_at=now(),
                closed_by_uid=uid,
                final=final,
                actual_days=days,
                note=' '.join(req.note.split()),
            )
            row['landed'] = landed(final, row)
            self._write(tx, company_id, rows, job_id, row)
            self.ws.event(
                tx,
                uid,
                'job_closed',
                company_id,
                {'job_id': job_id, 'landed': row['landed']},
                'job/' + job_id,
            )

        self.ws._run(commit)
        return self.view(uid, job_id)

    def _row_from_agreement(self, job, tx):
        """A job signed before this feature, or trimmed since, gets its row when it closes."""
        agreement = self.ws.read('authorizations', job['auth_id'], tx)
        if not agreement:
            raise LookupError('Signed agreement not found.')
        pin = self.ws.prices._pin(job['job_id'], tx)
        return history_row_at_signing(job, agreement, agreement.get('inspection') or {}, pin)

    def view(self, uid, job_id):
        job, actor = self.ws.job_access(uid, {'inspection_id': job_id}, 'read')
        if not job.get('auth_exists'):
            raise LookupError('This job is not signed.')
        row = self._rows(job['company_id']).get(job_id) or {}
        closed = bool(row.get('closed_at'))
        if 'coordination' not in actor['capabilities']:
            return dict(closed=closed, closed_at=row.get('closed_at'), can_close=False)
        agreement = self.ws.read('authorizations', job['auth_id']) or {}
        planned = (agreement.get('inspection') or {}).get('drying_days')
        suggested, source = self._suggested_days(job, planned)
        return dict(
            closed=closed,
            closed_at=row.get('closed_at'),
            final=row.get('final'),
            actual_days=row.get('actual_days'),
            note=row.get('note', ''),
            landed=row.get('landed'),
            landed_text=_landed_text(row) if closed else None,
            suggested_actual_days=suggested,
            suggested_days_source=source,
            planned_days=planned,
            signed_at=job.get('signed_at'),
            can_close=True,
        )

    def _suggested_days(self, job, planned):
        if ai_features.enabled('drying_watch'):
            try:
                watch = self.ws.monitoring.compute(job)
            except (LookupError, ValueError, TypeError):
                watch = None
            if watch and watch.get('status') in FINISHED_WATCH:
                return watch['day_number'], 'drying_watch'
        return planned, 'plan'

    def accuracy(self, uid, company_id):
        actor = self.ws.company_actor(uid)
        if actor['company_id'] != company_id:
            raise LookupError('Company not found.')
        if 'prices_manage' not in actor['capabilities']:
            raise AccessDenied('Only the company owner can read estimate accuracy.')
        try:
            book = self.ws.prices.effective(actor['company'])
        except Conflict:
            book = None
        return statistics(list(self._rows(company_id).values()), book)
