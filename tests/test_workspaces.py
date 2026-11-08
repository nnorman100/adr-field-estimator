"""Company policy is tested through real API handlers and transactional storage."""

import asyncio
import base64
import html
import json
import re
import logging
import smtplib
import socket
from copy import deepcopy
from types import SimpleNamespace
from concurrent.futures import ThreadPoolExecutor
import time
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
import backend.main as bm
import backend.workspaces as workspaces
from tests.adr_pricing import make_documents
from backend.contracts import InspectionData, AIResult
from backend.workspaces import (
    AccessDenied,
    CompanyCreate,
    MemberUpdate,
    ProfileUpdate,
    CompanyProfile,
    StatusUpdate,
    CoordinationUpdate,
)
from backend.inspection_store import Conflict, Limited
from backend.workspace_migration import migrate
from tests.fakes import ADR_PROFILE, FakeCompanyStore, FakeStore, png
from tests.ai_spending_fakes import counting_client, confirmed_scope
from tests.test_voice_notes import note as voice_note

ID = 'ADR-INS-' + 'a' * 32
OTHER = 'ADR-INS-' + 'b' * 32
# Synthetic passwords, traced to show where they may and may not go.
TEMPORARY = 'synthetic-temporary-0001'
CHOSEN = 'synthetic-chosen-0002'


def seed(store):
    for company_id in ('adr', 'other'):
        profile = (
            {
                **ADR_PROFILE,
                'name': 'Other Company',
                'license': '123456',
                'signoff': 'Other Estimator',
                'water_heater_notice': '',
            }
            if company_id == 'other'
            else deepcopy(ADR_PROFILE)
        )
        store.db.records['_companies/' + company_id] = dict(
            company_id=company_id,
            profile=profile,
            version=1,
            status='active',
            owner_uid='owner' if company_id == 'adr' else 'other-owner',
            region='CA',
            created_at='2026',
            updated_at='2026',
        )
    for uid, role, cid in [
        ('owner', 'owner', 'adr'),
        ('estimator', 'estimator', 'adr'),
        ('estimator2', 'estimator', 'adr'),
        ('office', 'office', 'adr'),
        ('other-owner', 'owner', 'other'),
    ]:
        store.db.records['_memberships/' + uid] = dict(
            uid=uid,
            email=uid + '@example.invalid',
            company_id=cid,
            role=role,
            status='active',
            version=1,
            updated_at='2026',
        )
    store.db.records['_platform_admins/admin'] = {'active': True}
    store.db.records['_platform_admins/owner'] = {'active': True}
    return store


def data(address='Test property'):
    return InspectionData(
        address=address,
        year_built=2000,
        rooms=[dict(name='Bathroom', category=1, finished_sf=10)],
        air_movers=3,
        dehumidifiers=1,
        scope_confirmed=True,
    ).model_dump(mode='json')


def identity(uid):
    return dict(
        uid=uid,
        email=uid + '@example.invalid',
        email_verified=True,
        firebase={'sign_in_provider': 'google.com'},
    )


@pytest.fixture
def store():
    return seed(FakeCompanyStore())


@pytest.fixture
def api(store, monkeypatch):
    current = {'uid': 'owner'}
    monkeypatch.setattr(bm, 'WORKSPACES_ENABLED', True)
    monkeypatch.setattr(bm, 'get_job_store', lambda: store)
    for endpoint in (bm.current_staff, bm.current_identity, bm.account_identity):
        bm.app.dependency_overrides[endpoint] = lambda: identity(current['uid'])
    # Depends captured the original function before the module attribute was patched.
    for route in bm.app.routes:
        if hasattr(route, 'dependant'):
            for dep in route.dependant.dependencies:
                if getattr(dep.call, '__name__', '') == 'get_job_store':
                    bm.app.dependency_overrides[dep.call] = lambda: store

    monkeypatch.setattr(bm, 'generate', confirmed_scope)
    monkeypatch.setattr(bm, 'get_ai_client', counting_client)
    with TestClient(
        bm.app, headers={'X-ADR-Workspace-Protocol': '1', 'Authorization': 'Bearer synthetic'}
    ) as client:
        yield client, current, store
    bm.app.dependency_overrides.clear()


