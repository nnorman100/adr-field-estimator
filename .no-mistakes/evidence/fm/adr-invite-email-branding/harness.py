"""Disposable harness: real backend app (fake stores from tests/browser_server.py) with the REAL
send_invitation, talking to a local STARTTLS SMTP server or a local fake Resend endpoint."""
import os, sys, json, ssl, datetime, ipaddress, threading, urllib.request
from pathlib import Path

ROOT = Path(sys.argv[1])
OUT = Path('/tmp/adr-invite-test/mail')
os.environ['ADR_BROWSER_PORT'] = '8799'
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'tests'))
os.chdir(ROOT)

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa

key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
name = x509.Name([x509.NameAttribute(x509.NameOID.COMMON_NAME, 'localhost')])
now = datetime.datetime.now(datetime.timezone.utc)
cert = (
    x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
    .serial_number(x509.random_serial_number())
    .not_valid_before(now - datetime.timedelta(minutes=1)).not_valid_after(now + datetime.timedelta(days=1))
    .add_extension(x509.SubjectAlternativeName([x509.DNSName('localhost'), x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]), critical=False)
    .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
    .sign(key, hashes.SHA256())
)
tls = Path('/tmp/adr-invite-test/tls'); tls.mkdir(exist_ok=True)
(tls / 'key.pem').write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
(tls / 'cert.pem').write_bytes(cert.public_bytes(serialization.Encoding.PEM))
# The product's ssl.create_default_context() trusts this CA only through the standard env var.
os.environ['SSL_CERT_FILE'] = str(tls / 'cert.pem')

# --- Local SMTP server with STARTTLS + AUTH LOGIN, like smtp.gmail.com:587 -----------------
from aiosmtpd.controller import Controller
from aiosmtpd.smtp import AuthResult

counter = {'n': 0}

class Handler:
    async def handle_DATA(self, server, session, envelope):
        counter['n'] += 1
        (OUT / f'smtp-{counter["n"]}.eml').write_bytes(envelope.original_content)
        (OUT / f'smtp-{counter["n"]}.meta.json').write_text(json.dumps({'mail_from': envelope.mail_from, 'rcpt_tos': envelope.rcpt_tos, 'tls': session.ssl is not None, 'auth': str(session.authenticated)}))
        return '250 OK'

def auth(server, session, envelope, mechanism, data):
    return AuthResult(success=data.login == b'captain@example.invalid' and data.password == b'app-password')

ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
ctx.load_cert_chain(tls / 'cert.pem', tls / 'key.pem')
smtp = Controller(Handler(), hostname='127.0.0.1', port=8825, tls_context=ctx, require_starttls=True, authenticator=auth, auth_require_tls=True, server_hostname='localhost')
smtp.start()

# --- Local fake Resend API --------------------------------------------------------------
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

class Resend(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers['Content-Length']))
        counter['n'] += 1
        (OUT / f'resend-{counter["n"]}.json').write_bytes(body)
        (OUT / f'resend-{counter["n"]}.headers.json').write_text(json.dumps({k: v for k, v in self.headers.items() if k.lower() != 'authorization'}))
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps({'id': f'resend-local-{counter["n"]}'}).encode())
    def log_message(self, *a):
        pass

resend = ThreadingHTTPServer(('127.0.0.1', 8826), Resend)
threading.Thread(target=resend.serve_forever, daemon=True).start()

import browser_server as bs  # noqa: E402  (real backend.main app with fake stores)
wm = bs.wm
wm.SMTP_HOST, wm.SMTP_PORT = 'localhost', 8825
_urlopen = urllib.request.urlopen

def urlopen(request, *a, **k):
    if getattr(request, 'full_url', '') == 'https://api.resend.com/emails':
        request.full_url = 'http://127.0.0.1:8826/emails'
    return _urlopen(request, *a, **k)

urllib.request.urlopen = urlopen
fixture = bs.workspaces_fixture

from fastapi import Request

@bs.bm.app.post('/__probe/real-sender')
async def real_sender(request: Request):
    body = await request.json()
    wm.send_invitation = bs.original_sender
    os.environ['INVITATION_TRANSPORT'] = body['transport']
    return {'transport': body['transport']}

bs.bm.app.router.routes.insert(0, bs.bm.app.router.routes.pop())

@bs.bm.app.post('/__probe/raw-profile')
async def raw_profile(request: Request):
    # Writes profile fields straight into the fake store, bypassing API validation (legacy/corrupt data).
    body = await request.json()
    bs.store.db.records['_companies/adr']['profile'].update(body)
    return bs.store.db.records['_companies/adr']['profile']

bs.bm.app.router.routes.insert(0, bs.bm.app.router.routes.pop())

if __name__ == '__main__':
    import uvicorn
    uvicorn.run(bs.bm.app, host='127.0.0.1', port=8799, log_level='warning')
