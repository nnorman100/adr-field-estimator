"""Authenticated inspection, evidence, claims and Gemini Live endpoints."""
import asyncio
import anyio
import base64
import io
import json
import logging
import os
import re
import sys
import time
from uuid import uuid4
from concurrent.futures import ThreadPoolExecutor
from contextlib import suppress, AsyncExitStack
from functools import partial, wraps
from typing import Optional
from fastapi import FastAPI, Depends, HTTPException, Query, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from PIL import Image, ImageOps
import firebase_admin
from firebase_admin import app_check, auth as firebase_auth
from google import genai
from google.genai import types
try:
    from .contracts import CreateInspection, UpdateInspection, InspectionData, PhotoUpload, OcrResult, AIResult, AuditRequest, AuthorizeRequest
    from .claims import make_documents, price_scope
    from .prompts import live_prompt, audit_prompt, OCR_INSTRUCTIONS
    from .live_support import live_config, scope_fingerprint, is_speech
    from .company_store import CompanyInspectionStore
    from .workspaces import AccessDenied
    from .workspace_api import register_workspace_routes
    from .scope import ScopeSuggestions, validate_suggestions, scope_prompt, scope_response_schema
    from .inspection_store import InspectionStore, Conflict, Limited
    from .job_store import BUCKET, decode_image, IMAGE_WORKER
except ImportError:
    from contracts import CreateInspection, UpdateInspection, InspectionData, PhotoUpload, OcrResult, AIResult, AuditRequest, AuthorizeRequest
    from claims import make_documents, price_scope
    from prompts import live_prompt, audit_prompt, OCR_INSTRUCTIONS
    from live_support import live_config, scope_fingerprint, is_speech
    from company_store import CompanyInspectionStore
    from workspaces import AccessDenied
    from workspace_api import register_workspace_routes
    from scope import ScopeSuggestions, validate_suggestions, scope_prompt, scope_response_schema
    from inspection_store import InspectionStore, Conflict, Limited
    from job_store import BUCKET, decode_image, IMAGE_WORKER

DEDICATED_PROJECT_ID = 'alert-disaster-field-2026'
PROJECT_ID = os.getenv('GOOGLE_CLOUD_PROJECT',DEDICATED_PROJECT_ID)
if PROJECT_ID != DEDICATED_PROJECT_ID: raise RuntimeError('This service must use its dedicated alert-disaster-field-2026 project.')
LOCATION = os.getenv('GOOGLE_CLOUD_LOCATION','global')
AUDIT_MODEL = os.getenv('AUDIT_MODEL','gemini-3.8-flash')
OCR_MODEL = os.getenv('OCR_MODEL',AUDIT_MODEL)
LIVE_MODEL = os.getenv('LIVE_MODEL','gemini-3.8-live')
LIVE_LOCATION = os.getenv('LIVE_LOCATION','us-central1')
LIVE_RECHECK_SECONDS = 20
LIVE_VOICE = os.getenv('LIVE_VOICE','Charon')
LIVE_URL = 'wss://alert-disaster-field-estimator-545776254070.us-west2.run.app/api/live'
ORIGINS = ['https://alert-disaster-field-2026.web.app','https://alert-disaster-field-2026.firebaseapp.com']
WORKSPACES_ENABLED = os.getenv('WORKSPACES_ENABLED','false').lower()=='true'
STAFF_EMAILS = {e.strip().lower() for e in os.getenv('STAFF_EMAILS','nathanaelcnorman@gmail.com').split(',') if e.strip()}
WORKSPACE_SIGN_IN_PROVIDERS = frozenset({'google.com','password'})
# Step one of the App Check rollout only records each request's token; see docs/app-check.md.
APPCHECK_MODE = os.getenv('APPCHECK_MODE','monitor')
if APPCHECK_MODE not in ('off','monitor'): raise RuntimeError('APPCHECK_MODE must be off or monitor; App Check enforcement is not available in this release.')
APPCHECK_SECONDS = 2
APPCHECK_TOKEN_LIMIT = 4096
# Its own two threads, so a slow signing-key fetch can never hold the request threadpool.
APPCHECK_WORKER = ThreadPoolExecutor(max_workers=2,thread_name_prefix='app-check')

def read_source_commit(path=os.path.join(os.path.dirname(os.path.abspath(__file__)),'SOURCE_COMMIT')):
    # scripts/deploy_backend.py writes the deployed commit into the build context; local runs have no stamp.
    try:
        with open(path,encoding='utf8') as stamp: value=stamp.read().strip()
    except OSError: return 'unknown'
    return value if re.fullmatch(r'[0-9a-f]{40}(?:-dirty)?',value) else 'unknown'

