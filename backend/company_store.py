"""Company-aware adapter over the unchanged inspection/document payloads."""

import logging
import re

from google.cloud import firestore

try:
    from .cloud_log import event
    from .inspection_store import InspectionStore, Conflict
    from .workspaces import WorkspaceStore, AccessDenied
except ImportError:
    from cloud_log import event
    from inspection_store import InspectionStore, Conflict
    from workspaces import WorkspaceStore, AccessDenied


class CompanyInspectionStore(InspectionStore):
    def __init__(self, db=None, bucket=None):
        super().__init__(db, bucket)
        self.workspaces = WorkspaceStore(self.db, self._atomic)

    def _access(self, uid, record, action='read', tx=None):
        self.workspaces.job_access(uid, record, action, tx)

    def _create_access(self, uid, record, tx):
        self.workspaces.create_job(uid, record, tx)

    def _sync_access(self, record, tx):
        self.workspaces.sync_job(record, tx)

    def _check_documents(self, uid, record, tx=None):
        if record.get('audit'):
            documents = record['audit']['documents']
            self.workspaces.check_profile(uid, documents.get('company_identity'), tx)
            self.workspaces.check_customer(record, documents['adr_estimate'], tx)
            self.workspaces.check_claim(record, documents, tx)

    def _company_id(self, uid, record, tx=None):
        return self.workspaces.job_access(uid, record, 'sign', tx)[1]['company_id']

    def _commit_authorization(self, uid, record, body, tx):
        job, actor = self.workspaces.job_access(uid, record, 'sign', tx)
        tx.create(
            self.workspaces.ref('_workspace_authorizations', body['auth_id']),
            {'job_id': job['job_id'], 'company_id': actor['company_id']},
        )
        tx.set(
            self.workspaces.ref('_workspace_jobs', job['job_id']),
            {
                'auth_exists': True,
                'auth_id': body['auth_id'],
                'signed_at': body['created_at'],
                'status': 'signed',
                'updated_at': body['created_at'],
            },
            merge=True,
        )

    def get(self, uid, auth_id):
        snapshot = self.workspaces.ref('authorizations', auth_id).get()
        if not snapshot.exists:
            return None
        return self._owned(snapshot, uid)

    def evidence(self, record, name, uid=None):
        if uid is None:
            raise AccessDenied('Authenticated evidence access is required.')
        self._access(uid, record)
        result = super().evidence(record, name)
        self._access(uid, record)
        return result

    def _page(self, collection, uid, timestamp, identifier, cursor=None):
        actor = self.workspaces.company_actor(uid)
        signed = collection == 'authorizations'

        def check_cursor(cursor):
            # The member must still be able to open the record the cursor names.
            if signed:
                if not self.get(uid, cursor):
                    raise LookupError('Page not found.')
            else:
                self.get_inspection(uid, cursor)

        return self._job_page(
            actor['company_id'],
            signed,
            uid if actor['role'] == 'estimator' else None,
            cursor,
            check_cursor,
            lambda job: self._listed(uid, job, signed),
        )

    def _job_page(self, company_id, signed, estimator_uid, cursor, check_cursor, listed):
        field = 'signed_at' if signed else 'updated_at'
        source = self.db.collection('_workspace_jobs')
        query = source.where(filter=firestore.FieldFilter('company_id', '==', company_id))
        query = query.where(
            filter=firestore.FieldFilter(
                'auth_exists' if signed else 'kind', '==', True if signed else 'inspection'
            )
        )
        if estimator_uid:
            query = query.where(
                filter=firestore.FieldFilter(
                    'accessible_estimator_uids', 'array_contains', estimator_uid
                )
            )
        query = query.order_by(field, direction=firestore.Query.DESCENDING)
        if cursor:
            check_cursor(cursor)
            if signed:
                mapping = self.workspaces.read('_workspace_authorizations', cursor)
                if not mapping:
                    raise LookupError('Page not found.')
                job_id = mapping['job_id']
            else:
                job_id = cursor
            snapshot = source.document(job_id).get()
            job = snapshot.to_dict() if snapshot.exists else None
            if (
                not job
                or job.get('company_id') != company_id
                or (signed and not job.get('auth_exists'))
                or (not signed and job.get('kind') != 'inspection')
            ):
                raise LookupError('Page not found.')
            query = query.start_after(snapshot)
        # A sidecar can outlive its draft, so a job whose source is gone is skipped and the
        # page reads on until it holds 100 jobs.
        records, last, skipped = [], None, 0
        for row in self._sidecars(query):
            if len(records) == 100:
                next_cursor = last['auth_id'] if signed else last['job_id']
                break
            last = row.to_dict()
            record = listed(last)
            if record:
                records.append(record)
            else:
                skipped += 1
        else:
            next_cursor = None
        if skipped:
            event(
                'Job list skipped jobs whose source record is missing',
                logging.WARNING,
                operation='job_list',
                outcome='missing_source',
            )
        return records, next_cursor

    def _sidecars(self, query):
        while True:
            rows = list(query.limit(101).stream())
            yield from rows
            if len(rows) < 101:
                return
            query = query.start_after(rows[-1])

    def _listed(self, uid, job, signed):
        if signed:
            return self.get(uid, job['auth_id'])
        snapshot = self._ref(job['job_id']).get()
        return self._owned(snapshot, uid) if snapshot.exists else None

    # Superadmin support reads: read-only, scoped to one company and audited before return.
    def support_page(self, uid, company_id, signed, cursor=None):
        self.workspaces.support_company(uid, company_id)

        def listed(job):
            snapshot = (
                self.workspaces.ref('authorizations', job['auth_id'])
                if signed
                else self._ref(job['job_id'])
            ).get()
            return snapshot.to_dict() if snapshot.exists else None

        page = self._job_page(company_id, signed, None, cursor, lambda cursor: None, listed)
        self.workspaces.support_audit(
            uid,
            company_id,
            'view_documents' if signed else 'view_jobs',
            'documents' if signed else 'jobs',
        )
        return page

    def _support_source(self, uid, company_id, collection, identifier):
        if collection == 'authorizations':
            if not re.fullmatch(r'ADR-AUTH-[A-Za-z0-9-]{6,64}', identifier):
                raise LookupError('Signed agreement not found.')
            ref = self.workspaces.ref('authorizations', identifier)
        else:
            ref = self._ref(identifier)
        # Checked before reading so a refused caller never triggers a source or evidence read.
        self.workspaces.support_company(uid, company_id)
        snapshot = ref.get()
        if not snapshot.exists:
            raise LookupError('Record not found.')
        record = snapshot.to_dict()
        return record, self.workspaces.support_job(uid, company_id, record)

    def support_inspection(self, uid, company_id, inspection_id):
        record, job = self._support_source(uid, company_id, 'inspections', inspection_id)
        self.workspaces.support_audit(uid, company_id, 'view_job', 'job/' + inspection_id, record)
        return record, job

    def support_photo(self, uid, company_id, inspection_id, photo_id):
        record, _ = self._support_source(uid, company_id, 'inspections', inspection_id)
        photo = next((p for p in record['photos'] if p['id'] == photo_id), None)
        if not photo:
            raise LookupError('Photo not found.')
        raw = self.bucket.blob(photo['file']['path']).download_as_bytes()
        self.workspaces.support_audit(
            uid, company_id, 'view_photo', f'photo/{inspection_id}/{photo["id"]}', record
        )
        return photo, raw

    def support_authorization(self, uid, company_id, auth_id):
        record, job = self._support_source(uid, company_id, 'authorizations', auth_id)
        self.workspaces.support_audit(
            uid, company_id, 'view_document', 'document/' + auth_id, record
        )
        return record, job

    def support_evidence(self, uid, company_id, auth_id, name):
        record, _ = self._support_source(uid, company_id, 'authorizations', auth_id)
        evidence = InspectionStore.evidence(self, record, name)
        if evidence:
            self.workspaces.support_audit(
                uid, company_id, 'view_evidence', f'evidence/{auth_id}/{name}', record
            )
        return evidence
