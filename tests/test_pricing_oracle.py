"""The pinned legacy-Python pricing oracle (tests/fixtures/pricing-oracle).

The current code must reproduce every stored answer byte for byte. A difference means the engine,
documents or canonical bytes changed for a stored input; fix the code. The answers are regenerated
only as tests/fixtures/pricing-oracle/README.md describes, never by a new implementation.
"""

import base64
import hashlib
import json
import time
from decimal import ROUND_HALF_EVEN

import pytest

from backend import pricing_v2, signing_links
from backend.contracts import AuthorizeRequest, HomeownerSignature
from scripts import pricing_oracle as oracle
from scripts.pricing_oracle_cases import corpus
from tests.fakes import FakeStore

OWNER = 'oracle-owner'
STORED = oracle.stored_files()
MANIFEST = json.loads(oracle.MANIFEST.read_text(encoding='ascii'))
# Rebuild-plan boundaries that apply to the code today; each must stay in the corpus.
REQUIRED_TAGS = {
    'year_boundary',
    'lead_notice',
    'cent_boundary',
    'half_cent',
    'zero_total',
    'bracket_boundary',
    'brackets',
    'cushion_brackets',
    'tiered',
    'whole-job',
    'room_once',
    'wet_vs_demolition',
    'area_basis',
    'waste',
    'water_category',
    'cabinetry',
    'mixed_rooms',
    'max_quantities',
    'tax',
    'minimum_charge',
    'overhead_profit',
    'after_hours',
    'unpriced_work',
    'extras',
    'approval_snapshot',
    'ocr',
    'uncertainty',
    'unicode',
    'null_omitted',
    'negative_zero',
    'unknown_version',
    'rejection',
    'seeded',
}
REJECTION_STAGES = {'inspection', 'save_checks', 'pin', 'table', 'pricing', 'documents'}


def _case(name):
    return json.loads(STORED[name])


def _first_difference(expected, actual, path='$'):
    """The first JSON path where two parsed values differ, for a readable failure."""
    if type(expected) is not type(actual):
        return path
    if isinstance(expected, dict):
        for key in sorted(set(expected) | set(actual)):
            if key not in expected or key not in actual:
                return f'{path}.{key}'
            found = _first_difference(expected[key], actual[key], f'{path}.{key}')
            if found:
                return found
        return None
    if isinstance(expected, list):
        for index, (left, right) in enumerate(zip(expected, actual)):
            found = _first_difference(left, right, f'{path}[{index}]')
            if found:
                return found
        return (
            None if len(expected) == len(actual) else f'{path}[{min(len(expected), len(actual))}]'
        )
    return None if repr(expected) == repr(actual) else path


def test_manifest_lists_every_case_file_with_its_hash():
    listed = {case['file']: case['sha256'] for case in MANIFEST['cases']}
    on_disk = {f'cases/{name}': hashlib.sha256(raw).hexdigest() for name, raw in STORED.items()}
    assert listed == on_disk
    assert MANIFEST['case_count'] == len(STORED)
    assert MANIFEST['corpus_sha256'] == oracle.corpus_sha256(STORED)
    assert MANIFEST['frozen']['proposal_date'] == oracle.FROZEN_DATE
    assert MANIFEST['calculation_versions'] == sorted({oracle.V1, oracle.V2})


@pytest.mark.parametrize('name', sorted(STORED))
def test_case_reproduces_byte_for_byte(name):
    stored = _case(name)
    body = dict(stored, expected=oracle.evaluate(stored['input']))
    actual = (oracle.render(body) + '\n').encode('ascii')
    if actual != STORED[name]:
        offset = next(
            (i for i, (a, b) in enumerate(zip(STORED[name], actual)) if a != b),
            min(len(actual), len(STORED[name])),
        )
        path = _first_difference(stored['expected'], json.loads(actual)['expected'], '$.expected')
        pytest.fail(f'{name}: first differing byte at offset {offset}, at {path}')


def test_canonical_bytes_hash_to_the_recorded_proposal_hash():
    for name in STORED:
        proposal = _case(name)['expected'].get('proposal')
        if proposal:
            raw = base64.b64decode(proposal['canonical_bytes_base64'])
            assert len(raw) == proposal['byte_length']
            assert hashlib.sha256(raw).hexdigest() == proposal['sha256'], name


def _audited(stored_input, expected):
    """A fake store holding the case's inspection, audited by the production save_audit."""
    store = FakeStore()
    store._ref(stored_input['inspection_id']).create(
        dict(
            inspection_id=stored_input['inspection_id'],
            owner_uid=OWNER,
            revision=stored_input['revision'],
            status='draft',
            data=expected['normalized_inspection'],
            photos=stored_input['photos'],
            audit=None,
        )
    )
    record = store.save_audit(
        OWNER, stored_input['inspection_id'], stored_input['revision'], expected['documents']
    )
    return store, record