SOURCE_COMMIT = read_source_commit()
app = FastAPI(title='Alert Disaster Restoration Field Estimator',version='2.0')
app.add_middleware(CORSMiddleware,allow_origins=ORIGINS,allow_credentials=False,allow_methods=['GET','POST','PUT'],allow_headers=['Authorization','Content-Type','X-ADR-Workspace-Protocol','X-Firebase-AppCheck'])
security = HTTPBearer(auto_error=False)
_job_store = None
genai_client = None
# An allowlist, so prompts, transcripts, images, tokens, emails, links and signatures cannot reach the log.
LOG_FIELDS = frozenset({'model','operation','elapsed_ms','duration_ms','outcome','provider_status','provider_code','status','total_tokens','inspection_id','method','route'})

class CloudLoggingJson(logging.Handler):
    """One JSON object per stdout line, which Cloud Logging parses into severity, message and fields."""
    def emit(self,record):
        entry={'severity':record.levelname,'message':record.getMessage(),**getattr(record,'fields',{})}
        print(json.dumps(entry,default=str),file=sys.stdout,flush=True)

log=logging.getLogger('adr')
log.setLevel(logging.INFO); log.propagate=False
if not log.handlers: log.addHandler(CloudLoggingJson())

def event(message,severity=logging.INFO,**fields):
    log.log(severity,message,extra={'fields':{k:v for k,v in fields.items() if k in LOG_FIELDS and v is not None}})

def get_job_store():
    global _job_store
    if _job_store is None: _job_store=CompanyInspectionStore() if WORKSPACES_ENABLED else InspectionStore()
    return _job_store

def get_ai_client():
    global genai_client
    if genai_client is None:
        genai_client=genai.Client(enterprise=True,project=PROJECT_ID,location=LOCATION,http_options=types.HttpOptions(timeout=95000))
    return genai_client

def admin_app():
    try: return firebase_admin.get_app('adr')
    except ValueError: return firebase_admin.initialize_app(options={'projectId':PROJECT_ID},name='adr')

async def verify_identity(token):
    try:
        claims=await run_in_threadpool(firebase_auth.verify_id_token,token,app=admin_app(),check_revoked=True)
    except Exception:
        raise HTTPException(401,'Your sign-in expired. Please sign in again.')
    if not claims.get('email_verified') or not claims.get('email'):
        raise HTTPException(403,'A verified email address is required. Verify your email, then sign in again.')
    if WORKSPACES_ENABLED and claims.get('firebase',{}).get('sign_in_provider') not in WORKSPACE_SIGN_IN_PROVIDERS:
        raise HTTPException(403,'Sign in with Google or a verified email and password.')
    return claims

async def app_check_outcome(token):
    """Classifies a request's App Check token; monitor mode records the result and never rejects on it."""
    if not token: return 'missing'
    if not isinstance(token,str) or len(token)>APPCHECK_TOKEN_LIMIT: return 'invalid'
    try:
        # The Admin SDK verifies locally against signing keys it caches for six hours.
        verify=partial(app_check.verify_token,token,app=admin_app())
        await asyncio.wait_for(asyncio.get_running_loop().run_in_executor(APPCHECK_WORKER,verify),APPCHECK_SECONDS)
        return 'valid'
    except (asyncio.TimeoutError,TimeoutError): return 'unverified'
    except Exception: return 'invalid'

def record_app_check(outcome,method,route,status=None):
    event('App Check',outcome=outcome,method=method,route=route,status=status)

async def verify_staff(token):
    claims=await verify_identity(token)
    if WORKSPACES_ENABLED:
        actor=await stored(get_job_store().workspaces.principal,claims['uid'])
        if not actor['role'] and not actor['superadmin']:
            raise HTTPException(403,'Accept a company invitation before using this app.')
    elif claims.get('email','').lower() not in STAFF_EMAILS:
        raise HTTPException(403,'Your account has not been approved for this app.')
    return claims

async def current_staff(credentials: Optional[HTTPAuthorizationCredentials]=Depends(security)):
    if not credentials or credentials.scheme.lower()!='bearer': raise HTTPException(401,'Sign in to continue.')
    return await verify_staff(credentials.credentials)

MB=1024*1024
# Sized to the contracts: an 8 MB photo as base64, a 3 MB signature PNG, a 1.4 MB company logo.
BODY_LIMITS=[('POST',re.compile(r'/api/inspections/[^/]+/photos'),13*MB),('POST',re.compile(r'/api/authorize'),int(3.5*MB)),
             ('PUT',re.compile(r'/api/companies/[^/]+'),2*MB)]
BODY_READ_SECONDS=50  # Below Firebase Hosting's 60-second request timeout.

def body_limit(method,path):
    return next((limit for m,pattern,limit in BODY_LIMITS if m==method and pattern.fullmatch(path)),MB)

