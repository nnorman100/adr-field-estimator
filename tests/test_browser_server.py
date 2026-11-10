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


def test_a_request_signed_in_to_a_workspace_keeps_its_store_when_workspaces_switch_off():
    """The switch can land after a request's sign-in and before its store is chosen."""
    served = subprocess.run(
        [
            sys.executable,
            '-c',
            """
import json
from fastapi.testclient import TestClient
from tests import browser_server as server

signed_in = server.identity


async def then_switched_off(request):
    claims = await signed_in(request)
    server.store, server.bm.WORKSPACES_ENABLED = server.legacy_store, False
    return claims


owner = {'Authorization': 'Bearer test-owner-ws-owner'}
with TestClient(server.bm.app, base_url='https://localhost:8765') as client:
    client.post('/__test/workspaces', json={'enabled': True})
    server.identity = then_switched_off
    access = client.get('/api/access', headers=owner)
print(json.dumps([access.status_code, access.json().get('company_id')]))
""",
        ],
        cwd=Path(__file__).resolve().parents[1],
        text=True,
        capture_output=True,
    )
    assert served.returncode == 0, served.stderr
    assert json.loads(served.stdout.splitlines()[-1]) == [200, 'adr']


def test_a_session_read_keeps_its_store_when_workspaces_switch_off_mid_request():
    """The switch can land while /api/session waits on its first company lookup."""
    served = subprocess.run(
        [
            sys.executable,
            '-c',
            """
import json
from fastapi.testclient import TestClient
from tests import browser_server as server

owner = {'Authorization': 'Bearer test-owner-ws-owner'}
with TestClient(server.bm.app, base_url='https://localhost:8765') as client:
    client.post('/__test/workspaces', json={'enabled': True})
    workspaces = server.store.workspaces
    looked_up = workspaces.principal

    def then_switched_off(uid):
        actor = looked_up(uid)
        server.store, server.bm.WORKSPACES_ENABLED = server.legacy_store, False
        return actor

    workspaces.principal = then_switched_off
    session = client.get('/api/session', headers=owner)
print(json.dumps([session.status_code, session.json().get('company_id')]))
""",
        ],
        cwd=Path(__file__).resolve().parents[1],
        text=True,
        capture_output=True,
    )
    assert served.returncode == 0, served.stderr
    assert json.loads(served.stdout.splitlines()[-1]) == [200, 'adr']


def test_the_server_keeps_an_idle_connection_open_for_a_slow_spec():
    """A spec's request context reuses one connection while its test runs for several seconds.
    A server that closes it first makes the next request, usually the afterEach reset, fail with
    ECONNRESET."""
    root = Path(__file__).resolve().parents[1]
    served = subprocess.run(
        [
            sys.executable,
            '-c',
            """
import http.client, json, os, socket, ssl, subprocess, sys, time

port = socket.socket()
port.bind(('127.0.0.1', 0))
number = port.getsockname()[1]
port.close()
server = subprocess.Popen(
    [sys.executable, '-B', 'tests/browser_server.py'],
    env={**os.environ, 'ADR_BROWSER_PORT': str(number)},
)
try:
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    deadline = time.monotonic() + 60
    while True:
        try:
            connection = http.client.HTTPSConnection('127.0.0.1', number, context=context)
            connection.request('GET', '/api/health')
            connection.getresponse().read()
            break
        except OSError:
            assert time.monotonic() < deadline, 'server did not start'
            time.sleep(0.25)
    time.sleep(6.5)
    connection.request('GET', '/api/health')
    status = connection.getresponse().status
    connection.close()
    print(json.dumps(status))
finally:
    server.kill()
    server.wait(10)
""",
        ],
        cwd=root,
        text=True,
        capture_output=True,
    )
    assert served.returncode == 0, served.stderr
    assert json.loads(served.stdout.splitlines()[-1]) == 200
