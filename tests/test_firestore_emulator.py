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

from google.api_core.exceptions import Aborted, ServiceUnavailable
from google.auth.credentials import AnonymousCredentials
from google.cloud import firestore
import backend.inspection_store as inspection_store
from backend.adr_price_book import adr_rates
from tests.adr_pricing import make_documents
from backend.company_store import CompanyInspectionStore
from backend.contracts import AIResult, InspectionData
from backend.inspection_store import Conflict, InspectionStore, Limited
from backend.workspaces import AccessDenied, MemberUpdate, WorkspaceStore
from tests.fakes import ADR_PROFILE, Bucket, png
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


def test_signing_writes_the_history_row_atomically_and_a_concurrent_close_does_not_lose_it(
    monkeypatch,
):
    from backend import ai_features
    from backend.outcomes import JobClose

    monkeypatch.setattr(ai_features, 'AI_FEATURES', {'estimate_assist'})
    stores = instances(CompanyInspectionStore)
    record = audited(stores[0])
    db = stores[0].db
    payload = sign_payload(record)

    # A signing transaction that fails after the row is written leaves neither agreement nor row.
    class FailsLast:
        def check(self, tx):
            pass

        def consume(self, tx, body):
            raise RuntimeError('Synthetic failure at the end of the signing transaction')

    with pytest.raises(RuntimeError):
        stores[0].authorize('owner', payload, claim=FailsLast())
    assert stored(db, '_estimate_history/adr') is None
    assert stored(db, 'authorizations/' + payload['auth_id']) is None

    receipt = stores[0].authorize('owner', payload)
    row = stored(db, '_estimate_history/adr')['rows'][ID]
    assert row['auth_id'] == receipt['auth_id'] == payload['auth_id']
    assert row['signed_at'] == receipt['created_at']
    assert stored(db, 'authorizations/' + payload['auth_id'])['created_at'] == row['signed_at']

    other = 'ADR-INS-' + 'e' * 32
    existing = dict(row, auth_id='ADR-AUTH-other', signed_at='2026-01-01T00:00:00+00:00')
    db.document('_estimate_history/adr').update({f'rows.`{other}`': existing})

    def close(store, final):
        request = JobClose(
            final_amount=final, actual_days=3, note='', expected_signed_at=row['signed_at']
        )
        return store.outcomes.close('owner', ID, request)

    def rewrite_other(store):
        # A second signature's history write, racing the close on the same company document.
        def write(tx):
            rows = store.outcomes._rows('adr', tx)
            store.outcomes._write(tx, 'adr', rows, other, dict(rows[other], planned_days=9))

        return store._atomic(write)

    outcomes(
        concurrently(
            [
                lambda: close(stores[0], '100.00'),
                lambda: rewrite_other(stores[1]),
                lambda: close(stores[1], '200.00'),
            ]
        ),
        refused=(),
    )
    # Contention may abort a call; the settled state then shows nothing was lost.
    close(stores[0], '300.00')
    rewrite_other(stores[1])
    rows = stored(db, '_estimate_history/adr')['rows']
    assert rows[ID]['final'] == '300.00' and rows[ID]['closed_at']
    assert rows[other]['planned_days'] == 9
    closes = [
        e for e in db.collection('_admin_events').stream() if e.to_dict()['action'] == 'job_closed'
    ]
    assert len(closes) >= 1
    assert all(set(e.to_dict()['details']) == {'job_id', 'landed'} for e in closes)


def close_on_emulator(store, signed_at, final='100.00'):
    from backend.outcomes import JobClose

    request = JobClose(final_amount=final, actual_days=3, note='', expected_signed_at=signed_at)
    return store.outcomes.close('owner', ID, request)


def test_a_history_failure_commits_the_signature_and_close_rebuilds_the_row(monkeypatch):
    from backend import ai_features, outcomes as history

    monkeypatch.setattr(ai_features, 'AI_FEATURES', {'estimate_assist'})
    store = instances(CompanyInspectionStore)[0]
    record = audited(store)
    db = store.db
    payload = sign_payload(record)

    def broken(*args):
        raise ValueError(history.NO_AMOUNTS)

    with monkeypatch.context() as patch:
        patch.setattr(history, 'history_row_at_signing', broken)
        receipt = store.authorize('owner', payload)
    assert stored(db, 'authorizations/' + payload['auth_id'])['created_at'] == receipt['created_at']
    assert stored(db, 'inspections/' + ID)['status'] == 'signed'
    assert stored(db, '_workspace_jobs/' + ID)['signed_at'] == receipt['created_at']
    assert stored(db, '_estimate_history/adr') is None

    assert close_on_emulator(store, receipt['created_at'])['closed'] is True
    row = stored(db, '_estimate_history/adr')['rows'][ID]
    assert row['auth_id'] == payload['auth_id'] and row['final'] == '100.00'


