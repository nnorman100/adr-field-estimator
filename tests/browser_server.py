"""Local-only production-code harness with fake cloud adapters and synthetic identity."""

import sys, json, os, re, time
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
from backend import places, ai_features, monitoring_store

bm.ORIGINS.extend([f'https://localhost:{BROWSER_PORT}', f'https://127.0.0.1:{BROWSER_PORT}'])
from tests.fakes import ADR_PROFILE, FakeAuth, FakeStore, FakeCompanyStore
import backend.workspaces as wm
import backend.document_links as document_links
from backend.contracts import InspectionData
from copy import deepcopy

store = FakeStore()
legacy_store = store
original_sender = wm.send_invitation
original_auth = (wm.firebase_auth, wm.auth_app)
# Firebase accounts the backend creates, such as superadmin-created owner logins; reset with each fixture.
accounts = FakeAuth()
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
        ('extra_approve', '/extras/' in request.url.path and request.url.path.endswith('/approve')),
        ('extra_quote', request.url.path.endswith('/extras/quote')),
        ('record', request.method == 'GET' and request.url.path.startswith('/api/authorizations/')),
    ]:
        if matched and fault.get(name):
            fault[name] -= 1
            raise HTTPException(503, 'Synthetic saved evidence load failure')
    if request.url.path.endswith('/drying-watch/summary') and fault.get('drying_summary'):
        fault['drying_summary'] -= 1
        raise HTTPException(502, 'Synthetic provider failure')
    if request.url.path == '/api/audit' and fault.get('audit'):
        fault['audit'] -= 1
        raise HTTPException(502, 'Synthetic provider failure')
    if request.url.path == '/api/authorize':
        authorization_refs.setdefault(uid, []).append((await request.json())['auth_id'])
        if fault.get('authorize'):
            fault['authorize'] -= 1
            raise HTTPException(503, 'Synthetic save failure')
    email = uid + '@example.invalid' if bm.WORKSPACES_ENABLED else 'synthetic@example.invalid'
    account = accounts.users.get(email) if bm.WORKSPACES_ENABLED else None
    if account and account.password:
        # A backend-created password login: its token carries the account's current custom claims.
        return {
            'uid': uid,
            'email': email,
            'email_verified': True,
            'firebase': {'sign_in_provider': 'password'},
            **(account.custom_claims or {}),
        }
    return {
        'uid': uid,
        'email': email,
        'email_verified': True,
        'firebase': {'sign_in_provider': 'google.com'},
    }


bm.app.dependency_overrides[bm.current_identity] = identity
bm.app.dependency_overrides[bm.account_identity] = identity
bm.app.dependency_overrides[bm.current_staff] = identity
bm.app.dependency_overrides[bm.get_job_store] = lambda: store
bm.get_job_store = lambda: store


CLAIM_WORDS = 'Synthetic Mutual claim number CLM 0042 77.'