def seed_jobs(store, count, orphaned):
    """Signed company jobs whose inspection or authorization source is missing when orphaned(i)."""
    kept = {'inspections': set(), 'authorizations': set()}
    for i in range(count):
        stamp = f'2026-10-06T19:{i // 60:02}:{i % 60:02}Z'
        job_id = 'ADR-INS-' + f'{i:032x}'
        auth_id = f'ADR-AUTH-{i:06}'
        store.db.records['_workspace_jobs/' + job_id] = dict(
            job_id=job_id,
            company_id='adr',
            accessible_estimator_uids=['estimator'],
            kind='inspection',
            auth_exists=True,
            auth_id=auth_id,
            updated_at=stamp,
            signed_at=stamp,
        )
        store.db.records['_workspace_authorizations/' + auth_id] = dict(
            job_id=job_id, company_id='adr'
        )
        if orphaned(i):
            continue
        store.db.records['inspections/' + job_id] = dict(
            inspection_id=job_id, owner_uid='estimator', updated_at=stamp
        )
        store.db.records['authorizations/' + auth_id] = dict(
            auth_id=auth_id, owner_uid='estimator', created_at=stamp
        )
        kept['inspections'].add(job_id)
        kept['authorizations'].add(auth_id)
    return kept


def verify_with(monkeypatch, enabled, changes):
    monkeypatch.setattr(bm, 'WORKSPACES_ENABLED', enabled)
    monkeypatch.setattr(bm.firebase_admin, 'get_app', lambda name: object())
    monkeypatch.setattr(
        bm.firebase_auth,
        'verify_id_token',
        lambda *args, **kwargs: {**identity('owner'), **changes},
    )
    return asyncio.run(bm.verify_identity('normal-client-token'))


@pytest.fixture
def mail(api, monkeypatch):
    """Real send_invitation against fake Resend and fake Firebase Admin; records every Firestore write."""
    from tests import fakes

    sent = []
    writes = []
    accounts = fakes.FakeAuth()

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self, size):
            return b'{"id":"message"}'

    monkeypatch.setenv('RESEND_API_KEY', 'test-key')
    monkeypatch.setenv('INVITATION_FROM', 'ADR <invite@example.invalid>')
    monkeypatch.setattr(
        workspaces.urllib.request,
        'urlopen',
        lambda request, timeout: sent.append(json.loads(request.data)) or Response(),
    )
    monkeypatch.setattr(workspaces, 'firebase_auth', accounts)
    monkeypatch.setattr(workspaces.firebase_admin, 'get_app', lambda name: object())
    for cls, name in ((fakes.Tx, 'set'), (fakes.Ref, 'create')):

        def logged(self, *args, _original=getattr(cls, name), **kwargs):
            writes.append(json.dumps(args, default=str))
            return _original(self, *args, **kwargs)

        monkeypatch.setattr(cls, name, logged)
    client, current, store = api
    return client, current, store, accounts, sent, writes


def coordinate_customer(client, current, name):
    current['uid'] = 'office'
    job = client.get('/api/jobs/' + ID + '/coordination').json()
    request = {'expected_version': job['version'], 'customer_name': name}
    assert client.put('/api/jobs/' + ID + '/coordination', json=request).status_code == 200
    current['uid'] = 'estimator'


@pytest.fixture
def smtp(mail, monkeypatch):
    """Real send_invitation over the SMTP transport against a fake SMTP server; never a real account."""
    client, current, store, accounts, sent, writes = mail
    monkeypatch.setenv('INVITATION_TRANSPORT', 'smtp')
    monkeypatch.setenv('INVITATION_SMTP_USERNAME', 'sender@example.invalid')
    monkeypatch.setenv('INVITATION_SMTP_PASSWORD', 'placeholder-app-password')
    connections, plan, sleeps = [], [], []

    class FakeSMTP:
        def __init__(self, host, port, timeout):
            self.steps = []
            self.failure = plan.pop(0) if plan else None
            connections.append(dict(host=host, port=port, timeout=timeout, server=self))
            self.fail('connect')

        def fail(self, stage):
            self.steps.append(stage)
            if self.failure and self.failure[0] == stage:
                raise self.failure[1]

        def starttls(self, context):
            self.context = context
            self.fail('starttls')

        def login(self, username, password):
            self.credentials = (username, password)
            self.fail('login')

        def send_message(self, message):
            self.message = message
            self.fail('send')

        def close(self):
            self.steps.append('close')

    monkeypatch.setattr(workspaces.smtplib, 'SMTP', FakeSMTP)
    monkeypatch.setattr(workspaces.time, 'sleep', sleeps.append)
    return client, store, accounts, sent, writes, connections, plan, sleeps