def test_a_failed_history_read_inside_the_transaction_still_commits_the_signature(monkeypatch):
    store = instances(CompanyInspectionStore)[0]
    record = audited(store)
    db = store.db
    payload = sign_payload(record)
    real = store.outcomes._rows

    def read_then_fail(company_id, tx=None):
        real(company_id, tx)
        raise ServiceUnavailable('Synthetic read failure')

    monkeypatch.setattr(store.outcomes, '_rows', read_then_fail)
    receipt = store.authorize('owner', payload)
    assert stored(db, 'authorizations/' + payload['auth_id'])['created_at'] == receipt['created_at']
    assert stored(db, 'inspections/' + ID)['status'] == 'signed'
    assert stored(db, '_estimate_history/adr') is None


@pytest.mark.parametrize('rows', ['not a map', ['not a map'], {'ADR-INS-other': 'not a row'}])
def test_a_corrupt_history_document_commits_the_signature_and_the_close(monkeypatch, rows):
    from backend import ai_features

    monkeypatch.setattr(ai_features, 'AI_FEATURES', {'estimate_assist'})
    store = instances(CompanyInspectionStore)[0]
    record = audited(store)
    db = store.db
    payload = sign_payload(record)
    db.document('_estimate_history/adr').set(dict(company_id='adr', rows=rows))
    receipt = store.authorize('owner', payload)
    assert stored(db, 'authorizations/' + payload['auth_id'])['created_at'] == receipt['created_at']
    assert stored(db, '_estimate_history/adr')['rows'][ID]['auth_id'] == payload['auth_id']

    db.document('_estimate_history/adr').set(dict(company_id='adr', rows=rows))
    assert close_on_emulator(store, receipt['created_at'])['closed'] is True
    assert stored(db, '_estimate_history/adr')['rows'][ID]['final'] == '100.00'


def test_contention_at_commit_still_retries_the_signing_transaction(monkeypatch):
    from google.cloud.firestore_v1.transaction import Transaction

    store = instances(CompanyInspectionStore)[0]
    record = audited(store)
    db = store.db
    payload = sign_payload(record)
    real, attempts = Transaction._commit, []

    def aborts_once(self):
        attempts.append(1)
        if len(attempts) == 1:
            # A real abort ends the attempt on the server, so its locks are gone before the retry.
            self._rollback()
            raise Aborted('Synthetic commit contention')
        return real(self)

    monkeypatch.setattr(Transaction, '_commit', aborts_once)
    receipt = store.authorize('owner', payload)
    assert len(attempts) == 2
    assert stored(db, 'authorizations/' + payload['auth_id'])['created_at'] == receipt['created_at']
    assert stored(db, '_estimate_history/adr')['rows'][ID]['auth_id'] == payload['auth_id']


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
    db.document('_migrations/adr-company-v1').set({'migration_id': 'adr-company-v1'})
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
        ('GET', '_company_price_books/adr', None),
        ('PATCH', '_company_price_books/adr', {'fields': {'generation': {'integerValue': '2'}}}),
        ('GET', '_price_book_versions/seed', None),
        ('GET', '_job_pricing/adr', None),
        ('GET', '_price_book_previews/seed', None),
        ('GET', '_migrations/adr-company-v1', None),
        ('GET', '_migrations', None),
        ('PATCH', '_migrations/forged', {'fields': {'source_commit': {'stringValue': 'x'}}}),
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
    assert stored(db, '_migrations/forged') is None