def has_bearer(request):
    scheme,_,token=request.headers.get('authorization','').partition(' ')
    return scheme.lower()=='bearer' and bool(token.strip())

@app.middleware('http')
async def limit_payload(request:Request,call_next):
    if request.method in ('POST','PUT'):
        # Reject before reading the body; current_staff still verifies the token.
        if request.url.path.startswith('/api/') and not has_bearer(request):
            return JSONResponse({'detail':'Sign in to continue.'},status_code=401)
        limit=body_limit(request.method,request.url.path)
        declared=request.headers.get('content-length')
        if declared is not None:
            if not re.fullmatch(r'[0-9]+',declared): return Response('Invalid Content-Length.',status_code=400)
            if int(declared)>limit: return Response('The upload is too large.',status_code=413)
        # Bound reads before model parsing, including requests without Content-Length.
        async def read():
            chunks=[]; size=0
            async for chunk in request.stream():
                size+=len(chunk)
                if size>limit: return None
                chunks.append(chunk)
            return b''.join(chunks)
        try: body=await asyncio.wait_for(read(),BODY_READ_SECONDS)
        except asyncio.TimeoutError: return Response('The upload took too long.',status_code=408)
        if body is None: return Response('The upload is too large.',status_code=413)
        request._body=body
    response=await call_next(request)
    if request.url.path.startswith('/api/'):
        response.headers['Cache-Control']='private, no-store'
    return response

@app.middleware('http')
async def monitor_app_check(request:Request,call_next):
    # Registered after limit_payload, so it also records requests that middleware rejects.
    if APPCHECK_MODE=='off' or not request.url.path.startswith('/api/'): return await call_next(request)
    verification=asyncio.create_task(app_check_outcome(request.headers.get('x-firebase-appcheck')))
    status=None
    try:
        response=await call_next(request); status=response.status_code
        return response
    finally:
        # The route template, never the concrete path, so inspection and photo IDs stay out of this line.
        record_app_check(await verification,request.method,getattr(request.scope.get('route'),'path',None),status)

async def stored(method,*args):
    try: return await run_in_threadpool(method,*args)
    except Limited as error: raise HTTPException(429,str(error),headers={'Retry-After':str(error.retry_after)})
    except AccessDenied as error: raise HTTPException(403,str(error))
    except Conflict as error: raise HTTPException(409,str(error))
    except LookupError: raise HTTPException(404,'Record not found.')
    except ValueError as error: raise HTTPException(400,str(error))
    except Exception as error:
        event('Storage operation failed',logging.ERROR,operation=getattr(method,'__name__',None),outcome=type(error).__name__)
        raise HTTPException(503,'Changes could not be saved. Your local draft can be retried.')

def public_record(record):
    return {k:v for k,v in record.items() if k not in ('owner_uid','payload_sha256')}

def parse_json_from_llm(text):
    text=(text or '').strip()
    if text.startswith('```'):
        text='\n'.join(text.splitlines()[1:])
        if text.rstrip().endswith('```'): text=text.rstrip()[:-3]
    return json.loads(text)

async def generate(schema,contents,model,operation,inspection_id,wire_schema=None):
    started=time.monotonic(); outcome='cancelled'; error_fields={}
    try:
        response=await asyncio.wait_for(get_ai_client().aio.models.generate_content(
            model=model,contents=contents,config=types.GenerateContentConfig(
                response_mime_type='application/json',response_schema=wire_schema or schema)),timeout=100)
        result=schema.model_validate(parse_json_from_llm(response.text))
        outcome='ok'
        return result
    except (asyncio.TimeoutError,TimeoutError):
        outcome='timeout'
        raise HTTPException(504,'AI generation timed out. Retry; no document or reading was verified.')
    except Exception as error:
        # Provider messages can echo the prompt; record only the class and status.
        outcome=type(error).__name__; error_fields=dict(provider_status=getattr(error,'status',None),provider_code=getattr(error,'code',None))
        raise HTTPException(502,'AI returned an unavailable or invalid result. Retry; no document or reading was verified.')
    finally:
        event('Vertex AI call',logging.INFO if outcome=='ok' else logging.ERROR,model=model,operation=operation,
              elapsed_ms=round((time.monotonic()-started)*1000),outcome=outcome,inspection_id=inspection_id,**error_fields)

def rest_deadline(operation):
    @wraps(operation)
    async def bounded(*args,**kwargs):
        try: return await asyncio.wait_for(operation(*args,**kwargs),55)
        except asyncio.TimeoutError: raise HTTPException(504,'The request timed out. Your draft is preserved; retry. No document or reading was verified.')
    return bounded

