"""Conservative transcript pass bar for F1's pre-enable Live eval (not a runtime validator)."""

import re

TERMS = {
    'address': r'address',
    'year_built': r'year|built',
    'rooms': r'room',
    'demolition': r'demolition|removal area|square feet.*remov',
    'loss': r'loss type|water.*mold',
    'floor_sf': r'floor area|floor.*square feet',
    'ceiling_height_ft': r'ceiling height|ceiling.*high',
    'water_class': r'water class',
    'wet_floor_sf': r'wet floor',
    'shot:overview': r'overview|wide photo',
    'shot:surface': r'affected.*photo|surface.*photo',
    'shot:meter': r'meter.*photo',
    'shot:source': r'source.*photo',
    'shot:contents': r'contents.*photo',
    'shot:equipment': r'equipment.*photo',
    'affected_surfaces': r'how many.*walls|how many.*surfaces',
    'wet_materials': r'how many.*materials',
    'equipment': r'equipment count|how many.*fans|air movers',
    'dehumidifier_ppd': r'aham|pints.*day',
    'setup_readings': r'setup.*reading|affected.*reading',
    'scope_confirmed': r'confirm.*scope',
    'ocr': r'verify.*reading|verification',
    'claim:carrier': r'carrier',
    'claim:claim_number': r'claim number',
    'claim:policy_number': r'policy number',
    'claim:date_of_loss': r'date of loss',
    'claim:loss_cause': r'cause|source of loss',
    'claim:adjuster_name': r'adjuster.*name',
    'claim:adjuster_email': r'adjuster.*email',
    'claim:adjuster_phone': r'adjuster.*phone',
    'claim:deductible': r'deductible',
}


def check_reply(state, transcript):
    text = transcript.lower()
    assert not re.search(
        r'\bcomplete[ds]?\b|ready to (sign|finish)|cannot (sign|finish)|can.t (sign|finish)|blocks? (signing|finishing)',
        text,
    ), 'Reply claims completion or blocks finishing/signing'
    mentioned = {code for code, pattern in TERMS.items() if re.search(pattern, text)}
    listed = {g['code'] for g in state['gaps']}
    assert len(mentioned) == 1 and mentioned <= listed, 'Reply must ask for exactly one listed gap'
    assert '?' in text or re.search(r'\b(please|record|enter|tell me|take|confirm)\b', text), (
        'Reply must request the gap'
    )
    return True


def dry_run():
    """Synthetic transcript fixtures exercise the check, never a provider or production API."""
    cases = [
        ('floor_sf', 'What is the floor area?'),
        ('dehumidifier_ppd', 'What is the AHAM rating?'),
        ('setup_readings', 'Please record the setup reading.'),
    ]
    for code, text in cases:
        check_reply({'gaps': [{'code': code}]}, text)
    for text in (
        'The job is complete.',
        'What is the floor area and AHAM rating?',
        'What is the address?',
    ):
        try:
            check_reply({'gaps': [{'code': 'floor_sf'}]}, text)
        except AssertionError:
            continue
        raise AssertionError('Invalid reply passed')
    print(
        'PASS: readiness dry run, 3 synthetic replies accepted; 3 invalid replies rejected. No model or service calls.'
    )