def test_concurrent_delivery_retries_send_each_entry_once_and_count_it(monkeypatch):
    """Two instances retry one job's delivery at once: each queued entry is sent exactly once, the
    shared daily count matches, and the sidecar stays private to the server."""
    import backend.delivery as delivery

    db = client()
    job = 'ADR-INS-' + 'd' * 32
    db.document('_companies/adr').set({'profile': {'document_delivery': True}})
    db.document('_workspace_jobs/' + job).set(
        dict(job_id=job, company_id='adr', auth_id='auth-' + 'd' * 32, status='signed')
    )
    sends = []
    monkeypatch.setattr(delivery, 'mail_settings', lambda: {})
    monkeypatch.setattr(
        delivery,
        'send_email',
        lambda settings, payload, kind, key, deadline, *, prevent_duplicates: (
            sends.append(key) or '<' + key + '>'
        ),
    )
    stores = [delivery.Deliveries(WorkspaceStore(client())) for _ in range(2)]
    stores[0].queue(job, {'crew_lead': 'Not switched on.'})
    compose = lambda role, record: {'to': [role + '@example.invalid']}
    outcomes(concurrently([lambda s=s: s.send(job, compose) for s in stores]), refused=LookupError)
    for s in stores:
        s.send(job, compose)
    entries = stored(db, '_job_deliveries/' + job)['entries']
    roles = [key.split('/')[1] for key in sends]
    # Never twice. An emulator lock timeout can abort a finish, leaving its entry reserved.
    assert sorted(roles) == ['adjuster', 'homeowner']
    assert entries['crew_lead']['status'] == 'skipped'
    sent = [role for role, e in entries.items() if e['status'] == 'sent']
    assert set(sent) <= set(roles)
    assert all(entries[role]['status'] in ('sent', 'sending') for role in roles)
    assert (stored(db, '_email_counts/daily') or {'sent': {'count': 0}})['sent']['count'] == len(
        sent
    )
    for path in ('_job_deliveries/' + job, '_job_deliveries', '_email_counts/daily'):
        assert browser_request('GET', path, browser_token('owner')) == 403, path


def test_readiness_derives_from_existing_log_without_source_writes():
    from backend.readiness import readiness

    store = instances(count=1)[0]
    record = store.create_inspection('owner', ID, data())
    before = stored(store.db, 'inspections/' + ID)
    state = readiness(
        record['data'], record['photos'], {}, store.drying_log('owner', ID)['readings']
    )
    assert 'setup_readings' in [g['code'] for g in state['gaps']]
    log = store.add_reading(
        'owner',
        'owner@example.invalid',
        ID,
        {
            'kind': 'air',
            'zone': 'affected',
            'room': 'Bathroom',
            'taken_at': '2026-10-25T10:00:00Z',
            'temperature_f': 70,
            'relative_humidity': 50,
        },
    )
    after = readiness(record['data'], record['photos'], {}, log['readings'])
    assert 'setup_readings' not in [g['code'] for g in after['gaps']]
    assert stored(store.db, 'inspections/' + ID) == before
    assert not stored(store.db, '_limits/owner')
    with pytest.raises((PermissionError, LookupError)):
        store.drying_log('other', ID)


