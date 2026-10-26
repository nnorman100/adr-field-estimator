"""Authenticated inspection, evidence, claims and Gemini Live endpoints."""

import asyncio
import anyio
import base64
import hashlib
import io
import ipaddress
import json
import logging
import os
import re
import time
from datetime import timedelta, timezone
from uuid import uuid4
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from contextlib import suppress, AsyncExitStack
from functools import partial, wraps
from typing import Optional
from fastapi import (
    FastAPI,
    Depends,
    HTTPException,
    Path,
    Query,
    Request,
    Response,
    Security,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.concurrency import run_in_threadpool
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials, SecurityScopes
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from starlette.datastructures import Headers, MutableHeaders
from starlette.requests import ClientDisconnect
from PIL import Image, ImageOps
import firebase_admin
from firebase_admin import app_check, auth as firebase_auth
from google import genai
from google.genai import types
from websockets.exceptions import ConnectionClosed

try:
    from .contracts import (
        CopyRequest,
        ExtraQuote,
        ExtraApprove,
        CreateInspection,
        UpdateInspection,
        ClaimDetails,
        InspectionData,
        PhotoUpload,
        PhotoRoomUpdate,
        PhotoShotUpdate,
        OcrResult,
        AIResult,
        AuditRequest,
        AuthorizeRequest,
        SigningLinkRequest,
        HomeownerSignature,
        VoiceNoteUpload,
        VoiceNoteId,
        TranscriptionResult,
        ReadingUpload,
        QrTagRequest,
    )
    from . import places, signing_links, ai_features
    from .delivery import Deliveries
    from . import document_links
    from . import tags as qr_tags
    from .claims import make_documents, price_scope, proposal_date
    from .sizing import equipment_sizing
    from .prompts import (
        live_prompt,
        audit_prompt,
        OCR_INSTRUCTIONS,
        TRANSCRIBE_INSTRUCTIONS,
        GREETING_TRIGGER,
        SHOT_STATUS_UPDATE,
        READINESS_UPDATE,
        shot_status_json,
    )
    from .live_support import (
        live_config,
        scope_fingerprint,
        is_speech,
        LiveCounters,
        AUDIO_ACK_EVERY,
    )
    from .company_store import CompanyInspectionStore
    from .delivery import DOCUMENT_ORIGINS, deliver_signed_adjuster, deliver_homeowner
    from .workspaces import AccessDenied, PASSWORD_CHANGE, PASSWORD_CHANGE_REQUIRED
    from .workspace_api import failure_for, register_workspace_routes
    from .price_book_api import register_price_book_routes
    from .price_book_store import Expired
    from .price_books import price_books_enabled, saved_basis
    from .scope import ScopeSuggestions, validate_suggestions, scope_prompt, scope_response_schema
    from .inspection_store import (
        InspectionStore,
        Conflict,
        Limited,
        TRANSCRIPT_LIMIT,
        voice_notes_clear,
    )
    from .job_store import BUCKET, decode_image, IMAGE_WORKER
    from .cloud_log import event
except ImportError:
    from contracts import (
        CopyRequest,
        ExtraQuote,
        ExtraApprove,
        CreateInspection,
        UpdateInspection,
        ClaimDetails,
        InspectionData,
        PhotoUpload,
        PhotoRoomUpdate,
        PhotoShotUpdate,
        OcrResult,
        AIResult,
        AuditRequest,
        AuthorizeRequest,
        SigningLinkRequest,
        HomeownerSignature,
        VoiceNoteUpload,
        VoiceNoteId,
        TranscriptionResult,
        ReadingUpload,
        QrTagRequest,
    )
    import places
    import ai_features
    import signing_links
    from delivery import Deliveries
    import document_links
    import tags as qr_tags
    from claims import make_documents, price_scope, proposal_date
    from sizing import equipment_sizing
    from prompts import (
        live_prompt,
        audit_prompt,
        OCR_INSTRUCTIONS,
        TRANSCRIBE_INSTRUCTIONS,
        GREETING_TRIGGER,
        SHOT_STATUS_UPDATE,
        READINESS_UPDATE,
        shot_status_json,
    )
    from live_support import (
        live_config,
        scope_fingerprint,
        is_speech,
        LiveCounters,
        AUDIO_ACK_EVERY,
    )
    from company_store import CompanyInspectionStore
    from delivery import DOCUMENT_ORIGINS, deliver_signed_adjuster, deliver_homeowner
    from workspaces import AccessDenied, PASSWORD_CHANGE, PASSWORD_CHANGE_REQUIRED
    from workspace_api import failure_for, register_workspace_routes
    from price_book_api import register_price_book_routes
    from price_book_store import Expired
    from price_books import price_books_enabled, saved_basis
    from scope import ScopeSuggestions, validate_suggestions, scope_prompt, scope_response_schema
    from inspection_store import (
        InspectionStore,
        Conflict,
        Limited,
        TRANSCRIPT_LIMIT,
        voice_notes_clear,
    )
    from job_store import BUCKET, decode_image, IMAGE_WORKER
    from cloud_log import event

DEDICATED_PROJECT_ID = 'alert-disaster-field-2026'
PROJECT_ID = os.getenv('GOOGLE_CLOUD_PROJECT', DEDICATED_PROJECT_ID)
if PROJECT_ID != DEDICATED_PROJECT_ID:
    raise RuntimeError('This service must use its dedicated alert-disaster-field-2026 project.')
LOCATION = os.getenv('GOOGLE_CLOUD_LOCATION', 'global')
AUDIT_MODEL = os.getenv('AUDIT_MODEL', 'gemini-3.8-flash')
OCR_MODEL = os.getenv('OCR_MODEL', AUDIT_MODEL)
# gemini-3.8-flash at its default thinking level occasionally spends 10,000+ thought tokens on a
# scope extraction and passes the 55-second REST deadline. A 4096-token thinking budget still let
# 3 of 4 staged scope calls reach the deadline on 2026-10-13. With the LOW thinking level, 10 calls
# on the staged check's synthetic job took at most 4.5 seconds (median 2.6 s), with valid
# suggestions. OCR calls never approached the deadline, so they keep the provider default.
SCOPE_THINKING_LEVEL = types.ThinkingLevel.LOW
AUDIT_THINKING_LEVEL = types.ThinkingLevel.LOW
REST_DEADLINE_SECONDS = 55
# Thinking is not what stalls audits: 2 of 7 production audits on 2026-10-15 reached the deadline,
# and in 17 real-Vertex audits with LOW thinking (no thought tokens) 15 took at most 21.6 s while
# provider stalls held two for 49 s and 82 s. A first attempt still running at 25 s is cancelled
# and retried once with the rest of the deadline, keeping 5 s to price and save the documents.
AUDIT_ATTEMPT_SECONDS = 25
AUDIT_RETRY_MIN_SECONDS = 10
AUDIT_SAVE_RESERVE_SECONDS = 5
LIVE_MODEL = os.getenv('LIVE_MODEL', 'gemini-3.8-live')
LIVE_LOCATION = os.getenv('LIVE_LOCATION', 'us-central1')
LIVE_RECHECK_SECONDS = 20
# How long a shot update waits for an expected reply that has not started speaking yet.
LIVE_REPLY_WAIT_SECONDS = 5
LIVE_VOICE = os.getenv('LIVE_VOICE', 'Charon')
LIVE_URL = 'wss://alert-disaster-field-estimator-545776254070.us-west2.run.app/api/live'
ORIGINS = list(DOCUMENT_ORIGINS)

WORKSPACES_ENABLED = os.getenv('WORKSPACES_ENABLED', 'false').lower() == 'true'
STAFF_EMAILS = {
    e.strip().lower()
    for e in os.getenv('STAFF_EMAILS', 'nathanaelcnorman@gmail.com').split(',')
    if e.strip()
}
WORKSPACE_SIGN_IN_PROVIDERS = frozenset({'google.com', 'password'})
# Step one of the App Check rollout only records each request's token; see docs/app-check.md.
APPCHECK_MODE = os.getenv('APPCHECK_MODE', 'monitor')
if APPCHECK_MODE not in ('off', 'monitor'):
    raise RuntimeError(
        'APPCHECK_MODE must be off or monitor; App Check enforcement is not available in this release.'
    )
APPCHECK_SECONDS = 2
APPCHECK_TOKEN_LIMIT = 4096
# Its own two threads, so a slow signing-key fetch can never hold the request threadpool.
APPCHECK_WORKER = ThreadPoolExecutor(max_workers=2, thread_name_prefix='app-check')
# A passed revoked/disabled-user lookup is reused for the same ID token for at most this long; see docs/firebase-isolation.md.
REVOCATION_CACHE_SECONDS = float(os.getenv('REVOCATION_CACHE_SECONDS', '45'))
if not 0 <= REVOCATION_CACHE_SECONDS <= 60:
    raise RuntimeError('REVOCATION_CACHE_SECONDS must be between 0 and 60.')
REVOCATION_CACHE_LIMIT = 1024
# Routes declaring this scope always repeat the lookup: signing, evidence, and company administration or access changes.
LIVE_REVOCATION = ['revocation:live']


def read_source_commit(
    path=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'SOURCE_COMMIT'),
):
    # scripts/deploy_backend.py writes the deployed commit into the build context; local runs have no stamp.
    try:
        with open(path, encoding='utf8') as stamp:
            value = stamp.read().strip()
    except OSError:
        return 'unknown'
    return value if re.fullmatch(r'[0-9a-f]{40}(?:-dirty)?', value) else 'unknown'


SOURCE_COMMIT = read_source_commit()
app = FastAPI(title='DryScope', version='2.0')
app.add_middleware(
    CORSMiddleware,
    allow_origins=ORIGINS,
    allow_credentials=False,
    allow_methods=['GET', 'POST', 'PUT'],
    allow_headers=[
        'Authorization',
        'Content-Type',
        'X-ADR-Workspace-Protocol',
        'X-Firebase-AppCheck',
    ],
)
security = HTTPBearer(auto_error=False)


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, error: RequestValidationError):
    # FastAPI's default echoes the submitted value, for a missing field the whole body, and a
    # body can carry a temporary password; the message and location are enough.
    return JSONResponse(
        {
            'detail': jsonable_encoder(
                [{k: v for k, v in e.items() if k != 'input'} for e in error.errors()]
            )
        },
        status_code=422,
    )


_job_store = None
genai_client = None


def get_job_store():
    global _job_store
    if _job_store is None:
        _job_store = CompanyInspectionStore() if WORKSPACES_ENABLED else InspectionStore()
    return _job_store


def get_ai_client():
    global genai_client
    if genai_client is None:
        genai_client = genai.Client(
            enterprise=True,
            project=PROJECT_ID,
            location=LOCATION,
            http_options=types.HttpOptions(timeout=95000),
        )
    return genai_client


