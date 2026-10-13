from copy import deepcopy
import pytest
from google.api_core.exceptions import AlreadyExists
from backend.job_store import JobStore

from tests.fakes import png

PNG = png()


class Snapshot:
    def __init__(self, value):
        self.value = value
        self.exists = value is not None

    def to_dict(self):
        return deepcopy(self.value)


class Ref:
    def __init__(self, records, key):
        self.records = records
        self.key = key

    def get(self):
        return Snapshot(self.records.get(self.key))

    def create(self, value):
        if self.key in self.records:
            raise AlreadyExists('exists')
        self.records[self.key] = deepcopy(value)


class DB:
    def __init__(self):
        self.records = {}

    def collection(self, name):
        return self

    def document(self, key):
        return Ref(self.records, key)


class Blob:
    def __init__(self, objects, key):
        self.objects = objects
        self.key = key

    def upload_from_string(self, raw, content_type):
        self.objects[self.key] = (raw, content_type)

    def download_as_bytes(self):
        return self.objects[self.key][0]


class Bucket:
    def __init__(self):
        self.objects = {}

    def blob(self, key):
        return Blob(self.objects, key)


@pytest.fixture
def store():
    result = object.__new__(JobStore)
    result.db = DB()
    result.bucket = Bucket()
    return result


def payload():
    return dict(
        auth_id='ADR-AUTH-test123456',
        address='Synthetic',
        proposed_cost=1999,
        signature_png=PNG,
        photos_count=1,
        photos=[{'data_url': PNG, 'ocr_status': 'Not verified'}],
    )


def test_durable_record_contains_private_evidence_references(store):
    record = store.save('owner-a', payload())
    assert record['owner_uid'] == 'owner-a'
    assert 'signature_png' not in record
    assert 'data_url' not in record['photos'][0]
    assert len(store.bucket.objects) == 2
    assert store.evidence(record, 'signature')[0].startswith(b'\x89PNG')
    assert store.get('owner-a', record['auth_id']) == record
    assert store.get('owner-b', record['auth_id']) is None


def test_retry_preserves_first_receipt_and_evidence(store):
    first = store.save('owner-a', payload())
    assert store.save('owner-a', payload()) == first
    assert len(store.db.records) == 1
    assert len(store.bucket.objects) == 2


def test_saved_agreement_cannot_be_replaced(store):
    store.save('owner-a', payload())
    changed = payload()
    changed['proposed_cost'] = 1
    with pytest.raises(ValueError, match='different signed agreement'):
        store.save('owner-a', changed)
    with pytest.raises(ValueError, match='different signed agreement'):
        store.save('owner-b', payload())


def test_invalid_evidence_never_creates_agreement(store):
    invalid = payload()
    invalid['photos'][0]['data_url'] = 'not an image'
    with pytest.raises(ValueError):
        store.save('owner-a', invalid)
    assert not store.db.records and not store.bucket.objects
