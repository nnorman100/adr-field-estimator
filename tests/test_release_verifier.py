"""Credential handling and boundaries for the normal-sign-in release verifier."""

import argparse
import io
import subprocess
import sys
from types import SimpleNamespace
import pytest
from scripts import verify_live_release as verifier


def test_existing_browser_token_is_authenticated_not_decoded(monkeypatch, capsys):
    calls = []

    def authenticated(method, path, token):
        calls.append((method, path, token))
        return dict(project=verifier.PROJECT, uid='staff-test', live_protocol_version=2)

    monkeypatch.setattr(verifier, 'check', authenticated)
    token, uid = verifier.staff_session(io.StringIO('private-memory-token\n'))
    assert (token, uid) == ('private-memory-token', 'staff-test')
    assert calls == [('GET', '/api/session', 'private-memory-token')]
    assert capsys.readouterr().out == ''


@pytest.mark.parametrize('token', ['', 'with spaces', 'x' * 16385])
def test_missing_or_unbounded_token_never_reaches_backend(monkeypatch, token):
    monkeypatch.setattr(verifier, 'check', lambda *args: pytest.fail('Unbounded credential sent'))
    with pytest.raises(RuntimeError):
        verifier.staff_session(io.StringIO(token + '\n'))


def test_token_from_other_project_is_rejected(monkeypatch):
    monkeypatch.setattr(
        verifier, 'check', lambda *args: dict(project='other', uid='staff', live_protocol_version=2)
    )
    with pytest.raises(RuntimeError):
        verifier.staff_session(io.StringIO('memory-token\n'))


def test_credentials_cannot_be_forwarded_to_another_service():
    assert verifier.service_url(verifier.PRODUCTION) == verifier.PRODUCTION
    assert verifier.service_url(verifier.STAGED) == verifier.STAGED
    with pytest.raises(argparse.ArgumentTypeError):
        verifier.service_url('https://untrusted.example/api')


def test_preflight_preserves_existing_capture(monkeypatch):
    monkeypatch.setattr(
        verifier, 'private_document', lambda *args: {'expires': {'doubleValue': 9999999999}}
    )
    with pytest.raises(RuntimeError, match='was not changed'):
        verifier.no_existing_capture('staff')


def test_synthetic_cleanup_checks_owner_before_deleting(monkeypatch):
    monkeypatch.setattr(verifier, 'access_token', lambda: 'admin-in-memory')

    class Other:
        status_code = 200

        def json(self):
            return {'fields': {'owner_uid': {'stringValue': 'someone-else'}}}

    class Missing:
        status_code = 404

    monkeypatch.setattr(
        verifier.requests,
        'get',
        lambda path, **kwargs: (
            Missing() if '/_memberships/' in path or '/_workspace_' in path else Other()
        ),
    )
    monkeypatch.setattr(
        verifier.requests, 'delete', lambda *args, **kwargs: pytest.fail('Wrong owner deleted')
    )
    with pytest.raises(RuntimeError):
        verifier.cleanup_synthetic('staff', ['ADR-INS-' + 'a' * 32], [])


def test_checkpoint_cleanup_preserves_another_inspection(monkeypatch):
    monkeypatch.setattr(verifier, 'access_token', lambda: 'admin-memory')

    class Capture:
        status_code = 200

        def json(self):
            return {
                'fields': {
                    'owner_uid': {'stringValue': 'staff'},
                    'inspection_id': {'stringValue': 'ADR-INS-' + 'b' * 32},
                },
                'updateTime': 'test-version',
            }

    monkeypatch.setattr(verifier.requests, 'get', lambda *args, **kwargs: Capture())
    monkeypatch.setattr(
        verifier.requests,
        'delete',
        lambda *args, **kwargs: pytest.fail('Another inspection checkpoint deleted'),
    )
    verifier.cleanup_test_checkpoint('staff', ['ADR-INS-' + 'a' * 32])


def test_checkpoint_cleanup_is_conditional_on_unchanged_version(monkeypatch):
    monkeypatch.setattr(verifier, 'access_token', lambda: 'admin-memory')

    class Capture:
        status_code = 200

        def json(self):
            return {
                'fields': {
                    'owner_uid': {'stringValue': 'staff'},
                    'inspection_id': {'stringValue': 'ADR-INS-' + 'a' * 32},
                },
                'updateTime': 'test-version',
            }

    calls = []

    class Changed:
        status_code = 412

    monkeypatch.setattr(verifier.requests, 'get', lambda *args, **kwargs: Capture())
    monkeypatch.setattr(
        verifier.requests, 'delete', lambda *args, **kwargs: calls.append(kwargs) or Changed()
    )
    verifier.cleanup_test_checkpoint('staff', ['ADR-INS-' + 'a' * 32])
    assert calls[0]['params'] == {'currentDocument.updateTime': 'test-version'}