def admin_app():
    try:
        return firebase_admin.get_app('adr')
    except ValueError:
        return firebase_admin.initialize_app(options={'projectId': PROJECT_ID}, name='adr')


# SHA-256 digests of ID tokens, never the tokens, mapped to when their passed revocation lookup lapses.
revocation_checked = OrderedDict()


async def verify_identity(token, live=False):
    """Verifies signature and expiry every call; reuses a recent revocation lookup unless live."""
    if not isinstance(token, str):
        raise HTTPException(401, 'Your sign-in expired. Please sign in again.')
    key = hashlib.sha256(token.encode()).digest()
    now = time.time()
    reuse = not live and revocation_checked.get(key, 0) > now
    try:
        claims = await run_in_threadpool(
            firebase_auth.verify_id_token, token, app=admin_app(), check_revoked=not reuse
        )
    except Exception:
        revocation_checked.pop(key, None)
        raise HTTPException(401, 'Your sign-in expired. Please sign in again.')
    if not reuse:
        # Never beyond the token's own expiry; the oldest entries go first once the cache is full.
        revocation_checked.pop(key, None)
        until = min(now + REVOCATION_CACHE_SECONDS, claims.get('exp', 0))
        if until > now:
            revocation_checked[key] = until
        while len(revocation_checked) > REVOCATION_CACHE_LIMIT:
            revocation_checked.popitem(last=False)
    if not claims.get('email_verified') or not claims.get('email'):
        raise HTTPException(
            403, 'A verified email address is required. Verify your email, then sign in again.'
        )
    if (
        WORKSPACES_ENABLED
        and claims.get('firebase', {}).get('sign_in_provider') not in WORKSPACE_SIGN_IN_PROVIDERS
    ):
        raise HTTPException(403, 'Sign in with Google or a verified email and password.')
    return claims


def unlocked(claims):
    """The claim refuses even without a membership marker, such as after a failed membership step."""
    if claims.get(PASSWORD_CHANGE):
        raise HTTPException(403, PASSWORD_CHANGE_REQUIRED)
    return claims


async def app_check_outcome(token):
    """Classifies a request's App Check token; monitor mode records the result and never rejects on it."""
    if not token:
        return 'missing'
    if not isinstance(token, str) or len(token) > APPCHECK_TOKEN_LIMIT:
        return 'invalid'
    try:
        # The Admin SDK verifies locally against signing keys it caches for six hours.
        verify = partial(app_check.verify_token, token, app=admin_app())
        await asyncio.wait_for(
            asyncio.get_running_loop().run_in_executor(APPCHECK_WORKER, verify), APPCHECK_SECONDS
        )
        return 'valid'
    except (asyncio.TimeoutError, TimeoutError):
        return 'unverified'
    except Exception:
        return 'invalid'


def record_app_check(outcome, method, route, status=None):
    event('App Check', outcome=outcome, method=method, route=route, status=status)


async def verify_staff(token, live=False):
    claims = await verify_identity(token, live)
    if WORKSPACES_ENABLED:
        unlocked(claims)
        actor = await stored(get_job_store().workspaces.principal, claims['uid'])
        if actor['password_change_required']:
            raise HTTPException(403, PASSWORD_CHANGE_REQUIRED)
        if not actor['role'] and not actor['superadmin']:
            raise HTTPException(403, 'Accept a company invitation before using this app.')
    elif claims.get('email', '').lower() not in STAFF_EMAILS:
        raise HTTPException(403, 'Your account has not been approved for this app.')
    return claims


async def current_staff(
    scopes: SecurityScopes, credentials: Optional[HTTPAuthorizationCredentials] = Depends(security)
):
    if not credentials or credentials.scheme.lower() != 'bearer':
        raise HTTPException(401, 'Sign in to continue.')
    return await verify_staff(credentials.credentials, live=LIVE_REVOCATION[0] in scopes.scopes)


MB = 1024 * 1024
# Sized to the contracts: an 8 MB photo or 10 MB voice note as base64, a 3 MB signature PNG, a 1.4 MB company logo.
BODY_LIMITS = [
    ('POST', re.compile(r'/api/inspections/[^/]+/photos'), 13 * MB),
    ('POST', re.compile(r'/api/inspections/[^/]+/voice-notes'), 14 * MB),
    ('POST', re.compile(r'/api/authorize'), int(3.5 * MB)),
    ('POST', re.compile(r'/api/sign'), int(3.5 * MB)),
    ('PUT', re.compile(r'/api/companies/[^/]+'), 2 * MB),
    # One fixed-template workbook plus the multipart reason fields. The parser caps the file itself.
    ('POST', re.compile(r'/api/companies/[^/]+/prices/import-preview'), MB + 64 * 1024),
]
BODY_READ_SECONDS = 50  # Below Firebase Hosting's 60-second request timeout.


def body_limit(method, path):
    return next(
        (limit for m, pattern, limit in BODY_LIMITS if m == method and pattern.fullmatch(path)), MB
    )


def has_bearer(headers):
    scheme, _, token = headers.get('authorization', '').partition(' ')
    return scheme.lower() == 'bearer' and bool(token.strip())


def replay(body, receive):
    """Delivers a pre-read body as one ASGI message, then defers to the server, which reports disconnects."""
    pending = True

    async def replayed():
        nonlocal pending
        if not pending:
            return await receive()
        pending = False
        return {'type': 'http.request', 'body': body, 'more_body': False}

    return replayed


