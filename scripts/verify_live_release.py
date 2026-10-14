"""Synthetic release checks using normal staff sign-in; credentials travel only through stdin."""

import argparse
import asyncio
import base64
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import wave
from pathlib import Path
from urllib.parse import quote
from uuid import UUID, uuid4

import requests

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import scripts.verify_common as common
from scripts.verify_common import admin, gcloud, image, FIXTURES, PROJECT, URL
from scripts.release_stamp import COMMIT_PATTERN

PRODUCTION = 'https://alert-disaster-field-estimator-545776254070.us-west2.run.app'
SERVICE_HOST = 'alert-disaster-field-estimator-ecyxym3iqa-wl.a.run.app'
# The service label plus '---' leaves 16 characters in a 63-character DNS label.
TAG_PATTERN = r'[a-z](?:[a-z0-9-]{0,14}[a-z0-9])?'
# Legacy explicit URLs remain accepted, but neither is a default target.
STAGED = 'https://live-reliable---alert-disaster-field-estimator-ecyxym3iqa-wl.a.run.app'
WORKSPACE_STAGE = 'https://workspaces---alert-disaster-field-estimator-ecyxym3iqa-wl.a.run.app'
SERVICE = None
EXPECTED_COMMIT = None
# One lookup per Live window avoids ~30 s WSL2 interop calls; gcloud may hand back a nearly expired token.
TOKEN_LIFETIME = 45 * 60
TOKEN_MARGIN = 2 * 60
TOKEN_INFO = 'https://oauth2.googleapis.com/tokeninfo'
_token_cache = None


def gcloud_token():
    environment = dict(os.environ)
    environment.pop('PYTHONPATH', None)
    result = subprocess.run(
        [
            gcloud(),
            'auth',
            'print-access-token',
            '--project=' + PROJECT,
            '--billing-project=' + PROJECT,
        ],
        env=environment,
        capture_output=True,
        text=True,
    )
    if result.returncode:
        raise RuntimeError('Cloud CLI token lookup failed; no credential was logged.')
    return result.stdout.strip()


def token_remaining(token):
    try:
        response = requests.post(TOKEN_INFO, data={'access_token': token}, timeout=30)
        return int(response.json()['expires_in']) if response.ok else None
    except (requests.RequestException, ValueError, KeyError, TypeError):
        return None


def access_token():
    global _token_cache
    if _token_cache and time.monotonic() < _token_cache[0]:
        return _token_cache[1]
    for _ in range(2):
        token = gcloud_token()
        remaining = token_remaining(token)
        if remaining is None or remaining > TOKEN_MARGIN:
            break
    lifetime = TOKEN_MARGIN if remaining is None else min(remaining - TOKEN_MARGIN, TOKEN_LIFETIME)
    _token_cache = (time.monotonic() + lifetime, token)
    return token


common.access_token = access_token


def backend_url(tag):
    if not re.fullmatch(TAG_PATTERN, tag):
        raise argparse.ArgumentTypeError(
            'Backend tag must be 1-16 lowercase letters/digits/hyphens, '
            'starting with a letter and ending with a letter or digit.'
        )
    return 'https://' + tag + '---' + SERVICE_HOST


def service_url(value):
    if value != PRODUCTION and not re.fullmatch(
        r'https://(?:' + TAG_PATTERN + r'---)?' + re.escape(SERVICE_HOST), value
    ):
        raise argparse.ArgumentTypeError(
            'Use only the exact dedicated production URL or a safe tagged backend URL, without URL components.'
        )
    return value


def check(method, path, token, body=None, expected=200):
    read_only_suggestions = (
        method == 'POST' and path.endswith('/scope-suggestions') and expected == 200
    )
    for attempt in range(2 if read_only_suggestions else 1):
        result = requests.request(
            method,
            SERVICE + path,
            json=body,
            headers={'Authorization': 'Bearer ' + token, 'X-ADR-Workspace-Protocol': '1'}
            if token
            else {},
            timeout=115,
            allow_redirects=False,
        )
        if result.status_code == 504 and read_only_suggestions and attempt == 0:
            print(
                'RETRY: read-only scope extraction reached the server deadline; retrying once after 2 seconds.',
                flush=True,
            )
            time.sleep(2)
            continue
        break
    if result.status_code != expected:
        raise RuntimeError(
            f'Synthetic {method} {path}: HTTP {result.status_code}, expected {expected}'
        )
    return result.json()


