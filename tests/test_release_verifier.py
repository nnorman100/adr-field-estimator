"""Credential handling and boundaries for the normal-sign-in release verifier."""
import argparse
import io
import subprocess
import sys
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
    monkeypatch.setattr(verifier, 'check', lambda *args: dict(project='other', uid='staff', live_protocol_version=2))
    with pytest.raises(RuntimeError):
        verifier.staff_session(io.StringIO('memory-token\n'))


def test_credentials_cannot_be_forwarded_to_another_service():
    assert verifier.service_url(verifier.PRODUCTION) == verifier.PRODUCTION
    assert verifier.service_url(verifier.STAGED) == verifier.STAGED
    with pytest.raises(argparse.ArgumentTypeError):
        verifier.service_url('https://untrusted.example/api')


def test_preflight_preserves_existing_capture(monkeypatch):
    monkeypatch.setattr(verifier, 'private_document', lambda *args: {'expires': {'doubleValue': 9999999999}})
    with pytest.raises(RuntimeError, match='was not changed'):
        verifier.no_existing_capture('staff')


def test_synthetic_cleanup_checks_owner_before_deleting(monkeypatch):
    monkeypatch.setattr(verifier, 'access_token', lambda: 'admin-in-memory')
    class Other:
        status_code = 200
        def json(self):
            return {'fields': {'owner_uid': {'stringValue': 'someone-else'}}}
    class Missing:
        status_code=404
    monkeypatch.setattr(verifier.requests, 'get', lambda path, **kwargs: Missing() if '/_memberships/' in path or '/_workspace_' in path else Other())
    monkeypatch.setattr(verifier.requests, 'delete', lambda *args, **kwargs: pytest.fail('Wrong owner deleted'))
    with pytest.raises(RuntimeError):
        verifier.cleanup_synthetic('staff', ['ADR-INS-' + 'a' * 32], [])


def test_checkpoint_cleanup_preserves_another_inspection(monkeypatch):
    monkeypatch.setattr(verifier, 'access_token', lambda: 'admin-memory')
    class Capture:
        status_code = 200
        def json(self):
            return {'fields': {'owner_uid': {'stringValue': 'staff'},
                               'inspection_id': {'stringValue': 'ADR-INS-' + 'b' * 32}},
                    'updateTime': 'test-version'}
    monkeypatch.setattr(verifier.requests, 'get', lambda *args, **kwargs: Capture())
    monkeypatch.setattr(verifier.requests, 'delete', lambda *args, **kwargs: pytest.fail('Another inspection checkpoint deleted'))
    verifier.cleanup_test_checkpoint('staff', ['ADR-INS-' + 'a' * 32])


def test_checkpoint_cleanup_is_conditional_on_unchanged_version(monkeypatch):
    monkeypatch.setattr(verifier, 'access_token', lambda: 'admin-memory')
    class Capture:
        status_code = 200
        def json(self):
            return {'fields': {'owner_uid': {'stringValue': 'staff'},
                               'inspection_id': {'stringValue': 'ADR-INS-' + 'a' * 32}},
                    'updateTime': 'test-version'}
    calls = []
    class Changed:
        status_code = 412
    monkeypatch.setattr(verifier.requests, 'get', lambda *args, **kwargs: Capture())
    monkeypatch.setattr(verifier.requests, 'delete', lambda *args, **kwargs: calls.append(kwargs) or Changed())
    verifier.cleanup_test_checkpoint('staff', ['ADR-INS-' + 'a' * 32])
    assert calls[0]['params'] == {'currentDocument.updateTime': 'test-version'}


@pytest.mark.parametrize('collection,identifier,valid', [
    ('authorizations', 'ADR-AUTH-12345678-1234-4321-8321-123456789abc', True),
    ('authorizations', 'ADR-AUTH-' + 'a' * 32, True),
    ('inspections', 'ADR-INS-' + 'b' * 32, True),
    ('authorizations', 'ADR-AUTH-12345678-1234-4321-8321-123456789abc/other', False),
    ('authorizations', 'ADR-AUTH-../../other', False),
    ('inspections', 'ADR-INS-12345678-1234-4321-8321-123456789abc', False),
])
def test_synthetic_cleanup_accepts_app_uuid_without_broadening_paths(collection, identifier, valid):
    assert verifier.valid_synthetic_identifier(collection, identifier) is valid


