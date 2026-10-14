"""Company-aware adapter over the unchanged inspection/document payloads."""

import logging

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

    def _check_documents(self, uid, documents, tx=None):
        if documents:
            self.workspaces.check_profile(uid, documents.get('company_identity'), tx)

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
        field = 'signed_at' if signed else 'updated_at'
        source = self.db.collection('_workspace_jobs')
        query = source.where(filter=firestore.FieldFilter('company_id', '==', actor['company_id']))
        query = query.where(
            filter=firestore.FieldFilter(
                'auth_exists' if signed else 'kind', '==', True if signed else 'inspection'
            )
        )
        if actor['role'] == 'estimator':
            query = query.where(
                filter=firestore.FieldFilter('accessible_estimator_uids', 'array_contains', uid)
            )
        query = query.order_by(field, direction=firestore.Query.DESCENDING)
        if cursor:
            if signed:
                record = self.get(uid, cursor)
                if not record:
                    raise LookupError('Page not found.')
                mapping = self.workspaces.read('_workspace_authorizations', cursor)
                job_id = mapping['job_id']
            else:
                record = self.get_inspection(uid, cursor)
                job_id = cursor
            snapshot = source.document(job_id).get()
            job = snapshot.to_dict() if snapshot.exists else None
            if (
                not job
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
            record = self._listed(uid, last, signed)
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