def _agreement(store, auth_id, digest):
    store.db.collection('authorizations').document(auth_id).create(
        dict(auth_id=auth_id, owner_uid=OWNER, payload_sha256=digest)
    )


def test_production_save_audit_and_signing_reproduce_the_pinned_hashes(monkeypatch):
    """save_audit, the onsite authorize and the homeowner link sign hash what the oracle pinned:
    each route re-hashes its own payload and only accepts the stored agreement on a match."""
    monkeypatch.setattr(signing_links, 'link_id', lambda token: token)
    signed = 0
    for name in sorted(STORED):
        body = _case(name)
        stored_input, expected = body['input'], body['expected']
        if 'proposal' not in expected:
            continue
        store, record = _audited(stored_input, expected)
        assert record['audit']['proposal_hash'] == expected['proposal']['sha256'], name
        if not expected['signing']:
            continue
        signing, pinned = stored_input['signing'], expected['signing']
        onsite = AuthorizeRequest.model_validate(
            dict(
                inspection_id=stored_input['inspection_id'],
                expected_revision=stored_input['revision'],
                auth_id=signing['auth_id'],
                proposal_hash=record['audit']['proposal_hash'],
                signature_png=signing['signature_png'],
                documents_confirmed=True,
                email_copy=signing.get('email_copy'),
            )
        ).model_dump(mode='json')
        onsite.pop('email_copy', None)
        _agreement(store, signing['auth_id'], pinned['onsite_sha256'])
        assert store.authorize(OWNER, onsite)['payload_sha256'] == pinned['onsite_sha256'], name

        link_auth = pinned['link_payload']['auth_id']
        _agreement(store, link_auth, pinned['link_sha256'])
        store.db.records[store._ref(stored_input['inspection_id']).key]['authorization_id'] = (
            link_auth
        )
        store.db.collection('_signing_links').document(signing['link_key']).create(
            dict(
                inspection_id=stored_input['inspection_id'],
                revision=stored_input['revision'],
                proposal_hash=record['audit']['proposal_hash'],
                owner_uid=OWNER,
                status='used',
                auth_id=link_auth,
                signed_at=time.time(),
                sign_attempts=0,
            )
        )
        request = HomeownerSignature.model_validate(signing['link']).model_dump(mode='json')
        saved = signing_links.sign(store, signing['link_key'], request, {})
        assert saved['payload_sha256'] == pinned['link_sha256'], name
        signed += 1
    assert signed


def test_corpus_builder_matches_the_stored_inputs():
    built = {case['id']: case for case in corpus()}
    stored = {body['id']: body for body in map(json.loads, STORED.values())}
    assert sorted(built) == sorted(stored)
    for case_id, case in built.items():
        assert oracle.render(case['input']) == oracle.render(stored[case_id]['input']), case_id
        assert (case['title'], case['tags']) == (stored[case_id]['title'], stored[case_id]['tags'])


def test_case_files_stay_under_the_line_limit():
    for name, raw in STORED.items():
        assert raw.count(b'\n') <= oracle.MAX_LINES, name
    assert oracle.MANIFEST.read_bytes().count(b'\n') <= oracle.MAX_LINES


def test_corpus_covers_every_required_boundary_and_outcome():
    bodies = [json.loads(raw) for raw in STORED.values()]
    tags = set().union(*(body['tags'] for body in bodies))
    assert REQUIRED_TAGS <= tags, sorted(REQUIRED_TAGS - tags)
    stages = {
        body['expected']['rejected']['stage'] for body in bodies if 'rejected' in body['expected']
    }
    assert stages == REJECTION_STAGES
    signable = [body for body in bodies if body['expected'].get('signing')]
    unsignable = [
        body for body in bodies if body['expected'].get('documents', {}).get('signable') is False
    ]
    assert signable and unsignable
    assert {body['input']['calculation'] for body in signable} == {oracle.V1, oracle.V2}


def test_oracle_detects_a_half_cent_rounding_change(monkeypatch):
    """A candidate that rounds half to even instead of half up must not match."""
    stored = _case('v2-one-cent-half-cent.json')
    monkeypatch.setattr(
        pricing_v2, '_money', lambda value: value.quantize(pricing_v2.CENT, ROUND_HALF_EVEN)
    )
    assert oracle.evaluate(stored['input']) != stored['expected']
