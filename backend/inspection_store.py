"""Transactional owner-private inspection lifecycle and cross-instance limits."""

import hashlib
import io
import json
import logging
import re
import time
from datetime import datetime, timezone
from uuid import uuid4
from PIL import Image
from google.cloud import firestore

try:
    from .job_store import JobStore, decode_image, IMAGE_WORKER
    from .cloud_log import event
    from .scope import default_photo_rename
    from .contracts import InspectionData
    from .psychrometrics import psychrometrics
except ImportError:
    from job_store import JobStore, decode_image, IMAGE_WORKER
    from cloud_log import event
    from scope import default_photo_rename
    from contracts import InspectionData
    from psychrometrics import psychrometrics

# Per-user daily caps on paid Vertex AI calls; Live counts new (non-resume) session starts.
DAILY_LIMITS = {'ocr': 400, 'audit': 60, 'scope': 120, 'live': 40, 'transcribe': 200}
TRANSCRIPT_LIMIT = 80000


class Conflict(ValueError):
    pass


class Limited(ValueError):
    def __init__(self, seconds=60):
        self.retry_after = seconds
        super().__init__('Too many requests. Please wait and retry.')


def reserve_slot(data, action, maximum, window=60):
    moment = time.time()
    counter = data.get(action, {'start': moment, 'count': 0})
    if moment - counter['start'] >= window:
        counter = {'start': moment, 'count': 0}
    if counter['count'] >= maximum:
        raise Limited(max(1, int(window - (moment - counter['start']))))
    counter['count'] += 1
    data[action] = counter
    return data


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)


def checked_metadata(value):
    if len(canonical(value).encode()) > 750_000:
        raise ValueError('Inspection text exceeds the storage limit.')


def changed_fields(old, new):
    # A key the saved shape leaves out when empty (equipment_scans) equals its empty default.
    def value(record, key):
        found = record.get(key)
        return None if found in ([], '', {}) else found

    return sorted(key for key in old.keys() | new.keys() if value(old, key) != value(new, key))


def saved(inspection_id, record, changed):
    # Field names from the fixed inspection schema only, never their values.
    event(
        'Inspection saved',
        operation='save',
        inspection_id=inspection_id,
        revision=record['revision'],
        changed_fields=changed,
    )
    return record


def now():
    return datetime.now(timezone.utc).isoformat()


