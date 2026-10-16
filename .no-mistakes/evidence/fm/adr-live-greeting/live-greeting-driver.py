"""Drives the real ADR backend (uvicorn, real FastAPI app, real google-genai SDK) over a real TCP
WebSocket, with Vertex Live replaced by the repo's local TLS stand-in and Firestore by FakeStore."""
import asyncio, base64, json, pathlib, socket as pysocket, sys, tempfile, threading, time
ROOT = pathlib.Path(sys.argv[1]); OUT = pathlib.Path(sys.argv[2])
sys.path.insert(0, str(ROOT))
import uvicorn, websockets
import backend.main as bm
from backend.contracts import InspectionData
from tests.fakes import FakeStore, FakeVertexLive, client_content, realtime

log = []
def say(*a):
    line = ' '.join(str(x) for x in a); print(line); log.append(line)

store = FakeStore()
BLANK = 'ADR-INS-' + 'a' * 32
SAVED = 'ADR-INS-' + 'b' * 32
store.create_inspection('owner', BLANK, InspectionData().model_dump(mode='json'))
store.create_inspection('owner', SAVED, InspectionData(address='1234 Truxtun Ave, Bakersfield, CA 93301').model_dump(mode='json'))

async def identity(token, **_):
    return {'uid': 'owner', 'email': 'tech@example.test', 'exp': time.time() + 600}
bm.verify_staff = identity
bm.get_job_store = lambda: store

def audio(text):
    return {'serverContent': {'modelTurn': {'parts': [{'inlineData': {'mimeType': 'audio/pcm;rate=24000', 'data': base64.b64encode(b'\x01\x02').decode()}}]}, 'outputTranscription': {'text': text}}}

tmp = pathlib.Path(tempfile.mkdtemp(prefix='nm-greet-'))
vertex = FakeVertexLive(tmp).__enter__()
bm.genai.Client = vertex.client(bm.genai.Client)

s = pysocket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
server = uvicorn.Server(uvicorn.Config(bm.app, host='127.0.0.1', port=port, log_level='warning'))
threading.Thread(target=server.run, daemon=True).start()
while not server.started: time.sleep(0.05)
say(f'# real backend listening on ws://127.0.0.1:{port}/api/live (uvicorn), Vertex stand-in on https://127.0.0.1:{vertex.port}')

def script(greeting=None):
    vertex.replies['setup'] = [{'setupComplete': {}}, {'sessionResumptionUpdate': {'newHandle': 'handle-1', 'resumable': True}}]
    vertex.replies['client_content'] = [audio(greeting), {'serverContent': {'turnComplete': True, 'interactionStatus': 'IDLE'}}] if greeting else []

async def walk(name, inspection, capture, resume, quiet=1.5):
    say(f'\n## {name}')
    n = len(vertex.connections)
    async with websockets.connect(f'ws://127.0.0.1:{port}/api/live', origin=bm.ORIGINS[0]) as ws:
        await ws.send(json.dumps(dict(type='authenticate', token='synthetic', inspection_id=inspection, protocol_version=2, capture_id=capture, resume=resume)))
        events = []
        try:
            while True:
                events.append(json.loads(await asyncio.wait_for(ws.recv(), quiet)))
        except asyncio.TimeoutError:
            pass
        for e in events:
            say('client <-', json.dumps({k: (v[:12] + '...' if k == 'data' else v) for k, v in e.items()}))
        say('(technician has not spoken; no audio/video was sent by the client)')
    conn = vertex.connections[n]
    setup = conn['received'][0]['setup']
    sysi = setup['systemInstruction']['parts'][0]['text']
    cc = [client_content(m) for m in conn['received'] if client_content(m)]
    say('vertex <- setup.sessionResumption =', json.dumps(setup.get('sessionResumption')))
    say('vertex <- clientContent turns =', json.dumps(cc))
    return events, cc, sysi

async def main():
    results = {}
    script("Hi, I'm ready. What's the property address?")
    ev, cc, sysi = await walk('A. New walkthrough, no saved address', BLANK, 'c' * 32, False)
    ready = ev[0]
    results['A'] = ready['recovery'] == 'new' and len(cc) == 1 and cc[0]['turns'][0]['parts'][0]['text'] == bm.GREETING_TRIGGER and [(e['type'], e.get('speaker')) for e in ev[1:]] == [('transcript', 'assistant'), ('audio', None), ('turn_complete', None)] and 'property address' in ev[1]['text'] and bm.GREETING_TRIGGER not in json.dumps(ev)
    say('saved inspection JSON in prompt shows address =', json.dumps(json.loads(sysi.split('(JSON):\n', 1)[1])['address']))

    script("Hi, I'm ready. What year was 1234 Truxtun Ave built?")
    ev, cc, sysi = await walk('B. New walkthrough, address already saved', SAVED, 'd' * 32, False)
    ctx = json.loads(sysi.split('(JSON):\n', 1)[1])
    say('saved inspection JSON in prompt shows address =', json.dumps(ctx['address']))
    say('system instruction greeting rule present:', 'GREETING (NEW WALKTHROUGH ONLY)' in sysi)
    results['B'] = ev[0]['recovery'] == 'new' and len(cc) == 1 and ctx['address'].startswith('1234 Truxtun') and 'otherwise the next gap' in sysi and ev[1]['speaker'] == 'assistant'

    script("SHOULD NOT BE SPOKEN")  # if the backend wrongly greets, this would surface
    ev, cc, _ = await walk('C. Resume the same walkthrough (saved handle)', SAVED, 'd' * 32, True)
    results['C'] = ev[0]['recovery'] == 'resumed' and cc == [] and not any(e['type'] in ('transcript', 'audio') for e in ev)

    script("SHOULD NOT BE SPOKEN")
    ev, cc, _ = await walk('D. Resume requested but no checkpoint exists (restarted)', BLANK, 'f' * 32, True)
    results['D'] = ev[0]['recovery'] == 'restarted' and cc == [] and not any(e['type'] in ('transcript', 'audio') for e in ev)

    dumped = json.dumps(store.db.records, default=str)
    results['E'] = bm.GREETING_TRIGGER not in dumped
    say('\n## E. Greeting trigger never persisted: trigger text found in stored records =', not results['E'])
    say('\nRESULTS', json.dumps(results))
    return results

r = asyncio.run(main())
server.should_exit = True; vertex.__exit__(None, None, None)
OUT.write_text('\n'.join(log) + '\n')
sys.exit(0 if all(r.values()) else 1)
