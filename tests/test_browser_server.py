"""The browser-test server's synthetic sign-in keeps the gates production's sign-in has."""

import json
import subprocess
import sys
from pathlib import Path


def test_workspace_sign_in_answers_like_production_while_workspaces_are_off():
    """Specs switch workspaces off in afterEach while their page is still open. The page's next
    company request must get production's refusal, not a server error from the legacy store."""
    served = subprocess.run(
        [
            sys.executable,
            '-c',
            """
import json
from fastapi.testclient import TestClient
from tests import browser_server as server

assert not server.bm.WORKSPACES_ENABLED
owner = {'Authorization': 'Bearer test-owner-ws-owner'}
with TestClient(server.bm.app, base_url='https://localhost:8765') as client:
    access = client.get('/api/access', headers=owner)
    session = client.get('/api/session', headers=owner)
print(json.dumps([access.status_code, access.json(), session.status_code]))
""",
        ],
        cwd=Path(__file__).resolve().parents[1],
        text=True,
        capture_output=True,
    )
    assert served.returncode == 0, served.stderr
    access_status, access, session_status = json.loads(served.stdout.splitlines()[-1])
    assert (access_status, access) == (503, {'detail': 'Company dashboards are not enabled yet.'})
    # The legacy staff sign-in is unchanged.
    assert session_status == 200
