"""Real Firestore transactions for quotas, Live leases and signing, run against the local emulator.

Skipped unless FIRESTORE_EMULATOR_HOST is set. Run locally from the repository root:
    npx firebase-tools emulators:exec --only firestore --project demo-adr-emulator \
        "python -m pytest tests/test_firestore_emulator.py -q -p no:cacheprovider"
Evidence objects use the in-memory bucket; only Firestore is real here.

The emulator resolves lock conflicts by timeout rather than production's wound-wait, so
concurrent transactions can exhaust their retries there ("Transaction lock timeout"; see
https://firebase.google.com/docs/emulator-suite/connect_firestore#transactions). Concurrent
tests therefore assert the safety properties (no lost update, nothing past a limit, one
receipt), accept contention aborts, then check the settled state with a sequential call.
"""

import base64
import json
import os
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from types import SimpleNamespace
import pytest

EMULATOR = os.getenv('FIRESTORE_EMULATOR_HOST')
# The CI emulator job sets this so a missing emulator fails instead of skipping.
if not EMULATOR and os.getenv('ADR_FIRESTORE_EMULATOR_REQUIRED'):
    raise RuntimeError('FIRESTORE_EMULATOR_HOST is required for the Firestore emulator tests.')
pytestmark = pytest.mark.skipif(
    not EMULATOR,
    reason='FIRESTORE_EMULATOR_HOST is not set; start the Firestore emulator to run these tests.',
)
# The demo- prefix keeps the client offline: no credentials, no real project.
PROJECT = 'demo-adr-emulator'

from google.api_core.exceptions import Aborted
from google.auth.credentials import AnonymousCredentials
from google.cloud import firestore
import backend.inspection_store as inspection_store
from backend.claims import make_documents
from backend.company_store import CompanyInspectionStore
from backend.contracts import AIResult, InspectionData
from backend.inspection_store import Conflict, InspectionStore, Limited
from backend.workspaces import ADR_PROFILE, AccessDenied, MemberUpdate, WorkspaceStore
from tests.fakes import Bucket, png
from tests.test_backend import ID, data, sign_payload


def client():
    return firestore.Client(project=PROJECT, credentials=AnonymousCredentials())


@pytest.fixture(autouse=True)
def empty_database():
    assert PROJECT.startswith('demo-')
    request = urllib.request.Request(
        f'http://{EMULATOR}/emulator/v1/projects/{PROJECT}/databases/(default)/documents',
        method='DELETE',
    )
    urllib.request.urlopen(request, timeout=10).close()


@pytest.fixture
def clock(monkeypatch):
    moment = [1_000_000.0]
    monkeypatch.setattr(inspection_store, 'time', SimpleNamespace(time=lambda: moment[0]))
    return moment


def instances(kind=InspectionStore, count=2):
    """Separate clients stand in for separate Cloud Run instances sharing one database."""
    bucket = Bucket()
    return [kind(client(), bucket) for _ in range(count)]


def concurrently(calls):
    with ThreadPoolExecutor(max_workers=len(calls)) as pool:
        futures = [pool.submit(call) for call in calls]
        return [future.exception() or future.result() for future in futures]


def contended(error):
    """Emulator lock timeouts surface as Aborted, or as exhausted transaction retries."""
    return isinstance(error, Aborted) or (
        type(error) is ValueError and str(error).startswith('Failed to commit transaction')
    )


def outcomes(results, refused=Limited):
    """Return the successes, asserting every failure is a refusal or emulator contention."""
    unexpected = [
        r
        for r in results
        if isinstance(r, Exception) and not isinstance(r, refused) and not contended(r)
    ]
    assert not unexpected, unexpected
    return [r for r in results if not isinstance(r, Exception)]


def stored(db, path):
    snapshot = db.document(path).get()
    return snapshot.to_dict() if snapshot.exists else None


def counted(db, action):
    return (stored(db, '_limits/owner') or {}).get(action, {}).get('count', 0)


