"""The per-room photo shot list an adjuster expects, kept as data so it can be adjusted later.

`public/core.js` carries the same list for the app; tests/test_shot_list.py keeps them equal.
Each shot is required in every room, or only when the room's named flag is set by the technician.
A shot with 'per' needs one tagged photo for each surface or material the technician counts.
"""

# 'when' names a Room field the technician sets; None means every room needs the shot.
# 'per' names a Room count the technician sets; None means one photo covers the shot.
SHOT_LIST = [
    {
        'id': 'overview',
        'label': 'Room overview',
        'when': None,
        'per': None,
        'ask': 'a wide photo of the whole room',
    },
    {
        'id': 'source',
        'label': 'Source of loss',
        'when': 'source_of_loss',
        'per': None,
        'ask': 'the source of the water or moisture',
    },
    {
        'id': 'surface',
        'label': 'Affected wall or floor',
        'when': None,
        'per': 'affected_surfaces',
        'ask': 'each affected wall, floor or ceiling surface',
    },
    {
        'id': 'meter',
        'label': 'Meter reading',
        'when': None,
        'per': 'wet_materials',
        'ask': 'a readable meter on each wet material, held on that surface',
    },
    {
        'id': 'contents',
        'label': 'Contents before moving',
        'when': 'contents_present',
        'per': None,
        'ask': 'the contents in place before anything is moved',
    },
    {
        'id': 'equipment',
        'label': 'Equipment as placed',
        'when': 'equipment_placed',
        'per': None,
        'ask': 'the drying equipment as placed',
    },
]

# The room flags the list depends on, with the wording the app shows beside each toggle.
ROOM_FLAGS = {
    'source_of_loss': 'Source of loss is here',
    'contents_present': 'Contents in room',
    'equipment_placed': 'Equipment placed here',
}

# The room counts the list depends on, with the wording the app shows beside each number.
ROOM_COUNTS = {
    'affected_surfaces': 'Affected walls or floors',
    'wet_materials': 'Wet materials',
}
# Every room answer the shot list reads; none of them changes pricing or the Live scope.
ROOM_FIELDS = (*ROOM_FLAGS, *ROOM_COUNTS)

SHOT_IDS = tuple(shot['id'] for shot in SHOT_LIST)
SHOT_LABELS = {shot['id']: shot['label'] for shot in SHOT_LIST}


def known_shot(value):
    if value not in SHOT_LABELS:
        raise ValueError('Choose a shot type from the shot list.')
    return value


def room_key(name):
    # Matches roomKey in public/core.js, so the app and Live count the same photos.
    return ' '.join(name.split()).lower()


def photos_needed(shot, room):
    """Tagged photos one shot needs in a room. A count the technician has not set still needs
    one photo, and the status names the count so it is asked for rather than assumed."""
    if not shot['per'] or room.get(shot['per']) is None:
        return 1
    return room[shot['per']]


def required_shots(room):
    """The shots one room needs, each with the tagged photos it needs; room is a saved room dict."""
    return [
        (shot, photos_needed(shot, room))
        for shot in SHOT_LIST
        if (not shot['when'] or room.get(shot['when'])) and photos_needed(shot, room) > 0
    ]


def room_shot_status(data, photos):
    """Per room: each required shot with the photos it needs, the tagged photos per shot type, the
    shots still short of photos, the counts not yet set, and the untagged photo count.

    Only a photo tagged with a shot type counts toward that shot; untagged photos count as untagged.
    """
    status = []
    for room in data.get('rooms', []):
        key = room_key(room['name'])
        mine = [p for p in photos if room_key(p.get('room', '')) == key]
        tagged = {s: sum(1 for p in mine if p.get('shot') == s) for s in SHOT_IDS}
        required = required_shots(room)
        status.append(
            {
                'room': room['name'],
                'required': [
                    {'shot': shot['label'], 'photos_needed': needed} for shot, needed in required
                ],
                'tagged': [
                    {'shot': SHOT_LABELS[s], 'photos': tagged[s]} for s in SHOT_IDS if tagged[s]
                ],
                'missing': [
                    {'shot': shot['label'], 'photos_missing': needed - tagged[shot['id']]}
                    for shot, needed in required
                    if tagged[shot['id']] < needed
                ],
                'counts_not_set': [
                    ROOM_COUNTS[shot['per']]
                    for shot, _ in required
                    if shot['per'] and room.get(shot['per']) is None
                ],
                'untagged_photos': sum(1 for p in mine if not p.get('shot')),
            }
        )
    return status
