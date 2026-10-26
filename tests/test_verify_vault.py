"""Owner receipt check. The fake transport never calls Google."""

import importlib.util
import io
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JOB_DIR = ROOT / 'ops' / 'vault-backup'
sys.path.insert(0, str(JOB_DIR))
verify_vault = importlib.import_module('verify_vault')
vault_backup = importlib.import_module('vault_backup')

SOURCE = 'users/secret-user/inspections/job/photo.jpg'
DEST = f'evidence/11/{SOURCE}'
SECRET = 'users/secret-user'


def receipt():
    return {
        'name': DEST,
        'generation': '2001',
        'size': '100',
        'crc32c': 'crc-a',
        'md5Hash': 'md5-a',
        'source_name': SOURCE,
        'source_generation': '11',
        'source_crc32c': 'crc-a',
        'source_md5Hash': 'md5-a',
    }


def manifest(item=None):
    return {
        'evidence': {
            'receipts': [receipt() if item is None else item],
        }
    }


def meta():
    return {
        'bucket': verify_vault.VAULT_BUCKET,
        'name': DEST,
        'generation': '2001',
        'size': '100',
        'crc32c': 'crc-a',
        'md5Hash': 'md5-a',
    }


class Store:
    def __init__(self, item=None, object_meta=None, fail=None):
        self.item = receipt() if item is None else item
        self.object_meta = meta() if object_meta is None else object_meta
        self.fail = fail
        self.calls = []

    def __call__(self, method, url, headers, body):
        self.calls.append(url)
        if self.fail == 'manifest' and 'alt=media' in url:
            return 500, b'hidden users/secret-user'
        if 'alt=media' in url:
            payload = {'evidence': {'receipts': [self.item]}}
            return 200, json.dumps(payload).encode()
        if self.fail == 'object':
            return 404, b'hidden users/secret-user'
        return 200, json.dumps(self.object_meta).encode()


def run_verify(store):
    stdout = io.StringIO()
    code = verify_vault.main(
        ['--date', '2026-10-26'],
        transport=store,
        token='TOKEN-PRIVATE',
        stdout=stdout,
    )
    text = stdout.getvalue()
    return code, text


def test_bucket_constant_matches_the_job():
    assert verify_vault.VAULT_BUCKET == vault_backup.VAULT_BUCKET


def test_matching_receipt_passes_and_prints_counts_only():
    code, text = run_verify(Store())
    assert code == 0
    assert text == 'checked=1 passed=1 failed=0\n'
    assert SECRET not in text
    assert 'crc-a' not in text


def test_generation_mismatch_fails_without_naming_the_object():
    object_meta = meta()
    object_meta['generation'] = '2002'
    code, text = run_verify(Store(object_meta=object_meta))
    assert code == 1
    assert text == 'checked=1 passed=0 failed=1\n'
    assert SECRET not in text


def test_missing_source_identity_fails():
    item = receipt()
    del item['source_generation']
    code, text = run_verify(Store(item=item))
    assert code == 1
    assert text == 'checked=1 passed=0 failed=1\n'
    assert SECRET not in text


def test_metadata_failure_is_a_failed_receipt():
    code, text = run_verify(Store(fail='object'))
    assert code == 1
    assert text == 'checked=1 passed=0 failed=1\n'
    assert SECRET not in text


def test_unreadable_manifest_prints_no_body():
    code, text = run_verify(Store(fail='manifest'))
    assert code == 1
    assert text == 'checked=0 passed=0 failed=1\n'
    assert SECRET not in text