def test_minute_quota_admits_exactly_the_limit_under_concurrency():
    stores = instances()
    admitted = len(
        outcomes(
            concurrently([lambda i=i: stores[i % 2].quota('owner', 'audit', 3) for i in range(6)])
        )
    )
    assert admitted <= 3
    assert (
        counted(stores[0].db, 'audit') == admitted
        and counted(stores[0].db, 'audit_day') == admitted
    )
    for call in range(admitted, 3):
        stores[call % 2].quota('owner', 'audit', 3)
    with pytest.raises(Limited):
        stores[0].quota('owner', 'audit', 3)
    assert counted(stores[0].db, 'audit') == 3
    stores[1].quota('other', 'audit', 3)


def test_daily_quota_admits_only_the_remaining_calls_under_concurrency(clock):
    stores = instances()
    stores[0].db.document('_limits/owner').set(
        {'live_day': {'start': clock[0], 'count': inspection_store.DAILY_LIMITS['live'] - 2}}
    )
    admitted = len(
        outcomes(concurrently([lambda i=i: stores[i % 2].quota('owner', 'live') for i in range(6)]))
    )
    assert admitted <= 2
    assert counted(stores[0].db, 'live_day') == inspection_store.DAILY_LIMITS['live'] - 2 + admitted
    for call in range(admitted, 2):
        stores[call % 2].quota('owner', 'live')
    with pytest.raises(Limited) as limited:
        stores[0].quota('owner', 'live')
    assert limited.value.retry_after > 3600
    clock[0] += 86400
    stores[1].quota('owner', 'live')
    assert counted(stores[0].db, 'live_day') == 1


def test_live_lease_contention_admits_one_holder():
    stores = instances()
    winners = outcomes(
        concurrently([lambda i=i: stores[i % 2].live_lease('owner') for i in range(6)])
    )
    assert len(winners) <= 1
    holder = winners[0] if winners else stores[0].live_lease('owner')
    assert stored(stores[0].db, '_live_sessions/owner')['id'] == holder
    with pytest.raises(Limited):
        stores[1].live_lease('owner')
    assert stores[1].live_lease('owner', holder) == holder


def test_live_lease_renewal_expiry_and_release(clock):
    first, second = instances()
    lease = first.live_lease('owner')
    clock[0] += 45
    assert second.live_lease('owner', lease) == lease
    assert stored(first.db, '_live_sessions/owner')['expires'] == clock[0] + 60
    clock[0] += 45
    with pytest.raises(Limited):
        second.live_lease('owner')
    second.live_lease('owner', 'not-the-holder', True)
    with pytest.raises(Limited):
        second.live_lease('owner')
    clock[0] += 61
    taken = second.live_lease('owner')
    assert taken != lease
    with pytest.raises(Limited):
        first.live_lease('owner', lease)
    second.live_lease('owner', taken, True)
    assert stored(first.db, '_live_sessions/owner') is None
    assert first.live_lease('other') and first.live_lease('owner')


def test_live_resume_checkpoint_follows_the_current_lease():
    first, second = instances()
    capture = 'c' * 32
    lease = first.live_lease('owner')
    with pytest.raises(Conflict):
        second.live_resume('owner', capture, ID, 'fp', 'stale', 'open')
    assert first.live_resume('owner', capture, ID, 'fp', lease, 'open') is None
    first.live_resume('owner', capture, ID, 'fp', lease, 'save', 'handle-1', True)
    second.live_resume('owner', capture, ID, 'fp', 'stale', 'save', 'forged', True)
    assert second.live_resume('owner', capture, ID, 'fp', lease, 'open') == 'handle-1'
    assert second.live_resume('owner', capture, ID, 'changed', lease, 'open') is None


def seed_company(db):
    db.document('_companies/adr').set(
        dict(
            company_id='adr',
            profile=deepcopy(ADR_PROFILE),
            version=1,
            status='active',
            owner_uid='owner',
            region='CA',
            created_at='2026',
            updated_at='2026',
        )
    )
    db.document('_memberships/owner').set(
        dict(
            uid='owner',
            email='owner@example.invalid',
            company_id='adr',
            role='owner',
            status='active',
            version=1,
            updated_at='2026',
        )
    )


