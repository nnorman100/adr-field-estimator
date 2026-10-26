"""Vault backup job with a fake HTTP transport. No Google calls."""

import importlib.util
import io
import json
import sys
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JOB_DIR = ROOT / 'ops' / 'vault-backup'
sys.path.insert(0, str(JOB_DIR))
auth_export = importlib.import_module('auth_export')
vault_backup = importlib.import_module('vault_backup')

PHOTO_A = {
    'name': 'users/secret-user/inspections/job/photo.jpg',
    'generation': '11',
    'size': '100',
    'crc32c': 'crc32c-PRIVATE-A',
    'md5Hash': 'md5-PRIVATE-A',
}
PHOTO_B = {
    'name': 'users/secret-user/inspections/job/other.jpg',
    'generation': '22',
    'size': '250',
    'crc32c': 'crc32c-PRIVATE-B',
    'md5Hash': 'md5-PRIVATE-B',
}
ACCOUNT = {
    'localId': 'user-1',
    'email': 'hidden@example.test',
    'emailVerified': True,
    'passwordHash': 'ab-c_d==',
    'salt': 's_a-lt',
    'version': 0,
    'passwordUpdatedAt': 1,
    'lastLoginAt': '5',
    'createdAt': '4',
    'displayName': 'Secret Name',
    'providerUserInfo': [
        {'providerId': 'password', 'rawId': 'hidden@example.test', 'federatedId': 'drop-me'},
        {
            'providerId': 'google.com',
            'rawId': 'g1',
            'email': 'hidden@example.test',
            'displayName': 'Secret Name',
            'photoUrl': 'p',
        },
    ],
}
GOOGLE_ONLY = {'localId': 'user-google', 'email': 'hidden@example.test', 'emailVerified': True}
SECRETS = (
    'PRIVATE_PHOTO',
    'hidden@example.test',
    'ab-c_d==',
    'ab+c/d==',
    'TOKEN-PRIVATE',
    'users/secret-user',
    'passwordHash',
    'crc32c-PRIVATE',
    'md5-PRIVATE',
    'Secret Name',
)
WHEN = datetime(2026, 10, 26, 11, 15, tzinfo=timezone.utc)


def dest_of(item):
    return f'evidence/{item["generation"]}/{item["name"]}'


