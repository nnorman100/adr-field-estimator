"""Disposable end-to-end harness: the real FastAPI app and Live relay (backend/main.py) served over
TLS, the real google-genai SDK connecting to a scripted local Vertex Live stand-in, and a TCP proxy
in front of /api/live that can delay the phone->server direction to emulate a weak cellular uplink.

Run from the worktree root: ADR_BROWSER_PORT=8790 python <this file>
"""

import asyncio, base64, json, os, sys, threading, time, tempfile, datetime, ipaddress
from array import array
from pathlib import Path

ROOT = Path.cwd()
sys.path.insert(0, str(ROOT))
os.environ.setdefault('ADR_BROWSER_PORT', '8790')
PORT = int(os.environ['ADR_BROWSER_PORT'])
PROXY_PORT = PORT + 1

import tests.browser_server as harness  # noqa: E402  (fake identity, store, static frontend)
import backend.main as bm  # noqa: E402
from tests.fakes import FakeVertexLive, realtime, client_content  # noqa: E402
from fastapi import Request  # noqa: E402

# The client pins the production Live hostname; Chromium maps it to the local proxy (see drive.js).


async def verify_staff(token, live=False):
    if not token.startswith('test-owner-'):
        raise bm.HTTPException(401, 'Sign in to continue.')
    return {'uid': token, 'email': 'synthetic@example.invalid', 'exp': time.time() + 3600}


bm.verify_staff = verify_staff

tmp = Path(tempfile.mkdtemp(prefix='adr-live-e2e-'))


def b64(text):
    # The SDK serializes bytes as URL-safe base64 without padding.
    return base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))


class ScriptedVertex(FakeVertexLive):
    """Records what the relay forwards and lets the driver push Vertex server messages."""

    def __init__(self, path):
        super().__init__(path)
        self.events = []  # (monotonic, kind, detail)
        self.socket = None

    def handle(self, socket):
        from websockets.exceptions import ConnectionClosed

        self.socket = socket
        try:
            while True:
                message = json.loads(socket.recv())
                now = time.time()
                if 'setup' in message:
                    self.events.append((now, 'setup', None))
                    socket.send(json.dumps({'setupComplete': {}}))
                    continue
                if client_content(message):
                    self.events.append((now, 'greeting_trigger', None))
                    continue
                rt = realtime(message) or {}
                for key, value in rt.items():
                    if key in ('audio', 'mediaChunks', 'media_chunks'):
                        blob = value if isinstance(value, dict) else value[0]
                        raw = b64(blob['data'])
                        samples = array('h')
                        samples.frombytes(raw[: len(raw) // 2 * 2])
                        rms = (sum(s * s for s in samples) / max(len(samples), 1)) ** 0.5
                        self.events.append((now, 'audio', dict(bytes=len(raw), rms=round(rms))))
                    elif key == 'video':
                        raw = b64(value['data'])
                        self.events.append((now, 'video', dict(bytes=len(raw), jpeg=raw[:200].hex())))
                        self.frames.append(raw)
                    else:
                        self.events.append((now, key, None))
        except ConnectionClosed:
            pass
        finally:
            self.events.append((time.time(), 'closed', None))

    frames = []


vertex = ScriptedVertex(tmp)
vertex.__enter__()
bm.genai.Client = vertex.client(bm.genai.Client)

# ---- weak uplink proxy (phone -> relay direction delayed) ----
delay = {'ms': 0}


async def pipe(reader, writer, delayed):
    queue = asyncio.Queue()

    async def pump():
        while True:
            at, chunk = await queue.get()
            if chunk is None:
                break
            wait = at - time.monotonic()
            if wait > 0:
                await asyncio.sleep(wait)
            writer.write(chunk)
            await writer.drain()
        writer.close()

    task = asyncio.create_task(pump())
    try:
        while chunk := await reader.read(65536):
            hold = delay['ms'] / 1000 if delayed else 0
            queue.put_nowait((time.monotonic() + hold, chunk))
    except Exception:
        pass
    queue.put_nowait((0, None))
    await task


async def proxy_client(reader, writer):
    up_r, up_w = await asyncio.open_connection('127.0.0.1', PORT)
    await asyncio.gather(pipe(reader, up_w, True), pipe(up_r, writer, False), return_exceptions=True)


def run_proxy():
    loop = asyncio.new_event_loop()

    async def main():
        server = await asyncio.start_server(proxy_client, '127.0.0.1', PROXY_PORT)
        async with server:
            await server.serve_forever()

    loop.run_until_complete(main())


threading.Thread(target=run_proxy, daemon=True).start()


# ---- driver control routes (test-only) ----
@bm.app.post('/__e2e/delay')
async def set_delay(request: Request):
    delay['ms'] = (await request.json())['ms']
    return delay


@bm.app.post('/__e2e/push')
async def push(request: Request):
    for message in (await request.json())['messages']:
        vertex.socket.send(json.dumps(message))
    return {'ok': True}


@bm.app.get('/__e2e/events')
async def events(since: float = 0):
    return [dict(t=t, kind=k, detail=d) for t, k, d in vertex.events if t >= since]


@bm.app.get('/__e2e/frame/{index}')
async def frame(index: int):
    from fastapi import Response

    return Response(vertex.frames[index], media_type='image/jpeg')


# The static mount must stay last; move it behind the control routes.
routes = bm.app.router.routes
mount = next(r for r in routes if getattr(r, 'name', '') == 'frontend')
routes.remove(mount)
routes.append(mount)

if __name__ == '__main__':
    import uvicorn
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(x509.NameOID.COMMON_NAME, 'localhost')])
    moment = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(moment - datetime.timedelta(minutes=1))
        .not_valid_after(moment + datetime.timedelta(days=1))
        .add_extension(
            x509.SubjectAlternativeName(
                [x509.DNSName('localhost'), x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]
            ),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )
    (tmp / 'k.pem').write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    (tmp / 'c.pem').write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    uvicorn.run(
        bm.app,
        host='127.0.0.1',
        port=PORT,
        log_level='warning',
        ssl_keyfile=str(tmp / 'k.pem'),
        ssl_certfile=str(tmp / 'c.pem'),
    )
