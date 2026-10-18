import asyncio, json, ssl, sys, urllib.request
import websockets
BASE = 'localhost:8799'
ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE

def post(path, body):
    req = urllib.request.Request('https://' + BASE + path, json.dumps(body).encode(),
                                 {'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(req, context=ctx))

async def attempt(label, uid, iid, extra):
    auth = dict(type='authenticate', token=uid, inspection_id=iid, protocol_version=2,
                capture_id='f' * 32, **extra)
    async with websockets.connect('wss://' + BASE + '/api/live', ssl=ctx,
                                  origin='https://' + BASE) as ws:
        await ws.send(json.dumps(auth))
        try:
            reply = json.loads(await asyncio.wait_for(ws.recv(), 10))
        except websockets.ConnectionClosed as e:
            reply = {'closed': e.code}
        print(f'{label}\n  sent: {json.dumps({k: v for k, v in auth.items() if k != "token"})}\n  got:  {json.dumps(reply)}')
        return reply

async def main():
    fixture = post('/__test/workspaces', {'enabled': True})
    iid = fixture['inspection_id']
    print('Workspaces enabled; ADR estimator test-owner-ws-estimator owns', iid)
    r = []
    r.append(await attempt('[1] Old ADR client (no workspace_protocol_version) - previously waived', 'test-owner-ws-estimator', iid, {}))
    r.append(await attempt('[2] ADR client claiming workspace_protocol_version=0', 'test-owner-ws-estimator', iid, {'workspace_protocol_version': 0}))
    r.append(await attempt('[3] ADR client sending workspace_protocol_version="1" (string)', 'test-owner-ws-estimator', iid, {'workspace_protocol_version': '1'}))
    r.append(await attempt('[4] Current ADR client (workspace_protocol_version=1)', 'test-owner-ws-estimator', iid, {'workspace_protocol_version': 1}))
    post('/__test/workspaces', {'enabled': False})
    want = {'type': 'error', 'status': 409, 'message': 'Update the app before a company walkthrough.'}
    ok = r[0] == want and r[1] == want and r[2] == want and r[3] != want and r[3].get('status') != 409
    print('RESULT:', 'PASS' if ok else 'FAIL')
    sys.exit(0 if ok else 1)
asyncio.run(main())
