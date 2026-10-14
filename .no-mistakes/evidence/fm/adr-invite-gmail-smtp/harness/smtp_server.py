"""Disposable local STARTTLS+AUTH SMTP server standing in for smtp.gmail.com:587."""
import asyncio, json, os, ssl, sys, time, socket, threading
from aiosmtpd.controller import Controller
from aiosmtpd.smtp import AuthResult, LoginPassword

PORT = int(sys.argv[1]); MODE = sys.argv[2]; LOG = sys.argv[3]
USER, PASS = 'synthetic.sender@example.invalid', 'synthetic-app-password'
state = {'data_calls': 0}

def log(**kw):
    kw['t'] = time.time()
    with open(LOG, 'a') as f:
        f.write(json.dumps(kw) + '\n')

class Handler:
    async def handle_DATA(self, server, session, envelope):
        state['data_calls'] += 1
        if MODE == 'transient' and state['data_calls'] == 1:
            log(event='data_tempfail')
            return '451 4.3.0 Synthetic temporary failure'
        log(event='delivered', mail_from=envelope.mail_from, rcpt=envelope.rcpt_tos,
            tls=session.ssl is not None, auth=session.authenticated, data=envelope.content.decode())
        return '250 2.0.0 OK synthetic'

def authenticator(server, session, envelope, mechanism, auth_data):
    ok = isinstance(auth_data, LoginPassword) and auth_data.login.decode() == USER and auth_data.password.decode() == PASS
    log(event='auth', ok=ok, tls=session.ssl is not None)
    return AuthResult(success=ok, handled=False)

if MODE == 'hang':
    s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(('127.0.0.1', PORT)); s.listen(10); conns = []
    print('ready', flush=True)
    while True:
        c, _ = s.accept(); conns.append(c); log(event='connect_hang')
else:
    ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    ctx.load_cert_chain('/tmp/nm-smtp-test/cert.pem', '/tmp/nm-smtp-test/key.pem')
    c = Controller(Handler(), hostname='127.0.0.1', port=PORT, tls_context=ctx, require_starttls=True,
                   authenticator=authenticator, auth_required=True, auth_require_tls=True)
    c.start(); print('ready', flush=True)
    threading.Event().wait()