def staff_session(stream=None):
    """Do not decode a token as proof of identity: authenticate it with the backend."""
    stream = stream or sys.stdin
    token = stream.readline(16385).strip()
    if not token or len(token) > 16384 or any(c.isspace() for c in token):
        raise RuntimeError('Supply a Firebase ID token through the private stdin pipe.')
    session = check('GET', '/api/session', token)
    if session['project'] != PROJECT or not session['uid'] or session['live_protocol_version'] != 2:
        raise RuntimeError('The token does not belong to a dedicated-project staff session.')
    return token, session['uid']


def private_document(collection, uid):
    response = requests.get(
        f'https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents/{collection}/{uid}',
        headers={'Authorization': 'Bearer ' + access_token(), 'x-goog-user-project': PROJECT},
        timeout=30,
    )
    if response.status_code == 404:
        return None
    if response.status_code != 200:
        raise RuntimeError('Private test-state lookup failed: ' + str(response.status_code))
    return response.json().get('fields', {})


def no_existing_capture(uid):
    for collection in ('_live_resume', '_live_sessions'):
        state = private_document(collection, uid)
        if state:
            expiry = state.get('expires', {})
            if float(expiry.get('doubleValue', expiry.get('integerValue', 0))) > time.time():
                raise RuntimeError(
                    'Stop/Finish the existing walkthrough first; its capture state was not changed.'
                )


def assert_capture_released(uid):
    # The finished acknowledgement precedes cleanup, so allow the relay a moment to release.
    until = time.monotonic() + 15
    while (
        private_document('_live_resume', uid) is not None
        or private_document('_live_sessions', uid) is not None
    ):
        if time.monotonic() > until:
            raise RuntimeError('Finish left a private checkpoint or an active lease')
        time.sleep(1)


async def finished(socket):
    until = time.monotonic() + 10
    while time.monotonic() < until:
        packet = json.loads(
            await asyncio.wait_for(socket.recv(), max(0.1, until - time.monotonic()))
        )
        if packet['type'] == 'finished':
            assert isinstance(packet['complete'], bool)
            return
        assert packet['type'] != 'error', 'Live failed while draining'
    raise RuntimeError('Live Finish did not acknowledge cleanup')


def live_connection(target):
    from websockets.asyncio.client import connect

    class NoRedirectConnect(connect):
        def process_redirect(self, exc):
            return exc

    return NoRedirectConnect(target, origin=URL)


async def live(token, iid, uid):
    capture = uuid4().hex
    target = SERVICE.replace('https:', 'wss:') + '/api/live'
    async with live_connection(target) as socket:
        await socket.send(
            json.dumps(
                dict(
                    type='authenticate',
                    token=token,
                    inspection_id=iid,
                    protocol_version=2,
                    capture_id=capture,
                )
            )
        )
        ready = json.loads(await asyncio.wait_for(socket.recv(), 40))
        assert ready.get('voice') == 'Charon' and ready.get('protocol_version') == 2, (
            'Unexpected Live setup'
        )
        with wave.open(str(FIXTURES / 'live-prompt.wav'), 'rb') as recording:
            assert recording.getframerate() == 16000 and recording.getnchannels() == 1
            pcm = recording.readframes(recording.getnframes())
        for offset in range(0, len(pcm), 3200):
            await socket.send(
                json.dumps(
                    {
                        'type': 'audio',
                        'data': base64.b64encode(pcm[offset : offset + 3200]).decode(),
                    }
                )
            )
            await asyncio.sleep(0.1)
        await socket.send(json.dumps({'type': 'pause'}))
        seen = set()
        until = time.monotonic() + 30
        while time.monotonic() < until:
            packet = json.loads(
                await asyncio.wait_for(socket.recv(), max(0.1, until - time.monotonic()))
            )
            if packet['type'] == 'transcript':
                assert 'sequence' in packet and 'connection_id' in packet
            assert packet['type'] != 'error', 'Live provider failed'
            seen.add(packet['type'])
            if packet['type'] == 'turn_complete' and 'audio' in seen:
                break
        assert 'audio' in seen and 'transcript' in seen
        # Unmute resumes audio packets; the protocol has no separate start packet.
        await socket.send(
            json.dumps({'type': 'audio', 'data': base64.b64encode(b'\0' * 3200).decode()})
        )
        await socket.send(json.dumps({'type': 'pause'}))
        # The loop must stay free to answer the relay's keepalive pings while gcloud runs.
        checkpoint = await asyncio.to_thread(private_document, '_live_resume', uid)
        assert checkpoint and checkpoint.get('capture_id', {}).get('stringValue') == capture
        assert checkpoint.get('resumable', {}).get('booleanValue')
        assert checkpoint.get('handle', {}).get('stringValue'), 'No usable checkpoint was saved'
        await socket.send(json.dumps({'type': 'end', 'preserve_resume': True}))
        await finished(socket)
    async with live_connection(target) as socket:
        await socket.send(
            json.dumps(
                dict(
                    type='authenticate',
                    token=token,
                    inspection_id=iid,
                    protocol_version=2,
                    capture_id=capture,
                    resume=True,
                )
            )
        )
        ready = json.loads(await asyncio.wait_for(socket.recv(), 40))
        assert ready.get('recovery') == 'resumed', 'Provider resumption was not accepted'
        await socket.send(json.dumps({'type': 'end'}))
        await finished(socket)
    assert_capture_released(uid)
    print(
        'PASS: deployed v2 audio/transcripts, pause/unmute packets, provider resumption and Finish checkpoint/lease deletion',
        flush=True,
    )


