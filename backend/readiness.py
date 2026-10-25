"""Advisory gaps only. Never stored, priced, or used as a signing gate.

The device mirror is ADRCore.readiness / missingItems; shared fixtures pin parity.
A setup reading is the first affected air or material reading in the drying log:
there is no separate equipment setup timestamp or visit type in today's schema.
"""

try:
    from .shot_list import SHOT_LIST, ROOM_COUNTS, required_shots, room_key
except ImportError:
    from shot_list import SHOT_LIST, ROOM_COUNTS, required_shots, room_key

CLAIM_FIELDS = {
    'carrier': 'insurance carrier',
    'claim_number': 'claim number',
    'policy_number': 'policy number',
    'date_of_loss': 'date of loss',
    'loss_cause': 'cause and source of loss',
    'adjuster_name': 'adjuster name',
    'adjuster_email': 'adjuster email',
    'adjuster_phone': 'adjuster phone',
    'deductible': 'deductible',
}
SIZING_FIELDS = {
    'floor_sf': 'floor area',
    'ceiling_height_ft': 'ceiling height',
    'water_class': 'water class',
}


def readiness(data, photos=None, claim=None, readings=None):
    if hasattr(data, 'model_dump'):
        data = data.model_dump(mode='json')
    photos, claim = photos or [], claim or {}
    gaps = []

    def add(code, text, room=''):
        gaps.append(dict(room=room, code=code, text=text))

    if not str(data.get('address') or '').strip():
        add('address', 'No property address')
    if data.get('year_built') is None:
        add('year_built', 'No year built')
    if not data.get('rooms'):
        add('rooms', 'No affected rooms')
    for room in data.get('rooms', []):
        name = room.get('name', '').strip() or 'Unnamed room'
        if not (room.get('finished_sf') or 0) > 0 and not (room.get('unfinished_sf') or 0) > 0:
            add('demolition', 'No measured demolition area', name)
        if not room.get('loss'):
            add('loss', 'Loss type not confirmed', name)
        # Match sizing.room_loss: legacy category 3 rooms read as mold, others as water.
        loss = room.get('loss') or ('mold' if room.get('category') == 3 else 'water')
        if loss != 'mold':
            for field, label in SIZING_FIELDS.items():
                if room.get(field) is None:
                    add(field, 'No ' + label + ' for the drying check', name)
            if (
                room.get('wet_floor_sf') is not None
                and room.get('floor_sf') is not None
                and room['wet_floor_sf'] > room['floor_sf']
            ):
                add('wet_floor_sf', 'Wet floor area exceeds floor area', name)
        mine = [p for p in photos if room_key(p.get('room', '')) == room_key(room.get('name', ''))]
        for shot, needed in required_shots(room):
            short = needed - sum(p.get('shot') == shot['id'] for p in mine)
            if short > 0:
                add('shot:' + shot['id'], f'{shot["label"]}: {short} photo(s) missing', name)
        for field, label in ROOM_COUNTS.items():
            if room.get(field) is None:
                add(field, 'Set how many: ' + label.lower(), name)
    equipment = any(
        (data.get(k) or 0) > 0 for k in ('air_movers', 'dehumidifiers', 'wood_floor_systems')
    )
    if not equipment:
        add('equipment', 'No drying equipment counts')
    if (data.get('dehumidifiers') or 0) > 0 and data.get('dehumidifier_ppd') is None:
        add('dehumidifier_ppd', 'No dehumidifier AHAM pints/day rating')
    if any(str(v or '').strip() for v in claim.values()):
        for field, label in CLAIM_FIELDS.items():
            if not str(claim.get(field) or '').strip():
                add('claim:' + field, 'No ' + label)
    if equipment:
        if readings is None:
            add('readings_unknown', 'Readings not loaded')
        elif not any(
            (r.get('kind') == 'air' and r.get('zone', 'affected') == 'affected')
            or (r.get('kind') == 'material' and r.get('affected', True))
            for r in readings
        ):
            add('setup_readings', 'No setup-day affected air or material reading')
    if any(p.get('ocr_status') in ('pending', 'failed') for p in photos):
        add('ocr', 'Photo readings await verification')
    if not data.get('scope_confirmed'):
        add('scope_confirmed', 'Scope not confirmed')
    return dict(gaps=gaps, ready=not gaps)
