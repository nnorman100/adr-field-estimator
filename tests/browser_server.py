"""Local-only production-code harness with fake cloud adapters and synthetic identity."""

import sys, json, os, re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
port_value = os.environ.get('ADR_BROWSER_PORT', '8765')
if (
    not re.fullmatch(r'[0-9]+', port_value)
    or len(port_value) > 5
    or not 1 <= int(port_value) <= 65535
):
    raise ValueError('ADR_BROWSER_PORT must be an integer from 1 to 65535.')
BROWSER_PORT = int(port_value)
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / '.test-deps'))
from types import SimpleNamespace
import uvicorn
from fastapi import Request, HTTPException, Response
from fastapi.staticfiles import StaticFiles
import backend.main as bm

bm.ORIGINS.extend([f'https://localhost:{BROWSER_PORT}', f'https://127.0.0.1:{BROWSER_PORT}'])
from tests.fakes import FakeStore, FakeCompanyStore
from backend.workspaces import ADR_PROFILE
import backend.workspaces as wm
from backend.contracts import InspectionData
from copy import deepcopy

store = FakeStore()
legacy_store = store
original_sender = wm.send_invitation
faults = {}
authorization_refs = {}
worker_suffix = ''


async def identity(request: Request):
    token = request.headers.get('Authorization', '')
    if not token.startswith('Bearer test-owner-'):
        raise HTTPException(401, 'Sign in to continue.')
    uid = token.split(' ')[1]
    fault = faults.get(uid, {})
    for name, matched in [
        ('evidence', '/evidence/' in request.url.path),
        ('record', request.method == 'GET' and request.url.path.startswith('/api/authorizations/')),
    ]:
        if matched and fault.get(name):
            fault[name] -= 1
            raise HTTPException(503, 'Synthetic saved evidence load failure')
    if request.url.path == '/api/audit' and fault.get('audit'):
        fault['audit'] -= 1
        raise HTTPException(502, 'Synthetic provider failure')
    if request.url.path == '/api/authorize':
        authorization_refs.setdefault(uid, []).append((await request.json())['auth_id'])
        if fault.get('authorize'):
            fault['authorize'] -= 1
            raise HTTPException(503, 'Synthetic save failure')
    return {
        'uid': uid,
        'email': uid + '@example.invalid' if bm.WORKSPACES_ENABLED else 'synthetic@example.invalid',
        'email_verified': True,
        'firebase': {'sign_in_provider': 'google.com'},
    }


bm.app.dependency_overrides[bm.current_identity] = identity
bm.app.dependency_overrides[bm.current_staff] = identity
bm.app.dependency_overrides[bm.get_job_store] = lambda: store
bm.get_job_store = lambda: store


async def generate(**kwargs):
    schema = kwargs['config'].response_schema
    if isinstance(schema, dict) and schema == bm.scope_response_schema():
        return SimpleNamespace(
            text=json.dumps(
                {
                    'changes': [
                        {
                            'field': 'category',
                            'room': 'Room 1',
                            'value': 2,
                            'source_quote': 'Room 1, category 2, 80 square feet of drywall.',
                        },
                        {
                            'field': 'finished_sf',
                            'room': 'Room 1',
                            'value': 80,
                            'source_quote': 'Room 1, category 2, 80 square feet of drywall.',
                        },
                        {
                            'field': 'air_movers',
                            'room': None,
                            'value': 3,
                            'source_quote': 'Use 3 fans.',
                        },
                    ],
                    'questions': ['Confirm any additional labor.'],
                }
            )
        )
    if schema is bm.TranscriptionResult:
        # Offline voice notes: the same statements the synthetic scope fill quotes.
        return SimpleNamespace(
            text=json.dumps({'text': 'Room 1, category 2, 80 square feet of drywall.'})
        )
    if schema is bm.AIResult:
        # Like the real audit, flag a dehumidifier the walkthrough mentions but the form omits.
        inspection = json.loads(kwargs['contents'][0].split('(JSON):\n', 1)[1])['inspection']
        omitted = (
            'dehumidifier' in inspection['technician_transcript'].lower()
            and not inspection['dehumidifiers']
        )
    result = (
        {
            'summary': '<img src=x onerror="window.reviewInjected=true"> Confirmed scope summary.',
            'suggestions': ['Document drying progress.'],
            'unpriced_work': (
                ['One dehumidifier rental for 3 days was described but omitted from the form.']
                if omitted
                else []
            ),
        }
        if schema is bm.AIResult
        else {
            'meter_detected': False,
            'meter_type': 'Inspection Photo',
            'value': '',
            'classification': 'Not verified',
            'notes': 'No physical meter in synthetic fixture.',
        }
    )
    return SimpleNamespace(text=json.dumps(result))


bm.get_ai_client = lambda: SimpleNamespace(
    aio=SimpleNamespace(models=SimpleNamespace(generate_content=generate))
)


@bm.app.post('/__test/fault')
async def fault(request: Request):
    global worker_suffix
    body = await request.json()
    faults[body['uid']] = body.get('faults', {})
    if body.get('faults', {}).get('worker'):
        worker_suffix = body['uid']
    return {'references': authorization_refs.get(body['uid'], [])}


