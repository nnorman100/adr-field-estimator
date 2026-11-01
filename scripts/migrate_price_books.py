"""Preview company price books by default. Write only with --apply, a manifest and the dedicated project.

Does not deploy, send email, or rewrite inspections, audits, authorizations or company identity versions.
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import firebase_admin
from google.cloud import firestore
from backend.migration_ledger import local_source_commit, record_applied
from backend.price_book_migration import (
    MIGRATION_ID,
    apply_plan,
    build_plan,
    source_fingerprints,
    summary,
)
from backend.workspaces import WorkspaceStore

PROJECT = 'alert-disaster-field-2026'


def main():
    parser = argparse.ArgumentParser(
        description='Dry-run company price books unless --apply is set.'
    )
    parser.add_argument('--company', action='append', required=True)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--manifest', type=Path)
    parser.add_argument('--project', default=PROJECT)
    args = parser.parse_args()
    if args.apply and args.project != PROJECT:
        parser.error('--apply is limited to project alert-disaster-field-2026')
    if args.apply and not args.manifest:
        parser.error('--apply requires --manifest')
    firebase_admin.initialize_app(options={'projectId': args.project}, name='price-book-migration')
    db = firestore.Client(project=args.project, database='(default)')
    before = source_fingerprints(db)
    plan = build_plan(db, args.company)
    store = WorkspaceStore(db)
    report = apply_plan(store, plan, args.apply)
    after = source_fingerprints(db)
    report['source_records_preserved'] = before == after
    if not report['source_records_preserved']:
        raise RuntimeError(
            'Source inspection or authorization records changed. No further apply is safe.'
        )
    if args.apply:
        report['ledger_recorded'] = record_applied(db, MIGRATION_ID, local_source_commit())
    if args.manifest:
        args.manifest.parent.mkdir(parents=True, exist_ok=True)
        args.manifest.write_text(
            json.dumps({'plan': plan, 'summary': report}, indent=2, default=str) + '\n',
            encoding='utf8',
        )
    print(json.dumps(summary(plan) if not args.apply else report, indent=2))


if __name__ == '__main__':
    main()
