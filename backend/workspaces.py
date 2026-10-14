"""Private company membership and job-access policy. Invitation delivery provisions the invitee's Firebase account."""

import base64
import hashlib
import html
import io
import json
import os
import re
import smtplib
import ssl
import time
import urllib.request
import urllib.error
from email.message import EmailMessage
from email.utils import parseaddr
from uuid import uuid4
import firebase_admin
from firebase_admin import auth as firebase_auth
from PIL import Image, ImageOps
from google.cloud import firestore
from pydantic import AfterValidator, Field, field_validator
from typing import Annotated, Literal

try:
    from .contracts import StrictModel
    from .inspection_store import Conflict, now, reserve_slot
except ImportError:
    from contracts import StrictModel
    from inspection_store import Conflict, now, reserve_slot

ADR_ID = 'adr'
ROLES = {'owner', 'estimator', 'office'}
CAPABILITIES = {
    'owner': [
        'jobs_read',
        'jobs_create',
        'coordination',
        'assignment',
        'scope',
        'photos',
        'ocr',
        'audit',
        'sign',
        'live',
        'team_manage',
        'profile_manage',
    ],
    'estimator': ['jobs_read', 'jobs_create', 'scope', 'photos', 'ocr', 'audit', 'sign', 'live'],
    'office': ['jobs_read', 'jobs_create', 'coordination', 'assignment'],
}
ADR_PROFILE = dict(
    name='Alert Disaster Restoration',
    address='3300 Patton Way · Bakersfield, CA 93308',
    phone='(661) 426-2151',
    email='',
    license='950983',
    signoff='Matthew Myers',
    logo_data_url='',
)

INVITATION_DAILY_LIMIT = 50
SMTP_HOST = 'smtp.gmail.com'
SMTP_PORT = 587
APP_URL = 'https://alert-disaster-field-2026.web.app/'


class AccessDenied(PermissionError):
    pass


def company_name(value):
    # Owner text reaches invitation emails; keep it to plain business-name characters.
    if (
        len(value) > 80
        or not re.fullmatch(r"(?:[^\W_]|[ .,&'()-])+", value)
        or 'www.' in value.lower()
    ):
        raise ValueError(
            "Company name must be up to 80 letters, numbers, spaces or . , & ' ( ) - characters, with no web address."
        )
    return value


CompanyName = Annotated[str, Field(min_length=1), AfterValidator(company_name)]


class CompanyProfile(StrictModel):
    name: CompanyName
    address: str = Field(default='', max_length=500)
    phone: str = Field(default='', max_length=80)
    email: str = Field(default='', max_length=254)
    license: str = Field(default='', max_length=80)
    signoff: str = Field(default='', max_length=150)
    logo_data_url: str = Field(default='', max_length=1400000)
    # Retired; accepted so older profiles still save, but no longer stored.
    water_heater_notice: str = Field(default='', max_length=1500)


class CompanyCreate(StrictModel):
    name: CompanyName
    owner_email: str = Field(max_length=254)


class ProfileUpdate(StrictModel):
    expected_version: int = Field(ge=1)
    profile: CompanyProfile


class StatusUpdate(StrictModel):
    expected_version: int = Field(ge=1)
    status: Literal['active', 'suspended']


class InviteCreate(StrictModel):
    email: str = Field(max_length=254)
    role: Literal['owner', 'estimator', 'office']


class MemberUpdate(StrictModel):
    expected_version: int = Field(ge=1)
    role: Literal['estimator', 'office']
    status: Literal['active', 'disabled']


class CoordinationUpdate(StrictModel):
    expected_version: int = Field(ge=1)
    customer_name: str = Field(default='', max_length=150)
    customer_phone: str = Field(default='', max_length=80)
    customer_email: str = Field(default='', max_length=254)
    office_notes: str = Field(default='', max_length=4000)
    assigned_estimator_uid: str | None = Field(default=None, max_length=128)
    address: str | None = Field(default=None, max_length=500)