def cleanup_test_checkpoint(uid, inspections):
    headers = {'Authorization': 'Bearer ' + access_token(), 'x-goog-user-project': PROJECT}
    path = f'https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents/_live_resume/{uid}'
    response = requests.get(path, headers=headers, timeout=30)
    if response.status_code == 404:
        return
    if response.status_code != 200:
        raise RuntimeError('Checkpoint lookup failed: ' + str(response.status_code))
    document = response.json()
    fields = document['fields']
    if (
        fields.get('owner_uid', {}).get('stringValue') != uid
        or fields.get('inspection_id', {}).get('stringValue') not in inspections
    ):
        return
    # A successor checkpoint must survive cleanup of an earlier failed test.
    removed = requests.delete(
        path,
        headers=headers,
        params={'currentDocument.updateTime': document['updateTime']},
        timeout=30,
    )
    if removed.status_code not in (200, 404, 412):
        raise RuntimeError('Checkpoint cleanup failed: ' + str(removed.status_code))


def valid_synthetic_identifier(collection, identifier):
    prefix = {'inspections': 'ADR-INS-', 'authorizations': 'ADR-AUTH-'}[collection]
    if not identifier.startswith(prefix):
        return False
    suffix = identifier[len(prefix) :]
    if len(suffix) == 32 and all(character in '0123456789abcdef' for character in suffix):
        return True
    if collection != 'authorizations':
        return False
    # Homeowner signing-link agreements: ADR-AUTH-link-<first 32 hex of the link digest>.
    if re.fullmatch(r'link-[0-9a-f]{32}', suffix):
        return True
    try:
        return str(UUID(suffix)) == suffix
    except (ValueError, AttributeError):
        return False


def synthetic_sidecars(headers, uid, inspections, agreements):
    base = f'https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents/'
    membership = requests.get(base + '_memberships/' + uid, headers=headers, timeout=30)
    if membership.status_code not in (200, 404):
        raise RuntimeError('Membership lookup failed: ' + str(membership.status_code))
    company = (
        membership.json()['fields']['company_id']['stringValue']
        if membership.status_code == 200
        else None
    )
    pending = []
    for collection, identifiers in (
        ('_workspace_jobs', inspections),
        ('_workspace_authorizations', agreements),
    ):
        for identifier in identifiers:
            path = base + collection + '/' + identifier
            response = requests.get(path, headers=headers, timeout=30)
            if response.status_code == 404:
                continue
            if response.status_code != 200:
                raise RuntimeError('Sidecar lookup failed: ' + str(response.status_code))
            snapshot = response.json()
            fields = snapshot['fields']
            if not company or fields['company_id']['stringValue'] != company:
                raise RuntimeError('Sidecar belongs to another company; retained for review.')
            if collection == '_workspace_jobs' and fields['creator_uid']['stringValue'] != uid:
                raise RuntimeError('Sidecar belongs to another creator; retained for review.')
            if (
                collection != '_workspace_jobs'
                and fields['job_id']['stringValue'] not in inspections
            ):
                raise RuntimeError('Sidecar references an untracked job; retained for review.')
            pending.append((path, snapshot['updateTime']))
    return pending


