"""Daily DryScope vault backup. One Cloud Run task, then exit.

Writes Firebase Auth users (password hashes included) to
gs://alert-disaster-vault-backups/auth/YYYY-MM-DD.json, copies live evidence
objects with the Storage rewrite API, and writes manifests/YYYY-MM-DD.json.

The backup identity can create vault objects and cannot read them, so a changed
source object is a new key evidence/<source-generation>/<source-object-name>.
ifGenerationMatch=0 makes an unchanged generation a precondition failure rather
than an overwrite. ifSourceGenerationMatch pins the copy to the listed
generation, so a replacement cannot be stored under the old generation's name.
Photo bytes stay in Cloud Storage; this process lists metadata and uploads two
JSON objects. See docs/VAULT-BACKUP.md for the permitted log fields.

See docs/VAULT-BACKUP.md. Merging this file does not update a deployed job.
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

_DIR = str(Path(__file__).resolve().parent)
if _DIR not in sys.path:
    sys.path.insert(0, _DIR)

import auth_export

AUTH_PROJECT = 'alert-disaster-field-2026'
SOURCE_BUCKET = 'alert-disaster-field-2026-evidence'
VAULT_BUCKET = 'alert-disaster-vault-backups'
EVENT = 'vault_backup'
METADATA_URL = (
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token'
    '?scopes=' + urllib.parse.quote('https://www.googleapis.com/auth/cloud-platform', safe='')
)
AUTH_URL = 'https://www.googleapis.com/identitytoolkit/v3/relyingparty/downloadAccount'
MAX_BYTES = 32 * 1024 * 1024
PAGE_LIMIT = 10000
REWRITE_LIMIT = 64
LOG_FIELDS = frozenset(
    {
        'outcome',
        'stage',
        'bucket',
        'http_status',
        'auth_object',
        'auth_outcome',
        'auth_generation',
        'auth_bytes',
        'users',
        'manifest_object',
        'manifest_outcome',
        'manifest_generation',
        'manifest_bytes',
        'copied',
        'already_present',
        'bytes_copied',
    }
)


class BackupError(Exception):
    def __init__(self, stage, http_status=None, **counts):
        super().__init__(stage)
        self.stage = stage
        self.http_status = http_status if _http_error(http_status) else None
        self.counts = {key: value for key, value in counts.items() if value is not None}

    def fields(self):
        payload = {'outcome': 'failed', 'stage': self.stage, 'bucket': VAULT_BUCKET}
        if self.http_status is not None:
            payload['http_status'] = self.http_status
        payload.update(self.counts)
        return payload


def _http_error(status):
    return isinstance(status, int) and not isinstance(status, bool) and 400 <= status <= 599


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise BackupError('transport', code)


def _read_limited(stream):
    data = stream.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise BackupError('response')
    return data


def urllib_transport(method, url, headers, body):
    data = None if method == 'GET' else (b'' if body is None else body)
    request = urllib.request.Request(url, data=data, headers=dict(headers), method=method)
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(request, timeout=120) as response:
            return response.status, _read_limited(response)
    except BackupError:
        raise
    except urllib.error.HTTPError as error:
        return error.code, _read_limited(error)
    except urllib.error.URLError:
        raise BackupError('transport') from None


def fetch_token(transport):
    status, body = transport('GET', METADATA_URL, {'Metadata-Flavor': 'Google'}, None)
    if status != 200:
        raise BackupError('token', status)
    try:
        token = json.loads(body)['access_token']
    except (json.JSONDecodeError, KeyError, TypeError, UnicodeError):
        raise BackupError('token') from None
    if not isinstance(token, str) or not token:
        raise BackupError('token')
    return token


def _headers(token, content_type=None):
    headers = {'Authorization': f'Bearer {token}'}
    if content_type:
        headers['Content-Type'] = content_type
    return headers


def _json_object(raw, stage, status=None):
    try:
        payload = json.loads(raw.decode('utf-8'))
    except (UnicodeError, json.JSONDecodeError, AttributeError):
        raise BackupError(stage, status) from None
    if not isinstance(payload, dict) or 'error' in payload:
        raise BackupError(stage, status)
    return payload


def _condition_not_met(status, raw):
    if status != 412:
        return False
    try:
        payload = json.loads(raw.decode('utf-8'))
    except (UnicodeError, json.JSONDecodeError, AttributeError):
        return False
    errors = payload.get('error', {}).get('errors') if isinstance(payload, dict) else None
    if not isinstance(errors, list) or not errors:
        return False
    return all(
        isinstance(item, dict) and item.get('reason') == 'conditionNotMet' for item in errors
    )


def _generation(value, stage):
    if isinstance(value, bool) or value is None:
        raise BackupError(stage)
    text = str(value)
    if not text.isdigit() or text.startswith('0'):
        raise BackupError(stage)
    return text


def _size(value, stage):
    if isinstance(value, bool) or value is None:
        raise BackupError(stage)
    text = str(value)
    if not text.isdigit():
        raise BackupError(stage)
    return int(text)


def _line(severity, message, fields):
    if set(fields) - LOG_FIELDS:
        raise BackupError('internal')
    payload = {'severity': severity, 'message': message, **fields, 'event': EVENT}
    return json.dumps(payload, separators=(',', ':'))


def _export_users(transport, token, page_limit=PAGE_LIMIT):
    records = []
    seen = set()
    page_token = None
    for _ in range(page_limit):
        body = {'targetProjectId': AUTH_PROJECT, 'maxResults': 1000}
        if page_token:
            body['nextPageToken'] = page_token
        status, raw = transport(
            'POST',
            AUTH_URL,
            _headers(token, 'application/json'),
            json.dumps(body).encode('utf-8'),
        )
        if status != 200:
            raise BackupError('export', status)
        page = _json_object(raw, 'export', status)
        accounts = page.get('users', [])
        next_token = page.get('nextPageToken')
        if not isinstance(accounts, list) or (
            next_token is not None and not isinstance(next_token, str)
        ):
            raise BackupError('export')
        if not accounts:
            if next_token:
                raise BackupError('export')
            break
        try:
            converted = auth_export.records_from_accounts(accounts)
        except auth_export.ExportError:
            raise BackupError('export') from None
        for record in converted:
            if record['localId'] in seen:
                raise BackupError('export')
            seen.add(record['localId'])
        records.extend(converted)
        if not next_token:
            break
        if next_token == page_token:
            raise BackupError('export')
        page_token = next_token
    else:
        raise BackupError('export')
    return records


def _source_object(item):
    if not isinstance(item, dict):
        raise BackupError('list')
    name = item.get('name')
    if not isinstance(name, str) or not name or name.startswith('/') or '\x00' in name:
        raise BackupError('list')
    generation = _generation(item.get('generation'), 'list')
    size = _size(item.get('size'), 'list')
    crc32c = item.get('crc32c')
    if not isinstance(crc32c, str) or not crc32c:
        raise BackupError('list')
    md5 = item.get('md5Hash')
    if md5 is not None and not isinstance(md5, str):
        raise BackupError('list')
    dest = f'evidence/{generation}/{name}'
    if len(dest.encode('utf-8')) > 1024:
        raise BackupError('list')
    return {
        'name': name,
        'generation': generation,
        'size': size,
        'crc32c': crc32c,
        'md5': md5,
        'dest': dest,
    }


def _list_source(transport, token, page_limit=PAGE_LIMIT):
    objects = []
    seen = set()
    page_token = None
    base = (
        'https://storage.googleapis.com/storage/v1/b/'
        + urllib.parse.quote(SOURCE_BUCKET, safe='')
        + '/o'
    )
    for _ in range(page_limit):
        query = {
            'maxResults': '1000',
            'fields': 'items(name,generation,size,crc32c,md5Hash),nextPageToken',
        }
        if page_token:
            query['pageToken'] = page_token
        status, raw = transport(
            'GET', base + '?' + urllib.parse.urlencode(query), _headers(token), None
        )
        if status != 200:
            raise BackupError('list', status)
        page = _json_object(raw, 'list', status)
        items = page.get('items', [])
        next_token = page.get('nextPageToken')
        if not isinstance(items, list) or (
            next_token is not None and not isinstance(next_token, str)
        ):
            raise BackupError('list')
        if not items:
            if next_token:
                raise BackupError('list')
            break
        for item in items:
            obj = _source_object(item)
            if obj['name'] in seen:
                raise BackupError('list')
            seen.add(obj['name'])
            objects.append(obj)
        if not next_token:
            break
        if next_token == page_token:
            raise BackupError('list')
        page_token = next_token
    else:
        raise BackupError('list')
    objects.sort(key=lambda obj: obj['name'])
    return objects


def _prove(resource, *, bucket, name, size, stage, crc32c=None, md5=None):
    if (
        not isinstance(resource, dict)
        or resource.get('bucket') != bucket
        or resource.get('name') != name
    ):
        raise BackupError(stage)
    _generation(resource.get('generation'), stage)
    if str(resource.get('size')) != str(size):
        raise BackupError(stage)
    if crc32c is not None and resource.get('crc32c') != crc32c:
        raise BackupError(stage)
    if md5 is not None and resource.get('md5Hash') != md5:
        raise BackupError(stage)


def _source_metadata_url(name):
    return (
        'https://storage.googleapis.com/storage/v1/b/'
        + urllib.parse.quote(SOURCE_BUCKET, safe='')
        + '/o/'
        + urllib.parse.quote(name, safe='')
        + '?'
        + urllib.parse.urlencode({'fields': 'generation'})
    )


def _listed_generation_still_live(transport, token, obj):
    status, raw = transport('GET', _source_metadata_url(obj['name']), _headers(token), None)
    if status != 200:
        raise BackupError('copy', status)
    payload = _json_object(raw, 'copy', status)
    return _generation(payload.get('generation'), 'copy') == obj['generation']


def _rewrite_url(obj, rewrite_token=None):
    query = {
        'ifGenerationMatch': '0',
        'ifSourceGenerationMatch': obj['generation'],
        'sourceGeneration': obj['generation'],
    }
    if rewrite_token:
        query['rewriteToken'] = rewrite_token
    return (
        'https://storage.googleapis.com/storage/v1/b/'
        + urllib.parse.quote(SOURCE_BUCKET, safe='')
        + '/o/'
        + urllib.parse.quote(obj['name'], safe='')
        + '/rewriteTo/b/'
        + urllib.parse.quote(VAULT_BUCKET, safe='')
        + '/o/'
        + urllib.parse.quote(obj['dest'], safe='')
        + '?'
        + urllib.parse.urlencode(query)
    )


def _receipt(obj, resource):
    receipt = {
        'name': resource['name'],
        'generation': resource['generation'],
        'size': resource['size'],
        'crc32c': resource['crc32c'],
        'source_name': obj['name'],
        'source_generation': obj['generation'],
        'source_crc32c': obj['crc32c'],
    }
    if 'md5Hash' in resource:
        receipt['md5Hash'] = resource['md5Hash']
    if obj['md5'] is not None:
        receipt['source_md5Hash'] = obj['md5']
    return receipt


def _rewrite(transport, token, obj, rewrite_limit=REWRITE_LIMIT):
    rewrite_token = None
    for _ in range(rewrite_limit):
        status, raw = transport('POST', _rewrite_url(obj, rewrite_token), _headers(token), b'')
        if _condition_not_met(status, raw):
            if rewrite_token or not _listed_generation_still_live(transport, token, obj):
                raise BackupError('copy', status)
            return None
        if status != 200:
            raise BackupError('copy', status)
        payload = _json_object(raw, 'copy', status)
        if payload.get('done') is True:
            _prove(
                payload.get('resource'),
                bucket=VAULT_BUCKET,
                name=obj['dest'],
                size=obj['size'],
                stage='verify_copy',
                crc32c=obj['crc32c'],
                md5=obj['md5'],
            )
            return _receipt(obj, payload['resource'])
        token_value = payload.get('rewriteToken')
        if not isinstance(token_value, str) or not token_value:
            raise BackupError('copy', status)
        rewrite_token = token_value
    raise BackupError('copy')


def _copy_all(transport, token, objects):
    copied = already = bytes_copied = 0
    receipts = []
    try:
        for obj in objects:
            receipt = _rewrite(transport, token, obj)
            if receipt is not None:
                receipts.append(receipt)
                copied += 1
                bytes_copied += obj['size']
            else:
                already += 1
    except BackupError as error:
        error.counts.update(copied=copied, already_present=already, bytes_copied=bytes_copied)
        raise
    return copied, already, bytes_copied, receipts


def _upload_json(transport, token, name, body, upload_stage, verify_stage):
    query = urllib.parse.urlencode({'uploadType': 'media', 'name': name, 'ifGenerationMatch': '0'})
    url = (
        'https://storage.googleapis.com/upload/storage/v1/b/'
        + urllib.parse.quote(VAULT_BUCKET, safe='')
        + '/o?'
        + query
    )
    status, raw = transport('POST', url, _headers(token, 'application/json'), body)
    if _condition_not_met(status, raw):
        return 'already_exists', None, None
    if status != 200:
        raise BackupError(upload_stage, status)
    resource = _json_object(raw, verify_stage, status)
    _prove(resource, bucket=VAULT_BUCKET, name=name, size=len(body), stage=verify_stage)
    return 'created', _generation(resource.get('generation'), verify_stage), len(body)


def _manifest(
    day,
    started,
    user_count,
    auth_name,
    auth_outcome,
    auth_generation,
    auth_bytes,
    copied,
    already,
    bytes_copied,
    receipts,
):
    auth = {'object': auth_name, 'outcome': auth_outcome, 'users': user_count}
    if auth_generation is not None:
        auth['generation'] = auth_generation
        auth['bytes'] = auth_bytes
    return {
        'event': EVENT,
        'date': day,
        'started': started,
        'bucket': VAULT_BUCKET,
        'auth': auth,
        'evidence': {
            'source_bucket': SOURCE_BUCKET,
            'layout': 'evidence/<source-generation>/<source-object-name>',
            'copied': copied,
            'already_present': already,
            'bytes_copied': bytes_copied,
            'receipts': receipts,
        },
        'outcome': 'ok',
    }


def run_backup(transport, *, token, now, page_limit=PAGE_LIMIT):
    if now.tzinfo is None:
        raise BackupError('internal')
    stamp = now.astimezone(timezone.utc)
    day = stamp.strftime('%Y-%m-%d')
    started = stamp.strftime('%Y-%m-%dT%H:%M:%SZ')
    users = _export_users(transport, token, page_limit=page_limit)
    auth_name = f'auth/{day}.json'
    auth_body = json.dumps({'users': users}, separators=(',', ':'), ensure_ascii=False).encode(
        'utf-8'
    )
    try:
        auth_outcome, auth_generation, auth_bytes = _upload_json(
            transport, token, auth_name, auth_body, 'upload_auth', 'verify_auth'
        )
    except BackupError as error:
        error.counts.setdefault('users', len(users))
        raise
    try:
        objects = _list_source(transport, token, page_limit=page_limit)
        copied, already, bytes_copied, receipts = _copy_all(transport, token, objects)
    except BackupError as error:
        error.counts.setdefault('users', len(users))
        raise
    manifest_name = f'manifests/{day}.json'
    manifest_body = json.dumps(
        _manifest(
            day,
            started,
            len(users),
            auth_name,
            auth_outcome,
            auth_generation,
            auth_bytes,
            copied,
            already,
            bytes_copied,
            receipts,
        ),
        separators=(',', ':'),
        sort_keys=True,
    ).encode('utf-8')
    try:
        manifest_outcome, manifest_generation, manifest_bytes = _upload_json(
            transport, token, manifest_name, manifest_body, 'upload_manifest', 'verify_manifest'
        )
        if copied and manifest_outcome == 'already_exists':
            raise BackupError('upload_manifest', 412)
    except BackupError as error:
        error.counts.update(
            copied=copied,
            already_present=already,
            bytes_copied=bytes_copied,
            users=len(users),
        )
        raise
    wrote_new = auth_outcome == 'created' or manifest_outcome == 'created' or copied > 0
    fields = {
        'outcome': 'created' if wrote_new else 'already_exists',
        'bucket': VAULT_BUCKET,
        'auth_object': auth_name,
        'auth_outcome': auth_outcome,
        'auth_generation': auth_generation,
        'auth_bytes': auth_bytes,
        'users': len(users),
        'manifest_object': manifest_name,
        'manifest_outcome': manifest_outcome,
        'manifest_generation': manifest_generation,
        'manifest_bytes': manifest_bytes,
        'copied': copied,
        'already_present': already,
        'bytes_copied': bytes_copied,
    }
    return {key: value for key, value in fields.items() if value is not None}


def main(transport=None, now=None, token=None, stdout=None, stderr=None):
    stdout = sys.stdout if stdout is None else stdout
    stderr = sys.stderr if stderr is None else stderr
    current = now if now is not None else datetime.now(timezone.utc)
    try:
        used = urllib_transport if transport is None else transport
        used_token = fetch_token(used) if token is None else token
        fields = run_backup(used, token=used_token, now=current)
        stdout.write(_line('INFO', 'Vault backup', fields) + '\n')
        stdout.flush()
        return 0
    except BackupError as error:
        stderr.write(_line('ERROR', 'Vault backup failed', error.fields()) + '\n')
        stderr.flush()
        return 1
    except Exception:
        stderr.write(
            _line(
                'ERROR',
                'Vault backup failed',
                {'outcome': 'failed', 'stage': 'internal', 'bucket': VAULT_BUCKET},
            )
            + '\n'
        )
        stderr.flush()
        return 1


if __name__ == '__main__':
    sys.exit(main())
