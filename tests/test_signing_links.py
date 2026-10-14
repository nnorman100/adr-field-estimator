"""Homeowner signing links through the real API handlers, in owner-only and company modes."""

import base64, json, time
import pytest
from fastapi.testclient import TestClient
import backend.main as bm
import backend.signing_links as sl
from tests.fakes import png
from tests.test_backend import context, inspect, audit, photo, data, as_user, ID
from tests.test_workspaces import api, store, data as company_data

SIGNER = dict(
    signer_name='Synthetic Signer',
    signer_role='owner',
    documents_reviewed=True,
    electronic_consent=True,
    consent_version=sl.CONSENT_VERSION,
)


def mint(client, record, inspection_id=ID):
    return client.post(
        '/api/inspections/' + inspection_id + '/signing-links',
        json=dict(
            expected_revision=record['revision'], proposal_hash=record['audit']['proposal_hash']
        ),
        headers={'Origin': bm.ORIGINS[0]},
    )


def token(link):
    url = link.json()['url']
    assert url.startswith(bm.ORIGINS[0] + '/sign#')
    return url.split('#', 1)[1]


def homeowner(value=None, **headers):
    """A browser with no sign-in: no Authorization header, only the link's own credential."""
    if value is not None:
        headers['X-ADR-Signing-Link'] = value
    return TestClient(bm.app, headers=headers)


def sign(value, **changes):
    return homeowner(value, **{'User-Agent': 'Synthetic homeowner browser'}).post(
        '/api/sign', json={**SIGNER, 'signature_png': png(), **changes}
    )


def recognized(client, record, photo_id='b' * 32):
    photo(client, record, photo_id)
    response = client.post('/api/inspections/' + ID + '/photos/' + photo_id + '/ocr')
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture
def ready(context):
    client, store = context
    record = audit(client, recognized(client, inspect(client)))
    link = mint(client, record)
    assert link.status_code == 200, link.text
    return client, store, record, token(link)


def test_link_reads_the_bound_documents_and_signs_once_as_the_technician(ready):
    client, store, record, value = ready
    stored_links = [k for k in store.db.records if k.startswith('_signing_links/')]
    # Only the digest is stored; the token itself never reaches Firestore.
    assert stored_links == ['_signing_links/' + sl.link_id(value)]
    assert value not in json.dumps(store.db.records, default=str)
    view = homeowner(value).get('/api/sign')
    assert view.status_code == 200, view.text
    body = view.json()
    assert body['status'] == 'pending' and body['documents'] == record['audit']['documents']
    assert body['consent'] == dict(version=sl.CONSENT_VERSION, statements=sl.CONSENT)
    assert 'owner_uid' not in json.dumps(body) and 'users/' not in json.dumps(body)
    assert homeowner(value).get('/api/sign/photos/' + 'b' * 32).status_code == 200
    assert homeowner(value).get('/api/sign/photos/' + 'c' * 32).status_code == 404
    assert homeowner(value).get('/api/sign/signature').status_code == 404
    saved = sign(value)
    assert saved.status_code == 200, saved.text
    receipt = saved.json()
    assert receipt['status'] == 'success' and receipt['auth_id'].startswith('ADR-AUTH-link-')
    # An identical retry returns the same receipt; a different submission is refused.
    assert sign(value).json() == receipt
    assert sign(value, signer_name='Someone Else').status_code == 409
    remote = client.get('/api/inspections/' + ID).json()
    assert remote['status'] == 'signed' and remote['authorization_id'] == receipt['auth_id']
    agreement = store.db.records['authorizations/' + receipt['auth_id']]
    assert agreement['owner_uid'] == 'owner'
    assert agreement['inspection_revision'] == record['revision']
    assert agreement['proposal_hash'] == record['audit']['proposal_hash']
    assert agreement['documents'] == record['audit']['documents']
    assert agreement['signing_channel'] == 'link'
    assert agreement['signer'] == dict(
        name='Synthetic Signer',
        role='owner',
        ip_address=None,
        user_agent='Synthetic homeowner browser',
    )
    assert agreement['consent'] == dict(
        version=sl.CONSENT_VERSION,
        statements=sl.CONSENT,
        documents_reviewed=True,
        electronic_records=True,
    )
    assert agreement['signing_link']['id'] == sl.link_id(value)
    staff_view = client.get('/api/authorizations/' + receipt['auth_id']).json()
    assert staff_view['signer']['name'] == 'Synthetic Signer'
    # Read-only after signing: the signed copy, receipt and signature stay viewable.
    signed = homeowner(value).get('/api/sign').json()
    assert signed['status'] == 'signed' and signed['documents'] == agreement['documents']
    assert signed['receipt'] == dict(
        auth_id=receipt['auth_id'],
        timestamp=receipt['timestamp'],
        signer_name='Synthetic Signer',
        signer_role='owner',
    )
    assert homeowner(value).get('/api/sign/signature').status_code == 200
    assert homeowner(value).get('/api/sign/photos/' + 'b' * 32).status_code == 200


