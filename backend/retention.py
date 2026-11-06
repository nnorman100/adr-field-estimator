"""How long each company keeps invitations, admin events, drying-watch history and the photos of
archived drafts, and the sweep that deletes what has passed its period.

The setting is per company and per record class: 90 days unless the owner changes it, between
MIN_DAYS and MAX_DAYS. The sweep runs only while RETENTION_ENABLED is true (the reviewed feature
baseline in scripts/deploy_backend.py), at most once a day per company, when a member's app asks
for it. Nothing a signed agreement holds is ever deleted, nor anything of an open draft or of a job
that is still in progress: each class below names the one moment its clock starts.

- invitations: from the invitation's expiry (7 days after it was sent or resent), whether it was
  accepted, cancelled or never used. A pending invitation that has not expired has no clock.
- admin_events: from the event's creation. This includes the support-access log and the records of
  earlier sweeps; the current setting itself stays on its own record.
- job_monitoring: the drying-watch sidecar of a signed job, from the job's close, which the close
  stores on the sidecar. An unclosed job's sidecar has no clock; readings and the signed agreement
  are not part of this class. A closed watch keeps only that it was closed, how and when, so it
  never reopens.
- evidence_photos: the photos of an archived unsigned draft, from its archiving. A signed job cannot
  be archived, so every photo a signed agreement holds stays.

Each deletion is checked again inside its own transaction, against the setting read in that same
transaction, so a longer period saved during a sweep wins and two sweeps cannot delete one record
twice. Photo objects are deleted after the transaction that removes them from the draft has
committed; the paths wait on the job until every object is gone, so a failed delete is retried.
"""

import hashlib
import logging
import os
import time
from datetime import datetime, timezone
from uuid import uuid4

from google.cloud import firestore
from pydantic import Field

try:
    from .cloud_log import event
    from .contracts import StrictModel
    from .inspection_store import Conflict, now
    from .outcomes import HISTORY
    from .workspaces import AccessDenied
except ImportError:
    from cloud_log import event
    from contracts import StrictModel
    from inspection_store import Conflict, now
    from outcomes import HISTORY
    from workspaces import AccessDenied

CLASSES = ('invitations', 'admin_events', 'job_monitoring', 'evidence_photos')
DEFAULT_DAYS = 90
MIN_DAYS = 30
MAX_DAYS = 3650
DAY = 86400
SETTINGS = '_company_retention'
STATE = '_retention_state'
RUN_EVERY = DAY
LEASE_SECONDS = 600
# The most records of one class one sweep deletes; the rest wait for the next day's sweep.
BATCH = 100
PAGE = 400
ACTOR = 'system:retention'
NOT_ALLOWED = 'Only the company owner can change how long records are kept.'

_forced = None


def retention_enabled():
    if _forced is not None:
        return bool(_forced)
    return os.getenv('RETENTION_ENABLED', 'false').lower() == 'true'


Days = Field(ge=MIN_DAYS, le=MAX_DAYS)


class RetentionDays(StrictModel):
    invitations: int = Days
    admin_events: int = Days
    job_monitoring: int = Days
    evidence_photos: int = Days


class RetentionUpdate(StrictModel):
    expected_version: int = Field(ge=0)
    days: RetentionDays


def _plural(days):
    return f'{days} day' if days == 1 else f'{days} days'


# The settings screen fills {days} as the owner types, the same way effect() does.
TEMPLATES = {
    'invitations': (
        'Invitations, with the email address they were sent to, are deleted {days} after they '
        'expire. An invitation expires 7 days after it is sent, whether it was accepted or not. '
        'Pending invitations are kept.'
    ),
    'admin_events': (
        'The company activity log (settings, team, price and support-access changes, and these '
        'deletions) keeps each entry for {days}.'
    ),
    'job_monitoring': (
        'Drying-watch history (status, reminders and extensions) is deleted {days} after a signed '
        'job is closed. Jobs that are not closed keep it. Drying readings and the signed agreement '
        'are kept.'
    ),
    'evidence_photos': (
        'Photos on an archived draft are deleted {days} after it was archived; restoring it later '
        'brings back the draft without them. Photos on signed agreements, open drafts and jobs in '
        'progress are never deleted.'
    ),
}


