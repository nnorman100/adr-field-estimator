"""Internal job summaries: the model selects facts; only the server writes prose."""

import hashlib
import json
import re
from datetime import datetime, timedelta, timezone
from typing import Literal

from pydantic import Field

try:
    from .contracts import StrictModel, InspectionData
    from .claims import JSON_TERM, FIELD_NAME
    from .readiness import readiness
    from .sizing import equipment_sizing, count
    from .inspection_store import Conflict
    from . import ai_features
except ImportError:
    from contracts import StrictModel, InspectionData
    from claims import JSON_TERM, FIELD_NAME
    from readiness import readiness
    from sizing import equipment_sizing, count
    from inspection_store import Conflict
    import ai_features

TOPICS = Literal[
    'rooms',
    'equipment',
    'evidence',
    'readiness',
    'sizing',
    'review',
    'claim',
    'delivery',
    'monitoring',
]
TTL_DAYS = 30


class JobSummary(StrictModel):
    topics: list[TOPICS] = Field(min_length=1, max_length=4)


def fact_pack(job, record, log, delivery, monitoring):
    signed = bool(job.get('auth_id'))
    data = (record.get('inspection') if signed else record.get('data')) or {}
    docs = (
        record.get('documents') if signed else (record.get('audit') or {}).get('documents')
    ) or {}
    claim = (docs.get('claim') if signed else job.get('claim')) or {}
    photos = record.get('photos') or []
    rooms = data.get('rooms') or []
    pack = dict(
        version=1,
        status='signed' if signed else 'draft',
        customer=job.get('customer_name', ''),
        address=data.get('address', '') or record.get('address', ''),
        room_count=len(rooms),
        rooms=[
            {k: r.get(k) for k in ('name', 'category', 'loss', 'finished_sf', 'unfinished_sf')}
            for r in rooms
        ],
        categories=sorted({r['category'] for r in rooms if r.get('category') in (1, 2, 3)}),
        mold_rooms=sum(
            (r.get('loss') or ('mold' if r.get('category') == 3 else 'water')) == 'mold'
            for r in rooms
        ),
        air_movers=data.get('air_movers'),
        dehumidifiers=data.get('dehumidifiers'),
        drying_days=data.get('drying_days'),
        photo_count=len(photos),
        unverified_photos=sum(p.get('ocr_status') in ('pending', 'failed') for p in photos),
        claim_recorded=any(bool(v) for v in claim.values()),
        adjuster_recorded=bool(claim.get('adjuster_name') or claim.get('adjuster_email')),
        reviewed=bool(docs),
        unpriced_count=len(docs.get('unpriced_work') or []),
        scope_confirmed=bool(data.get('scope_confirmed')),
        delivery_recorded=bool(delivery),
        delivery={
            status: sum(
                e.get('status') == status for e in (delivery or {}).get('entries', {}).values()
            )
            for status in ('queued', 'sending', 'sent', 'failed', 'skipped')
        },
    )
    if ai_features.enabled('readiness') and not signed:
        pack['readiness_gaps'] = len(
            readiness(data, photos, claim, log.get('readings', []))['gaps']
        )
    try:
        sizing = equipment_sizing(InspectionData.model_validate(data))
    except ValueError:
        sizing = None
    if sizing:
        pack['sizing_status'] = sizing['status']
        pack['sizing_flags'] = sum(
            (sizing.get(k) or {}).get('flag') not in (None, 'within')
            for k in ('air_movers', 'dehumidifiers')
        )
    if monitoring:
        pack['monitoring_status'] = monitoring['status']
        pack['monitoring_flags'] = monitoring['flags']
        pack['day_number'] = monitoring['day_number']
        pack['planned_days'] = monitoring['planned_days']
    return pack


def sentences(pack):
    result = {
        'rooms': count(pack['room_count'], 'affected room')
        + '; categories '
        + (', '.join(map(str, pack['categories'])) or 'not recorded')
        + '; '
        + count(pack['mold_rooms'], 'room')
        + ' recorded as mold.',
        'equipment': 'Planned equipment: '
        + (
            count(pack['air_movers'], 'air mover')
            if pack['air_movers'] is not None
            else 'air movers not recorded'
        )
        + ' and '
        + (
            count(pack['dehumidifiers'], 'dehumidifier')
            if pack['dehumidifiers'] is not None
            else 'dehumidifiers not recorded'
        )
        + (
            ' for ' + count(pack['drying_days'], 'day') + '.'
            if pack['drying_days'] is not None
            else '; drying days not recorded.'
        ),
        'evidence': count(pack['photo_count'], 'photo')
        + f'; {pack["unverified_photos"]} awaiting reading verification.',
        'review': (
            'The scope review lists ' + count(pack['unpriced_count'], 'unpriced item') + '.'
            if pack['reviewed']
            else 'The scope review has not been saved.'
        ),
        'claim': (
            'Insurance claim details are recorded; '
            + (
                'adjuster details are recorded.'
                if pack['adjuster_recorded']
                else 'adjuster details are missing.'
            )
            if pack['claim_recorded']
            else 'Insurance claim details are not recorded.'
        ),
    }
    if 'readiness_gaps' in pack:
        result['readiness'] = 'Readiness: ' + count(pack['readiness_gaps'], 'advisory gap') + '.'
    if 'sizing_status' in pack:
        result['sizing'] = {
            'not_available': 'The drying equipment check needs more inputs.',
            'not_applicable': 'The drying equipment check does not apply to the recorded rooms.',
            'available': 'The drying equipment check has '
            + count(pack['sizing_flags'], 'flag')
            + '.',
        }[pack['sizing_status']]
    if pack['status'] == 'signed':
        result['delivery'] = (
            'Document delivery: '
            + ', '.join(f'{count} {status}' for status, count in pack['delivery'].items())
            + '.'
            if pack['delivery_recorded']
            else 'No document delivery record is available.'
        )
    if 'monitoring_status' in pack:
        status = {
            'active': 'monitoring active',
            'dry_standard_met': 'recorded materials meet their dry standards',
            'marked_dry': 'marked dry by staff',
            'closed': 'monitoring closed',
        }[pack['monitoring_status']]
        flags = [
            label
            for key, label in [
                ('stalled', 'stalled readings'),
                ('overdue', 'reading overdue'),
                ('past_signed_plan', 'past signed plan'),
            ]
            if key in pack['monitoring_flags']
        ]
        result['monitoring'] = (
            f'Day {pack["day_number"]} of {pack["planned_days"]} signed days: {status}'
            + ('; ' + ', '.join(flags) if flags else '')
            + '.'
        )
    return result