def direct_invite():
    return dict(
        invitation_id='a' * 32, send_attempt='b' * 32, email='new@example.invalid', role='office'
    )


def message_parts(message):
    """The text and HTML bodies, in order, wherever the inline logo nests them."""
    return [part.get_content() for part in message.walk() if part.get_content_maintype() == 'text']


def branded(role='office', name='Kern Water Pros', logo=''):
    invite = {**direct_invite(), 'role': role}
    return invite, {'profile': {'name': name, 'logo_data_url': logo}}


PHOTO = 'd' * 32
SIGNED = 'ADR-AUTH-support123456'


def support_events(store):
    return [
        v
        for k, v in store.db.records.items()
        if k.startswith('_admin_events/') and v['action'].startswith('support_')
    ]


def signed_job(client, current, store):
    """An ADR estimator's signed job with one photo, plus customer coordination text."""
    current['uid'] = 'estimator'
    assert (
        client.post('/api/inspections', json={'inspection_id': ID, 'data': data()}).status_code
        == 200
    )
    store.add_photo(
        'estimator',
        ID,
        dict(
            photo_id=PHOTO,
            expected_revision=1,
            room='Bathroom',
            captured_at='2026-10-14T12:00:00Z',
            data_url=png(),
        ),
    )
    # A recorded reading keeps the audit from waiting on photo recognition.
    reading = dict(
        meter_detected=True, meter_type='Moisture meter', value='12', classification='', notes=''
    )
    store.set_ocr('estimator', ID, PHOTO, reading)
    current['uid'] = 'office'
    job = client.get('/api/jobs/' + ID + '/coordination').json()
    assert (
        client.put(
            '/api/jobs/' + ID + '/coordination',
            json={
                'expected_version': job['version'],
                'customer_name': 'Synthetic Customer Name',
                'customer_phone': '555-0100',
                'customer_email': 'customer@example.invalid',
            },
        ).status_code
        == 200
    )
    current['uid'] = 'estimator'
    # Audited after coordination, so the documents name the customer.
    record = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 3}).json()
    payload = dict(
        inspection_id=ID,
        expected_revision=3,
        auth_id=SIGNED,
        proposal_hash=record['audit']['proposal_hash'],
        signature_png=png(),
        documents_confirmed=True,
    )
    assert client.post('/api/authorize', json=payload).status_code == 200
    store.create_inspection('other-owner', OTHER, data('Other company job'))


QUANTITY_NOTE = dict(label='Labor hours', measured=8, entered=6, reason='Synthetic override reason')


def with_note(documents):
    documents['quantity_notes'] = [QUANTITY_NOTE]


OVERRIDES = {'labor_hours': dict(measured='8', entered='6', reason='Synthetic entered reason')}


# Superadmin-only tools: every caller who is not an active superadmin is refused.
NON_SUPERADMINS = [
    'owner',  # ADR owner; superadmin_gate removes this fixture's superadmin record
    'estimator',
    'office',
    'outsider',  # verified sign-in, no membership
    'disabled',  # disabled ADR estimator
    'suspended',  # owner of a suspended company
    'inactive',  # superadmin record set inactive
    'removed',  # former ADR office member whose superadmin record was deleted
]


