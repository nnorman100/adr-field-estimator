"""Authorized monitoring sidecar and human-approved reminder reservations."""

import logging
import hashlib
import json
import time
from uuid import uuid4
from typing import Literal

from google.cloud import firestore
from pydantic import Field, StrictBool

try:
    from . import ai_features
    from .cloud_log import event
    from .contracts import StrictModel
    from .drying_watch import watch_state, facts_hash
    from .inspection_store import Conflict, now
    from .workspaces import (
        AccessDenied,
        UnconfirmedDelivery,
        SMTP_DEADLINE,
        email_address,
        emails_sent,
        mail_settings,
        send_email,
    )
    from .delivery import delivery_email, FAILED, UNCONFIRMED, RESERVATION_SECONDS
except ImportError:
    import ai_features
    from cloud_log import event
    from contracts import StrictModel
    from drying_watch import watch_state, facts_hash
    from inspection_store import Conflict, now
    from workspaces import (
        AccessDenied,
        UnconfirmedDelivery,
        SMTP_DEADLINE,
        email_address,
        emails_sent,
        mail_settings,
        send_email,
    )
    from delivery import delivery_email, FAILED, UNCONFIRMED, RESERVATION_SECONDS


class WatchAction(StrictModel):
    action: Literal['mark_dry', 'extend', 'close']
    reason: str = Field(min_length=1, max_length=500)
    facts_hash: str = Field(pattern=r'^[a-f0-9]{64}$')
    request_id: str = Field(pattern=r'^[a-f0-9]{32}$')
    approved: StrictBool


class ReminderRequest(StrictModel):
    reminder_id: str = Field(pattern=r'^[a-f0-9]{32}$')
    recipient: Literal['estimator', 'crew_lead'] = 'estimator'
    recipient_hash: str = Field(pattern=r'^[a-f0-9]{64}$')
    facts_hash: str = Field(pattern=r'^[a-f0-9]{64}$')
    approved: StrictBool