def model_image(raw):
    with IMAGE_WORKER, Image.open(io.BytesIO(raw)) as image:
        image=ImageOps.exif_transpose(image).convert('RGB'); image.thumbnail((1600,1600))
        output=io.BytesIO(); image.save(output,format='JPEG',quality=85)
        return types.Part.from_bytes(data=output.getvalue(),mime_type='image/jpeg')

@app.get('/health')
@app.get('/api/health')
def health_check():
    # Anonymous callers learn liveness and the source commit only; configuration is staff-only below.
    return dict(status='healthy',schema_version=3,source_commit=SOURCE_COMMIT)

@app.get('/api/health/details')
def health_details(staff=Depends(current_staff)):
    return dict(status='healthy',service='alert-disaster-field-estimator',project=PROJECT_ID,
                location=LOCATION,database_project=PROJECT_ID,database='(default)',evidence_bucket=BUCKET,
                schema_version=3,audit_model=AUDIT_MODEL,ocr_model=OCR_MODEL,live_model=LIVE_MODEL,workspaces_enabled=WORKSPACES_ENABLED,
                source_commit=SOURCE_COMMIT)

async def current_identity(credentials: Optional[HTTPAuthorizationCredentials]=Depends(security)):
    if not WORKSPACES_ENABLED: raise HTTPException(503,'Company dashboards are not enabled yet.')
    if not credentials or credentials.scheme.lower()!='bearer': raise HTTPException(401,'Sign in to continue.')
    return await verify_identity(credentials.credentials)

@app.get('/api/session')
async def session_info(staff=Depends(current_staff)):
    result=dict(uid=staff['uid'],email=staff['email'],project=PROJECT_ID,live_url=LIVE_URL,schema_version=3,live_protocol_version=2,live_voice=LIVE_VOICE,workspaces_enabled=WORKSPACES_ENABLED,workspace_protocol_version=1)
    if WORKSPACES_ENABLED:
        result.update(await stored(get_job_store().workspaces.principal,staff['uid']))
    return result

register_workspace_routes(app,current_identity,get_job_store,stored)

def workspace_client(request):
    if WORKSPACES_ENABLED and request.headers.get('X-ADR-Workspace-Protocol')!='1':
        raise HTTPException(409,'Update the app before generating or opening company-branded documents.')

def inspection_payload(data):
    result=data.model_dump(mode='json')
    if result.get('capture_metadata') is None: result.pop('capture_metadata',None)
    return result

@app.post('/api/inspections')
async def create_inspection(req:CreateInspection,staff=Depends(current_staff),store=Depends(get_job_store)):
    await stored(store.quota,staff['uid'],'draft',60)
    return public_record(await stored(store.create_inspection,staff['uid'],req.inspection_id,inspection_payload(req.data)))

@app.get('/api/inspections')
async def list_inspections(cursor:Optional[str]=Query(default=None,max_length=80,pattern=r'^[A-Za-z0-9-]+$'),staff=Depends(current_staff),store=Depends(get_job_store)):
    records,next_cursor=await stored(store.inspection_page,staff['uid'],cursor)
    return {'inspections':[dict(inspection_id=r['inspection_id'],address=r['data']['address'],revision=r['revision'],status=r['status'],updated_at=r['updated_at']) for r in records],'next_cursor':next_cursor}

@app.get('/api/inspections/{inspection_id}')
async def get_inspection(inspection_id:str,request:Request,staff=Depends(current_staff),store=Depends(get_job_store)):
    record=await stored(store.get_inspection,staff['uid'],inspection_id)
    if record.get('audit') and record['audit']['documents'].get('company_identity'): workspace_client(request)
    return public_record(record)

@app.put('/api/inspections/{inspection_id}')
async def update_inspection(inspection_id:str,req:UpdateInspection,staff=Depends(current_staff),store=Depends(get_job_store)):
    await stored(store.quota,staff['uid'],'draft',60)
    return public_record(await stored(store.update_inspection,staff['uid'],inspection_id,req.expected_revision,inspection_payload(req.data)))

@app.post('/api/inspections/{inspection_id}/photos')
async def upload_photo(inspection_id:str,req:PhotoUpload,staff=Depends(current_staff),store=Depends(get_job_store)):
    await stored(store.quota,staff['uid'],'draft',60)
    record=await stored(store.add_photo,staff['uid'],inspection_id,req.model_dump(mode='json'))
    return public_record(record)

@app.get('/api/inspections/{inspection_id}/photos/{photo_id}')
async def photo_evidence(inspection_id:str,photo_id:str,staff=Depends(current_staff),store=Depends(get_job_store)):
    photo,raw=await stored(store.photo,staff['uid'],inspection_id,photo_id)
    return Response(raw,media_type=photo['file']['content_type'],headers={'Cache-Control':'private, no-store'})