class Gateway:
    def __init__(
        self,
        auth_pages=None,
        source_pages=None,
        existing=(),
        fail=None,
        receipt=None,
        rewrite_parts=1,
    ):
        self.auth_pages = [{'users': [ACCOUNT]}] if auth_pages is None else auth_pages
        self.source_pages = [{'items': [PHOTO_A]}] if source_pages is None else source_pages
        self.existing = set(existing)
        self.fail = fail
        self.receipt = receipt
        self.rewrite_parts = rewrite_parts
        self.rewrite_counts = {}
        self.calls = []
        self.stored = []
        self.bodies = {}
        self.auth_i = 0
        self.list_i = 0

    def __call__(self, method, url, headers, body):
        self.calls.append({'method': method, 'url': url, 'headers': dict(headers), 'body': body})
        if url.startswith('http://metadata.google.internal/'):
            return 200, b'{"access_token":"TOKEN-PRIVATE"}'
        if 'downloadAccount' in url:
            return self._auth()
        if method == 'GET' and '/storage/v1/b/' in url:
            return self._list()
        if '/rewriteTo/' in url:
            return self._rewrite(url)
        if url.startswith('https://storage.googleapis.com/upload/'):
            return self._upload(url, body)
        return 404, b'unexpected-url'

    def _maybe_fail(self, kind):
        fail = self.fail
        if not fail or fail.get('match') != kind:
            return None
        fail['seen'] = fail.get('seen', 0) + 1
        if fail['seen'] != fail.get('on', 1):
            return None
        body = fail.get('body', b'PRIVATE_PHOTO hidden@example.test ab-c_d==')
        if isinstance(body, str):
            body = body.encode()
        return fail.get('status', 500), body

    def _precondition(self):
        body = {
            'error': {
                'code': 412,
                'message': 'precondition',
                'errors': [{'reason': 'conditionNotMet'}],
            }
        }
        return 412, json.dumps(body).encode()

    def _auth(self):
        failed = self._maybe_fail('export')
        if failed:
            return failed
        page = self.auth_pages[self.auth_i]
        self.auth_i += 1
        return 200, json.dumps(page).encode()

    def _list(self):
        failed = self._maybe_fail('list')
        if failed:
            return failed
        page = self.source_pages[self.list_i]
        self.list_i += 1
        return 200, json.dumps(page).encode()

    def _source_for_dest(self, dest):
        _prefix, _, rest = dest.partition('/')
        generation, _, name = rest.partition('/')
        for page in self.source_pages:
            for item in page.get('items', []):
                if item['name'] == name and str(item['generation']) == generation:
                    return item
        raise AssertionError(dest)

    def _rewrite(self, url):
        failed = self._maybe_fail('copy')
        if failed:
            return failed
        path, _, query = url.partition('?')
        encoded = path.split('/rewriteTo/b/', 1)[1].split('/o/', 1)[1]
        dest = urllib.parse.unquote(encoded)
        if 'ifGenerationMatch=0' not in query:
            return 400, b'missing-precondition'
        if 'rewriteToken=' not in query and dest in self.existing:
            return self._precondition()
        seen = self.rewrite_counts.get(dest, 0) + 1
        self.rewrite_counts[dest] = seen
        if seen < self.rewrite_parts:
            return 200, json.dumps(
                {'done': False, 'rewriteToken': f'part-{seen}', 'totalBytesRewritten': '1'}
            ).encode()
        item = self._source_for_dest(dest)
        resource = {
            'bucket': vault_backup.VAULT_BUCKET,
            'name': dest,
            'generation': str(2000 + len(self.stored)),
            'size': str(item['size']),
            'crc32c': item['crc32c'],
            'md5Hash': item['md5Hash'],
        }
        if self.receipt and self.receipt['target'] == 'copy':
            resource.update(self.receipt['resource'])
        self.existing.add(dest)
        self.stored.append(dest)
        return 200, json.dumps({'done': True, 'resource': resource}).encode()

    def _upload(self, url, body):
        query = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
        name = query['name'][0]
        if query.get('ifGenerationMatch') != ['0'] or query.get('uploadType') != ['media']:
            return 400, b'missing-precondition'
        kind = 'upload_auth' if name.startswith('auth/') else 'upload_manifest'
        failed = self._maybe_fail(kind)
        if failed:
            return failed
        if name in self.existing:
            return self._precondition()
        resource = {
            'bucket': vault_backup.VAULT_BUCKET,
            'name': name,
            'generation': str(3000 + len(self.stored)),
            'size': str(len(body)),
        }
        if self.receipt and self.receipt['target'] == kind:
            resource.update(self.receipt['resource'])
        self.existing.add(name)
        self.stored.append(name)
        self.bodies[name] = body
        return 200, json.dumps(resource).encode()


def run(gateway, when=WHEN, token='TOKEN-PRIVATE'):
    stdout, stderr = io.StringIO(), io.StringIO()
    code = vault_backup.main(transport=gateway, now=when, token=token, stdout=stdout, stderr=stderr)
    logs = [json.loads(line) for line in stdout.getvalue().splitlines() if line]
    errors = [json.loads(line) for line in stderr.getvalue().splitlines() if line]
    return code, logs, errors, gateway


def assert_private(logs, errors):
    text = json.dumps({'logs': logs, 'errors': errors})
    for secret in SECRETS:
        assert secret not in text
    allowed = vault_backup.LOG_FIELDS | {'severity', 'message', 'event'}
    for entry in logs + errors:
        assert set(entry) <= allowed
        assert entry['event'] == 'vault_backup'
        assert entry['bucket'] == vault_backup.VAULT_BUCKET


