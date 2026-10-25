"""Firestore TTL policies: the owner-run script, and why deleting expired records is safe.

TTL policies are enabled per collection group, so every document in the group with an `expire_at`
field is deleted once the time passes. These tests pin which documents carry the field and that each
value is no earlier than the last moment the application accepts the record.
"""

import re
import subprocess
import time
from pathlib import Path
import pytest
import backend.document_links as dl
import backend.main as bm
import backend.signing_links as sl
from scripts import ensure_firestore_ttls as ttls
from tests.test_backend import context, inspect, audit, sign_payload, as_user, ID
from tests.test_document_links import AUTH, reader, signed
from tests.test_signing_links import ready, homeowner, mint, token, recognized, sign

BACKEND = Path(__file__).resolve().parents[1] / 'backend'


@pytest.fixture(autouse=True)
def no_real_gcloud(monkeypatch):
    """Nothing here may reach the real project: any gcloud process not faked by a test fails."""

    def refuse(argv, **kwargs):
        raise AssertionError('unexpected process: ' + ' '.join(argv))

    monkeypatch.setattr(ttls.subprocess, 'run', refuse)
    monkeypatch.setattr(ttls, 'gcloud', lambda: 'gcloud')


def fake_gcloud(states):
    """Answers `fields ttls list` from a mutable {group: state} map (absent means no policy)."""

    def run(argv):
        assert argv[1:5] == ['firestore', 'fields', 'ttls', 'list']
        assert '--project=alert-disaster-field-2026' in argv
        base = 'projects/alert-disaster-field-2026/databases/(default)/collectionGroups/'
        fields = [{'name': base + group + '/fields/expire_at', 'ttlConfig': {'state': state}}
                  for group, state in states.items() if state]
        # Another field in the same group, and a group with an unrelated field, never match.
        fields.append({'name': base + '_limits/fields/other', 'ttlConfig': {'state': 'ACTIVE'}})
        fields.append({'name': base + 'jobs/fields/expire_at'})
        return fields

    return run


ALL_ACTIVE = {group: 'ACTIVE' for group in ttls.COLLECTION_GROUPS}


def test_the_policies_cover_exactly_the_documented_collection_groups():
    assert list(ttls.COLLECTION_GROUPS) == [
        '_live_resume',
        '_signing_links',
        '_limits',
        '_document_links',
    ]
    assert ttls.FIELD == 'expire_at' and ttls.PROJECT == 'alert-disaster-field-2026'


def test_the_check_is_read_only_and_reports_match_and_missing():
    lines = []
    enabled = []
    states = {**ALL_ACTIVE, '_limits': None, '_document_links': 'NEEDS_REPAIR'}
    missing = ttls.ensure(False, fake_gcloud(states), enabled.append, lines.append)
    assert missing == 2 and enabled == []
    assert [line.split()[0] for line in lines] == ['match', 'match', 'missing', 'missing']
    assert 'MISSING' in lines[2] and 'NEEDS_REPAIR' in lines[3]


def test_a_policy_that_is_still_backfilling_counts_as_in_place():
    states = {**ALL_ACTIVE, '_limits': 'CREATING'}
    never = lambda group: pytest.fail('enabled a policy already in place')
    assert ttls.ensure(False, fake_gcloud(states), never, lambda line: None) == 0


def test_apply_enables_only_the_missing_policies_and_a_rerun_changes_nothing():
    states = {'_live_resume': 'ACTIVE'}
    enabled = []

    def enable(group):
        enabled.append(group)
        states[group] = 'CREATING'

    lines = []
    assert ttls.ensure(True, fake_gcloud(states), enable, lines.append) == 0
    assert enabled == ['_signing_links', '_limits', '_document_links']
    assert [line.split()[0] for line in lines] == ['match', 'enabled', 'enabled', 'enabled']
    enabled.clear()
    assert ttls.ensure(True, fake_gcloud(states), enable, lambda line: None) == 0
    assert enabled == []
    assert list(states) == ['_live_resume', '_signing_links', '_limits', '_document_links']


def test_apply_reports_a_policy_that_did_not_take():
    lines = []
    missing = ttls.ensure(True, fake_gcloud({}), lambda group: None, lines.append)
    assert missing == 4 and all(line.startswith('FAILED') for line in lines)


def test_the_enable_command_targets_one_group_in_the_dedicated_project(monkeypatch):
    seen = []
    monkeypatch.setattr(
        ttls.subprocess,
        'run',
        lambda argv, **kw: seen.append((argv, kw)) or subprocess.CompletedProcess(argv, 0),
    )
    ttls.enable('_limits')
    argv, kwargs = seen[0]
    assert argv == [
        'gcloud',
        'firestore',
        'fields',
        'ttls',
        'update',
        'expire_at',
        '--collection-group=_limits',
        '--enable-ttl',
        '--async',
        '--project=alert-disaster-field-2026',
        '--quiet',
    ]
    assert kwargs['check']