def effect(days):
    """Plain-word sentences for the settings screen, one per class, for the given periods."""
    return {name: TEMPLATES[name].replace('{days}', _plural(days[name])) for name in CLASSES}


def _iso(moment):
    return datetime.fromtimestamp(moment, timezone.utc).isoformat()


def _epoch(text):
    try:
        value = datetime.fromisoformat(str(text).replace('Z', '+00:00'))
    except ValueError:
        return None
    if value.tzinfo is None:
        return None
    return value.timestamp()


def _invite_key(company_id, email):
    # The same deterministic key WorkspaceStore.invite serializes on.
    return hashlib.sha256((company_id + ':' + email).encode()).hexdigest()


def photo_paths(photo):
    """Every evidence object one photo record names: the upload, its model copy and the
    hash-linked original that may arrive later on Wi-Fi."""
    paths = [photo['file']['path']]
    if photo.get('model_file'):
        paths.append(photo['model_file']['path'])
    original = photo.get('original')
    if original:
        folder = photo['file']['path'].rpartition('/')[0]
        extension = original['content_type'].rpartition('/')[2]
        paths.append(f'{folder}/original-{original["sha256"]}.{extension}')
    return paths


class Retention:
    def __init__(self, workspaces, bucket):
        self.ws = workspaces
        self.bucket = bucket

    # Settings

    def settings(self, company_id, tx=None):
        saved = self.ws.read(SETTINGS, company_id, tx) or {}
        stored = saved.get('days') if isinstance(saved.get('days'), dict) else {}
        days = {}
        for name in CLASSES:
            value = stored.get(name)
            # A missing or unreadable value keeps the default rather than deleting sooner.
            ok = isinstance(value, int) and not isinstance(value, bool)
            days[name] = value if ok and MIN_DAYS <= value <= MAX_DAYS else DEFAULT_DAYS
        return days, int(saved.get('version') or 0), saved

    def _owner(self, uid, company_id, tx=None):
        actor = self.ws.company_actor(uid, company_id, tx=tx)
        if 'retention_manage' not in actor['capabilities']:
            raise AccessDenied(NOT_ALLOWED)
        return actor

    @staticmethod
    def _shape(company_id, version, days, updated_at, state):
        return dict(
            company_id=company_id,
            version=version,
            days=days,
            default_days=DEFAULT_DAYS,
            min_days=MIN_DAYS,
            max_days=MAX_DAYS,
            effect=effect(days),
            templates=TEMPLATES,
            running=retention_enabled(),
            updated_at=updated_at,
            last_run_at=state.get('last_run_at'),
            last_deleted=state.get('last_deleted'),
        )

    def _view(self, company_id, tx=None):
        days, version, saved = self.settings(company_id, tx)
        state = self.ws.read(STATE, company_id, tx) or {}
        return self._shape(company_id, version, days, saved.get('updated_at'), state)

    def view(self, uid, company_id):
        self._owner(uid, company_id)
        return self._view(company_id)

    def update(self, uid, company_id, req):
        def commit(tx):
            self._owner(uid, company_id, tx)
            days, version, _saved = self.settings(company_id, tx)
            if version != req.expected_version:
                raise Conflict('The retention setting changed. Reload before saving.')
            chosen = req.days.model_dump()
            record = dict(
                company_id=company_id,
                version=version + 1,
                days=chosen,
                updated_at=now(),
                updated_by_uid=uid,
            )
            state = self.ws.read(STATE, company_id, tx) or {}
            tx.set(self.ws.ref(SETTINGS, company_id), record)
            self.ws.event(
                tx,
                uid,
                'retention_settings',
                company_id,
                {'version': record['version'], 'days': chosen, 'previous': days},
            )
            return self._shape(company_id, record['version'], chosen, record['updated_at'], state)

        return self.ws._run(commit)

    # The daily sweep

    def tick(self, uid, company_id, moment=None):
        """A member's app asks for the company's daily sweep. Returns at once when the feature is
        off, a sweep ran in the last day, or another instance holds the lease."""
        self.ws.company_actor(uid, company_id)
        if not retention_enabled():
            return {'ran': False}
        moment = time.time() if moment is None else moment
        lease = uuid4().hex

        def take(tx):
            self.ws.company_actor(uid, company_id, tx=tx)
            state = self.ws.read(STATE, company_id, tx) or {}
            if state.get('next_run_at', 0) > moment or state.get('lease_until', 0) > moment:
                return False
            tx.set(
                self.ws.ref(STATE, company_id),
                dict(
                    state, company_id=company_id, lease_id=lease, lease_until=moment + LEASE_SECONDS
                ),
            )
            return True

        if not self.ws._run(take):
            return {'ran': False}
        # Filled as each class finishes, so a failed run still records what it deleted.
        deleted = {name: 0 for name in CLASSES}
        outcome = 'completed'
        try:
            self.sweep(company_id, moment, deleted)
        except Exception as error:
            outcome = type(error).__name__
            raise
        finally:
            self._finish(uid, company_id, lease, moment, deleted, outcome)
        return {'ran': True, 'deleted': deleted}

    def _finish(self, uid, company_id, lease, moment, deleted, outcome):
        def finish(tx):
            state = self.ws.read(STATE, company_id, tx) or {}
            days, version, _saved = self.settings(company_id, tx)
            if state.get('lease_id') == lease:
                state.update(
                    last_run_at=now(),
                    last_deleted=deleted,
                    last_outcome=outcome,
                    next_run_at=moment + RUN_EVERY,
                    lease_until=0,
                )
                tx.set(self.ws.ref(STATE, company_id), state)
            self.ws.event(
                tx,
                ACTOR,
                'retention_run',
                company_id,
                {
                    'deleted': deleted,
                    'days': days,
                    'settings_version': version,
                    'outcome': outcome,
                    'triggered_by_uid': uid,
                },
            )

        self.ws._run(finish)
        event(
            'Retention sweep finished',
            logging.INFO if outcome == 'completed' else logging.ERROR,
            operation='retention',
            outcome=outcome,
            status=str(sum(deleted.values())),
        )

    def sweep(self, company_id, moment, deleted=None):
        deleted = {name: 0 for name in CLASSES} if deleted is None else deleted
        deleted['invitations'] = self._invitations(company_id, moment, deleted)
        deleted['admin_events'] = self._admin_events(company_id, moment, deleted)
        deleted['job_monitoring'] = self._job_monitoring(company_id, moment, deleted)
        deleted['evidence_photos'] = self._evidence_photos(company_id, moment, deleted)
        return deleted

    def _cutoff(self, company_id, name, moment, tx=None):
        days, _version, _saved = self.settings(company_id, tx)
        return moment - days[name] * DAY

    def _pages(self, query):
        page = list(query.limit(PAGE).stream())
        while page:
            yield from page
            if len(page) < PAGE:
                return
            page = list(query.limit(PAGE).start_after(page[-1]).stream())

    # Invitations

    @staticmethod
    def _invitation_due(invite, company_id, cutoff):
        return bool(
            invite
            and invite.get('company_id') == company_id
            and isinstance(invite.get('expires_at'), (int, float))
            and invite['expires_at'] <= cutoff
        )

    def _invitations(self, company_id, moment, deleted):
        cutoff = self._cutoff(company_id, 'invitations', moment)
        query = (
            self.ws.db.collection('_invitations')
            .where(filter=firestore.FieldFilter('company_id', '==', company_id))
            .order_by('invitation_id', direction=firestore.Query.DESCENDING)
        )
        due = [
            s.to_dict()['invitation_id']
            for s in self._pages(query)
            if self._invitation_due(s.to_dict(), company_id, cutoff)
        ][:BATCH]
        for identifier in due:

            def delete(tx, identifier=identifier):
                invite = self.ws.read('_invitations', identifier, tx)
                if not self._invitation_due(
                    invite, company_id, self._cutoff(company_id, 'invitations', moment, tx)
                ):
                    return False
                key = _invite_key(company_id, invite.get('email', ''))
                pointer = self.ws.read('_invite_keys', key, tx)
                tx.delete(self.ws.ref('_invitations', identifier))
                if pointer and pointer.get('invitation_id') == identifier:
                    tx.delete(self.ws.ref('_invite_keys', key))
                return True

            deleted['invitations'] += bool(self.ws._run(delete))
        return deleted['invitations']

    # Admin events

    def _admin_events(self, company_id, moment, deleted):
        cutoff = _iso(self._cutoff(company_id, 'admin_events', moment))
        # company_id + created_at range: the composite index in firestore.indexes.json.
        query = (
            self.ws.db.collection('_admin_events')
            .where(filter=firestore.FieldFilter('company_id', '==', company_id))
            .where(filter=firestore.FieldFilter('created_at', '<', cutoff))
            .limit(BATCH)
        )
        due = [s.to_dict().get('event_id') for s in query.stream()]
        for identifier in filter(None, due):

            def delete(tx, identifier=identifier):
                entry = self.ws.read('_admin_events', identifier, tx)
                fresh = _iso(self._cutoff(company_id, 'admin_events', moment, tx))
                if (
                    not entry
                    or entry.get('company_id') != company_id
                    or not str(entry.get('created_at', '')) < fresh
                ):
                    return False
                tx.delete(self.ws.ref('_admin_events', identifier))
                return True

            deleted['admin_events'] += bool(self.ws._run(delete))
        return deleted['admin_events']

    # Drying-watch history

    def _history_rows(self, company_id, tx=None):
        rows = (self.ws.read(HISTORY, company_id, tx) or {}).get('rows')
        return rows if isinstance(rows, dict) else {}

    @staticmethod
    def _job_closed_at(record, rows):
        """The close time stored on the sidecar; a sidecar from before close times were stored
        counts from its history row's close or its own last write, whichever is later."""
        stored = _epoch(record.get('job_closed_at'))
        if stored is not None:
            return stored
        row = rows.get(record.get('job_id'))
        closed = _epoch(row.get('closed_at')) if isinstance(row, dict) else None
        if closed is None:
            return None
        return max(closed, _epoch(record.get('updated_at')) or closed)

    @staticmethod
    def _history_left(record):
        if not record.get('history_deleted_at'):
            return True
        return any(record.get(key) for key in ('extensions', 'reminders', 'summary'))

    @staticmethod
    def _marker(record, company_id, closed_at):
        """What a closed watch keeps once its history goes: that it was closed, how and when."""
        closed = record['closed']
        return dict(
            job_id=record['job_id'],
            company_id=company_id,
            job_closed_at=_iso(closed_at),
            history_deleted_at=now(),
            closed=dict(action=closed.get('action'), at=closed.get('at')),
        )

    def _job_monitoring(self, company_id, moment, deleted):
        cutoff = self._cutoff(company_id, 'job_monitoring', moment)
        rows = self._history_rows(company_id)
        query = self.ws.db.collection('_job_monitoring').where(
            filter=firestore.FieldFilter('company_id', '==', company_id)
        )
        due = []
        for snapshot in self._pages(query):
            record = snapshot.to_dict()
            closed_at = self._job_closed_at(record, rows)
            if closed_at is None:
                continue
            unstamped = _epoch(record.get('job_closed_at')) is None
            if unstamped or (closed_at <= cutoff and self._history_left(record)):
                due.append(record['job_id'])
        for job_id in due[:BATCH]:

            def expire(tx, job_id=job_id):
                ref = self.ws.ref('_job_monitoring', job_id)
                record = self.ws.read('_job_monitoring', job_id, tx)
                job = self.ws.read('_workspace_jobs', job_id, tx)
                rows = self._history_rows(company_id, tx)
                fresh = self._cutoff(company_id, 'job_monitoring', moment, tx)
                if (
                    not record
                    or not job
                    or job.get('company_id') != company_id
                    or record.get('company_id') != company_id
                ):
                    return False
                closed_at = self._job_closed_at(record, rows)
                if closed_at is None:
                    return False
                if closed_at > fresh or not self._history_left(record):
                    if _epoch(record.get('job_closed_at')) is None:
                        tx.update(ref, {'job_closed_at': _iso(closed_at)})
                    return False
                if isinstance(record.get('closed'), dict):
                    tx.set(ref, self._marker(record, company_id, closed_at))
                else:
                    tx.delete(ref)
                return True

            deleted['job_monitoring'] += bool(self.ws._run(expire))
        return deleted['job_monitoring']

    # Photos of archived drafts

    @staticmethod
    def _photos_due(job, company_id, cutoff):
        archived = _epoch(job.get('archived_at')) if job else None
        if (
            not job
            or job.get('company_id') != company_id
            or job.get('kind') != 'archived_inspection'
            or job.get('auth_exists')
            or archived is None
        ):
            return False
        deleted = _epoch(job.get('evidence_deleted_at'))
        # A draft restored and archived again after its photos went has a new clock.
        return archived <= cutoff and (deleted is None or deleted < archived)

    def _evidence_photos(self, company_id, moment, deleted):
        cutoff = self._cutoff(company_id, 'evidence_photos', moment)
        # The archived-drafts list query and its index (company_id, kind, updated_at).
        query = (
            self.ws.db.collection('_workspace_jobs')
            .where(filter=firestore.FieldFilter('company_id', '==', company_id))
            .where(filter=firestore.FieldFilter('kind', '==', 'archived_inspection'))
            .order_by('updated_at', direction=firestore.Query.DESCENDING)
        )
        due = [
            s.to_dict()['job_id']
            for s in self._pages(query)
            if self._photos_due(s.to_dict(), company_id, cutoff)
        ][:BATCH]
        # Objects of photos already removed from a draft, archived or restored since.
        retry = (
            self.ws.db.collection('_workspace_jobs')
            .where(filter=firestore.FieldFilter('company_id', '==', company_id))
            .where(filter=firestore.FieldFilter('evidence_pending', '==', True))
            .limit(BATCH)
        )
        waiting = {
            s.to_dict()['job_id']: list(s.to_dict().get('evidence_pending_paths') or [])
            for s in retry.stream()
        }
        for job_id in due:
            paths = self.ws._run(
                lambda tx, job_id=job_id: self._release(tx, company_id, job_id, moment)
            )
            if paths is not None:
                waiting[job_id] = paths
        for job_id, paths in waiting.items():
            if paths and self._delete_objects(paths):
                self.ws._run(lambda tx, job_id=job_id, paths=paths: self._settle(tx, job_id, paths))
                deleted['evidence_photos'] += 1
        return deleted['evidence_photos']

    def _release(self, tx, company_id, job_id, moment):
        """Removes the photos from the archived draft and records their paths on the job, in one
        transaction; returns the paths to delete, or None when the draft no longer qualifies."""
        job_ref = self.ws.ref('_workspace_jobs', job_id)
        job = self.ws.read('_workspace_jobs', job_id, tx)
        record_ref = self.ws.db.collection('inspections').document(job_id)
        snapshot = record_ref.get(transaction=tx)
        record = snapshot.to_dict() if snapshot.exists else None
        fresh = self._cutoff(company_id, 'evidence_photos', moment, tx)
        if not self._photos_due(job, company_id, fresh) or not record:
            return None
        if record.get('status') == 'signed' or record.get('authorization_id'):
            return None
        pending = list(job.get('evidence_pending_paths') or [])
        photos = record.get('photos') or []
        for photo in photos:
            for path in photo_paths(photo):
                if path not in pending:
                    pending.append(path)
        if photos:
            tx.update(
                record_ref,
                {
                    'photos': [],
                    'audit': None,
                    'revision': record['revision'] + 1,
                    'updated_at': now(),
                },
            )
        tx.set(
            job_ref,
            dict(
                evidence_pending_paths=pending,
                evidence_pending=bool(pending),
                evidence_deleted_at=now(),
                evidence_deleted_photos=len(photos),
            ),
            merge=True,
        )
        return pending

    def _delete_objects(self, paths):
        from google.api_core.exceptions import NotFound

        ok = True
        for path in paths:
            try:
                self.bucket.blob(path).delete()
            except NotFound:
                pass
            except Exception as error:
                ok = False
                event(
                    'Retention could not delete a photo object; it is retried tomorrow',
                    logging.WARNING,
                    operation='retention_photo',
                    outcome=type(error).__name__,
                )
        return ok

    def _settle(self, tx, job_id, paths):
        job = self.ws.read('_workspace_jobs', job_id, tx) or {}
        left = [p for p in job.get('evidence_pending_paths') or [] if p not in paths]
        tx.set(
            self.ws.ref('_workspace_jobs', job_id),
            dict(evidence_pending_paths=left, evidence_pending=bool(left)),
            merge=True,
        )