def assert_create_only(gateway):
    for call in gateway.calls:
        assert call['method'] in {'GET', 'POST'}
        assert 'alt=media' not in call['url']
        if call['method'] == 'POST' and 'metadata.google.internal' not in call['url']:
            if 'downloadAccount' not in call['url']:
                assert 'ifGenerationMatch=0' in call['url']
        if '/rewriteTo/' in call['url']:
            assert call['body'] == b''
            assert vault_backup.SOURCE_BUCKET in call['url']
            assert vault_backup.VAULT_BUCKET in call['url']
        if call['url'].startswith('https://storage.googleapis.com/upload/'):
            assert vault_backup.VAULT_BUCKET in call['url']
            assert vault_backup.SOURCE_BUCKET not in call['url']


def auth_record(gateway, day='2026-10-26'):
    return json.loads(gateway.bodies[f'auth/{day}.json'])['users']


def manifest_of(gateway, day='2026-10-26'):
    return json.loads(gateway.bodies[f'manifests/{day}.json'])


def test_records_match_firebase_export_shape():
    record = auth_export.to_import_record(ACCOUNT)
    assert record['passwordHash'] == 'ab+c/d=='
    assert record['salt'] == 's/a+lt'
    assert record['lastSignedInAt'] == '5'
    assert 'lastLoginAt' not in record
    assert record['providerUserInfo'] == [
        {
            'providerId': 'google.com',
            'rawId': 'g1',
            'email': 'hidden@example.test',
            'displayName': 'Secret Name',
            'photoUrl': 'p',
        }
    ]
    # version other than 0 drops the hash; the backup must refuse that record.
    assert 'passwordHash' not in auth_export.to_import_record({**ACCOUNT, 'version': 1})


def test_password_account_without_a_hash_fails_before_any_write():
    page = {'users': [{**ACCOUNT, 'passwordHash': None}]}
    code, logs, errors, gateway = run(Gateway(auth_pages=[page]))
    assert code == 1
    assert logs == []
    assert errors[0]['outcome'] == 'failed'
    assert errors[0]['stage'] == 'export'
    assert 'http_status' not in errors[0]
    assert gateway.stored == []
    assert_private(logs, errors)


def test_version_that_drops_the_hash_fails_the_export():
    code, logs, errors, gateway = run(Gateway(auth_pages=[{'users': [{**ACCOUNT, 'version': 1}]}]))
    assert code == 1
    assert errors[0]['stage'] == 'export'
    assert gateway.stored == []
    assert_private(logs, errors)


def test_incremental_copy_and_a_later_generation():
    code, logs, errors, gateway = run(Gateway(source_pages=[{'items': [PHOTO_A, PHOTO_B]}]))
    assert code == 0 and errors == []
    assert logs[0]['outcome'] == 'created'
    assert logs[0]['copied'] == 2
    assert logs[0]['already_present'] == 0
    assert logs[0]['bytes_copied'] == 350
    assert logs[0]['users'] == 1
    assert logs[0]['auth_object'] == 'auth/2026-10-26.json'
    assert logs[0]['auth_outcome'] == 'created'
    assert logs[0]['auth_generation'] == '3000'
    assert logs[0]['manifest_outcome'] == 'created'
    assert dest_of(PHOTO_A) in gateway.stored
    assert dest_of(PHOTO_B) in gateway.stored
    assert_create_only(gateway)
    record = auth_record(gateway)[0]
    assert record['passwordHash'] == 'ab+c/d=='
    manifest = manifest_of(gateway)
    assert manifest['evidence']['copied'] == 2
    assert manifest['evidence']['layout'] == 'evidence/<source-generation>/<source-object-name>'
    assert manifest['auth']['users'] == 1
    assert_private(logs, errors)
    manifest_text = gateway.bodies['manifests/2026-10-26.json'].decode()
    for secret in SECRETS:
        assert secret not in manifest_text

    changed = {**PHOTO_B, 'generation': '33', 'size': '251', 'crc32c': 'crc32c-PRIVATE-C'}
    second = Gateway(
        source_pages=[{'items': [PHOTO_A, changed]}],
        existing=list(gateway.stored),
    )
    code, logs, errors, gateway = run(second)
    assert code == 0 and errors == []
    assert logs[0]['copied'] == 1
    assert logs[0]['already_present'] == 1
    assert logs[0]['bytes_copied'] == 251
    assert logs[0]['auth_outcome'] == 'already_exists'
    assert 'auth_generation' not in logs[0]
    assert gateway.stored == [dest_of(changed)]
    assert dest_of(PHOTO_B) in gateway.existing
    assert_private(logs, errors)
    assert_create_only(gateway)


