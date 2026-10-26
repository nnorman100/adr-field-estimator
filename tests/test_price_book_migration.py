"""Price-book seed migration is a dry run until apply, and it does not rewrite source records."""

from copy import deepcopy

import pytest
from backend.price_book_migration import apply_plan, build_plan, source_fingerprints, summary
from tests.fakes import FakeCompanyStore
from tests.test_backend import ID
from tests.test_workspaces import data, seed

OTHER = 'ADR-INS-' + 'b' * 32
SIGNED = 'ADR-INS-' + '9' * 32


def company():
    store = seed(FakeCompanyStore())
    store.create_inspection('estimator', ID, data())
    store.create_inspection('estimator', OTHER, data())
    store.create_inspection('estimator', SIGNED, data())
    store.db.records['_workspace_jobs/' + SIGNED]['auth_exists'] = True
    return store


def test_dry_run_writes_nothing_and_apply_is_idempotent():
    store = company()
    store.db.records['_companies/adr']['profile']['additional_work_rate'] = '55.00'
    store.db.records['inspections/' + OTHER]['data']['package_price'] = '2049.99'
    store.db.records['_workspace_jobs/' + ID]['auth_exists'] = False
    plan = build_plan(store.db, ['adr'])
    assert summary(plan)['books_to_create'] == 1
    assert summary(plan)['ambiguous_drafts'] == 1
    assert plan['companies'][0]['rates']['additional_work_hourly'] == '55.00'
    assert OTHER in plan['ambiguous']
    assert all(row['inspection_id'] != ID or row['action'] == 'create' for row in plan['pins'])
    before = deepcopy(store.db.records)
    assert apply_plan(store, plan, False) == summary(plan)
    assert store.db.records == before
    fingerprints = source_fingerprints(store.db)
    apply_plan(store, plan, True)
    assert source_fingerprints(store.db) == fingerprints
    pin = store.db.records['_job_pricing/' + ID]
    assert pin['rates']['additional_work_hourly'] == '55.00'
    assert pin['reason'] == 'legacy_rollout'
    assert '_job_pricing/' + OTHER not in store.db.records
    assert '_job_pricing/' + SIGNED not in store.db.records
    assert store.db.records['_companies/adr']['version'] == 1
    second = build_plan(store.db, ['adr'])
    assert second['companies'][0]['action'] == 'noop'
    assert all(row['action'] == 'noop' for row in second['pins'])
    settled = deepcopy(store.db.records)
    apply_plan(store, second, True)
    assert store.db.records == settled


def test_apply_refuses_a_drifted_additional_work_rate_without_writing():
    store = company()
    plan = build_plan(store.db, ['adr'])
    apply_plan(store, plan, True)
    version_id = plan['companies'][0]['version_id']
    store.db.records['_price_book_versions/' + version_id]['rates']['additional_work_hourly'] = (
        '60.00'
    )
    before = deepcopy(store.db.records)
    with pytest.raises(RuntimeError, match='additional-work'):
        build_plan(store.db, ['adr'])
    assert store.db.records == before


def test_a_company_without_a_rate_keeps_the_blank_instead_of_adr_default():
    store = company()
    plan = build_plan(store.db, ['other'])
    assert plan['companies'][0]['rates']['additional_work_hourly'] == ''
    apply_plan(store, plan, True)
    assert (
        store.db.records['_price_book_versions/migrate-other-v1']['rates']['additional_work_hourly']
        == ''
    )


@pytest.mark.parametrize('change', ['signed', 'association', 'rate'])
def test_apply_rechecks_current_state_before_writing(change):
    store = company()
    plan = build_plan(store.db, ['adr'])
    if change == 'signed':
        store.db.records['inspections/' + ID]['status'] = 'signed'
    elif change == 'association':
        store.db.records['_workspace_jobs/' + ID]['company_id'] = 'other'
    else:
        store.db.records['_companies/adr']['profile']['additional_work_rate'] = '60.00'
    before = deepcopy(store.db.records)
    with pytest.raises(RuntimeError):
        apply_plan(store, plan, True)
    assert store.db.records == before


def test_migration_reads_before_writes_and_keeps_seed_unpublished(monkeypatch):
    from tests.fakes import Ref, Tx

    store = company()
    plan = build_plan(store.db, ['adr', 'other'])
    writing = False
    original_get = Ref.get
    original_create, original_set = Tx.create, Tx.set

    def read(ref, transaction=None):
        assert not writing
        return original_get(ref, transaction)

    def create(tx, ref, value):
        nonlocal writing
        writing = True
        return original_create(tx, ref, value)

    def write(tx, ref, value, merge=False):
        nonlocal writing
        writing = True
        return original_set(tx, ref, value, merge)

    monkeypatch.setattr(Ref, 'get', read)
    monkeypatch.setattr(Tx, 'create', create)
    monkeypatch.setattr(Tx, 'set', write)
    apply_plan(store, plan, True)
    for row in plan['companies']:
        version = store.db.records['_price_book_versions/' + row['version_id']]
        assert version['sequence'] == 0
        assert version['published_at'] is None and version['effective_from'] is None
        head = store.db.records['_company_price_books/' + row['company_id']]
        assert head['generation'] == 0 and head['next_sequence'] == 1
    assert store.db.records['_job_pricing/' + ID]['sequence'] == 0