@pytest.mark.parametrize(
    'collection,identifier,valid',
    [
        ('authorizations', 'ADR-AUTH-12345678-1234-4321-8321-123456789abc', True),
        ('authorizations', 'ADR-AUTH-' + 'a' * 32, True),
        ('inspections', 'ADR-INS-' + 'b' * 32, True),
        ('authorizations', 'ADR-AUTH-12345678-1234-4321-8321-123456789abc/other', False),
        ('authorizations', 'ADR-AUTH-../../other', False),
        ('inspections', 'ADR-INS-12345678-1234-4321-8321-123456789abc', False),
    ],
)
def test_synthetic_cleanup_accepts_app_uuid_without_broadening_paths(collection, identifier, valid):
    assert verifier.valid_synthetic_identifier(collection, identifier) is valid


def test_invalid_cleanup_target_is_rejected_before_admin_calls(monkeypatch):
    monkeypatch.setattr(
        verifier, 'access_token', lambda: pytest.fail('Invalid path reached admin lookup')
    )
    with pytest.raises(RuntimeError, match='Unexpected synthetic identifier'):
        verifier.cleanup_synthetic('staff', [], ['ADR-AUTH-../../other'])


def test_only_read_only_scope_extraction_retries_one_server_timeout(monkeypatch):
    monkeypatch.setattr(verifier, 'SERVICE', verifier.STAGED)
    calls = []
    waits = []

    class Response:
        def __init__(self, status):
            self.status_code = status

        def json(self):
            return {'changes': []}

    results = iter([Response(504), Response(200)])

    def request(*args, **kwargs):
        calls.append((args, kwargs))
        return next(results)

    monkeypatch.setattr(verifier.requests, 'request', request)
    monkeypatch.setattr(verifier.time, 'sleep', waits.append)
    body = {'inspection_id': 'ADR-INS-' + 'a' * 32, 'expected_revision': 1}
    assert verifier.check(
        'POST', '/api/inspections/test/scope-suggestions', 'memory-token', body
    ) == {'changes': []}
    assert len(calls) == 2 and calls[0] == calls[1] and waits == [2]


def test_write_timeout_is_not_automatically_replayed(monkeypatch):
    monkeypatch.setattr(verifier, 'SERVICE', verifier.STAGED)
    calls = []

    class Response:
        status_code = 504

    def request(*args, **kwargs):
        calls.append(args)
        return Response()

    monkeypatch.setattr(verifier.requests, 'request', request)
    monkeypatch.setattr(verifier.time, 'sleep', lambda *_: pytest.fail('Write retried'))
    with pytest.raises(RuntimeError, match='HTTP 504'):
        verifier.check('POST', '/api/authorize', 'memory-token', {'auth_id': 'synthetic'})
    assert len(calls) == 1


def test_company_sidecar_cleanup_rejects_foreign_tenant_before_deletion(monkeypatch):
    class Response:
        status_code = 200

        def __init__(self, fields):
            self.fields = fields

        def json(self):
            return {'fields': self.fields, 'updateTime': 'version'}

    def get(path, **kwargs):
        return (
            Response({'company_id': {'stringValue': 'adr'}})
            if '/_memberships/' in path
            else Response(
                {
                    'company_id': {'stringValue': 'another-company'},
                    'creator_uid': {'stringValue': 'staff'},
                }
            )
        )

    monkeypatch.setattr(verifier.requests, 'get', get)
    monkeypatch.setattr(
        verifier.requests, 'delete', lambda *args, **kwargs: pytest.fail('Foreign tenant deleted')
    )
    with pytest.raises(RuntimeError):
        verifier.synthetic_sidecars({}, 'staff', ['ADR-INS-' + 'a' * 32], [])


@pytest.mark.parametrize(
    'module,argv,entry',
    [
        (verifier, ['--public'], 'public'),
        (verifier, ['--token-stdin'], 'main'),
    ],
)
def test_verifiers_refuse_to_run_without_an_explicit_target(monkeypatch, module, argv, entry):
    monkeypatch.setattr(module, entry, lambda *args: pytest.fail('Ran against a default target'))
    monkeypatch.setattr(sys, 'argv', ['verifier'] + argv)
    with pytest.raises(SystemExit) as exited:
        module.cli()
    assert exited.value.code != 0


def test_public_check_accepts_only_the_trimmed_health_payload(monkeypatch):
    class Health:
        status_code = 200

        def json(self):
            return {'status': 'healthy', 'schema_version': 3, 'project': verifier.PROJECT}

    monkeypatch.setattr(verifier, 'SERVICE', verifier.PRODUCTION)
    monkeypatch.setattr(verifier.requests, 'get', lambda *args, **kwargs: Health())
    with pytest.raises(AssertionError):
        verifier.public()


def test_public_check_reports_and_compares_the_source_commit(monkeypatch):
    commit = '0123456789abcdef0123456789abcdef01234567'

    class Health:
        status_code = 200

        def json(self):
            return {'status': 'healthy', 'schema_version': 3, 'source_commit': commit}

    monkeypatch.setattr(verifier, 'SERVICE', verifier.PRODUCTION)
    monkeypatch.setattr(verifier.requests, 'get', lambda *args, **kwargs: Health())
    monkeypatch.setattr(verifier, 'EXPECTED_COMMIT', 'f' * 40)
    with pytest.raises(RuntimeError, match='not the expected'):
        verifier.public()
    monkeypatch.setattr(verifier, 'EXPECTED_COMMIT', commit)
    assert verifier.source_commit({'source_commit': commit}) == commit
    with pytest.raises(RuntimeError, match='not reported'):
        verifier.source_commit({})
    monkeypatch.setattr(verifier, 'EXPECTED_COMMIT', None)
    assert verifier.source_commit({'source_commit': 'unknown'}) == 'unknown'
    assert 'not reported' in verifier.source_commit({})