def test_recorded_address_is_the_entry_hosting_appended(ready):
    _, store, _, value = ready
    # A client-supplied leading entry, then Hosting's entry for the client, then Hosting itself.
    chain = '198.51.100.66, 203.0.113.7, 35.191.0.1'
    response = homeowner(value, **{'X-Forwarded-For': chain}).post(
        '/api/sign', json={**SIGNER, 'signature_png': png()}
    )
    assert response.status_code == 200, response.text
    signer = store.db.records['authorizations/' + response.json()['auth_id']]['signer']
    assert signer['ip_address'] == '203.0.113.7'
    assert set(signer) == {'name', 'role', 'ip_address', 'user_agent'}
    assert '198.51.100.66' not in json.dumps(store.db.records, default=str)


def test_a_chain_without_the_hosting_hops_records_no_address(context):
    client, store = context
    record = audit(client, recognized(client, inspect(client)))
    value = token(mint(client, record))
    response = homeowner(value, **{'X-Forwarded-For': '198.51.100.66'}).post(
        '/api/sign', json={**SIGNER, 'signature_png': png()}
    )
    assert response.status_code == 200, response.text
    signer = store.db.records['authorizations/' + response.json()['auth_id']]['signer']
    assert signer['ip_address'] is None


def test_technician_reads_the_current_link_state_without_the_token(ready):
    client, store, record, value = ready
    path = '/api/inspections/' + ID + '/signing-links'
    pending = client.get(path)
    assert pending.status_code == 200, pending.text
    assert pending.json()['status'] == 'pending' and pending.json()['expires_at']
    assert value not in pending.text and sl.link_id(value) not in pending.text
    as_user('other')
    assert client.get(path).status_code == 404
    as_user('owner')
    client.post(path + '/revoke')
    assert client.get(path).json() == {'status': 'revoked'}
    fresh = token(mint(client, record))
    assert sign(fresh).status_code == 200
    assert client.get(path).json() == {'status': 'used'}


def test_link_state_reports_an_edited_estimate_as_voided(ready):
    client, _, record, _ = ready
    path = '/api/inspections/' + ID + '/signing-links'
    changed = client.put(
        '/api/inspections/' + ID,
        json={'expected_revision': record['revision'], 'data': data(labor_hours=1)},
    )
    assert changed.status_code == 200
    assert client.get(path).json() == {'status': 'voided'}


def test_link_state_is_none_before_any_link(context):
    client, _ = context
    audit(client, recognized(client, inspect(client)))
    assert client.get('/api/inspections/' + ID + '/signing-links').json() == {'status': 'none'}