def superadmin_gate(client, current, store):
    """Adds the non-superadmin callers and the records each superadmin tool targets."""
    signed_job(client, current, store)
    records = store.db.records
    del records['_platform_admins/owner']
    records['_companies/paused'] = {
        **deepcopy(records['_companies/other']),
        'company_id': 'paused',
        'status': 'suspended',
        'owner_uid': 'suspended',
    }
    for uid, role, company_id, status in [
        ('disabled', 'estimator', 'adr', 'disabled'),
        ('suspended', 'owner', 'paused', 'active'),
        ('removed', 'office', 'adr', 'active'),
        ('other-estimator', 'estimator', 'other', 'active'),
        ('other-staff', 'office', 'other', 'disabled'),
    ]:
        records['_memberships/' + uid] = dict(
            uid=uid,
            email=uid + '@example.invalid',
            company_id=company_id,
            role=role,
            status=status,
            version=1,
            updated_at='2026',
        )
    records['_platform_admins/inactive'] = {'active': False}
    records['_platform_admins/removed'] = {'active': True}
    del records['_platform_admins/removed']
    w = store.workspaces
    return dict(
        staff=w.invite('other-owner', 'other', 'other-new@example.invalid', 'office'),
        owner=w.invite('admin', 'other', 'other-next-owner@example.invalid', 'owner'),
        adr_owner=w.invite('admin', 'adr', 'adr-next-owner@example.invalid', 'owner'),
    )


def superadmin_tools(invites):
    """(name, method, path, body, superadmin status), ordered so an active superadmin succeeds."""
    support = '/api/admin/companies/'
    other = '/api/companies/other'
    staff = other + '/invitations/' + invites['staff']['invitation_id']
    owner = other + '/invitations/' + invites['owner']['invitation_id']
    adr_owner = '/api/companies/adr/invitations/' + invites['adr_owner']['invitation_id']
    return [
        ('list companies', 'GET', '/api/admin/companies', None, 200),
        ('company metadata', 'GET', other, None, 200),
        ('team metadata', 'GET', other + '/team', None, 200),
        ('invitation metadata', 'GET', other + '/invitations', None, 200),
        ('support jobs', 'GET', support + 'adr/jobs', None, 200),
        (
            'support insight (rollout off)',
            'GET',
            support + 'adr/jobs/' + ID + '/insight',
            None,
            404,
        ),
        ('support AI usage (rollout off)', 'GET', support + 'adr/ai-usage', None, 404),
        ('support drying watch (rollout off)', 'GET', support + 'adr/drying-watch', None, 404),
        ('support prices (rollout off)', 'GET', support + 'adr/prices', None, 404),
        ('support price versions (rollout off)', 'GET', support + 'adr/prices/versions', None, 404),
        (
            'support price version (rollout off)',
            'GET',
            support + 'adr/prices/versions/seed',
            None,
            404,
        ),
        ('support price export (rollout off)', 'GET', support + 'adr/prices/export', None, 404),
        ('support price history (rollout off)', 'GET', support + 'adr/prices/history', None, 404),
        ('support documents', 'GET', support + 'adr/authorizations', None, 200),
        ('support job', 'GET', support + 'adr/jobs/' + ID, None, 200),
        ('support photo', 'GET', support + 'adr/jobs/' + ID + '/photos/' + PHOTO, None, 200),
        ('support document', 'GET', support + 'adr/authorizations/' + SIGNED, None, 200),
        (
            'support evidence',
            'GET',
            support + 'adr/authorizations/' + SIGNED + '/evidence/signature',
            None,
            200,
        ),
        ('support other jobs', 'GET', support + 'other/jobs', None, 200),
        ('support other job', 'GET', support + 'other/jobs/' + OTHER, None, 200),
        ('support other documents', 'GET', support + 'other/authorizations', None, 200),
        ('support archived jobs', 'GET', support + 'other/archived-jobs', None, 200),
        (
            'support archive draft',
            'POST',
            support + 'other/jobs/' + OTHER + '/archive',
            {'expected_version': 1},
            200,
        ),
        (
            'support restore draft',
            'POST',
            support + 'other/jobs/' + OTHER + '/restore',
            {'expected_version': 2},
            200,
        ),
        (
            'switch member role',
            'PUT',
            other + '/team/other-estimator',
            {'expected_version': 1, 'role': 'office', 'status': 'active'},
            200,
        ),
        (
            're-enable member',
            'PUT',
            other + '/team/other-staff',
            {'expected_version': 1, 'role': 'office', 'status': 'active'},
            200,
        ),
        ('resend staff invitation', 'POST', staff + '/resend', None, 200),
        ('cancel staff invitation', 'POST', staff + '/cancel', None, 200),
        ('resend owner invitation', 'POST', owner + '/resend', None, 200),
        ('cancel owner invitation', 'POST', owner + '/cancel', None, 200),
        (
            'replace owner',
            'POST',
            other + '/invitations',
            {'email': 'other-replacement@example.invalid', 'role': 'owner'},
            200,
        ),
        (
            'replace own company owner',
            'POST',
            '/api/companies/adr/invitations',
            {'email': 'adr-replacement@example.invalid', 'role': 'owner'},
            200,
        ),
        ('cancel own company owner invitation', 'POST', adr_owner + '/cancel', None, 200),
        (
            'suspend own company',
            'PUT',
            support + 'adr/status',
            {'expected_version': 1, 'status': 'suspended'},
            200,
        ),
        (
            'reactivate suspended company',
            'PUT',
            support + 'paused/status',
            {'expected_version': 1, 'status': 'active'},
            200,
        ),
        (
            'create owner login',
            'POST',
            support + 'paused/owner-login',
            {'email': 'paused-owner@example.invalid', 'password': TEMPORARY, 'expected_version': 2},
            200,
        ),
        (
            'suspend company',
            'PUT',
            support + 'other/status',
            {'expected_version': 1, 'status': 'suspended'},
            200,
        ),
        (
            'status of unknown company',
            'PUT',
            support + 'missing/status',
            {'expected_version': 1, 'status': 'suspended'},
            404,
        ),
        (
            'create company',
            'POST',
            '/api/admin/companies',
            {'name': 'Forged Restoration', 'owner_email': 'forged-owner@example.invalid'},
            200,
        ),
        (
            'create company with owner login',
            'POST',
            '/api/admin/companies',
            {
                'name': 'Login Restoration',
                'owner_email': 'login-owner@example.invalid',
                'owner_password': TEMPORARY,
            },
            200,
        ),
    ]


