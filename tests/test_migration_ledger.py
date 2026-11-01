"""The applied-migration ledger: idempotent recording, staff-only reporting, server-only storage."""

import json
import subprocess
from pathlib import Path

import backend.main as bm
from backend.migration_ledger import COLLECTION, list_applied, local_source_commit, record_applied
from backend.price_book_migration import MIGRATION_ID as PRICE_BOOKS
from backend.workspace_migration import MIGRATION_ID as WORKSPACES
from fastapi.testclient import TestClient
from tests.fakes import DB, FakeStore

COMMIT = 'a' * 40
LATER = 'b' * 40
ROOT = Path(__file__).resolve().parents[1]


def test_recording_is_idempotent_and_the_first_apply_wins():
    db = DB()
    assert record_applied(db, WORKSPACES, COMMIT) is True
    first = dict(db.records[COLLECTION + '/' + WORKSPACES])
    assert first['migration_id'] == WORKSPACES and first['source_commit'] == COMMIT
    assert first['applied_at'] is not None
    assert record_applied(db, WORKSPACES, LATER) is False
    assert db.records[COLLECTION + '/' + WORKSPACES] == first
    assert len(db.records) == 1


def test_list_is_oldest_first_json_safe_and_empty_by_default():
    db = DB()
    assert list_applied(db) == []
    record_applied(db, WORKSPACES, COMMIT)
    record_applied(db, PRICE_BOOKS, LATER)
    rows = list_applied(db)
    assert [row['migration_id'] for row in rows] == [WORKSPACES, PRICE_BOOKS]
    assert [row['source_commit'] for row in rows] == [COMMIT, LATER]
    json.dumps(rows)


def test_local_source_commit_reads_git_and_marks_dirty_trees(tmp_path):
    def git(*args):
        subprocess.run(['git', '-C', str(tmp_path), *args], check=True, capture_output=True)

    assert local_source_commit(tmp_path) == 'unknown'
    git('init', '-q')
    (tmp_path / 'a.txt').write_text('a')
    git('add', '.')
    git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'a')
    clean = local_source_commit(tmp_path)
    assert len(clean) == 40 and not clean.endswith('-dirty')
    (tmp_path / 'a.txt').write_text('b')
    assert local_source_commit(tmp_path) == clean + '-dirty'


def test_health_details_lists_migrations_but_public_health_does_not(monkeypatch):
    store = FakeStore()
    record_applied(store.db, WORKSPACES, COMMIT)
    bm.app.dependency_overrides[bm.current_staff] = lambda: {'uid': 'owner', 'email': 'o@e.invalid'}
    bm.app.dependency_overrides[bm.get_job_store] = lambda: store
    try:
        client = TestClient(bm.app)
        details = client.get('/api/health/details').json()
        assert [row['migration_id'] for row in details['migrations']] == [WORKSPACES]
        assert details['migrations'][0]['source_commit'] == COMMIT
        for path in ('/api/health', '/health'):
            assert 'migrations' not in client.get(path).json()
        bm.app.dependency_overrides.pop(bm.current_staff)
        assert client.get('/api/health/details', headers={'Authorization': ''}).status_code == 401
    finally:
        bm.app.dependency_overrides.clear()


def test_health_details_survives_a_ledger_read_failure():
    store = FakeStore()

    def broken(name):
        raise RuntimeError('Synthetic Firestore outage')

    store.db.collection = broken
    bm.app.dependency_overrides[bm.current_staff] = lambda: {'uid': 'owner', 'email': 'o@e.invalid'}
    bm.app.dependency_overrides[bm.get_job_store] = lambda: store
    try:
        response = TestClient(bm.app).get('/api/health/details')
        assert response.status_code == 200
        assert response.json()['migrations'] is None
    finally:
        bm.app.dependency_overrides.clear()


def test_ledger_stays_server_only_under_the_deny_all_rules():
    rules = (ROOT / 'firestore.rules').read_text()
    assert 'match /{document=**}' in rules and 'allow read, write: if false;' in rules
    assert '_migrations' not in rules and 'allow read' not in rules.replace(
        'allow read, write: if false;', ''
    )


def test_both_migration_scripts_record_only_when_applying():
    for script in ('migrate_workspaces.py', 'migrate_price_books.py'):
        source = (ROOT / 'scripts' / script).read_text()
        assert 'record_applied' in source
        assert source.index('if args.apply:\n        report[') < source.index('if args.manifest:')