class LimitPayload:
    """Caps and times each POST/PUT body read before the app runs, using only the ASGI receive channel."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        method, path = scope['method'], scope['path']
        if method in ('POST', 'PUT'):
            headers = Headers(scope=scope)
            # Reject before reading the body; current_staff still verifies the token. A homeowner
            # signing-link submission carries its own credential header instead.
            if path.startswith('/api/') and path != '/api/sign' and not has_bearer(headers):
                return await JSONResponse({'detail': 'Sign in to continue.'}, status_code=401)(
                    scope, receive, send
                )
            limit = body_limit(method, path)
            declared = headers.get('content-length')
            if declared is not None:
                if not re.fullmatch(r'[0-9]+', declared):
                    return await Response('Invalid Content-Length.', status_code=400)(
                        scope, receive, send
                    )
                if int(declared) > limit:
                    return await Response('The upload is too large.', status_code=413)(
                        scope, receive, send
                    )

            # Bound reads before model parsing, including requests without Content-Length.
            async def read():
                chunks = []
                size = 0
                while True:
                    message = await receive()
                    if message['type'] == 'http.disconnect':
                        raise ClientDisconnect()
                    chunk = message.get('body', b'')
                    size += len(chunk)
                    if size > limit:
                        return None
                    chunks.append(chunk)
                    if not message.get('more_body', False):
                        return b''.join(chunks)

            try:
                body = await asyncio.wait_for(read(), BODY_READ_SECONDS)
            except asyncio.TimeoutError:
                return await Response('The upload took too long.', status_code=408)(
                    scope, receive, send
                )
            if body is None:
                return await Response('The upload is too large.', status_code=413)(
                    scope, receive, send
                )
            receive = replay(body, receive)
        if path.startswith('/api/'):
            downstream = send

            async def no_store(message):
                if message['type'] == 'http.response.start':
                    MutableHeaders(scope=message)['Cache-Control'] = 'private, no-store'
                await downstream(message)

            send = no_store
        await self.app(scope, receive, send)


app.add_middleware(LimitPayload)


@app.middleware('http')
async def monitor_app_check(request: Request, call_next):
    # Registered after LimitPayload, so it also records requests that middleware rejects.
    if APPCHECK_MODE == 'off' or not request.url.path.startswith('/api/'):
        return await call_next(request)
    verification = asyncio.create_task(
        app_check_outcome(request.headers.get('x-firebase-appcheck'))
    )
    status = None
    try:
        response = await call_next(request)
        status = response.status_code
        return response
    finally:
        # The route template, never the concrete path, so inspection and photo IDs stay out of this line.
        record_app_check(
            await verification,
            request.method,
            getattr(request.scope.get('route'), 'path', None),
            status,
        )


STORED_FAILURE = 'Changes could not be saved. Your local draft can be retried.'


async def stored(method, *args, failure=None):
    """failure is the 503 message for an unexpected error (see failure_for); None is the generic one."""
    try:
        return await run_in_threadpool(method, *args)
    except Limited as error:
        raise HTTPException(429, str(error), headers={'Retry-After': str(error.retry_after)})
    except AccessDenied as error:
        raise HTTPException(403, str(error))
    except Conflict as error:
        raise HTTPException(409, str(error))
    except LookupError:
        raise HTTPException(404, 'Record not found.')
    except Expired as error:
        raise HTTPException(410, str(error))
    except ValueError as error:
        try:
            from .price_book_import import SizeLimit
        except ImportError:
            from price_book_import import SizeLimit
        if isinstance(error, SizeLimit):
            raise HTTPException(413, str(error))
        raise HTTPException(400, str(error))
    except Exception as error:
        event(
            'Storage operation failed',
            logging.ERROR,
            operation=getattr(method, '__name__', None),
            outcome=type(error).__name__,
        )
        raise HTTPException(503, failure or STORED_FAILURE)


NO_CLAIM = ClaimDetails().model_dump()


def require_voice_notes_clear(record):
    """Audit, scope fill and signing wait until every voice note is resolved or reviewed."""
    if not voice_notes_clear(record):
        raise HTTPException(
            409, 'Finish voice notes and review their transcripts before continuing.'
        )


def reusable_audit(record, revision, identity, customer, claim=None, price_basis=None):
    """The saved audit still matches this revision, company profile, customer, claim details and
    proposal date. An unresolved voice note makes the saved audit stale.

    The saved price basis must match the job pin. An audit without one is reusable only while
    the job has no pin.
    """
    if not voice_notes_clear(record):
        return False
    audit = record.get('audit')
    if not audit or audit['revision'] != revision:
        return False
    basis, pinned = saved_basis(audit) or {}, price_basis or {}
    if (basis.get('content_sha256'), basis.get('version_id')) != (
        pinned.get('content_sha256'),
        pinned.get('version_id'),
    ):
        return False
    saved, current = audit['documents'].get('company_identity') or {}, identity or {}
    proposal = audit['documents']['adr_estimate']
    return (
        (saved.get('company_id'), saved.get('version'))
        == (current.get('company_id'), current.get('version'))
        and proposal.get('customer_name', '') == customer
        # Audits saved before claim details match a job that has none recorded.
        and (audit['documents'].get('claim') or NO_CLAIM) == (claim or NO_CLAIM)
        and proposal['date'] == proposal_date()
    )


def public_record(record, *, readiness_state=None):
    result = {k: v for k, v in record.items() if k not in ('owner_uid', 'payload_sha256')}
    # An unsigned draft carries the equipment-sizing check for its saved data; it is derived on
    # every read, never stored, and a signed record keeps only what its documents printed.
    if 'data' in result and 'auth_id' not in result and result.get('status') != 'signed':
        try:
            data = InspectionData.model_validate(result['data'])
        except ValidationError:
            return result
        result['equipment_sizing'] = equipment_sizing(data)
        if ai_features.enabled('readiness') and readiness_state is not None:
            result['readiness'] = readiness_state
    return result


async def saved_readiness(store, uid, record):
    # Called only after the record's access check; recheck after sidecar reads as well.
    try:
        from .readiness import readiness
    except ImportError:
        from readiness import readiness
    log = await stored(store.drying_log, uid, record['inspection_id'])
    claim = await stored(store.workspaces.claim_details, record) if WORKSPACES_ENABLED else None
    await stored(store._access, uid, record)
    return readiness(record['data'], record.get('photos', []), claim, log['readings'])


async def draft_record(store, uid, record):
    state = None
    if (
        ai_features.enabled('readiness')
        and 'data' in record
        and 'auth_id' not in record
        and record.get('status') != 'signed'
    ):
        state = await saved_readiness(store, uid, record)
    return public_record(record, readiness_state=state)


def parse_json_from_llm(text):
    text = (text or '').strip()
    if text.startswith('```'):
        text = '\n'.join(text.splitlines()[1:])
        if text.rstrip().endswith('```'):
            text = text.rstrip()[:-3]
    return json.loads(text)


async def generate(
    schema,
    contents,
    model,
    operation,
    inspection_id,
    wire_schema=None,
    thinking_level=None,
    timeout=100,
    check=None,
    invalid_detail=None,
):
    started = time.monotonic()
    outcome = 'cancelled'
    error_fields = {}
    try:
        response = await asyncio.wait_for(
            get_ai_client().aio.models.generate_content(
                model=model,
                contents=contents,
                config=types.GenerateContentConfig(
                    response_mime_type='application/json',
                    response_schema=wire_schema or schema,
                    thinking_config=(
                        types.ThinkingConfig(thinking_level=thinking_level)
                        if thinking_level
                        else None
                    ),
                ),
            ),
            timeout=timeout,
        )
        result = schema.model_validate(parse_json_from_llm(response.text))
        if check is not None:
            # Domain rejection is logged with this call. The validator's message can quote the
            # technician; only the fixed detail is returned, and the log line has no text.
            try:
                checked = check(result)
            except (ValueError, ValidationError):
                outcome = 'validation'
                raise HTTPException(
                    502,
                    invalid_detail
                    or 'AI returned an unavailable or invalid result. Retry; no document or reading was verified.',
                )
            if checked is not None:
                result = checked
        outcome = 'ok'
        return result
    except HTTPException:
        raise
    except (asyncio.TimeoutError, TimeoutError):
        outcome = 'timeout'
        raise HTTPException(
            504, 'AI generation timed out. Retry; no document or reading was verified.'
        )
    except Exception as error:
        # Provider messages can echo the prompt; record only the class and status.
        outcome = type(error).__name__
        error_fields = dict(
            provider_status=getattr(error, 'status', None),
            provider_code=getattr(error, 'code', None),
        )
        raise HTTPException(
            502,
            'AI returned an unavailable or invalid result. Retry; no document or reading was verified.',
        )
    finally:
        event(
            'Vertex AI call',
            logging.INFO if outcome == 'ok' else logging.ERROR,
            model=model,
            operation=operation,
            elapsed_ms=round((time.monotonic() - started) * 1000),
            outcome=outcome,
            inspection_id=inspection_id,
            **error_fields,
        )


def rest_deadline(operation):
    @wraps(operation)
    async def bounded(*args, **kwargs):
        try:
            return await asyncio.wait_for(operation(*args, **kwargs), REST_DEADLINE_SECONDS)
        except asyncio.TimeoutError:
            raise HTTPException(
                504,
                'The request timed out. Your draft is preserved; retry. No document or reading was verified.',
            )

    return bounded


async def generate_audit(contents, inspection_id, started):
    # `started` is when the request's REST deadline began, so no attempt can outlast it. A timed-out
    # attempt is cancelled with its HTTP request and discarded; nothing is saved until one succeeds.
    end = started + REST_DEADLINE_SECONDS - AUDIT_SAVE_RESERVE_SECONDS
    remaining = end - time.monotonic()
    timeout = (
        AUDIT_ATTEMPT_SECONDS
        if remaining - AUDIT_ATTEMPT_SECONDS >= AUDIT_RETRY_MIN_SECONDS
        else remaining
    )
    for attempt in (1, 2):
        try:
            return await generate(
                AIResult,
                contents,
                AUDIT_MODEL,
                'audit',
                inspection_id,
                thinking_level=AUDIT_THINKING_LEVEL,
                timeout=timeout,
            )
        except HTTPException as error:
            timeout = end - time.monotonic()
            if error.status_code != 504 or attempt == 2 or timeout < AUDIT_RETRY_MIN_SECONDS:
                raise
            event(
                'Vertex AI retry',
                logging.WARNING,
                model=AUDIT_MODEL,
                operation='audit',
                elapsed_ms=round((time.monotonic() - started) * 1000),
                timeout_ms=round(timeout * 1000),
                inspection_id=inspection_id,
            )


def model_image(raw):
    with IMAGE_WORKER, Image.open(io.BytesIO(raw)) as image:
        # JPEG originals decode at the smallest power-of-two reduction that still fills the box.
        scale = max(image.size) / 1600
        if scale > 1:
            box = (max(1, int(image.width / scale)), max(1, int(image.height / scale)))
            image.draft('RGB', box)
        image = ImageOps.exif_transpose(image).convert('RGB')
        image.thumbnail((1600, 1600))
        output = io.BytesIO()
        image.save(output, format='JPEG', quality=85)
        return types.Part.from_bytes(data=output.getvalue(), mime_type='image/jpeg')


@app.get('/health')
@app.get('/api/health')
def health_check():
    # Anonymous callers learn liveness and the source commit only; configuration is staff-only below.
    return dict(status='healthy', schema_version=3, source_commit=SOURCE_COMMIT)


@app.get('/api/health/details')
def health_details(staff=Depends(current_staff)):
    return dict(
        status='healthy',
        service='alert-disaster-field-estimator',
        project=PROJECT_ID,
        location=LOCATION,
        database_project=PROJECT_ID,
        database='(default)',
        evidence_bucket=BUCKET,
        schema_version=3,
        audit_model=AUDIT_MODEL,
        ocr_model=OCR_MODEL,
        live_model=LIVE_MODEL,
        workspaces_enabled=WORKSPACES_ENABLED,
        source_commit=SOURCE_COMMIT,
    )


async def account_identity(
    scopes: SecurityScopes, credentials: Optional[HTTPAuthorizationCredentials] = Depends(security)
):
    """A verified identity without membership; only the temporary-password change uses it directly."""
    if not WORKSPACES_ENABLED:
        raise HTTPException(503, 'Company dashboards are not enabled yet.')
    if not credentials or credentials.scheme.lower() != 'bearer':
        raise HTTPException(401, 'Sign in to continue.')
    return await verify_identity(credentials.credentials, live=LIVE_REVOCATION[0] in scopes.scopes)


async def current_identity(
    scopes: SecurityScopes,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
    failure: Optional[str] = Depends(failure_for),
):
    claims = unlocked(await account_identity(scopes, credentials))
    await stored(get_job_store().workspaces.unlocked, claims['uid'], failure=failure)
    return claims


@app.get('/api/session')
async def session_info(staff=Depends(current_staff)):
    result = dict(
        uid=staff['uid'],
        email=staff['email'],
        project=PROJECT_ID,
        live_url=LIVE_URL,
        schema_version=3,
        live_protocol_version=2,
        live_voice=LIVE_VOICE,
        workspaces_enabled=WORKSPACES_ENABLED,
        workspace_protocol_version=1,
        ai_features=sorted(ai_features.AI_FEATURES),
        price_books_enabled=bool(WORKSPACES_ENABLED and price_books_enabled()),
    )
    if WORKSPACES_ENABLED:
        actor = await stored(get_job_store().workspaces.principal, staff['uid'])
        if actor['password_change_required']:
            raise HTTPException(403, PASSWORD_CHANGE_REQUIRED)
        result.update(actor)
        result['email_notice'] = actor['role'] == 'owner' and await stored(
            get_job_store().workspaces.email_notice
        )
    if ai_features.enabled('ai_usage'):
        try:
            result['quota'] = await stored(get_job_store().usage, staff['uid'])
        except HTTPException:
            result['quota'] = None
    return result


register_workspace_routes(
    app, current_identity, get_job_store, stored, LIVE_REVOCATION, account_identity
)
register_price_book_routes(app, current_identity, get_job_store, stored, LIVE_REVOCATION)


def workspace_client(request):
    if WORKSPACES_ENABLED and request.headers.get('X-ADR-Workspace-Protocol') != '1':
        raise HTTPException(
            409, 'Update the app before generating or opening company-branded documents.'
        )


def inspection_payload(data):
    result = data.model_dump(mode='json')
    if result.get('capture_metadata') is None:
        result.pop('capture_metadata', None)
    # Absent values stay absent so an older draft keeps its stored shape and the client's
    # acknowledged copy; a saved record never gains a key the technician did not set.
    if result.get('dehumidifier_ppd') is None:
        result.pop('dehumidifier_ppd', None)
    for room in result['rooms']:
        for key in (
            'loss',
            'floor_sf',
            'wet_floor_sf',
            'ceiling_height_ft',
            'water_class',
            'source_of_loss',
            'contents_present',
            'equipment_placed',
            'affected_surfaces',
            'wet_materials',
        ):
            if room.get(key) is None:
                room.pop(key, None)
    if not result.get('extras') and 'extras' not in data.model_fields_set:
        result.pop('extras', None)
    if not result.get('equipment_scans'):
        result.pop('equipment_scans', None)
    if result.get('coordinates') is None and 'coordinates' not in data.model_fields_set:
        result.pop('coordinates', None)
    return result


def extras_enabled():
    if not WORKSPACES_ENABLED or not ai_features.enabled('priced_extras'):
        raise HTTPException(404, 'Priced extras are not enabled.')


def check_extras_input(data):
    if data.extras:
        extras_enabled()


@app.post('/api/inspections/{inspection_id}/extras/quote')
async def quote_extra(
    inspection_id: str, req: ExtraQuote, staff=Depends(current_staff), store=Depends(get_job_store)
):
    extras_enabled()
    await stored(store.quota, staff['uid'], 'draft', 60)
    return await stored(store.quote_extra, staff['uid'], inspection_id, req.hours)


@app.post('/api/inspections/{inspection_id}/extras/{extra_id}/approve')
async def approve_extra(
    inspection_id: str,
    extra_id: str,
    req: ExtraApprove,
    staff=Security(current_staff, scopes=LIVE_REVOCATION),
    store=Depends(get_job_store),
):
    extras_enabled()
    await stored(store.quota, staff['uid'], 'draft', 60)
    record = await stored(store.approve_extra, staff['uid'], inspection_id, extra_id, req)
    return await draft_record(store, staff['uid'], record)


@app.post('/api/inspections')
async def create_inspection(
    req: CreateInspection, staff=Depends(current_staff), store=Depends(get_job_store)
):
    check_extras_input(req.data)
    await stored(store.quota, staff['uid'], 'draft', 60)
    return await draft_record(
        store,
        staff['uid'],
        await stored(
            store.create_inspection, staff['uid'], req.inspection_id, inspection_payload(req.data)
        ),
    )


@app.post('/api/authorizations/{auth_id}/copy')
async def copy_signed_job(
    auth_id: str, req: CopyRequest, staff=Depends(current_staff), store=Depends(get_job_store)
):
    await stored(store.quota, staff['uid'], 'draft', 60)
    data, copied_from = await stored(store.copy_source, staff['uid'], auth_id)
    return await draft_record(
        store,
        staff['uid'],
        await stored(
            store.create_inspection,
            staff['uid'],
            req.inspection_id,
            inspection_payload(data),
            copied_from,
        ),
    )


@app.get('/api/inspections')
async def list_inspections(
    cursor: Optional[str] = Query(default=None, max_length=80, pattern=r'^[A-Za-z0-9-]+$'),
    staff=Depends(current_staff),
    store=Depends(get_job_store),
):
    records, next_cursor = await stored(store.inspection_page, staff['uid'], cursor)
    return {'inspections': [inspection_summary(r) for r in records], 'next_cursor': next_cursor}


def listing_summary(record):
    # Company job pages attach the job's customer and claim; owner-less records have neither.
    listing = record.get('listing', {})
    return dict(
        customer_name=listing.get('customer_name', ''),
        claim_number=listing.get('claim_number', ''),
    )


def inspection_summary(record):
    return dict(
        inspection_id=record['inspection_id'],
        address=record['data']['address'],
        revision=record['revision'],
        status=record['status'],
        updated_at=record['updated_at'],
        **listing_summary(record),
    )


@app.get('/api/inspections/{inspection_id}')
async def get_inspection(
    inspection_id: str, request: Request, staff=Depends(current_staff), store=Depends(get_job_store)
):
    record = await stored(store.get_inspection, staff['uid'], inspection_id)
    if record.get('audit') and record['audit']['documents'].get('company_identity'):
        workspace_client(request)
    return await draft_record(store, staff['uid'], record)


@app.put('/api/inspections/{inspection_id}')
async def update_inspection(
    inspection_id: str,
    req: UpdateInspection,
    staff=Depends(current_staff),
    store=Depends(get_job_store),
):
    check_extras_input(req.data)
    await stored(store.quota, staff['uid'], 'draft', 60)
    return await draft_record(
        store,
        staff['uid'],
        await stored(
            store.update_inspection,
            staff['uid'],
            inspection_id,
            req.expected_revision,
            inspection_payload(req.data),
        ),
    )


@app.post('/api/inspections/{inspection_id}/photos')
async def upload_photo(
    inspection_id: str, req: PhotoUpload, staff=Depends(current_staff), store=Depends(get_job_store)
):
    await stored(store.quota, staff['uid'], 'draft', 60)
    record = await stored(store.add_photo, staff['uid'], inspection_id, req.model_dump(mode='json'))
    return await draft_record(store, staff['uid'], record)


@app.put('/api/inspections/{inspection_id}/photos/{photo_id}/room')
async def move_photo(
    inspection_id: str,
    photo_id: str,
    req: PhotoRoomUpdate,
    staff=Depends(current_staff),
    store=Depends(get_job_store),
):
    await stored(store.quota, staff['uid'], 'draft', 60)
    return await draft_record(
        store,
        staff['uid'],
        await stored(
            store.move_photo,
            staff['uid'],
            inspection_id,
            req.expected_revision,
            photo_id,
            req.room,
        ),
    )


# The drying log is a sidecar: readings never touch the priced revision, its audit or its
# signature, and a signed job keeps accepting monitoring-visit readings.
@app.get('/api/inspections/{inspection_id}/readings')
async def drying_log(
    inspection_id: str, staff=Depends(current_staff), store=Depends(get_job_store)
):
    return await stored(store.drying_log, staff['uid'], inspection_id)


@app.post('/api/inspections/{inspection_id}/readings')
async def add_reading(
    inspection_id: str,
    req: ReadingUpload,
    staff=Depends(current_staff),
    store=Depends(get_job_store),
):
    await stored(store.quota, staff['uid'], 'draft', 60)
    return await stored(
        store.add_reading,
        staff['uid'],
        staff.get('email', ''),
        inspection_id,
        req.reading.model_dump(mode='json'),
    )


@app.delete('/api/inspections/{inspection_id}/readings/{reading_id}')
async def remove_reading(
    inspection_id: str,
    reading_id: str = Path(max_length=32, pattern=r'^[a-f0-9]{32}$'),
    staff=Depends(current_staff),
    store=Depends(get_job_store),
):
    await stored(store.quota, staff['uid'], 'draft', 60)
    return await stored(store.remove_reading, staff['uid'], inspection_id, reading_id)


@app.put('/api/inspections/{inspection_id}/photos/{photo_id}/shot')
async def tag_photo_shot(
    inspection_id: str,
    photo_id: str,
    req: PhotoShotUpdate,
    staff=Depends(current_staff),
    store=Depends(get_job_store),
):
    await stored(store.quota, staff['uid'], 'draft', 60)
    return await draft_record(
        store,
        staff['uid'],
        await stored(
            store.tag_photo_shot,
            staff['uid'],
            inspection_id,
            req.expected_revision,
            photo_id,
            req.shot,
        ),
    )


@app.get('/api/inspections/{inspection_id}/photos/{photo_id}')
async def photo_evidence(
    inspection_id: str, photo_id: str, staff=Depends(current_staff), store=Depends(get_job_store)
):
    photo, raw = await stored(store.photo, staff['uid'], inspection_id, photo_id)
    return Response(
        raw,
        media_type=photo['file']['content_type'],
        headers={'Cache-Control': 'private, no-store'},
    )


@app.post('/api/inspections/{inspection_id}/photos/{photo_id}/ocr')
@rest_deadline
async def ocr_photo(
    inspection_id: str, photo_id: str, staff=Depends(current_staff), store=Depends(get_job_store)
):
    await stored(store.quota, staff['uid'], 'ocr', 20)
    record = await stored(store.get_inspection, staff['uid'], inspection_id)
    await stored(store._access, staff['uid'], record, 'ocr')
    photo, raw = await stored(store.photo, staff['uid'], inspection_id, photo_id)
    try:
        result = await generate(
            OcrResult,
            [await run_in_threadpool(model_image, raw), OCR_INSTRUCTIONS],
            OCR_MODEL,
            'ocr',
            inspection_id,
        )
    except (HTTPException, asyncio.CancelledError):
        await stored(store.set_ocr, staff['uid'], inspection_id, photo_id, None)
        raise
    return await draft_record(
        store,
        staff['uid'],
        await stored(
            store.set_ocr, staff['uid'], inspection_id, photo_id, result.model_dump(mode='json')
        ),
    )


@app.post('/api/ocr-meter')
async def legacy_ocr(staff=Depends(current_staff)):
    raise HTTPException(
        409, 'Update the app and attach the photo to an inspection before recognition.'
    )


@app.post('/api/inspections/{inspection_id}/scope-suggestions')
@rest_deadline
async def suggest_scope(
    inspection_id: str,
    req: AuditRequest,
    staff=Depends(current_staff),
    store=Depends(get_job_store),
):
    if req.inspection_id != inspection_id:
        raise HTTPException(400, 'Inspection references must match.')
    record = await stored(store.get_inspection, staff['uid'], inspection_id)
    if record['revision'] != req.expected_revision or record['status'] == 'signed':
        raise HTTPException(409, 'Restore the latest unsigned draft before filling scope.')
    await stored(store._access, staff['uid'], record, 'scope')
    require_voice_notes_clear(record)
    data = InspectionData.model_validate(record['data'])
    if not (data.technician_transcript.strip() or data.technician_notes.strip()):
        raise HTTPException(
            400, 'Record technician observations in the walkthrough or notes first.'
        )
    await stored(store.quota, staff['uid'], 'scope', 6)
    claim = await stored(store.workspaces.claim_details, record) if WORKSPACES_ENABLED else None

    def verified(suggestion):
        # Run inside the logged model call so a rejected quote is an ERROR, not INFO/ok.
        # The filtered suggestion is applied once, after this call returns.
        validate_suggestions(data, suggestion, claim)
        return None

    result = await generate(
        ScopeSuggestions,
        [scope_prompt(data, claim)],
        AUDIT_MODEL,
        'scope',
        inspection_id,
        wire_schema=scope_response_schema(),
        thinking_level=SCOPE_THINKING_LEVEL,
        check=verified,
        invalid_detail=(
            'Scope suggestions could not be verified. Clarify the recorded room, category and quantities, then retry.'
        ),
    )
    latest = await stored(store.get_inspection, staff['uid'], inspection_id)
    await stored(store._access, staff['uid'], latest, 'scope')
    require_voice_notes_clear(latest)
    if latest['revision'] != req.expected_revision or latest['status'] == 'signed':
        raise HTTPException(
            409,
            'The inspection changed while reading the walkthrough. Retry from the current draft.',
        )
    result = validate_suggestions(data, result, claim)
    return dict(
        inspection_id=inspection_id,
        revision=req.expected_revision,
        **result.model_dump(mode='json'),
    )


VOICE_NOTE_BYTES = 10 * MB
AUDIO_SIGNATURES = {
    'audio/mp4': lambda raw: raw[4:8] == b'ftyp',
    'audio/webm': lambda raw: raw.startswith(b'\x1a\x45\xdf\xa3'),
    'audio/ogg': lambda raw: raw.startswith(b'OggS'),
}


def voice_note_audio(req):
    try:
        raw = base64.b64decode(req.audio_base64, validate=True)
    except ValueError:
        raise HTTPException(400, 'The voice note could not be read. Record it again.')
    if not raw or len(raw) > VOICE_NOTE_BYTES:
        raise HTTPException(400, 'A voice note can be at most 10 MB. Record shorter notes.')
    if not AUDIO_SIGNATURES[req.mime_type](raw):
        raise HTTPException(400, 'The voice note does not match its audio type.')
    return raw


def voice_note_marker(note_id):
    return '[Offline voice note ' + note_id[:8]


def voice_note_block(req, text):
    """The transcript entry for one note, labeled as recorded offline and transcribed later."""
    local = req.recorded_at.astimezone(timezone(timedelta(minutes=req.utc_offset_minutes)))
    label = local.strftime('%b %d, %I:%M %p').replace(' 0', ' ')
    room = ' '.join(req.room.split()) or 'no room chosen'
    words = text.strip() or '(No speech recognized.)'
    return f'{voice_note_marker(req.note_id)} · {room} · recorded {label} · transcribed later]\n{words}\n'


async def revoke_moved_link(store, uid, inspection_id, moved):
    """A new voice note drops the job's signing link. A revoke failure still keeps the reservation."""
    if not moved:
        return
    with suppress(Exception):
        await stored(signing_links.revoke, store, uid, inspection_id)


