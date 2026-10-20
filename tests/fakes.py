from copy import deepcopy
from threading import RLock
import io, base64
from PIL import Image, ImageDraw
from google.api_core.exceptions import AlreadyExists
from backend.inspection_store import InspectionStore


def png(blank=False):
    image = Image.new('RGBA', (120, 60), (255, 255, 255, 0))
    if not blank:
        ImageDraw.Draw(image).line(
            [(10, 35), (40, 12), (65, 40), (105, 15)], fill=(0, 0, 0, 255), width=3
        )
    output = io.BytesIO()
    image.save(output, format='PNG')
    return 'data:image/png;base64,' + base64.b64encode(output.getvalue()).decode()


class Snapshot:
    def __init__(self, value):
        self.value = deepcopy(value)
        self.exists = value is not None

    def to_dict(self):
        return deepcopy(self.value)


class Ref:
    def __init__(self, db, key):
        self.db = db
        self.key = key

    def get(self, transaction=None):
        return Snapshot(self.db.records.get(self.key))

    def create(self, value):
        if self.key in self.db.records:
            raise AlreadyExists('exists')
        self.db.records[self.key] = deepcopy(value)


class Collection:
    def __init__(self, db, name):
        self.db = db
        self.name = name
        self.filters = []
        self.maximum = 100
        self.order = None
        self.cursor = None

    def document(self, key):
        return Ref(self.db, self.name + '/' + key)

    def where(self, *, filter):
        self.filters.append(filter)
        return self

    def limit(self, maximum):
        self.maximum = maximum
        return self

    def order_by(self, field, direction):
        self.order = field
        return self

    def start_after(self, snapshot):
        self.cursor = snapshot.to_dict()
        return self

    def stream(self, transaction=None):
        rows = [
            v
            for k, v in self.db.records.items()
            if k.startswith(self.name + '/')
            and all(
                (
                    f.value in v.get(f.field_path, [])
                    if f.op_string == 'array_contains'
                    else v.get(f.field_path) == f.value
                )
                for f in self.filters
            )
        ]
        if self.order:
            rows.sort(
                key=lambda r: (
                    r[self.order],
                    r.get('job_id', r.get('inspection_id', r.get('auth_id', ''))),
                ),
                reverse=True,
            )
        if self.cursor:
            key = lambda r: (r[self.order], r.get('inspection_id', r.get('auth_id', '')))
            rows = [r for r in rows if key(r) < key(self.cursor)]
        return iter(Snapshot(r) for r in rows[: self.maximum])


class DB:
    def __init__(self):
        self.records = {}
        self.lock = RLock()

    def collection(self, name):
        return Collection(self, name)


class Tx:
    def create(self, ref, value):
        ref.create(value)

    def set(self, ref, value, merge=False):
        if merge:
            ref.db.records.setdefault(ref.key, {}).update(deepcopy(value))
        else:
            ref.db.records[ref.key] = deepcopy(value)

    def update(self, ref, value):
        ref.db.records[ref.key].update(deepcopy(value))

    def delete(self, ref):
        ref.db.records.pop(ref.key, None)


class Blob:
    def __init__(self, bucket, key):
        self.bucket = bucket
        self.key = key
        self.name = key
        self.generation = 1

    def upload_from_string(self, raw, content_type, **kwargs):
        self.bucket.objects[self.key] = (raw, content_type)

    def download_as_bytes(self):
        return self.bucket.objects[self.key][0]

    def delete(self, **kwargs):
        self.bucket.objects.pop(self.key, None)


class Bucket:
    def __init__(self):
        self.objects = {}

    def blob(self, key):
        return Blob(self, key)


class FakeStore(InspectionStore):
    def __init__(self, db=None, bucket=None):
        super().__init__(db or DB(), bucket or Bucket())

    def _atomic(self, callback):
        with self.db.lock:
            return callback(Tx())


from backend.company_store import CompanyInspectionStore


class FakeCompanyStore(CompanyInspectionStore):
    def __init__(self, db=None, bucket=None):
        super().__init__(db or DB(), bucket or Bucket())

    def _atomic(self, callback):
        with self.db.lock:
            return callback(Tx())


from types import SimpleNamespace
from firebase_admin import auth as firebase_auth


