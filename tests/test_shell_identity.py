"""The shipped app must not assume a restoration company's identity."""

import json
import subprocess
from pathlib import Path

import pytest

from tests.fakes import ADR_PROFILE

ROOT = Path(__file__).resolve().parents[1]
SHIPPED = ['public', 'backend', 'index.html', 'firebase.json']
ADR_TEXT = ['Alert Disaster', 'alertdisaster', 'Matthew Myers', 'adr-logo', '950983', '426-2151']


def shipped_files():
    listed = subprocess.run(
        ['git', 'ls-files', '--', *SHIPPED], cwd=ROOT, capture_output=True, text=True, check=True
    ).stdout.split()
    return [ROOT / name for name in listed if (ROOT / name).exists()]


# The later product-identity change adds the manifest check; it stays out of this change.
@pytest.mark.parametrize('filename', ['index.html', 'public/index.html', 'public/sign.html'])
def test_shell_has_no_adr_identity(filename):
    shell = (ROOT / filename).read_text()
    for value in [*ADR_PROFILE.values(), 'Alert Disaster', '950983', '661']:
        if value:
            assert value not in shell


def test_shipped_files_carry_no_built_in_adr_branding():
    files = shipped_files()
    assert files
    assert not [path for path in files if 'adr-logo' in path.name]
    for path in files:
        try:
            text = path.read_text(encoding='utf8')
        except UnicodeDecodeError:
            continue
        for value in ADR_TEXT:
            assert value.lower() not in text.lower(), f'{value} in {path.relative_to(ROOT)}'


def test_google_consent_screen_says_dryscope():
    config = json.loads((ROOT / 'firebase.json').read_text())
    assert config['auth']['providers']['googleSignIn']['oAuthBrandDisplayName'] == 'DryScope'
