"""Read-only document links: one signed agreement, one document set, many views, never a signature."""

import json, time
import pytest
from fastapi.testclient import TestClient
import backend.main as bm
import backend.document_links as dl
import backend.signing_links as sl
from backend.workspaces import AccessDenied
from tests.test_backend import context, inspect, audit, sign_payload, data, as_user, ID
from tests.test_signing_links import recognized, mint as mint_signing, token as signing_token, sign
from tests.test_workspaces import api, store, data as company_data

AUTH = 'ADR-AUTH-test123456'


def reader(value=None, **headers):
    """A browser with no sign-in: only the document link's own header."""
    if value is not None:
        headers['X-ADR-Document-Link'] = value
    return TestClient(bm.app, headers=headers)


def links(store):
    return {k: v for k, v in store.db.records.items() if k.startswith('_document_links/')}


@pytest.fixture
def signed(context):
    """An owner-only inspection with one recognized photo, audited and signed on the device."""
    client, store = context
    record = audit(client, recognized(client, inspect(client)))
    saved = client.post('/api/authorize', json=sign_payload(record))
    assert saved.status_code == 200, saved.text
    return client, store, store.db.records['authorizations/' + AUTH]


def test_homeowner_link_reads_the_signed_proposal_photos_and_signature_many_times(signed):
    client, store, agreement = signed
    before = time.time()
    value, expires = dl.mint(store, 'owner', AUTH, 'homeowner')
    assert before + dl.LINK_SECONDS <= expires <= time.time() + dl.LINK_SECONDS
    assert dl.LINK_SECONDS == 30 * 86400
    # Only the digest is stored, with identifiers: no token, customer, address or document text.
    [(key, link)] = links(store).items()
    assert key == '_document_links/' + dl.link_id(value)
    dump = json.dumps(store.db.records, default=str)
    assert value not in dump
    assert link['auth_id'] == AUTH and link['inspection_id'] == ID
    assert link['owner_uid'] == 'owner' and link['status'] == 'active'
    assert link['document_set'] == 'homeowner' and link['company_id'] is None
    assert 'Synthetic test property' not in json.dumps(link, default=str)
    assert store.db.records['_document_link_agreements/' + AUTH] == {
        'links': {'homeowner': dl.link_id(value)},
        'owner_uid': 'owner',
    }
    for _ in range(3):
        view = reader(value).get('/api/documents')
        assert view.status_code == 200, view.text
    body = view.json()
    assert body['status'] == 'signed' and body['document_set'] == 'homeowner'
    assert body['tabs'] == ['proposal', 'photos']
    assert body['expires_at'] == dl.iso(expires)
    documents = body['documents']
    assert documents['adr_estimate'] == agreement['documents']['adr_estimate']
    assert documents['xactimate_total'] == agreement['documents']['xactimate_total']
    assert documents['photo_audit_log'] == agreement['documents']['photo_audit_log']
    assert documents['photo_audit_log'][0]['id'] == 'b' * 32
    # The other set's documents are emptied, and the estimator's notes never leave the app.
    assert documents['xactimate_scope'] == [] and documents['iicrc_defense_letter'] == ''
    for hidden in dl.ESTIMATOR_ONLY + ('owner_uid', 'payload_sha256', 'inspection'):
        assert hidden not in documents and hidden not in body
    assert body['receipt'] == dict(
        auth_id=AUTH, timestamp=agreement['created_at'], signing_channel='device'
    )
    assert reader(value).get('/api/documents/photos/' + 'b' * 32).status_code == 200
    assert reader(value).get('/api/documents/photos/' + 'c' * 32).status_code == 404
    signature = reader(value).get('/api/documents/signature')
    assert (
        signature.status_code == 200 and signature.headers['Cache-Control'] == 'private, no-store'
    )
    # The link never signs: the anonymous route has no write, and the bearer precheck holds.
    assert reader(value).post('/api/documents', json={}).status_code == 401
    assert store.db.records['authorizations/' + AUTH] == agreement


V2_BASIS = dict(
    company_id='adr',
    version_id='v4',
    sequence=4,
    content_sha256='a' * 64,
    calculation_version='dryscope-v2',
    priced_at='2026-11-01T12:00:00Z',
    item_count=26,
)
PRICING_DETAIL = [
    dict(V2_BASIS, policy=dict(minimum_job_charge='9000', range=dict(first_percent='50'))),
    dict(V2_BASIS, calculation_version='adr-residential-v1', rates=dict(air_mover='30')),
]


