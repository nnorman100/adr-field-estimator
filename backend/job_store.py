"""Private signed agreements and evidence in the dedicated ADR project."""
import base64
import hashlib
import json
import os
import re
import io
import warnings
from threading import BoundedSemaphore
from datetime import datetime, timezone
from uuid import uuid4
from google.cloud import firestore, storage
from PIL import Image

# Limit decoded-image memory across concurrent OCR/audit/signature requests.
IMAGE_WORKER = BoundedSemaphore(1)

PROJECT = 'alert-disaster-field-2026'
DATABASE = '(default)'
BUCKET = os.getenv('EVIDENCE_BUCKET', f'{PROJECT}-evidence')
if BUCKET != f'{PROJECT}-evidence':
    raise RuntimeError('Evidence must use the dedicated ADR bucket.')

def decode_image(data_url, *, signature=False):
    match = re.fullmatch(r'data:image/(png|jpeg|webp);base64,([A-Za-z0-9+/=\r\n]+)', data_url or '')
    if not match or (signature and match[1] != 'png'):
        raise ValueError('Use a PNG signature and PNG, JPEG or WebP photos.')
    raw = base64.b64decode(match[2], validate=True)
    if not raw or len(raw) > (2 if signature else 8) * 1024 * 1024:
        raise ValueError('Signature limit is 2 MB; photo limit is 8 MB.')
    signatures = {'png': b'\x89PNG\r\n\x1a\n', 'jpeg': b'\xff\xd8\xff', 'webp': b'RIFF'}
    if not raw.startswith(signatures[match[1]]) or (match[1] == 'webp' and raw[8:12] != b'WEBP'):
        raise ValueError('The uploaded image does not match its file type.')
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as image:
                if image.width * image.height > (4_000_000 if signature else 60_000_000):
                    raise ValueError('Signature exceeds 4 megapixels; photo exceeds 60 megapixels.')
                image.verify()
    except Exception as error:
        raise ValueError('The image is damaged or cannot be decoded.') from error
    return raw, f'image/{match[1]}', match[1]

class JobStore:
    def __init__(self, db=None, bucket=None):
        self.db = db if db is not None else firestore.Client(project=PROJECT, database=DATABASE)
        self.bucket = bucket if bucket is not None else storage.Client(project=PROJECT).bucket(BUCKET)

    def save(self, owner_uid, payload):
        body = dict(payload)
        auth_id = body.get('auth_id') or f'ADR-AUTH-{uuid4().hex}'
        if not re.fullmatch(r'ADR-AUTH-[A-Za-z0-9-]{6,64}', auth_id):
            raise ValueError('Invalid authorization reference.')
        body['auth_id'] = auth_id
        photos = body.get('photos') or []
        if body.get('photos_count', 0) != len(photos):
            raise ValueError('Photo count does not match the attached evidence.')
        signature = decode_image(body['signature_png'], signature=True)
        decoded_photos = [decode_image(photo.get('data_url', '')) for photo in photos]
        metadata_only = {k:v for k,v in body.items() if k not in ('signature_png','photos')}
        metadata_only['photos'] = [{k:v for k,v in p.items() if k != 'data_url'} for p in photos]
        if len(json.dumps(metadata_only, allow_nan=False).encode()) > 750_000:
            raise ValueError('The signed agreement contains too much text to save.')
        canonical = json.dumps(body, sort_keys=True, separators=(',', ':'), allow_nan=False)
        digest = hashlib.sha256(canonical.encode()).hexdigest()
        ref = self.db.collection('authorizations').document(auth_id)
        existing = ref.get()
        if existing.exists:
            current = existing.to_dict()
            if current['owner_uid'] != owner_uid or current['payload_sha256'] != digest:
                raise ValueError('This reference already belongs to a different signed agreement.')
            return current
        # Content-addressed paths keep competing retries from replacing saved evidence.
        prefix = f'users/{owner_uid}/authorizations/{auth_id}/{digest}'
        def upload(name, image):
            raw, mime, extension = image
            path = f'{prefix}/{name}.{extension}'
            self.bucket.blob(path).upload_from_string(raw, content_type=mime)
            return {'path': path, 'content_type': mime, 'sha256': hashlib.sha256(raw).hexdigest()}
        body.pop('signature_png')
        body['signature'] = upload('signature', signature)
        evidence = []
        for i, (photo, image) in enumerate(zip(photos, decoded_photos)):
            metadata = {k: v for k, v in photo.items() if k != 'data_url'}
            metadata['file'] = upload(f'photo-{i}', image)
            evidence.append(metadata)
        body['photos'] = evidence
        if len(json.dumps(body, allow_nan=False).encode()) > 800_000:
            raise ValueError('The signed agreement contains too much text to save.')
        body.update(owner_uid=owner_uid, payload_sha256=digest,
                    created_at=datetime.now(timezone.utc).isoformat(), status='saved')
        # create() prevents a concurrent request from overwriting an immutable agreement.
        from google.api_core.exceptions import AlreadyExists
        try:
            ref.create(body)
        except AlreadyExists:
            current = ref.get().to_dict()
            if current['owner_uid'] != owner_uid or current['payload_sha256'] != digest:
                raise ValueError('This reference already belongs to a different signed agreement.')
            return current
        return body

    def get(self, owner_uid, auth_id):
        if not re.fullmatch(r'ADR-AUTH-[A-Za-z0-9-]{6,64}', auth_id):
            return None
        snapshot = self.db.collection('authorizations').document(auth_id).get()
        data = snapshot.to_dict() if snapshot.exists else None
        return data if data and data.get('owner_uid') == owner_uid else None

    def list(self, owner_uid):
        return self.authorization_page(owner_uid)[0]

    def _page(self, collection, owner_uid, timestamp, identifier, cursor=None):
        source = self.db.collection(collection)
        query = source.where(filter=firestore.FieldFilter('owner_uid', '==', owner_uid)).order_by(timestamp, direction=firestore.Query.DESCENDING)
        if cursor:
            snapshot = source.document(cursor).get()
            if not snapshot.exists or snapshot.to_dict().get('owner_uid') != owner_uid:
                raise LookupError('Page not found.')
            query = query.start_after(snapshot)
        records = [s.to_dict() for s in query.limit(101).stream()]
        return records[:100], records[99][identifier] if len(records)>100 else None

    def authorization_page(self, owner_uid, cursor=None):
        return self._page('authorizations', owner_uid, 'created_at', 'auth_id', cursor)

    def evidence(self, record, name):
        if name == 'signature':
            metadata = record['signature']
        elif re.fullmatch(r'photo-\d+', name):
            index = int(name.split('-')[1])
            if index >= len(record['photos']):
                return None
            metadata = record['photos'][index]['file']
        else:
            return None
        return self.bucket.blob(metadata['path']).download_as_bytes(), metadata['content_type']
