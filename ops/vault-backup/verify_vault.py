"""Compare one day's manifest receipts with vault object metadata.

The owner runs this. It prints pass and fail counts only. It does not print
object names, checksums, or file bodies, and it does not download photo bytes.
The backup job's identity cannot read the vault, so this is not part of that job.
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.parse
import urllib.request

VAULT_BUCKET = 'alert-disaster-vault-backups'
MAX_BYTES = 32 * 1024 * 1024


def _generation(value):
    if isinstance(value, bool) or value is None:
        return None
    text = str(value)
    if not text.isdigit() or text.startswith('0'):
        return None
    return text


def _receipts(manifest):
    if not isinstance(manifest, dict):
        return None
    evidence = manifest.get('evidence')
    if not isinstance(evidence, dict):
        return None
    receipts = evidence.get('receipts')
    if not isinstance(receipts, list):
        return None
    for item in receipts:
        if not isinstance(item, dict):
            return None
        for field in ('name', 'crc32c', 'source_name', 'source_crc32c'):
            if not isinstance(item.get(field), str) or not item[field]:
                return None
        if item['source_name'].startswith('/'):
            return None
        for field in ('generation', 'source_generation'):
            if _generation(item.get(field)) is None:
                return None
        size = item.get('size')
        if isinstance(size, bool) or not isinstance(size, (str, int)):
            return None
        if not str(size).isascii() or not str(size).isdigit():
            return None
        for field in ('md5Hash', 'source_md5Hash'):
            if field in item and (not isinstance(item[field], str) or not item[field]):
                return None
    return receipts


def _matches(receipt, meta):
    if not isinstance(meta, dict):
        return False
    source_name = receipt['source_name']
    source_generation = _generation(receipt['source_generation'])
    source_crc = receipt['source_crc32c']
    expected = f'evidence/{source_generation}/{source_name}'
    if receipt.get('name') != expected or meta.get('name') != expected:
        return False
    if meta.get('bucket') != VAULT_BUCKET:
        return False
    if _generation(meta.get('generation')) != _generation(receipt.get('generation')):
        return False
    if str(meta.get('size')) != str(receipt.get('size')):
        return False
    if meta.get('crc32c') != receipt.get('crc32c') or meta.get('crc32c') != source_crc:
        return False
    copied_md5 = receipt.get('md5Hash')
    if copied_md5 is not None and meta.get('md5Hash') != copied_md5:
        return False
    source_md5 = receipt.get('source_md5Hash')
    if source_md5 is not None and source_md5 != copied_md5:
        return False
    return True


def evaluate(manifest, metadata_for):
    receipts = _receipts(manifest)
    if receipts is None:
        raise ValueError('manifest')
    passed = failed = 0
    for receipt in receipts:
        meta = metadata_for(receipt['name'])
        if _matches(receipt, meta):
            passed += 1
        else:
            failed += 1
    return passed, failed


def _request(transport, token, url):
    headers = {'Authorization': f'Bearer {token}'}
    status, raw = transport('GET', url, headers, None)
    if status != 200 or not isinstance(raw, bytes) or len(raw) > MAX_BYTES:
        raise OSError(status)
    return raw


def _object_url(name, query):
    return (
        'https://storage.googleapis.com/storage/v1/b/'
        + urllib.parse.quote(VAULT_BUCKET, safe='')
        + '/o/'
        + urllib.parse.quote(name, safe='')
        + '?'
        + urllib.parse.urlencode(query)
    )


def _load(transport, token, day):
    manifest_name = f'manifests/{day}.json'
    raw = _request(transport, token, _object_url(manifest_name, {'alt': 'media'}))
    manifest = json.loads(raw.decode('utf-8'))
    receipts = _receipts(manifest)
    if receipts is None:
        raise ValueError('manifest')

    def metadata_for(name):
        if not isinstance(name, str):
            return None
        try:
            body = _request(
                transport,
                token,
                _object_url(name, {'fields': 'bucket,name,generation,size,crc32c,md5Hash'}),
            )
        except (OSError, UnicodeError, json.JSONDecodeError):
            return None
        try:
            payload = json.loads(body.decode('utf-8'))
        except (UnicodeError, json.JSONDecodeError):
            return None
        return payload if isinstance(payload, dict) else None

    return manifest, metadata_for


def _gcloud_token():
    import subprocess

    proc = subprocess.run(
        ['gcloud', 'auth', 'print-access-token'],
        capture_output=True,
        check=False,
        text=True,
    )
    token = proc.stdout.strip()
    if proc.returncode != 0 or not token or '\n' in token:
        raise OSError(proc.returncode)
    return token


def _urlopen_transport(method, url, headers, body):
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return response.status, response.read(MAX_BYTES + 1)
    except urllib.error.HTTPError as error:
        return error.code, error.read(MAX_BYTES + 1)


def _counts(passed, failed, stdout):
    checked = passed + failed
    print(f'checked={checked} passed={passed} failed={failed}', file=stdout)


def _unread(stdout):
    # An unreadable manifest is not a compared receipt, so checked stays 0.
    print('checked=0 passed=0 failed=1', file=stdout)


def main(argv=None, *, transport=None, token=None, stdout=None):
    args = list(sys.argv[1:] if argv is None else argv)
    out = stdout or sys.stdout
    if len(args) != 2 or args[0] != '--date':
        _unread(out)
        return 1
    day = args[1]
    parts = day.split('-')
    if [len(part) for part in parts] != [4, 2, 2] or not ''.join(parts).isdigit():
        _unread(out)
        return 1
    try:
        if transport is None:
            transport = _urlopen_transport
        if token is None:
            token = _gcloud_token()
        manifest, metadata_for = _load(transport, token, day)
        passed, failed = evaluate(manifest, metadata_for)
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError, TypeError):
        _unread(out)
        return 1
    _counts(passed, failed, out)
    return 1 if failed else 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except urllib.error.URLError:
        print('checked=0 passed=0 failed=1')
        raise SystemExit(1) from None