@pytest.mark.parametrize('basis', PRICING_DETAIL, ids=['policy', 'rates'])
@pytest.mark.parametrize('document_set', ['homeowner', 'adjuster'])
def test_link_identifies_the_price_basis_without_the_owners_pricing(signed, document_set, basis):
    client, store, agreement = signed
    agreement['documents']['price_basis'] = basis
    value, _ = dl.mint(store, 'owner', AUTH, document_set)
    delivered = reader(value).get('/api/documents').json()['documents']['price_basis']
    assert not {'policy', 'rates'} & set(delivered)
    assert delivered == {k: v for k, v in basis.items() if k not in ('policy', 'rates')}
    # The company's own view and the signed record keep the full basis.
    assert agreement['documents']['price_basis'] == basis
    assert client.get('/api/authorizations/' + AUTH).json()['documents']['price_basis'] == basis


@pytest.mark.parametrize('document_set', ['homeowner', 'adjuster'])
def test_link_never_delivers_quantity_notes_or_the_entered_overrides(signed, document_set):
    _, store, agreement = signed
    agreement['inspection']['quantity_overrides'] = {
        'labor_hours': dict(measured='8', entered='6', reason='Synthetic entered reason')
    }
    agreement['documents']['quantity_notes'] = [
        dict(label='Labor hours', measured=8, entered=6, reason='Synthetic entered reason')
    ]
    value, _ = dl.mint(store, 'owner', AUTH, document_set)
    view = reader(value).get('/api/documents')
    assert view.status_code == 200, view.text
    assert 'Synthetic entered reason' not in view.text
    assert 'quantity_notes' not in view.json()['documents']


def test_adjuster_link_reads_the_claim_and_letter_without_the_proposal_or_photos(signed):
    client, store, agreement = signed
    homeowner, _ = dl.mint(store, 'owner', AUTH, 'homeowner')
    adjuster, _ = dl.mint(store, 'owner', AUTH, 'adjuster')
    body = reader(adjuster).get('/api/documents').json()
    assert body['document_set'] == 'adjuster' and body['tabs'] == ['claim', 'defense']
    documents = body['documents']
    assert documents['xactimate_scope'] == agreement['documents']['xactimate_scope']
    assert documents['iicrc_defense_letter'] == agreement['documents']['iicrc_defense_letter']
    assert documents['xactimate_total'] == agreement['documents']['xactimate_total']
    # The claim still names the property; the priced proposal and its photos stay out.
    assert set(documents['adr_estimate']) <= {'customer_name', 'property_address', 'date'}
    assert documents['adr_estimate']['property_address'] == 'Synthetic test property'
    assert documents['photo_audit_log'] == []
    for path in ['/api/documents/photos/' + 'b' * 32, '/api/documents/signature']:
        refused = reader(adjuster).get(path)
        assert refused.status_code == 404 and refused.json()['detail'] == dl.UNAVAILABLE
    # Both sets stay active side by side.
    assert reader(homeowner).get('/api/documents').json()['tabs'] == ['proposal', 'photos']
    assert set(store.db.records['_document_link_agreements/' + AUTH]['links']) == {
        'homeowner',
        'adjuster',
    }


def test_minting_a_set_again_revokes_its_earlier_link_and_revoke_ends_them(signed):
    _, store, _ = signed
    first, _ = dl.mint(store, 'owner', AUTH, 'homeowner')
    second, _ = dl.mint(store, 'owner', AUTH, 'homeowner')
    adjuster, _ = dl.mint(store, 'owner', AUTH, 'adjuster')
    refused = reader(first).get('/api/documents')
    assert refused.status_code == 404 and refused.json()['detail'] == dl.UNAVAILABLE
    assert store.db.records['_document_links/' + dl.link_id(first)]['status'] == 'revoked'
    assert reader(second).get('/api/documents').status_code == 200
    assert dl.revoke(store, 'owner', AUTH, 'homeowner') == {'homeowner': 'revoked'}
    assert reader(second).get('/api/documents').status_code == 404
    assert reader(adjuster).get('/api/documents').status_code == 200
    assert dl.revoke(store, 'owner', AUTH) == {'homeowner': 'revoked', 'adjuster': 'revoked'}
    assert reader(adjuster).get('/api/documents').status_code == 404
    assert dl.revoke(store, 'owner', AUTH) == {'homeowner': 'revoked', 'adjuster': 'revoked'}
    with pytest.raises(ValueError):
        dl.revoke(store, 'owner', AUTH, 'crew')
    with pytest.raises(ValueError):
        dl.mint(store, 'owner', AUTH, 'crew')


