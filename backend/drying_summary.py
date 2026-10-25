"""Closed model selections rendered from deterministic monitoring facts."""

from typing import Literal
from pydantic import Field, StrictInt

try:
    from .contracts import StrictModel
except ImportError:
    from contracts import StrictModel


class RoomSummary(StrictModel):
    room_index: StrictInt = Field(ge=0)
    trend: Literal['recorded', 'stalled', 'improving', 'no_new_reading', 'at_dry_standard']
    mention: Literal['status', 'moisture', 'air', 'progress']


class DryingSummary(StrictModel):
    rooms: list[RoomSummary] = Field(min_length=1, max_length=2)


def room_names(facts):
    return list(dict.fromkeys(
        [m['room'] for m in facts['materials']]
        + [a['room'] for a in facts['air']]
        + facts['missing_rooms']
    )) or [None]


def summary_options(facts):
    names = room_names(facts)
    options = []
    for index, name in enumerate(names):
        materials = [m for m in facts['materials'] if m['room'] == name]
        air = [a for a in facts['air'] if a['room'] == name]
        trend = (
            'at_dry_standard' if facts['status'] == 'dry_standard_met'
            else 'no_new_reading' if name in facts['missing_rooms'] or not (materials or air)
            else facts.get('air_trends', {}).get(name, 'recorded')
        )
        mentions = ['status']
        if materials:
            mentions.append('moisture')
        if air:
            mentions.extend(['air', 'progress'])
        options.append(dict(room_index=index, trend=trend, mentions=mentions))
    return options


def validate_summary(result, facts):
    result = DryingSummary.model_validate(result)
    options = summary_options(facts)
    names = room_names(facts)
    clauses = []
    seen = set()
    labels = {
        'recorded': 'readings recorded',
        'stalled': 'stalled',
        'improving': 'improving',
        'no_new_reading': 'no new reading',
        'at_dry_standard': 'at dry standard',
    }
    for selection in result.rooms:
        index = selection.room_index
        if index >= len(options) or index in seen:
            raise ValueError('Unknown or repeated summary room.')
        option = options[index]
        if selection.trend != option['trend'] or selection.mention not in option['mentions']:
            raise ValueError('Summary selection does not match recorded facts.')
        seen.add(index)
        clause = f"Room {index + 1}: {labels[selection.trend]}"
        if selection.mention == 'moisture':
            material = next(m for m in facts['materials'] if m['room'] == names[index])
            reference = material['dry_standard']
            clause += f"; moisture {material['moisture']}, reference {reference if reference is not None else 'not set'}"
        elif selection.mention in ('air', 'progress'):
            air = next(a for a in facts['air'] if a['room'] == names[index])
            if selection.mention == 'air':
                clause += f"; affected air {air['latest_gpp']} GPP, reference {air['reference_gpp']} GPP"
            else:
                clause += f"; progress {air['percent']}%"
        clauses.append(clause)
    return f"Day {facts['day_number']} of {facts['planned_days']}. " + '; '.join(clauses) + '.'