def unrestricted(store):
    # A refused caller's own rate-limit counter (_limits) is the only record a request may touch.
    return {k: deepcopy(v) for k, v in store.db.records.items() if not k.startswith('_limits/')}


def assert_refused(client, tools, headers=None, expected=(403,)):
    for name, method, path, body, _ in tools:
        response = client.request(method, path, json=body, headers=headers)
        assert response.status_code in expected, (name, response.status_code, response.text)
        assert set(response.json()) == {'detail'}, name


def revoke_admin(store):
    store.db.records['_platform_admins/admin']['active'] = False


def revoked(records):
    # The revocation itself is the one expected change.
    return {**records, '_platform_admins/admin': {'active': False}}


FORGED_CLAIMS = dict(
    superadmin=True,
    admin=True,
    role='superadmin',
    capabilities=['team_manage', 'profile_manage', 'superadmin'],
    platform_admin=True,
)
FORGED_HEADERS = {
    'X-ADR-Superadmin': 'true',
    'X-ADR-Role': 'superadmin',
    'X-ADR-Capabilities': 'superadmin,team_manage',
}


# Ownership transfer: superadmin replaces the owner; the switch is atomic on acceptance.

DRAFT = 'ADR-INS-' + 'c' * 32


def transfer_setup(client, current, store):
    """A plain owner (no superadmin record), the owner's draft, an estimator's signed job and
    a staff invitation the owner sent; returns that invitation."""
    signed_job(client, current, store)
    del store.db.records['_platform_admins/owner']
    current['uid'] = 'owner'
    assert (
        client.post(
            '/api/inspections', json={'inspection_id': DRAFT, 'data': data('Owner draft')}
        ).status_code
        == 200
    )
    staff = client.post(
        '/api/companies/adr/invitations', json={'email': 'staff@example.invalid', 'role': 'office'}
    )
    assert staff.status_code == 200
    return staff.json()


