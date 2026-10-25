"""Delivery of the signed paperwork. Each job has one delivery sidecar, beside its coordination record
and never inside the signed agreement, with one entry per recipient role. A durable signature queues
one record and sends the adjuster a private link when the signed claim details include an adjuster
email. Crew-lead mail is queued; homeowner mail is sent when requested. Nothing scans older jobs."""

import html
import time
from uuid import uuid4

try:
    from . import document_links
    from .cloud_log import event
    from .contracts import InspectionData
    from .inspection_store import now
    from .workspaces import (
        LOGO_CID,
        SMTP_DEADLINE,
        UnconfirmedDelivery,
        email_address,
        emails_sent,
        invitation_logo,
        logo_attachment,
        mail_settings,
        send_email,
    )
except ImportError:
    import document_links
    from cloud_log import event
    from contracts import InspectionData
    from inspection_store import now
    from workspaces import (
        LOGO_CID,
        SMTP_DEADLINE,
        UnconfirmedDelivery,
        email_address,
        emails_sent,
        invitation_logo,
        logo_attachment,
        mail_settings,
        send_email,
    )

RECIPIENTS = ('homeowner', 'adjuster', 'crew_lead')
NO_ADJUSTER_EMAIL = 'No adjuster email.'
INVALID_ADJUSTER_EMAIL = 'The adjuster email is not a valid address.'
# Same hosts as main.ORIGINS. A request Origin outside this list never becomes a link.
DOCUMENT_ORIGINS = (
    'https://alert-disaster-field-2026.web.app',
    'https://alert-disaster-field-2026.firebaseapp.com',
)
# As for invitations: a send ends within SMTP_DEADLINE (24 s), inside this reservation, so a
# concurrent retry never opens a second Gmail session for an attempt still in flight.
RESERVATION_SECONDS = 30
FAILED = 'The email could not be sent. A retry sends it again.'
NOT_ASKED = 'The homeowner did not ask for an emailed copy.'
NO_CUSTOMER_EMAIL = 'No customer email is saved on the job.'
NOT_SWITCHED_ON = {
    'crew_lead': 'Crew-lead email is not switched on.',
}
# Gmail does not deduplicate, so an attempt that never recorded its outcome is not sent again.
UNCONFIRMED = (
    'Sending stopped before it was confirmed, so the email may have arrived. '
    'It is not sent again automatically.'
)
DELIVERY_OFF = 'Document delivery is turned off for this company.'
NO_CREW_LEAD = 'No crew-lead email is saved for this company.'


def delivery_on(company):
    profile = (company or {}).get('profile') or {}
    return profile.get('document_delivery') is True


def crew_email(company):
    profile = (company or {}).get('profile') or {}
    return (profile.get('crew_lead_email') or '').strip()


def skip_reasons(company, pending=None):
    """Reasons for recipients that will not be sent. Delivery off skips every role. Otherwise a
    company with no crew-lead email skips that role, and pending supplies the other steps'
    reasons."""
    if not delivery_on(company):
        return {role: DELIVERY_OFF for role in RECIPIENTS}
    reasons = dict(pending or {})
    if not crew_email(company):
        reasons.setdefault('crew_lead', NO_CREW_LEAD)
    return reasons


def plain(value):
    return ' '.join(str(value).split())


def crew_summary(data):
    """Address, rooms, equipment and drying days for the crew lead. Prices are left out, and so are
    notes, transcripts and anything else that could carry a dollar amount."""
    if not isinstance(data, InspectionData):
        data = InspectionData.model_validate(data)
    rooms = [plain(room.name) for room in data.rooms]
    equipment = []
    for count, singular, plural in (
        (data.air_movers, 'air mover', 'air movers'),
        (data.dehumidifiers, 'dehumidifier', 'dehumidifiers'),
        (data.air_scrubbers, 'air scrubber', 'air scrubbers'),
        (data.wood_floor_systems, 'wood-floor drying system', 'wood-floor drying systems'),
        (data.power_distribution, 'power-distribution unit', 'power-distribution units'),
    ):
        if count:
            equipment.append(f'{count} {singular if count == 1 else plural}')
    drying = f'Drying days: {data.drying_days}.'
    if data.wood_floor_systems:
        drying += f' Wood-floor drying days: {data.wood_floor_days}.'
    return [
        'Job summary',
        'Address: ' + (plain(data.address) or 'No address recorded.'),
        'Rooms:\n' + ('\n'.join(rooms) or 'None recorded.'),
        'Equipment: ' + (', '.join(equipment) or 'none recorded.'),
        drying,
    ]