def audited(store):
    if isinstance(store, CompanyInspectionStore):
        seed_company(store.db)
    record = store.create_inspection('owner', ID, data())
    identity = (
        store.workspaces.snapshot('owner') if isinstance(store, CompanyInspectionStore) else None
    )
    documents = make_documents(
        InspectionData.model_validate(record['data']),
        [],
        AIResult(summary='Confirmed', suggestions=[], unpriced_work=[]),
        identity,
    )
    return store.save_audit('owner', ID, record['revision'], documents)


@pytest.fixture(params=[InspectionStore, CompanyInspectionStore])
def signing(request):
    stores = instances(request.param)
    return stores, audited(stores[0])


def test_concurrent_signing_retries_return_one_receipt(signing):
    stores, record = signing
    payload = sign_payload(record)
    receipts = outcomes(
        concurrently([lambda i=i: stores[i % 2].authorize('owner', payload) for i in range(4)]),
        refused=(),
    )
    receipt = stores[1].authorize('owner', payload)
    assert all(r == receipt for r in receipts)
    assert [s.id for s in stores[0].db.collection('authorizations').stream()] == [
        payload['auth_id']
    ]
    assert receipt == stored(stores[0].db, 'authorizations/' + payload['auth_id'])
    assert len(stores[0].bucket.objects) == 1
    inspection = stores[0].get_inspection('owner', ID)
    assert inspection['status'] == 'signed' and inspection['authorization_id'] == payload['auth_id']


def test_signed_records_cannot_be_altered(signing):
    stores, record = signing
    payload = sign_payload(record)
    stores[0].authorize('owner', payload)
    db = stores[0].db
    before = (stored(db, 'inspections/' + ID), stored(db, 'authorizations/' + payload['auth_id']))
    changed = data()
    changed['technician_notes'] = 'Edited after signing'
    with pytest.raises(Conflict):
        stores[1].update_inspection('owner', ID, record['revision'], changed)
    with pytest.raises(Conflict):
        stores[1].save_audit('owner', ID, record['revision'], record['audit']['documents'])
    with pytest.raises(Conflict):
        stores[1].add_photo(
            'owner',
            ID,
            dict(
                expected_revision=record['revision'],
                photo_id='b' * 32,
                room='Bathroom',
                captured_at='2026-10-06T19:00:00Z',
                data_url=png(),
            ),
        )
    with pytest.raises(Conflict):
        stores[1].append_transcript('owner', ID, '[Offline voice note 12345678', 'Late note\n')
    with pytest.raises(Conflict):
        stores[1].authorize('owner', {**payload, 'auth_id': 'ADR-AUTH-second123456'})
    with pytest.raises(Conflict):
        stores[1].authorize('owner', {**payload, 'signature_png': png(blank=True)})
    after = (stored(db, 'inspections/' + ID), stored(db, 'authorizations/' + payload['auth_id']))
    assert after == before
    assert stored(db, 'authorizations/ADR-AUTH-second123456') is None
    assert len(stores[0].bucket.objects) == 1


def test_concurrent_voice_note_appends_keep_every_note_exactly_once():
    stores = instances()
    stores[0].create_inspection('owner', ID, data(technician_transcript='Live words.'))
    notes = {
        f'[Offline voice note {c * 8}': f'[Offline voice note {c * 8} · Room]\nWords {c}.\n'
        for c in 'abcd'
    }
    calls = [
        lambda marker=marker, block=block, i=i: stores[i % 2].append_transcript(
            'owner', ID, marker, block
        )
        for i, (marker, block) in enumerate(list(notes.items()) * 2)
    ]
    outcomes(concurrently(calls), refused=())
    # Contention may abort some calls; each note's retry then lands once.
    for marker, block in notes.items():
        stores[1].append_transcript('owner', ID, marker, block)
    record = stores[0].get_inspection('owner', ID)
    transcript = record['data']['technician_transcript']
    assert transcript.startswith('Live words.\n')
    assert all(transcript.count(marker) == 1 for marker in notes)
    assert record['revision'] == 1 + len(notes)


SIGNER = dict(
    signer_name='Synthetic Signer',
    signer_role='owner',
    documents_reviewed=True,
    electronic_consent=True,
    consent_version='homeowner-link-v1',
    signature_png=png(),
)
CLIENT = dict(ip_address=None, user_agent='Synthetic')