class InspectionStore(JobStore):
    def _discard_unreferenced(self, blob, ref):
        # Each attempt has a unique path. Never delete the winning retry's object,
        # including when a commit succeeded but its response was lost.
        try:
            snapshot = ref.get()
            record = snapshot.to_dict() if snapshot.exists else {}
            paths = {p['file']['path'] for p in record.get('photos', [])}
            paths.add(record.get('signature', {}).get('path'))
            if blob.name not in paths:
                blob.delete(if_generation_match=blob.generation)
        except Exception as error:
            # The object path and the error text name the user; record only the error class.
            event(
                'Upload cleanup could not be confirmed; private object retained',
                logging.ERROR,
                operation='upload_cleanup',
                outcome=type(error).__name__,
            )

    def _ref(self, inspection_id):
        if not re.fullmatch(r'ADR-INS-[a-f0-9]{32}', inspection_id):
            raise LookupError('Inspection not found.')
        return self.db.collection('inspections').document(inspection_id)

    def _atomic(self, callback):
        transaction = self.db.transaction()
        return firestore.transactional(callback)(transaction)

    def _owned(self, snapshot, uid, action='read', tx=None):
        record = snapshot.to_dict() if snapshot.exists else None
        if not record:
            raise LookupError('Inspection not found.')
        self._access(uid, record, action, tx)
        return record

    def _access(self, uid, record, action='read', tx=None):
        if record.get('owner_uid') != uid:
            raise LookupError('Inspection not found.')

    def _create_access(self, uid, record, tx):
        pass

    def _sync_access(self, record, tx):
        pass

    def _commit_authorization(self, uid, record, body, tx):
        pass

    def _check_documents(self, uid, record, tx=None):
        pass

    def _company_id(self, uid, record, tx=None):
        return None

    def get_inspection(self, uid, inspection_id):
        return self._owned(self._ref(inspection_id).get(), uid)

    def list_inspections(self, uid):
        return self.inspection_page(uid)[0]

    def inspection_page(self, uid, cursor=None):
        return self._page('inspections', uid, 'updated_at', 'inspection_id', cursor)

    def create_inspection(self, uid, inspection_id, data):
        checked_metadata(data)
        ref = self._ref(inspection_id)
        changed = []

        def create(tx):
            snapshot = ref.get(transaction=tx)
            if snapshot.exists:
                existing = self._owned(snapshot, uid, 'create', tx)
                if existing['data'] != data:
                    raise Conflict('This inspection already exists. Restore it before editing.')
                changed.clear()
                return existing
            changed[:] = changed_fields(InspectionData().model_dump(mode='json'), data)
            record = dict(
                inspection_id=inspection_id,
                schema_version=3,
                owner_uid=uid,
                revision=1,
                data=data,
                photos=[],
                audit=None,
                status='draft',
                created_at=now(),
                updated_at=now(),
            )
            self._create_access(uid, record, tx)
            tx.create(ref, record)
            return record

        return saved(inspection_id, self._atomic(create), changed)

    def _change(self, uid, inspection_id, revision, transform, action='scope'):
        ref = self._ref(inspection_id)

        def change(tx):
            record = self._owned(ref.get(transaction=tx), uid, action, tx)
            if record['status'] == 'signed':
                raise Conflict('Signed inspections are immutable. Start a new inspection.')
            if record['revision'] != revision:
                raise Conflict(
                    'The inspection changed. Restore the latest draft or save your local work as a new inspection.'
                )
            record = transform(record)
            checked_metadata(record)
            record['updated_at'] = now()
            self._check_documents(uid, record, tx)
            self._sync_access(record, tx)
            tx.set(ref, record)
            return record

        return self._atomic(change)

    def update_inspection(self, uid, inspection_id, revision, data):
        changed = []

        def update(record):
            # Recomputed on each transaction attempt; the log line reports the committed one.
            changed[:] = changed_fields(record['data'], data)
            if record['data'] != data:
                rename = default_photo_rename(record['data'], data)
                if rename:
                    for photo in record['photos']:
                        if photo['room'] == rename[0]:
                            photo['room'] = rename[1]
                record.update(
                    data=data, revision=record['revision'] + 1, audit=None, status='draft'
                )
            return record

        return saved(inspection_id, self._change(uid, inspection_id, revision, update), changed)

    def add_photo(self, uid, inspection_id, upload):
        record = self.get_inspection(uid, inspection_id)
        self._access(uid, record, 'photos')
        raw, mime, extension = decode_image(upload['data_url'])
        digest = hashlib.sha256(raw).hexdigest()
        existing = next((p for p in record['photos'] if p['id'] == upload['photo_id']), None)
        if existing:
            if (
                existing['file']['sha256'] != digest
                or existing['room'] != upload['room']
                or existing['captured_at'] != upload['captured_at']
            ):
                raise Conflict('This photo ID already represents different evidence.')
            self._access(uid, record, 'photos')
            return record
        if upload['room'] not in {room['name'] for room in record['data']['rooms']}:
            raise ValueError('Choose a room from this inspection before uploading evidence.')
        if len(record['photos']) >= 60:
            raise ValueError('An inspection can contain at most 60 photos.')
        if record['revision'] != upload['expected_revision'] or record['status'] == 'signed':
            raise Conflict('Restore the latest draft before adding a photo.')
        with Image.open(io.BytesIO(raw)) as image:
            width, height = image.size
        path = f'users/{uid}/inspections/{inspection_id}/{upload["photo_id"]}/{uuid4().hex}-{digest}.{extension}'
        photo = dict(
            id=upload['photo_id'],
            room=upload['room'],
            captured_at=upload['captured_at'],
            width=width,
            height=height,
            ocr_status='pending',
            ocr=None,
            file=dict(path=path, content_type=mime, sha256=digest),
        )
        checked_metadata({**record, 'photos': record['photos'] + [photo]})
        blob = self.bucket.blob(path)
        blob.upload_from_string(raw, content_type=mime, if_generation_match=0)

        def append(current):
            if len(current['photos']) >= 60:
                raise ValueError('An inspection can contain at most 60 photos.')
            current['photos'].append(photo)
            current.update(revision=current['revision'] + 1, audit=None, status='draft')
            return current

        try:
            return self._change(uid, inspection_id, upload['expected_revision'], append)
        except Exception:
            self._discard_unreferenced(blob, self._ref(inspection_id))
            raise

    def move_photo(self, uid, inspection_id, revision, photo_id, room):
        """Relabels one uploaded photo with another room of the draft. The evidence itself is
        immutable; only its room tag moves, and a moved photo invalidates the audit like any
        other draft change."""

        def update(record):
            photo = next((p for p in record['photos'] if p['id'] == photo_id), None)
            if photo is None:
                raise LookupError('Photo not found.')
            if room not in {r['name'] for r in record['data']['rooms']}:
                raise ValueError('Choose a room from this inspection for the photo.')
            if photo['room'] != room:
                photo['room'] = room
                record.update(revision=record['revision'] + 1, audit=None, status='draft')
            return record

        return self._change(uid, inspection_id, revision, update, 'photos')

    # Drying readings live in their own document beside the inspection. They never enter the
    # priced revision, so adding one changes no audit, proposal hash or signature, and a monitoring
    # visit after signing can still record the day's readings against the immutable agreement.
    READING_LIMIT = 400

    def _log_ref(self, inspection_id):
        self._ref(inspection_id)
        return self.db.collection('drying_logs').document(inspection_id)

    @staticmethod
    def _log_body(inspection_id, snapshot):
        body = snapshot.to_dict() if snapshot.exists else None
        return body or {'inspection_id': inspection_id, 'readings': [], 'updated_at': None}

    def drying_log(self, uid, inspection_id):
        self._owned(self._ref(inspection_id).get(), uid)
        return self._log_body(inspection_id, self._log_ref(inspection_id).get())

    def add_reading(self, uid, email, inspection_id, reading):
        """Appends one reading; the server names who saved it and computes the air values."""
        ref, log_ref = self._ref(inspection_id), self._log_ref(inspection_id)
        entry = dict(reading, id=uuid4().hex, recorded_by=email, recorded_at=now())
        if entry['kind'] == 'air':
            entry.update(psychrometrics(entry['temperature_f'], entry['relative_humidity']))

        def append(tx):
            self._owned(ref.get(transaction=tx), uid, 'scope', tx)
            log = self._log_body(inspection_id, log_ref.get(transaction=tx))
            if len(log['readings']) >= self.READING_LIMIT:
                raise ValueError(f'At most {self.READING_LIMIT} readings are kept per job.')
            log['readings'].append(entry)
            log['updated_at'] = now()
            tx.set(log_ref, log)
            return log

        return self._atomic(append)

    def remove_reading(self, uid, inspection_id, reading_id):
        ref, log_ref = self._ref(inspection_id), self._log_ref(inspection_id)

        def remove(tx):
            self._owned(ref.get(transaction=tx), uid, 'scope', tx)
            log = self._log_body(inspection_id, log_ref.get(transaction=tx))
            kept = [r for r in log['readings'] if r['id'] != reading_id]
            if len(kept) == len(log['readings']):
                raise LookupError('Reading not found.')
            log.update(readings=kept, updated_at=now())
            tx.set(log_ref, log)
            return log

        return self._atomic(remove)

    def tag_photo_shot(self, uid, inspection_id, revision, photo_id, shot):
        """Tags one uploaded photo with a shot type from the shot list, or clears the tag (None).
        Like a room move, only the tag changes; it invalidates the audit because the audit reads
        the tags."""

        def update(record):
            photo = next((p for p in record['photos'] if p['id'] == photo_id), None)
            if photo is None:
                raise LookupError('Photo not found.')
            if photo.get('shot') != shot:
                # Untagged photos keep no key, matching photos saved before the shot list existed.
                if shot:
                    photo['shot'] = shot
                else:
                    photo.pop('shot', None)
                record.update(revision=record['revision'] + 1, audit=None, status='draft')
            return record

        return self._change(uid, inspection_id, revision, update, 'photos')

    def append_transcript(self, uid, inspection_id, marker, block):
        """Appends a transcribed offline voice note once; a retried note whose marker is already
        in the transcript returns the record unchanged. It is an append, so a revision that moved
        on (for example a finished OCR) does not refuse it."""
        ref = self._ref(inspection_id)

        def update(tx):
            record = self._owned(ref.get(transaction=tx), uid, 'scope', tx)
            if record['status'] == 'signed':
                raise Conflict('Signed inspections are immutable. Start a new inspection.')
            transcript = record['data'].get('technician_transcript', '')
            if marker in transcript:
                return record
            joined = transcript + ('\n' if transcript and not transcript.endswith('\n') else '')
            joined += block
            if len(joined) > TRANSCRIPT_LIMIT:
                raise ValueError(
                    'Transcript storage is full. Type the remaining observations in notes.'
                )
            record['data']['technician_transcript'] = joined
            record.update(
                revision=record['revision'] + 1, audit=None, status='draft', updated_at=now()
            )
            checked_metadata(record)
            self._sync_access(record, tx)
            tx.set(ref, record)
            return record

        return self._atomic(update)

    def set_ocr(self, uid, inspection_id, photo_id, result):
        ref = self._ref(inspection_id)

        def update(tx):
            record = self._owned(ref.get(transaction=tx), uid, 'ocr', tx)
            if record['status'] == 'signed':
                return record
            photo = next((p for p in record['photos'] if p['id'] == photo_id), None)
            if not photo:
                raise LookupError('Photo not found.')
            status = (
                'verified'
                if result and result['meter_detected'] and result['value'].strip()
                else ('no_meter' if result else 'failed')
            )
            if status == 'failed' and photo['ocr_status'] not in ('pending', 'failed'):
                return record
            if photo.get('ocr') != result or photo['ocr_status'] != status:
                photo.update(ocr=result, ocr_status=status)
                record.update(
                    revision=record['revision'] + 1, audit=None, status='draft', updated_at=now()
                )
                checked_metadata(record)
                self._sync_access(record, tx)
                tx.set(ref, record)
            return record

        return self._atomic(update)

    def photo(self, uid, inspection_id, photo_id):
        record = self.get_inspection(uid, inspection_id)
        photo = next((p for p in record['photos'] if p['id'] == photo_id), None)
        if not photo:
            raise LookupError('Photo not found.')
        raw = self.bucket.blob(photo['file']['path']).download_as_bytes()
        self._access(uid, record)
        return photo, raw

    def save_audit(self, uid, inspection_id, revision, documents):
        self._access(uid, self.get_inspection(uid, inspection_id), 'audit')

        def update(record):
            payload = dict(
                data=record['data'], photos=record['photos'], documents=documents, revision=revision
            )
            digest = hashlib.sha256(canonical(payload).encode()).hexdigest()
            record.update(
                audit=dict(revision=revision, proposal_hash=digest, documents=documents),
                status='audited',
            )
            return record

        return self._change(uid, inspection_id, revision, update)

    def authorize(self, uid, payload, extra=None, claim=None):
        """extra adds fields to the record; a claim (a signing link) is checked with the
        transaction's reads and consumed with its writes."""
        # Resolve retries before inspecting mutable state or uploading evidence.
        auth_ref = self.db.collection('authorizations').document(payload['auth_id'])
        digest = hashlib.sha256(canonical(payload).encode()).hexdigest()
        snapshot = auth_ref.get()
        if snapshot.exists:
            existing = self._owned(snapshot, uid, 'sign')
            if existing.get('payload_sha256') != digest:
                raise Conflict(
                    'This authorization reference already represents a different agreement.'
                )
            return existing
        record = self.get_inspection(uid, payload['inspection_id'])
        self._access(uid, record, 'sign')
        self._check_documents(uid, record)
        self._signable(record, payload)
        raw, mime, extension = decode_image(payload['signature_png'], signature=True)
        with IMAGE_WORKER, Image.open(io.BytesIO(raw)) as image:
            # A click without a stroke must not become a signed agreement.
            pixels = image.convert('RGBA')
            background = Image.new('RGBA', pixels.size, 'white')
            ink = (
                Image.alpha_composite(background, pixels)
                .convert('L')
                .point(lambda value: 255 if value < 200 else 0)
            )
            if not ink.getbbox():
                raise ValueError('Draw a signature before saving.')
        path = f'users/{uid}/authorizations/{payload["auth_id"]}/{digest}/{uuid4().hex}/signature.{extension}'
        body = dict(
            auth_id=payload['auth_id'],
            schema_version=3,
            inspection_id=payload['inspection_id'],
            inspection_revision=payload['expected_revision'],
            proposal_hash=payload['proposal_hash'],
            owner_uid=uid,
            payload_sha256=digest,
            created_at=now(),
            status='saved',
            address=record['data']['address'],
            proposed_cost=record['audit']['documents']['adr_estimate']['proposed_cost'],
            proposed_cost_low=record['audit']['documents']['adr_estimate']['proposed_cost_low'],
            documents=record['audit']['documents'],
            inspection=record['data'],
            photos=record['photos'],
            photos_count=len(record['photos']),
            signature=dict(path=path, content_type=mime, sha256=hashlib.sha256(raw).hexdigest()),
            **(extra or {}),
        )
        checked_metadata(body)
        blob = self.bucket.blob(path)
        blob.upload_from_string(raw, content_type=mime, if_generation_match=0)
        inspection_ref = self._ref(payload['inspection_id'])

        def sign(tx):
            auth = auth_ref.get(transaction=tx)
            current = self._owned(inspection_ref.get(transaction=tx), uid, 'sign', tx)
            if claim and not auth.exists:
                claim.check(tx)
            if auth.exists:
                existing = self._owned(auth, uid, 'sign', tx)
                if existing.get('payload_sha256') != digest:
                    raise Conflict(
                        'This authorization reference already represents a different agreement.'
                    )
                return existing
            self._signable(current, payload)
            if current.get('status') == 'signed':
                raise Conflict('This inspection is already signed.')
            self._check_documents(uid, current, tx)
            self._commit_authorization(uid, current, body, tx)
            tx.create(auth_ref, body)
            tx.update(
                inspection_ref,
                {'status': 'signed', 'authorization_id': payload['auth_id'], 'updated_at': now()},
            )
            if claim:
                claim.consume(tx, body)
            return body

        try:
            saved = self._atomic(sign)
        except Exception:
            self._discard_unreferenced(blob, auth_ref)
            raise
        if saved['signature']['path'] != path:
            self._discard_unreferenced(blob, auth_ref)
        return saved

    @staticmethod
    def _signable(record, payload):
        audit = record.get('audit')
        if (
            not audit
            or not audit['documents']['signable']
            or record['revision'] != payload['expected_revision']
            or audit['revision'] != record['revision']
            or audit['proposal_hash'] != payload['proposal_hash']
        ):
            raise Conflict(
                'The scope changed or requires review. Complete a new audit before signing.'
            )

    def quota(self, uid, action, maximum=None, ttl=None):
        """ttl sets expire_at, the _limits TTL field, so an idle counter document is deleted."""
        ref = self.db.collection('_limits').document(uid)

        def reserve(tx):
            snapshot = ref.get(transaction=tx)
            data = snapshot.to_dict() if snapshot.exists else {}
            if action in DAILY_LIMITS:
                data = reserve_slot(data, action + '_day', DAILY_LIMITS[action], 86400)
            if maximum:
                data = reserve_slot(data, action, maximum)
            if ttl:
                data['expire_at'] = datetime.fromtimestamp(time.time() + ttl, timezone.utc)
            tx.set(ref, data)

        self._atomic(reserve)

    def live_lease(self, uid, lease_id=None, release=False):
        ref = self.db.collection('_live_sessions').document(uid)

        def lease(tx):
            snapshot = ref.get(transaction=tx)
            data = snapshot.to_dict() if snapshot.exists else {}
            if release:
                if data.get('id') == lease_id:
                    tx.delete(ref)
                return None
            if data.get('expires', 0) > time.time() and data.get('id') != lease_id:
                raise Limited(60)
            identifier = lease_id or uuid4().hex
            tx.set(ref, {'id': identifier, 'expires': time.time() + 60})
            return identifier

        return self._atomic(lease)

    def live_resume(
        self,
        uid,
        capture_id,
        inspection_id,
        fingerprint,
        lease_id,
        action,
        handle=None,
        resumable=False,
    ):
        """Only a matching lease can change its private checkpoint; never expose handles."""
        if not re.fullmatch(r'[a-f0-9]{32}', capture_id):
            raise ValueError('Invalid capture identifier.')
        ref = self.db.collection('_live_resume').document(uid)
        lease_ref = self.db.collection('_live_sessions').document(uid)

        def checkpoint(tx):
            snapshot = ref.get(transaction=tx)
            current = snapshot.to_dict() if snapshot.exists else {}
            moment = time.time()
            if action == 'open':
                active = lease_ref.get(transaction=tx).to_dict() or {}
                if active.get('id') != lease_id:
                    raise Conflict('Live lease changed.')
                match = (
                    current.get('owner_uid') == uid
                    and current.get('capture_id') == capture_id
                    and current.get('inspection_id') == inspection_id
                    and current.get('fingerprint') == fingerprint
                    and current.get('expires', 0) > moment
                )
                previous = current.get('handle') if match and current.get('resumable') else None
                tx.set(
                    ref,
                    dict(
                        owner_uid=uid,
                        capture_id=capture_id,
                        inspection_id=inspection_id,
                        fingerprint=fingerprint,
                        lease_id=lease_id,
                        handle=previous,
                        resumable=bool(previous),
                        expires=moment + 600,
                        expire_at=datetime.fromtimestamp(moment + 600, timezone.utc),
                    ),
                )
                return previous
            if current.get('lease_id') != lease_id or current.get('capture_id') != capture_id:
                return None
            if action == 'delete':
                tx.delete(ref)
                return None
            current.update(
                expires=moment + 600, expire_at=datetime.fromtimestamp(moment + 600, timezone.utc)
            )
            if action == 'save':
                current.update(handle=handle if resumable else None, resumable=resumable)
            tx.set(ref, current)
            return None

        return self._atomic(checkpoint)