def validate_summary(selection, pack):
    selection = JobSummary.model_validate(selection)
    options = sentences(pack)
    if len(set(selection.topics)) != len(selection.topics) or any(
        k not in options for k in selection.topics
    ):
        raise ValueError('Summary selected an unavailable or repeated fact.')
    text = ('Signed agreement. ' if pack['status'] == 'signed' else 'Draft scope. ') + ' '.join(
        options[k] for k in selection.topics
    )
    numbers = set(re.findall(r'\d+(?:\.\d+)?', json.dumps(pack)))
    if (
        len(text.split()) > 80
        or '$' in text
        or JSON_TERM.search(text)
        or FIELD_NAME.search(text)
        or not set(re.findall(r'\d+(?:\.\d+)?', text)) <= numbers
    ):
        raise ValueError('Summary failed grounding checks.')
    return text


def facts_hash(pack):
    return hashlib.sha256(
        json.dumps(pack, sort_keys=True, separators=(',', ':')).encode()
    ).hexdigest()


class Insights:
    def __init__(self, store):
        self.store, self.w = store, store.workspaces

    def read(self, uid, identifier, support_company=None, tx=None):
        source = (
            {'auth_id': identifier}
            if identifier.startswith('ADR-AUTH-')
            else {'inspection_id': identifier}
        )
        job = (
            self.w.support_job(uid, support_company, source, tx)
            if support_company
            else self.w.job_access(uid, source, tx=tx)[0]
        )
        record = (
            self.w.read('authorizations', job['auth_id'], tx)
            if job.get('auth_id')
            else self.w.read('inspections', job['job_id'], tx)
        )
        if not record:
            raise LookupError('Job source not found.')
        log = self.w.read('drying_logs', job['job_id'], tx) or {}
        delivery = self.w.read('_job_deliveries', job['job_id'], tx)
        monitoring = None
        if ai_features.enabled('drying_watch') and job.get('auth_id'):
            try:
                monitoring = self.w.monitoring.compute(job, tx, log)
            except LookupError:
                pass  # Older signed records may lack a drying plan.
        pack = fact_pack(job, record, log, delivery, monitoring)
        return job, pack

    def view(self, uid, identifier, support_company=None):
        def read(tx):
            job, pack = self.read(uid, identifier, support_company, tx)
            cached = self.w.read('_job_insights', job['job_id'], tx) or {}
            digest = facts_hash(pack)
            narrative = None
            if (
                cached.get('company_id') == job['company_id']
                and cached.get('facts_hash') == digest
                and isinstance(cached.get('expire_at'), datetime)
                and cached['expire_at'] > datetime.now(timezone.utc)
            ):
                try:
                    narrative = validate_summary(cached.get('selection'), pack)
                except ValueError:
                    pass
            if support_company:
                self.w.event(
                    tx, uid, 'support_view_insight', support_company, {}, 'job/' + job['job_id']
                )
            return dict(
                job_id=job['job_id'],
                facts=pack,
                fact_lines=[
                    f'Room: {r["name"] or "Unnamed"}; category {r["category"] or "not recorded"}; planned demolition {r["finished_sf"] or 0} finished SF, {r["unfinished_sf"] or 0} unfinished SF.'
                    for r in pack.get('rooms', [])
                ]
                + list(sentences(pack).values()),
                facts_hash=digest,
                narrative=narrative,
                generated_at=cached.get('generated_at') if narrative else None,
                stale=bool(cached and not narrative),
            )

        return self.w._run(read)

    def save(self, uid, identifier, expected_hash, selection):
        def save(tx):
            job, pack = self.read(uid, identifier, tx=tx)
            if facts_hash(pack) != expected_hash:
                raise Conflict('The job facts changed. Refresh the summary.')
            narrative = validate_summary(selection, pack)
            moment = datetime.now(timezone.utc)
            tx.set(
                self.w.ref('_job_insights', job['job_id']),
                dict(
                    company_id=job['company_id'],
                    facts_hash=expected_hash,
                    narrative=narrative,
                    selection=JobSummary.model_validate(selection).model_dump(),
                    generated_at=moment.isoformat(),
                    expire_at=moment + timedelta(days=TTL_DAYS),
                ),
            )

        self.w._run(save)
        return self.view(uid, identifier)