def test_main_exit_codes_and_default_mode(monkeypatch, capsys):
    states = {**ALL_ACTIVE, '_limits': None}
    enabled = []
    monkeypatch.setattr(ttls, 'states', lambda run=None: {g: s for g, s in states.items() if s})
    monkeypatch.setattr(ttls, 'enable', enabled.append)
    assert ttls.main([]) == 1 and enabled == []
    assert 'Run again with --apply' in capsys.readouterr().out

    def enable(group):
        enabled.append(group)
        states[group] = 'CREATING'

    monkeypatch.setattr(ttls, 'enable', enable)
    assert ttls.main(['--apply']) == 0 and enabled == ['_limits']
    assert ttls.main(['--apply']) == 0 and enabled == ['_limits']


def test_a_gcloud_failure_stops_with_its_message_and_exit_2(monkeypatch, capsys):
    def fail(argv, **kwargs):
        return subprocess.CompletedProcess(argv, 1, stdout='', stderr='PERMISSION_DENIED')

    monkeypatch.setattr(ttls.subprocess, 'run', fail)
    assert ttls.main([]) == 2
    assert 'PERMISSION_DENIED' in capsys.readouterr().err


# What makes deleting each group's expired documents safe.


def test_only_the_three_ttl_writers_set_expire_at():
    writers = {
        path.name
        for path in BACKEND.glob('*.py')
        if re.search(r"expire_at", path.read_text(encoding='utf-8'))
    }
    assert writers == {'document_links.py', 'inspection_store.py', 'signing_links.py'}


def test_pending_signing_link_keeps_its_record_until_it_can_no_longer_be_used(ready):
    _, store, _, value = ready
    link = store.db.records['_signing_links/' + sl.link_id(value)]
    assert link['expire_at'].timestamp() == pytest.approx(link['expires'])
    assert link['expires'] - link['created_at'] == sl.LINK_SECONDS


def test_signed_link_is_kept_thirty_days_after_signing(ready):
    _, store, _, value = ready
    assert sign(value).status_code == 200
    link = store.db.records['_signing_links/' + sl.link_id(value)]
    assert link['status'] == 'used'
    kept_until = link['signed_at'] + sl.SIGNED_VIEW_SECONDS
    assert link['expire_at'].timestamp() == pytest.approx(kept_until)
    assert sl.SIGNED_VIEW_SECONDS == 30 * 86400
    # Signing never shortens the pending expiry.
    assert link['expire_at'].timestamp() > link['expires']


def test_a_deleted_signing_link_reads_as_unknown_everywhere(ready):
    client, store, record, value = ready
    path = '/api/inspections/' + ID + '/signing-links'
    del store.db.records['_signing_links/' + sl.link_id(value)]
    assert homeowner(value).get('/api/sign').status_code == 404
    assert sign(value).status_code == 404
    assert client.get(path).json() == {'status': 'none'}
    assert client.post(path + '/revoke').json() == {'status': 'none'}
    assert token(mint(client, record))


def test_document_link_expiry_equals_its_application_expiry(signed):
    _, store, _ = signed
    value, _ = dl.mint(store, 'owner', AUTH, 'homeowner')
    link = store.db.records['_document_links/' + dl.link_id(value)]
    assert link['expire_at'].timestamp() == pytest.approx(link['expires'])
    assert link['expires'] - link['created_at'] == dl.LINK_SECONDS == 30 * 86400
    # A replaced or revoked link keeps the same field: it is dead before the deletion.
    dl.revoke(store, 'owner', AUTH)
    assert store.db.records['_document_links/' + dl.link_id(value)]['status'] == 'revoked'


def test_a_deleted_document_link_reads_as_unknown_and_can_be_replaced(signed):
    _, store, _ = signed
    value, _ = dl.mint(store, 'owner', AUTH, 'homeowner')
    del store.db.records['_document_links/' + dl.link_id(value)]
    assert reader(value).get('/api/documents').status_code == 404
    assert dl.revoke(store, 'owner', AUTH, 'homeowner') == {'homeowner': 'none'}
    replacement, _ = dl.mint(store, 'owner', AUTH, 'homeowner')
    assert reader(replacement).get('/api/documents').status_code == 200


def test_only_per_address_counters_in_limits_carry_expire_at(ready, monkeypatch):
    client, store, record, value = ready
    hops = {'X-Forwarded-For': '198.51.100.1, 203.0.113.9, 35.191.0.1'}
    assert homeowner(value, **hops).get('/api/sign').status_code == 200
    # Per-user counters: minting counts against the technician's quota and the places and AI
    # caps share the same collection.
    assert client.post('/api/inspections/' + ID + '/signing-links/revoke').status_code == 200
    limits = {k: v for k, v in store.db.records.items() if k.startswith('_limits/')}
    assert any(k.startswith('_limits/ip-') for k in limits)
    assert any(not k.startswith('_limits/ip-') for k in limits)
    for key, counter in limits.items():
        if key.startswith('_limits/ip-'):
            # Idle for an hour: every counter window (one minute) has long closed.
            remaining = counter['expire_at'].timestamp() - time.time()
            assert 0 < remaining <= sl.ADDRESS_LIMIT_SECONDS == 3600
        else:
            assert 'expire_at' not in counter, key