class Monitoring:
    def __init__(self, workspaces):
        self.w = workspaces

    def ref(self, job_id):
        return self.w.ref('_job_monitoring', job_id)

    def access(self, uid, job_id, action='read', tx=None):
        job, actor = self.w.job_access(uid, {'inspection_id': job_id}, action, tx)
        if not job.get('auth_id'):
            raise LookupError('Drying watch is available after signing.')
        return job, actor

    def compute(self, job, tx=None, log=None):
        if not job.get('auth_id'):
            return None
        agreement = self.w.read('authorizations', job['auth_id'], tx)
        if not agreement:
            raise LookupError('Signed agreement not found.')
        data = agreement.get('inspection')
        if not isinstance(data, dict) or not data.get('drying_days'):
            raise LookupError('This older agreement has no saved drying plan.')
        log = log if log is not None else self.w.read('drying_logs', job['job_id'], tx) or {}
        previous = self.w.read('_job_monitoring', job['job_id'], tx) or {}
        state = watch_state(data, log, job['signed_at'], previous)
        result = dict(previous, **state)
        result.update(
            job_id=job['job_id'],
            company_id=job['company_id'],
            auth_id=job['auth_id'],
            accessible_estimator_uids=job['accessible_estimator_uids'],
            address=data['address'],
        )
        result['facts_hash'] = facts_hash(result)
        if (result.get('summary') or {}).get('facts_hash') != result['facts_hash']:
            result.pop('summary', None)
        result.setdefault('extensions', [])
        result.setdefault('reminders', [])
        return result

    def sync(self, job_id, tx, log=None, job=None):
        """Call before the transaction's first write, including on deletion and reassignment."""
        if not ai_features.enabled('drying_watch'):
            return
        job = job or self.w.read('_workspace_jobs', job_id, tx)
        if not job or not job.get('auth_id'):
            return
        try:
            record = self.compute(job, tx, log)
        except LookupError:
            return  # A historical agreement without its source cannot gain a plan.
        tx.set(self.ref(job_id), dict(record, updated_at=now()))

    def view(self, uid, job_id, support_company=None):
        def read(tx):
            if support_company:
                job = self.w.support_job(uid, support_company, {'inspection_id': job_id}, tx)
            else:
                job, _ = self.access(uid, job_id, tx=tx)
            record = self.compute(job, tx)
            if not record:
                raise LookupError('Drying watch is available after signing.')
            company = self.w.read('_companies', job['company_id'], tx)
            assignee = (
                self.w.read('_memberships', job['assigned_estimator_uid'], tx)
                if job.get('assigned_estimator_uid')
                else None
            )
            recipient = self.recipient(company, job, assignee, 'estimator', required=False)
            if not support_company:
                tx.set(self.ref(job_id), dict(record, updated_at=now()))
            result = dict(
                record,
                reminders_enabled=company['profile'].get('drying_reminders') is True,
                estimator=recipient,
                crew_lead=self.recipient(company, job, assignee, 'crew_lead', required=False),
                recipient_hashes={role: self.recipient_hash(company, job, assignee, role)
                                  for role in ('estimator', 'crew_lead')},
            )
            # Reservation internals never leave the server.
            result['reminders'] = [
                {
                    k: entry.get(k)
                    for k in (
                        'reminder_id',
                        'recipient',
                        'status',
                        'reason',
                        'retryable',
                        'accepted_by_uid',
                        'accepted_at',
                    )
                }
                for entry in record['reminders']
            ]
            for entry, private in zip(result['reminders'], record['reminders']):
                if (
                    private['status'] == 'sending'
                    and time.time() - private['send_started'] >= RESERVATION_SECONDS
                ):
                    entry.update(status='failed', reason=UNCONFIRMED, retryable=False)
            return result

        result = self.w._run(read)
        if support_company:
            self.w.support_audit(
                uid,
                support_company,
                'view_drying_watch',
                'job/' + job_id,
                {'inspection_id': job_id},
            )
        return result

    def listing(self, uid, company_id=None, support=False, cursor=None):
        if support:
            self.w.support_company(uid, company_id)
            actor = None
        else:
            actor = self.w.company_actor(uid, company_id)
            company_id = actor['company_id']
        query = self.w.db.collection('_workspace_jobs').where(
            filter=firestore.FieldFilter('company_id', '==', company_id)
        )
        query = query.where(filter=firestore.FieldFilter('auth_exists', '==', True))
        if actor and actor['role'] == 'estimator':
            query = query.where(
                filter=firestore.FieldFilter('accessible_estimator_uids', 'array_contains', uid)
            )
        query = query.order_by('signed_at', direction=firestore.Query.DESCENDING)
        if cursor:
            self.view(uid, cursor, company_id if support else None)
            query = query.start_after(self.w.ref('_workspace_jobs', cursor).get())
        rows = list(query.limit(51).stream())
        records = []
        for row in rows[:50]:
            try:
                records.append(
                    self.view(uid, row.to_dict()['job_id'], company_id if support else None)
                )
            except LookupError:
                continue
        # Recheck membership after the potentially long list read.
        if support:
            self.w.support_audit(uid, company_id, 'view_drying_watch', 'drying-watch')
        else:
            self.w.company_actor(uid, company_id)
        return dict(
            jobs=records,
            next_cursor=rows[49].to_dict()['job_id'] if len(rows) > 50 else None,
            unavailable=len(rows[:50]) - len(records),
        )

    def save_summary(self, uid, job_id, expected, text):
        def save(tx):
            job, _ = self.access(uid, job_id, tx=tx)
            record = self.compute(job, tx)
            if record['facts_hash'] != expected:
                raise Conflict('Readings changed. Reload the drying summary.')
            record['summary'] = dict(text=text, facts_hash=expected, generated_at=now())
            tx.set(self.ref(job_id), dict(record, updated_at=now()))
            return record

        return self.w._run(save)

    def change(self, uid, job_id, req):
        if not req.approved or not req.reason.strip():
            raise ValueError('Confirm this monitoring change with a reason.')

        def update(tx):
            job, actor = self.access(uid, job_id, tx=tx)
            cap = (
                'scope'
                if req.action == 'mark_dry' and actor['role'] == 'estimator'
                else 'coordination'
            )
            self.access(uid, job_id, cap, tx)
            record = self.compute(job, tx)
            entries = record['extensions'] + ([record['closed']] if record.get('closed') else [])
            if any(e.get('request_id') == req.request_id for e in entries):
                return record
            if record['facts_hash'] != req.facts_hash:
                raise Conflict('Drying facts changed. Review them before confirming.')
            if record.get('closed'):
                raise Conflict('Monitoring is already closed.')
            provenance = dict(
                action=req.action,
                reason=req.reason.strip(),
                origin='manual',
                accepted_by_uid=uid,
                accepted_at=now(),
                facts_hash=req.facts_hash,
                request_id=req.request_id,
            )
            if req.action == 'extend':
                if len(record['extensions']) >= 100:
                    raise ValueError('This job has reached its monitoring note limit.')
                record['extensions'].append(provenance)
            else:
                record['closed'] = dict(provenance, by_uid=uid, at=provenance['accepted_at'])
                record.update(
                    status='marked_dry' if req.action == 'mark_dry' else 'closed',
                    flags=[],
                    next_due_at=None,
                )
                record.pop('summary', None)
                record['facts_hash'] = facts_hash(record)
            tx.set(self.ref(job_id), dict(record, updated_at=now()))
            return record

        return self.w._run(update)

    @staticmethod
    def recipient(company, job, member, role, required=True):
        value = (
            (company['profile'].get('crew_lead_email') or '')
            if role == 'crew_lead'
            else (
                member.get('email', '')
                if member
                and member.get('status') == 'active'
                and member.get('role') == 'estimator'
                and member.get('company_id') == job['company_id']
                else ''
            )
        )
        if value:
            return email_address(value)
        if required:
            raise ValueError('Choose an active assigned estimator or a configured crew lead.')
        return None

    def recipient_hash(self, company, job, member, role):
        value = [
            role,
            job.get('assigned_estimator_uid') if role == 'estimator' else None,
            self.recipient(company, job, member, role, required=False),
        ]
        return hashlib.sha256(json.dumps(value, separators=(',', ':')).encode()).hexdigest()

    def reserve(self, uid, job_id, req):
        if not req.approved:
            raise ValueError('Approve the reminder before sending.')

        def reserve(tx):
            job, _ = self.access(uid, job_id, 'coordination', tx)
            company = self.w.read('_companies', job['company_id'], tx)
            if company['profile'].get('drying_reminders') is not True:
                raise AccessDenied('Drying reminders are turned off for this company.')
            record = self.compute(job, tx)
            entry = next(
                (r for r in record['reminders'] if r['reminder_id'] == req.reminder_id), None
            )
            if entry and entry['recipient'] != req.recipient:
                raise Conflict('This reminder already names another recipient.')
            if entry and (
                entry['status'] == 'sent'
                or entry['status'] == 'sending'
                or not entry.get('retryable')
            ):
                return record, None, None
            if record['facts_hash'] != req.facts_hash:
                raise Conflict('Drying facts changed. Review the reminder before sending.')
            if record['status'] != 'active':
                raise Conflict('Monitoring has ended; no reminder is needed.')
            member = (
                self.w.read('_memberships', job['assigned_estimator_uid'], tx)
                if job.get('assigned_estimator_uid')
                else None
            )
            if self.recipient_hash(company, job, member, req.recipient) != req.recipient_hash:
                raise Conflict('Recipient changed. Review the reminder before sending.')
            recipient = self.recipient(company, job, member, req.recipient)
            if not entry:
                if len(record['reminders']) >= 200:
                    raise ValueError('This job has reached its reminder limit.')
                entry = dict(reminder_id=req.reminder_id, recipient=req.recipient)
                record['reminders'].append(entry)
            entry.update(
                status='sending',
                retryable=False,
                reason='',
                send_started=time.time(),
                attempt=uuid4().hex,
                origin='manual',
                accepted_by_uid=uid,
                accepted_at=now(),
                facts_hash=req.facts_hash,
                recipient_hash=req.recipient_hash,
            )
            gap = (
                ('No reading since ' + record['last_reading_at'])
                if record['last_reading_at']
                else 'No reading recorded yet.'
            )
            message = delivery_email(
                company,
                recipient,
                'Drying reading reminder',
                [
                    record['address'],
                    f'Day {record["day_number"]} of {record["planned_days"]}.',
                    gap,
                    'Please record the next monitoring reading in DryScope.',
                ],
            )
            tx.set(self.ref(job_id), dict(record, updated_at=now()))
            return record, entry['attempt'], message

        return self.w._run(reserve)

    def remind(self, uid, job_id, req):
        record, attempt, message = self.reserve(uid, job_id, req)
        if not attempt:
            return self.view(uid, job_id)
        try:
            send_email(
                mail_settings(),
                message,
                'reminder',
                'monitoring/' + job_id + '/' + req.reminder_id,
                time.monotonic() + SMTP_DEADLINE,
                prevent_duplicates=True,
            )
            status, reason, retryable = 'sent', '', False
        except UnconfirmedDelivery:
            status, reason, retryable = 'failed', UNCONFIRMED, False
        except Exception:
            status, reason, retryable = 'failed', FAILED, True

        def finish(tx):
            current = self.w.read('_job_monitoring', job_id, tx)
            entry = next(r for r in current['reminders'] if r['reminder_id'] == req.reminder_id)
            if entry['attempt'] != attempt:
                return None
            counter = self.w.email_count(tx) if status == 'sent' else None
            entry.update(status=status, reason=reason, retryable=retryable)
            tx.set(self.ref(job_id), dict(current, updated_at=now()))
            if counter:
                tx.set(self.w.ref('_email_counts', 'daily'), counter)
            return counter

        counter = self.w._run(finish)
        emails_sent(counter)
        event(
            'Drying reminder',
            logging.ERROR if status == 'failed' else logging.INFO,
            operation='reminder',
            reminder_id=req.reminder_id,
            status=status,
        )
        return self.view(uid, job_id)