def email_address(value):
    value = value.strip().lower()
    if len(value) > 254 or not re.fullmatch(r'[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+', value):
        raise ValueError('Enter a valid email address.')
    return value


def safe_id(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', value):
        raise LookupError('Record not found.')
    return value


def clean_logo(data):
    if not data:
        return ''
    match = re.fullmatch(r'data:image/(png|jpeg);base64,([A-Za-z0-9+/=]+)', data)
    if not match:
        raise ValueError('Use a PNG or JPEG company logo.')
    try:
        raw = base64.b64decode(match[2], validate=True)
        if len(raw) > 1000000:
            raise ValueError('Logo exceeds 1 MB.')
        with Image.open(io.BytesIO(raw)) as image:
            if image.width * image.height > 4000000:
                raise ValueError('Logo exceeds 4 megapixels.')
            image = ImageOps.exif_transpose(image).convert('RGB')
            image.thumbnail((384, 192))
            output = io.BytesIO()
            image.save(output, format='JPEG', quality=80)
        if len(output.getvalue()) > 100000:
            raise ValueError('Logo is too complex.')
        return 'data:image/jpeg;base64,' + base64.b64encode(output.getvalue()).decode()
    except ValueError:
        raise
    except Exception as error:
        raise ValueError('The logo could not be read.') from error


class WorkspaceStore:
    def __init__(self, db, atomic=None):
        self.db = db
        self._run = atomic or self._atomic

    def _atomic(self, callback):
        return firestore.transactional(callback)(self.db.transaction())

    def ref(self, collection, identifier):
        return self.db.collection(collection).document(safe_id(identifier))

    def read(self, collection, identifier, tx=None):
        snapshot = self.ref(collection, identifier).get(transaction=tx)
        return snapshot.to_dict() if snapshot.exists else None

    def principal(self, uid, tx=None):
        member = self.read('_memberships', uid, tx)
        company = self.read('_companies', member['company_id'], tx) if member else None
        admin = self.read('_platform_admins', uid, tx)
        active = bool(
            member
            and member.get('status') == 'active'
            and company
            and company.get('status') == 'active'
        )
        role = member['role'] if active else None
        return dict(
            uid=uid,
            superadmin=bool(admin and admin.get('active')),
            company_id=member['company_id'] if member else None,
            role=role,
            capabilities=CAPABILITIES.get(role, []),
            company=company if active else None,
            membership_version=member.get('version') if member else None,
        )

    def company_actor(self, uid, company_id=None, manage=False, tx=None):
        actor = self.principal(uid, tx)
        if not actor['role'] or (company_id and company_id != actor['company_id']):
            raise AccessDenied('Your company access is unavailable.')
        if manage and actor['role'] != 'owner':
            raise AccessDenied('Only the company owner can manage staff and company settings.')
        return actor

    def admin(self, uid, tx=None):
        if not self.principal(uid, tx)['superadmin']:
            raise AccessDenied('Superadmin access is required.')

    def company(self, uid, company_id):
        actor = self.principal(uid)
        if not actor['superadmin']:
            self.company_actor(uid, company_id)
        company = self.read('_companies', company_id)
        if not company:
            raise LookupError('Company not found.')
        return company

    def event(self, tx, uid, action, company_id, details):
        identifier = uuid4().hex
        tx.create(
            self.ref('_admin_events', identifier),
            dict(
                event_id=identifier,
                actor_uid=uid,
                action=action,
                company_id=company_id,
                details=details,
                created_at=now(),
            ),
        )

    def companies(self, uid):
        self.admin(uid)
        return [
            s.to_dict()
            for s in self.db.collection('_companies')
            .order_by('created_at', direction=firestore.Query.DESCENDING)
            .limit(100)
            .stream()
        ]

    def create_company(self, uid, name, owner_email):
        owner_email = email_address(owner_email)
        identifier = uuid4().hex
        profile = {
            **ADR_PROFILE,
            'name': name.strip(),
            'address': '',
            'phone': '',
            'email': '',
            'license': '',
            'signoff': '',
            'logo_data_url': '',
        }
        if not profile['name']:
            raise ValueError('Enter the company name.')
        company = dict(
            company_id=identifier,
            profile=profile,
            version=1,
            status='active',
            owner_uid=None,
            region='CA',
            pricing_version='adr-workbook-v1',
            created_at=now(),
            updated_at=now(),
        )
        invite = self.new_invite(identifier, owner_email, 'owner', uid)
        invite['expected_owner_uid'] = None

        def create(tx):
            self.admin(uid, tx)
            tx.create(self.ref('_companies', identifier), company)
            tx.create(self.ref('_invitations', invite['invitation_id']), invite)
            self.event(
                tx, uid, 'company_created', identifier, {'invitation_id': invite['invitation_id']}
            )

        self._run(create)
        return company, invite

    def update_company(self, uid, company_id, req):
        def update(tx):
            company = self.read('_companies', company_id, tx)
            if not company:
                raise LookupError('Company not found.')
            if isinstance(req, StatusUpdate):
                self.admin(uid, tx)
            else:
                self.company_actor(uid, company_id, True, tx)
            expected = req.expected_version
            if company['version'] != expected:
                raise Conflict('Company settings changed. Reload before saving.')
            if isinstance(req, StatusUpdate):
                company['status'] = req.status
            else:
                profile = req.profile.model_dump(exclude={'water_heater_notice'})
                profile['name'] = profile['name'].strip()
                if not profile['name']:
                    raise ValueError('Enter a company name.')
                if profile['email']:
                    profile['email'] = email_address(profile['email'])
                profile['logo_data_url'] = clean_logo(profile['logo_data_url'])
                company['profile'] = profile
            company.update(version=company['version'] + 1, updated_at=now())
            tx.set(self.ref('_companies', company_id), company)
            self.event(
                tx,
                uid,
                'company_status' if isinstance(req, StatusUpdate) else 'company_profile',
                company_id,
                {'version': company['version']},
            )
            return company

        return self._run(update)

    def team(self, uid, company_id):
        actor = self.principal(uid)
        if not actor['superadmin']:
            actor = self.company_actor(uid, company_id)
        members = [
            s.to_dict()
            for s in self.db.collection('_memberships')
            .where(filter=firestore.FieldFilter('company_id', '==', company_id))
            .limit(500)
            .stream()
        ]
        if actor['superadmin'] or 'team_manage' in actor['capabilities']:
            return members
        if 'assignment' not in actor['capabilities']:
            raise AccessDenied('Only the company owner can view the team.')
        # Office staff only need the assignable estimators for the job-assignment dropdown.
        return [
            {k: m[k] for k in ('uid', 'email', 'role', 'status')}
            for m in members
            if m['role'] == 'estimator' and m['status'] == 'active'
        ]

    def cancel_invitations(self, tx, company_id, email):
        # A pending invitation would otherwise let a disabled member reactivate themselves.
        # Reads precede writes here, so call this before the transaction's first write.
        stale = [
            s.to_dict()
            for s in self.db.collection('_invitations')
            .where(filter=firestore.FieldFilter('company_id', '==', company_id))
            .where(filter=firestore.FieldFilter('email', '==', email))
            .stream(transaction=tx)
        ]
        for invitation in stale:
            if invitation['status'] == 'pending':
                invitation['status'] = 'cancelled'
                tx.set(self.ref('_invitations', invitation['invitation_id']), invitation)

    def update_member(self, uid, company_id, member_uid, req):
        def update(tx):
            self.company_actor(uid, company_id, True, tx)
            member = self.read('_memberships', member_uid, tx)
            if not member or member['company_id'] != company_id:
                raise LookupError('Staff member not found.')
            if member['role'] == 'owner' and member['status'] == 'active':
                raise AccessDenied('Only superadmin can replace the owner.')
            if member['version'] != req.expected_version:
                raise Conflict('Staff access changed. Reload the team.')
            if req.status == 'disabled':
                self.cancel_invitations(tx, company_id, member['email'])
            member.update(
                role=req.role, status=req.status, version=member['version'] + 1, updated_at=now()
            )
            tx.set(self.ref('_memberships', member_uid), member)
            self.event(
                tx,
                uid,
                'member_access',
                company_id,
                {'uid': member_uid, 'role': req.role, 'status': req.status},
            )
            return member

        return self._run(update)

    @staticmethod
    def new_invite(company_id, email, role, uid):
        return dict(
            invitation_id=uuid4().hex,
            company_id=company_id,
            email=email,
            role=role,
            status='pending',
            expires_at=time.time() + 7 * 86400,
            created_by=uid,
            created_at=now(),
            delivery_status='pending',
            send_attempt=uuid4().hex,
            send_started=0,
        )

    def invite_actor(self, uid, company_id, role, tx=None):
        if role == 'owner':
            self.admin(uid, tx)
        else:
            self.company_actor(uid, company_id, True, tx)
        company = self.read('_companies', company_id, tx)
        if not company or company['status'] != 'active':
            raise AccessDenied('The company must be active to invite staff.')

    def invitation_quota(self, company_id, tx):
        return reserve_slot(
            self.read('_company_limits', company_id, tx) or {},
            'invitations',
            INVITATION_DAILY_LIMIT,
            86400,
        )

    def invite(self, uid, company_id, email, role):
        email = email_address(email)
        # Serialize invitations for this company/email using a deterministic private key.
        key = hashlib.sha256((company_id + ':' + email).encode()).hexdigest()

        def create(tx):
            self.invite_actor(uid, company_id, role, tx)
            company = self.read('_companies', company_id, tx)
            pointer = self.read('_invite_keys', key, tx)
            previous = self.read('_invitations', pointer['invitation_id'], tx) if pointer else None
            if (
                previous
                and previous['status'] == 'pending'
                and previous['expires_at'] > time.time()
            ):
                if previous['role'] != role:
                    raise Conflict('Cancel the existing invitation before changing its role.')
                return previous
            limits = self.invitation_quota(company_id, tx)
            invitation = self.new_invite(company_id, email, role, uid)
            if role == 'owner':
                invitation['expected_owner_uid'] = company.get('owner_uid')
            tx.create(self.ref('_invitations', invitation['invitation_id']), invitation)
            tx.set(self.ref('_invite_keys', key), {'invitation_id': invitation['invitation_id']})
            tx.set(self.ref('_company_limits', company_id), limits)
            self.event(
                tx,
                uid,
                'invitation_created',
                company_id,
                {'invitation_id': invitation['invitation_id'], 'role': role},
            )
            return invitation

        return self._run(create)

    def invitations(self, uid, company_id):
        actor = self.principal(uid)
        if not actor['superadmin']:
            self.company_actor(uid, company_id, True)
        return [
            s.to_dict()
            for s in self.db.collection('_invitations')
            .where(filter=firestore.FieldFilter('company_id', '==', company_id))
            .limit(100)
            .stream()
        ]

    def pending(self, claims):
        email = email_address(claims['email'])
        return [
            s.to_dict()
            for s in self.db.collection('_invitations')
            .where(filter=firestore.FieldFilter('email', '==', email))
            .limit(100)
            .stream()
            if s.to_dict()['status'] == 'pending' and s.to_dict()['expires_at'] > time.time()
        ]

    def invitation(self, claims, identifier):
        invite = self.read('_invitations', identifier)
        if not invite or invite['email'] != email_address(claims['email']):
            raise LookupError('Invitation not found for this account.')
        company = self.read('_companies', invite['company_id'])
        return {**invite, 'company_name': company['profile']['name'] if company else ''}

    def accept(self, claims, identifier):
        uid = claims['uid']
        email = email_address(claims['email'])
        if not claims.get('email_verified'):
            raise AccessDenied('A verified email address is required.')

        def accept(tx):
            invite = self.read('_invitations', identifier, tx)
            if not invite or invite['email'] != email:
                raise LookupError('Invitation not found for this account.')
            member = self.read('_memberships', uid, tx)
            company = self.read('_companies', invite['company_id'], tx)
            if not company or company['status'] != 'active':
                raise AccessDenied('Company access is unavailable.')
            if invite['status'] == 'accepted' and invite.get('accepted_by') == uid:
                return self.principal(uid, tx)
            if invite['status'] != 'pending' or invite['expires_at'] <= time.time():
                raise Conflict('This invitation is expired or cancelled. Request a new invitation.')
            if member and member['company_id'] != invite['company_id']:
                raise Conflict('This account already belongs to another company.')
            # Revalidate the inviter so a demoted/disabled owner cannot leave usable invitations behind.
            self.invite_actor(invite['created_by'], invite['company_id'], invite['role'], tx)
            old_owner = company.get('owner_uid')
            if invite['role'] == 'owner' and old_owner != invite.get('expected_owner_uid'):
                raise Conflict('The company owner changed. Request a new owner invitation.')
            old_member = (
                self.read('_memberships', old_owner, tx)
                if old_owner and old_owner != uid and invite['role'] == 'owner'
                else None
            )
            if (
                member
                and member['status'] == 'active'
                and member['role'] != invite['role']
                and invite['role'] != 'owner'
            ):
                raise Conflict(
                    'This user already has active access. Change their role through the team dashboard.'
                )
            if (
                member
                and member['role'] == 'owner'
                and member['status'] == 'active'
                and invite['role'] != 'owner'
            ):
                raise AccessDenied('An owner cannot be demoted through a staff invitation.')
            membership = dict(
                uid=uid,
                email=email,
                company_id=invite['company_id'],
                role=invite['role'],
                status='active',
                version=(member or {}).get('version', 0) + 1,
                updated_at=now(),
            )
            if old_member:
                self.cancel_invitations(tx, invite['company_id'], old_member['email'])
                old_member.update(
                    status='disabled', version=old_member['version'] + 1, updated_at=now()
                )
                tx.set(self.ref('_memberships', old_owner), old_member)
            if invite['role'] == 'owner':
                company.update(owner_uid=uid, version=company['version'] + 1, updated_at=now())
                tx.set(self.ref('_companies', invite['company_id']), company)
            tx.set(self.ref('_memberships', uid), membership)
            invite.update(status='accepted', accepted_by=uid, accepted_at=now())
            tx.set(self.ref('_invitations', identifier), invite)
            self.event(
                tx,
                uid,
                'invitation_accepted',
                invite['company_id'],
                {
                    'role': invite['role'],
                    'previous_owner_uid': old_owner if invite['role'] == 'owner' else None,
                },
            )
            return {'uid': uid, 'company_id': invite['company_id'], 'role': invite['role']}

        return self._run(accept)

    def invitation_action(self, uid, company_id, identifier, action):
        def update(tx):
            invitation = self.read('_invitations', identifier, tx)
            if not invitation or invitation['company_id'] != company_id:
                raise LookupError('Invitation not found.')
            self.invite_actor(uid, company_id, invitation['role'], tx)
            if invitation['status'] != 'pending':
                raise Conflict('This invitation is no longer pending.')
            if action == 'cancel':
                invitation['status'] = 'cancelled'
            elif action == 'resend':
                tx.set(
                    self.ref('_company_limits', company_id), self.invitation_quota(company_id, tx)
                )
                invitation.update(
                    delivery_status='pending',
                    send_attempt=uuid4().hex,
                    send_started=0,
                    expires_at=time.time() + 7 * 86400,
                )
            else:
                raise ValueError('Unsupported invitation action.')
            tx.set(self.ref('_invitations', identifier), invitation)
            self.event(tx, uid, 'invitation_' + action, company_id, {'invitation_id': identifier})
            return invitation

        return self._run(update)

    def deliver(self, uid, identifier, sender=None):
        def reserve(tx):
            invite = self.read('_invitations', identifier, tx)
            if not invite:
                raise LookupError('Invitation not found.')
            self.invite_actor(uid, invite['company_id'], invite['role'], tx)
            company = self.read('_companies', invite['company_id'], tx)
            if invite['status'] != 'pending' or invite['expires_at'] <= time.time():
                raise Conflict('Invitation is no longer pending.')
            if invite['delivery_status'] == 'sent':
                return invite, company, False
            if invite['delivery_status'] == 'sending' and time.time() - invite['send_started'] < 30:
                return invite, company, False
            if invite['send_started'] and time.time() - invite['send_started'] > 23 * 3600:
                raise Conflict('Use Resend to start a new delivery attempt.')
            invite.update(delivery_status='sending', send_started=time.time())
            tx.set(self.ref('_invitations', identifier), invite)
            return invite, company, True

        invite, company, send = self._run(reserve)
        if not send:
            return invite
        try:
            message_id = (sender or send_invitation)(invite, company)
            status = 'sent'
            error = ''
        except Exception:
            message_id = None
            status = 'failed'
            error = 'Invitation email could not be sent. Check the sender setup and retry.'

        def finish(tx):
            current = self.read('_invitations', identifier, tx)
            if (
                current
                and current['send_attempt'] == invite['send_attempt']
                and current['status'] == 'pending'
            ):
                current.update(delivery_status=status, delivery_error=error, message_id=message_id)
                tx.set(self.ref('_invitations', identifier), current)
                return current
            return current

        return self._run(finish)

    def job_access(self, uid, record, action='read', tx=None):
        actor = self.company_actor(uid, tx=tx)
        if record.get('inspection_id') and not record.get('auth_id'):
            job_id = record['inspection_id']
        else:
            mapping = self.read('_workspace_authorizations', record.get('auth_id', ''), tx)
            if not mapping:
                raise LookupError('Job not found.')
            job_id = mapping['job_id']
        job = self.read('_workspace_jobs', job_id, tx)
        if not job or job['company_id'] != actor['company_id']:
            raise LookupError('Job not found.')
        if actor['role'] == 'estimator' and uid not in job['accessible_estimator_uids']:
            raise LookupError('Job not found.')
        capability = {'read': 'jobs_read', 'create': 'jobs_create'}.get(action, action)
        if capability not in actor['capabilities']:
            raise AccessDenied('Your role cannot perform this job action.')
        return job, actor

    def create_job(self, uid, record, tx):
        actor = self.company_actor(uid, tx=tx)
        if 'jobs_create' not in actor['capabilities']:
            raise AccessDenied('Job creation is not allowed.')
        if actor['role'] == 'office':
            try:
                from .contracts import InspectionData
            except ImportError:
                from contracts import InspectionData
            defaults = InspectionData(address=record['data']['address']).model_dump(
                mode='json', exclude_none=True
            )
            actual = {k: v for k, v in record['data'].items() if v is not None}
            if actual != defaults:
                raise AccessDenied('Office-created jobs must start with empty scope.')
        job = dict(
            job_id=record['inspection_id'],
            company_id=actor['company_id'],
            creator_uid=uid,
            accessible_estimator_uids=[uid],
            assigned_estimator_uid=None,
            version=1,
            kind='inspection',
            customer_name='',
            customer_phone='',
            customer_email='',
            office_notes='',
            auth_exists=False,
            address=record['data']['address'],
            status=record['status'],
            updated_at=record['updated_at'],
            created_at=record['created_at'],
        )
        tx.create(self.ref('_workspace_jobs', job['job_id']), job)
        return job

    def sync_job(self, record, tx):
        tx.set(
            self.ref('_workspace_jobs', record['inspection_id']),
            dict(
                address=record['data']['address'],
                status=record['status'],
                updated_at=record['updated_at'],
            ),
            merge=True,
        )

    def snapshot(self, uid):
        actor = self.company_actor(uid)
        company = actor['company']
        # Older profiles may still store the retired water-heater notice.
        profile = {k: v for k, v in company['profile'].items() if k != 'water_heater_notice'}
        return {
            **profile,
            'company_id': company['company_id'],
            'version': company['version'],
        }

    def check_profile(self, uid, identity, tx=None):
        actor = self.company_actor(uid, tx=tx)
        company = actor['company']
        if (
            not identity
            or identity['company_id'] != actor['company_id']
            or identity['version'] != company['version']
        ):
            raise Conflict('Company details changed. Generate new documents before signing.')

    def coordination(self, uid, inspection_id, req):
        ref = self.ref('_workspace_jobs', inspection_id)
        inspection_ref = self.ref('inspections', inspection_id)

        def update(tx):
            record = self.read('inspections', inspection_id, tx)
            if not record:
                raise LookupError('Inspection not found.')
            job, actor = self.job_access(uid, record, 'coordination', tx)
            if job['version'] != req.expected_version:
                raise Conflict('Job coordination changed. Reload before saving.')
            assignee = (
                self.read('_memberships', req.assigned_estimator_uid, tx)
                if req.assigned_estimator_uid
                else None
            )
            if req.assigned_estimator_uid and (
                not assignee
                or assignee['company_id'] != actor['company_id']
                or assignee['role'] != 'estimator'
                or assignee['status'] != 'active'
            ):
                raise ValueError('Assign an active estimator from this company.')
            if req.address is not None and req.address != record['data']['address']:
                if record['status'] == 'signed':
                    raise Conflict('A signed property address cannot be changed.')
                record['data']['address'] = req.address
                record.update(
                    revision=record['revision'] + 1, audit=None, status='draft', updated_at=now()
                )
            updates = req.model_dump(exclude={'expected_version', 'address'})
            if updates['customer_email']:
                updates['customer_email'] = email_address(updates['customer_email'])
            job.update(
                **updates,
                version=job['version'] + 1,
                accessible_estimator_uids=list(
                    dict.fromkeys(
                        [job['creator_uid']]
                        + ([req.assigned_estimator_uid] if req.assigned_estimator_uid else [])
                    )
                ),
                address=record['data']['address'],
                status=record['status'],
                updated_at=now(),
            )
            tx.set(ref, job)
            if req.address is not None and record['status'] != 'signed':
                tx.set(inspection_ref, record)
            self.event(
                tx,
                uid,
                'job_coordination',
                actor['company_id'],
                {'job_id': inspection_id, 'assigned_estimator_uid': req.assigned_estimator_uid},
            )
            return job

        return self._run(update)


def password_setup_link(email):
    """Create the invitee's account if needed so nobody else can pre-register the address. None means a Google account."""
    try:
        app = firebase_admin.get_app('adr')
    except ValueError:
        app = firebase_admin.initialize_app(
            options={'projectId': os.getenv('GOOGLE_CLOUD_PROJECT', 'alert-disaster-field-2026')},
            name='adr',
        )
    try:
        user = firebase_auth.get_user_by_email(email, app=app)
    except firebase_auth.UserNotFoundError:
        try:
            user = firebase_auth.create_user(email=email, email_verified=False, app=app)
        except firebase_auth.EmailAlreadyExistsError:
            user = firebase_auth.get_user_by_email(email, app=app)
    if any(info.provider_id == 'google.com' for info in user.provider_data):
        return None
    # The link is a credential: it goes only into the outgoing email, never Firestore or logs.
    return firebase_auth.generate_password_reset_link(
        email, firebase_auth.ActionCodeSettings(url=APP_URL, handle_code_in_app=False), app=app
    )


def send_invitation(invite, company):
    """Send through the transport INVITATION_TRANSPORT selects: 'resend' (default) or 'smtp' (Gmail app password)."""
    transport = os.getenv('INVITATION_TRANSPORT', 'resend').strip().lower() or 'resend'
    sender = os.getenv('INVITATION_FROM', '')
    if transport == 'resend':
        key = os.getenv('RESEND_API_KEY', '')
        configured = key and sender
    elif transport == 'smtp':
        username = os.getenv('INVITATION_SMTP_USERNAME', '')
        password = os.getenv('INVITATION_SMTP_PASSWORD', '')
        configured = username and password and sender
    else:
        configured = False
    if not configured:
        raise RuntimeError('Invitation email is not configured.')
    link = APP_URL + '?invite=' + invite['invitation_id']
    setup = password_setup_link(invite['email'])
    name = company['profile']['name']
    role = {'office': 'office staff'}.get(invite['role'], invite['role'])
    email = invite['email']
    if setup:
        steps = f'Set your password for the ADR field app: {setup}\nIf that link has expired, use Forgot password on the sign-in page.\nThen sign in with {email} and that password.'
        steps_html = (
            f'<p>Set your password for the ADR field app: <a href="{html.escape(setup)}">{html.escape(setup)}</a></p>'
            f'<p>If that link has expired, use Forgot password on the sign-in page.</p><p>Then sign in with {html.escape(email)} and that password.</p>'
        )
    else:
        steps = f'Sign in with Google using this email ({email}).'
        steps_html = f'<p>Sign in with Google using this email ({html.escape(email)}).</p>'
    payload = {
        'from': sender,
        'to': [email],
        'subject': 'Invitation to join a company on the ADR field app',
        'text': f'You have been invited to {name} as {role}.\n{steps}\nAccept the invitation: {link}\nThis invitation expires in seven days.',
        'html': f'<p>You have been invited to {html.escape(name)} as {html.escape(role)}.</p>{steps_html}<p><a href="{link}">Accept invitation</a></p><p>Expires in seven days.</p>',
    }
    if transport == 'smtp':
        return send_smtp(payload, username, password, invite)
    request = urllib.request.Request(
        'https://api.resend.com/emails',
        data=json.dumps(payload).encode(),
        method='POST',
        headers={
            'Authorization': 'Bearer ' + key,
            'Content-Type': 'application/json',
            'Idempotency-Key': invite['invitation_id'] + '/' + invite['send_attempt'],
        },
    )
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=8) as response:
                result = json.loads(response.read(65536))
                if not isinstance(result.get('id'), str):
                    raise RuntimeError('Unconfirmed email delivery.')
                return result['id']
        except urllib.error.HTTPError as error:
            if error.code not in (408, 429, 500, 502, 503, 504) or attempt == 2:
                raise
        except (urllib.error.URLError, TimeoutError):
            if attempt == 2:
                raise
        time.sleep(2 ** (attempt + 1))


