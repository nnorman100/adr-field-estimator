"""Disposable driver: serve the real backend app over uvicorn with fake store/identity,
then connect real WebSocket clients to /api/live as an ADR member."""
import sys, asyncio, json, threading, time
sys.path.insert(0, sys.argv[1])
import uvicorn, websockets
import backend.main as bm
from tests.test_workspaces import seed, data, identity, ID
from tests.fakes import FakeCompanyStore

PORT = 18766
store = seed(FakeCompanyStore())
store.create_inspection('owner', ID, data())
bm.WORKSPACES_ENABLED = True
bm.get_job_store = lambda: store
async def verified(token, **_):
    return {**identity(token), 'exp': time.time() + 600}
bm.verify_staff = verified
vertex_calls = []
def client(**kw):
    vertex_calls.append(kw)
    raise RuntimeError('synthetic: Vertex reached (no real service)')
bm.genai.Client = client
origin = bm.ORIGINS[0]

server = uvicorn.Server(uvicorn.Config(bm.app, host='127.0.0.1', port=PORT, log_level='warning'))
threading.Thread(target=server.run, daemon=True).start()
while not server.started: time.sleep(0.05)

async def attempt(label, uid, extra):
    auth = dict(type='authenticate', token=uid, inspection_id=ID, protocol_version=2,
                capture_id='f' * 32, **extra)
    before = len(vertex_calls)
    async with websockets.connect(f'ws://127.0.0.1:{PORT}/api/live', origin=origin) as ws:
        await ws.send(json.dumps(auth))
        try:
            reply = json.loads(await asyncio.wait_for(ws.recv(), 10))
        except websockets.ConnectionClosed as e:
            reply = {'closed': e.rcvd.code if e.rcvd else None}
    print(f'{label}: sent workspace_protocol_version={extra.get("workspace_protocol_version", "<absent>")}')
    print('   reply:', json.dumps(reply))
    print('   reached Vertex:', len(vertex_calls) > before)
    return reply, len(vertex_calls) > before

async def main():
    import urllib.request
    print('GET /api/health ->', urllib.request.urlopen(f'http://127.0.0.1:{PORT}/api/health').read().decode())
    print('OpenAPI title ->', json.loads(urllib.request.urlopen(f'http://127.0.0.1:{PORT}/openapi.json').read())['info']['title'])
    results = [
        await attempt('Old ADR client (no workspace protocol)', 'owner', {}),
        await attempt('Old ADR client (workspace protocol 0)', 'owner', {'workspace_protocol_version': 0}),
        await attempt('Current ADR client', 'owner', {'workspace_protocol_version': 1}),
    ]
    old = {'type': 'error', 'status': 409, 'message': 'Update the app before a company walkthrough.'}
    ok = results[0] == (old, False) and results[1] == (old, False) and results[2][1] is True
    print('RESULT:', 'PASS' if ok else 'FAIL')
asyncio.run(main())
server.should_exit = True