def test_signing_link_lifecycle_in_real_transactions(signing):
    from backend import signing_links

    stores, record = signing
    first, _ = signing_links.mint(
        stores[0], 'owner', ID, record['revision'], record['audit']['proposal_hash']
    )
    token, _ = signing_links.mint(
        stores[1], 'owner', ID, record['revision'], record['audit']['proposal_hash']
    )
    with pytest.raises(LookupError):
        signing_links.view(stores[0], first)
    assert signing_links.view(stores[1], token)['status'] == 'pending'
    receipt = signing_links.sign(stores[0], token, SIGNER, CLIENT)
    assert signing_links.sign(stores[1], token, SIGNER, CLIENT) == receipt
    db = stores[0].db
    link = stored(db, '_signing_links/' + signing_links.link_id(token))
    assert link['status'] == 'used' and link['auth_id'] == receipt['auth_id']
    assert stored(db, 'inspections/' + ID)['authorization_id'] == receipt['auth_id']
    assert signing_links.view(stores[1], token)['receipt']['auth_id'] == receipt['auth_id']
    assert signing_links.revoke(stores[0], 'owner', ID) == 'used'


def test_link_and_device_signatures_race_to_one_agreement(signing):
    from backend import signing_links

    stores, record = signing
    token, _ = signing_links.mint(
        stores[0], 'owner', ID, record['revision'], record['audit']['proposal_hash']
    )
    device = sign_payload(record)
    results = concurrently(
        [
            lambda: signing_links.sign(stores[0], token, SIGNER, CLIENT),
            lambda: stores[1].authorize('owner', device),
        ]
    )
    outcomes(results, refused=(Conflict, LookupError))
    db = stores[0].db
    inspection = stored(db, 'inspections/' + ID)
    agreements = [s.id for s in db.collection('authorizations').stream()]
    if inspection['status'] == 'signed':
        assert agreements == [inspection['authorization_id']]
    else:
        assert agreements == []
    link = stored(db, '_signing_links/' + signing_links.link_id(token))
    assert (link['status'] == 'used') == (
        inspection.get('authorization_id', '').startswith('ADR-AUTH-link-')
    )


def test_link_signature_and_edit_race_never_both_land(signing):
    from backend import signing_links

    stores, record = signing
    token, _ = signing_links.mint(
        stores[0], 'owner', ID, record['revision'], record['audit']['proposal_hash']
    )
    changed = data()
    changed['technician_notes'] = 'Edited while the homeowner signs'
    results = concurrently(
        [
            lambda: signing_links.sign(stores[0], token, SIGNER, CLIENT),
            lambda: stores[1].update_inspection('owner', ID, record['revision'], changed),
        ]
    )
    outcomes(results, refused=(Conflict, LookupError))
    inspection = stored(stores[0].db, 'inspections/' + ID)
    if inspection['status'] == 'signed':
        assert inspection['data'] == record['data']
        assert inspection['revision'] == record['revision']
    else:
        assert not list(stores[0].db.collection('authorizations').stream())
        if inspection['revision'] != record['revision']:
            with pytest.raises(Conflict):
                signing_links.view(stores[0], token)


@pytest.mark.parametrize('kind', ['inspection', 'authorization'])
def test_company_job_pages_skip_sidecars_whose_source_is_missing(kind):
    """Real queries read past orphan sidecars across batches and still page by 100."""
    store = CompanyInspectionStore(client(), Bucket())
    seed_company(store.db)
    kept = set()
    for i in range(205):
        writes = store.db.batch()
        stamp = f'2026-10-06T19:{i // 60:02}:{i % 60:02}Z'
        job_id = 'ADR-INS-' + f'{i:032x}'
        auth_id = f'ADR-AUTH-{i:06}'
        writes.set(
            store.db.document('_workspace_jobs/' + job_id),
            dict(
                job_id=job_id,
                company_id='adr',
                accessible_estimator_uids=['owner'],
                kind='inspection',
                auth_exists=True,
                auth_id=auth_id,
                updated_at=stamp,
                signed_at=stamp,
            ),
        )
        writes.set(
            store.db.document('_workspace_authorizations/' + auth_id),
            dict(job_id=job_id, company_id='adr'),
        )
        if i % 3 == 0 or i > 180:
            writes.commit()
            continue
        writes.set(
            store.db.document('inspections/' + job_id),
            dict(inspection_id=job_id, owner_uid='owner', updated_at=stamp),
        )
        writes.set(
            store.db.document('authorizations/' + auth_id),
            dict(auth_id=auth_id, owner_uid='owner', created_at=stamp),
        )
        writes.commit()
        kept.add(job_id if kind == 'inspection' else auth_id)
    page = getattr(store, kind + '_page')
    field = 'inspection_id' if kind == 'inspection' else 'auth_id'
    rows, cursor = page('owner')
    assert len(rows) == 100 and cursor
    seen = [r[field] for r in rows]
    rows, cursor = page('owner', cursor)
    seen += [r[field] for r in rows]
    assert cursor is None and len(seen) == len(set(seen)) == 120 and set(seen) == kept