def send_smtp(payload, username, password, invite):
    """Gmail SMTP has no idempotency key; the Message-ID is stable per attempt but Gmail does not deduplicate on it."""
    message = EmailMessage()
    message['From'] = payload['from']
    message['To'] = ', '.join(payload['to'])
    message['Subject'] = payload['subject']
    domain = parseaddr(payload['from'])[1].rpartition('@')[2] or 'adr.invalid'
    message['Message-ID'] = (
        f'<invitation-{invite["invitation_id"]}-{invite["send_attempt"]}@{domain}>'
    )
    message.set_content(payload['text'])
    message.add_alternative(payload['html'], subtype='html')
    for attempt in range(3):
        try:
            server = smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=8)
            try:
                server.starttls(context=ssl.create_default_context())
                server.login(username, password)
                server.send_message(message)
            finally:
                # No QUIT: a failed QUIT after an accepted message must not trigger a duplicate retry.
                server.close()
            return message['Message-ID']
        except smtplib.SMTPRecipientsRefused as error:
            if attempt == 2 or not all(400 <= code < 500 for code, _ in error.recipients.values()):
                raise
        except smtplib.SMTPResponseException as error:
            if not 400 <= error.smtp_code < 500 or attempt == 2:
                raise
        except smtplib.SMTPServerDisconnected:
            if attempt == 2:
                raise
        except smtplib.SMTPException:
            raise
        except OSError:
            if attempt == 2:
                raise
        time.sleep(2 ** (attempt + 1))