async def _voice_note_ready(store, uid, inspection_id):
    record = await stored(store.get_inspection, uid, inspection_id)
    await stored(store._access, uid, record, 'scope')
    if record['status'] == 'signed':
        raise HTTPException(409, 'Signed inspections are immutable. Start a new inspection.')
    return record


@app.post('/api/inspections/{inspection_id}/voice-notes/pending')
@rest_deadline
async def reserve_voice_note(
    inspection_id: str,
    req: VoiceNoteId,
    staff=Depends(current_staff),
    store=Depends(get_job_store),
):
    """Reserves a note before capture or upload, invalidating the unsigned estimate."""
    await _voice_note_ready(store, staff['uid'], inspection_id)
    saved, moved = await stored(
        store.update_voice_note, staff['uid'], inspection_id, req.note_id, 'reserve'
    )
    await revoke_moved_link(store, staff['uid'], inspection_id, moved)
    return await draft_record(store, staff['uid'], saved)


def _checked_note_id(note_id):
    if not re.fullmatch(r'[a-f0-9]{32}', note_id):
        raise HTTPException(422, 'Voice note reference is not valid.')
    return note_id


@app.post('/api/inspections/{inspection_id}/voice-notes/{note_id}/review')
@rest_deadline
async def review_voice_note(
    inspection_id: str,
    note_id: str,
    staff=Depends(current_staff),
    store=Depends(get_job_store),
):
    """The technician has read the transcript of this note."""
    _checked_note_id(note_id)
    await _voice_note_ready(store, staff['uid'], inspection_id)
    saved, _moved = await stored(
        store.update_voice_note, staff['uid'], inspection_id, note_id, 'review'
    )
    return await draft_record(store, staff['uid'], saved)