async def generate(**kwargs):
    schema = kwargs['config'].response_schema
    if schema.__name__ == 'DryingSummary' if isinstance(schema, type) else False:
        from backend.drying_summary import summary_options

        pack = json.loads(str(kwargs['contents']).split('\n')[-1])
        option = summary_options(pack['facts'])[0]
        return SimpleNamespace(
            text=json.dumps(
                {
                    'rooms': [
                        {
                            'room_index': option['room_index'],
                            'trend': option['trend'],
                            'mention': 'status',
                        }
                    ]
                }
            )
        )
    if isinstance(schema, dict) and schema == bm.scope_response_schema():
        kitchen = 'Kitchen, category 2, 80 SF drywall' in str(kwargs['contents'])
        room = 'Kitchen' if kitchen else 'Room 1'
        quote = (
            'Kitchen, category 2, 80 SF drywall'
            if kitchen
            else 'Room 1, category 2, 80 square feet of drywall.'
        )
        return SimpleNamespace(
            text=json.dumps(
                {
                    'changes': [
                        {
                            'field': 'category',
                            'room': room,
                            'value': 2,
                            'source_quote': quote,
                        },
                        {
                            'field': 'finished_sf',
                            'room': room,
                            'value': 80,
                            'source_quote': quote,
                        },
                        {
                            'field': 'air_movers',
                            'room': None,
                            'value': 3,
                            'source_quote': 'Use 3 fans.',
                        },
                    ],
                    # Claim details only when the walkthrough states them (tests/browser/claim-details.spec.js).
                    'claim_changes': [
                        {'field': field, 'value': value, 'source_quote': CLAIM_WORDS}
                        for field, value in (
                            ('carrier', 'Synthetic Mutual'),
                            ('claim_number', 'CLM 0042 77'),
                        )
                    ]
                    if CLAIM_WORDS in str(kwargs['contents'])
                    else [],
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
                else (
                    ['Move and reset toilet']
                    if 'Move and reset toilet' in inspection.get('technician_notes', '')
                    else []
                )
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


# Address suggestions: the real routes and caps run; only the network call to Google is replaced.
# No key unless a spec turns one on, so other specs see the plain address box.
places_fixture = {'key': False, 'fail': None, 'calls': []}


def synthetic_png():
    from PIL import Image
    import io

    output = io.BytesIO()
    Image.new('RGB', (1200, 600), (124, 196, 232)).save(output, format='PNG')
    return output.getvalue()


def synthetic_places(request):
    places_fixture['calls'].append(request.full_url.split('?')[0].rsplit('/', 1)[-1])
    if places_fixture['fail']:
        raise places.ProviderError(places_fixture['fail'])
    if request.full_url.endswith('places:autocomplete'):
        return 'application/json', json.dumps(
            {
                'suggestions': [
                    {
                        'placePrediction': {
                            'placeId': 'ChIJsynthetic_place_id_0001',
                            'text': {'text': '4821 Zephyr Hollow Lane, Bakersfield, CA, USA'},
                        }
                    }
                ]
            }
        ).encode()
    if '/places/' in request.full_url:
        return 'application/json', json.dumps(
            {
                'formattedAddress': '4821 Zephyr Hollow Lane, Bakersfield, CA 93301, USA',
                'location': {'latitude': 35.373292, 'longitude': -119.018712},
                'addressComponents': [],
            }
        ).encode()
    return 'image/png', synthetic_png()


places.send = synthetic_places
places.api_key = lambda: 'synthetic-maps-key' if places_fixture['key'] else ''


@bm.app.post('/__test/places')
async def places_settings(request: Request):
    body = await request.json()
    places_fixture.update(key=body.get('key', False), fail=body.get('fail'), calls=[])
    return places_fixture


@bm.app.get('/__test/places')
async def places_calls():
    return places_fixture['calls']


@bm.app.post('/__test/fault')
async def fault(request: Request):
    global worker_suffix
    body = await request.json()
    faults[body['uid']] = body.get('faults', {})
    if body.get('faults', {}).get('worker'):
        worker_suffix = body['uid']
    return {'references': authorization_refs.get(body['uid'], [])}


@bm.app.post('/__test/auth/sign-in')
async def password_sign_in(request: Request):
    # Stands in for Firebase's password check on accounts the backend created.
    body = await request.json()
    account = accounts.users.get(body.get('email'))
    if not account or not account.password or account.password != body.get('password'):
        raise HTTPException(401, 'Synthetic wrong password')
    return {'uid': account.uid}


@bm.app.get('/__test/auth/claims')
async def password_claims(uid: str):
    return accounts.get_user(uid).custom_claims or {}


@bm.app.post('/__test/workspaces')
async def workspaces_fixture(request: Request):
    global store, accounts
    body = await request.json()
    ai_features.AI_FEATURES = frozenset(body.get('ai_features', []))
    if not body.get('enabled'):
        store = legacy_store
        bm.WORKSPACES_ENABLED = False
        wm.send_invitation = original_sender
        wm.firebase_auth, wm.auth_app = original_auth
        return {'enabled': False}
    store = FakeCompanyStore()
    accounts = FakeAuth()
    accounts.add('test-owner-ws-google@example.invalid', 'google.com')
    accounts.add('test-owner-ws-estimator@example.invalid', 'password')
    wm.firebase_auth, wm.auth_app = accounts, lambda: None
    bm.WORKSPACES_ENABLED = True
    for cid in ('adr', 'other'):
        profile = deepcopy(ADR_PROFILE)
        if cid == 'other':
            profile.update(
                name='Other Restoration',
                address='Other office',
                phone='(555) 123-4567',
                email='other@example.invalid',
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
    # Stored in the shape the inspections API saves, so a later client save compares equal.
    data = bm.inspection_payload(
        InspectionData(
            address='Assigned bathroom',
            year_built=2000,
            rooms=[dict(name='Bathroom', category=1, finished_sf=10)],
            air_movers=3,
            dehumidifiers=1,
            scope_confirmed=True,
        )
    )
    store.create_inspection('test-owner-ws-estimator', 'ADR-INS-' + 'c' * 32, data)
    if body.get('emails_today'):
        store.db.records['_email_counts/daily'] = {
            'sent': {'start': time.time(), 'count': body['emails_today']}
        }
    if body.get('send_fail'):

        def sender(*args):
            raise TimeoutError('Synthetic email failure')
    else:

        def sender(invite, company):
            return 'synthetic-message-' + invite['send_attempt']

    wm.send_invitation = sender
    return {'enabled': True, 'inspection_id': 'ADR-INS-' + 'c' * 32}


@bm.app.post('/__test/drying-watch')
async def drying_watch_fixture(request: Request):
    from backend.contracts import AIResult
    from tests.fakes import png

    body = await request.json()
    job_id = 'ADR-INS-' + 'c' * 32
    uid = 'test-owner-ws-estimator'
    record = store.get_inspection(uid, job_id)
    documents = bm.make_documents(
        InspectionData.model_validate(record['data']),
        [],
        AIResult(summary='Confirmed', suggestions=[], unpriced_work=[]),
        store.workspaces.snapshot(uid),
    )
    record = store.save_audit(uid, job_id, record['revision'], documents)
    payload = dict(
        inspection_id=job_id,
        auth_id='ADR-AUTH-dryingwatch123',
        expected_revision=record['revision'],
        proposal_hash=record['audit']['proposal_hash'],
        signature_png=png(),
        documents_confirmed=True,
    )
    store.authorize(uid, payload)
    store.db.records['_workspace_jobs/' + job_id]['assigned_estimator_uid'] = uid
    store.db.records['_companies/adr']['profile'].update(
        drying_reminders=body.get('reminders', True), crew_lead_email='crew@example.invalid'
    )
    store.db.records['_memberships/test-owner-ws-unassigned'] = dict(
        uid='test-owner-ws-unassigned',
        email='unassigned@example.invalid',
        company_id='adr',
        role='estimator',
        status='active',
        version=1,
    )
    monitoring_store.mail_settings = lambda: {}
    sends = []

    def fake_send(*args, **kwargs):
        if body.get('send_fail'):
            body['send_fail'] = False
            raise RuntimeError('Synthetic reminder failure')
        sends.append(args[3])
        return 'synthetic-reminder'

    monitoring_store.send_email = fake_send
    return {'job_id': job_id, 'auth_id': payload['auth_id']}


@bm.app.post('/__test/expire-signing-links')
async def expire_signing_links():
    # Moves every outstanding link past its seven-day expiry.
    expired = 0
    for key, link in store.db.records.items():
        if key.startswith('_signing_links/') and link['status'] == 'pending':
            link['expires'] = 0
            expired += 1
    return {'expired': expired}


@bm.app.post('/__test/document-links')
async def mint_document_link(request: Request):
    # Stands in for the delivery step that will mint links after signing (roadmap Phase 2); the
    # app has no action for it yet. Acts as the synthetic staff user the body names.
    body = await request.json()
    uid = body['uid']
    if not uid.startswith('test-owner-'):
        raise HTTPException(400, 'Synthetic identity required.')
    try:
        token, expires = document_links.mint(store, uid, body['auth_id'], body['document_set'])
    except (LookupError, wm.AccessDenied) as error:
        raise HTTPException(404, str(error))
    origin = f'https://localhost:{BROWSER_PORT}'
    return {'url': origin + '/documents#' + token, 'expires_at': document_links.iso(expires)}


@bm.app.post('/__test/old-document-record')
async def old_document_record(request: Request):
    body = await request.json()
    agreement = store.db.records['authorizations/' + body['auth_id']]
    agreement.pop('signing_channel', None)
    agreement['documents'].pop('claim', None)
    for photo in agreement['documents']['photo_audit_log']:
        photo.pop('location', None)
    return {'prepared': True}


@bm.app.post('/__test/revoke-document-links')
async def revoke_document_links(request: Request):
    body = await request.json()
    return document_links.revoke(store, body['uid'], body['auth_id'])


@bm.app.post('/__test/expire-document-links')
async def expire_document_links():
    expired = 0
    for key, link in store.db.records.items():
        if key.startswith('_document_links/') and link['status'] == 'active':
            link['expires'] = 0
            expired += 1
    return {'expired': expired}


@bm.app.get('/__test/workspaces-stats')
async def workspaces_stats():
    return {
        'inspection_count': len([k for k in store.db.records if k.startswith('inspections/')]),
        'delivery_count': len([k for k in store.db.records if k.startswith('_job_deliveries/')]),
        'email_count': store.db.records.get('_email_counts/daily', {})
        .get('sent', {})
        .get('count', 0),
    }


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
            "const CACHE='dryscope-extras-v1-'+VERSION;",
            "const CACHE='dryscope-extras-v1-'+VERSION+'" + worker_suffix + "';",
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
@bm.app.get('/documents')
def signing_page():
    # Mirrors the /sign and /documents rewrites in firebase.json: one shell, two links.
    return Response(
        (ROOT / 'public/sign.html').read_bytes(),
        media_type='text/html',
        headers={
            'Cache-Control': 'no-store',
            'X-Robots-Tag': 'noindex, nofollow',
            'Permissions-Policy': 'tools=()',
        },
    )


@bm.app.get('/app')
def app_shell():
    # Mirrors the /app rewrite in firebase.json: the signed-in app shell, never cached or indexed.
    return Response(
        (ROOT / 'public/app.html').read_bytes(),
        media_type='text/html',
        headers={
            'Cache-Control': 'no-store',
            'X-Robots-Tag': 'noindex, nofollow',
            'Permissions-Policy': 'tools=()',
        },
    )


@bm.app.get('/app.html')
def app_shell_redirect():
    # Mirrors the firebase.json redirect: the file's own name is never a second address.
    return Response(status_code=301, headers={'Location': '/app'})


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
