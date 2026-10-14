"""Single-use homeowner signing links bound to one audited inspection revision.

The technician sees the token once; Firestore keeps only its SHA-256 digest. A link reads and
signs as the technician who created it, so the store's access hooks apply owner-only or company
job access in both modes. Tokens, IP addresses and user agents never reach the log.
"""

import base64
import hashlib
import hmac
import re
import secrets
import time
from datetime import datetime, timezone
import qrcode
import qrcode.image.svg

try:
    from .inspection_store import Conflict, canonical, reserve_slot
    from .workspaces import AccessDenied
except ImportError:
    from inspection_store import Conflict, canonical, reserve_slot
    from workspaces import AccessDenied

LINK_SECONDS = 7 * 86400
SIGNED_VIEW_SECONDS = 30 * 86400
READS_PER_MINUTE = 60
SIGN_ATTEMPTS = 10
TOKEN = re.compile(r'[A-Za-z0-9_-]{43}')
# The page shows these statements and the signed record stores them with their version.
CONSENT_VERSION = 'homeowner-link-v1'
CONSENT = [
    'I reviewed all four documents, the separate totals and the attached photo evidence.',
    'I agree to sign this agreement electronically and to receive it electronically. '
    'I can print or save a copy from this page.',
]
# Per-address counters are keyed by an HMAC under a server key and expire once idle this long.
ADDRESS_LIMIT_SECONDS = 3600
UNAVAILABLE = 'This signing link is not available. Ask your technician for a new link.'
UPDATED = 'This estimate was updated. Ask your technician for a new link.'


def link_id(token):
    if not isinstance(token, str) or not TOKEN.fullmatch(token):
        raise LookupError(UNAVAILABLE)
    return hashlib.sha256(token.encode()).hexdigest()


def address_key(store, address):
    """The _limits document for a client address; without the stored key it cannot be reversed."""
    secret = getattr(store, '_address_secret', None)
    if secret is None:
        ref = store.db.collection('_server_keys').document('signing_link_addresses')

        def load(tx):
            snapshot = ref.get(transaction=tx)
            if snapshot.exists:
                return snapshot.to_dict()['key']
            key = secrets.token_hex(32)
            tx.create(ref, {'key': key})
            return key

        secret = store._address_secret = bytes.fromhex(store._atomic(load))
    return 'ip-' + hmac.new(secret, address.encode(), hashlib.sha256).hexdigest()


def iso(moment):
    return datetime.fromtimestamp(moment, timezone.utc).isoformat()


def qr_data_url(url):
    image = qrcode.make(url, image_factory=qrcode.image.svg.SvgPathFillImage, border=4)
    return 'data:image/svg+xml;base64,' + base64.b64encode(image.to_string()).decode()


def _links(store):
    return store.db.collection('_signing_links')


def _pointer(store, inspection_id):
    # One active link per inspection: minting again revokes the link this pointer names.
    return store.db.collection('_signing_link_jobs').document(inspection_id)


def _owned(store, uid, snapshot, action, tx):
    try:
        return store._owned(snapshot, uid, action, tx)
    except AccessDenied:
        raise LookupError(UNAVAILABLE)


def mint(store, uid, inspection_id, revision, proposal_hash):
    token = secrets.token_urlsafe(32)
    key = link_id(token)
    inspection_ref = store._ref(inspection_id)
    pointer_ref = _pointer(store, inspection_id)

    def create(tx):
        record = store._owned(inspection_ref.get(transaction=tx), uid, 'sign', tx)
        if record['status'] == 'signed':
            raise Conflict('This inspection is already signed.')
        store._signable(record, {'expected_revision': revision, 'proposal_hash': proposal_hash})
        store._check_documents(uid, record['audit']['documents'], tx)
        company_id = store._company_id(uid, record, tx)
        pointer = pointer_ref.get(transaction=tx)
        previous_ref = (
            _links(store).document(pointer.to_dict()['link_id']) if pointer.exists else None
        )
        previous = previous_ref.get(transaction=tx).to_dict() if previous_ref else None
        moment = time.time()
        if previous and previous['status'] == 'pending':
            tx.update(previous_ref, {'status': 'revoked', 'ended_at': moment})
        tx.create(
            _links(store).document(key),
            dict(
                inspection_id=inspection_id,
                revision=revision,
                proposal_hash=proposal_hash,
                owner_uid=uid,
                company_id=company_id,
                status='pending',
                created_at=moment,
                expires=moment + LINK_SECONDS,
                # Firestore TTL field; expiry is enforced on every use before physical deletion.
                expire_at=datetime.fromtimestamp(moment + LINK_SECONDS, timezone.utc),
                limits={},
                sign_attempts=0,
            ),
        )
        tx.set(pointer_ref, {'link_id': key, 'owner_uid': uid})
        return moment + LINK_SECONDS

    return token, store._atomic(create)