@app.post('/api/inspections/{inspection_id}/photos/{photo_id}/ocr')
@rest_deadline
async def ocr_photo(inspection_id:str,photo_id:str,staff=Depends(current_staff),store=Depends(get_job_store)):
    await stored(store.quota,staff['uid'],'ocr',20)
    record=await stored(store.get_inspection,staff['uid'],inspection_id)
    await stored(store._access,staff['uid'],record,'ocr')
    photo,raw=await stored(store.photo,staff['uid'],inspection_id,photo_id)
    try:
        result=await generate(OcrResult,[await run_in_threadpool(model_image,raw),
            OCR_INSTRUCTIONS],OCR_MODEL,'ocr',inspection_id)
    except (HTTPException,asyncio.CancelledError):
        await stored(store.set_ocr,staff['uid'],inspection_id,photo_id,None)
        raise
    return public_record(await stored(store.set_ocr,staff['uid'],inspection_id,photo_id,result.model_dump(mode='json')))

@app.post('/api/ocr-meter')
async def legacy_ocr(staff=Depends(current_staff)):
    raise HTTPException(409,'Update the app and attach the photo to an inspection before recognition.')

@app.post('/api/inspections/{inspection_id}/scope-suggestions')
@rest_deadline
async def suggest_scope(inspection_id:str,req:AuditRequest,staff=Depends(current_staff),store=Depends(get_job_store)):
    if req.inspection_id != inspection_id: raise HTTPException(400,'Inspection references must match.')
    record=await stored(store.get_inspection,staff['uid'],inspection_id)
    if record['revision']!=req.expected_revision or record['status']=='signed':
        raise HTTPException(409,'Restore the latest unsigned draft before filling scope.')
    await stored(store._access,staff['uid'],record,'scope')
    data=InspectionData.model_validate(record['data'])
    if not (data.technician_transcript.strip() or data.technician_notes.strip()):
        raise HTTPException(400,'Record technician observations in the walkthrough or notes first.')
    await stored(store.quota,staff['uid'],'scope',6)
    result=await generate(ScopeSuggestions,[scope_prompt(data)],AUDIT_MODEL,'scope',inspection_id,wire_schema=scope_response_schema())
    try: result=validate_suggestions(data,result)
    except (ValueError,ValidationError):
        raise HTTPException(502,'Scope suggestions could not be verified. Clarify the recorded room, category and quantities, then retry.')
    latest=await stored(store.get_inspection,staff['uid'],inspection_id)
    await stored(store._access,staff['uid'],latest,'scope')
    if latest['revision']!=req.expected_revision or latest['status']=='signed':
        raise HTTPException(409,'The inspection changed while reading the walkthrough. Retry from the current draft.')
    return dict(inspection_id=inspection_id,revision=req.expected_revision,**result.model_dump(mode='json'))

@app.post('/api/audit')
@rest_deadline
async def audit_inspection(req:AuditRequest,request:Request,staff=Depends(current_staff),store=Depends(get_job_store)):
    await stored(store.quota,staff['uid'],'audit',3)
    record=await stored(store.get_inspection,staff['uid'],req.inspection_id)
    await stored(store._access,staff['uid'],record,'audit')
    workspace_client(request)
    if record['revision']!=req.expected_revision or record['status']=='signed': raise HTTPException(409,'Restore the latest draft before auditing.')
    data=InspectionData.model_validate(record['data'])
    if data.package_price is not None:
        raise HTTPException(409,'Update the app and clear the old package-tier selection before auditing.')
    if not data.scope_confirmed: raise HTTPException(400,'Confirm room quantities, category, equipment, days and labor before auditing.')
    if not data.address.strip() or data.year_built is None or not data.rooms:
        raise HTTPException(400,'Enter the address, year built and rooms before auditing.')
    items,total=price_scope(data)
    if total<=0: raise HTTPException(400,'Add measured work, equipment or charges before auditing.')
    deadline=time.monotonic()+30
    while any(p['ocr_status']=='pending' for p in record['photos']) and time.monotonic()<deadline:
        await asyncio.sleep(0.5)
        record=await stored(store.get_inspection,staff['uid'],req.inspection_id)
        if record['data']!=inspection_payload(data): raise HTTPException(409,'Inspection inputs changed while waiting for OCR.')
    # OCR may advance the revision; bind the resulting audit to that exact snapshot.
    revision=record['revision']
    identity=await stored(store.workspaces.snapshot,staff['uid']) if WORKSPACES_ENABLED else None
    prompt=audit_prompt(record['data'],record['photos'],items,identity)
    contents=[prompt]
    for photo in record['photos']:
        _,raw=await stored(store.photo,staff['uid'],req.inspection_id,photo['id'])
        contents.append(await run_in_threadpool(model_image,raw))
    ai=await generate(AIResult,contents,AUDIT_MODEL,'audit',req.inspection_id)
    try: documents=make_documents(data,record['photos'],ai,identity)
    except (ValueError,ValidationError): raise HTTPException(400,'The scope could not be priced. Review the inspection inputs and retry.')
    saved=await stored(store.save_audit,staff['uid'],req.inspection_id,revision,documents)
    return public_record(saved)