def test_already_present_objects_are_not_rewritten():
    present = [
        'auth/2026-10-26.json',
        'manifests/2026-10-26.json',
        dest_of(PHOTO_A),
        dest_of(PHOTO_B),
    ]
    code, logs, errors, gateway = run(
        Gateway(source_pages=[{'items': [PHOTO_A, PHOTO_B]}], existing=present)
    )
    assert code == 0 and errors == []
    assert logs[0]['outcome'] == 'already_exists'
    assert logs[0]['copied'] == 0
    assert logs[0]['already_present'] == 2
    assert logs[0]['bytes_copied'] == 0
    assert logs[0]['auth_outcome'] == 'already_exists'
    assert logs[0]['manifest_outcome'] == 'already_exists'
    assert gateway.stored == []
    assert_private(logs, errors)


def test_same_day_rerun_still_copies_a_new_photo():
    code, logs, errors, gateway = run(
        Gateway(
            source_pages=[{'items': [PHOTO_A]}],
            existing=['auth/2026-10-26.json', dest_of(PHOTO_B)],
        )
    )
    assert code == 0 and errors == []
    assert logs[0]['auth_outcome'] == 'already_exists'
    assert logs[0]['copied'] == 1
    assert gateway.stored == [dest_of(PHOTO_A), 'manifests/2026-10-26.json']
    assert_private(logs, errors)


def test_utc_date_comes_from_the_start_of_the_run():
    when = datetime.fromisoformat('2026-10-26T23:30:00-07:00')
    code, logs, errors, gateway = run(Gateway(source_pages=[{'items': []}]), when=when)
    assert code == 0 and errors == []
    assert logs[0]['auth_object'] == 'auth/2026-10-27.json'
    assert logs[0]['manifest_object'] == 'manifests/2026-10-27.json'
    assert logs[0]['copied'] == 0
    manifest = manifest_of(gateway, '2026-10-27')
    assert manifest['date'] == '2026-10-27'
    assert manifest['started'] == '2026-10-27T06:30:00Z'
    assert_private(logs, errors)


def test_auth_and_evidence_pages_follow_tokens():
    pages = [
        {'users': [GOOGLE_ONLY], 'nextPageToken': 'auth-2'},
        {'users': [ACCOUNT]},
    ]
    sources = [
        {'items': [PHOTO_A], 'nextPageToken': 'list-2'},
        {'items': [PHOTO_B]},
    ]
    code, logs, errors, gateway = run(Gateway(auth_pages=pages, source_pages=sources))
    assert code == 0 and errors == []
    assert [user['localId'] for user in auth_record(gateway)] == ['user-google', 'user-1']
    assert 'passwordHash' not in auth_record(gateway)[0]
    bodies = [
        json.loads(call['body']) for call in gateway.calls if 'downloadAccount' in call['url']
    ]
    assert bodies[0] == {'targetProjectId': 'alert-disaster-field-2026', 'maxResults': 1000}
    assert bodies[1]['nextPageToken'] == 'auth-2'
    list_urls = [call['url'] for call in gateway.calls if call['method'] == 'GET']
    assert 'pageToken=list-2' in list_urls[1]
    assert logs[0]['copied'] == 2
    assert_private(logs, errors)


def test_export_page_limit_and_repeated_token_fail_closed():
    looping = {'users': [GOOGLE_ONLY], 'nextPageToken': 'again'}
    try:
        vault_backup._export_users(Gateway(auth_pages=[looping, looping]), 'token', page_limit=5)
    except vault_backup.BackupError as error:
        assert error.stage == 'export'
    else:
        raise AssertionError('repeated page token returned')
    tokens = [
        {'users': [{**GOOGLE_ONLY, 'localId': 'one'}], 'nextPageToken': 't1'},
        {'users': [{**GOOGLE_ONLY, 'localId': 'two'}], 'nextPageToken': 't2'},
        {'users': [{**GOOGLE_ONLY, 'localId': 'three'}], 'nextPageToken': 't3'},
    ]
    try:
        vault_backup._export_users(Gateway(auth_pages=tokens), 'token', page_limit=2)
    except vault_backup.BackupError as error:
        assert error.stage == 'export'
    else:
        raise AssertionError('page cap returned')