def test_monitoring_reading_assignment_transactions_reminder_reservation_and_retention(monkeypatch):
    from backend import ai_features, monitoring_store
    from backend.monitoring_store import ReminderRequest
    from backend.workspaces import CoordinationUpdate
    from scripts.preview_drying_watch import preview

    monkeypatch.setattr(ai_features, 'AI_FEATURES', frozenset({'drying_watch'}))
    stores = instances(CompanyInspectionStore)
    record = audited(stores[0])
    agreement = stores[0].authorize('owner', sign_payload(record))
    db = stores[0].db
    original = stored(db, 'authorizations/' + agreement['auth_id'])
    db.document('_companies/adr').update(
        {'profile.drying_reminders': True, 'profile.crew_lead_email': 'crew@example.invalid'}
    )
    reading = dict(
        kind='material',
        room=record['data']['rooms'][0]['name'],
        material='Drywall',
        unit='%WME',
        moisture=22,
        dry_standard=12,
        affected=True,
        taken_at='2026-10-21T10:00:00Z',
    )
    result = stores[0].add_reading('owner', 'owner@example.invalid', ID, reading)
    watch = stored(db, '_job_monitoring/' + ID)
    assert watch['last_reading_at'] == reading['taken_at']
    assert watch['log_updated_at'] == result['updated_at']
    assert 'expire_at' not in watch  # Permanent coordination; no new TTL policy.
    stores[0].workspaces.coordination('owner', ID, CoordinationUpdate(expected_version=1))
    assert stored(db, '_job_monitoring/' + ID)['accessible_estimator_uids'] == ['owner']
    req = ReminderRequest(
        reminder_id='a' * 32,
        approved=True,
        recipient='crew_lead',
        recipient_hash=stores[0].workspaces.monitoring.view('owner', ID)['recipient_hashes'][
            'crew_lead'
        ],
        facts_hash=stores[0].workspaces.monitoring.view('owner', ID)['facts_hash'],
    )
    sends = []
    monkeypatch.setattr(monitoring_store, 'mail_settings', lambda: {})
    monkeypatch.setattr(
        monitoring_store, 'send_email', lambda *args, **kwargs: sends.append(args[3])
    )
    outcomes(
        concurrently(
            [lambda s=s: s.workspaces.monitoring.remind('owner', ID, req) for s in stores]
        ),
        refused=LookupError,
    )
    for s in stores:
        s.workspaces.monitoring.remind('owner', ID, req)
    assert sends == ['monitoring/' + ID + '/' + req.reminder_id]
    entry = stored(db, '_job_monitoring/' + ID)['reminders'][0]
    assert entry['status'] in ('sent', 'sending')
    assert stored(db, 'authorizations/' + agreement['auth_id']) == original
    for path in ('_job_monitoring/' + ID, '_job_monitoring'):
        assert browser_request('GET', path, browser_token('owner')) == 403
    assert (
        browser_request(
            'PATCH',
            '_job_monitoring/' + ID,
            browser_token('owner'),
            {'fields': {'status': {'stringValue': 'dry_standard_met'}}},
        )
        == 403
    )
    # The preview defaults to no writes and reports only counts, then applies idempotently.
    db.document('_job_monitoring/' + ID).delete()
    summary = preview(stores[0].workspaces, 'adr')
    assert summary['eligible_for_creation'] == 1 and summary['created'] == 0
    assert stored(db, '_job_monitoring/' + ID) is None
    assert preview(stores[0].workspaces, 'adr', apply=True)['created'] == 1
    assert preview(stores[0].workspaces, 'adr', apply=True)['created'] == 0


def test_monitoring_sidecar_failure_rolls_back_reading(monkeypatch):
    from backend import ai_features

    monkeypatch.setattr(ai_features, 'AI_FEATURES', frozenset({'drying_watch'}))
    store = instances(CompanyInspectionStore, 1)[0]
    record = audited(store)
    store.authorize('owner', sign_payload(record))

    def broken(*args, **kwargs):
        raise RuntimeError('Synthetic monitoring failure')

    monkeypatch.setattr(store.workspaces.monitoring, 'compute', broken)
    with pytest.raises(RuntimeError):
        store.add_reading(
            'owner',
            'owner@example.invalid',
            ID,
            dict(
                kind='material',
                room='Bathroom',
                material='Drywall',
                unit='%WME',
                moisture=22,
                dry_standard=12,
                affected=True,
                taken_at='2026-10-21T10:00:00Z',
            ),
        )
    assert stored(store.db, 'drying_logs/' + ID) is None
    assert stored(store.db, '_job_monitoring/' + ID) is None


def test_extras_approval_is_atomic_private_and_revision_bound():
    from backend.contracts import ExtraApprove
    from tests.test_extras import proposed, EXTRA_ID

    first, second = instances(CompanyInspectionStore)
    seed_company(first.db)
    payload = data()
    payload['extras'] = [proposed()]
    record = first.create_inspection('owner', ID, payload)
    request = ExtraApprove(
        expected_revision=record['revision'],
        expected_company_version=1,
        owner_name='Synthetic Owner',
    )
    results = concurrently(
        [
            lambda: first.approve_extra('owner', ID, EXTRA_ID, request),
            lambda: second.approve_extra('owner', ID, EXTRA_ID, request),
        ]
    )
    outcomes(results, refused=Conflict)
    current = first.get_inspection('owner', ID)
    assert current['revision'] == 2 and current['audit'] is None
    assert current['data']['extras'][0]['approval']['total'] == '118.65'
    entries = [snap.to_dict() for snap in first.db.collection('_admin_events').stream()]
    assert len([entry for entry in entries if entry['action'] == 'extra_approved']) == 1
    for token in (browser_token('owner'), browser_token('owner', role='owner', admin=True)):
        assert browser_request('GET', 'inspections/' + ID, token) == 403
        assert (
            browser_request(
                'PATCH', 'inspections/' + ID, token, {'fields': {'extras': {'arrayValue': {}}}}
            )
            == 403
        )
        assert (
            browser_request(
                'PATCH',
                '_companies/adr',
                token,
                {'fields': {'additional_work_rate': {'doubleValue': 1}}},
            )
            == 403
        )
    assert first.get_inspection('owner', ID)['data']['extras'][0]['approval']['total'] == '118.65'


