"""Delivery of the signed paperwork. Each job has one delivery sidecar, beside its coordination record
and never inside the signed agreement, with one entry per recipient role. Nothing queues a delivery
yet: signing does not trigger one and no recipient email is switched on."""

import html
import time
from uuid import uuid4

try:
    from .cloud_log import event
    from .inspection_store import now
    from .workspaces import (
        LOGO_CID,
        SMTP_DEADLINE,
        email_address,
        emails_sent,
        invitation_logo,
        logo_attachment,
        mail_settings,
        send_email,
    )
except ImportError:
    from cloud_log import event
    from inspection_store import now
    from workspaces import (
        LOGO_CID,
        SMTP_DEADLINE,
        email_address,
        emails_sent,
        invitation_logo,
        logo_attachment,
        mail_settings,
        send_email,
    )

RECIPIENTS = ('homeowner', 'adjuster', 'crew_lead')
# As for invitations: a send ends within SMTP_DEADLINE (24 s), inside this reservation, so a
# concurrent retry never opens a second Gmail session for an attempt still in flight.
RESERVATION_SECONDS = 30
FAILED = 'The email could not be sent. A retry sends it again.'
# Gmail does not deduplicate, so an attempt that never recorded its outcome is not sent again.
UNCONFIRMED = (
    'Sending stopped before it was confirmed, so the email may have arrived. '
    'It is not sent again automatically.'
)


class Deliveries:
    def __init__(self, workspaces):
        self.w = workspaces

    def ref(self, job_id):
        return self.w.ref('_job_deliveries', job_id)

    def queue(self, job_id, skipped):
        """Creates the signed job's delivery record once; repeating it returns the record unchanged.
        skipped maps each role that will not be sent to its reason; every other role is queued."""

        def create(tx):
            current = self.w.read('_job_deliveries', job_id, tx)
            if current:
                return current, False
            job = self.w.read('_workspace_jobs', job_id, tx)
            if not job or not job.get('auth_id'):
                raise LookupError('Signed job not found.')
            record = dict(
                delivery_id=uuid4().hex,
                job_id=job_id,
                auth_id=job['auth_id'],
                company_id=job['company_id'],
                created_at=now(),
                entries={
                    role: dict(
                        status='skipped' if role in skipped else 'queued',
                        reason=skipped.get(role, ''),
                        retryable=False,
                        attempt='',
                        send_started=0,
                        message_id=None,
                        updated_at=now(),
                    )
                    for role in RECIPIENTS
                },
            )
            tx.create(self.ref(job_id), record)
            return record, True

        record, created = self.w._run(create)
        if created:
            for role in RECIPIENTS:
                logged(record, role)
        return record

    def send(self, job_id, compose):
        """Sends each queued entry, and each failed one, once; sent and skipped entries are never sent
        again, so repeating this is the retry. compose(role, record) builds that role's message with
        delivery_email."""
        record = None
        for role in RECIPIENTS:
            record, attempt, stale = self.w._run(
                lambda tx, role=role: self.reserve(tx, job_id, role)
            )
            if stale:
                logged(record, role)
            if not attempt:
                continue
            deadline = time.monotonic() + SMTP_DEADLINE
            try:
                settings = mail_settings()
                key = record['delivery_id'] + '/' + role + '/' + attempt
                message_id = send_email(settings, compose(role, record), 'delivery', key, deadline)
                status = 'sent'
            except Exception:
                message_id = None
                status = 'failed'

            def finish(tx, role=role, attempt=attempt, status=status, message_id=message_id):
                current = self.w.read('_job_deliveries', job_id, tx)
                counter = self.w.email_count(tx) if status == 'sent' else None
                entry = current['entries'][role]
                # A later reservation owns the entry once its attempt changes.
                if entry['attempt'] == attempt:
                    entry.update(
                        status=status,
                        reason='' if status == 'sent' else FAILED,
                        retryable=status == 'failed',
                        message_id=message_id,
                        updated_at=now(),
                    )
                    tx.set(self.ref(job_id), current)
                if counter:
                    tx.set(self.w.ref('_email_counts', 'daily'), counter)
                return current, counter

            record, counter = self.w._run(finish)
            logged(record, role)
            emails_sent(counter)
        return record

    def reserve(self, tx, job_id, role):
        """Returns the record, a new attempt ID when this entry should be sent now (else None), and
        whether an unconfirmed attempt was just marked failed."""
        record = self.w.read('_job_deliveries', job_id, tx)
        if not record:
            raise LookupError('Delivery not found.')
        entry = record['entries'][role]
        if entry['status'] == 'sending':
            if time.time() - entry['send_started'] < RESERVATION_SECONDS:
                return record, None, False
            entry.update(status='failed', reason=UNCONFIRMED, retryable=False, updated_at=now())
            tx.set(self.ref(job_id), record)
            return record, None, True
        if entry['status'] != 'queued' and not (entry['status'] == 'failed' and entry['retryable']):
            return record, None, False
        attempt = uuid4().hex
        entry.update(status='sending', attempt=attempt, send_started=time.time(), updated_at=now())
        tx.set(self.ref(job_id), record)
        return record, attempt, False