def owner_routes(store, staff_invitation):
    """(name, method, path, body) for every owner route, with bodies valid for the current records."""
    records = store.db.records
    company = records['_companies/adr']
    job = records['_workspace_jobs/' + ID]
    evidence = '/api/authorizations/' + SIGNED
    return [
        ('company', 'GET', '/api/companies/adr', None),
        (
            'profile',
            'PUT',
            '/api/companies/adr',
            {'expected_version': company['version'], 'profile': company['profile']},
        ),
        ('team', 'GET', '/api/companies/adr/team', None),
        (
            'member',
            'PUT',
            '/api/companies/adr/team/estimator2',
            {
                'expected_version': records['_memberships/estimator2']['version'],
                'role': 'estimator',
                'status': 'active',
            },
        ),
        ('invitations', 'GET', '/api/companies/adr/invitations', None),
        (
            'invite',
            'POST',
            '/api/companies/adr/invitations',
            {'email': 'next-staff@example.invalid', 'role': 'estimator'},
        ),
        (
            'cancel invitation',
            'POST',
            '/api/companies/adr/invitations/' + staff_invitation['invitation_id'] + '/cancel',
            None,
        ),
        ('jobs', 'GET', '/api/inspections', None),
        ('job', 'GET', '/api/inspections/' + ID, None),
        ('draft', 'GET', '/api/inspections/' + DRAFT, None),
        ('photo', 'GET', '/api/inspections/' + ID + '/photos/' + PHOTO, None),
        ('documents', 'GET', '/api/authorizations', None),
        ('document', 'GET', evidence, None),
        ('evidence', 'GET', evidence + '/evidence/signature', None),
        ('coordination', 'GET', '/api/jobs/' + ID + '/coordination', None),
        (
            'coordinate',
            'PUT',
            '/api/jobs/' + ID + '/coordination',
            {
                'expected_version': job['version'],
                **{
                    k: job[k]
                    for k in ('customer_name', 'customer_phone', 'customer_email', 'office_notes')
                },
            },
        ),
    ]


def active_owners(store, company_id='adr'):
    return sorted(
        m['uid']
        for k, m in store.db.records.items()
        if k.startswith('_memberships/')
        and m['company_id'] == company_id
        and m['role'] == 'owner'
        and m['status'] == 'active'
    )


def company_records(store):
    """Customer jobs, drafts, signed agreements and their company sidecars."""
    prefixes = ('inspections/', 'authorizations/', '_workspace_jobs/', '_workspace_authorizations/')
    return {k: deepcopy(v) for k, v in store.db.records.items() if k.startswith(prefixes)}


def events(store, action):
    return [
        v
        for k, v in store.db.records.items()
        if k.startswith('_admin_events/') and v['action'] == action
    ]


# Permission changes during a Live walkthrough, at the production 20-second recheck.


