import sys,asyncio,json,websockets
async def main(port):
    try:
        async with websockets.connect(f'ws://127.0.0.1:{port}/api/live',origin='https://alert-disaster-field-2026.web.app',open_timeout=5) as ws:
            print('handshake accepted; sending unauthenticated first message')
            await ws.send(json.dumps({'type':'auth','token':'not-a-real-token'}))
            try: m=await asyncio.wait_for(ws.recv(),5); print('server message:',str(m)[:160])
            except Exception as e: print('then',type(e).__name__, getattr(ws,'close_code',None), getattr(ws,'close_reason',None))
    except Exception as e: print('connect result:',type(e).__name__,str(e)[:160])
asyncio.run(main(sys.argv[1]))