@app.post('/api/authorize')
async def authorize_estimate(request:Request,staff=Depends(current_staff),store=Depends(get_job_store)):
    workspace_client(request)
    try: body=await request.json()
    except (ValueError,UnicodeDecodeError): raise HTTPException(422,'Expected a signed-agreement object.')
    if not isinstance(body,dict): raise HTTPException(422,'Expected a signed-agreement object.')
    await stored(store.quota,staff['uid'],'authorize',10)
    if 'inspection_id' not in body:
        # Historical agreements remain readable; old clients cannot create new agreements.
        existing=await stored(store.get,staff['uid'],str(body.get('auth_id','')))
        if not existing: raise HTTPException(409,'Update the app and complete a revision-bound audit before signing.')
        defaults={'auth_id':None,'timestamp':None,'address':None,'date':None,'proposed_cost':None,'findings':[],
                  'recommendations':[],'xactimate_scope':[],'signature_png':None,'photos_count':0,'photos':[],'inspection':{}}
        import hashlib
        from_json={key:body.get(key,value) for key,value in defaults.items()}
        digest=hashlib.sha256(json.dumps(from_json,sort_keys=True,separators=(',', ':'),allow_nan=False).encode()).hexdigest()
        if digest!=existing.get('payload_sha256'): raise HTTPException(409,'This reference already represents a different agreement.')
        record=existing
    else:
        try: req=AuthorizeRequest.model_validate(body)
        except ValidationError: raise HTTPException(422,'Signing requires the current inspection revision, proposal hash, document confirmation and PNG signature.')
        record=await stored(store.authorize,staff['uid'],req.model_dump(mode='json'))
    return dict(status='success',auth_id=record['auth_id'],timestamp=record['created_at'],message='Signed agreement and private evidence saved.')

@app.get('/api/authorizations')
async def list_authorizations(cursor:Optional[str]=Query(default=None,max_length=80,pattern=r'^[A-Za-z0-9-]+$'),staff=Depends(current_staff),store=Depends(get_job_store)):
    records,next_cursor=await stored(store.authorization_page,staff['uid'],cursor)
    return {'authorizations':[{k:r.get(k) for k in ('auth_id','address','proposed_cost','proposed_cost_low','created_at','photos_count','schema_version')} for r in records],'next_cursor':next_cursor}

@app.get('/api/authorizations/{auth_id}')
async def get_authorization(auth_id:str,request:Request,staff=Depends(current_staff),store=Depends(get_job_store)):
    record=await stored(store.get,staff['uid'],auth_id)
    if not record: raise HTTPException(404,'Signed agreement not found.')
    if record.get('documents',{}).get('company_identity'): workspace_client(request)
    return public_record(record)

@app.get('/api/authorizations/{auth_id}/evidence/{name}')
async def get_evidence(auth_id:str,name:str,staff=Depends(current_staff),store=Depends(get_job_store)):
    record=await stored(store.get,staff['uid'],auth_id)
    if not record: raise HTTPException(404,'Evidence not found.')
    evidence=await stored(store.evidence,record,name,staff['uid']) if WORKSPACES_ENABLED else await stored(store.evidence,record,name)
    if not evidence: raise HTTPException(404,'Evidence not found.')
    return Response(evidence[0],media_type=evidence[1],headers={'Cache-Control':'private, no-store'})