@pytest.mark.parametrize(
    'change',
    ['edit', 'photo', 'device-signed'],
)
def test_any_edit_or_device_signature_voids_an_unused_link(ready, change):
    client, store, record, value = ready
    if change == 'edit':
        changed = client.put(
            '/api/inspections/' + ID,
            json={
                'expected_revision': record['revision'],
                'data': data(labor_hours=1),
            },
        )
        assert changed.status_code == 200
    elif change == 'photo':
        recognized(client, record, 'd' * 32)
    else:
        payload = dict(
            inspection_id=ID,
            expected_revision=record['revision'],
            auth_id='ADR-AUTH-device123456',
            proposal_hash=record['audit']['proposal_hash'],
            signature_png=png(),
            documents_confirmed=True,
        )
        assert client.post('/api/authorize', json=payload).status_code == 200
    for _ in range(2):
        refused = homeowner(value).get('/api/sign')
        assert refused.status_code == 409 and refused.json()['detail'] == sl.UPDATED
    assert sign(value).status_code == 409
    assert homeowner(value).get('/api/sign/photos/' + 'b' * 32).status_code == 409
    assert store.db.records['_signing_links/' + sl.link_id(value)]['status'] == 'voided'
    if change != 'device-signed':
        assert client.get('/api/inspections/' + ID).json()['status'] != 'signed'


def test_unknown_expired_revoked_and_replaced_links_are_not_found(ready, monkeypatch):
    client, store, record, value = ready
    for bad in [None, '', 'short', value[:-1] + ('A' if value[-1] != 'A' else 'B'), value + 'x']:
        response = homeowner(bad).get('/api/sign')
        assert response.status_code == 404 and response.json()['detail'] == sl.UNAVAILABLE
    assert sign('x' * 43).status_code == 404
    # Minting again revokes the earlier link: one active link per inspection.
    replacement = token(mint(client, record))
    assert homeowner(value).get('/api/sign').status_code == 404
    assert homeowner(replacement).get('/api/sign').status_code == 200
    revoked = client.post('/api/inspections/' + ID + '/signing-links/revoke')
    assert revoked.json() == {'status': 'revoked'}
    assert homeowner(replacement).get('/api/sign').status_code == 404
    assert sign(replacement).status_code == 404
    fresh = token(mint(client, record))
    later = time.time() + sl.LINK_SECONDS + 1
    monkeypatch.setattr(sl.time, 'time', lambda: later)
    assert homeowner(fresh).get('/api/sign').status_code == 404
    assert sign(fresh).status_code == 404
    assert client.get('/api/inspections/' + ID).json()['status'] == 'audited'


def test_signed_view_ends_thirty_days_after_signing(ready, monkeypatch):
    _, _, _, value = ready
    assert sign(value).status_code == 200
    moment = time.time()
    monkeypatch.setattr(sl.time, 'time', lambda: moment + sl.SIGNED_VIEW_SECONDS - 60)
    assert homeowner(value).get('/api/sign').json()['status'] == 'signed'
    monkeypatch.setattr(sl.time, 'time', lambda: moment + sl.SIGNED_VIEW_SECONDS + 60)
    for path in ['/api/sign', '/api/sign/signature', '/api/sign/photos/' + 'b' * 32]:
        assert homeowner(value).get(path).status_code == 404


def test_only_the_owner_mints_or_revokes_and_only_for_a_current_audit(context):
    client, store = context
    record = inspect(client)
    unaudited = client.post(
        '/api/inspections/' + ID + '/signing-links',
        json=dict(expected_revision=record['revision'], proposal_hash='0' * 64),
    )
    assert unaudited.status_code == 409
    record = audit(client, record)
    stale = client.post(
        '/api/inspections/' + ID + '/signing-links',
        json=dict(expected_revision=record['revision'], proposal_hash='0' * 64),
    )
    assert stale.status_code == 409
    as_user('other')
    assert mint(client, record).status_code == 404
    assert client.post('/api/inspections/' + ID + '/signing-links/revoke').status_code == 404
    as_user('owner')
    value = token(mint(client, record))
    as_user('other')
    assert client.post('/api/inspections/' + ID + '/signing-links/revoke').status_code == 404
    assert homeowner(value).get('/api/sign').status_code == 200
    assert not [k for k in store.db.records if k.startswith('authorizations/')]