@app.post('/api/inspections/{inspection_id}/voice-notes/{note_id}/resolve')
@rest_deadline
async def resolve_voice_note(
    inspection_id: str,
    note_id: str,
    staff=Depends(current_staff),
    store=Depends(get_job_store),
):
    """The technician typed the key facts and removed a note that could not be transcribed."""
    _checked_note_id(note_id)
    await _voice_note_ready(store, staff['uid'], inspection_id)
    saved, moved = await stored(
        store.update_voice_note, staff['uid'], inspection_id, note_id, 'resolve'
    )
    await revoke_moved_link(store, staff['uid'], inspection_id, moved)
    return await draft_record(store, staff['uid'], saved)


@app.post('/api/inspections/{inspection_id}/voice-notes')
@rest_deadline
async def transcribe_voice_note(
    inspection_id: str,
    req: VoiceNoteUpload,
    staff=Depends(current_staff),
    store=Depends(get_job_store),
):
    """Transcribes an offline voice note into the walkthrough transcript; the audio is not kept."""
    record = await _voice_note_ready(store, staff['uid'], inspection_id)
    marker = voice_note_marker(req.note_id)
    if marker in record['data'].get('technician_transcript', ''):
        return await draft_record(
            store,
            staff['uid'],
            await stored(
                store.append_transcript,
                staff['uid'],
                inspection_id,
                marker,
                '',
                req.note_id,
            ),
        )
    saved, moved = await stored(
        store.update_voice_note, staff['uid'], inspection_id, req.note_id, 'reserve'
    )
    await revoke_moved_link(store, staff['uid'], inspection_id, moved)

    async def fail():
        await stored(store.update_voice_note, staff['uid'], inspection_id, req.note_id, 'fail')

    try:
        raw = voice_note_audio(req)
    except HTTPException as error:
        if error.status_code == 400:
            await fail()
        raise
    transcript = saved['data'].get('technician_transcript', '')
    longest = voice_note_block(req, 'x' * min(20000, int(req.duration_seconds * 40) + 200))
    if len(transcript) + 1 + len(longest) > TRANSCRIPT_LIMIT:
        await fail()
        raise HTTPException(
            400, 'Transcript storage is full. Type the remaining observations in notes.'
        )
    # A quota 429 leaves the note pending so the phone can retry. A model failure marks it failed.
    await stored(store.quota, staff['uid'], 'transcribe', 10)
    try:
        result = await generate(
            TranscriptionResult,
            [types.Part.from_bytes(data=raw, mime_type=req.mime_type), TRANSCRIBE_INSTRUCTIONS],
            AUDIT_MODEL,
            'transcribe',
            inspection_id,
            thinking_level=SCOPE_THINKING_LEVEL,
            timeout=REST_DEADLINE_SECONDS - 5,
        )
    except HTTPException as error:
        if error.status_code != 429:
            await fail()
        raise
    return await draft_record(
        store,
        staff['uid'],
        await stored(
            store.append_transcript,
            staff['uid'],
            inspection_id,
            marker,
            voice_note_block(req, result.text),
            req.note_id,
        ),
    )


@app.post('/api/audit')
@rest_deadline
async def audit_inspection(
    req: AuditRequest, request: Request, staff=Depends(current_staff), store=Depends(get_job_store)
):
    started = time.monotonic()
    record = await stored(store.get_inspection, staff['uid'], req.inspection_id)
    await stored(store._access, staff['uid'], record, 'audit')
    # A note that is still open is not an audit attempt, so it does not use the audit quota.
    require_voice_notes_clear(record)
    await stored(store.quota, staff['uid'], 'audit', 3)
    workspace_client(request)
    if record['revision'] != req.expected_revision or record['status'] == 'signed':
        raise HTTPException(409, 'Restore the latest draft before auditing.')
    data = InspectionData.model_validate(record['data'])
    check_extras_input(data)
    if data.package_price is not None:
        raise HTTPException(
            409, 'Update the app and clear the old package-tier selection before auditing.'
        )
    if not data.scope_confirmed:
        raise HTTPException(
            400, 'Confirm room quantities, category, equipment, days and labor before auditing.'
        )
    if not data.address.strip() or data.year_built is None or not data.rooms:
        raise HTTPException(400, 'Enter the address, year built and rooms before auditing.')
    pin = None
    basis = None
    if WORKSPACES_ENABLED and price_books_enabled() and getattr(store, 'workspaces', None):
        pin = await stored(store.workspaces.prices.ensure_pin, staff['uid'], req.inspection_id)
        basis = await stored(store.workspaces.prices.basis_for, pin, pin['company_id'])
    items, total = price_scope(data, None if pin is None else pin['rates'])
    if total <= 0:
        raise HTTPException(400, 'Add measured work, equipment or charges before auditing.')
    deadline = time.monotonic() + 30
    while (
        any(p['ocr_status'] == 'pending' for p in record['photos']) and time.monotonic() < deadline
    ):
        await asyncio.sleep(0.5)
        record = await stored(store.get_inspection, staff['uid'], req.inspection_id)
        if record['data'] != inspection_payload(data):
            raise HTTPException(409, 'Inspection inputs changed while waiting for OCR.')
    # OCR may advance the revision; bind the resulting audit to that exact snapshot.
    require_voice_notes_clear(record)
    revision = record['revision']
    identity = await stored(store.workspaces.snapshot, staff['uid']) if WORKSPACES_ENABLED else None
    customer = await stored(store.workspaces.customer_name, record) if WORKSPACES_ENABLED else ''
    claim = await stored(store.workspaces.claim_details, record) if WORKSPACES_ENABLED else None
    if reusable_audit(record, revision, identity, customer, claim, basis):
        # Every input edit clears the audit, so a second Finish & review returns the saved result.
        return await draft_record(store, staff['uid'], record)
    prompt = audit_prompt(record['data'], record['photos'], items, identity)
    contents = [prompt]
    for photo in record['photos']:
        _, raw = await stored(store.photo, staff['uid'], req.inspection_id, photo['id'])
        contents.append(await run_in_threadpool(model_image, raw))
    ai = await generate_audit(contents, req.inspection_id, started)
    try:
        documents = make_documents(
            data,
            record['photos'],
            ai,
            identity,
            customer,
            claim,
            None if pin is None else pin['rates'],
            basis,
        )
    except (ValueError, ValidationError):
        raise HTTPException(
            400, 'The scope could not be priced. Review the inspection inputs and retry.'
        )
    saved = await stored(store.save_audit, staff['uid'], req.inspection_id, revision, documents)
    return await draft_record(store, staff['uid'], saved)


