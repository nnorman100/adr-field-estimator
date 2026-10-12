"""Disposable launcher: the real backend (via tests/browser_server.py) with a local App Check JWKS.
Only test isolation is patched: the JWKS URL, the Admin SDK credential (no ADC locally),
Live identity (synthetic token) and the Gemini Live client (fake session)."""
import json, os, runpy, sys, threading, asyncio, time
from http.server import BaseHTTPRequestHandler, HTTPServer
from contextlib import asynccontextmanager
from types import SimpleNamespace as NS
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives import serialization
import jwt
from jwt.algorithms import RSAAlgorithm
KEYDIR='/tmp/adr-ac-keys'
key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
open(KEYDIR+'/key.pem','wb').write(key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
jwk=json.loads(RSAAlgorithm.to_jwk(key.public_key()));jwk.update(kid='local-kid',use='sig',alg='RS256')
JWKS=json.dumps({'keys':[jwk]}).encode()
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        time.sleep(float(os.environ.get('JWKS_DELAY','0')))
        self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(JWKS)
    def log_message(self,*a):sys.stderr.write('JWKS fetch\n')
srv=HTTPServer(('127.0.0.1',int(os.environ.get('JWKS_PORT','8799'))),H);threading.Thread(target=srv.serve_forever,daemon=True).start()
import firebase_admin
from firebase_admin import app_check, credentials
import google.auth.credentials
app_check._AppCheckService._JWKS_URL=f'http://127.0.0.1:{srv.server_port}/v1/jwks'
class Anon(credentials.Base):
    def get_credential(self):return google.auth.credentials.AnonymousCredentials()
firebase_admin.initialize_app(Anon(),options={'projectId':'alert-disaster-field-2026'},name='adr')
sys.path.insert(0,os.getcwd())
import backend.main as bm
async def verify_staff(token):
    if not token.startswith('test-owner-'):raise ValueError('bad synthetic token')
    return {'uid':token,'exp':time.time()+600,'email':'synthetic@example.invalid','email_verified':True}
bm.verify_staff=verify_staff
class Session:
    async def receive(self):
        await asyncio.Event().wait()
        yield None
@asynccontextmanager
async def connect(**kw):yield Session()
async def aclose():pass
bm.genai.Client=lambda **kw:NS(aio=NS(live=NS(connect=connect),aclose=aclose))
runpy.run_path('tests/browser_server.py',run_name='__main__')