def test_insight_cache_transaction_rechecks_facts_access_and_expiry(monkeypatch):
    from datetime import datetime, timedelta, timezone
    from backend import ai_features
    from backend.insights import Insights, JobSummary

    monkeypatch.setattr(ai_features, 'AI_FEATURES', frozenset({'job_summary', 'ai_usage'}))
    first, second = instances(CompanyInspectionStore)
    seed_company(first.db)
    first.create_inspection('owner', ID, data())
    readers = [Insights(first), Insights(second)]
    before = stored(first.db, 'inspections/' + ID)
    current = readers[0].view('owner', ID)
    selection = JobSummary(topics=['rooms', 'equipment'])
    results = concurrently(
        [lambda r=r: r.save('owner', ID, current['facts_hash'], selection) for r in readers]
    )
    outcomes(results, Conflict)
    readers[0].save('owner', ID, current['facts_hash'], selection)
    cached = stored(first.db, '_job_insights/' + ID)
    assert cached['company_id'] == 'adr'
    assert cached['expire_at'] - datetime.fromisoformat(cached['generated_at']) == timedelta(
        days=30
    )
    assert readers[1].view('owner', ID)['narrative'] == cached['narrative']
    assert stored(first.db, 'inspections/' + ID) == before
    # A source update between generation and commit invalidates the candidate.
    first.db.document('inspections/' + ID).update({'data.air_movers': 9})
    with pytest.raises(Conflict):
        readers[1].save('owner', ID, current['facts_hash'], selection)
    assert stored(first.db, '_job_insights/' + ID) == cached
    current = readers[1].view('owner', ID)
    assert current['stale'] and current['narrative'] is None
    readers[1].save('owner', ID, current['facts_hash'], selection)
    first.db.document('_job_insights/' + ID).update(
        {'expire_at': datetime.now(timezone.utc) - timedelta(seconds=1)}
    )
    assert readers[0].view('owner', ID)['narrative'] is None
    # Emulators do not execute TTL deletion; simulate that lifecycle explicitly.
    first.db.document('_job_insights/' + ID).delete()
    assert readers[0].view('owner', ID)['narrative'] is None
    readers[1].save('owner', ID, current['facts_hash'], selection)
    for token in (browser_token('owner'), browser_token('owner', superadmin=True)):
        for method, path, body in [
            ('GET', '_job_insights/' + ID, None),
            ('GET', '_job_insights', None),
            ('PATCH', '_job_insights/' + ID, {'fields': {'narrative': {'stringValue': 'forged'}}}),
            ('DELETE', '_job_insights/' + ID, None),
        ]:
            assert browser_request(method, path, token, body) == 403
    first.db.document('_memberships/owner').update({'status': 'disabled'})
    with pytest.raises(AccessDenied):
        readers[0].save('owner', ID, current['facts_hash'], selection)
    with pytest.raises(AccessDenied):
        readers[1].view('owner', ID)


def test_job_summary_daily_limit_and_usage_reads_share_transactional_counters(clock):
    first, second = instances()
    first.db.document('_limits/owner').set({'job_summary_day': {'start': clock[0], 'count': 59}})
    admitted = len(
        outcomes(
            concurrently([lambda s=s: s.quota('owner', 'job_summary', 6) for s in (first, second)])
        )
    )
    assert admitted <= 1
    if not admitted:
        first.quota('owner', 'job_summary', 6)
    before = stored(first.db, '_limits/owner')
    assert second.usage('owner')['job_summary'] == dict(used=60, limit=60, remaining=0)
    with pytest.raises(Limited):
        second.quota('owner', 'job_summary', 6)
    assert stored(first.db, '_limits/owner') == before
    clock[0] += 86400
    assert first.usage('owner')['job_summary'] == dict(used=0, limit=60, remaining=60)
    assert stored(first.db, '_limits/owner') == before