def cleanup_links(headers, uid, inspections, links):
    """Signing-link records of tracked inspections: each link digest, then each job pointer."""
    base = f'https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents/'
    paths = [base + '_signing_links/' + key for key in links]
    paths += [base + '_signing_link_jobs/' + identifier for identifier in inspections]
    for path in paths:
        existing = requests.get(path, headers=headers, timeout=30)
        if existing.status_code == 404:
            continue
        if existing.status_code != 200:
            raise RuntimeError('Signing-link lookup failed: ' + str(existing.status_code))
        fields = existing.json()['fields']
        if fields['owner_uid']['stringValue'] != uid or (
            '/_signing_links/' in path and fields['inspection_id']['stringValue'] not in inspections
        ):
            raise RuntimeError('Signing link belongs to another job; retained for review.')
        response = requests.delete(
            path,
            headers=headers,
            params={'currentDocument.updateTime': existing.json()['updateTime']},
            timeout=30,
        )
        if response.status_code not in (200, 404):
            raise RuntimeError('Signing-link cleanup failed: ' + str(response.status_code))


def cleanup_synthetic(uid, inspections, agreements, links=()):
    """Deletes only IDs tracked by this run and objects under those exact prefixes."""
    for collection, identifiers in (('authorizations', agreements), ('inspections', inspections)):
        if not all(
            valid_synthetic_identifier(collection, identifier) for identifier in identifiers
        ):
            raise RuntimeError('Unexpected synthetic identifier')
    if not all(isinstance(key, str) and re.fullmatch(r'[0-9a-f]{64}', key) for key in links):
        raise RuntimeError('Unexpected synthetic identifier')
    headers = {'Authorization': 'Bearer ' + access_token(), 'x-goog-user-project': PROJECT}
    sidecars = synthetic_sidecars(headers, uid, inspections, agreements)
    prefixes = []
    for collection, identifiers in (('authorizations', agreements), ('inspections', inspections)):
        for identifier in identifiers:
            path = f'https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents/{collection}/{identifier}'
            existing = requests.get(path, headers=headers, timeout=30)
            if existing.status_code not in (200, 404):
                raise RuntimeError(f'Synthetic {collection} lookup failed: {existing.status_code}')
            if existing.status_code == 200:
                if existing.json()['fields']['owner_uid']['stringValue'] != uid:
                    raise RuntimeError(
                        f'Synthetic {collection} record belongs to another owner; retained for review.'
                    )
                response = requests.delete(
                    path,
                    headers=headers,
                    params={'currentDocument.updateTime': existing.json()['updateTime']},
                    timeout=30,
                )
                if response.status_code not in (200, 404):
                    raise RuntimeError(
                        f'Synthetic {collection} cleanup failed: {response.status_code}'
                    )
            prefixes.append(f'users/{uid}/{collection}/{identifier}/')
    for prefix in prefixes:
        response = admin(
            'GET',
            f'https://storage.googleapis.com/storage/v1/b/{PROJECT}-evidence/o?prefix={quote(prefix, safe="")}',
        )
        for item in response.get('items', []):
            if not item['name'].startswith(prefix):
                raise RuntimeError(
                    'Evidence listing escaped its synthetic prefix; retained for review.'
                )
            admin(
                'DELETE',
                f'https://storage.googleapis.com/storage/v1/b/{PROJECT}-evidence/o/{quote(item["name"], safe="")}',
            )
    cleanup_links(headers, uid, inspections, links)
    for path, version in sidecars:
        response = requests.delete(
            path, headers=headers, params={'currentDocument.updateTime': version}, timeout=30
        )
        if response.status_code not in (200, 404):
            raise RuntimeError('Synthetic sidecar changed; retained for review.')
    cleanup_test_checkpoint(uid, inspections)
    print(
        'Only tracked synthetic records and their exact evidence prefixes were removed; staff identity and other jobs unchanged.',
        flush=True,
    )