def test_only_the_homeowner_submission_skips_the_bearer_precheck(context):
    anonymous = TestClient(bm.app)
    assert anonymous.post('/api/sign', json={}).status_code == 422
    for path in [
        '/api/authorize',
        '/api/sign/photos/x',
        '/api/inspections/' + ID + '/signing-links',
        '/api/inspections/' + ID + '/signing-links/revoke',
    ]:
        response = anonymous.post(path, json={})
        assert response.status_code == 401 and response.json()['detail'] == 'Sign in to continue.'
    oversized = anonymous.post(
        '/api/sign', content=b'x', headers={'Content-Length': str(int(3.5 * bm.MB) + 1)}
    )
    assert oversized.status_code == 413
    assert bm.body_limit('POST', '/api/sign') == int(3.5 * bm.MB)


def test_submission_requires_name_role_both_consents_and_a_stroke(ready):
    client, store, _, value = ready
    for change in [
        dict(signer_name='   '),
        dict(signer_name='Name\u0000Hidden'),
        dict(signer_role='neighbor'),
        dict(documents_reviewed=False),
        dict(electronic_consent=False),
        dict(consent_version='older-wording'),
        dict(inspection_id=ID),
        dict(expected_revision=99),
    ]:
        assert sign(value, **change).status_code == 422, change
    assert sign(value, signature_png=png(blank=True)).status_code == 400
    saved = sign(
        value, signer_name='  Synthetic   Representative ', signer_role='authorized_representative'
    )
    assert saved.status_code == 200, saved.text
    signer = store.db.records['authorizations/' + saved.json()['auth_id']]['signer']
    assert signer['name'] == 'Synthetic Representative'
    assert signer['role'] == 'authorized_representative'


def test_per_link_read_and_sign_attempt_limits(ready, monkeypatch):
    _, _, _, value = ready
    for _ in range(sl.READS_PER_MINUTE):
        assert homeowner(value).get('/api/sign').status_code == 200
    limited = homeowner(value).get('/api/sign')
    assert limited.status_code == 429 and limited.headers['Retry-After']
    for _ in range(sl.SIGN_ATTEMPTS):
        assert sign(value, signature_png=png(blank=True)).status_code == 400
    assert sign(value).status_code == 409


def test_per_address_limit_covers_every_anonymous_route(ready, monkeypatch):
    _, store, _, value = ready
    monkeypatch.setattr(bm, 'LINK_REQUESTS_PER_MINUTE', 3)

    def via_hosting(address, spoofed='198.51.100.1'):
        return homeowner(value, **{'X-Forwarded-For': spoofed + ', ' + address + ', 35.191.0.1'})

    client = via_hosting('203.0.113.9')
    statuses = [client.get('/api/sign/photos/' + 'b' * 32).status_code for _ in range(3)]
    assert statuses == [200, 200, 200]
    # Changing the client-supplied leading entry does not reset the count.
    for spoofed in ['198.51.100.2', '198.51.100.3']:
        assert via_hosting('203.0.113.9', spoofed).get('/api/sign').status_code == 429
    assert via_hosting('203.0.113.10').get('/api/sign').status_code == 200
    counters = {k: v for k, v in store.db.records.items() if k.startswith('_limits/ip-')}
    assert len(counters) == 2
    # Keyed by an HMAC under a stored server key, never the address or its plain digest.
    plain = sl.hashlib.sha256(b'203.0.113.9').hexdigest()
    dump = json.dumps(store.db.records, default=str)
    assert '203.0.113.9' not in dump and plain not in dump
    assert store.db.records['_server_keys/signing_link_addresses']['key']
    for counter in counters.values():
        remaining = counter['expire_at'].timestamp() - time.time()
        assert 0 < remaining <= sl.ADDRESS_LIMIT_SECONDS