def revoke(store, uid, inspection_id):
    inspection_ref = store._ref(inspection_id)
    pointer_ref = _pointer(store, inspection_id)

    def update(tx):
        store._owned(inspection_ref.get(transaction=tx), uid, 'sign', tx)
        pointer = pointer_ref.get(transaction=tx)
        if not pointer.exists:
            return 'none'
        link_ref = _links(store).document(pointer.to_dict()['link_id'])
        link = link_ref.get(transaction=tx).to_dict() or {}
        if link.get('status') != 'pending':
            return link.get('status', 'none')
        tx.update(link_ref, {'status': 'revoked', 'ended_at': time.time()})
        return 'revoked'

    return store._atomic(update)


def status(store, uid, inspection_id):
    """The job's current link for its technician, never the token; pending only while it can sign."""
    inspection_ref = store._ref(inspection_id)
    pointer_ref = _pointer(store, inspection_id)

    def read(tx):
        record = store._owned(inspection_ref.get(transaction=tx), uid, 'sign', tx)
        pointer = pointer_ref.get(transaction=tx)
        if not pointer.exists:
            return dict(status='none')
        link = _links(store).document(pointer.to_dict()['link_id']).get(transaction=tx).to_dict()
        if not link or link['status'] != 'pending':
            return dict(status=link['status'] if link else 'none')
        if time.time() >= link['expires']:
            return dict(status='expired')
        try:
            if record['status'] == 'signed':
                raise Conflict(UPDATED)
            store._signable(
                record,
                {'expected_revision': link['revision'], 'proposal_hash': link['proposal_hash']},
            )
        except Conflict:
            return dict(status='voided')
        return dict(status='pending', expires_at=iso(link['expires']))

    return store._atomic(read)


def _resolve(store, key, count=False):
    """The link and its inspection; a pending link whose estimate changed becomes voided."""
    link_ref = _links(store).document(key)

    def check(tx):
        snapshot = link_ref.get(transaction=tx)
        link = snapshot.to_dict() if snapshot.exists else None
        moment = time.time()
        if not link:
            raise LookupError(UNAVAILABLE)
        if link['status'] == 'voided':
            return link, None
        if link['status'] == 'used':
            if moment >= link['signed_at'] + SIGNED_VIEW_SECONDS:
                raise LookupError(UNAVAILABLE)
        elif link['status'] != 'pending' or moment >= link['expires']:
            raise LookupError(UNAVAILABLE)
        inspection = store._ref(link['inspection_id']).get(transaction=tx)
        record = _owned(store, link['owner_uid'], inspection, 'read', tx)
        if link['status'] == 'used':
            if record.get('authorization_id') != link['auth_id']:
                raise LookupError(UNAVAILABLE)
        else:
            try:
                if record['status'] == 'signed':
                    raise Conflict(UPDATED)
                store._signable(
                    record,
                    {'expected_revision': link['revision'], 'proposal_hash': link['proposal_hash']},
                )
            except Conflict:
                tx.update(link_ref, {'status': 'voided', 'ended_at': moment})
                return link, None
        if count:
            limits = reserve_slot(link.get('limits', {}), 'reads', READS_PER_MINUTE)
            tx.update(link_ref, {'limits': limits})
        return link, record

    link, record = store._atomic(check)
    if record is None:
        raise Conflict(UPDATED)
    return link, record


