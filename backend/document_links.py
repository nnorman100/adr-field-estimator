"""Read-only document links for one signed agreement.

Each link is bound to one signed authorization and one document set: the homeowner's set (the
signed proposal and the photo log) or the adjuster's set (the itemized claim and the scope defense
letter). The server returns the token once when minting; Firestore keeps only its SHA-256 digest.
Every read acts as the technician who created the link, through the store's access hooks, so a
technician who loses the job disables their links. A link is viewed any number of times until it
expires or is revoked; it never signs. Tokens, IP addresses and user agents never reach the log.
"""

import re
import secrets
import time
from datetime import datetime, timezone

try:
    from .inspection_store import reserve_slot
    from .signing_links import TOKEN, iso, link_documents, link_id as digest_of
    from .workspaces import AccessDenied
except ImportError:
    from inspection_store import reserve_slot
    from signing_links import TOKEN, iso, link_documents, link_id as digest_of
    from workspaces import AccessDenied

# The owner can change how long a link works; the roadmap's default is 30 days.
LINK_SECONDS = 30 * 86400
READS_PER_MINUTE = 60
AUTH_ID = re.compile(r'ADR-AUTH-[A-Za-z0-9-]{6,64}')
# The documents each recipient receives (docs/roadmap.md, "Who gets what"). A tab names the page's
# document; "photos" also lets the link fetch the photo files and "proposal" the saved signature.
SETS = {
    'homeowner': ('proposal', 'photos'),
    'adjuster': ('claim', 'defense'),
}
UNAVAILABLE = 'This document link is not available. Ask your restoration company for a new link.'
# Notes the company sees in the app; they are never part of a delivered document.
ESTIMATOR_ONLY = (
    'ai_summary',
    'ai_suggestions',
    'unpriced_work',
    'company_setup_missing',
    'quantity_notes',
)


# What the itemized claim prints from the estimate: the lines that add up to the claim total.
CLAIM_ESTIMATE_KEYS = (
    'low',
    'after_hours_label',
    'after_hours_percent',
    'overhead_profit_percent',
    'sales_tax_percent',
)


def link_id(token):
    if not isinstance(token, str) or not TOKEN.fullmatch(token):
        raise LookupError(UNAVAILABLE)
    return digest_of(token)


def _links(store):
    return store.db.collection('_document_links')


def _pointer(store, auth_id):
    # One active link per agreement and document set: minting the same set again revokes the
    # link this pointer names for it.
    return store.db.collection('_document_link_agreements').document(auth_id)


def _agreement_ref(store, auth_id):
    if not isinstance(auth_id, str) or not AUTH_ID.fullmatch(auth_id):
        raise LookupError('Signed agreement not found.')
    return store.db.collection('authorizations').document(auth_id)


def mint(store, uid, auth_id, document_set):
    """A new link for one document set of a signed agreement the user may sign for.

    Returns the token (shown once) and the expiry moment. The creating user needs the job's `sign`
    permission, as for a signing link, because every later read acts as that user."""
    if document_set not in SETS:
        raise ValueError('Unknown document set.')
    token = secrets.token_urlsafe(32)
    key = link_id(token)
    agreement_ref = _agreement_ref(store, auth_id)
    pointer_ref = _pointer(store, auth_id)

    def create(tx):
        agreement = store._owned(agreement_ref.get(transaction=tx), uid, 'sign', tx)
        company_id = store._company_id(uid, agreement, tx)
        pointer = pointer_ref.get(transaction=tx)
        links = dict(pointer.to_dict().get('links', {})) if pointer.exists else {}
        moment = time.time()
        previous_key = links.get(document_set)
        if previous_key:
            previous_ref = _links(store).document(previous_key)
            previous = previous_ref.get(transaction=tx).to_dict()
            if previous and previous['status'] == 'active':
                tx.update(previous_ref, {'status': 'revoked', 'ended_at': moment})
        tx.create(
            _links(store).document(key),
            dict(
                auth_id=auth_id,
                inspection_id=agreement.get('inspection_id'),
                document_set=document_set,
                owner_uid=uid,
                company_id=company_id,
                status='active',
                created_at=moment,
                expires=moment + LINK_SECONDS,
                # Firestore TTL field; expiry is enforced on every use before physical deletion.
                expire_at=datetime.fromtimestamp(moment + LINK_SECONDS, timezone.utc),
                limits={},
            ),
        )
        links[document_set] = key
        tx.set(pointer_ref, {'links': links, 'owner_uid': uid})
        return moment + LINK_SECONDS

    return token, store._atomic(create)