def test_qr_code_encodes_only_the_link(ready):
    client, _, record, _ = ready
    link = mint(client, record).json()
    prefix = 'data:image/svg+xml;base64,'
    assert link['qr_svg'].startswith(prefix)
    svg = base64.b64decode(link['qr_svg'][len(prefix) :]).decode()
    assert svg.startswith('<svg') and '<script' not in svg and 'href' not in svg
    assert link['status'] == 'pending' and link['expires_at']


def test_link_origin_follows_the_requesting_app_origin_only_when_allowed(ready):
    client, _, record, _ = ready
    body = dict(
        expected_revision=record['revision'], proposal_hash=record['audit']['proposal_hash']
    )
    path = '/api/inspections/' + ID + '/signing-links'
    other = client.post(path, json=body, headers={'Origin': bm.ORIGINS[1]}).json()['url']
    assert other.startswith(bm.ORIGINS[1] + '/sign#')
    for origin in ['https://attacker.invalid', None]:
        headers = {'Origin': origin} if origin else {}
        url = client.post(path, json=body, headers=headers).json()['url']
        assert url.startswith(bm.ORIGINS[0] + '/sign#')


def test_tokens_addresses_and_user_agents_never_reach_the_log(ready, capsys):
    _, _, _, value = ready
    capsys.readouterr()
    agent = 'Synthetic-Agent/9.9'
    client = homeowner(value, **{'X-Forwarded-For': '203.0.113.44', 'User-Agent': agent})
    client.get('/api/sign')
    client.get('/api/sign/photos/' + 'b' * 32)
    client.post('/api/sign', json={**SIGNER, 'signature_png': png()})
    homeowner('y' * 43).get('/api/sign')
    output = capsys.readouterr().out
    for secret in [value, sl.link_id(value), '203.0.113.44', agent, 'Synthetic Signer']:
        assert secret not in output


def test_company_estimator_link_signs_through_the_workspace_hooks(api):
    client, current, store = api
    current['uid'] = 'estimator'
    client.post('/api/inspections', json={'inspection_id': ID, 'data': company_data()})
    record = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1}).json()
    current['uid'] = 'office'
    assert mint(client, record).status_code == 403
    current['uid'] = 'other-owner'
    assert mint(client, record).status_code == 404
    current['uid'] = 'estimator'
    link = mint(client, record)
    assert link.status_code == 200, link.text
    value = token(link)
    assert store.db.records['_signing_links/' + sl.link_id(value)]['company_id'] == 'adr'
    view = homeowner(value).get('/api/sign').json()
    assert view['documents']['company_identity']['company_id'] == 'adr'
    saved = sign(value)
    assert saved.status_code == 200, saved.text
    auth_id = saved.json()['auth_id']
    assert store.db.records['_workspace_authorizations/' + auth_id]['company_id'] == 'adr'
    assert store.db.records['_workspace_jobs/' + ID]['status'] == 'signed'
    # The company sees the signed job; the homeowner keeps the read-only copy.
    current['uid'] = 'owner'
    assert client.get('/api/authorizations/' + auth_id).json()['signer']['role'] == 'owner'
    assert homeowner(value).get('/api/sign').json()['status'] == 'signed'


def test_company_link_dies_when_the_technician_loses_job_access(api):
    client, current, store = api
    current['uid'] = 'estimator'
    client.post('/api/inspections', json={'inspection_id': ID, 'data': company_data()})
    record = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1}).json()
    value = token(mint(client, record))
    assert homeowner(value).get('/api/sign').status_code == 200
    store.db.records['_memberships/estimator']['status'] = 'disabled'
    for response in [homeowner(value).get('/api/sign'), sign(value)]:
        assert response.status_code == 404 and response.json()['detail'] == sl.UNAVAILABLE
    assert not [k for k in store.db.records if k.startswith('authorizations/')]
