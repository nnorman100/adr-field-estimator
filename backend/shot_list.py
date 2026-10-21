"""The per-room photo shot list an adjuster expects, kept as data so it can be adjusted later.

`public/core.js` carries the same list for the app; tests/test_shot_list.py keeps them equal.
Each shot is required in every room, or only when the room's named flag is set by the technician.
"""

# 'when' names a Room field the technician sets; None means every room needs the shot.
SHOT_LIST = [
    {
        'id': 'overview',
        'label': 'Room overview',
        'when': None,
        'ask': 'a wide photo of the whole room',
    },
    {
        'id': 'source',
        'label': 'Source of loss',
        'when': 'source_of_loss',
        'ask': 'the source of the water or moisture',
    },
    {
        'id': 'surface',
        'label': 'Affected wall or floor',
        'when': None,
        'ask': 'each affected wall, floor or ceiling surface',
    },
    {
        'id': 'meter',
        'label': 'Meter reading',
        'when': None,
        'ask': 'a readable meter on each wet material, held on that surface',
    },
    {
        'id': 'contents',
        'label': 'Contents before moving',
        'when': 'contents_present',
        'ask': 'the contents in place before anything is moved',
    },
    {
        'id': 'equipment',
        'label': 'Equipment as placed',
        'when': 'equipment_placed',
        'ask': 'the drying equipment as placed',
    },
]

# The room flags the list depends on, with the wording the app shows beside each toggle.
ROOM_FLAGS = {
    'source_of_loss': 'Source of loss is here',
    'contents_present': 'Contents in room',
    'equipment_placed': 'Equipment placed here',
}

SHOT_IDS = tuple(shot['id'] for shot in SHOT_LIST)
SHOT_LABELS = {shot['id']: shot['label'] for shot in SHOT_LIST}


def known_shot(value):
    if value not in SHOT_LABELS:
        raise ValueError('Choose a shot type from the shot list.')
    return value


def room_key(name):
    # Matches roomKey in public/core.js, so the app and Live count the same photos.
    return ' '.join(name.split()).lower()


def required_shots(room):
    """The shots one room needs; room is a saved room dict."""
    return [shot for shot in SHOT_LIST if not shot['when'] or room.get(shot['when'])]


def room_shot_status(data, photos):
    """Per room: required shot labels, the ones no tagged photo covers, and untagged photo count.

    Only a photo tagged with a shot type counts toward that shot; untagged photos count as untagged.
    """
    status = []
    for room in data.get('rooms', []):
        key = room_key(room['name'])
        mine = [p for p in photos if room_key(p.get('room', '')) == key]
        tagged = {p['shot'] for p in mine if p.get('shot')}
        required = required_shots(room)
        status.append(
            {
                'room': room['name'],
                'required': [shot['label'] for shot in required],
                'tagged': [SHOT_LABELS[s] for s in SHOT_IDS if s in tagged],
                'missing': [shot['label'] for shot in required if shot['id'] not in tagged],
                'untagged_photos': sum(1 for p in mine if not p.get('shot')),
            }
        )
    return status
