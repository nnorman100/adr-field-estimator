"""The shipped app must not assume a restoration company's identity."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_google_consent_screen_says_dryscope():
    config = json.loads((ROOT / 'firebase.json').read_text())
    assert config['auth']['providers']['googleSignIn']['oAuthBrandDisplayName'] == 'DryScope'
