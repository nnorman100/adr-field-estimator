import asyncio, json, base64, sys, struct, math, urllib.request
from websockets.asyncio.client import connect
URL='ws://127.0.0.1:8765/api/live'; ORIGIN='https://alert-disaster-field-2026.web.app'
ID='ADR-INS-'+'d'*32; CAP='e'*32
def pcm(n):  # loud tone so the relay treats it as speech
    return base64.b64encode(b''.join(struct.pack('<h',int(12000*math.sin(i/5))) for i in range(n))).decode()
def auth(resume=False,token='synthetic'):return json.dumps(dict(type='authenticate',token=token,inspection_id=ID,protocol_version=2,capture_id=CAP,resume=resume))
async def recv(ws):
    m=json.loads(await asyncio.wait_for(ws.recv(),10));print('  <-',json.dumps({k:(v[:16]+'...' if k=='data' else v) for k,v in m.items()}));return m
async def main():
    print('== Scenario: first walkthrough (new session), speech, model reply, interaction_status, go_away rollover')
    async with connect(URL,origin=ORIGIN) as ws:
        await ws.send(auth());print('  -> authenticate')
        await recv(ws);await recv(ws)
        await ws.send(json.dumps({'type':'audio','data':pcm(3300)}));print('  -> audio (16 kHz PCM)')
        for _ in range(6):await recv(ws)
        await ws.send(json.dumps({'type':'video','data':base64.b64encode(b'\xff\xd8\xffsynthetic').decode()}));print('  -> video (JPEG frame)')
        await recv(ws)
        try: await recv(ws)
        except Exception as e: print('  socket closed after rollover:',type(e).__name__)
    print('== Scenario: reconnect resumes with stored handle, pause + end flush audio_stream_end')
    async with connect(URL,origin=ORIGIN) as ws:
        await ws.send(auth(True));print('  -> authenticate resume=true')
        await recv(ws)
        await ws.send(json.dumps({'type':'pause'}));print('  -> pause')
        await ws.send(json.dumps({'type':'end'}));print('  -> end')
        await recv(ws)
    print('== Adversarial: bad token is refused before any Vertex connection')
    async with connect(URL,origin=ORIGIN) as ws:
        await ws.send(auth(token='forged'));print('  -> authenticate token=forged')
        await recv(ws)
asyncio.run(main())
