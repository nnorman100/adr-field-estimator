"""The applied-migration ledger: idempotent recording, staff-only reporting, server-only storage."""

import importlib
import json
import subprocess
import sys
from copy import deepcopy
from types import SimpleNamespace

import pytest

import backend.main as bm
from backend.migration_ledger import COLLECTION, list_applied, local_source_commit, record_applied
from backend.price_book_migration import MIGRATION_ID as PRICE_BOOKS
from backend.workspace_migration import MIGRATION_ID as WORKSPACES
from fastapi.testclient import TestClient
from tests.fakes import DB, Collection, FakeAuth, FakeStore

COMMIT = 'a' * 40
LATER = 'b' * 40


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


class PathCollection(Collection):
    def stream(self, transaction=None):
        return iter(
            SimpleNamespace(to_dict=lambda v=v: deepcopy(v), reference=SimpleNamespace(path=k))
            for k, v in list(self.db.records.items())
            if k.startswith(self.name + '/')
        )


class PathDB(DB):
    def collection(self, name):
        return PathCollection(self, name)


def run_workspaces(monkeypatch, db, *flags, change_source=False):
    script = importlib.import_module('scripts.migrate_workspaces')
    users = FakeAuth()
    users.add(script.ADMIN_EMAIL, 'google.com')
    db.records['inspections/job'] = {'owner_uid': users.users[script.ADMIN_EMAIL].uid, 'v': 1}

    def migrate(workspace, users, admin_uid, company_name, apply):
        if change_source:
            db.records['inspections/job'] = dict(db.records['inspections/job'], v=2)
        return {'created_paths': []}

    monkeypatch.setattr(script, 'firebase_admin', SimpleNamespace(initialize_app=lambda **k: None))
    monkeypatch.setattr(script, 'auth', users)
    monkeypatch.setattr(script, 'firestore', SimpleNamespace(Client=lambda **k: db))
    monkeypatch.setattr(script, 'migrate', migrate)
    monkeypatch.setattr(script, 'local_source_commit', lambda: COMMIT)
    monkeypatch.setattr(sys, 'argv', ['migrate_workspaces.py', '--company-name', 'ADR', *flags])
    script.main()


def run_price_books(monkeypatch, db, *flags, change_source=False):
    script = importlib.import_module('scripts.migrate_price_books')
    reads = iter([{'a': 1}, {'a': 2} if change_source else {'a': 1}])
    monkeypatch.setattr(script, 'firebase_admin', SimpleNamespace(initialize_app=lambda **k: None))
    monkeypatch.setattr(script, 'firestore', SimpleNamespace(Client=lambda **k: db))
    monkeypatch.setattr(script, 'source_fingerprints', lambda _db: next(reads))
    monkeypatch.setattr(script, 'build_plan', lambda _db, companies: {})
    monkeypatch.setattr(script, 'apply_plan', lambda store, plan, apply: {})
    monkeypatch.setattr(script, 'summary', lambda plan: {})
    monkeypatch.setattr(script, 'local_source_commit', lambda: COMMIT)
    monkeypatch.setattr(sys, 'argv', ['migrate_price_books.py', '--company', 'adr', *flags])
    script.main()


SCRIPTS = [(run_workspaces, WORKSPACES), (run_price_books, PRICE_BOOKS)]


@pytest.mark.parametrize('run, migration_id', SCRIPTS)
def test_migration_scripts_record_the_ledger_only_on_a_successful_apply(
    monkeypatch, tmp_path, run, migration_id
):
    key = COLLECTION + '/' + migration_id
    db = PathDB()
    run(monkeypatch, db)
    assert key not in db.records
    run(monkeypatch, db, '--manifest', str(tmp_path / 'dry.json'))
    assert key not in db.records
    manifest = tmp_path / 'applied.json'
    run(monkeypatch, db, '--apply', '--manifest', str(manifest))
    assert db.records[key]['migration_id'] == migration_id
    assert db.records[key]['source_commit'] == COMMIT
    assert 'ledger_recorded' in manifest.read_text()


@pytest.mark.parametrize('run, migration_id', SCRIPTS)
def test_migration_scripts_skip_the_ledger_when_source_records_change(
    monkeypatch, tmp_path, run, migration_id
):
    db = PathDB()
    manifest = tmp_path / 'applied.json'
    with pytest.raises(RuntimeError):
        run(monkeypatch, db, '--apply', '--manifest', str(manifest), change_source=True)
    assert COLLECTION + '/' + migration_id not in db.records
    assert not manifest.exists()