def test_invalid_cleanup_target_is_rejected_before_admin_calls(monkeypatch):
    monkeypatch.setattr(verifier, 'access_token', lambda: pytest.fail('Invalid path reached admin lookup'))
    with pytest.raises(RuntimeError, match='Unexpected synthetic identifier'):
        verifier.cleanup_synthetic('staff', [], ['ADR-AUTH-../../other'])


def test_only_read_only_scope_extraction_retries_one_server_timeout(monkeypatch):
    monkeypatch.setattr(verifier, 'SERVICE', verifier.STAGED)
    calls = []
    waits = []
    class Response:
        def __init__(self, status):self.status_code = status
        def json(self):return {'changes': []}
    results = iter([Response(504), Response(200)])
    def request(*args, **kwargs):
        calls.append((args, kwargs))
        return next(results)
    monkeypatch.setattr(verifier.requests, 'request', request)
    monkeypatch.setattr(verifier.time, 'sleep', waits.append)
    body = {'inspection_id': 'ADR-INS-' + 'a' * 32, 'expected_revision': 1}
    assert verifier.check('POST', '/api/inspections/test/scope-suggestions', 'memory-token', body) == {'changes': []}
    assert len(calls) == 2 and calls[0] == calls[1] and waits == [2]


def test_write_timeout_is_not_automatically_replayed(monkeypatch):
    monkeypatch.setattr(verifier, 'SERVICE', verifier.STAGED)
    calls = []
    class Response:
        status_code = 504
    def request(*args, **kwargs):calls.append(args);return Response()
    monkeypatch.setattr(verifier.requests, 'request', request)
    monkeypatch.setattr(verifier.time, 'sleep', lambda *_: pytest.fail('Write retried'))
    with pytest.raises(RuntimeError, match='HTTP 504'):
        verifier.check('POST', '/api/authorize', 'memory-token', {'auth_id': 'synthetic'})
    assert len(calls) == 1


def test_company_sidecar_cleanup_rejects_foreign_tenant_before_deletion(monkeypatch):
    class Response:
        status_code=200
        def __init__(self,fields):self.fields=fields
        def json(self):return {'fields':self.fields,'updateTime':'version'}
    def get(path,**kwargs):
        return Response({'company_id':{'stringValue':'adr'}}) if '/_memberships/' in path else Response({'company_id':{'stringValue':'another-company'},'creator_uid':{'stringValue':'staff'}})
    monkeypatch.setattr(verifier.requests,'get',get)
    monkeypatch.setattr(verifier.requests,'delete',lambda *args,**kwargs:pytest.fail('Foreign tenant deleted'))
    with pytest.raises(RuntimeError):verifier.synthetic_sidecars({},'staff',['ADR-INS-'+'a'*32],[])


@pytest.mark.parametrize('module,argv,entry', [
    (verifier, ['--public'], 'public'),
    (verifier, ['--token-stdin'], 'main'),
])
def test_verifiers_refuse_to_run_without_an_explicit_target(monkeypatch, module, argv, entry):
    monkeypatch.setattr(module, entry, lambda *args: pytest.fail('Ran against a default target'))
    monkeypatch.setattr(sys, 'argv', ['verifier'] + argv)
    with pytest.raises(SystemExit) as exited:
        module.cli()
    assert exited.value.code != 0


def test_public_check_accepts_only_the_trimmed_health_payload(monkeypatch):
    class Health:
        status_code = 200
        def json(self): return {'status': 'healthy', 'schema_version': 3, 'project': verifier.PROJECT}
    monkeypatch.setattr(verifier, 'SERVICE', verifier.PRODUCTION)
    monkeypatch.setattr(verifier.requests, 'get', lambda *args, **kwargs: Health())
    with pytest.raises(AssertionError):
        verifier.public()


def test_owner_guard_survives_optimized_python():
    # python -O strips assert statements, so a deletion guard must be an explicit raise.
    code = """
import sys
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