@app.post('/api/authorize')
async def authorize_estimate(
    request: Request,
    staff=Security(current_staff, scopes=LIVE_REVOCATION),
    store=Depends(get_job_store),
):
    workspace_client(request)
    try:
        body = await request.json()
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(422, 'Expected a signed-agreement object.')
    if not isinstance(body, dict):
        raise HTTPException(422, 'Expected a signed-agreement object.')
    await stored(store.quota, staff['uid'], 'authorize', 10)
    if 'inspection_id' not in body:
        # Historical agreements remain readable; old clients cannot create new agreements.
        existing = await stored(store.get, staff['uid'], str(body.get('auth_id', '')))
        if not existing:
            raise HTTPException(
                409, 'Update the app and complete a revision-bound audit before signing.'
            )
        defaults = {
            'auth_id': None,
            'timestamp': None,
            'address': None,
            'date': None,
            'proposed_cost': None,
            'findings': [],
            'recommendations': [],
            'xactimate_scope': [],
            'signature_png': None,
            'photos_count': 0,
            'photos': [],
            'inspection': {},
        }
        import hashlib

        from_json = {key: body.get(key, value) for key, value in defaults.items()}
        digest = hashlib.sha256(
            json.dumps(from_json, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
        ).hexdigest()
        if digest != existing.get('payload_sha256'):
            raise HTTPException(409, 'This reference already represents a different agreement.')
        record = existing
    else:
        try:
            req = AuthorizeRequest.model_validate(body)
        except ValidationError:
            raise HTTPException(
                422,
                'Signing requires the current inspection revision, proposal hash, document confirmation and PNG signature.',
            )
        # The checkbox is stored with the signature, not in the hashed agreement, so a client that
        # does not send it still retries an agreement it already saved.
        payload = req.model_dump(mode='json')
        choice = payload.pop('email_copy', None)
        record = await stored(
            store.authorize,
            staff['uid'],
            payload,
            None if choice is None else {'email_copy': choice},
        )
    await email_signed_copy(store, record, request)
    await stored(deliver_signed_adjuster, store, record, document_origin(request))
    return dict(
        status='success',
        auth_id=record['auth_id'],
        timestamp=record['created_at'],
        message='Signed agreement and private evidence saved.',
    )


async def email_signed_copy(store, record, request):
    """After the receipt is durable. A send failure is recorded on the delivery entry and the
    signature response still succeeds. Agreements signed before the checkbox are left alone."""
    if not WORKSPACES_ENABLED or not isinstance(record, dict) or 'email_copy' not in record:
        return
    origin = request.headers.get('origin')
    if origin not in ORIGINS:
        origin = ORIGINS[0]
    try:
        await run_in_threadpool(deliver_homeowner, store, record, origin)
    except Exception:
        event(
            'Delivery entry',
            operation='delivery',
            recipient_role='homeowner',
            status='failed',
        )


# A homeowner signing link's single credential; it never goes in Authorization or the URL path.
SIGNING_LINK_HEADER = 'X-ADR-Signing-Link'
# A read-only document link's single credential, carried the same way.
DOCUMENT_LINK_HEADER = 'X-ADR-Document-Link'
# Per client IP across the anonymous signing-link and document-link routes.
LINK_REQUESTS_PER_MINUTE = 120
# Google's front ends append to X-Forwarded-For rather than replace it
# (https://cloud.google.com/load-balancing/docs/https#x-forwarded-for_header). Behind the
# Hosting rewrite, Hosting appends the address it received the request from, then the Cloud Run
# front end appends Hosting's own address, so the client is this many entries from the right and
# every entry before it is client-supplied.
TRUSTED_FORWARDED_HOPS = 2


def document_origin(request):
    """A document link's site: the caller's origin when it is one of ours, otherwise the public site."""
    origin = request.headers.get('origin')
    return origin if origin in ORIGINS else ORIGINS[0]


def client_ip(request):
    """The entry Firebase Hosting appended to X-Forwarded-For; the peer only without the header."""
    forwarded = [hop.strip() for hop in request.headers.get('x-forwarded-for', '').split(',')]
    forwarded = [hop for hop in forwarded if hop]
    if not forwarded:
        candidate = getattr(request.client, 'host', '')
    elif len(forwarded) >= TRUSTED_FORWARDED_HOPS:
        candidate = forwarded[-TRUSTED_FORWARDED_HOPS]
    else:
        return None
    try:
        return str(ipaddress.ip_address(candidate))
    except ValueError:
        return None


async def anonymous_link(request, store, header):
    """The link token from its header, after the shared per-address limit for anonymous routes."""
    key = await stored(signing_links.address_key, store, client_ip(request) or 'unknown')
    await stored(
        store.quota, key, 'sign_link', LINK_REQUESTS_PER_MINUTE, signing_links.ADDRESS_LIMIT_SECONDS
    )
    return request.headers.get(header, '')


async def signing_link(request, store):
    return await anonymous_link(request, store, SIGNING_LINK_HEADER)


async def document_link(request, store):
    return await anonymous_link(request, store, DOCUMENT_LINK_HEADER)


async def linked(method, *args, unavailable=signing_links.UNAVAILABLE):
    """Unknown, expired, revoked and inaccessible links all answer with the same 404."""
    try:
        return await stored(method, *args)
    except HTTPException as error:
        if error.status_code in (403, 404):
            raise HTTPException(404, unavailable)
        raise


@app.post('/api/inspections/{inspection_id}/signing-links')
async def create_signing_link(
    inspection_id: str,
    req: SigningLinkRequest,
    request: Request,
    staff=Security(current_staff, scopes=LIVE_REVOCATION),
    store=Depends(get_job_store),
):
    await stored(store.quota, staff['uid'], 'link', 10)
    token, expires = await stored(
        signing_links.mint,
        store,
        staff['uid'],
        inspection_id,
        req.expected_revision,
        req.proposal_hash,
    )
    origin = request.headers.get('origin')
    # The fragment never reaches Hosting or Cloud Run logs, or a Referer header.
    url = (origin if origin in ORIGINS else ORIGINS[0]) + '/sign#' + token
    return dict(
        status='pending',
        url=url,
        qr_svg=await run_in_threadpool(signing_links.qr_data_url, url),
        expires_at=signing_links.iso(expires),
    )


@app.get('/api/inspections/{inspection_id}/signing-links')
async def signing_link_status(
    inspection_id: str, staff=Depends(current_staff), store=Depends(get_job_store)
):
    return await stored(signing_links.status, store, staff['uid'], inspection_id)


@app.post('/api/inspections/{inspection_id}/signing-links/revoke')
async def revoke_signing_link(
    inspection_id: str,
    staff=Security(current_staff, scopes=LIVE_REVOCATION),
    store=Depends(get_job_store),
):
    await stored(store.quota, staff['uid'], 'link', 10)
    return dict(status=await stored(signing_links.revoke, store, staff['uid'], inspection_id))


@app.post('/api/qr-tags')
async def qr_tag_sheet(
    req: QrTagRequest, staff=Depends(current_staff), store=Depends(get_job_store)
):
    """QR images for a printed sheet of room and equipment tags. Rendering is a server calculation
    over the tag codes alone; no inspection is read or changed."""
    await stored(store.quota, staff['uid'], 'tags', 30)
    try:
        tags = await run_in_threadpool(qr_tags.qr_tags, req.codes)
    except ValueError as error:
        raise HTTPException(422, str(error))
    return {'tags': tags}


async def place_lookup(store, staff, action, per_minute, call, *args):
    """Address suggestions, place details and the map share one gate: a member with the places
    capability, a configured key, then the per-user minute and daily caps. Neither the typed
    address nor the coordinates reach a log, and every provider failure reads the same."""
    await stored(store.places_access, staff['uid'])
    if not places.configured():
        raise HTTPException(503, 'Address suggestions are not set up.')
    await stored(store.quota, staff['uid'], action, per_minute)
    try:
        return await run_in_threadpool(call, *args)
    except places.ProviderError:
        raise HTTPException(502, 'Address lookup is unavailable. Type the address instead.')


# The typed address and the coordinates travel in POST bodies, never in a URL that request logs keep.
@app.post('/api/places/autocomplete')
async def place_suggestions(
    req: places.SuggestRequest, staff=Depends(current_staff), store=Depends(get_job_store)
):
    found = await place_lookup(
        store, staff, 'places_suggest', 30, places.suggest, req.input, req.session
    )
    return {'suggestions': found}


@app.post('/api/places/details')
async def place_details(
    req: places.DetailsRequest, staff=Depends(current_staff), store=Depends(get_job_store)
):
    return await place_lookup(
        store, staff, 'places_details', 10, places.details, req.place_id, req.session
    )


@app.post('/api/places/map')
async def place_map(
    req: places.MapRequest, staff=Depends(current_staff), store=Depends(get_job_store)
):
    image = await place_lookup(
        store, staff, 'places_map', 20, places.static_map, req.latitude, req.longitude
    )
    return Response(image, media_type='image/png', headers={'Cache-Control': 'private, no-store'})


@app.get('/api/sign')
async def signing_link_view(request: Request, store=Depends(get_job_store)):
    token = await signing_link(request, store)
    return await linked(signing_links.view, store, token)


@app.get('/api/sign/photos/{photo_id}')
async def signing_link_photo(photo_id: str, request: Request, store=Depends(get_job_store)):
    token = await signing_link(request, store)
    raw, media_type = await linked(signing_links.photo, store, token, photo_id)
    return Response(raw, media_type=media_type, headers={'Cache-Control': 'private, no-store'})


@app.get('/api/sign/signature')
async def signing_link_signature(request: Request, store=Depends(get_job_store)):
    token = await signing_link(request, store)
    raw, media_type = await linked(signing_links.signature, store, token)
    return Response(raw, media_type=media_type, headers={'Cache-Control': 'private, no-store'})


@app.post('/api/sign')
async def sign_with_link(request: Request, store=Depends(get_job_store)):
    token = await signing_link(request, store)
    try:
        req = HomeownerSignature.model_validate(await request.json())
    except (ValueError, UnicodeDecodeError, ValidationError):
        raise HTTPException(
            422, 'Signing requires your full name, your role, both confirmations and a signature.'
        )
    record = await linked(
        signing_links.sign,
        store,
        token,
        req.model_dump(mode='json'),
        dict(
            ip_address=client_ip(request),
            user_agent=request.headers.get('user-agent', '')[:512],
        ),
    )
    await email_signed_copy(store, record, request)
    await stored(deliver_signed_adjuster, store, record, document_origin(request))
    return dict(
        status='success',
        auth_id=record['auth_id'],
        timestamp=record['created_at'],
        message='Signed agreement saved.',
    )


# Read-only document links: one signed agreement, one document set, no signing. The homeowner
# and adjuster emails mint their own sets after signing; no route creates a link on request.
@app.get('/api/documents')
async def document_link_view(request: Request, store=Depends(get_job_store)):
    token = await document_link(request, store)
    return await linked(document_links.view, store, token, unavailable=document_links.UNAVAILABLE)


@app.get('/api/documents/photos/{photo_id}')
async def document_link_photo(photo_id: str, request: Request, store=Depends(get_job_store)):
    token = await document_link(request, store)
    raw, media_type = await linked(
        document_links.photo, store, token, photo_id, unavailable=document_links.UNAVAILABLE
    )
    return Response(raw, media_type=media_type, headers={'Cache-Control': 'private, no-store'})


@app.get('/api/documents/signature')
async def document_link_signature(request: Request, store=Depends(get_job_store)):
    token = await document_link(request, store)
    raw, media_type = await linked(
        document_links.signature, store, token, unavailable=document_links.UNAVAILABLE
    )
    return Response(raw, media_type=media_type, headers={'Cache-Control': 'private, no-store'})


@app.get('/api/authorizations')
async def list_authorizations(
    cursor: Optional[str] = Query(default=None, max_length=80, pattern=r'^[A-Za-z0-9-]+$'),
    staff=Depends(current_staff),
    store=Depends(get_job_store),
):
    records, next_cursor = await stored(store.authorization_page, staff['uid'], cursor)
    return {
        'authorizations': [authorization_summary(r) for r in records],
        'next_cursor': next_cursor,
    }


def authorization_summary(record):
    return {
        k: record.get(k)
        for k in (
            'auth_id',
            'address',
            'proposed_cost',
            'proposed_cost_low',
            'created_at',
            'photos_count',
            'schema_version',
        )
    } | listing_summary(record)


@app.get('/api/authorizations/{auth_id}')
async def get_authorization(
    auth_id: str, request: Request, staff=Depends(current_staff), store=Depends(get_job_store)
):
    record = await stored(store.get, staff['uid'], auth_id)
    if not record:
        raise HTTPException(404, 'Signed agreement not found.')
    if record.get('documents', {}).get('company_identity'):
        workspace_client(request)
    return await draft_record(store, staff['uid'], record)


@app.get('/api/authorizations/{auth_id}/evidence/{name}')
async def get_evidence(
    auth_id: str,
    name: str,
    staff=Security(current_staff, scopes=LIVE_REVOCATION),
    store=Depends(get_job_store),
):
    record = await stored(store.get, staff['uid'], auth_id)
    if not record:
        raise HTTPException(404, 'Evidence not found.')
    evidence = (
        await stored(store.evidence, record, name, staff['uid'])
        if WORKSPACES_ENABLED
        else await stored(store.evidence, record, name)
    )
    if not evidence:
        raise HTTPException(404, 'Evidence not found.')
    return Response(
        evidence[0], media_type=evidence[1], headers={'Cache-Control': 'private, no-store'}
    )


# Superadmin support view: read-only company records, each read audited before it returns.
# Only GET routes exist here; every write keeps its company-membership check.
support_identity = Security(current_identity, scopes=LIVE_REVOCATION)
page_cursor = Query(default=None, max_length=80, pattern=r'^[A-Za-z0-9-]+$')


@app.get('/api/admin/companies/{company_id}/jobs')
async def support_jobs(
    company_id: str,
    request: Request,
    cursor: Optional[str] = page_cursor,
    staff=support_identity,
    store=Depends(get_job_store),
):
    workspace_client(request)
    records, next_cursor = await stored(store.support_page, staff['uid'], company_id, False, cursor)
    return {'inspections': [inspection_summary(r) for r in records], 'next_cursor': next_cursor}


@app.get('/api/admin/companies/{company_id}/authorizations')
async def support_authorizations(
    company_id: str,
    request: Request,
    cursor: Optional[str] = page_cursor,
    staff=support_identity,
    store=Depends(get_job_store),
):
    workspace_client(request)
    records, next_cursor = await stored(store.support_page, staff['uid'], company_id, True, cursor)
    return {
        'authorizations': [authorization_summary(r) for r in records],
        'next_cursor': next_cursor,
    }


@app.get('/api/admin/companies/{company_id}/jobs/{inspection_id}')
async def support_job(
    company_id: str,
    inspection_id: str,
    request: Request,
    staff=support_identity,
    store=Depends(get_job_store),
):
    workspace_client(request)
    record, job = await stored(store.support_inspection, staff['uid'], company_id, inspection_id)
    return {'inspection': public_record(record), 'job': job}


@app.get('/api/admin/companies/{company_id}/jobs/{inspection_id}/photos/{photo_id}')
async def support_photo(
    company_id: str,
    inspection_id: str,
    photo_id: str,
    staff=support_identity,
    store=Depends(get_job_store),
):
    photo, raw = await stored(
        store.support_photo, staff['uid'], company_id, inspection_id, photo_id
    )
    return Response(
        raw,
        media_type=photo['file']['content_type'],
        headers={'Cache-Control': 'private, no-store'},
    )


@app.get('/api/admin/companies/{company_id}/authorizations/{auth_id}')
async def support_authorization(
    company_id: str,
    auth_id: str,
    request: Request,
    staff=support_identity,
    store=Depends(get_job_store),
):
    workspace_client(request)
    record, job, delivery = await stored(
        store.support_authorization, staff['uid'], company_id, auth_id
    )
    result = {'authorization': public_record(record), 'job': job, 'delivery': delivery}
    if ai_features.enabled('drying_watch') and (record.get('inspection') or {}).get('drying_days'):
        result['monitoring'] = await stored(
            store.workspaces.monitoring.view, staff['uid'], job['job_id'], company_id
        )
    return result


@app.get('/api/admin/companies/{company_id}/authorizations/{auth_id}/evidence/{name}')
async def support_evidence(
    company_id: str,
    auth_id: str,
    name: str,
    staff=support_identity,
    store=Depends(get_job_store),
):
    evidence = await stored(store.support_evidence, staff['uid'], company_id, auth_id, name)
    if not evidence:
        raise HTTPException(404, 'Evidence not found.')
    return Response(
        evidence[0], media_type=evidence[1], headers={'Cache-Control': 'private, no-store'}
    )


def live_provider_code(error):
    """Provider failure code for the Live alert, or None for an ordinary client rejection.

    ConnectionClosed uses the upstream close code, or 1006 when the socket dropped without one.
    HTTPException, ValueError and WebSocketDisconnect are client auth or input rejections and are
    not given a code, even if the object has one. A provider error keeps its own code. A provider
    timeout or connection error with no code is logged as 1006 so the alert filter can see it.
    """
    if isinstance(error, ConnectionClosed):
        return error.rcvd.code if error.rcvd else 1006
    if isinstance(error, (HTTPException, ValueError, WebSocketDisconnect)):
        return None
    code = getattr(error, 'code', None)
    if code is not None:
        return code
    if isinstance(error, (TimeoutError, ConnectionError, OSError)):
        return 1006
    try:
        from google.genai import errors as genai_errors
    except ImportError:
        genai_errors = None
    if genai_errors is not None and isinstance(error, genai_errors.APIError):
        return 1006
    return None


@app.websocket('/api/live')
async def live_walkthrough(socket: WebSocket):
    if socket.headers.get('origin') not in ORIGINS:
        await socket.close(code=1008)
        return
    await socket.accept()
    store = None
    lease = None
    uid = None
    client = None
    tasks = []
    capture = None
    retain = True
    fingerprint = None
    inspection_id = None
    protocol = 1
    started = time.monotonic()
    outcome = 'closed'
    status = None
    total_tokens = None
    provider_code = None
    counters = LiveCounters()
    try:
        packet = await asyncio.wait_for(socket.receive_text(), 10)
        if len(packet) > 16384:
            raise ValueError('Authentication packet too large.')
        auth = json.loads(packet)
        if auth.get('type') != 'authenticate':
            raise ValueError('Authenticate before streaming.')
        protocol = auth.get('protocol_version', 1)
        if protocol not in (1, 2):
            raise ValueError('Update the app to connect.')
        capture = auth.get('capture_id') if protocol == 2 else None
        if protocol == 2 and (not isinstance(capture, str) or len(capture) != 32):
            raise ValueError('Invalid capture identifier.')
        if APPCHECK_MODE == 'monitor':
            record_app_check(
                await app_check_outcome(auth.get('app_check')), 'WEBSOCKET', '/api/live'
            )
        token = auth.get('token', '')
        staff = await verify_staff(token, live=True)
        uid = staff['uid']
        store = get_job_store()
        inspection_id = auth.get('inspection_id', '')
        record = await stored(store.get_inspection, uid, inspection_id)
        await stored(store._access, uid, record, 'live')
        identity = await stored(store.workspaces.snapshot, uid) if WORKSPACES_ENABLED else None
        claim = await stored(store.workspaces.claim_details, record) if WORKSPACES_ENABLED else None
        if identity and auth.get('workspace_protocol_version') != 1:
            raise HTTPException(409, 'Update the app before a company walkthrough.')
        if record['status'] == 'signed':
            raise ValueError('Start a new inspection for live coaching.')
        fingerprint = scope_fingerprint(record['data'])
        for attempt in range(31):
            try:
                lease = await stored(store.live_lease, uid)
                break
            except HTTPException as error:
                if (
                    protocol != 2
                    or not auth.get('resume')
                    or error.status_code != 429
                    or attempt == 30
                ):
                    raise
                await asyncio.sleep(0.1)
        handle = None
        if capture:
            handle = await stored(
                store.live_resume, uid, capture, inspection_id, fingerprint, lease, 'open'
            )
            if not auth.get('resume', False):
                handle = None
                await stored(
                    store.live_resume,
                    uid,
                    capture,
                    inspection_id,
                    fingerprint,
                    lease,
                    'save',
                    None,
                    False,
                )
        # Only a saved checkpoint for this user, capture and scope makes a start free.
        if not handle:
            await stored(store.quota, uid, 'live')
        client = genai.Client(
            enterprise=True,
            project=PROJECT_ID,
            location=LIVE_LOCATION,
            http_options=types.HttpOptions(timeout=95000),
        )
        async with AsyncExitStack() as stack:
            config = live_config(
                live_prompt(
                    record['data'],
                    identity,
                    claim,
                    record['photos'],
                    readiness_state=(await saved_readiness(store, uid, record))
                    if ai_features.enabled('readiness')
                    else None,
                ),
                LIVE_VOICE,
                handle,
            )
            try:
                session = await stack.enter_async_context(
                    client.aio.live.connect(model=LIVE_MODEL, config=config)
                )
            except Exception:
                if not handle:
                    raise
                await stored(
                    store.live_resume,
                    uid,
                    capture,
                    inspection_id,
                    fingerprint,
                    lease,
                    'save',
                    None,
                    False,
                )
                handle = None
                session = await stack.enter_async_context(
                    client.aio.live.connect(
                        model=LIVE_MODEL,
                        config=live_config(
                            live_prompt(
                                record['data'],
                                identity,
                                claim,
                                record['photos'],
                                readiness_state=(await saved_readiness(store, uid, record))
                                if ai_features.enabled('readiness')
                                else None,
                            ),
                            LIVE_VOICE,
                        ),
                    )
                )
            connection = uuid4().hex
            sequence = 0
            pending = False
            finishing = False
            final_text = asyncio.Event()
            final_text.set()
            recovery = 'resumed' if handle else 'restarted' if auth.get('resume') else 'new'
            ready = {'type': 'ready', 'model': LIVE_MODEL}
            if protocol == 2:
                ready.update(
                    protocol_version=2,
                    connection_id=connection,
                    voice=LIVE_VOICE,
                    token_refresh=True,
                    shot_updates=True,
                    recovery=recovery,
                    audio_ack=AUDIO_ACK_EVERY,
                )
            await socket.send_json(ready)
            # Tagged photo changes reach the model as context between its replies, because
            # client content sent while it speaks would cut the reply off. A reply counts from when
            # one is expected, after the greeting or technician speech, until it ends.
            shots = {'wanted': False, 'speaking': False, 'expected': 0.0}
            shot_wake = asyncio.Event()

            def replying():
                return shots['speaking'] or time.monotonic() < shots['expected']

            async def shot_updates():
                sent_at = 0.0
                while True:
                    held = shots['expected'] - time.monotonic()
                    try:
                        await asyncio.wait_for(
                            shot_wake.wait(), held if shots['wanted'] and held > 0 else None
                        )
                    except asyncio.TimeoutError:
                        pass
                    shot_wake.clear()
                    await asyncio.sleep(max(0.0, sent_at + 1 - time.monotonic()))
                    if not shots['wanted'] or replying() or finishing:
                        continue
                    shots['wanted'] = False
                    # Read from the store, with the same access check, so only saved tags are reported.
                    current = await stored(store.get_inspection, uid, inspection_id)
                    await stored(store._access, uid, current, 'live')
                    if replying() or finishing:
                        shots['wanted'] = True
                        continue
                    status = shot_status_json(current['data'], current['photos'])
                    parts = [types.Part(text=SHOT_STATUS_UPDATE + status)]
                    if ai_features.enabled('readiness'):
                        state = await saved_readiness(store, uid, current)
                        parts.append(types.Part(text=READINESS_UPDATE + json.dumps(state)))
                    if replying() or finishing:
                        shots['wanted'] = True
                        continue
                    sent_at = time.monotonic()
                    await session.send_client_content(
                        turns=types.Content(role='user', parts=parts),
                        turn_complete=False,
                    )

            if recovery == 'new':
                # The Live API waits for input, so only a brand-new walkthrough asks the model to speak first.
                shots['expected'] = time.monotonic() + LIVE_REPLY_WAIT_SECONDS
                await session.send_client_content(
                    turns=types.Content(role='user', parts=[types.Part(text=GREETING_TRIGGER)]),
                    turn_complete=True,
                )

            async def upstream():
                nonlocal pending, finishing, retain, outcome, staff, token
                frame_at = 0
                second = 0
                count = 0
                while True:
                    raw = await socket.receive_text()
                    if len(raw) > 800000:
                        raise ValueError('Live packet too large.')
                    data = json.loads(raw)
                    kind = data.get('type')
                    moment = time.monotonic()
                    if int(moment) != second:
                        second = int(moment)
                        count = 0
                    count += 1
                    if count > 60:
                        raise ValueError('Live stream exceeded its message limit.')
                    if kind == 'audio':
                        audio = base64.b64decode(data['data'], validate=True)
                        if len(audio) > 64000 or len(audio) % 2:
                            raise ValueError('Invalid PCM audio.')
                        # The client streams the open microphone, so only speech can still be awaiting a transcript.
                        speech = is_speech(audio)
                        if speech:
                            pending = True
                            final_text.clear()
                        await session.send_realtime_input(
                            audio=types.Blob(data=audio, mime_type='audio/pcm;rate=16000')
                        )
                        counters.audio(len(audio), speech, moment)
                        seq = data.get('seq')
                        # Acknowledging after forwarding lets the client measure how far behind its audio is.
                        if (
                            protocol == 2
                            and type(seq) is int
                            and seq > 0
                            and seq % AUDIO_ACK_EVERY == 0
                        ):
                            await socket.send_json({'type': 'ack', 'seq': seq})
                    elif kind == 'video':
                        if moment - frame_at < 0.95:
                            continue
                        frame_at = moment
                        image = base64.b64decode(data['data'], validate=True)
                        if len(image) > 512000 or not image.startswith(b'\xff\xd8\xff'):
                            raise ValueError('Invalid JPEG frame.')
                        await session.send_realtime_input(
                            video=types.Blob(data=image, mime_type='image/jpeg')
                        )
                        counters.frames += 1
                    elif kind == 'pause' and protocol == 2:
                        counters.pause()
                        await session.send_realtime_input(audio_stream_end=True)
                    elif kind == 'shots' and protocol == 2:
                        shots['wanted'] = True
                        shot_wake.set()
                    elif kind == 'refresh':
                        # A renewed ID token extends the session only for the same verified user.
                        refreshed = await verify_staff(data.get('token', ''))
                        if refreshed['uid'] != uid:
                            retain = False
                            raise ValueError('Session owner changed.')
                        staff = refreshed
                        token = data['token']
                    elif kind == 'end':
                        outcome = 'finished'
                        counters.client_end(data)
                        retain = (
                            bool(data.get('preserve_resume', False)) if protocol == 2 else False
                        )
                        if protocol == 2:
                            finishing = True
                            await session.send_realtime_input(audio_stream_end=True)
                            try:
                                await asyncio.wait_for(final_text.wait(), 3)
                            except asyncio.TimeoutError:
                                pass
                            # The client stops waiting 3.5 s after End, so acknowledge before cleanup.
                            await socket.send_json({'type': 'finished', 'complete': not pending})
                        return
                    else:
                        raise ValueError('Unsupported live packet.')

            async def downstream():
                nonlocal sequence, pending, outcome, total_tokens
                while True:
                    async for response in session.receive():
                        update = getattr(response, 'session_resumption_update', None)
                        if update and capture:
                            await stored(
                                store.live_resume,
                                uid,
                                capture,
                                inspection_id,
                                fingerprint,
                                lease,
                                'save',
                                getattr(update, 'new_handle', None),
                                bool(getattr(update, 'resumable', False)),
                            )
                        usage = getattr(response, 'usage_metadata', None)
                        if usage:
                            total_tokens = getattr(usage, 'total_token_count', None) or total_tokens
                        if usage and protocol == 2:
                            await socket.send_json(
                                {
                                    'type': 'usage',
                                    'total_tokens': getattr(usage, 'total_token_count', None),
                                }
                            )
                        away = getattr(response, 'go_away', None)
                        content = getattr(response, 'server_content', None)
                        if content:
                            if content.interrupted:
                                shots['speaking'] = False
                                shots['expected'] = 0.0
                                counters.end_reply(interrupted=True)
                                await socket.send_json({'type': 'interrupted'})
                            for side, value in [
                                ('technician', content.input_transcription),
                                ('assistant', content.output_transcription),
                            ]:
                                if value and (value.text or getattr(value, 'finished', False)):
                                    if side == 'technician' and value.text:
                                        shots['expected'] = (
                                            time.monotonic() + LIVE_REPLY_WAIT_SECONDS
                                        )
                                    sequence += 1
                                    message = {
                                        'type': 'transcript',
                                        'speaker': side,
                                        'text': value.text or '',
                                    }
                                    if protocol == 2:
                                        message.update(
                                            connection_id=connection,
                                            sequence=sequence,
                                            finished=getattr(value, 'finished', None),
                                        )
                                    await socket.send_json(message)
                                    if side == 'technician' and getattr(value, 'finished', False):
                                        pending = False
                                        final_text.set()
                            if content.model_turn:
                                for part in content.model_turn.parts:
                                    if part.inline_data and part.inline_data.data:
                                        shots['speaking'] = True
                                        counters.model_audio(
                                            len(part.inline_data.data), time.monotonic()
                                        )
                                        if finishing:
                                            continue
                                        await socket.send_json(
                                            {
                                                'type': 'audio',
                                                'data': base64.b64encode(
                                                    part.inline_data.data
                                                ).decode(),
                                                'rate': 24000,
                                            }
                                        )
                            if content.turn_complete:
                                # Vertex Live never sets a transcription's finished flag, so a model turn that
                                # began after the last speech and completed proves that speech was heard.
                                if counters.end_reply():
                                    pending = False
                                    final_text.set()
                                await socket.send_json({'type': 'turn_complete'})
                                shots['speaking'] = False
                                shots['expected'] = 0.0
                            if shots['wanted'] and not replying():
                                shot_wake.set()
                        if away:
                            outcome = 'rollover'
                            if protocol == 2:
                                await socket.send_json({'type': 'recovery', 'reason': 'rollover'})
                            return

            async def heartbeat():
                nonlocal retain
                while True:
                    await asyncio.sleep(LIVE_RECHECK_SECONDS)
                    if staff.get('exp', 0) < time.time():
                        raise ValueError('Sign-in expired. Reconnect to continue.')
                    # Always repeats the revocation lookup, so a revoked account ends at this recheck.
                    refreshed = await verify_staff(token, live=True)
                    if refreshed['uid'] != uid:
                        retain = False
                        raise ValueError('Session owner changed.')
                    current = await stored(store.get_inspection, uid, inspection_id)
                    try:
                        await stored(store._access, uid, current, 'live')
                    except HTTPException:
                        retain = False
                        raise
                    if (
                        current['status'] == 'signed'
                        or scope_fingerprint(current['data']) != fingerprint
                    ):
                        retain = False
                        raise ValueError('Scope changed. Restart the walkthrough.')
                    await stored(store.live_lease, uid, lease)
                    if capture:
                        await stored(
                            store.live_resume,
                            uid,
                            capture,
                            inspection_id,
                            fingerprint,
                            lease,
                            'touch',
                        )

            tasks = [
                asyncio.create_task(fn()) for fn in (upstream, downstream, heartbeat, shot_updates)
            ]
            try:
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    task.result()
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                tasks = []
    except WebSocketDisconnect:
        outcome = 'disconnected'
    except Exception as error:
        if isinstance(error, HTTPException) and error.status_code in (401, 403, 404):
            retain = False
        outcome = type(error).__name__
        status = getattr(error, 'status_code', None)
        # Vertex's close code, an SDK error code, or 1006 for a code-less provider timeout.
        # Client auth and input rejections stay without a provider code and do not page.
        provider_code = live_provider_code(error)
        message = {
            'type': 'error',
            'message': error.detail
            if isinstance(error, HTTPException)
            else 'Live coaching disconnected. Your draft is preserved; reconnect to continue.',
        }
        if protocol == 2 and isinstance(error, HTTPException):
            message['status'] = error.status_code
        with suppress(Exception):
            await socket.send_json(message)
    finally:

        async def cleanup():
            with anyio.CancelScope(shield=True):
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                if store and lease:
                    if capture:
                        with suppress(Exception):
                            await stored(
                                store.live_resume,
                                uid,
                                capture,
                                inspection_id,
                                fingerprint,
                                lease,
                                'touch' if retain else 'delete',
                            )
                    with suppress(Exception):
                        await stored(store.live_lease, uid, lease, True)
                if client:
                    with suppress(Exception):
                        await client.aio.aclose()
                event(
                    'Live session ended',
                    logging.INFO
                    if outcome in ('finished', 'rollover', 'disconnected', 'closed')
                    else logging.WARNING,
                    model=LIVE_MODEL,
                    operation='live',
                    inspection_id=inspection_id or None,
                    duration_ms=round((time.monotonic() - started) * 1000),
                    outcome=outcome,
                    status=status,
                    total_tokens=total_tokens,
                    provider_code=provider_code,
                    **counters.fields(),
                )
                with suppress(Exception):
                    await socket.close()

        cleanup_task = asyncio.create_task(cleanup())
        try:
            await asyncio.shield(cleanup_task)
        except asyncio.CancelledError:
            await cleanup_task
            raise