class LiveHarness:
    """Real identity, membership and job checks around a fake Vertex session.

    Each heartbeat parks until the test ticks it; a tick moves the virtual clock forward by the
    full LIVE_RECHECK_SECONDS. The log orders Vertex calls against the first refused check."""

    def __init__(self, store, monkeypatch):
        self.store = store
        self.now = 1_000_000.0
        self.parked = 0
        self.ticks = 0
        self.revoked = set()
        self.log = []
        self.connects = 0
        harness = self

        async def sleep(seconds):
            if seconds != bm.LIVE_RECHECK_SECONDS:
                return await asyncio.sleep(seconds)
            harness.parked += 1
            while harness.ticks < harness.parked:
                await asyncio.sleep(0.002)
            harness.now += seconds

        def verify_id_token(token, app=None, check_revoked=False):
            if check_revoked and token in harness.revoked:
                raise ValueError('Synthetic revoked account')
            return {**identity(token), 'exp': harness.now + 3000}

        class Session:
            async def send_client_content(self, **kwargs):
                pass

            async def send_realtime_input(self, **kwargs):
                harness.log.append('vertex ' + next(iter(kwargs)))

            async def receive(self):
                yield SimpleNamespace(
                    server_content=None,
                    session_resumption_update=SimpleNamespace(
                        new_handle='synthetic-private', resumable=True
                    ),
                )
                await asyncio.Event().wait()

        from contextlib import asynccontextmanager

        @asynccontextmanager
        async def connect(**kwargs):
            harness.connects += 1
            harness.log.append('vertex connect')
            yield Session()

        async def close():
            harness.log.append('vertex closed')

        def refused(call):
            async def wrapped(*args, **kwargs):
                try:
                    return await call(*args, **kwargs)
                except bm.HTTPException as error:
                    if error.status_code in (401, 403, 404):
                        harness.log.append('refused')
                    raise

            return wrapped

        clock = asyncio.__dict__ | {'sleep': sleep}
        monkeypatch.setattr(bm, 'asyncio', SimpleNamespace(**clock))
        monkeypatch.setattr(
            bm, 'time', SimpleNamespace(time=lambda: harness.now, monotonic=time.monotonic)
        )
        monkeypatch.setattr(bm, 'LIVE_RECHECK_SECONDS', 20)
        monkeypatch.setattr(bm, 'REVOCATION_CACHE_SECONDS', 45)
        monkeypatch.setattr(bm, 'revocation_checked', type(bm.revocation_checked)())
        monkeypatch.setattr(bm.firebase_admin, 'get_app', lambda name: object())
        monkeypatch.setattr(bm.firebase_auth, 'verify_id_token', verify_id_token)
        monkeypatch.setattr(bm, 'WORKSPACES_ENABLED', True)
        monkeypatch.setattr(bm, 'get_job_store', lambda: store)
        monkeypatch.setattr(bm, 'verify_staff', refused(bm.verify_staff))
        monkeypatch.setattr(bm, 'stored', refused(bm.stored))
        monkeypatch.setattr(
            bm.genai,
            'Client',
            lambda **kwargs: SimpleNamespace(
                aio=SimpleNamespace(live=SimpleNamespace(connect=connect), aclose=close)
            ),
        )

    def until(self, condition, what):
        deadline = time.monotonic() + 5
        while not condition():
            assert time.monotonic() < deadline, what
            time.sleep(0.002)

    def tick(self):
        """Let the parked heartbeat run once, then wait until it parks again or the session ends."""
        self.ticks += 1
        self.until(
            lambda: self.parked > self.ticks or 'vertex closed' in self.log, 'heartbeat finished'
        )

    def start(self, socket, uid, resume=False):
        socket.send_json(
            {
                'type': 'authenticate',
                'token': uid,
                'inspection_id': ID,
                'protocol_version': 2,
                'workspace_protocol_version': 1,
                'capture_id': 'f' * 32,
                'resume': resume,
            }
        )


LIVE_LOSSES = [
    'member disabled',
    'role changed to office',
    'job reassigned away',
    'company suspended',
    'membership removed',
    'account revoked',
    'owner replaced',
    'superadmin owner replaced',
]


def live_participant(store, change):
    """Creates the job and returns who runs Live for this change."""
    if 'owner' in change:
        if change == 'owner replaced':
            del store.db.records['_platform_admins/owner']
        store.create_inspection('owner', ID, data())
        return 'owner'
    store.create_inspection('estimator', ID, data())
    if change == 'job reassigned away':
        store.workspaces.coordination(
            'owner', ID, CoordinationUpdate(expected_version=1, assigned_estimator_uid='estimator2')
        )
        return 'estimator2'
    return 'estimator'


def apply_loss(harness, change):
    w = harness.store.workspaces
    if change == 'member disabled':
        w.update_member(
            'owner',
            'adr',
            'estimator',
            MemberUpdate(expected_version=1, role='estimator', status='disabled'),
        )
    elif change == 'role changed to office':
        w.update_member(
            'owner',
            'adr',
            'estimator',
            MemberUpdate(expected_version=1, role='office', status='active'),
        )
    elif change == 'job reassigned away':
        w.coordination('owner', ID, CoordinationUpdate(expected_version=2))
    elif change == 'company suspended':
        w.update_company('admin', 'adr', StatusUpdate(expected_version=1, status='suspended'))
    elif change == 'membership removed':
        del harness.store.db.records['_memberships/estimator']
    elif change == 'account revoked':
        harness.revoked.add('estimator')
    else:
        # The owner is live while a superadmin replacement is accepted.
        invitation = w.invite('admin', 'adr', 'successor@example.invalid', 'owner')
        w.accept(identity('successor'), invitation['invitation_id'])


