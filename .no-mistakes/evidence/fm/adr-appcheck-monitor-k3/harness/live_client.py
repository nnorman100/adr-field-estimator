"""Connects to the running backend's /api/live and authenticates; prints the server's first reply."""
import asyncio,json,ssl,subprocess,sys,secrets,urllib.request
import websockets
B='127.0.0.1:8791';MINT=[sys.executable,sys.argv[1]]
ctx=ssl.create_default_context();ctx.check_hostname=False;ctx.verify_mode=ssl.CERT_NONE
def create():
    iid='ADR-INS-'+secrets.token_hex(16)
    req=urllib.request.Request(f'https://{B}/api/inspections',data=json.dumps({'inspection_id':iid}).encode(),headers={'Authorization':'Bearer test-owner-live','Content-Type':'application/json'},method='POST')
    urllib.request.urlopen(req,context=ctx).read();return iid
async def main():
    for kind in ['none','valid','wrong-key']:
        iid=create()
        tok=None if kind=='none' else subprocess.check_output(MINT+[kind]).decode().strip()
        async with websockets.connect(f'wss://{B}/api/live',ssl=ctx,origin=f'https://localhost:8791') as ws:
            await ws.send(json.dumps({'type':'authenticate','token':'test-owner-live','inspection_id':iid,'protocol_version':2,'capture_id':secrets.token_hex(16),**({'app_check':tok} if tok else {})}))
            reply=json.loads(await asyncio.wait_for(ws.recv(),10))
            print(f'== Live authenticate with app_check={kind}: server replied type={reply.get("type")}')
            await asyncio.sleep(.3)
            print('   log:',[l for l in open(sys.argv[2]).read().splitlines() if '"App Check"' in l][-1])
asyncio.run(main())