def test_rewrite_continues_until_done_and_proves_the_response():
    code, logs, errors, gateway = run(Gateway(source_pages=[{'items': [PHOTO_A]}], rewrite_parts=2))
    assert code == 0 and errors == []
    rewrites = [call['url'] for call in gateway.calls if '/rewriteTo/' in call['url']]
    assert len(rewrites) == 2
    assert 'rewriteToken=' not in rewrites[0]
    assert 'rewriteToken=part-1' in rewrites[1]
    assert gateway.stored.count(dest_of(PHOTO_A)) == 1
    assert logs[0]['copied'] == 1
    assert_private(logs, errors)


def test_write_failure_stops_the_manifest_and_keeps_the_log_clean():
    code, logs, errors, gateway = run(
        Gateway(
            source_pages=[{'items': [PHOTO_A, PHOTO_B]}],
            fail={
                'match': 'copy',
                'status': 500,
                'on': 2,
                'body': b'PRIVATE_PHOTO hidden@example.test',
            },
        )
    )
    assert code == 1
    assert logs == []
    assert errors[0]['stage'] == 'copy'
    assert errors[0]['http_status'] == 500
    assert errors[0]['copied'] == 1
    assert errors[0]['users'] == 1
    assert not any(name.startswith('manifests/') for name in gateway.stored)
    assert len([name for name in gateway.stored if name.startswith('evidence/')]) == 1
    assert_private(logs, errors)
    assert_create_only(gateway)


def test_unrelated_412_is_a_copy_failure():
    body = json.dumps({'error': {'code': 412, 'errors': [{'reason': 'unrelated'}]}})
    code, logs, errors, gateway = run(
        Gateway(
            source_pages=[{'items': [PHOTO_A]}], fail={'match': 'copy', 'status': 412, 'body': body}
        )
    )
    assert code == 1
    assert errors[0]['stage'] == 'copy'
    assert errors[0]['http_status'] == 412
    assert errors[0]['copied'] == 0
    assert not any(name.startswith('evidence/') for name in gateway.stored)
    assert_private(logs, errors)


def test_bad_receipts_fail_verification():
    cases = [
        ('upload_auth', 'verify_auth', {'bucket': 'old-backup-bucket'}),
        ('upload_auth', 'verify_auth', {'name': 'auth/2026-10-22.json'}),
        ('upload_auth', 'verify_auth', {'generation': '0'}),
        ('upload_auth', 'verify_auth', {'size': '1'}),
        ('upload_manifest', 'verify_manifest', {'size': '0'}),
        ('copy', 'verify_copy', {'crc32c': 'crc32c-WRONG'}),
        ('copy', 'verify_copy', {'md5Hash': 'md5-WRONG'}),
    ]
    for target, stage, resource in cases:
        code, logs, errors, gateway = run(
            Gateway(
                source_pages=[{'items': [PHOTO_A]}],
                receipt={'target': target, 'resource': resource},
            )
        )
        assert code == 1, target
        assert logs == []
        assert errors[0]['stage'] == stage
        assert 'http_status' not in errors[0]
        assert (
            not any(name.startswith('manifests/') for name in gateway.stored)
            or target == 'upload_manifest'
        )
        assert_private(logs, errors)


def test_auth_upload_failure_skips_evidence():
    code, logs, errors, gateway = run(
        Gateway(
            fail={
                'match': 'upload_auth',
                'status': 403,
                'body': b'PRIVATE_PHOTO hidden@example.test',
            }
        )
    )
    assert code == 1
    assert errors[0]['stage'] == 'upload_auth'
    assert errors[0]['http_status'] == 403
    assert errors[0]['users'] == 1
    assert gateway.calls[-1]['url'].startswith('https://storage.googleapis.com/upload/')
    assert not any('/rewriteTo/' in call['url'] for call in gateway.calls)
    assert_private(logs, errors)