def revoke(store, uid, auth_id, document_set=None):
    """Revoke the agreement's active link for one document set, or for every set.

    Returns the resulting status of each named set: `revoked`, `none`, or its earlier state."""
    agreement_ref = _agreement_ref(store, auth_id)
    pointer_ref = _pointer(store, auth_id)
    wanted = [document_set] if document_set else list(SETS)
    if any(name not in SETS for name in wanted):
        raise ValueError('Unknown document set.')

    def update(tx):
        store._owned(agreement_ref.get(transaction=tx), uid, 'sign', tx)
        pointer = pointer_ref.get(transaction=tx)
        links = pointer.to_dict().get('links', {}) if pointer.exists else {}
        moment = time.time()
        result = {}
        selected = []
        for name in wanted:
            key = links.get(name)
            link_ref = _links(store).document(key) if key else None
            link = link_ref.get(transaction=tx).to_dict() if link_ref else None
            selected.append((name, link_ref, link))
        for name, link_ref, link in selected:
            if not link:
                result[name] = 'none'
            elif link['status'] != 'active':
                result[name] = link['status']
            elif moment >= link['expires']:
                result[name] = 'expired'
            else:
                tx.update(link_ref, {'status': 'revoked', 'ended_at': moment})
                result[name] = 'revoked'
        return result

    return store._atomic(update)


def _resolve(store, key, count=False):
    """The link and the signed agreement it names, read as the link's creator."""
    link_ref = _links(store).document(key)

    def check(tx):
        snapshot = link_ref.get(transaction=tx)
        link = snapshot.to_dict() if snapshot.exists else None
        if not link or link['status'] != 'active' or time.time() >= link['expires']:
            raise LookupError(UNAVAILABLE)
        if count:
            limits = reserve_slot(link.get('limits', {}), 'reads', READS_PER_MINUTE)
            tx.update(link_ref, {'limits': limits})
        return link

    link = store._atomic(check)
    try:
        agreement = store.get(link['owner_uid'], link['auth_id'])
        if agreement:
            store._access(link['owner_uid'], agreement, 'sign')
    except (AccessDenied, LookupError):
        agreement = None
    if not agreement:
        raise LookupError(UNAVAILABLE)
    return link, agreement


def delivered_documents(documents, tabs):
    """The saved documents reduced to one set: other documents are emptied, never summarized."""
    kept = {k: v for k, v in link_documents(documents).items() if k not in ESTIMATOR_ONLY}
    if 'proposal' not in tabs:
        proposal = documents.get('adr_estimate') or {}
        # The claim and letter still name the customer and property; the priced proposal stays out.
        kept['adr_estimate'] = {
            k: proposal[k] for k in ('customer_name', 'property_address', 'date') if k in proposal
        }
    estimate = documents.get('estimate')
    if estimate and 'proposal' not in tabs:
        kept['estimate'] = {k: estimate[k] for k in CLAIM_ESTIMATE_KEYS}
    elif estimate and estimate['show_line_breakdown'] and 'claim' not in tabs:
        kept['estimate'] = {
            **estimate,
            'lines': [
                {k: line[k] for k in ('description', 'quantity', 'unit', 'total')}
                for line in documents['xactimate_scope']
            ],
        }
    if 'claim' not in tabs:
        kept['xactimate_scope'] = []
    if 'defense' not in tabs:
        kept['iicrc_defense_letter'] = ''
    if 'photos' not in tabs:
        kept['photo_audit_log'] = []
    return kept


def view(store, token):
    link, agreement = _resolve(store, link_id(token), count=True)
    tabs = list(SETS[link['document_set']])
    signer = agreement.get('signer') or {}
    receipt = dict(
        auth_id=agreement['auth_id'],
        timestamp=agreement['created_at'],
        signing_channel=agreement.get('signing_channel', 'device'),
    )
    if signer.get('name'):
        receipt.update(signer_name=signer['name'], signer_role=signer.get('role'))
    return dict(
        status='signed',
        document_set=link['document_set'],
        tabs=tabs,
        expires_at=iso(link['expires']),
        documents=delivered_documents(agreement['documents'], tabs),
        receipt=receipt,
    )


def photo(store, token, photo_id):
    link, agreement = _resolve(store, link_id(token))
    if 'photos' not in SETS[link['document_set']]:
        raise LookupError(UNAVAILABLE)
    found = next((p for p in agreement.get('photos', []) if p['id'] == photo_id), None)
    if not found:
        raise LookupError(UNAVAILABLE)
    raw = store.bucket.blob(found['file']['path']).download_as_bytes()
    return raw, found['file']['content_type']


def signature(store, token):
    link, agreement = _resolve(store, link_id(token))
    if 'proposal' not in SETS[link['document_set']]:
        raise LookupError(UNAVAILABLE)
    metadata = agreement['signature']
    return store.bucket.blob(metadata['path']).download_as_bytes(), metadata['content_type']
