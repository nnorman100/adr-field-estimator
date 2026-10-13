"""Real Firestore/storage checks with synthetic identities; NOT Firebase/API/email acceptance."""

import base64
import hashlib
import io
import json
import sys
from pathlib import Path
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from google.cloud import firestore
from PIL import Image, ImageDraw
from scripts.verify_common import EVIDENCE
from backend.company_store import CompanyInspectionStore
from backend.contracts import InspectionData, AIResult
from backend.claims import make_documents
from backend.workspaces import (
    AccessDenied,
    CoordinationUpdate,
    CompanyProfile,
    ProfileUpdate,
    StatusUpdate,
)
from backend.inspection_store import Conflict, now


def main():
    store = CompanyInspectionStore()
    w = store.workspaces
    db = store.db
    run = uuid4().hex
    prefix = 'ADR-TEST-WS-' + run + '-'
    users = {
        role: prefix + role
        for role in ('admin', 'owner', 'other', 'estimator', 'estimator2', 'office')
    }
    companies = []
    inspections = []
    agreements = []
    owner_invitations = {}
    paths = set()
    checks = []
    completed = False
    artifact = EVIDENCE / 'workspaces-20261007/real-database-check.json'

    def claims(role):
        return dict(
            uid=users[role], email=users[role].lower() + '@example.invalid', email_verified=True
        )

    def check(label, callback):
        callback()
        checks.append(label)
        print('PASS:', label, flush=True)

    def denied(callback):
        try:
            callback()
        except (AccessDenied, LookupError, Conflict):
            return
        raise AssertionError('Operation unexpectedly permitted')

    def remember(collection, identifier):
        paths.add(collection + '/' + identifier)

    def invite(owner, cid, role):
        entry = w.invite(
            users[owner], cid, claims(role)['email'], 'office' if role == 'office' else 'estimator'
        )
        remember('_invitations', entry['invitation_id'])
        remember(
            '_invite_keys', hashlib.sha256((cid + ':' + claims(role)['email']).encode()).hexdigest()
        )
        remember('_memberships', users[role])
        w.accept(claims(role), entry['invitation_id'])

    def new_job(role, data):
        identifier = 'ADR-INS-' + uuid4().hex
        inspections.append(identifier)
        remember('inspections', identifier)
        remember('_workspace_jobs', identifier)
        return store.create_inspection(users[role], identifier, data)

    try:
        remember('_platform_admins', users['admin'])
        w.ref('_platform_admins', users['admin']).create({'active': True, 'synthetic_run': run})
        for role in ('owner', 'other'):
            company, entry = w.create_company(
                users['admin'], 'Synthetic workspace ' + role, claims(role)['email']
            )
            owner_invitations[role] = entry['invitation_id']
            cid = company['company_id']
            companies.append(cid)
            remember('_companies', cid)
            remember('_invitations', entry['invitation_id'])
            remember('_memberships', users[role])
            w.accept(claims(role), entry['invitation_id'])
            profile = CompanyProfile(
                name='Synthetic workspace ' + role,
                address='Synthetic California address',
                license='TEST-ONLY',
                signoff='Synthetic estimator',
            )
            w.update_company(
                users[role],
                cid,
                ProfileUpdate(
                    expected_version=w.read('_companies', cid)['version'], profile=profile
                ),
            )
        cid, other = companies
        for role in ('estimator', 'estimator2', 'office'):
            invite('owner', cid, role)
        check(
            'Explicit invitation acceptance and repeat acceptance',
            lambda: w.accept(claims('owner'), owner_invitations['owner']),
        )
        initial = InspectionData(address='Synthetic office property').model_dump(mode='json')
        record = new_job('office', initial)
        job_id = record['inspection_id']
        check(
            'Office empty scope; measured scope rejected',
            lambda: denied(lambda: store.update_inspection(users['office'], job_id, 1, initial)),
        )
        w.coordination(
            users['office'],
            job_id,
            CoordinationUpdate(
                expected_version=1,
                assigned_estimator_uid=users['estimator'],
                address='Synthetic assigned property',
            ),
        )
        record = store.get_inspection(users['estimator'], job_id)
        check(
            'Assigned estimator can read office-created job',
            lambda: store.get_inspection(users['estimator'], job_id),
        )
        check(
            'Cross-company and admin-only job denial',
            lambda: (
                denied(lambda: store.get_inspection(users['other'], job_id)),
                denied(lambda: store.get_inspection(users['admin'], job_id)),
            ),
        )
        check(
            'Cross-company cursor denial',
            lambda: denied(lambda: store.inspection_page(users['other'], job_id)),
        )
        measured = InspectionData(
            address=record['data']['address'],
            year_built=2000,
            rooms=[dict(name='Synthetic room', finished_sf=10)],
            air_movers=3,
            dehumidifiers=1,
            scope_confirmed=True,
        )
        record = store.update_inspection(
            users['estimator'], job_id, record['revision'], measured.model_dump(mode='json')
        )
        documents = make_documents(
            measured,
            [],
            AIResult(
                summary='Synthetic database verification only.', suggestions=[], unpriced_work=[]
            ),
            w.snapshot(users['estimator']),
        )
        assert (
            documents['xactimate_total'] == 1775
            and documents['adr_estimate']['proposed_cost'] == 1788.9
        )
        record = store.save_audit(users['estimator'], job_id, record['revision'], documents)
        image = Image.new('RGBA', (300, 100), 'white')
        ImageDraw.Draw(image).line(
            [(15, 70), (90, 20), (150, 80), (260, 25)], fill='black', width=4
        )
        stream = io.BytesIO()
        image.save(stream, format='PNG')
        auth_id = 'ADR-AUTH-' + uuid4().hex
        agreements.append(auth_id)
        remember('authorizations', auth_id)
        remember('_workspace_authorizations', auth_id)
        payload = dict(
            inspection_id=job_id,
            expected_revision=record['revision'],
            auth_id=auth_id,
            proposal_hash=record['audit']['proposal_hash'],
            signature_png='data:image/png;base64,' + base64.b64encode(stream.getvalue()).decode(),
        )
        saved = store.authorize(users['estimator'], payload)
        check(
            'Real signature storage and company evidence access',
            lambda: store.evidence(
                store.get(users['office'], auth_id), 'signature', users['office']
            ),
        )
        check(
            'Foreign company cannot reopen agreement',
            lambda: denied(lambda: store.get(users['other'], auth_id)),
        )
        check(
            'Owner and estimator indexes list saved agreement',
            lambda: (
                assert_ids(store.authorization_page(users['owner'])[0], auth_id, 'auth_id'),
                assert_ids(store.authorization_page(users['estimator'])[0], auth_id, 'auth_id'),
            ),
        )
        own = new_job('estimator', measured.model_dump(mode='json'))
        w.coordination(
            users['owner'],
            own['inspection_id'],
            CoordinationUpdate(expected_version=1, assigned_estimator_uid=users['estimator2']),
        )
        check(
            'Original creator retains reassigned job access',
            lambda: store.get_inspection(users['estimator'], own['inspection_id']),
        )
        check(
            'Company and estimator draft indexes',
            lambda: (
                assert_ids(
                    store.inspection_page(users['owner'])[0], own['inspection_id'], 'inspection_id'
                ),
                assert_ids(
                    store.inspection_page(users['estimator2'])[0],
                    own['inspection_id'],
                    'inspection_id',
                ),
            ),
        )
        changed = w.read('_companies', cid)
        profile = CompanyProfile(**{**changed['profile'], 'phone': 'Synthetic new phone'})
        w.update_company(
            users['owner'], cid, ProfileUpdate(expected_version=changed['version'], profile=profile)
        )
        assert store.get(users['office'], auth_id)['documents'] == saved['documents']
        check(
            'Saved identity and hashes stay immutable after profile edit',
            lambda: assert_equal(
                store.get(users['owner'], auth_id)['payload_sha256'], saved['payload_sha256']
            ),
        )
        changed = w.read('_companies', cid)
        w.update_company(
            users['admin'],
            cid,
            StatusUpdate(expected_version=changed['version'], status='suspended'),
        )
        check(
            'Suspended company denies existing job access',
            lambda: denied(lambda: store.get_inspection(users['estimator'], own['inspection_id'])),
        )
        completed = True
    finally:
        # Enumerate administrative events only for the exact companies created above.
        for cid in companies:
            for snap in (
                db.collection('_admin_events')
                .where(filter=firestore.FieldFilter('company_id', '==', cid))
                .stream()
            ):
                paths.add(snap.reference.path)
        for auth_id in agreements:
            for blob in store.bucket.list_blobs(
                prefix='users/' + users['estimator'] + '/authorizations/' + auth_id + '/'
            ):
                blob.delete(if_generation_match=blob.generation)
        cleanup = []
        for path in sorted(paths):
            ref = db.document(path)
            snap = ref.get()
            if snap.exists:
                ref.delete(option=firestore.LastUpdateOption(snap.update_time))
                cleanup.append(path)
        remaining = [path for path in paths if db.document(path).get().exists]
        artifact.parent.mkdir(parents=True, exist_ok=True)
        artifact.write_text(
            json.dumps(
                dict(
                    completed=completed,
                    timestamp=now(),
                    kind='real Firestore/storage; synthetic unverified identities; no API/email/Vertex',
                    checks=checks,
                    synthetic_run=run,
                    created_companies=companies,
                    cleanup_deleted=len(cleanup),
                    cleanup_remaining=remaining,
                ),
                indent=2,
            )
            + '\n',
            encoding='utf8',
        )
        artifact.with_name('real-database-' + run + '.json').write_bytes(artifact.read_bytes())
        assert not remaining, 'Synthetic cleanup incomplete'
        print('Synthetic cleanup complete:', len(cleanup), 'records', flush=True)


def assert_ids(records, identifier, key):
    assert identifier in [r[key] for r in records]


def assert_equal(a, b):
    assert a == b


if __name__ == '__main__':
    main()
