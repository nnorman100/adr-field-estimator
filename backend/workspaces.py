"""Private company membership and job-access policy. Invitation delivery provisions the invitee's Firebase account;
a superadmin can instead create an owner's email/password login with a temporary password."""

import base64
import hashlib
import html
import io
import json
import os
import re
import smtplib
import socket
import ssl
import threading
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
from pydantic import AfterValidator, Field, SecretStr, field_validator
from typing import Annotated, Literal

try:
    from .contracts import ClaimDetails, StrictModel
    from .inspection_store import Conflict, now, reserve_slot
except ImportError:
    from contracts import ClaimDetails, StrictModel
    from inspection_store import Conflict, now, reserve_slot

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

INVITATION_DAILY_LIMIT = 50
SMTP_HOST = 'smtp.gmail.com'
SMTP_PORT = 587
SMTP_DEADLINE = 24
# The signed-in app lives at /app; the site root is the public DryScope landing page.
APP_URL = 'https://alert-disaster-field-2026.web.app/app'
INVITATION_SUBJECT = 'Invitation to join {company} on DryScope'
# Invitation logo for a company without one: the DryScope lockup on white.
with open(os.path.join(os.path.dirname(__file__), 'brand', 'dryscope-logo.png'), 'rb') as _logo:
    DRYSCOPE_LOGO = _logo.read()
LOGO_CID = 'invitation-logo@dryscope'
# Set on the membership (the server's gate) and as a Firebase custom claim (the client's cue) when a
# superadmin creates an owner login; cleared when the owner sets their own password.
PASSWORD_CHANGE = 'password_change_required'
PASSWORD_CHANGE_REQUIRED = 'Set your own password before using DryScope.'
PASSWORD_LENGTH = (12, 128)
# Holds an account for one owner login from before its password is written until its membership commits.
LOGIN_RESERVATIONS = '_owner_login_reservations'
# The reservation must outlive the request's Firebase writes, or a slow write could land after another
# owner login reused the account. Those writes use login_client: no SDK retries (urllib3 honors
# Retry-After for up to six hours) and LOGIN_HTTP_SECONDS for each connect and read wait. A call is at
# most three rounds (google-auth's two 401 token refreshes) of a token fetch and the request, each a
# connect and a read, so 12 waits; an owner login makes at most two calls: 24 waits, 240 seconds.
LOGIN_HTTP_SECONDS = 10
LOGIN_RESERVATION_SECONDS = 600


class AccessDenied(PermissionError):
    pass


class PasswordChangeRequired(AccessDenied):
    def __init__(self):
        super().__init__(PASSWORD_CHANGE_REQUIRED)


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
    # Present: create the owner's login with this temporary password instead of inviting them.
    # SecretStr keeps the value out of reprs; check_password applies the rule with a fixed message.
    owner_password: SecretStr | None = None


class OwnerLogin(StrictModel):
    email: str = Field(max_length=254)
    password: SecretStr
    expected_version: int = Field(ge=1)


class PasswordChange(StrictModel):
    password: SecretStr


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


class ClaimUpdate(StrictModel):
    # Jobs saved before claim details have no claim_version; they start at 0.
    expected_version: int = Field(ge=0)
    claim: ClaimDetails


def email_address(value):
    value = value.strip().lower()
    if len(value) > 254 or not re.fullmatch(r'[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+', value):
        raise ValueError('Enter a valid email address.')
    return value


def check_password(value):
    low, high = PASSWORD_LENGTH
    if not low <= len(value) <= high:
        raise ValueError(f'Use a password of {low} to {high} characters.')
    return value


def login_key(email):
    return hashlib.sha256(email.encode()).hexdigest()