def test_price_publish_rolls_back_and_two_publishes_keep_one_generation():
    """A failure before the audit event commits nothing, and two publishes cannot both win."""
    from backend import price_books

    def stop():
        raise RuntimeError('stop before the event')

    price_books.set_enabled(True)
    try:
        stores = instances(CompanyInspectionStore)
        seed_company(stores[0].db)
        books = stores[0].workspaces.prices
        changed = dict(adr_rates(), emergency_call='150.00')
        other = dict(adr_rates(), emergency_call='160.00')
        payload = {
            'rates': changed,
            'acknowledgements': [],
            'change_reason': 'Trip charge review',
            'source': 'manual',
        }
        preview = books.preview('owner', 'adr', payload)
        books._before_event = stop
        with pytest.raises(RuntimeError):
            books.publish('owner', 'adr', preview['preview_id'], preview['generation'])
        assert list(stores[0].db.collection('_price_book_versions').stream()) == []
        assert stored(stores[0].db, '_company_price_books/adr') is None
        assert stored(stores[0].db, '_companies/adr')['version'] == 1
        books._before_event = None
        first = books.preview('owner', 'adr', payload)
        second = stores[1].workspaces.prices.preview(
            'owner',
            'adr',
            {
                'rates': other,
                'acknowledgements': [],
                'change_reason': 'A competing trip charge',
                'source': 'manual',
            },
        )
        outcomes(
            concurrently(
                [
                    lambda: books.publish('owner', 'adr', first['preview_id'], first['generation']),
                    lambda: stores[1].workspaces.prices.publish(
                        'owner', 'adr', second['preview_id'], second['generation']
                    ),
                ]
            ),
            refused=Conflict,
        )
        if not list(stores[0].db.collection('_price_book_versions').stream()):
            books.publish('owner', 'adr', first['preview_id'], 0)
        assert len(list(stores[0].db.collection('_price_book_versions').stream())) == 1
        assert stored(stores[0].db, '_company_price_books/adr')['generation'] == 1
        assert stored(stores[0].db, '_companies/adr')['version'] == 1
    finally:
        price_books.set_enabled(None)


