"""The public shells must not assume a restoration company's identity."""

from pathlib import Path

import pytest

from backend.workspaces import ADR_PROFILE

ROOT = Path(__file__).resolve().parents[1]


# The later product-identity change adds the manifest check; it stays out of this change.
@pytest.mark.parametrize('filename', ['index.html', 'public/index.html', 'public/sign.html'])
def test_shell_has_no_adr_identity(filename):
    shell = (ROOT / filename).read_text()
    for value in [*ADR_PROFILE.values(), 'Alert Disaster', '950983', '661']:
        if value:
            assert value not in shell