def support_entries(db):
    return [
        s.to_dict()
        for s in db.collection('_admin_events').stream()
        if s.to_dict()['action'].startswith('support_')
    ]


def test_superadmin_support_views_and_fixes_append_audit_entries():
    """Each support read or fix appends one private entry in the transaction that rechecks access."""
    stores = instances(CompanyInspectionStore)
    store, db = stores[0], stores[0].db
    receipt = store.authorize('owner', sign_payload(audited(store)))
    auth_id = receipt['auth_id']
    db.document('_platform_admins/admin').set({'active': True})
    db.document('_companies/other').set(
        dict(company_id='other', profile=deepcopy(ADR_PROFILE), version=1, status='active')
    )
    db.document('_memberships/staff').set(
        dict(
            uid='staff',
            email='staff@example.invalid',
            company_id='adr',
            role='estimator',
            status='disabled',
            version=1,
            updated_at='2026',
        )
    )
    assert [r['inspection_id'] for r in store.support_page('admin', 'adr', False)[0]] == [ID]
    assert [r['auth_id'] for r in stores[1].support_page('admin', 'adr', True)[0]] == [auth_id]
    assert store.support_inspection('admin', 'adr', ID)[0]['status'] == 'signed'
    assert stores[1].support_authorization('admin', 'adr', auth_id)[0]['auth_id'] == auth_id
    assert store.support_evidence('admin', 'adr', auth_id, 'signature')[1] == 'image/png'
    store.workspaces.update_member(
        'admin', 'adr', 'staff', MemberUpdate(expected_version=1, role='office', status='active')
    )
    assert stored(db, '_memberships/staff')['status'] == 'active'
    with pytest.raises(LookupError):
        store.support_inspection('admin', 'other', ID)
    entries = support_entries(db)
    assert sorted((e['action'], e['target']) for e in entries) == [
        ('support_member_access', 'member/staff'),
        ('support_view_document', 'document/' + auth_id),
        ('support_view_documents', 'documents'),
        ('support_view_evidence', 'evidence/' + auth_id + '/signature'),
        ('support_view_job', 'job/' + ID),
        ('support_view_jobs', 'jobs'),
    ]
    assert all(
        e['actor_uid'] == 'admin' and e['company_id'] == 'adr' and e['created_at'] for e in entries
    )
    assert stored(db, '_memberships/admin') is None
    # Concurrent views each append their own entry; none overwrites another.
    views = outcomes(
        concurrently(
            [lambda i=i: stores[i % 2].support_inspection('admin', 'adr', ID) for i in range(4)]
        ),
        refused=(),
    )
    assert len(support_entries(db)) == len(entries) + len(views)
    # A revoked superadmin gets nothing back and leaves no entry.
    db.document('_platform_admins/admin').set({'active': False})
    with pytest.raises(AccessDenied):
        store.support_inspection('admin', 'adr', ID)
    with pytest.raises(AccessDenied):
        store.support_evidence('admin', 'adr', auth_id, 'signature')
    assert len(support_entries(db)) == len(entries) + len(views)


def verified(uid):
    return dict(uid=uid, email=uid + '@example.invalid', email_verified=True)