def homeowner(method, path, link, body=None, expected=200):
    """A request with no sign-in: only the signing link's own header."""
    result = requests.request(
        method,
        SERVICE + path,
        json=body,
        headers={'X-ADR-Signing-Link': link},
        timeout=115,
        allow_redirects=False,
    )
    if result.status_code != expected:
        raise RuntimeError(
            f'Homeowner {method} {path}: HTTP {result.status_code}, expected {expected}'
        )
    return result


def mint_link(token, record, links):
    iid = record['inspection_id']
    link = check(
        'POST',
        f'/api/inspections/{iid}/signing-links',
        token,
        dict(expected_revision=record['revision'], proposal_hash=record['audit']['proposal_hash']),
    )
    assert link['qr_svg'].startswith('data:image/svg+xml;base64,')
    secret = link['url'].split('#', 1)[1]
    links.append(hashlib.sha256(secret.encode()).hexdigest())
    return secret


SIGNER = dict(
    signer_name='Synthetic Release Signer',
    signer_role='authorized_representative',
    documents_reviewed=True,
    electronic_consent=True,
    consent_version='homeowner-link-v1',
)


def signing_link(token, iid, agreements, links):
    """One audited job: a replaced link is refused, the current one signs once with no sign-in."""
    data = dict(
        address='Synthetic signing-link release verification - no customer data',
        year_built=2000,
        rooms=[dict(name='Bathroom', category=1, finished_sf=10)],
        air_movers=3,
        dehumidifiers=1,
        drying_days=3,
        technician_notes='Localized clean-water damage. Proposed drywall removal and drying only.',
        scope_confirmed=True,
    )
    record = check('POST', '/api/inspections', token, dict(inspection_id=iid, data=data))
    record = check(
        'POST', '/api/audit', token, {'inspection_id': iid, 'expected_revision': record['revision']}
    )
    documents = record['audit']['documents']
    replaced = mint_link(token, record, links)
    view = homeowner('GET', '/api/sign', replaced).json()
    assert view['status'] == 'pending' and view['documents'] == documents
    current = mint_link(token, record, links)
    homeowner('GET', '/api/sign', replaced, expected=404)
    homeowner('GET', '/api/sign', 'x' * 43, expected=404)
    body = dict(SIGNER, signature_png=image(True))
    receipt = homeowner('POST', '/api/sign', current, body).json()
    agreements.append(receipt['auth_id'])
    assert homeowner('POST', '/api/sign', current, body).json() == receipt
    inspection = check('GET', f'/api/inspections/{iid}', token)
    assert inspection['status'] == 'signed'
    assert inspection['authorization_id'] == receipt['auth_id']
    saved = check('GET', '/api/authorizations/' + receipt['auth_id'], token)
    signer = saved['signer']
    assert saved['signing_channel'] == 'link' and saved['documents'] == documents
    assert signer['name'] == SIGNER['signer_name'] and signer['role'] == SIGNER['signer_role']
    assert saved['consent']['version'] == SIGNER['consent_version'] and signer['user_agent']
    signed = homeowner('GET', '/api/sign', current).json()
    assert signed['status'] == 'signed' and signed['receipt']['auth_id'] == receipt['auth_id']
    homeowner('GET', '/api/sign/signature', current)
    assert set(signer) == {'name', 'role', 'ip_address', 'user_agent'}
    # Presence only; the address itself stays in the record and out of this output.
    print(
        'PASS: signing link minted, replaced link refused, anonymous read and single signature; '
        'ip_address ' + ('recorded' if signer['ip_address'] else 'absent'),
        flush=True,
    )