def test_unknown_tampered_expired_and_other_kind_links_are_not_found(signed, monkeypatch):
    client, store, record = signed
    value, _ = dl.mint(store, 'owner', AUTH, 'homeowner')
    flipped = value[:-1] + ('A' if value[-1] != 'A' else 'B')
    for bad in [None, '', 'short', flipped, value + 'x', 'x' * 43]:
        response = reader(bad).get('/api/documents')
        assert response.status_code == 404 and response.json()['detail'] == dl.UNAVAILABLE
    # A document link is not a signing link, and a signing link is not a document link.
    assert (
        TestClient(bm.app, headers={'X-ADR-Signing-Link': value}).get('/api/sign').status_code
        == 404
    )
    assert reader(value).get('/api/documents').status_code == 200
    later = time.time() + dl.LINK_SECONDS + 1
    monkeypatch.setattr(dl.time, 'time', lambda: later)
    for path in ['/api/documents', '/api/documents/signature', '/api/documents/photos/' + 'b' * 32]:
        expired = reader(value).get(path)
        assert expired.status_code == 404 and expired.json()['detail'] == dl.UNAVAILABLE
    assert dl.revoke(store, 'owner', AUTH, 'homeowner') == {'homeowner': 'expired'}


def test_a_signing_link_token_cannot_open_the_document_routes(context):
    client, store = context
    record = audit(client, recognized(client, inspect(client)))
    value = signing_token(mint_signing(client, record))
    assert sign(value).status_code == 200
    for path in ['/api/documents', '/api/documents/signature', '/api/documents/photos/' + 'b' * 32]:
        response = reader(value).get(path)
        assert response.status_code == 404 and response.json()['detail'] == dl.UNAVAILABLE
    # The agreement signed through the link reports its signer on a document link.
    auth_id = store.db.records['inspections/' + ID]['authorization_id']
    document, _ = dl.mint(store, 'owner', auth_id, 'homeowner')
    receipt = reader(document).get('/api/documents').json()['receipt']
    assert receipt == dict(
        auth_id=auth_id,
        timestamp=store.db.records['authorizations/' + auth_id]['created_at'],
        signing_channel='link',
        signer_name='Synthetic Signer',
        signer_role='owner',
    )


def test_only_a_user_who_can_sign_the_job_mints_and_the_link_dies_with_their_access(signed):
    _, store, _ = signed
    for uid, auth_id in [('other', AUTH), ('owner', 'ADR-AUTH-missing1234'), ('owner', 'bad id')]:
        with pytest.raises(LookupError):
            dl.mint(store, uid, auth_id, 'homeowner')
        with pytest.raises(LookupError):
            dl.revoke(store, uid, auth_id)
    assert links(store) == {}
    value, _ = dl.mint(store, 'owner', AUTH, 'homeowner')
    assert reader(value).get('/api/documents').status_code == 200
    # The record's owner changing (an impossible edit in production) proves reads act as the creator.
    store.db.records['authorizations/' + AUTH]['owner_uid'] = 'someone-else'
    assert reader(value).get('/api/documents').status_code == 404


def test_records_signed_before_claim_details_and_locations_still_open(signed):
    _, store, _ = signed
    agreement = store.db.records['authorizations/' + AUTH]
    agreement['documents'].pop('claim', None)
    for photo in agreement['documents']['photo_audit_log']:
        photo.pop('location', None)
    agreement.pop('signing_channel', None)
    value, _ = dl.mint(store, 'owner', AUTH, 'homeowner')
    body = reader(value).get('/api/documents').json()
    assert 'claim' not in body['documents']
    assert 'location' not in body['documents']['photo_audit_log'][0]
    assert body['receipt']['signing_channel'] == 'device'
    # An agreement without stored photo files answers 404 for a photo, never an error.
    agreement.pop('photos')
    assert reader(value).get('/api/documents/photos/' + 'b' * 32).status_code == 404
    assert reader(value).get('/api/documents').status_code == 200


def test_per_link_reads_and_the_shared_address_limit_are_counted(signed, monkeypatch):
    _, store, _ = signed
    value, _ = dl.mint(store, 'owner', AUTH, 'homeowner')
    for _ in range(dl.READS_PER_MINUTE):
        assert reader(value).get('/api/documents').status_code == 200
    limited = reader(value).get('/api/documents')
    assert limited.status_code == 429 and limited.headers['Retry-After']
    # Photos and the signature are not counted reads of the documents.
    assert reader(value).get('/api/documents/signature').status_code == 200
    monkeypatch.setattr(bm, 'LINK_REQUESTS_PER_MINUTE', 3)
    hops = {'X-Forwarded-For': '198.51.100.1, 203.0.113.9, 35.191.0.1'}
    client = reader(value, **hops)
    assert [client.get('/api/documents/signature').status_code for _ in range(3)] == [200] * 3
    # One address counter covers the document and signing routes together.
    assert client.get('/api/documents/signature').status_code == 429
    assert (
        TestClient(bm.app, headers={**hops, 'X-ADR-Signing-Link': 'x' * 43})
        .get('/api/sign')
        .status_code
        == 429
    )
    assert '203.0.113.9' not in json.dumps(store.db.records, default=str)