def test_owner_transfer_switches_atomically_and_leaves_one_owner(monkeypatch):
    """Acceptance replaces the owner in one transaction: a failure before commit changes nothing,
    and competing acceptances on separate instances leave exactly one active owner."""
    stores = instances(CompanyInspectionStore)
    db = stores[0].db
    seed_company(db)
    db.document('_platform_admins/admin').set({'active': True})
    invitations = {
        uid: stores[0].workspaces.invite('admin', 'adr', uid + '@example.invalid', 'owner')
        for uid in ('first', 'second')
    }
    paths = ['_companies/adr', '_memberships/owner', '_memberships/first']
    paths += ['_invitations/' + i['invitation_id'] for i in invitations.values()]
    before = {path: stored(db, path) for path in paths}
    event = WorkspaceStore.event

    def failing(self, tx, uid, action, *args):
        if action == 'invitation_accepted':
            raise RuntimeError('Synthetic failure after the switch was staged')
        return event(self, tx, uid, action, *args)

    monkeypatch.setattr(WorkspaceStore, 'event', failing)
    with pytest.raises(RuntimeError):
        stores[0].workspaces.accept(verified('first'), invitations['first']['invitation_id'])
    assert {path: stored(db, path) for path in paths} == before
    monkeypatch.setattr(WorkspaceStore, 'event', event)

    def accept(store, uid):
        return lambda: store.workspaces.accept(verified(uid), invitations[uid]['invitation_id'])

    winners = outcomes(
        concurrently([accept(stores[0], 'first'), accept(stores[1], 'second')]), refused=Conflict
    )
    assert len(winners) <= 1
    if not winners:
        winners = [accept(stores[0], 'first')()]
    winner = winners[0]['uid']
    loser = 'second' if winner == 'first' else 'first'
    with pytest.raises(Conflict):
        accept(stores[1], loser)()
    # Repeated acceptance by the winner is idempotent.
    assert accept(stores[1], winner)()['role'] == 'owner'
    owners = [
        s.to_dict()['uid']
        for s in db.collection('_memberships').stream()
        if s.to_dict()['role'] == 'owner' and s.to_dict()['status'] == 'active'
    ]
    assert owners == [winner] and stored(db, '_companies/adr')['owner_uid'] == winner
    assert stored(db, '_memberships/owner')['status'] == 'disabled'
    assert stored(db, '_memberships/' + loser) is None
    accepted = [
        s.to_dict()
        for s in db.collection('_admin_events').stream()
        if s.to_dict()['action'] == 'invitation_accepted'
    ]
    assert [(e['actor_uid'], e['details']) for e in accepted] == [
        (winner, {'role': 'owner', 'previous_owner_uid': 'owner'})
    ]


def test_owner_login_replaces_the_owner_atomically_and_competes_with_acceptance(monkeypatch):
    """A superadmin-created owner login commits in one transaction: a failure before commit leaves
    the company, both memberships and the pending invitation untouched, and racing an owner
    invitation's acceptance on another instance leaves exactly one active owner."""
    import backend.workspaces as workspaces
    from tests.fakes import FakeAuth

    monkeypatch.setattr(workspaces, 'firebase_auth', FakeAuth())
    monkeypatch.setattr(workspaces.firebase_admin, 'get_app', lambda name: object())
    stores = instances(CompanyInspectionStore)
    db = stores[0].db
    seed_company(db)
    db.document('_platform_admins/admin').set({'active': True})
    invitation = stores[0].workspaces.invite('admin', 'adr', 'invited@example.invalid', 'owner')
    paths = [
        '_companies/adr',
        '_memberships/owner',
        '_memberships/direct',
        '_invitations/' + invitation['invitation_id'],
    ]
    before = {path: stored(db, path) for path in paths}
    event = WorkspaceStore.event

    def failing(self, tx, uid, action, *args):
        if action == 'owner_login_created':
            raise RuntimeError('Synthetic failure after the switch was staged')
        return event(self, tx, uid, action, *args)

    def login(store):
        return lambda: store.workspaces.owner_login(
            'admin', 'adr', 'direct@example.invalid', 'synthetic-temporary-0001', 1
        )

    monkeypatch.setattr(WorkspaceStore, 'event', failing)
    with pytest.raises(RuntimeError):
        login(stores[0])()
    assert {path: stored(db, path) for path in paths} == before
    monkeypatch.setattr(WorkspaceStore, 'event', event)

    def accept():
        return stores[1].workspaces.accept(verified('invited'), invitation['invitation_id'])

    if not outcomes(concurrently([login(stores[0]), accept]), refused=Conflict):
        login(stores[0])()
    owners = [
        s.to_dict()['uid']
        for s in db.collection('_memberships').stream()
        if s.to_dict()['role'] == 'owner' and s.to_dict()['status'] == 'active'
    ]
    assert len(owners) == 1 and stored(db, '_companies/adr')['owner_uid'] == owners[0]
    assert stored(db, '_memberships/owner')['status'] == 'disabled'
    if owners == ['direct']:
        assert stored(db, '_memberships/direct')['password_change_required'] is True
        assert stored(db, '_invitations/' + invitation['invitation_id'])['status'] == 'cancelled'
        assert stored(db, '_memberships/invited') is None
    else:
        assert stored(db, '_memberships/direct') is None
    password = json.dumps([s.to_dict() for s in db.collection('_admin_events').stream()])
    assert 'synthetic-temporary-0001' not in password


