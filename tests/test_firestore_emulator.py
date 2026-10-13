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

import os
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
from backend.workspaces import ADR_PROFILE
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
        stores[1].authorize('owner', {**payload, 'auth_id': 'ADR-AUTH-second123456'})
    with pytest.raises(Conflict):
        stores[1].authorize('owner', {**payload, 'signature_png': png(blank=True)})
    after = (stored(db, 'inspections/' + ID), stored(db, 'authorizations/' + payload['auth_id']))
    assert after == before
    assert stored(db, 'authorizations/ADR-AUTH-second123456') is None
    assert len(stores[0].bucket.objects) == 1