def main():
    token, uid = staff_session()
    health = check('GET', '/api/health/details', token)
    assert health['project'] == PROJECT and health['live_model'] == 'gemini-3.8-live'
    source = source_commit(health)
    print(
        f'PASS: staff health details; workspaces_enabled={str(health["workspaces_enabled"]).lower()}; source_commit={source}',
        flush=True,
    )
    no_existing_capture(uid)
    iid = 'ADR-INS-' + uuid4().hex
    aid = 'ADR-AUTH-' + uuid4().hex
    link_iid = 'ADR-INS-' + uuid4().hex
    agreements, links = [aid], []
    try:
        check('GET', '/api/inspections', None, expected=401)
        # Before the Live walkthrough, so its audit and this one rarely share a one-minute quota window.
        signing_link(token, link_iid, agreements, links)
        data = dict(
            address='Synthetic Live release verification - no customer data',
            year_built=2000,
            rooms=[dict(name='Bathroom', category=1, finished_sf=0)],
            air_movers=0,
            dehumidifiers=0,
            drying_days=3,
            technician_notes='Localized clean-water damage. Proposed drywall removal and drying only.',
            technician_transcript='Bathroom, water category 1. I measured 10 square feet of drywall to remove. For this job use 3 fans and 1 dehumidifier for 3 days.',
            scope_confirmed=False,
        )
        record = check('POST', '/api/inspections', token, dict(inspection_id=iid, data=data))
        suggested = check(
            'POST',
            f'/api/inspections/{iid}/scope-suggestions',
            token,
            {'inspection_id': iid, 'expected_revision': record['revision']},
        )
        assert suggested['revision'] == record['revision'] and suggested['changes']
        assert check('GET', f'/api/inspections/{iid}', token)['revision'] == record['revision']
        assert any(c['field'] == 'air_movers' and c['value'] == 3 for c in suggested['changes'])
        selected = dict(record['data'])
        selected.update(air_movers=3, scope_confirmed=False)
        old_revision = record['revision']
        record = check(
            'PUT',
            f'/api/inspections/{iid}',
            token,
            {'expected_revision': old_revision, 'data': selected},
        )
        assert (
            record['data']['rooms'][0]['finished_sf'] == 0 and record['data']['dehumidifiers'] == 0
        )
        check(
            'PUT',
            f'/api/inspections/{iid}',
            token,
            {'expected_revision': old_revision, 'data': selected},
            expected=409,
        )
        check(
            'POST',
            f'/api/inspections/{iid}/scope-suggestions',
            token,
            {'inspection_id': iid, 'expected_revision': old_revision},
            expected=409,
        )
        confirmed = dict(record['data'])
        confirmed.update(
            rooms=[dict(name='Bathroom', category=1, finished_sf=10)],
            dehumidifiers=1,
            scope_confirmed=True,
        )
        record = check(
            'PUT',
            f'/api/inspections/{iid}',
            token,
            {'expected_revision': record['revision'], 'data': confirmed},
        )
        print(
            'PASS: review-only suggestions, selective technician application and stale revision rejection',
            flush=True,
        )
        pid = uuid4().hex
        record = check(
            'POST',
            f'/api/inspections/{iid}/photos',
            token,
            dict(
                expected_revision=record['revision'],
                photo_id=pid,
                room='Bathroom',
                captured_at='2026-10-07T17:00:00Z',
                data_url=image(),
            ),
        )
        record = check('POST', f'/api/inspections/{iid}/photos/{pid}/ocr', token, {})
        assert record['photos'][0]['ocr_status'] == 'no_meter'
        asyncio.run(live(token, iid, uid))
        record = check(
            'POST',
            '/api/audit',
            token,
            {'inspection_id': iid, 'expected_revision': record['revision']},
        )
        documents = record['audit']['documents']
        assert documents['signable'] and documents['xactimate_total'] == 1775.0
        assert documents['adr_estimate']['proposed_cost_low'] == 1775.0
        assert documents['adr_estimate']['proposed_cost'] == 1788.90
        assert (
            len(documents['photo_audit_log']) == 1
            and documents['iicrc_defense_letter']
            and documents['xactimate_scope']
        )
        # An unused link stops working once the estimate is signed on the device.
        unused = mint_link(token, record, links)
        assert homeowner('GET', '/api/sign', unused).json()['status'] == 'pending'
        check(
            'POST',
            '/api/authorize',
            token,
            dict(
                inspection_id=iid,
                expected_revision=record['revision'],
                auth_id=aid,
                proposal_hash=record['audit']['proposal_hash'],
                signature_png=image(True),
                documents_confirmed=True,
            ),
        )
        saved = check('GET', '/api/authorizations/' + aid, token)
        assert saved['documents'] == documents
        homeowner('GET', '/api/sign', unused, expected=409)
        for name in ('signature', 'photo-0'):
            evidence = requests.get(
                SERVICE + f'/api/authorizations/{aid}/evidence/{name}',
                headers={'Authorization': 'Bearer ' + token},
                timeout=30,
                allow_redirects=False,
            )
            assert (
                evidence.status_code == 200
                and evidence.headers.get('Cache-Control') == 'private, no-store'
            )
        check(
            'PUT',
            f'/api/inspections/{iid}',
            token,
            {'expected_revision': record['revision'], 'data': confirmed},
            expected=409,
        )
        assert check('GET', f'/api/inspections/{iid}', token)['status'] == 'signed'
        print(
            'PASS: non-meter OCR, workbook range, four documents, durable signing and evidence restoration',
            flush=True,
        )
    finally:
        cleanup_synthetic(uid, [iid, link_iid], agreements, links)


