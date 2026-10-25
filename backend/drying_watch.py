"""Pull-based drying monitoring. Only the private sidecar is mutable after signing."""

import hashlib
import json
import math
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

ZONE = ZoneInfo('America/Los_Angeles')


def instant(value):
    if isinstance(value, datetime):
        return value.replace(tzinfo=value.tzinfo or timezone.utc)
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    return parsed.replace(tzinfo=parsed.tzinfo or timezone.utc)


def iso(value):
    return value.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')


def day(value):
    return instant(value).astimezone(ZONE).date().isoformat()


def rounded(value):
    # Math.round parity, including negative half values.
    return math.floor(value + 0.5)


def day_groups(readings, rooms):
    """Port of summarizeLog, using the California company's calendar, independent of server TZ."""
    ordered = sorted(readings, key=lambda r: (r['taken_at'], r.get('recorded_at', '')))
    days = sorted({day(r['taken_at']) for r in ordered})
    names = [r['name'] for r in rooms]
    order = list(dict.fromkeys(names + [r['room'] for r in ordered if r['room']] + ['']))
    references = [r for r in ordered if r['kind'] == 'air' and r['zone'] == 'unaffected']
    outsides = [r for r in ordered if r['kind'] == 'air' and r['zone'] == 'outside']

    def last(rows):
        return rows[-1] if rows else None

    groups = []
    for room in order:
        mine = [r for r in ordered if r['room'] == room]
        room_days = []
        for key in dict.fromkeys(day(r['taken_at']) for r in mine):
            rows = [r for r in mine if day(r['taken_at']) == key]

            def air(zone):
                return last([r for r in rows if r['kind'] == 'air' and r['zone'] == zone])

            affected, outlet = air('affected'), air('dehu_outlet')
            inlet = air('dehu_inlet') or affected
            reference = last([r for r in references if day(r['taken_at']) <= key])
            outside = last([r for r in outsides if day(r['taken_at']) <= key])
            depression = vapor = None
            if inlet and outlet:
                delta = rounded(inlet['gpp'] - outlet['gpp'])
                depression = dict(
                    delta_gpp=delta,
                    status=(
                        'optimal'
                        if delta >= 20
                        else 'acceptable'
                        if delta >= 12
                        else 'low'
                        if delta > 0
                        else 'none'
                    ),
                    efficiency_percent=(
                        min(100, rounded(delta / max(1, inlet['gpp']) * 100)) if delta > 0 else 0
                    ),
                )
            if affected and outlet:
                delta = round(affected['vapor_pressure_inhg'] - outlet['vapor_pressure_inhg'], 3)
                vapor = dict(
                    delta_inhg=delta,
                    potential=(
                        'high'
                        if delta >= 0.25
                        else 'moderate'
                        if delta >= 0.12
                        else 'low'
                        if delta > 0
                        else 'stagnant'
                    ),
                )
            room_days.append(
                dict(
                    key=key,
                    number=(datetime.fromisoformat(key) - datetime.fromisoformat(days[0])).days + 1,
                    readings=rows,
                    affected=affected,
                    reference=reference,
                    outside=outside,
                    above_standard=rounded(affected['gpp'] - reference['gpp'])
                    if affected and reference
                    else None,
                    depression=depression,
                    vapor=vapor,
                    system=('open' if outside['gpp'] < affected['gpp'] - 20 else 'closed')
                    if affected and outside
                    else None,
                )
            )
        tracked = [d for d in room_days if d['affected']]
        progress = None
        if tracked and tracked[-1]['reference']:
            first, latest = tracked[0], tracked[-1]
            span = first['affected']['gpp'] - latest['reference']['gpp']
            percent = (
                (100 if latest['affected']['gpp'] <= latest['reference']['gpp'] else 0)
                if span <= 0
                else max(
                    0,
                    min(
                        100,
                        rounded(
                            (first['affected']['gpp'] - latest['affected']['gpp']) / span * 100
                        ),
                    ),
                )
            )
            progress = dict(
                first_gpp=first['affected']['gpp'],
                latest_gpp=latest['affected']['gpp'],
                reference_gpp=latest['reference']['gpp'],
                percent=percent,
                days=latest['number'] - first['number'] + 1,
            )
        if room in names or mine:
            groups.append(
                dict(
                    room=room,
                    known=room in names,
                    days=room_days,
                    progress=progress,
                    count=len(mine),
                )
            )
    return dict(days=days, groups=groups)