def test_v2_publish_and_working_copy_transactions():
    """v2 publish rollback leaves working copy intact, competing publishes keep one generation,
    winning publish deletes the working copy, and client rules deny _price_book_drafts."""
    from backend import price_books, price_table

    def stop():
        raise RuntimeError('stop before the event')

    def priced_v2(amount):
        table = price_table.starter_table()
        for item in table['items']:
            if item['enabled']:
                item['unit_price'] = amount
            if item['group'] == 'extras':
                item['enabled'] = False
        return table

    price_books.set_enabled(True)
    try:
        stores = instances(CompanyInspectionStore)
        seed_company(stores[0].db)
        books = stores[0].workspaces.prices
        table_a = priced_v2('25.00')
        table_b = priced_v2('35.00')

        # Save a working copy and verify client rules deny direct access to _price_book_drafts
        wc = books.save_working_copy(
            'owner',
            'adr',
            {
                'expected_working_version': 0,
                'expected_generation': 0,
                'items': table_a['items'],
                'policy': table_a['policy'],
            },
        )
        assert wc['working_version'] == 1
        assert stored(stores[0].db, '_price_book_drafts/adr') is not None

        for token in (browser_token('owner'), browser_token('owner', superadmin=True)):
            for method, path, body in [
                ('GET', '_price_book_drafts/adr', None),
                ('GET', '_price_book_drafts', None),
                (
                    'PATCH',
                    '_price_book_drafts/adr',
                    {'fields': {'working_version': {'integerValue': '99'}}},
                ),
                ('DELETE', '_price_book_drafts/adr', None),
            ]:
                assert browser_request(method, path, token, body) == 403

        # Competing working-copy saves at the same expected_working_version admit at most one
        wc_outcomes = outcomes(
            concurrently(
                [
                    lambda: books.save_working_copy(
                        'owner',
                        'adr',
                        {
                            'expected_working_version': 1,
                            'expected_generation': 0,
                            'items': table_a['items'],
                            'policy': table_a['policy'],
                        },
                    ),
                    lambda: stores[1].workspaces.prices.save_working_copy(
                        'owner',
                        'adr',
                        {
                            'expected_working_version': 1,
                            'expected_generation': 0,
                            'items': table_b['items'],
                            'policy': table_b['policy'],
                        },
                    ),
                ]
            ),
            refused=Conflict,
        )
        assert len(wc_outcomes) <= 1

        # A publish failure before the audit event rolls back both the version and the working-copy deletion
        preview_a = books.preview(
            'owner',
            'adr',
            {
                'items': table_a['items'],
                'policy': table_a['policy'],
                'acknowledgements': [],
                'change_reason': 'First v2 table',
                'source': 'manual',
            },
        )
        books._before_event = stop
        with pytest.raises(RuntimeError):
            books.publish('owner', 'adr', preview_a['preview_id'], preview_a['generation'])
        assert list(stores[0].db.collection('_price_book_versions').stream()) == []
        assert stored(stores[0].db, '_company_price_books/adr') is None
        assert stored(stores[0].db, '_price_book_drafts/adr') is not None
        books._before_event = None

        # Competing v2 publishes keep one generation and delete the working copy
        first = books.preview(
            'owner',
            'adr',
            {
                'items': table_a['items'],
                'policy': table_a['policy'],
                'acknowledgements': [],
                'change_reason': 'First v2 table',
                'source': 'manual',
            },
        )
        second = stores[1].workspaces.prices.preview(
            'owner',
            'adr',
            {
                'items': table_b['items'],
                'policy': table_b['policy'],
                'acknowledgements': [],
                'change_reason': 'Competing v2 table',
                'source': 'manual',
            },
        )
        outcomes(
            concurrently(
                [
                    lambda: books.publish('owner', 'adr', first['preview_id'], first['generation']),
                    lambda: stores[1].workspaces.prices.publish(
                        'owner', 'adr', second['preview_id'], second['generation']
                    ),
                ]
            ),
            refused=Conflict,
        )
        if not list(stores[0].db.collection('_price_book_versions').stream()):
            books.publish('owner', 'adr', first['preview_id'], 0)
        assert len(list(stores[0].db.collection('_price_book_versions').stream())) == 1
        head = stored(stores[0].db, '_company_price_books/adr')
        assert head['generation'] == 1
        assert head['calculation_version'] == price_table.CALCULATION_VERSION
        assert stored(stores[0].db, '_price_book_drafts/adr') is None
        assert stored(stores[0].db, '_companies/adr')['version'] == 1
    finally:
        price_books.set_enabled(None)


def test_switch_from_a_rate_book_and_reprice_transactions():
    """Starting and publishing the switch and repricing a kept draft run in real transactions."""
    from backend import price_books, price_table

    price_books.set_enabled(True)
    try:
        stores = instances(CompanyInspectionStore)
        db = stores[0].db
        seed_company(db)
        books = stores[0].workspaces.prices
        rates = adr_rates()
        rates['emergency_call'] = '150.00'
        preview = books.preview(
            'owner',
            'adr',
            {
                'rates': rates,
                'acknowledgements': [],
                'change_reason': 'Starting rates',
                'source': 'manual',
            },
        )
        first = books.publish('owner', 'adr', preview['preview_id'], preview['generation'])
        record = stores[0].create_inspection('owner', ID, data())
        assert stored(db, '_job_pricing/' + ID) is None

        started = books.start_v2('owner', 'adr')
        with pytest.raises(Conflict):
            stores[1].workspaces.prices.start_v2('owner', 'adr')
        copy = started['working_copy']
        assert stored(db, '_company_price_books/adr').get('calculation_version') != (
            price_table.CALCULATION_VERSION
        )
        preview = books.preview(
            'owner',
            'adr',
            {
                'items': copy['items'],
                'policy': copy['policy'],
                'acknowledgements': [
                    row['item_id'] for row in copy['items'] if row['unit_price'] == '0.00'
                ],
                'change_reason': 'Move to our own table',
                'source': 'manual',
            },
        )
        books.publish('owner', 'adr', preview['preview_id'], preview['generation'])
        head = stored(db, '_company_price_books/adr')
        assert head['calculation_version'] == price_table.CALCULATION_VERSION
        assert head['last_v1_version_id'] == first['version_id']
        assert stored(db, '_price_book_drafts/adr') is None

        # The draft begun earlier stays on the rate book, and only the owner's reprice moves it.
        record = stores[0].get_inspection('owner', ID)
        review = books.reprice_preview('owner', record)
        assert review['from_version_id'] == first['version_id']
        books.reprice(
            'owner',
            ID,
            {
                'expected_revision': review['revision'],
                'expected_pin_hash': review['from_hash'],
                'destination_version_id': review['to_version_id'],
                'destination_hash': review['to_hash'],
            },
        )
        pin = stored(db, '_job_pricing/' + ID)
        assert pin['calculation_version'] == price_table.CALCULATION_VERSION
        assert pin['reason'] == 'explicit_reprice'
        assert stored(db, 'inspections/' + ID)['audit'] is None
    finally:
        price_books.set_enabled(None)