LIVE_KEEPS = {
    'same role saved again': lambda w: w.update_member(
        'owner',
        'adr',
        'estimator',
        MemberUpdate(expected_version=1, role='estimator', status='active'),
    ),
    'job also assigned to another estimator': lambda w: w.coordination(
        'owner', ID, CoordinationUpdate(expected_version=1, assigned_estimator_uid='estimator2')
    ),
    'company profile changed': lambda w: w.update_company(
        'owner',
        'adr',
        ProfileUpdate(
            expected_version=1, profile=CompanyProfile(**{**ADR_PROFILE, 'phone': '555-0101'})
        ),
    ),
    'another member disabled': lambda w: w.update_member(
        'owner', 'adr', 'office', MemberUpdate(expected_version=1, role='office', status='disabled')
    ),
    'owner replaced': lambda w: w.accept(
        identity('successor'),
        w.invite('admin', 'adr', 'successor@example.invalid', 'owner')['invitation_id'],
    ),
}


# Owner logins with a temporary password: the superadmin alternative to an owner invitation.
def owner_events(store, action='owner_login_created'):
    return [
        v
        for k, v in store.db.records.items()
        if k.startswith('_admin_events/') and v['action'] == action
    ]


def create_owner_login(client, email='new-owner@example.invalid', company='other', **changes):
    body = {'email': email, 'password': TEMPORARY, 'expected_version': 1, **changes}
    return client.post('/api/admin/companies/' + company + '/owner-login', json=body)


REFUSED_LOGINS = {
    'member email': ('estimator@example.invalid', {}, 409, 'already has company access'),
    'Google account': ('google-owner@example.invalid', {}, 409, 'signs in with Google'),
    'Google and password': ('both-owner@example.invalid', {}, 409, 'signs in with Google'),
    'disabled account': ('disabled-owner@example.invalid', {}, 409, 'disabled'),
    'short password': ('new-owner@example.invalid', {'password': 'x' * 11}, 400, '12 to 128'),
    'long password': ('new-owner@example.invalid', {'password': 'x' * 129}, 400, '12 to 128'),
    'invalid email': ('not-an-email', {}, 400, 'valid email'),
    'stale version': ('new-owner@example.invalid', {'expected_version': 2}, 409, 'Reload'),
    'suspended company': ('new-owner@example.invalid', {'company': 'paused'}, 403, 'active'),
    'unknown company': ('new-owner@example.invalid', {'company': 'missing'}, 404, 'not found'),
}


def locked_identity(accounts, uid):
    """Claims as Firebase would issue them now: the account's current custom claims at top level."""
    user = accounts.get_user(uid)
    return {
        **identity(uid),
        'firebase': {'sign_in_provider': 'password'},
        **(user.custom_claims or {}),
    }


def real_verification(monkeypatch, current, accounts):
    for endpoint in (bm.current_staff, bm.current_identity, bm.account_identity):
        bm.app.dependency_overrides.pop(endpoint)
    monkeypatch.setattr(bm, 'revocation_checked', type(bm.revocation_checked)())
    monkeypatch.setattr(bm.firebase_admin, 'get_app', lambda name: object())
    monkeypatch.setattr(
        bm.firebase_auth,
        'verify_id_token',
        lambda *args, **kwargs: locked_identity(accounts, current['uid']),
    )


def member_routes():
    """Every authenticated HTTP route except the password change itself."""
    for route in bm.app.routes:
        path = getattr(route, 'path', '')
        if (
            not path.startswith('/api/')
            or not getattr(route, 'methods', None)
            or path in ('/api/health', '/api/sign', '/api/documents', '/api/account/password')
            or path.startswith(('/api/sign/', '/api/documents/'))
        ):
            continue
        for method in route.methods - {'HEAD'}:
            yield method, re.sub(r'\{[^}]+\}', 'x', path)


COPY = 'ADR-INS-' + 'c' * 32


def copy_request(client, auth_id=SIGNED, inspection_id=COPY):
    return client.post(
        '/api/authorizations/' + auth_id + '/copy', json={'inspection_id': inspection_id}
    )