def browser_token(uid, **claims):
    """An unsigned Firebase ID token, as the emulator accepts, carrying forged custom claims."""

    def part(value):
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip('=')

    issued = int(time.time())
    payload = dict(
        iss='https://securetoken.google.com/' + PROJECT,
        aud=PROJECT,
        iat=issued,
        exp=issued + 3600,
        auth_time=issued,
        sub=uid,
        user_id=uid,
        email=uid + '@example.invalid',
        email_verified=True,
        firebase={'sign_in_provider': 'google.com', 'identities': {}},
        **claims,
    )
    return part({'alg': 'none', 'kid': 'fakekid', 'typ': 'JWT'}) + '.' + part(payload) + '.'


def browser_request(method, path, token, body=None):
    request = urllib.request.Request(
        f'http://{EMULATOR}/v1/projects/{PROJECT}/databases/(default)/documents/{path}',
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'},
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code


def test_rules_deny_browser_access_to_superadmin_records_even_with_forged_claims():
    """Superadmin status and its audit log are server-only; custom claims grant no database access."""
    db = client()
    db.document('_platform_admins/admin').set({'active': True})
    db.document('_admin_events/event').set({'actor_uid': 'admin', 'action': 'support_view_jobs'})
    db.document('_companies/adr').set({'company_id': 'adr', 'status': 'active'})
    db.document('_memberships/office').set({'uid': 'office', 'company_id': 'adr', 'role': 'office'})
    active = {'booleanValue': True}
    attempts = [
        ('GET', '_platform_admins/admin', None),
        ('GET', '_platform_admins', None),
        ('PATCH', '_platform_admins/office', {'fields': {'active': active}}),
        ('PATCH', '_platform_admins/admin', {'fields': {'active': active}}),
        ('GET', '_admin_events/event', None),
        ('GET', '_admin_events', None),
        ('PATCH', '_admin_events/forged', {'fields': {'actor_uid': {'stringValue': 'office'}}}),
        ('DELETE', '_admin_events/event', None),
        ('GET', '_companies/adr', None),
        ('PATCH', '_companies/adr', {'fields': {'status': {'stringValue': 'suspended'}}}),
        ('PATCH', '_memberships/office', {'fields': {'role': {'stringValue': 'owner'}}}),
        ('GET', '_invitations', None),
    ]
    forged = dict(superadmin=True, admin=True, role='superadmin', platform_admin=True)
    for uid in ('office', 'admin', 'outsider'):
        for token in (browser_token(uid), browser_token(uid, **forged)):
            for method, path, body in attempts:
                assert browser_request(method, path, token, body) == 403, (uid, method, path)
    # The emulator's admin token bypasses rules, so the same reads fail only because of the rules.
    assert browser_request('GET', '_platform_admins/admin', 'owner') == 200
    assert stored(db, '_platform_admins/admin') == {'active': True}
    assert stored(db, '_platform_admins/office') is None
    assert stored(db, '_admin_events/event')['actor_uid'] == 'admin'
    assert stored(db, '_admin_events/forged') is None
    assert stored(db, '_companies/adr')['status'] == 'active'
    assert stored(db, '_memberships/office')['role'] == 'office'
