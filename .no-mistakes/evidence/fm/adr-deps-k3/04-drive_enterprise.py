"""Drive the real backend's enterprise=True genai clients against disposable local Vertex/OAuth fakes."""
import asyncio, base64, json, os, sys, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
ROOT=sys.argv[1]; sys.path.insert(0,ROOT)
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives import serialization
import websockets

log=[]
class H(BaseHTTPRequestHandler):
    def log_message(self,*a):pass
    def do_POST(self):
        body=self.rfile.read(int(self.headers.get('Content-Length','0')))
        if self.path=='/token':
            log.append(('oauth-token',self.path));out={'access_token':'fake-adc-token','expires_in':3600,'token_type':'Bearer'}
        else:
            log.append(('rest',self.path,self.headers.get('Authorization'),json.loads(body)['contents'][0]['parts'][0]['text']))
            out={'candidates':[{'content':{'role':'model','parts':[{'text':'pong from fake vertex'}]},'finishReason':'STOP'}]}
        data=json.dumps(out).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
http=ThreadingHTTPServer(('127.0.0.1',0),H);threading.Thread(target=http.serve_forever,daemon=True).start()
HP=http.server_address[1]

async def ws_handler(ws):
    log.append(('live',ws.request.path,ws.request.headers.get('Authorization')))
    setup=json.loads(await ws.recv());log.append(('live-setup-model',setup['setup']['model']))
    await ws.send(json.dumps({'setupComplete':{}}))
    async for raw in ws:
        msg=json.loads(raw);log.append(('live-client-message-keys',list(msg)))
        if True:
            await ws.send(json.dumps({'serverContent':{'outputTranscription':{'text':'Fake Vertex Live heard you'},'turnComplete':True}}));break
    await asyncio.sleep(5)

tmp=tempfile.mkdtemp(prefix='adr-adc-')
key=rsa.generate_private_key(public_exponent=65537,key_size=2048).private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()).decode()
sa=os.path.join(tmp,'sa.json');json.dump({'type':'service_account','project_id':'alert-disaster-field-2026','private_key_id':'x','private_key':key,'client_email':'fake@alert-disaster-field-2026.iam.gserviceaccount.com','client_id':'1','token_uri':f'http://127.0.0.1:{HP}/token'},open(sa,'w'))
os.environ.update(HOME=tmp,CLOUDSDK_CONFIG=tmp,GOOGLE_APPLICATION_CREDENTIALS=sa)
for k in ('GOOGLE_API_KEY','GEMINI_API_KEY','GOOGLE_GENAI_USE_VERTEXAI'):os.environ.pop(k,None)

def make_tls():
    import datetime, ipaddress, ssl
    from cryptography import x509
    from cryptography.x509.oid import NameOID
    from cryptography.hazmat.primitives import hashes
    k=rsa.generate_private_key(public_exponent=65537,key_size=2048);n=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'127.0.0.1')])
    now=datetime.datetime.now(datetime.timezone.utc)
    cert=x509.CertificateBuilder().subject_name(n).issuer_name(n).public_key(k.public_key()).serial_number(1).not_valid_before(now-datetime.timedelta(minutes=5)).not_valid_after(now+datetime.timedelta(hours=1)).add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]),False).add_extension(x509.BasicConstraints(ca=True,path_length=None),True).sign(k,hashes.SHA256())
    cp=os.path.join(tmp,'cert.pem');kp=os.path.join(tmp,'key.pem')
    open(cp,'wb').write(cert.public_bytes(serialization.Encoding.PEM));open(kp,'wb').write(k.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
    ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);ctx.load_cert_chain(cp,kp);os.environ['SSL_CERT_FILE']=cp;return ctx

async def main():
    server=await websockets.serve(ws_handler,'127.0.0.1',0,ssl=make_tls());WP=server.sockets[0].getsockname()[1]
    os.environ['GOOGLE_VERTEX_BASE_URL']=f'http://127.0.0.1:{HP}/'
    import backend.main as bm
    from backend.contracts import InspectionData
    from tests.fakes import FakeStore
    print('== Engine 2 REST: bm.get_ai_client() ==')
    c=bm.get_ai_client();print('client.vertexai =',c.vertexai,'| project =',c._api_client.project,'| location =',c._api_client.location)
    r=await c.aio.models.generate_content(model=bm.AUDIT_MODEL,contents='ping')
    print('response text =',r.text)
    for e in log:print('fake server saw:',e)
    log.clear()
    print('\n== Engine 1 Live: real /api/live relay -> genai.Client(enterprise=True) ==')
    os.environ['GOOGLE_VERTEX_BASE_URL']=f'http://127.0.0.1:{WP}/'
    ID='ADR-INS-'+'d'*32;store=FakeStore();store.create_inspection('owner',ID,InspectionData().model_dump(mode='json'))
    async def identity(token):return {'uid':'owner','exp':time.time()+600}
    bm.verify_staff=identity;bm.get_job_store=lambda:store
    from fastapi.testclient import TestClient
    def drive():
        with TestClient(bm.app) as client, client.websocket_connect('/api/live',headers={'origin':bm.ORIGINS[0]}) as s:
            s.send_json({'type':'authenticate','token':'synthetic','inspection_id':ID});print('relay ->',s.receive_json())
            s.send_json({'type':'audio','data':base64.b64encode(b'\x00\x00'*1600).decode()})
            for _ in range(2):
                m=s.receive_json();print('relay ->',m)
                if m['type']=='turn_complete':break
    await asyncio.to_thread(drive)
    for e in log:print('fake server saw:',e)
    server.close()
asyncio.run(main())
