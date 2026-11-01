"""Ledger of applied data migrations: one server-only `_migrations/{id}` document per migration.

The first successful apply wins, so re-running a migration never changes its recorded time or commit.
The ledger starts empty; migrations applied before it existed are not backfilled.
"""

import logging
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from google.api_core.exceptions import AlreadyExists

COLLECTION = '_migrations'
COMMIT_PATTERN = re.compile(r'[0-9a-f]{40}(?:-dirty)?')
log = logging.getLogger(__name__)


def local_source_commit(repo=Path(__file__).resolve().parents[1]):
    """The checkout's commit, `-dirty` when it has uncommitted changes; `unknown` when git cannot say."""
    try:
        head = subprocess.run(
            ['git', '-C', str(repo), 'rev-parse', 'HEAD'],
            capture_output=True,
            text=True,
            check=True,
            timeout=10,
        ).stdout.strip()
        dirty = subprocess.run(
            ['git', '-C', str(repo), 'status', '--porcelain'],
            capture_output=True,
            text=True,
            check=True,
            timeout=10,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return 'unknown'
    value = head + ('-dirty' if dirty else '')
    return value if COMMIT_PATTERN.fullmatch(value) else 'unknown'


def record_applied(db, migration_id, source_commit):
    """Record one applied migration. True when this call wrote it, False when it was already recorded."""
    try:
        db.collection(COLLECTION).document(migration_id).create(
            dict(
                migration_id=migration_id,
                applied_at=datetime.now(timezone.utc),
                source_commit=source_commit,
            )
        )
    except AlreadyExists:
        return False
    return True


def list_applied(db):
    """Applied migrations, oldest first, as JSON-safe dictionaries."""
    rows = [snapshot.to_dict() for snapshot in db.collection(COLLECTION).stream()]
    rows.sort(key=lambda row: (str(row.get('applied_at')), row.get('migration_id', '')))
    return [
        dict(
            migration_id=row.get('migration_id'),
            applied_at=_iso(row.get('applied_at')),
            source_commit=row.get('source_commit', 'unknown'),
        )
        for row in rows
    ]


def _iso(value):
    return value.isoformat() if hasattr(value, 'isoformat') else value