def test_two_instances_run_one_retention_sweep_that_deletes_each_record_once(monkeypatch):
    """Record retention in real transactions: the daily lease admits one sweep, the activity-log
    range query and invitation paging run on Firestore, and each record is deleted once."""
    import hashlib
    from datetime import datetime, timezone

    import backend.retention as retention
    from backend.workspaces import ArchiveRequest

    monkeypatch.setattr(retention, '_forced', True)
    stores = instances(CompanyInspectionStore)
    db = stores[0].db
    seed_company(db)
    now = time.time()
    old = datetime.fromtimestamp(now - 200 * 86400, timezone.utc).isoformat()
    recent = datetime.fromtimestamp(now - 10 * 86400, timezone.utc).isoformat()
    for index in range(3):
        identifier = f'{index:032x}'
        email = f'invitee{index}@example.invalid'
        db.document('_invitations/' + identifier).set(
            dict(
                invitation_id=identifier,
                company_id='adr',
                email=email,
                role='estimator',
                status='accepted' if index else 'pending',
                # The pending one has not expired; the others expired 200 days ago.
                expires_at=now + 86400 if not index else now - 200 * 86400,
                created_at=old,
            )
        )
        key = hashlib.sha256(('adr:' + email).encode()).hexdigest()
        db.document('_invite_keys/' + key).set({'invitation_id': identifier})
    for identifier, created in (('a' * 32, old), ('b' * 32, recent)):
        db.document('_admin_events/' + identifier).set(
            dict(
                event_id=identifier, company_id='adr', action='company_profile', created_at=created
            )
        )
    db.document('_admin_events/' + 'c' * 32).set(
        dict(event_id='c' * 32, company_id='other', action='company_profile', created_at=old)
    )
    store = stores[0]
    store.create_inspection('owner', ID, data())
    record = store.add_photo(
        'owner',
        ID,
        dict(
            photo_id='d' * 32,
            expected_revision=1,
            room='Bathroom',
            captured_at='2026-10-01T10:00:00Z',
            data_url=png(),
        ),
    )
    path = record['photos'][0]['file']['path']
    job = stored(db, '_workspace_jobs/' + ID)
    store.workspaces.archive_job('owner', ID, ArchiveRequest(expected_version=job['version']))
    db.document('_workspace_jobs/' + ID).update({'archived_at': old})

    keepers = [retention.Retention(s.workspaces, s.bucket) for s in stores]
    results = concurrently([lambda k=k: k.tick('owner', 'adr', now) for k in keepers])
    ran = [r for r in outcomes(results, refused=()) if r['ran']]
    assert len(ran) <= 1
    if not ran:  # both lost the lease transaction to emulator contention; run again in sequence
        ran = [keepers[0].tick('owner', 'adr', now)]
    assert ran[0]['deleted'] == dict(
        invitations=2, admin_events=1, job_monitoring=0, evidence_photos=1
    )
    left = {s.id for s in db.collection('_invitations').stream()}
    assert left == {f'{0:032x}'}
    assert len(list(db.collection('_invite_keys').stream())) == 1
    events = {s.id: s.to_dict() for s in db.collection('_admin_events').stream()}
    assert 'a' * 32 not in events and {'b' * 32, 'c' * 32} <= set(events)
    runs = [e for e in events.values() if e['action'] == 'retention_run']
    assert len(runs) == 1 and runs[0]['actor_uid'] == 'system:retention'
    assert path not in store.bucket.objects
    assert stored(db, 'inspections/' + ID)['photos'] == []
    assert keepers[1].tick('owner', 'adr', now + 60) == {'ran': False}