def logged(record, role):
    # The delivery ID, recipient role and status only: never an address, name or link.
    event(
        'Delivery entry',
        operation='delivery',
        delivery_id=record['delivery_id'],
        recipient_role=role,
        status=record['entries'][role]['status'],
    )


def delivery_email(company, to, subject, paragraphs, links=()):
    """One email from the company: its logo, name, address and phone, Reply-To its contact email
    when that is a valid address, and the sign-off "Powered by DryScope". links are (label, URL)."""
    profile = company['profile']
    name = profile['name']
    contact = [value for value in (profile.get('address'), profile.get('phone')) if value]
    try:
        reply_to = email_address(profile.get('email') or '')
    except ValueError:
        reply_to = None
    logo = invitation_logo(company)
    footer = 'Powered by DryScope'
    text = '\n\n'.join(
        [
            '\n'.join([name, *contact]),
            *paragraphs,
            *[f'{label}: {url}' for label, url in links],
            footer,
        ]
    )
    e = html.escape
    font = 'font-family:Lato,Arial,Helvetica,sans-serif;color:#212529;'
    para = f'{font}font-size:15px;line-height:22px;margin:0 0 12px 0;'
    page = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>{e(subject)}</title></head>
<body style="margin:0;padding:0;background:#f1f2f2;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f1f2f2" style="background:#f1f2f2;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="max-width:560px;background:#ffffff;border:1px solid #dadddd;border-top:4px solid #0B2545;">
<tr><td style="padding:24px 24px 16px 24px;border-bottom:1px solid #dadddd;">
<img src="cid:{LOGO_CID}" width="{logo['width']}" height="{logo['height']}" alt="{e(name)} logo" style="display:block;border:0;outline:none;">
<div style="{font}font-size:18px;line-height:24px;font-weight:bold;padding-top:12px;">{e(name)}</div>
{''.join(f'<div style="{font}font-size:13px;line-height:20px;color:#4b4b4b;">{e(line)}</div>' for line in contact)}
</td></tr>
<tr><td style="padding:24px;">
{''.join(f'<p style="{para}">{e(paragraph)}</p>' for paragraph in paragraphs)}
{''.join(f'<p style="{para}"><a href="{e(url)}" style="color:#0B2545;font-weight:bold;">{e(label)}</a></p>' for label, url in links)}
</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #dadddd;background:#f7f7f7;" bgcolor="#f7f7f7">
<p style="{font}font-size:13px;line-height:20px;margin:0;color:#4b4b4b;">{footer}</p>
</td></tr>
</table>
</td></tr></table>
</body></html>"""
    message = dict(
        to=[email_address(to)],
        subject=subject,
        text=text,
        html=page,
        attachments=[logo_attachment(logo)],
    )
    if reply_to:
        message['reply_to'] = reply_to
    return message
