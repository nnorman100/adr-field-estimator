#!/usr/bin/env python3
"""Preview the last 60 days of a company's signed jobs. Counts only; no writes without --apply."""

import argparse
import json
import os
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from google.cloud import firestore
from backend.workspaces import WorkspaceStore
from backend.drying_watch import instant
from backend.inspection_store import now


def preview(workspaces, company_id, apply=False, at=None):
    cutoff = (at or datetime.now(timezone.utc)) - timedelta(days=60)
    query = workspaces.db.collection('_workspace_jobs').where(
        filter=firestore.FieldFilter('company_id', '==', company_id)
    )
    query = query.where(filter=firestore.FieldFilter('auth_exists', '==', True))
    query = query.order_by('signed_at', direction=firestore.Query.DESCENDING)
    counts = Counter()
    while True:
        rows = list(query.limit(100).stream())
        for row in rows:
            job = row.to_dict()
            if instant(job['signed_at']) < cutoff:
                return dict(counts)
            counts['signed_jobs'] += 1

            def visit(tx):
                current = workspaces.read('_workspace_jobs', job['job_id'], tx)
                if current['company_id'] != company_id:
                    return None, False
                log = workspaces.read('drying_logs', job['job_id'], tx) or {}
                try:
                    state = workspaces.monitoring.compute(current, tx, log)
                except LookupError:
                    return 'unavailable', False
                exists = workspaces.read('_job_monitoring', job['job_id'], tx)
                create = bool(log.get('readings')) and not exists
                if apply and create:
                    tx.create(
                        workspaces.monitoring.ref(job['job_id']), dict(state, updated_at=now())
                    )
                return state['status'], create

            status, create = workspaces._run(visit)
            if status:
                counts[status] += 1
                counts['eligible_for_creation'] += int(create)
                counts['created'] += int(apply and create)
        if len(rows) < 100:
            return dict(counts)
        query = query.start_after(rows[-1])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--company', required=True)
    parser.add_argument(
        '--project', required=True, choices=['alert-disaster-field-2026', 'demo-adr-emulator']
    )
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if args.project.startswith('demo-') and not os.getenv('FIRESTORE_EMULATOR_HOST'):
        parser.error('The demo project requires FIRESTORE_EMULATOR_HOST.')
    if os.getenv('FIRESTORE_EMULATOR_HOST') and not args.project.startswith('demo-'):
        parser.error('Use the demo project with the emulator.')
    db = firestore.Client(project=args.project)
    print(
        json.dumps(
            dict(
                mode='apply' if args.apply else 'dry-run',
                counts=preview(WorkspaceStore(db), args.company, args.apply),
            )
        )
    )


if __name__ == '__main__':
    main()