def crew_lead_message(company, data):
    """The crew-lead email. It refuses to build when the company has no crew-lead email."""
    to = crew_email(company)
    if not to:
        raise ValueError(NO_CREW_LEAD)
    summary = crew_summary(data)
    address = summary[1].removeprefix('Address: ')
    if address == 'No address recorded.':
        address = 'a signed job'
    return delivery_email(company, to, 'Job summary for ' + address, summary)


class Deliveries:
    def __init__(self, workspaces):
        self.w = workspaces

    def ref(self, job_id):
        return self.w.ref('_job_deliveries', job_id)

    def queue(self, job_id, skipped):
        """Creates the signed job's delivery record once; repeating it returns the record unchanged.
        skipped maps each role that will not be sent to its reason; every other role is queued.
        Company policy always applies. Other steps pass their own reasons in skipped."""

        def create(tx):
            current = self.w.read('_job_deliveries', job_id, tx)
            if current:
                return current, False
            job = self.w.read('_workspace_jobs', job_id, tx)
            if not job or not job.get('auth_id'):
                raise LookupError('Signed job not found.')
            company = self.w.read('_companies', job['company_id'], tx)
            record = self.record(job, skip_reasons(company, skipped))
            tx.create(self.ref(job_id), record)
            return record, True

        record, created = self.w._run(create)
        if created:
            for role in RECIPIENTS:
                logged(record, role)
        return record

    @staticmethod
    def record(job, skipped):
        record = dict(
            delivery_id=uuid4().hex,
            job_id=job['job_id'],
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
        return record

    def send(self, job_id, compose, roles=RECIPIENTS):
        """Sends queued entries and retryable failures; uncertain outcomes are never retried.
        Sent and skipped entries are never sent again. compose(role, record) builds that role's
        message with delivery_email."""
        record = None
        for role in roles:
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
                message_id = send_email(
                    settings,
                    compose(role, record),
                    'delivery',
                    key,
                    deadline,
                    prevent_duplicates=True,
                )
                status, reason, retryable = 'sent', '', False
            except UnconfirmedDelivery:
                message_id = None
                status, reason, retryable = 'failed', UNCONFIRMED, False
            except Exception:
                message_id = None
                status, reason, retryable = 'failed', FAILED, True

            def finish(
                tx,
                role=role,
                attempt=attempt,
                status=status,
                message_id=message_id,
                reason=reason,
                retryable=retryable,
            ):
                current = self.w.read('_job_deliveries', job_id, tx)
                counter = self.w.email_count(tx) if status == 'sent' else None
                entry = current['entries'][role]
                # A later reservation owns the entry once its attempt changes.
                if entry['attempt'] == attempt:
                    entry.update(
                        status=status,
                        reason=reason,
                        retryable=retryable,
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

    def deliver_adjuster(self, store, agreement, origin):
        """After a durable signature. The signature already stands: this never raises.

        The adjuster entry is skipped, with a reason, when the signed claim has no usable email.
        A private link to the itemized claim, the scope defense letter and the scope-code JSON
        is the whole message; nothing is attached. Repeating this retries only an unsent entry."""
        try:
            return self._deliver_adjuster(store, agreement, origin)
        except Exception:
            return None

    def _deliver_adjuster(self, store, agreement, origin):
        documents = agreement.get('documents') or {}
        recipient, reason = adjuster_recipient(documents)
        skipped = dict(NOT_SWITCHED_ON, homeowner='Homeowner email is not switched on.')
        if reason:
            skipped['adjuster'] = reason
        record = self.queue(agreement['inspection_id'], skipped)
        if record['entries']['adjuster']['status'] == 'skipped':
            return record
        host = origin if origin in DOCUMENT_ORIGINS else DOCUMENT_ORIGINS[0]

        def compose(role, current):
            if role != 'adjuster':
                raise RuntimeError('Only the adjuster email is switched on.')
            address, problem = adjuster_recipient(documents)
            if problem or not address:
                raise RuntimeError('Adjuster email is missing.')
            token, _expires = document_links.mint(
                store, agreement['owner_uid'], agreement['auth_id'], 'adjuster'
            )
            company = self.w.read('_companies', current['company_id'])
            if not company:
                raise LookupError('Company not found.')
            return adjuster_email(
                company,
                address,
                documents,
                host + '/documents#' + token,
            )

        return self.send(agreement['inspection_id'], compose, roles=('adjuster',))

    def reserve(self, tx, job_id, role):
        """Returns the record, a new attempt ID when this entry should be sent now (else None), and
        whether the entry was just rewritten without sending (unconfirmed, or skipped because
        delivery is off)."""
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
        sendable = entry['status'] == 'queued' or (
            entry['status'] == 'failed' and entry['retryable']
        )
        if not sendable:
            return record, None, False
        # Off at send time skips work that was queued while the switch was on. Sent entries stay.
        company = self.w.read('_companies', record['company_id'], tx)
        if not delivery_on(company):
            entry.update(status='skipped', reason=DELIVERY_OFF, retryable=False, updated_at=now())
            tx.set(self.ref(job_id), record)
            return record, None, True
        attempt = uuid4().hex
        entry.update(status='sending', attempt=attempt, send_started=time.time(), updated_at=now())
        tx.set(self.ref(job_id), record)
        return record, attempt, False


def homeowner_skips(job, record):
    skipped = dict(NOT_SWITCHED_ON)
    _recipient, reason = adjuster_recipient(record.get('documents') or {})
    if reason:
        skipped['adjuster'] = reason
    if 'email_copy' not in record:
        skipped['homeowner'] = 'Homeowner email is not switched on.'
    elif not record['email_copy']:
        skipped['homeowner'] = NOT_ASKED
    else:
        try:
            email_address(job.get('customer_email') or '')
        except ValueError:
            skipped['homeowner'] = NO_CUSTOMER_EMAIL
    return skipped


def deliver_homeowner(store, record, origin):
    """Send the homeowner's private document link.

    The choice recorded on the signature wins: True sends when customer_email is a real address,
    False or a missing address skips with a reason, and a signature with no choice (signed before
    the checkbox) is left alone. Other recipient entries are handled separately. Sending is idempotent
    through Deliveries.send. A send failure is stored
    on the entry and does not propagate."""
    if (
        not isinstance(record, dict)
        or 'email_copy' not in record
        or not hasattr(store, 'workspaces')
    ):
        return None
    job = store.workspaces.job_for(record)
    deliveries = Deliveries(store.workspaces)
    queued = store.workspaces.read('_job_deliveries', job['job_id'])
    if queued['entries']['homeowner']['status'] == 'skipped':
        return queued
    to = email_address(job.get('customer_email') or '')
    company = store.workspaces.company_actor(record['owner_uid'])['company']
    name = company['profile']['name']

    def compose(role, _delivery):
        token, _expires = document_links.mint(
            store, record['owner_uid'], record['auth_id'], 'homeowner'
        )
        url = origin + '/documents#' + token
        return delivery_email(
            company,
            to,
            'Your signed documents from ' + name,
            [
                'Your signed proposal and photo log are ready.',
                'Open them with the private link below. Nothing is attached.',
            ],
            [('View your signed documents', url)],
        )

    return deliveries.send(job['job_id'], compose, roles=('homeowner',))


def logged(record, role):
    # The delivery ID, recipient role and status only: never an address, name or link.
    event(
        'Delivery entry',
        operation='delivery',
        delivery_id=record['delivery_id'],
        recipient_role=role,
        status=record['entries'][role]['status'],
    )


def adjuster_recipient(documents):
    """The address on the signed claim snapshot, and a skip reason when there is nothing to send.

    The live claim sidecar can change after signing. The email follows the snapshot the documents
    were signed with, which is the claim details those documents hold."""
    claim = documents.get('claim') if isinstance(documents, dict) else None
    raw = claim.get('adjuster_email') if isinstance(claim, dict) else ''
    if not isinstance(raw, str) or not raw.strip():
        return None, NO_ADJUSTER_EMAIL
    try:
        return email_address(raw), None
    except ValueError:
        return None, INVALID_ADJUSTER_EMAIL


def adjuster_email(company, address, documents, url):
    """The adjuster's message: one private link, no file attached, and no ESX claim."""
    name = company['profile']['name']
    proposal = documents.get('adr_estimate') or {}
    claim = documents.get('claim') or {}
    sentences = [f'{name} signed a remediation scope and sent the claim documents.']
    if proposal.get('property_address'):
        sentences.append(f'The property is {proposal["property_address"]}.')
    if claim.get('claim_number'):
        sentences.append(f'The claim number is {claim["claim_number"]}.')
    days = document_links.LINK_SECONDS // 86400
    return delivery_email(
        company,
        address,
        f'Claim documents from {name}',
        [
            ' '.join(sentences),
            (
                'This private link opens the itemized claim and the scope defense letter. '
                'Download scope JSON on that page saves the scope-code export, using the '
                "company's internal scope codes. "
                f'The link can be opened more than once and expires in {days} days.'
            ),
        ],
        [('View the claim documents', url)],
    )


def deliver_signed_adjuster(store, agreement, origin):
    """Queues and sends after a signature when this store has company workspaces. Never raises."""
    if not getattr(store, 'workspaces', None) or not isinstance(agreement, dict):
        return None
    if not agreement.get('inspection_id') or not agreement.get('auth_id'):
        return None
    if not agreement.get('owner_uid'):
        return None
    return Deliveries(store.workspaces).deliver_adjuster(store, agreement, origin)


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