def watch_state(data, log, setup_at, previous=None, at=None):
    previous = previous or {}
    at = at or datetime.now(timezone.utc)
    # Future entries cannot postpone a visit or attest that a material is dry today.
    readings = sorted(
        [r for r in log.get('readings', []) if instant(r['taken_at']) <= at],
        key=lambda r: (instant(r['taken_at']), r.get('recorded_at', '')),
    )
    grouped = day_groups(readings, data.get('rooms', []))
    materials = {}
    for r in readings:
        if r['kind'] == 'material' and r.get('affected', True):
            materials[(r['room'], r['material'].casefold(), r['unit'].casefold())] = r
    latest = list(materials.values())
    # No air-only or partial-room log can attest that all affected materials are dry.
    missing_rooms = [
        r['name']
        for r in data.get('rooms', [])
        if len([m for m in latest if m['room'] == r['name']]) < (r['wet_materials'] if r.get('wet_materials') is not None else 1)
    ]
    dry = (
        bool(data.get('rooms'))
        and not missing_rooms
        and all(
            r.get('dry_standard') is not None and r['moisture'] <= r['dry_standard'] for r in latest
        )
    )
    last = readings[-1]['taken_at'] if readings else None
    due = instant(last or setup_at) + timedelta(days=1)
    number = max(
        1, (at.astimezone(ZONE).date() - instant(setup_at).astimezone(ZONE).date()).days + 1
    )
    flags = []
    if not data.get('rooms') or missing_rooms or any(r.get('dry_standard') is None for r in latest):
        flags.append('missing_dry_standard')
    air_trends = {}
    for g in grouped['groups']:
        air_days = [d for d in g['days'] if d['affected']]
        stalled = len(air_days) >= 3 and all(
            air_days[i]['affected']['gpp'] >= air_days[i - 1]['affected']['gpp'] for i in (-2, -1)
        )
        improving = len(air_days) >= 2 and (
            air_days[-1]['affected']['gpp'] < air_days[-2]['affected']['gpp']
        )
        air_trends[g['room']] = (
            'stalled' if stalled else 'improving' if improving else 'recorded'
        )
    if 'stalled' in air_trends.values():
        flags.append('stalled')
    status = 'dry_standard_met' if dry else 'active'
    if previous.get('closed'):
        status = 'marked_dry' if previous['closed']['action'] == 'mark_dry' else 'closed'
    if status == 'active':
        if due < at:
            flags.append('overdue')
        elif due.astimezone(ZONE).date() == at.astimezone(ZONE).date():
            flags.append('due_today')
        if number > data['drying_days']:
            flags.append('past_signed_plan')
    else:
        flags = []
    return dict(
        status=status,
        planned_days=data['drying_days'],
        day_number=number,
        setup_at=setup_at,
        last_reading_at=last,
        next_due_at=iso(due) if status == 'active' else None,
        flags=flags,
        log_updated_at=log.get('updated_at'),
        materials=[
            {k: r.get(k) for k in ('room', 'material', 'unit', 'moisture', 'dry_standard')}
            for r in latest
        ],
        air=[dict(room=g['room'], **g['progress']) for g in grouped['groups'] if g['progress']],
        missing_rooms=missing_rooms,
        air_trends=air_trends,
    )


def facts(watch):
    # No customer, address, transcript, notes, price or email enters the model.
    return {
        k: watch[k]
        for k in (
            'status',
            'planned_days',
            'day_number',
            'flags',
            'materials',
            'air',
            'missing_rooms',
            'air_trends',
        )
    }


def facts_hash(watch):
    body = dict(facts(watch), log_updated_at=watch.get('log_updated_at'))
    return hashlib.sha256(
        json.dumps(body, sort_keys=True, separators=(',', ':')).encode()
    ).hexdigest()