def test_tokens_digests_addresses_agents_and_names_never_reach_the_log(signed, capsys):
    _, store, _ = signed
    value, _ = dl.mint(store, 'owner', AUTH, 'homeowner')
    capsys.readouterr()
    agent = 'Synthetic-Agent/9.9'
    client = reader(value, **{'X-Forwarded-For': '203.0.113.44', 'User-Agent': agent})
    client.get('/api/documents')
    client.get('/api/documents/photos/' + 'b' * 32)
    client.get('/api/documents/signature')
    reader('y' * 43).get('/api/documents')
    dl.revoke(store, 'owner', AUTH)
    output = capsys.readouterr().out
    for secret in [value, dl.link_id(value), '203.0.113.44', agent, 'Synthetic test property']:
        assert secret not in output


def company_signed(client, current, store, uid='estimator'):
    current['uid'] = uid
    client.post('/api/inspections', json={'inspection_id': ID, 'data': company_data()})
    record = client.post('/api/audit', json={'inspection_id': ID, 'expected_revision': 1}).json()
    payload = dict(
        inspection_id=ID,
        expected_revision=record['revision'],
        auth_id=AUTH,
        proposal_hash=record['audit']['proposal_hash'],
        signature_png=sign_payload(record)['signature_png'],
        documents_confirmed=True,
    )
    saved = client.post('/api/authorize', json=payload)
    assert saved.status_code == 200, saved.text
    return store.db.records['authorizations/' + AUTH]


def test_company_links_follow_the_job_sign_permission(api):
    client, current, store = api
    agreement = company_signed(client, current, store)
    # Office staff cannot sign, superadmin support is not a membership, other companies see no job.
    with pytest.raises(AccessDenied):
        dl.mint(store, 'office', AUTH, 'homeowner')
    with pytest.raises(AccessDenied):
        dl.mint(store, 'admin', AUTH, 'homeowner')
    with pytest.raises(LookupError):
        dl.mint(store, 'other-owner', AUTH, 'homeowner')
    with pytest.raises(LookupError):
        dl.mint(store, 'estimator2', AUTH, 'homeowner')
    assert links(store) == {}
    value, _ = dl.mint(store, 'estimator', AUTH, 'homeowner')
    owner_link, _ = dl.mint(store, 'owner', AUTH, 'adjuster')
    stored = links(store)
    assert {link['company_id'] for link in stored.values()} == {'adr'}
    view = reader(value).get('/api/documents').json()
    assert view['documents']['company_identity']['company_id'] == 'adr'
    assert view['documents']['adr_estimate'] == agreement['documents']['adr_estimate']
    assert reader(owner_link).get('/api/documents').status_code == 200
    with pytest.raises(AccessDenied):
        dl.revoke(store, 'office', AUTH)
    # A technician who loses the job disables their links; the owner's own link keeps working.
    store.db.records['_memberships/estimator']['status'] = 'disabled'
    refused = reader(value).get('/api/documents')
    assert refused.status_code == 404 and refused.json()['detail'] == dl.UNAVAILABLE
    assert reader(value).get('/api/documents/photos/' + 'b' * 32).status_code == 404
    assert reader(owner_link).get('/api/documents').status_code == 200
    assert store.db.records['authorizations/' + AUTH] == agreement


def test_revoke_all_active_sets_reads_before_writing(signed, monkeypatch):
    from tests.fakes import Ref, Tx

    _, store, _ = signed
    tokens = [dl.mint(store, 'owner', AUTH, name)[0] for name in dl.SETS]
    original_get = Ref.get

    def get(ref, transaction=None):
        assert not transaction or not getattr(transaction, 'written', False)
        return original_get(ref, transaction)

    class StrictTx(Tx):
        written = False

        def update(self, *args, **kwargs):
            self.written = True
            return super().update(*args, **kwargs)

    monkeypatch.setattr(Ref, 'get', get)
    monkeypatch.setattr(store, '_atomic', lambda callback: callback(StrictTx()))
    assert dl.revoke(store, 'owner', AUTH) == dict.fromkeys(dl.SETS, 'revoked')
    for token in tokens:
        assert reader(token).get('/api/documents').status_code == 404


def test_links_stop_when_creator_becomes_office(api):
    client, current, store = api
    company_signed(client, current, store)
    tokens = [dl.mint(store, 'estimator', AUTH, name)[0] for name in dl.SETS]
    for token in tokens:
        assert reader(token).get('/api/documents').status_code == 200
    store.db.records['_memberships/estimator']['role'] = 'office'
    assert store.get('estimator', AUTH)
    paths = ['/api/documents', '/api/documents/signature', '/api/documents/photos/' + 'b' * 32]
    for token in tokens:
        for path in paths:
            response = reader(token).get(path)
            assert response.status_code == 404 and response.json()['detail'] == dl.UNAVAILABLE