@bm.app.post('/__test/workspaces')
async def workspaces_fixture(request: Request):
    global store
    body = await request.json()
    if not body.get('enabled'):
        store = legacy_store
        bm.WORKSPACES_ENABLED = False
        wm.send_invitation = original_sender
        return {'enabled': False}
    store = FakeCompanyStore()
    bm.WORKSPACES_ENABLED = True
    for cid in ('adr', 'other'):
        profile = deepcopy(ADR_PROFILE)
        if cid == 'other':
            profile.update(
                name='Other Restoration',
                address='Other office',
                license='123456',
                signoff='Other Estimator',
                water_heater_notice='Other company trade coordination.',
            )
        store.db.records['_companies/' + cid] = dict(
            company_id=cid,
            profile=profile,
            version=1,
            status='active',
            owner_uid='test-owner-ws-owner' if cid == 'adr' else 'test-owner-ws-other',
            created_at='2026',
            updated_at='2026',
            region='CA',
        )
    for role in ('owner', 'estimator', 'office', 'other'):
        uid = 'test-owner-ws-' + role
        store.db.records['_memberships/' + uid] = dict(
            uid=uid,
            email=uid + '@example.invalid',
            company_id='other' if role == 'other' else 'adr',
            role='owner' if role == 'other' else role,
            status='active',
            version=1,
            updated_at='2026',
        )
    store.db.records['_platform_admins/test-owner-ws-owner'] = {'active': True}
    store.db.records['_platform_admins/test-owner-ws-admin'] = {'active': True}
    data = InspectionData(
        address='Assigned bathroom',
        year_built=2000,
        rooms=[dict(name='Bathroom', category=1, finished_sf=10)],
        air_movers=3,
        dehumidifiers=1,
        scope_confirmed=True,
    ).model_dump(mode='json')
    store.create_inspection('test-owner-ws-estimator', 'ADR-INS-' + 'c' * 32, data)
    if body.get('send_fail'):

        def sender(*args):
            raise TimeoutError('Synthetic email failure')
    else:

        def sender(invite, company):
            return 'synthetic-message-' + invite['send_attempt']

    wm.send_invitation = sender
    return {'enabled': True, 'inspection_id': 'ADR-INS-' + 'c' * 32}


@bm.app.post('/__test/expire-signing-links')
async def expire_signing_links():
    # Moves every outstanding link past its seven-day expiry.
    expired = 0
    for key, link in store.db.records.items():
        if key.startswith('_signing_links/') and link['status'] == 'pending':
            link['expires'] = 0
            expired += 1
    return {'expired': expired}


@bm.app.get('/__test/workspaces-stats')
async def workspaces_stats():
    return {'inspection_count': len([k for k in store.db.records if k.startswith('inspections/')])}


@bm.app.get('/__test/support-events')
async def support_events():
    return [
        v
        for k, v in store.db.records.items()
        if k.startswith('_admin_events/') and v['action'].startswith('support_')
    ]


@bm.app.get('/sw.js')
def worker():
    return Response(
        (ROOT / 'public/sw.js')
        .read_text()
        .replace(
            "const CACHE='alert-disaster-'+VERSION;",
            "const CACHE='alert-disaster-'+VERSION+'" + worker_suffix + "';",
        ),
        media_type='text/javascript',
        headers={'Cache-Control': 'no-store'},
    )


@bm.app.post('/__test/seed-jobs')
async def seed_jobs(request: Request):
    uid = (await request.json())['uid']
    if not uid.startswith('test-owner-'):
        raise HTTPException(400, 'Synthetic identity required.')
    for i in range(105):
        aid = f'ADR-AUTH-{uid}-{i:03}'
        store.db.records['authorizations/' + aid] = dict(
            auth_id=aid,
            owner_uid=uid,
            address=f'Synthetic signed job {i:03}',
            created_at=f'2026-10-06T19:{i // 60:02}:{i % 60:02}Z',
            proposed_cost=1000,
            photos_count=0,
            schema_version=3,
        )
    return {'count': 105}


@bm.app.get('/__/firebase/init.json')
def firebase_config():
    return {'projectId': 'alert-disaster-field-2026', 'apiKey': 'synthetic-config-only'}


@bm.app.get('/vendor/firebase/{version}/firebase-app.js')
def app_sdk(version: str):
    return Response(
        '/* Local synthetic browser identity only. */export const initializeApp=options=>({options});',
        media_type='text/javascript',
    )


@bm.app.get('/vendor/firebase/{version}/firebase-auth.js')
def auth_sdk(version: str):
    return Response((ROOT / 'tests/browser-auth.js').read_text(), media_type='text/javascript')


@bm.app.get('/sign')
def signing_page():
    # Mirrors the /sign rewrite in firebase.json.
    return Response(
        (ROOT / 'public/sign.html').read_bytes(),
        media_type='text/html',
        headers={'Cache-Control': 'no-store'},
    )


bm.app.mount('/', StaticFiles(directory=str(ROOT / 'public'), html=True), name='frontend')
if __name__ == '__main__':
    # Real secure context for WebKit's media APIs and service worker support.
    import tempfile, datetime, ipaddress
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    with tempfile.TemporaryDirectory(prefix='adr-browser-tls-') as directory:
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
        key_path = Path(directory) / 'key.pem'
        cert_path = Path(directory) / 'cert.pem'
        key_path.write_bytes(
            key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
        )
        cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        uvicorn.run(
            bm.app,
            host='127.0.0.1',
            port=BROWSER_PORT,
            log_level='warning',
            ssl_keyfile=str(key_path),
            ssl_certfile=str(cert_path),
        )