@app.websocket('/api/live')
async def live_walkthrough(socket:WebSocket):
    if socket.headers.get('origin') not in ORIGINS:
        await socket.close(code=1008); return
    await socket.accept()
    store=None; lease=None; uid=None; client=None; tasks=[]; capture=None; retain=True
    fingerprint=None; inspection_id=None; protocol=1
    started=time.monotonic(); outcome='closed'; status=None; total_tokens=None
    try:
        packet=await asyncio.wait_for(socket.receive_text(),10)
        if len(packet)>16384: raise ValueError('Authentication packet too large.')
        auth=json.loads(packet)
        if auth.get('type')!='authenticate': raise ValueError('Authenticate before streaming.')
        protocol=auth.get('protocol_version',1)
        if protocol not in (1,2): raise ValueError('Update the app to connect.')
        capture=auth.get('capture_id') if protocol==2 else None
        if protocol==2 and (not isinstance(capture,str) or len(capture)!=32): raise ValueError('Invalid capture identifier.')
        if APPCHECK_MODE=='monitor': record_app_check(await app_check_outcome(auth.get('app_check')),'WEBSOCKET','/api/live')
        token=auth.get('token','');staff=await verify_staff(token)
        uid=staff['uid']; store=get_job_store(); inspection_id=auth.get('inspection_id','')
        record=await stored(store.get_inspection,uid,inspection_id)
        await stored(store._access,uid,record,'live')
        identity=await stored(store.workspaces.snapshot,uid) if WORKSPACES_ENABLED else None
        if identity and identity['company_id']!='adr' and auth.get('workspace_protocol_version')!=1:
            raise HTTPException(409,'Update the app before a company walkthrough.')
        if record['status']=='signed': raise ValueError('Start a new inspection for live coaching.')
        fingerprint=scope_fingerprint(record['data'])
        for attempt in range(31):
            try:
                lease=await stored(store.live_lease,uid)
                break
            except HTTPException as error:
                if protocol!=2 or not auth.get('resume') or error.status_code!=429 or attempt==30: raise
                await asyncio.sleep(.1)
        handle=None
        if capture:
            handle=await stored(store.live_resume,uid,capture,inspection_id,fingerprint,lease,'open')
            if not auth.get('resume',False):
                handle=None
                await stored(store.live_resume,uid,capture,inspection_id,fingerprint,lease,'save',None,False)
        # Only a saved checkpoint for this user, capture and scope makes a start free.
        if not handle: await stored(store.quota,uid,'live')
        client=genai.Client(enterprise=True,project=PROJECT_ID,location=LIVE_LOCATION,http_options=types.HttpOptions(timeout=95000))
        async with AsyncExitStack() as stack:
            config=live_config(live_prompt(record['data'],identity),LIVE_VOICE,handle)
            try:
                session=await stack.enter_async_context(client.aio.live.connect(model=LIVE_MODEL,config=config))
            except Exception:
                if not handle: raise
                await stored(store.live_resume,uid,capture,inspection_id,fingerprint,lease,'save',None,False)
                handle=None
                session=await stack.enter_async_context(client.aio.live.connect(model=LIVE_MODEL,
                    config=live_config(live_prompt(record['data'],identity),LIVE_VOICE)))
            connection=uuid4().hex; sequence=0; pending=False; finishing=False
            final_text=asyncio.Event(); final_text.set()
            ready={'type':'ready','model':LIVE_MODEL}
            if protocol==2:
                ready.update(protocol_version=2,connection_id=connection,voice=LIVE_VOICE,token_refresh=True,
                    recovery='resumed' if handle else 'restarted' if auth.get('resume') else 'new')
            await socket.send_json(ready)
            async def upstream():
                nonlocal pending,finishing,retain,outcome,staff,token
                frame_at=0; second=0; count=0
                while True:
                    raw=await socket.receive_text()
                    if len(raw)>800000: raise ValueError('Live packet too large.')
                    data=json.loads(raw); kind=data.get('type'); moment=time.monotonic()
                    if int(moment)!=second: second=int(moment); count=0
                    count+=1
                    if count>60: raise ValueError('Live stream exceeded its message limit.')
                    if kind=='audio':
                        audio=base64.b64decode(data['data'],validate=True)
                        if len(audio)>64000 or len(audio)%2: raise ValueError('Invalid PCM audio.')
                        # The client streams the open microphone, so only speech can still be awaiting a transcript.
                        if is_speech(audio): pending=True; final_text.clear()
                        await session.send_realtime_input(audio=types.Blob(data=audio,mime_type='audio/pcm;rate=16000'))
                    elif kind=='video':
                        if moment-frame_at<0.95: continue
                        frame_at=moment; image=base64.b64decode(data['data'],validate=True)
                        if len(image)>512000 or not image.startswith(b'\xff\xd8\xff'): raise ValueError('Invalid JPEG frame.')
                        await session.send_realtime_input(video=types.Blob(data=image,mime_type='image/jpeg'))
                    elif kind=='pause' and protocol==2:
                        await session.send_realtime_input(audio_stream_end=True)
                    elif kind=='refresh':
                        # A renewed ID token extends the session only for the same verified user.
                        refreshed=await verify_staff(data.get('token',''))
                        if refreshed['uid']!=uid: retain=False; raise ValueError('Session owner changed.')
                        staff=refreshed; token=data['token']
                    elif kind=='end':
                        outcome='finished'
                        retain=bool(data.get('preserve_resume',False)) if protocol==2 else False
                        if protocol==2:
                            finishing=True
                            await session.send_realtime_input(audio_stream_end=True)
                            try: await asyncio.wait_for(final_text.wait(),3)
                            except asyncio.TimeoutError: pass
                            # The client stops waiting 3.5 s after End, so acknowledge before cleanup.
                            await socket.send_json({'type':'finished','complete':not pending})
                        return
                    else: raise ValueError('Unsupported live packet.')
            async def downstream():
                nonlocal sequence,pending,outcome,total_tokens
                while True:
                    async for response in session.receive():
                        update=getattr(response,'session_resumption_update',None)
                        if update and capture:
                            await stored(store.live_resume,uid,capture,inspection_id,fingerprint,lease,'save',
                                getattr(update,'new_handle',None),bool(getattr(update,'resumable',False)))
                        usage=getattr(response,'usage_metadata',None)
                        if usage: total_tokens=getattr(usage,'total_token_count',None) or total_tokens
                        if usage and protocol==2:
                            await socket.send_json({'type':'usage','total_tokens':getattr(usage,'total_token_count',None)})
                        away=getattr(response,'go_away',None)
                        content=getattr(response,'server_content',None)
                        if content:
                            if content.interrupted: await socket.send_json({'type':'interrupted'})
                            for side,value in [('technician',content.input_transcription),('assistant',content.output_transcription)]:
                                if value and (value.text or getattr(value,'finished',False)):
                                    sequence+=1
                                    message={'type':'transcript','speaker':side,'text':value.text or ''}
                                    if protocol==2: message.update(connection_id=connection,sequence=sequence,finished=getattr(value,'finished',None))
                                    await socket.send_json(message)
                                    if side=='technician' and getattr(value,'finished',False):
                                        pending=False; final_text.set()
                            if content.model_turn and not finishing:
                                for part in content.model_turn.parts:
                                    if part.inline_data and part.inline_data.data:
                                        await socket.send_json({'type':'audio','data':base64.b64encode(part.inline_data.data).decode(),'rate':24000})
                            if content.turn_complete: await socket.send_json({'type':'turn_complete'})
                        if away:
                            outcome='rollover'
                            if protocol==2: await socket.send_json({'type':'recovery','reason':'rollover'})
                            return
            async def heartbeat():
                nonlocal retain
                while True:
                    await asyncio.sleep(LIVE_RECHECK_SECONDS)
                    if staff.get('exp',0)<time.time(): raise ValueError('Sign-in expired. Reconnect to continue.')
                    refreshed=await verify_staff(token)
                    if refreshed['uid']!=uid: retain=False; raise ValueError('Session owner changed.')
                    current=await stored(store.get_inspection,uid,inspection_id)
                    try: await stored(store._access,uid,current,'live')
                    except HTTPException:
                        retain=False
                        raise
                    if current['status']=='signed' or scope_fingerprint(current['data'])!=fingerprint:
                        retain=False; raise ValueError('Scope changed. Restart the walkthrough.')
                    await stored(store.live_lease,uid,lease)
                    if capture: await stored(store.live_resume,uid,capture,inspection_id,fingerprint,lease,'touch')
            tasks=[asyncio.create_task(fn()) for fn in (upstream,downstream,heartbeat)]
            try:
                done,_=await asyncio.wait(tasks,return_when=asyncio.FIRST_COMPLETED)
                for task in done: task.result()
            finally:
                for task in tasks: task.cancel()
                await asyncio.gather(*tasks,return_exceptions=True)
                tasks=[]
    except WebSocketDisconnect: outcome='disconnected'
    except Exception as error:
        if isinstance(error,HTTPException) and error.status_code in (401,403,404): retain=False
        outcome=type(error).__name__; status=getattr(error,'status_code',None)
        message={'type':'error','message':error.detail if isinstance(error,HTTPException) else 'Live coaching disconnected. Your draft is preserved; reconnect to continue.'}
        if protocol==2 and isinstance(error,HTTPException): message['status']=error.status_code
        with suppress(Exception): await socket.send_json(message)
    finally:
        async def cleanup():
            with anyio.CancelScope(shield=True):
                for task in tasks: task.cancel()
                await asyncio.gather(*tasks,return_exceptions=True)
                if store and lease:
                    if capture:
                        with suppress(Exception): await stored(store.live_resume,uid,capture,inspection_id,fingerprint,lease,'touch' if retain else 'delete')
                    with suppress(Exception): await stored(store.live_lease,uid,lease,True)
                if client:
                    with suppress(Exception): await client.aio.aclose()
                event('Live session ended',logging.INFO if outcome in ('finished','rollover','disconnected','closed') else logging.WARNING,
                      model=LIVE_MODEL,operation='live',inspection_id=inspection_id or None,duration_ms=round((time.monotonic()-started)*1000),
                      outcome=outcome,status=status,total_tokens=total_tokens)
                with suppress(Exception): await socket.close()
        cleanup_task=asyncio.create_task(cleanup())
        try: await asyncio.shield(cleanup_task)
        except asyncio.CancelledError:
            await cleanup_task
            raise