@pytest.mark.parametrize('value', ['abc123', 'F' * 40, 'f' * 40 + '-other', 'unknown'])
def test_expected_commit_must_be_a_full_hash(monkeypatch, value):
    monkeypatch.setattr(
        sys, 'argv', ['verifier', '--production', '--public', '--expect-commit', value]
    )
    monkeypatch.setattr(
        verifier, 'public', lambda: pytest.fail('Ran with an invalid expected commit')
    )
    with pytest.raises(SystemExit):
        verifier.cli()


def test_owner_guard_survives_optimized_python():
    # python -O strips assert statements, so a deletion guard must be an explicit raise.
    code = """
import sys
from types import SimpleNamespace
from scripts import verify_live_release as v
class Other:
    status_code = 200
    def json(self): return {'fields': {'owner_uid': {'stringValue': 'someone-else'}}, 'updateTime': 't'}
class Missing:
    status_code = 404
v.access_token = lambda: 'admin-in-memory'
v.requests.get = lambda path, **kw: Missing() if '/_memberships/' in path or '/_workspace_' in path else Other()
def deleted(*args, **kw): sys.exit(3)
v.requests.delete = deleted
try: v.cleanup_synthetic('staff', ['ADR-INS-' + 'a' * 32], [])
except RuntimeError: sys.exit(0)
sys.exit(4)
"""
    result = subprocess.run([sys.executable, '-O', '-c', code], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_gcloud_resolves_from_environment_or_path(monkeypatch, tmp_path):
    from scripts import verify_common

    monkeypatch.setenv('ADR_GCLOUD', '/opt/gcloud')
    assert verify_common.gcloud() == '/opt/gcloud'
    monkeypatch.delenv('ADR_GCLOUD')
    monkeypatch.setenv('PATH', str(tmp_path))
    with pytest.raises(RuntimeError, match='ADR_GCLOUD'):
        verify_common.gcloud()


def test_live_prompt_fixture_ships_with_tests():
    from scripts import verify_common

    assert (verify_common.FIXTURES / 'live-prompt.wav').is_file()


def test_gcloud_access_token_is_cached_only_until_its_real_expiry(monkeypatch):
    calls = []
    lifetimes = {'token-1': 3600, 'token-2': 360, 'token-3': 60, 'token-4': 3000}
    checked = []

    def lookup(command, **kwargs):
        calls.append(command)
        return subprocess.CompletedProcess(command, 0, stdout=f'token-{len(calls)}\n')

    def tokeninfo(url, data=None, timeout=None, **kwargs):
        assert url == verifier.TOKEN_INFO and data['access_token'] not in url and timeout
        checked.append(data['access_token'])
        return SimpleNamespace(ok=True, json=lambda: {'expires_in': str(lifetimes[data['access_token']])})

    clock = [1000.0]
    monkeypatch.setattr(verifier, '_token_cache', None)
    monkeypatch.setattr(verifier, 'gcloud', lambda: 'gcloud')
    monkeypatch.setattr(verifier.subprocess, 'run', lookup)
    monkeypatch.setattr(verifier.requests, 'post', tokeninfo)
    monkeypatch.setattr(verifier.time, 'monotonic', lambda: clock[0])
    assert verifier.access_token() == verifier.access_token() == 'token-1'
    assert len(calls) == 1 and calls[0][:3] == ['gcloud', 'auth', 'print-access-token']
    clock[0] += verifier.TOKEN_LIFETIME + 1
    assert verifier.access_token() == 'token-2' and len(calls) == 2
    clock[0] += 360 - verifier.TOKEN_MARGIN - 1
    assert verifier.access_token() == 'token-2' and len(calls) == 2
    clock[0] += 2
    assert verifier.access_token() == 'token-4' and len(calls) == 4
    assert checked == ['token-1', 'token-2', 'token-3', 'token-4']


def test_failed_token_lifetime_lookup_never_reveals_the_token(monkeypatch):
    monkeypatch.setattr(verifier, '_token_cache', None)
    monkeypatch.setattr(verifier, 'gcloud', lambda: 'gcloud')
    monkeypatch.setattr(
        verifier.subprocess,
        'run',
        lambda command, **kwargs: subprocess.CompletedProcess(command, 0, stdout='secret-token\n'),
    )
    monkeypatch.setattr(
        verifier.requests, 'post', lambda *a, **k: SimpleNamespace(ok=False, json=lambda: {})
    )
    with pytest.raises(RuntimeError) as error:
        verifier.access_token()
    assert 'secret-token' not in str(error.value) and verifier._token_cache is None