def test_missing_hash_on_a_later_page_writes_nothing():
    pages = [
        {'users': [GOOGLE_ONLY], 'nextPageToken': 'next'},
        {'users': [{**ACCOUNT, 'passwordHash': ''}]},
    ]
    code, logs, errors, gateway = run(Gateway(auth_pages=pages))
    assert code == 1
    assert errors[0]['stage'] == 'export'
    assert gateway.stored == []
    assert_private(logs, errors)


def test_duplicate_account_fails_closed():
    pages = [
        {'users': [ACCOUNT], 'nextPageToken': 'next'},
        {'users': [ACCOUNT]},
    ]
    code, _logs, errors, gateway = run(Gateway(auth_pages=pages))
    assert code == 1
    assert errors[0]['stage'] == 'export'
    assert gateway.stored == []


def test_token_failure_stops_before_export():
    calls = []

    def transport(method, url, headers, body):
        calls.append(url)
        assert headers.get('Metadata-Flavor') == 'Google'
        return 503, b'PRIVATE_PHOTO hidden@example.test'

    stdout, stderr = io.StringIO(), io.StringIO()
    code = vault_backup.main(
        transport=transport, now=WHEN, token=None, stdout=stdout, stderr=stderr
    )
    assert code == 1
    assert calls == [vault_backup.METADATA_URL]
    error = json.loads(stderr.getvalue())
    assert error['stage'] == 'token'
    assert error['http_status'] == 503
    assert_private([], [error])


def test_exceptions_do_not_reach_the_log():
    def transport(method, url, headers, body):
        raise RuntimeError('PRIVATE_PHOTO hidden@example.test users/secret-user')

    stdout, stderr = io.StringIO(), io.StringIO()
    code = vault_backup.main(
        transport=transport, now=WHEN, token='TOKEN-PRIVATE', stdout=stdout, stderr=stderr
    )
    assert code == 1
    assert stdout.getvalue() == ''
    error = json.loads(stderr.getvalue())
    assert error['stage'] == 'internal'
    assert_private([], [error])
    naive = vault_backup.main(
        transport=Gateway(),
        now=datetime(2026, 10, 26),
        token='TOKEN-PRIVATE',
        stdout=io.StringIO(),
        stderr=io.StringIO(),
    )
    assert naive == 1


def test_google_only_user_and_empty_bucket_still_write_auth():
    code, logs, errors, gateway = run(
        Gateway(auth_pages=[{'users': [GOOGLE_ONLY]}], source_pages=[{'items': []}])
    )
    assert code == 0 and errors == []
    assert logs[0]['users'] == 1
    assert logs[0]['copied'] == 0
    assert 'passwordHash' not in auth_record(gateway)[0]
    assert_private(logs, errors)


def test_image_and_lifecycle_match_the_documented_contract():
    backend_from = next(
        line.strip()
        for line in (ROOT / 'backend' / 'Dockerfile').read_text().splitlines()
        if line.startswith('FROM ')
    )
    dockerfile = (JOB_DIR / 'Dockerfile').read_text()
    assert dockerfile.splitlines()[0] == backend_from
    assert 'pip ' not in dockerfile
    assert 'CMD ["python", "vault_backup.py"]' in dockerfile
    lifecycle = json.loads((JOB_DIR / 'lifecycle.json').read_text())
    assert lifecycle == {
        'lifecycle': {'rule': [{'action': {'type': 'Delete'}, 'condition': {'age': 90}}]}
    }
    doc = (ROOT / 'docs' / 'VAULT-BACKUP.md').read_text()
    for required in (
        'alert-disaster-vault',
        'alert-disaster-vault-backups',
        'alert-disaster-field-2026-evidence',
        'dryscope-vault-backup',
        'dryscopeVaultBackup',
        'firebaseauth.users.get',
        'firebaseauth.configs.getHashConfig',
        'roles/storage.objectViewer',
        'roles/storage.objectCreator',
        'roles/run.invoker',
        'us-central1',
        'ifGenerationMatch=0',
        '15 11 * * *',
        '545776254070',
        'ops/vault-backup/lifecycle.json',
    ):
        assert required in doc