def source_commit(health):
    """Report the backend's stamped commit; with --expect-commit, a different build fails."""
    source = health.get('source_commit', 'not reported (built before release stamping)')
    if EXPECTED_COMMIT and source != EXPECTED_COMMIT:
        raise RuntimeError(f'Backend source_commit {source} is not the expected {EXPECTED_COMMIT}.')
    return source


def public():
    result = requests.get(SERVICE + '/api/health', timeout=30)
    assert result.status_code == 200
    health = result.json()
    assert set(health) <= {'status', 'schema_version', 'source_commit'}
    assert health['status'] == 'healthy' and health['schema_version'] == 3
    print('Backend source_commit: ' + source_commit(health), flush=True)
    for path in ('/api/health/details', '/api/session', '/api/inspections', '/api/authorizations'):
        assert requests.get(SERVICE + path, timeout=30).status_code == 401

    async def denied():
        from websockets.asyncio.client import connect
        from websockets.exceptions import InvalidStatus

        target = SERVICE.replace('https:', 'wss:') + '/api/live'
        try:
            async with connect(target, origin='https://invalid.example.invalid'):
                raise AssertionError('Invalid origin accepted')
        except InvalidStatus:
            pass
        async with connect(target, origin=URL) as socket:
            await socket.send(
                json.dumps(
                    dict(
                        type='authenticate',
                        token='synthetic-invalid-not-a-token',
                        inspection_id='ADR-INS-' + 'f' * 32,
                    )
                )
            )
            assert json.loads(await asyncio.wait_for(socket.recv(), 15))['type'] == 'error'

    asyncio.run(denied())
    print(
        'PASS: dedicated backend health and anonymous/invalid Live denials; no data or IAM changes.',
        flush=True,
    )


def cleanup_from_stdin():
    payload = json.loads(sys.stdin.readline(25000))
    import io

    token, uid = staff_session(io.StringIO(payload['token'] + '\n'))
    cleanup_synthetic(uid, payload['inspections'], payload['agreements'], payload.get('links', []))


def commit_hash(value):
    if not re.fullmatch(COMMIT_PATTERN, value):
        raise argparse.ArgumentTypeError(
            'Use a full 40-character commit hash, optionally ending in -dirty.'
        )
    return value


def cli():
    global SERVICE, EXPECTED_COMMIT
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument(
        'service',
        nargs='?',
        type=service_url,
        help='Explicit dedicated backend URL (legacy syntax).',
    )
    parser.add_argument(
        '--backend-tag',
        type=backend_url,
        action='append',
        help='Explicit Cloud Run candidate tag on the dedicated service.',
    )
    parser.add_argument(
        '--production', action='store_true', help='Select the dedicated production backend.'
    )
    parser.add_argument(
        '--expect-commit',
        type=commit_hash,
        help='Fail unless the backend reports this source_commit (see RELEASES.md).',
    )
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument('--public', action='store_true')
    modes.add_argument('--cleanup-stdin', action='store_true')
    modes.add_argument(
        '--token-stdin',
        action='store_true',
        help='Read a Firebase ID token from a private stdin pipe.',
    )
    args = parser.parse_args()
    targets = (
        ([args.service] if args.service else [])
        + (args.backend_tag or [])
        + ([PRODUCTION] if args.production else [])
    )
    if len(targets) != 1:
        parser.error('Select exactly one explicit service URL, --backend-tag TAG, or --production.')
    SERVICE = targets[0]
    EXPECTED_COMMIT = args.expect_commit
    if args.public:
        public()
    elif args.cleanup_stdin:
        cleanup_from_stdin()
    elif args.token_stdin:
        main()
    else:
        parser.error(
            'Use --token-stdin with scripts/verify_live_browser.js for normal staff sign-in.'
        )


if __name__ == '__main__':
    try:
        cli()
    except (AssertionError, RuntimeError) as error:
        print('FAIL: ' + str(error), file=sys.stderr)
        sys.exit(1)
