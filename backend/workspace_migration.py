"""Explicit, idempotent ADR sidecar migration. Signed source records are never written."""

try:
    from .workspaces import WorkspaceStore
    from .inspection_store import Conflict, now
except ImportError:
    from workspaces import WorkspaceStore
    from inspection_store import Conflict, now

ADR_ID = 'adr'
MIGRATION_ID = 'adr-company-v1'


def migration_records(workspaces, approved_users, admin_uid, company_name):
    if admin_uid not in approved_users:
        raise ValueError('The superadmin must be explicitly approved.')
    records = {}
    # Only the name is seeded; the owner enters the rest of the profile in Company settings.
    company = dict(
        company_id=ADR_ID,
        profile=WorkspaceStore.new_company(company_name)['profile'],
        version=1,
        status='active',
        owner_uid=admin_uid,
        region='CA',
        pricing_version='adr-workbook-v1',
        created_at=now(),
        updated_at=now(),
        migration_id=MIGRATION_ID,
    )
    records['_companies/' + ADR_ID] = company
    records['_platform_admins/' + admin_uid] = {'active': True, 'migration_id': MIGRATION_ID}
    for uid, email in approved_users.items():
        records['_memberships/' + uid] = dict(
            uid=uid,
            email=email.lower(),
            company_id=ADR_ID,
            role='owner' if uid == admin_uid else 'estimator',
            status='active',
            version=1,
            updated_at=now(),
            migration_id=MIGRATION_ID,
        )
    skipped = 0
    for snapshot in workspaces.db.collection('inspections').stream():
        record = snapshot.to_dict()
        uid = record.get('owner_uid')
        if uid not in approved_users:
            skipped += 1
            continue
        identifier = record['inspection_id']
        records['_workspace_jobs/' + identifier] = dict(
            job_id=identifier,
            company_id=ADR_ID,
            creator_uid=uid,
            assigned_estimator_uid=None,
            accessible_estimator_uids=[uid],
            version=1,
            kind='inspection',
            customer_name='',
            customer_phone='',
            customer_email='',
            office_notes='',
            address=record['data']['address'],
            status=record['status'],
            auth_exists=False,
            created_at=record['created_at'],
            updated_at=record['updated_at'],
            migration_id=MIGRATION_ID,
        )
    for snapshot in workspaces.db.collection('authorizations').stream():
        record = snapshot.to_dict()
        uid = record.get('owner_uid')
        if uid not in approved_users:
            skipped += 1
            continue
        identifier = record['auth_id']
        job_id = record.get('inspection_id', identifier)
        if '_workspace_jobs/' + job_id not in records:
            # Standalone historical agreements get only an access sidecar.
            if record.get('inspection_id'):
                skipped += 1
                continue
            records['_workspace_jobs/' + job_id] = dict(
                job_id=job_id,
                company_id=ADR_ID,
                creator_uid=uid,
                assigned_estimator_uid=None,
                accessible_estimator_uids=[uid],
                version=1,
                kind='historical',
                customer_name='',
                customer_phone='',
                customer_email='',
                office_notes='',
                address=record.get('address', ''),
                status='signed',
                created_at=record['created_at'],
                updated_at=record['created_at'],
                migration_id=MIGRATION_ID,
            )
        job = records['_workspace_jobs/' + job_id]
        job.update(auth_exists=True, auth_id=identifier, signed_at=record['created_at'])
        records['_workspace_authorizations/' + identifier] = {
            'job_id': job_id,
            'company_id': ADR_ID,
            'migration_id': MIGRATION_ID,
        }
    return records, skipped


def migrate(workspaces, approved_users, admin_uid, company_name, apply=False):
    records, skipped = migration_records(workspaces, approved_users, admin_uid, company_name)
    report = {
        'migration_id': MIGRATION_ID,
        'apply': apply,
        'create': 0,
        'already_present': 0,
        'unmapped_source_records': skipped,
        'created_paths': [],
    }
    for path, expected in records.items():
        collection, identifier = path.split('/', 1)

        def create(tx):
            current = workspaces.read(collection, identifier, tx)
            if current:
                # Never overwrite later invitations, assignments, profiles or owner transfers.
                valid = current.get('migration_id') == MIGRATION_ID
                if collection == '_workspace_jobs':
                    valid = valid or (
                        current.get('company_id') == ADR_ID
                        and current.get('creator_uid') == expected['creator_uid']
                    )
                if collection == '_workspace_authorizations':
                    valid = valid or (
                        current.get('company_id') == ADR_ID
                        and current.get('job_id') == expected['job_id']
                    )
                if not valid or (current.get('company_id') and current['company_id'] != ADR_ID):
                    raise Conflict('Migration target exists outside this migration: ' + path)
                if collection == '_workspace_jobs' and expected['kind'] == 'inspection':
                    source = workspaces.read('inspections', identifier, tx)
                    if not source or source['owner_uid'] != expected['creator_uid']:
                        raise Conflict('Migration source changed: ' + path)
                    summary = dict(
                        address=source['data']['address'],
                        status=source['status'],
                        updated_at=source['updated_at'],
                    )
                    if expected.get('auth_exists'):
                        summary.update(
                            {k: expected[k] for k in ('auth_exists', 'auth_id', 'signed_at')}
                        )
                    if apply and any(current.get(k) != v for k, v in summary.items()):
                        tx.set(workspaces.ref(collection, identifier), summary, merge=True)
                return False
            if apply:
                tx.create(workspaces.ref(collection, identifier), expected)
            return True

        missing = workspaces._run(create) if apply else create(None)
        if missing:
            report['create'] += 1
            if apply:
                report['created_paths'].append(path)
        else:
            report['already_present'] += 1
    return report