class FakeAuth:
    """Firebase Admin auth keyed by email. Reset links carry a recognizable secret so tests can trace where they go.
    A user's uid is its email's local part; passwords are kept only to check where they went."""

    UserNotFoundError = firebase_auth.UserNotFoundError
    EmailAlreadyExistsError = firebase_auth.EmailAlreadyExistsError
    ActionCodeSettings = firebase_auth.ActionCodeSettings

    def __init__(self):
        self.users = {}
        self.created = []
        self.updated = []
        self.links = []

    def add(self, email, *providers, disabled=False):
        self.users[email] = SimpleNamespace(
            uid=email.split('@')[0],
            email=email,
            email_verified=True,
            disabled=disabled,
            custom_claims=None,
            password=None,
            provider_data=[SimpleNamespace(provider_id=p) for p in providers],
        )

    def get_user_by_email(self, email, app=None):
        if email not in self.users:
            raise self.UserNotFoundError('No user record found.')
        return self.users[email]

    def Client(self, app):
        # Stands in for the owner-login client too; it has no HTTP adapters to bound.
        self._user_manager = SimpleNamespace(
            http_client=SimpleNamespace(session=SimpleNamespace(adapters={}))
        )
        return self

    def get_user(self, uid, app=None):
        for user in self.users.values():
            if user.uid == uid:
                return user
        raise self.UserNotFoundError('No user record found.')

    def create_user(self, email, email_verified, password=None, app=None):
        if email in self.users:
            raise self.EmailAlreadyExistsError(
                'The user with the provided email already exists.', None, None
            )
        self.created.append(dict(email=email, email_verified=email_verified))
        self.add(email, *(['password'] if password else []))
        self.users[email].email_verified = email_verified
        self.users[email].password = password
        return self.users[email]

    def update_user(self, uid, app=None, **changes):
        user = self.get_user(uid)
        self.updated.append(dict(uid=uid, fields=sorted(changes)))
        if 'password' in changes and not any(
            p.provider_id == 'password' for p in user.provider_data
        ):
            user.provider_data.append(SimpleNamespace(provider_id='password'))
        for name, value in changes.items():
            setattr(user, name, value)
        return user

    def generate_password_reset_link(self, email, action_code_settings, app=None):
        link = (
            'https://alert-disaster-field-2026.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=secret-oob-'
            + str(len(self.links))
        )
        self.links.append(
            dict(
                email=email,
                url=action_code_settings.url,
                in_app=action_code_settings.handle_code_in_app,
                link=link,
            )
        )
        return link


def realtime(message):
    # The SDK sends the proto-JSON envelope key in snake case; Vertex accepts either spelling.
    return message.get('realtimeInput', message.get('realtime_input'))


def client_content(message):
    return message.get('clientContent', message.get('client_content'))


class FakeVertexLive:
    """A local TLS stand-in for the Vertex AI Live endpoint, driven by the real SDK client."""

    def __init__(self, tmp_path):
        import datetime, ipaddress, ssl
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.x509.oid import NameOID

        key = ec.generate_private_key(ec.SECP256R1())
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, '127.0.0.1')])
        now = datetime.datetime.now(datetime.timezone.utc)
        cert = (
            x509.CertificateBuilder()
            .subject_name(name)
            .issuer_name(name)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(minutes=5))
            .not_valid_after(now + datetime.timedelta(hours=1))
            .add_extension(
                x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]),
                critical=False,
            )
            .sign(key, hashes.SHA256())
        )
        (tmp_path / 'cert.pem').write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        (tmp_path / 'key.pem').write_bytes(
            key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
        )
        self.server_ssl = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
        self.server_ssl.load_cert_chain(tmp_path / 'cert.pem', tmp_path / 'key.pem')
        self.client_ssl = ssl.create_default_context(cafile=str(tmp_path / 'cert.pem'))
        self.connections = []
        self.replies = {}
        self.drained = []

    def __enter__(self):
        import threading
        from websockets.sync.server import serve

        self.server = serve(self.handle, '127.0.0.1', 0, ssl=self.server_ssl)
        self.port = self.server.socket.getsockname()[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *exc):
        self.server.shutdown()
        # Handlers finish once they have read every frame the closed client sent.
        for drained in self.drained:
            drained.wait(5)

    def client(self, relay):
        """Wraps genai.Client so it reaches this server with synthetic credentials and otherwise unchanged arguments."""
        from google.oauth2.credentials import Credentials

        def connect(**kw):
            options = kw.pop('http_options').model_copy(
                update=dict(
                    base_url=f'https://127.0.0.1:{self.port}',
                    async_client_args={'ssl': self.client_ssl},
                )
            )
            return relay(
                credentials=Credentials(token='synthetic-token'), http_options=options, **kw
            )

        return connect

    def handle(self, socket):
        import json, threading
        from websockets.exceptions import ConnectionClosed

        received = []
        self.connections.append(
            dict(
                path=socket.request.path,
                authorization=socket.request.headers.get('Authorization'),
                received=received,
            )
        )
        drained = threading.Event()
        self.drained.append(drained)
        try:
            while True:
                message = json.loads(socket.recv())
                received.append(message)
                kind = (
                    'setup'
                    if 'setup' in message
                    else 'client_content'
                    if client_content(message)
                    else next(iter(realtime(message) or {}), None)
                )
                for reply in self.replies.pop(kind, []):
                    socket.send(json.dumps(reply))
        except ConnectionClosed:
            pass
        finally:
            drained.set()