def masked_email(email):
    local, _, domain = email.partition('@')
    return local[:1] + '***@' + domain


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
        # A temporary password grants nothing, superadmin included, until the owner replaces it.
        locked = bool(member and member.get(PASSWORD_CHANGE))
        active = bool(
            not locked
            and member
            and member.get('status') == 'active'
            and company
            and company.get('status') == 'active'
        )
        role = member['role'] if active else None
        return dict(
            uid=uid,
            superadmin=bool(not locked and admin and admin.get('active')),
            company_id=member['company_id'] if member else None,
            role=role,
            capabilities=CAPABILITIES.get(role, []),
            company=company if active else None,
            membership_version=member.get('version') if member else None,
            password_change_required=locked,
        )

    def company_actor(self, uid, company_id=None, manage=False, tx=None):
        actor = self.principal(uid, tx)
        if actor['password_change_required']:
            raise PasswordChangeRequired()
        if not actor['role'] or (company_id and company_id != actor['company_id']):
            raise AccessDenied('Your company access is unavailable.')
        if manage and actor['role'] != 'owner':
            raise AccessDenied('Only the company owner can manage staff and company settings.')
        return actor

    def admin(self, uid, tx=None):
        actor = self.principal(uid, tx)
        if actor['password_change_required']:
            raise PasswordChangeRequired()
        if not actor['superadmin']:
            raise AccessDenied('Superadmin access is required.')

    def unlocked(self, uid, tx=None):
        if (self.read('_memberships', uid, tx) or {}).get(PASSWORD_CHANGE):
            raise PasswordChangeRequired()

    def support_company(self, uid, company_id, tx=None):
        """Superadmin support: read-only access to any company plus a few audited team fixes.
        It is not a membership, so it grants no job writes, assignments or membership slot."""
        self.admin(uid, tx)
        company = self.read('_companies', company_id, tx)
        if not company:
            raise LookupError('Company not found.')
        return company

    @staticmethod
    def supported(actor, company_id, role=None):
        # Membership permissions come first; superadmin support covers only what they lack.
        member = actor['role'] and actor['company_id'] == company_id
        return actor['superadmin'] and not (member and (role is None or actor['role'] == role))

    def support_job(self, uid, company_id, record, tx=None):
        self.support_company(uid, company_id, tx)
        job = self.job_for(record, tx)
        if job['company_id'] != company_id:
            raise LookupError('Job not found.')
        return job

    def support_audit(self, uid, company_id, action, target, record=None):
        """Rechecks support access and appends the audit entry in one transaction, so a
        superadmin receives company data only when both succeed."""

        def audit(tx):
            if record is None:
                self.support_company(uid, company_id, tx)
            else:
                self.support_job(uid, company_id, record, tx)
            self.event(tx, uid, 'support_' + action, company_id, {}, target)

        self._run(audit)

    def company(self, uid, company_id):
        actor = self.principal(uid)
        support = self.supported(actor, company_id)
        if not support:
            self.company_actor(uid, company_id)
        company = self.read('_companies', company_id)
        if not company:
            raise LookupError('Company not found.')
        if support:
            self.support_audit(uid, company_id, 'view_company', 'company')
        return company

    def event(self, tx, uid, action, company_id, details, target=None):
        # Append-only: each entry is created once and never rewritten. Targets are record IDs only.
        identifier = uuid4().hex
        entry = dict(
            event_id=identifier,
            actor_uid=uid,
            action=action,
            company_id=company_id,
            details=details,
            created_at=now(),
        )
        if target:
            entry['target'] = target
        tx.create(self.ref('_admin_events', identifier), entry)

    def companies(self, uid):
        self.admin(uid)
        return [
            s.to_dict()
            for s in self.db.collection('_companies')
            .order_by('created_at', direction=firestore.Query.DESCENDING)
            .limit(100)
            .stream()
        ]

    @staticmethod
    def new_company(name):
        identifier = uuid4().hex
        profile = {
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
        return company

    def create_company(self, uid, name, owner_email):
        owner_email = email_address(owner_email)
        company = self.new_company(name)
        identifier = company['company_id']
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

    def owner_login(self, uid, company_id, email, password, expected_version=None, name=None):
        """Superadmin alternative to an owner invitation: creates or updates the owner's email/password
        login with a temporary password, then makes it the company's owner as an accepted owner
        invitation would. company_id None creates the company named name. The password goes only
        to Firebase Authentication, never to Firestore, the audit log, logs or the response."""
        # Authorize before any lookup so a refused caller learns nothing and changes no account.
        self.admin(uid)
        email = email_address(email)
        check_password(password)
        if company_id is None:
            created = self.new_company(name)
        else:
            self.replaceable(self.read('_companies', company_id), expected_version)
        user = login_account(email)
        key, claim = self.reserve_login(email, user)

        def create(tx):
            self.admin(uid, tx)
            if (self.read(LOGIN_RESERVATIONS, key, tx) or {}).get('claim') != claim:
                raise Conflict('This owner login took too long. Try again.')
            company = (
                created
                if company_id is None
                else self.replaceable(self.read('_companies', company_id, tx), expected_version)
            )
            if self.read('_memberships', owner_uid, tx):
                raise Conflict('This email already has company access. Choose a different email.')
            old_owner = company.get('owner_uid')
            old_member = self.read('_memberships', old_owner, tx) if old_owner else None
            invitations = (
                []
                if company_id is None
                else [
                    s.to_dict()
                    for s in self.db.collection('_invitations')
                    .where(filter=firestore.FieldFilter('company_id', '==', company_id))
                    .stream(transaction=tx)
                ]
            )
            # All reads are done. Pending owner invitations, and any left for either owner, end here.
            emails = {email, (old_member or {}).get('email')}
            cancelled = [
                i
                for i in invitations
                if i['status'] == 'pending' and (i['role'] == 'owner' or i['email'] in emails)
            ]
            for invitation in cancelled:
                invitation['status'] = 'cancelled'
                tx.set(self.ref('_invitations', invitation['invitation_id']), invitation)
            if old_member:
                old_member.update(
                    status='disabled', version=old_member['version'] + 1, updated_at=now()
                )
                tx.set(self.ref('_memberships', old_owner), old_member)
            company = {**company, 'owner_uid': owner_uid, 'updated_at': now()}
            if company_id is None:
                tx.create(self.ref('_companies', company['company_id']), company)
            else:
                company['version'] += 1
                tx.set(self.ref('_companies', company_id), company)
            tx.create(
                self.ref('_memberships', owner_uid),
                dict(
                    uid=owner_uid,
                    email=email,
                    company_id=company['company_id'],
                    role='owner',
                    status='active',
                    version=1,
                    updated_at=now(),
                    **{PASSWORD_CHANGE: True},
                ),
            )
            self.event(
                tx,
                uid,
                'owner_login_created',
                company['company_id'],
                {
                    'email': masked_email(email),
                    'replacement': bool(old_owner),
                    'previous_owner_uid': old_owner,
                    'cancelled_invitations': len(cancelled),
                },
                'member/' + owner_uid,
            )
            tx.delete(self.ref(LOGIN_RESERVATIONS, key))
            return company

        # The password changes only while this request holds the account; any failure frees it.
        try:
            owner_uid = set_temporary_password(user, email, password)
            company = self._run(create)
        except Exception:
            self.release_login(key, claim)
            raise
        return {'company': company, 'owner': {'uid': owner_uid, 'email': email}}

    def reserve_login(self, email, user):
        """Claims the account before its password changes, so a competing owner login or invitation
        acceptance cannot take it between the password write and the membership commit."""
        key = login_key(email)
        claim = uuid4().hex

        def reserve(tx):
            held = self.read(LOGIN_RESERVATIONS, key, tx)
            if user and self.read('_memberships', user.uid, tx):
                raise Conflict('This email already has company access. Choose a different email.')
            if held and held['expires_at'] > time.time():
                raise Conflict(
                    'Another owner login for this email is in progress. Try again in a few minutes.'
                )
            tx.set(
                self.ref(LOGIN_RESERVATIONS, key),
                {'claim': claim, 'expires_at': time.time() + LOGIN_RESERVATION_SECONDS},
            )

        self._run(reserve)
        return key, claim

    def release_login(self, key, claim):
        def release(tx):
            if (self.read(LOGIN_RESERVATIONS, key, tx) or {}).get('claim') == claim:
                tx.delete(self.ref(LOGIN_RESERVATIONS, key))

        self._run(release)

    @staticmethod
    def replaceable(company, expected_version):
        if not company:
            raise LookupError('Company not found.')
        if company['status'] != 'active':
            raise AccessDenied('The company must be active to change its owner.')
        if company['version'] != expected_version:
            raise Conflict('Company details changed. Reload before changing the owner.')
        return company

    def change_password(self, claims, password):
        """Replaces a temporary password with the owner's own, then lifts the gate. The backend sets the
        password itself, so a modified client cannot clear the marker without changing it."""
        uid = claims['uid']
        if claims.get('firebase', {}).get('sign_in_provider') != 'password':
            raise AccessDenied('Sign in with your email and temporary password first.')
        check_password(password)
        member = self.read('_memberships', uid) or {}
        # The claim also counts, so an account whose membership step failed is not stuck.
        if not (member.get(PASSWORD_CHANGE) or claims.get(PASSWORD_CHANGE)):
            raise Conflict(
                'Your password is already set. Use Forgot password on the sign-in page to change it.'
            )
        # Firebase first: clearing the gate before the password changed would let the temporary one stand.
        replace_temporary_password(uid, password)

        def clear(tx):
            member = self.read('_memberships', uid, tx)
            if member and member.get(PASSWORD_CHANGE):
                member = {k: v for k, v in member.items() if k != PASSWORD_CHANGE}
                member['updated_at'] = now()
                tx.set(self.ref('_memberships', uid), member)
                self.event(
                    tx,
                    uid,
                    'temporary_password_replaced',
                    member['company_id'],
                    {},
                    'member/' + uid,
                )

        self._run(clear)
        return {'password_changed': True}

    def update_company(self, uid, company_id, req):
        def update(tx):
            # Authorize before the lookup so a refused caller cannot probe which companies exist.
            if isinstance(req, StatusUpdate):
                self.admin(uid, tx)
            else:
                self.company_actor(uid, company_id, True, tx)
            company = self.read('_companies', company_id, tx)
            if not company:
                raise LookupError('Company not found.')
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
        support = self.supported(actor, company_id, 'owner')
        if not support:
            actor = self.company_actor(uid, company_id)
        members = [
            s.to_dict()
            for s in self.db.collection('_memberships')
            .where(filter=firestore.FieldFilter('company_id', '==', company_id))
            .limit(500)
            .stream()
        ]
        if support:
            self.support_audit(uid, company_id, 'view_team', 'team')
            return members
        if 'team_manage' in actor['capabilities']:
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
            support = self.supported(self.principal(uid, tx), company_id, 'owner')
            if support:
                if self.support_company(uid, company_id, tx)['status'] != 'active':
                    raise AccessDenied('The company must be active to change staff access.')
            else:
                self.company_actor(uid, company_id, True, tx)
            member = self.read('_memberships', member_uid, tx)
            if not member or member['company_id'] != company_id:
                raise LookupError('Staff member not found.')
            if member['role'] == 'owner' and member['status'] == 'active':
                raise AccessDenied('Only superadmin can replace the owner.')
            if support:
                # Support may switch estimator/office and re-enable staff, nothing more.
                if member_uid == uid:
                    raise AccessDenied('Support access cannot change your own membership.')
                if member['role'] == 'owner':
                    raise AccessDenied('Owner access changes only through an owner invitation.')
                if req.status == 'disabled' and member['status'] != 'disabled':
                    raise AccessDenied('Support access cannot disable staff.')
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
                'support_member_access' if support else 'member_access',
                company_id,
                {'uid': member_uid, 'role': req.role, 'status': req.status},
                'member/' + member_uid if support else None,
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

    def invite_actor(self, uid, company_id, role, tx=None, support=False):
        """support admits superadmin for an existing staff invitation's resend or cancel;
        returns True when that, rather than ownership, authorized the call."""
        supported = False
        if role == 'owner':
            self.admin(uid, tx)
        elif support and self.supported(self.principal(uid, tx), company_id, 'owner'):
            supported = True
        else:
            self.company_actor(uid, company_id, True, tx)
        company = self.read('_companies', company_id, tx)
        if not company or company['status'] != 'active':
            raise AccessDenied('The company must be active to invite staff.')
        return supported

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
        support = self.supported(self.principal(uid), company_id, 'owner')
        if not support:
            self.company_actor(uid, company_id, True)
        invitations = [
            s.to_dict()
            for s in self.db.collection('_invitations')
            .where(filter=firestore.FieldFilter('company_id', '==', company_id))
            .limit(100)
            .stream()
        ]
        if support:
            self.support_audit(uid, company_id, 'view_invitations', 'invitations')
        return invitations

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
        self.unlocked(claims['uid'])
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
            if (member or {}).get(PASSWORD_CHANGE):
                raise PasswordChangeRequired()
            held = self.read(LOGIN_RESERVATIONS, login_key(email), tx)
            if held and held['expires_at'] > time.time():
                raise Conflict(
                    'An owner login is being created for this account. Try again shortly.'
                )
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
            support = self.invite_actor(uid, company_id, invitation['role'], tx, True)
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
            self.event(
                tx,
                uid,
                ('support_' if support else '') + 'invitation_' + action,
                company_id,
                {'invitation_id': identifier},
                'invitation/' + identifier if support else None,
            )
            return invitation

        return self._run(update)

    def deliver(self, uid, identifier, sender=None):
        def reserve(tx):
            invite = self.read('_invitations', identifier, tx)
            if not invite:
                raise LookupError('Invitation not found.')
            # Only creation and resend reach delivery; creation already required ownership.
            self.invite_actor(uid, invite['company_id'], invite['role'], tx, True)
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

    def job_for(self, record, tx=None):
        if record.get('inspection_id') and not record.get('auth_id'):
            job_id = record['inspection_id']
        else:
            mapping = self.read('_workspace_authorizations', record.get('auth_id', ''), tx)
            if not mapping:
                raise LookupError('Job not found.')
            job_id = mapping['job_id']
        job = self.read('_workspace_jobs', job_id, tx)
        if not job:
            raise LookupError('Job not found.')
        return job

    def job_access(self, uid, record, action='read', tx=None):
        actor = self.company_actor(uid, tx=tx)
        job = self.job_for(record, tx)
        if job['company_id'] != actor['company_id']:
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
            # Saved payloads leave out an empty tag-scan list (inspection_payload).
            defaults.pop('equipment_scans')
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

    def customer_name(self, record, tx=None):
        return self.job_for(record, tx).get('customer_name', '').strip()

    def check_customer(self, record, proposal, tx=None):
        # Documents audited before customer names were added carry none to compare.
        named = proposal.get('customer_name')
        if named is not None and named != self.customer_name(record, tx):
            raise Conflict('Customer details changed. Generate new documents before signing.')

    @staticmethod
    def job_claim(job):
        return ClaimDetails.model_validate(job.get('claim', {})).model_dump()

    def claim_details(self, record, tx=None):
        return self.job_claim(self.job_for(record, tx))

    def check_claim(self, record, documents, tx=None):
        # Documents audited before claim details, or without workspaces, carry none to compare.
        if 'claim' in documents and documents['claim'] != self.claim_details(record, tx):
            raise Conflict('Claim details changed. Generate new documents before signing.')

    def claim(self, uid, inspection_id):
        record = self.read('inspections', inspection_id)
        if not record:
            raise LookupError('Inspection not found.')
        job, actor = self.job_access(uid, record)
        return self.claim_view(job, actor)

    def claim_view(self, job, actor):
        return dict(
            job_id=job['job_id'],
            claim_version=job.get('claim_version', 0),
            claim=self.job_claim(job),
            editable=bool({'scope', 'coordination'} & set(actor['capabilities'])),
        )

    def update_claim(self, uid, inspection_id, req):
        """Estimators record claim details during intake and office staff after it; signed
        documents keep the snapshot they were signed with."""
        ref = self.ref('_workspace_jobs', inspection_id)
        inspection_ref = self.ref('inspections', inspection_id)

        def update(tx):
            record = self.read('inspections', inspection_id, tx)
            if not record:
                raise LookupError('Inspection not found.')
            job, actor = self.job_access(uid, record, tx=tx)
            if not {'scope', 'coordination'} & set(actor['capabilities']):
                raise AccessDenied('Your role cannot change claim details.')
            if job.get('claim_version', 0) != req.expected_version:
                raise Conflict('Claim details changed. Reload before saving.')
            claim = req.claim.model_dump()
            # The documents print the claim details, so new details need new documents.
            if (
                claim != self.job_claim(job)
                and record['status'] != 'signed'
                and record.get('audit') is not None
            ):
                record.update(audit=None, status='draft', updated_at=now())
                tx.set(inspection_ref, record)
            job.update(
                claim=claim,
                claim_version=req.expected_version + 1,
                status=record['status'],
                updated_at=now(),
            )
            tx.set(ref, job)
            self.event(tx, uid, 'job_claim', actor['company_id'], {'job_id': inspection_id})
            return self.claim_view(job, actor)

        return self._run(update)

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
            # The documents name the customer, so a new name needs new documents.
            customer_changed = (
                req.customer_name.strip() != job.get('customer_name', '').strip()
                and record['status'] != 'signed'
                and record.get('audit') is not None
            )
            if customer_changed:
                record.update(audit=None, status='draft', updated_at=now())
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
            if (req.address is not None or customer_changed) and record['status'] != 'signed':
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


def auth_app():
    try:
        return firebase_admin.get_app('adr')
    except ValueError:
        return firebase_admin.initialize_app(
            options={'projectId': os.getenv('GOOGLE_CLOUD_PROJECT', 'alert-disaster-field-2026')},
            name='adr',
        )


def google_account(user):
    return any(info.provider_id == 'google.com' for info in user.provider_data)


def login_account(email):
    """The existing Firebase account for an owner login, or None. Read-only; refuses accounts a temporary password must not take over."""
    try:
        user = firebase_auth.get_user_by_email(email, app=auth_app())
    except firebase_auth.UserNotFoundError:
        return None
    if user.disabled:
        raise Conflict(
            "This email's sign-in is disabled in Firebase Authentication. Choose a different email."
        )
    if google_account(user):
        raise Conflict('This email signs in with Google. Send an owner invitation instead.')
    return user


def login_client():
    """Firebase Authentication with the bounded calls LOGIN_RESERVATION_SECONDS relies on."""
    try:
        app = firebase_admin.get_app('adr-owner-login')
    except ValueError:
        app = firebase_admin.initialize_app(
            options={
                'projectId': os.getenv('GOOGLE_CLOUD_PROJECT', 'alert-disaster-field-2026'),
                'httpTimeout': LOGIN_HTTP_SECONDS,
            },
            name='adr-owner-login',
        )
    client = firebase_auth.Client(app)
    # The SDK exposes no retry option, so this client's own session adapters stop retrying.
    for adapter in client._user_manager.http_client.session.adapters.values():
        adapter.max_retries = adapter.max_retries.new(total=0)
    return client


def set_temporary_password(user, email, password):
    """Creates the email/password account, or sets the password on an existing one, verified because the
    superadmin vouches for the address. Changing a password ends the account's other sessions."""
    client = login_client()
    if user is None:
        try:
            # Unverified until the claim is set, so a failed second step leaves a login that can do nothing.
            user = client.create_user(email=email, email_verified=False, password=password)
        except firebase_auth.EmailAlreadyExistsError:
            raise Conflict('This email was registered moments ago. Try again.')
        client.update_user(user.uid, email_verified=True, custom_claims={PASSWORD_CHANGE: True})
    else:
        client.update_user(
            user.uid,
            password=password,
            email_verified=True,
            custom_claims={**(user.custom_claims or {}), PASSWORD_CHANGE: True},
        )
    return user.uid


def replace_temporary_password(uid, password):
    app = auth_app()
    claims = firebase_auth.get_user(uid, app=app).custom_claims or {}
    firebase_auth.update_user(
        uid,
        password=password,
        custom_claims={k: v for k, v in claims.items() if k != PASSWORD_CHANGE},
        app=app,
    )


def password_setup_link(email):
    """Create the invitee's account if needed so nobody else can pre-register the address. None means a Google account."""
    app = auth_app()
    try:
        user = firebase_auth.get_user_by_email(email, app=app)
    except firebase_auth.UserNotFoundError:
        try:
            user = firebase_auth.create_user(email=email, email_verified=False, app=app)
        except firebase_auth.EmailAlreadyExistsError:
            user = firebase_auth.get_user_by_email(email, app=app)
    if google_account(user):
        return None
    # The link is a credential: it goes only into the outgoing email, never Firestore or logs.
    return firebase_auth.generate_password_reset_link(
        email, firebase_auth.ActionCodeSettings(url=APP_URL, handle_code_in_app=False), app=app
    )


def invitation_logo(company):
    """The company's saved logo (already a capped JPEG from clean_logo), otherwise DryScope's."""
    match = re.fullmatch(
        r'data:image/(png|jpeg);base64,([A-Za-z0-9+/=]+)',
        company['profile'].get('logo_data_url') or '',
    )
    candidates = [(match[2], match[1])] if match else []
    for data, subtype in candidates + [(DRYSCOPE_LOGO, 'png')]:
        try:
            if isinstance(data, str):
                data = base64.b64decode(data, validate=True)
            if len(data) > 100000:
                continue
            with Image.open(io.BytesIO(data)) as image:
                width, height = image.size
            # Display box for the email header; width/height attributes keep Outlook from upscaling.
            scale = min(200 / width, 64 / height, 1)
            return dict(
                data=data,
                subtype=subtype,
                width=max(1, round(width * scale)),
                height=max(1, round(height * scale)),
            )
        except Exception:
            continue
    raise RuntimeError('The fallback invitation logo could not be read.')


def invitation_email(invite, company, setup):
    """Subject, text, HTML and inline logo of an invitation. setup is the set-password link, or None for Google."""
    link = APP_URL + '?invite=' + invite['invitation_id']
    name = company['profile']['name']
    role = {'owner': 'an owner', 'estimator': 'an estimator', 'office': 'office staff'}[
        invite['role']
    ]
    email = invite['email']
    logo = invitation_logo(company)
    subject = INVITATION_SUBJECT.format(company=name)
    invited = f'{name} has invited you to join their team on DryScope as {role}.'
    about = f'DryScope is what {name} uses for water and mold loss inspections, estimates and homeowner signatures.'
    ignore = "If you weren't expecting this, you can ignore this email."
    if setup:
        steps = [
            f'Set your password for DryScope: {setup}\nIf that link has expired, use Forgot password on the sign-in page.',
            f'Accept the invitation. Then sign in with {email} and that password.',
        ]
        steps_html = [
            f'<a href="{html.escape(setup)}" style="color:#0B2545;font-weight:bold;">Set your password for DryScope</a>.'
            ' If that link has expired, use Forgot password on the sign-in page.',
            f'Accept the invitation. Then sign in with <strong>{html.escape(email)}</strong> and that password.',
        ]
    else:
        steps = [f'Accept the invitation. Sign in with Google using this email ({email}).']
        steps_html = [
            f'Accept the invitation. Sign in with Google using this email (<strong>{html.escape(email)}</strong>).'
        ]
    numbered = len(steps) > 1
    text = '\n\n'.join(
        [
            invited,
            about,
            *[f'{i}. {step}' if numbered else step for i, step in enumerate(steps, 1)],
            f'Accept the invitation: {link}',
            'This invitation expires in seven days.',
            f'Sent by {name} through DryScope. {ignore}',
        ]
    )
    e = html.escape
    font = 'font-family:Lato,Arial,Helvetica,sans-serif;color:#212529;'
    step_rows = ''.join(
        f'<tr><td valign="top" style="{font}font-size:15px;line-height:22px;padding:0 10px 10px 0;font-weight:bold;color:#0B2545;">{i}.</td>'
        f'<td style="{font}font-size:15px;line-height:22px;padding:0 0 10px 0;">{step}</td></tr>'
        if numbered
        else f'<tr><td style="{font}font-size:15px;line-height:22px;padding:0 0 10px 0;">{step}</td></tr>'
        for i, step in enumerate(steps_html, 1)
    )
    page = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>{e(subject)}</title></head>
<body style="margin:0;padding:0;background:#f1f2f2;">
<div style="display:none;max-height:0;overflow:hidden;">{e(invited)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f1f2f2" style="background:#f1f2f2;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="max-width:560px;background:#ffffff;border:1px solid #dadddd;border-top:4px solid #0B2545;">
<tr><td style="padding:24px 24px 16px 24px;border-bottom:1px solid #dadddd;">
<img src="cid:{LOGO_CID}" width="{logo['width']}" height="{logo['height']}" alt="{e(name)} logo" style="display:block;border:0;outline:none;">
<div style="{font}font-size:18px;line-height:24px;font-weight:bold;padding-top:12px;">{e(name)}</div>
</td></tr>
<tr><td style="padding:24px;">
<h1 style="{font}font-size:22px;line-height:28px;margin:0 0 12px 0;">You're invited to join {e(name)}</h1>
<p style="{font}font-size:15px;line-height:22px;margin:0 0 12px 0;">{e(invited)}</p>
<p style="{font}font-size:15px;line-height:22px;margin:0 0 20px 0;color:#4b4b4b;">{e(about)}</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px 0;">{step_rows}</table>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 12px 0;"><tr><td bgcolor="#0B2545" style="background:#0B2545;border-radius:4px;">
<a href="{e(link)}" style="display:inline-block;padding:13px 28px;font-family:Lato,Arial,Helvetica,sans-serif;font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;">Accept invitation</a>
</td></tr></table>
<p style="{font}font-size:13px;line-height:20px;margin:0 0 16px 0;color:#4b4b4b;">Or open this link: <a href="{e(link)}" style="color:#0B2545;word-break:break-all;">{e(link)}</a></p>
<p style="{font}font-size:15px;line-height:22px;margin:0;">This invitation expires in seven days.</p>
</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #dadddd;background:#f7f7f7;" bgcolor="#f7f7f7">
<p style="{font}font-size:13px;line-height:20px;margin:0;color:#4b4b4b;">Sent by {e(name)} through DryScope. {e(ignore)}</p>
</td></tr>
</table>
</td></tr></table>
</body></html>"""
    return dict(subject=subject, text=text, html=page, logo=logo)


def send_invitation(invite, company):
    """Send through the transport INVITATION_TRANSPORT selects: 'resend' (default) or 'smtp' (Gmail app password)."""
    transport = os.getenv('INVITATION_TRANSPORT') or 'resend'
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
    deadline = time.monotonic() + SMTP_DEADLINE
    message = invitation_email(invite, company, password_setup_link(invite['email']))
    logo = message['logo']
    payload = {
        'from': sender,
        'to': [invite['email']],
        'subject': message['subject'],
        'text': message['text'],
        'html': message['html'],
        # Resend's inline image: the HTML refers to it as cid:<content_id>.
        'attachments': [
            {
                'content': base64.b64encode(logo['data']).decode(),
                'filename': 'logo.' + logo['subtype'].replace('jpeg', 'jpg'),
                'content_type': 'image/' + logo['subtype'],
                'content_id': LOGO_CID,
            }
        ],
    }
    if transport == 'smtp':
        return send_smtp(payload, username, password, invite, deadline)
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


def send_smtp(payload, username, password, invite, deadline):
    """Gmail SMTP has no idempotency key; the Message-ID is stable per attempt but Gmail does not deduplicate on it."""
    message = EmailMessage()
    message['From'] = payload['from']
    message['To'] = ', '.join(payload['to'])
    message['Subject'] = payload['subject']
    domain = parseaddr(payload['from'])[1].rpartition('@')[2] or 'dryscope.invalid'
    message['Message-ID'] = (
        f'<invitation-{invite["invitation_id"]}-{invite["send_attempt"]}@{domain}>'
    )
    message.set_content(payload['text'])
    message.add_alternative(payload['html'], subtype='html')
    # multipart/alternative [text, multipart/related [html, inline logo]] so Gmail and Outlook show it.
    page = message.get_payload()[1]
    for item in payload['attachments']:
        page.add_related(
            base64.b64decode(item['content']),
            'image',
            item['content_type'].partition('/')[2],
            cid='<' + item['content_id'] + '>',
            filename=item['filename'],
            disposition='inline',
        )
    if time.monotonic() >= deadline:
        raise TimeoutError('Invitation email deadline passed.')
    for attempt in range(3):
        try:
            server = smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=min(8, deadline - time.monotonic()))
            watchdog = threading.Timer(deadline - time.monotonic(), stop_smtp, (server,))
            watchdog.start()
            try:
                server.starttls(context=ssl.create_default_context())
                server.login(username, password)
                server.send_message(message)
            finally:
                watchdog.cancel()
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
        if time.monotonic() + 2 ** (attempt + 1) >= deadline:
            raise TimeoutError('Invitation email deadline passed.')
        time.sleep(2 ** (attempt + 1))


def stop_smtp(server):
    try:
        socket.socket.shutdown(server.sock, socket.SHUT_RDWR)
    except (TypeError, OSError):
        pass
