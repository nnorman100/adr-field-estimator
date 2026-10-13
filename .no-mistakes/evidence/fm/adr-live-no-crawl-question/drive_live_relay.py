"""Run the real FastAPI backend under uvicorn, connect a real WebSocket client to /api/live,
and capture the setup message the real google-genai SDK sends to a local fake Vertex Live endpoint."""
import sys, json, time, threading, asyncio, pathlib, tempfile
root = pathlib.Path(sys.argv[1]); out = pathlib.Path(sys.argv[2]); mode = sys.argv[3]
sys.path.insert(0, str(root))
from types import SimpleNamespace as NS
import uvicorn, websockets
import backend.main as bm
from backend.contracts import InspectionData
from tests.fakes import FakeStore, FakeVertexLive

ID = 'ADR-INS-' + 'f' * 32
store = FakeStore()
data = InspectionData().model_dump(mode='json')
data.update(address='123 Synthetic St, Bakersfield, CA', year_built=1972)
store.create_inspection('owner', ID, data)
async def identity(token, **_):
    return {'uid': 'owner', 'exp': time.time() + 600}
bm.verify_staff = identity
bm.get_job_store = lambda: store
if mode == 'company':
    bm.WORKSPACES_ENABLED = True
    store.workspaces = NS(snapshot=lambda uid: {'company_id': 'other', 'name': 'Other Restoration Co', 'signoff': 'Pat Lee'})
tmp = pathlib.Path(tempfile.mkdtemp())
with FakeVertexLive(tmp) as vertex:
    bm.genai.Client = vertex.client(bm.genai.Client)
    vertex.replies['setup'] = [{'setupComplete': {}}]
    server = uvicorn.Server(uvicorn.Config(bm.app, host='127.0.0.1', port=0, log_level='warning'))
    t = threading.Thread(target=server.run, daemon=True); t.start()
    while not server.started: time.sleep(0.05)
    port = server.servers[0].sockets[0].getsockname()[1]
    async def drive():
        async with websockets.connect(f'ws://127.0.0.1:{port}/api/live', origin=bm.ORIGINS[0]) as ws:
            auth = {'type': 'authenticate', 'token': 'synthetic', 'inspection_id': ID}
            if mode == 'company': auth['workspace_protocol_version'] = 1
            await ws.send(json.dumps(auth))
            reply = json.loads(await ws.recv())
            print('relay reply to technician client:', reply)
            return reply
    reply = asyncio.run(drive())
    time.sleep(0.5)
    server.should_exit = True; t.join(5)
setup = vertex.connections[0]['received'][0]['setup']
text = ''.join(p.get('text', '') for p in setup['systemInstruction']['parts'])
out.write_text(text)
intake = [l for l in text.splitlines() if l.startswith('Collect the address')]
print('model:', setup.get('model'))
print('PROPERTY INTAKE line sent to Vertex:', intake)
print('"crawl" occurrences in instructions (before JSON context):', text.split('\nCurrent inspection context (JSON):\n')[0].lower().count('crawl'))