def _agreement(store, link):
    try:
        agreement = store.get(link['owner_uid'], link['auth_id'])
    except AccessDenied:
        agreement = None
    if not agreement:
        raise LookupError(UNAVAILABLE)
    return agreement


def view(store, token):
    link, record = _resolve(store, link_id(token), count=True)
    result = dict(consent=dict(version=CONSENT_VERSION, statements=CONSENT))
    if link['status'] == 'pending':
        return dict(
            result,
            status='pending',
            expires_at=iso(link['expires']),
            documents=record['audit']['documents'],
        )
    agreement = _agreement(store, link)
    return dict(
        result,
        status='signed',
        view_until=iso(link['signed_at'] + SIGNED_VIEW_SECONDS),
        documents=agreement['documents'],
        receipt=dict(
            auth_id=agreement['auth_id'],
            timestamp=agreement['created_at'],
            signer_name=agreement['signer']['name'],
            signer_role=agreement['signer']['role'],
        ),
    )


def photo(store, token, photo_id):
    _, record = _resolve(store, link_id(token))
    found = next((p for p in record['photos'] if p['id'] == photo_id), None)
    if not found:
        raise LookupError(UNAVAILABLE)
    raw = store.bucket.blob(found['file']['path']).download_as_bytes()
    return raw, found['file']['content_type']


def signature(store, token):
    link, _ = _resolve(store, link_id(token))
    if link['status'] != 'used':
        raise LookupError(UNAVAILABLE)
    metadata = _agreement(store, link)['signature']
    return store.bucket.blob(metadata['path']).download_as_bytes(), metadata['content_type']


class LinkClaim:
    """Marks the link used in the same transaction that creates the signed agreement."""

    def __init__(self, ref):
        self.ref = ref

    def check(self, tx):
        snapshot = self.ref.get(transaction=tx)
        link = snapshot.to_dict() if snapshot.exists else None
        if not link or link['status'] != 'pending' or time.time() >= link['expires']:
            raise LookupError(UNAVAILABLE)

    def consume(self, tx, body):
        moment = time.time()
        tx.update(
            self.ref,
            {
                'status': 'used',
                'auth_id': body['auth_id'],
                'signed_at': moment,
                'expire_at': datetime.fromtimestamp(moment + SIGNED_VIEW_SECONDS, timezone.utc),
            },
        )


def sign(store, token, req, client):
    """client holds the request's IP address and user agent for the record."""
    key = link_id(token)
    link_ref = _links(store).document(key)

    def attempt(tx):
        snapshot = link_ref.get(transaction=tx)
        if not snapshot.exists:
            raise LookupError(UNAVAILABLE)
        attempts = snapshot.to_dict().get('sign_attempts', 0)
        if attempts >= SIGN_ATTEMPTS:
            raise Conflict('Too many signing attempts. Ask your technician for a new link.')
        tx.update(link_ref, {'sign_attempts': attempts + 1})

    store._atomic(attempt)
    link, _ = _resolve(store, key)
    # Revision, hash and reference come from the link, never from the homeowner's browser.
    payload = dict(
        inspection_id=link['inspection_id'],
        expected_revision=link['revision'],
        auth_id='ADR-AUTH-link-' + key[:32],
        proposal_hash=link['proposal_hash'],
        signature_png=req['signature_png'],
        documents_confirmed=True,
        signer_name=req['signer_name'],
        signer_role=req['signer_role'],
        consent_version=req['consent_version'],
    )
    if link['status'] == 'used':
        existing = _agreement(store, link)
        digest = hashlib.sha256(canonical(payload).encode()).hexdigest()
        if existing.get('payload_sha256') != digest:
            raise Conflict('This estimate is already signed.')
        return existing
    extra = dict(
        signing_channel='link',
        signer=dict(name=req['signer_name'], role=req['signer_role'], **client),
        consent=dict(
            version=CONSENT_VERSION,
            statements=CONSENT,
            documents_reviewed=True,
            electronic_records=True,
        ),
        signing_link=dict(id=key, created_by=link['owner_uid'], created_at=iso(link['created_at'])),
    )
    try:
        return store.authorize(link['owner_uid'], payload, extra, LinkClaim(link_ref))
    except AccessDenied:
        raise LookupError(UNAVAILABLE)
