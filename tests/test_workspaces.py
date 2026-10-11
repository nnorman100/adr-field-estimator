"""Company policy is tested through real API handlers and transactional storage."""
import asyncio
import html
import json
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
import time
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
import backend.main as bm
import backend.workspaces as workspaces
from backend.claims import make_documents
from backend.contracts import InspectionData, AIResult
from backend.workspaces import ADR_PROFILE, AccessDenied, CompanyCreate, MemberUpdate, ProfileUpdate, CompanyProfile, StatusUpdate, CoordinationUpdate
from backend.inspection_store import Conflict, Limited
from backend.workspace_migration import migrate
from tests.fakes import FakeCompanyStore, FakeStore, png

ID='ADR-INS-'+'a'*32
OTHER='ADR-INS-'+'b'*32

def seed(store):
    for company_id in ('adr','other'):
        profile={**ADR_PROFILE,'name':'Other Company','license':'123456','signoff':'Other Estimator','water_heater_notice':''} if company_id=='other' else deepcopy(ADR_PROFILE)
        store.db.records['_companies/'+company_id]=dict(company_id=company_id,profile=profile,version=1,status='active',owner_uid='owner' if company_id=='adr' else 'other-owner',region='CA',created_at='2026',updated_at='2026')
    for uid,role,cid in [('owner','owner','adr'),('estimator','estimator','adr'),('estimator2','estimator','adr'),('office','office','adr'),('other-owner','owner','other')]:
        store.db.records['_memberships/'+uid]=dict(uid=uid,email=uid+'@example.invalid',company_id=cid,role=role,status='active',version=1,updated_at='2026')
    store.db.records['_platform_admins/admin']={'active':True}
    store.db.records['_platform_admins/owner']={'active':True}
    return store

def data(address='Test property'):
    return InspectionData(address=address,year_built=2000,rooms=[dict(name='Bathroom',category=1,finished_sf=10)],air_movers=3,dehumidifiers=1,scope_confirmed=True).model_dump(mode='json')

def identity(uid):return dict(uid=uid,email=uid+'@example.invalid',email_verified=True,firebase={'sign_in_provider':'google.com'})

@pytest.fixture
def store():return seed(FakeCompanyStore())

@pytest.fixture
def api(store,monkeypatch):
    current={'uid':'owner'}
    monkeypatch.setattr(bm,'WORKSPACES_ENABLED',True)
    monkeypatch.setattr(bm,'get_job_store',lambda:store)
    for endpoint in (bm.current_staff,bm.current_identity):
        bm.app.dependency_overrides[endpoint]=lambda:identity(current['uid'])
    # Depends captured the original function before the module attribute was patched.
    for route in bm.app.routes:
        if hasattr(route,'dependant'):
            for dep in route.dependant.dependencies:
                if getattr(dep.call,'__name__','')=='get_job_store': bm.app.dependency_overrides[dep.call]=lambda:store
    async def generate(schema,*args,**kwargs):
        return AIResult(summary='Confirmed scope.',suggestions=[],unpriced_work=[])
    monkeypatch.setattr(bm,'generate',generate)
    with TestClient(bm.app,headers={'X-ADR-Workspace-Protocol':'1'}) as client:yield client,current,store
    bm.app.dependency_overrides.clear()

def test_roles_and_cross_company_scoped_jobs(store):
    record=store.create_inspection('estimator',ID,data())
    store.create_inspection('other-owner',OTHER,data())
    for uid in ('owner','office','estimator'):
        assert store.get_inspection(uid,ID)['inspection_id']==ID
    for uid in ('admin','other-owner','estimator2'):
        with pytest.raises((AccessDenied,LookupError)):store.get_inspection(uid,ID)
    assert not store.list_inspections('estimator2')
    assert len(store.list_inspections('owner'))==1
    with pytest.raises(LookupError):store.inspection_page('owner',OTHER)
    with pytest.raises(AccessDenied):store.update_inspection('office',ID,1,data('Changed'))
    with pytest.raises(AccessDenied):store.add_photo('office',ID,dict(photo_id='c'*32,expected_revision=1,room='Bathroom',captured_at='2026',data_url=png()))

@pytest.mark.parametrize('uid', ['office','other-owner','admin','estimator2'])
def test_direct_api_cannot_bypass_scope_permissions(api,uid):
    client,current,store=api; store.create_inspection('estimator',ID,data());current['uid']=uid
    assert client.put('/api/inspections/'+ID,json={'expected_revision':1,'data':data()}).status_code in (403,404)
    assert client.post('/api/audit',json={'inspection_id':ID,'expected_revision':1}).status_code in (403,404)
    assert client.post('/api/inspections/'+ID+'/scope-suggestions',json={'inspection_id':ID,'expected_revision':1}).status_code in (403,404)
    assert client.post('/api/inspections/'+ID+'/photos/'+'c'*32+'/ocr',json={}).status_code in (403,404)


def test_office_creation_and_assignment(api):
    client,current,store=api;current['uid']='office'
    initial=InspectionData(address='Office job').model_dump(mode='json')
    assert client.post('/api/inspections',json={'inspection_id':ID,'data':initial}).status_code==200
    assert client.post('/api/inspections',json={'inspection_id':OTHER,'data':data()}).status_code==403
    job=client.get('/api/jobs/'+ID+'/coordination').json()
    request={'expected_version':job['version'],'customer_name':'Test','assigned_estimator_uid':'estimator','address':'Updated office job'}
    assert client.put('/api/jobs/'+ID+'/coordination',json=request).status_code==200
    assert store.get_inspection('estimator',ID)['revision']==2
    request['expected_version']=2;request['assigned_estimator_uid']='other-owner'
    assert client.put('/api/jobs/'+ID+'/coordination',json=request).status_code==400
    current['uid']='estimator'
    assert client.put('/api/jobs/'+ID+'/coordination',json=request).status_code==403
    assert client.get('/api/companies/other/team').status_code==403


def test_assignment_retains_creator_and_revokes_previous_assignee(store):
    store.create_inspection('estimator',ID,data())
    first=CoordinationUpdate(expected_version=1,assigned_estimator_uid='estimator2')
    store.workspaces.coordination('office',ID,first)
    assert store.get_inspection('estimator2',ID)
    store.workspaces.coordination('owner',ID,CoordinationUpdate(expected_version=2))
    with pytest.raises(LookupError):store.get_inspection('estimator2',ID)
    assert store.get_inspection('estimator',ID)


def test_invitation_requires_google_email_expiry_and_explicit_acceptance(store):
    w=store.workspaces
    invitation=w.invite('owner','adr','new@example.invalid','estimator')
    assert not w.principal('new')['role']
    with pytest.raises(LookupError):w.accept(identity('wrong'),invitation['invitation_id'])
    claims=identity('new')
    assert w.accept(claims,invitation['invitation_id'])['role']=='estimator'
    assert w.accept(claims,invitation['invitation_id'])['role']=='estimator'
    expired=w.invite('owner','adr','expired@example.invalid','office')
    store.db.records['_invitations/'+expired['invitation_id']]['expires_at']=0
    with pytest.raises(Conflict):w.accept(identity('expired'),expired['invitation_id'])
    cancelled=w.invite('owner','adr','cancelled@example.invalid','office')
    w.invitation_action('owner','adr',cancelled['invitation_id'],'cancel')
    with pytest.raises(Conflict):w.accept(identity('cancelled'),cancelled['invitation_id'])
    other=w.invite('owner','adr','other-owner@example.invalid','estimator')
    with pytest.raises(Conflict):w.accept(identity('other-owner'),other['invitation_id'])


def test_no_owner_or_superadmin_escalation(store):
    w=store.workspaces
    with pytest.raises(AccessDenied):w.invite('office','adr','x@example.invalid','estimator')
    # owner is also a platform admin in this fixture; estimator is never an admin.
    with pytest.raises(AccessDenied):w.invite('estimator','adr','x@example.invalid','owner')
    with pytest.raises(AccessDenied):w.update_member('owner','adr','owner',MemberUpdate(expected_version=1,role='office',status='disabled'))
    with pytest.raises(AccessDenied):w.create_company('estimator','Company','x@example.invalid')
    with pytest.raises(LookupError):w.update_member('owner','adr','other-owner',MemberUpdate(expected_version=1,role='office',status='disabled'))


def test_email_confirmation_retry_and_idempotency(store):
    w=store.workspaces; i=w.invite('owner','adr','new@example.invalid','office');calls=[]
    def failed(*args):raise TimeoutError('Do not leak provider credentials')
    result=w.deliver('owner',i['invitation_id'],failed)
    assert result['delivery_status']=='failed' and 'credentials' not in result['delivery_error']
    def send(invitation,company):calls.append(invitation['send_attempt']);return 'message-id'
    result=w.deliver('owner',i['invitation_id'],send);assert result['delivery_status']=='sent'
    w.deliver('owner',i['invitation_id'],send);assert len(calls)==1
    fresh=w.invitation_action('owner','adr',i['invitation_id'],'resend')
    w.deliver('owner',i['invitation_id'],send)
    assert len(calls)==2 and calls[0]!=calls[1]


def test_disabled_inviter_and_concurrent_owner_replacement(store):
    w=store.workspaces
    invite=w.invite('owner','adr','new@example.invalid','office')
    store.db.records['_memberships/owner']['status']='disabled'
    with pytest.raises(AccessDenied):w.accept(identity('new'),invite['invitation_id'])
    a=w.invite('admin','adr','a@example.invalid','owner')
    b=w.invite('admin','adr','b@example.invalid','owner')
    w.accept(identity('a'),a['invitation_id'])
    assert w.principal('a')['role']=='owner'
    with pytest.raises(Conflict):w.accept(identity('b'),b['invitation_id'])


def test_disabling_member_cancels_their_pending_invitation(store):
    w=store.workspaces
    stale=w.invite('owner','adr','estimator@example.invalid','estimator')
    other=w.invite('owner','adr','new@example.invalid','office')
    w.update_member('owner','adr','estimator',MemberUpdate(expected_version=1,role='estimator',status='disabled'))
    with pytest.raises(Conflict):w.accept(identity('estimator'),stale['invitation_id'])
    assert store.db.records['_memberships/estimator']['status']=='disabled'
    assert store.db.records['_invitations/'+other['invitation_id']]['status']=='pending'
    fresh=w.invite('owner','adr','estimator@example.invalid','estimator')
    assert fresh['invitation_id']!=stale['invitation_id']
    w.accept(identity('estimator'),fresh['invitation_id'])
    assert w.principal('estimator')['role']=='estimator'

def test_owner_replacement_cancels_the_former_owners_pending_invitations(store):
    w=store.workspaces
    former=w.invite('admin','adr','owner@example.invalid','owner')
    staff=w.invite('owner','adr','new@example.invalid','office')
    replacement=w.invite('admin','adr','a@example.invalid','owner')
    w.accept(identity('a'),replacement['invitation_id'])
    assert store.db.records['_memberships/owner']['status']=='disabled'
    assert store.db.records['_invitations/'+former['invitation_id']]['status']=='cancelled'
    assert store.db.records['_invitations/'+staff['invitation_id']]['status']=='pending'

def test_disable_company_and_membership_rechecked_inside_write(store):
    store.create_inspection('estimator',ID,data())
    store.workspaces.update_member('owner','adr','estimator',MemberUpdate(expected_version=1,role='office',status='active'))
    with pytest.raises(AccessDenied):store.update_inspection('estimator',ID,1,data('Changed'))
    store.workspaces.update_company('admin','adr',StatusUpdate(expected_version=1,status='suspended'))
    with pytest.raises(AccessDenied):store.get_inspection('office',ID)
    assert store.workspaces.principal('owner')['superadmin']


def test_company_snapshot_pricing_profile_conflict_and_signed_evidence(api):
    client,current,store=api; current['uid']='estimator'
    record=client.post('/api/inspections',json={'inspection_id':ID,'data':data()}).json()
    response=client.post('/api/audit',json={'inspection_id':ID,'expected_revision':1})
    assert response.status_code==200,response.text
    record=response.json();documents=record['audit']['documents']
    assert documents['xactimate_total']==1775 and documents['adr_estimate']['proposed_cost']==1788.9
    assert documents['company_identity']['company_id']=='adr'
    payload=dict(inspection_id=ID,expected_revision=1,auth_id='ADR-AUTH-test123456',proposal_hash=record['audit']['proposal_hash'],signature_png=png(),documents_confirmed=True)
    assert client.post('/api/authorize',json=payload).status_code==200
    current['uid']='office'
    assert client.get('/api/authorizations/'+payload['auth_id']).json()['documents']==documents
    assert client.get('/api/authorizations/'+payload['auth_id']+'/evidence/signature').status_code==200
    assert client.post('/api/authorize',json=payload).status_code==403
    current['uid']='other-owner'
    assert client.get('/api/authorizations/'+payload['auth_id']).status_code==404
    assert client.get('/api/authorizations/'+payload['auth_id']+'/evidence/signature').status_code==404
    assert store.db.records['authorizations/'+payload['auth_id']]['documents']==documents


def test_profile_changes_invalidate_unsigned_audit_and_not_signed_payload(store):
    record=store.create_inspection('estimator',ID,data())
    documents=make_documents(InspectionData.model_validate(record['data']),[],AIResult(summary='Test',suggestions=[],unpriced_work=[]),store.workspaces.snapshot('estimator'))
    record=store.save_audit('estimator',ID,1,documents)
    profile=deepcopy(ADR_PROFILE);profile['phone']='new phone'
    store.workspaces.update_company('owner','adr',ProfileUpdate(expected_version=1,profile=CompanyProfile(**profile)))
    payload=dict(inspection_id=ID,expected_revision=1,auth_id='ADR-AUTH-test123456',proposal_hash=record['audit']['proposal_hash'],signature_png=png())
    with pytest.raises(Conflict):store.authorize('estimator',payload)
    assert not store.bucket.objects


def test_other_company_has_no_adr_identity_or_trade_promise(store):
    identity=store.workspaces.snapshot('other-owner')
    documents=make_documents(InspectionData.model_validate({**data(),'water_heater_loss':True}),[],AIResult(summary='Test',suggestions=[],unpriced_work=[]),identity)
    assert 'Alert Disaster' not in documents['iicrc_defense_letter']
    assert 'Matthew Myers' not in documents['iicrc_defense_letter']
    assert not documents['signable'] and 'Water-heater coordination notice' in documents['company_setup_missing']
    assert not any('Can Do Crew' in notice for notice in documents['adr_estimate']['disclaimers'])


def test_migration_preview_idempotency_and_signed_payload_unchanged():
    original=FakeStore();original.create_inspection('legacy',ID,data())
    original.db.records['authorizations/ADR-AUTH-legacy123']=dict(auth_id='ADR-AUTH-legacy123',owner_uid='legacy',created_at='2026',payload_sha256='immutable-hash',documents={'saved':'unchanged'})
    original.db.records['authorizations/ADR-AUTH-unmapped']=dict(auth_id='ADR-AUTH-unmapped',owner_uid='unknown',created_at='2026')
    before=deepcopy(original.db.records)
    secured=FakeCompanyStore(original.db,original.bucket)
    preview=migrate(secured.workspaces,{'legacy':'legacy@example.invalid'},'legacy')
    assert preview['create']==6 and preview['unmapped_source_records']==1
    assert original.db.records==before
    report=migrate(secured.workspaces,{'legacy':'legacy@example.invalid'},'legacy',True)
    again=migrate(secured.workspaces,{'legacy':'legacy@example.invalid'},'legacy',True)
    assert report['create']==6 and again['create']==0
    for key,value in before.items():assert original.db.records[key]==value
    assert secured.get('legacy','ADR-AUTH-legacy123')['payload_sha256']=='immutable-hash'
    with pytest.raises(LookupError):secured.get('legacy','ADR-AUTH-unmapped')

@pytest.mark.parametrize('role', ['office','admin','other-owner'])
def test_live_denial_precedes_vertex(store,monkeypatch,role):
    from starlette.websockets import WebSocketDisconnect
    store.create_inspection('estimator',ID,data())
    async def verified(token):return {**identity(role),'exp':time.time()+600}
    monkeypatch.setattr(bm,'WORKSPACES_ENABLED',True)
    monkeypatch.setattr(bm,'verify_staff',verified)
    monkeypatch.setattr(bm,'get_job_store',lambda:store)
    def forbidden(**kwargs):pytest.fail('Unauthorized Live must not connect to Vertex')
    monkeypatch.setattr(bm.genai,'Client',forbidden)
    with TestClient(bm.app) as client:
        with client.websocket_connect('/api/live',headers={'origin':bm.ORIGINS[0]}) as socket:
            socket.send_json({'type':'authenticate','token':'synthetic','inspection_id':ID,'protocol_version':2,'capture_id':'f'*32})
            assert socket.receive_json()['type']=='error'
            with pytest.raises(WebSocketDisconnect):socket.receive_json()
    assert not any(k.startswith('_live_sessions/') for k in store.db.records)

def test_live_resume_fallback_keeps_company_identity(store,monkeypatch):
    from contextlib import asynccontextmanager
    from types import SimpleNamespace as NS
    from starlette.websockets import WebSocketDisconnect
    store.create_inspection('other-owner',OTHER,data())
    configs=[]
    class Session:
        async def receive(self):
            yield NS(server_content=None,session_resumption_update=NS(new_handle='synthetic-private',resumable=True))
            yield NS(server_content=None,go_away=NS(time_left=1))
    @asynccontextmanager
    async def connect(**kwargs):
        configs.append(kwargs['config'])
        if kwargs['config'].session_resumption.handle:raise RuntimeError('Synthetic expired provider handle')
        yield Session()
    async def close():pass
    async def verified(token):return {**identity('other-owner'),'exp':time.time()+600}
    monkeypatch.setattr(bm,'WORKSPACES_ENABLED',True)
    monkeypatch.setattr(bm,'verify_staff',verified)
    monkeypatch.setattr(bm,'get_job_store',lambda:store)
    monkeypatch.setattr(bm.genai,'Client',lambda **kwargs:NS(aio=NS(live=NS(connect=connect),aclose=close)))
    def auth(resume):return {'type':'authenticate','token':'synthetic','inspection_id':OTHER,'protocol_version':2,'workspace_protocol_version':1,'capture_id':'f'*32,'resume':resume}
    with TestClient(bm.app) as client:
        with client.websocket_connect('/api/live',headers={'origin':bm.ORIGINS[0]}) as socket:
            socket.send_json(auth(False));assert socket.receive_json()['recovery']=='new'
            assert socket.receive_json()['type']=='recovery'
            with pytest.raises(WebSocketDisconnect):socket.receive_json()
        assert store.db.records['_live_resume/other-owner']['handle']=='synthetic-private'
        with client.websocket_connect('/api/live',headers={'origin':bm.ORIGINS[0]}) as socket:
            socket.send_json(auth(True));response=socket.receive_json();assert response.get('recovery')=='restarted',response
            assert socket.receive_json()['type']=='recovery'
            with pytest.raises(WebSocketDisconnect):socket.receive_json()
    assert len(configs)==3 and configs[1].session_resumption.handle=='synthetic-private'
    for config in configs:
        prompt=str(config.system_instruction)
        assert 'Other Company' in prompt and 'Alert Disaster Restoration' not in prompt

@pytest.mark.parametrize('change', ['role','company','assignment'])
def test_live_rechecks_workspace_permission_and_deletes_checkpoint(store,monkeypatch,change):
    from contextlib import asynccontextmanager
    from types import SimpleNamespace as NS
    from starlette.websockets import WebSocketDisconnect
    store.create_inspection('estimator',ID,data())
    store.workspaces.coordination('owner',ID,CoordinationUpdate(expected_version=1,assigned_estimator_uid='estimator2'))
    closed=[]
    async def verified(token):return {**identity('estimator2'),'exp':time.time()+600}
    class Session:
        async def receive(self):
            yield NS(server_content=None,session_resumption_update=NS(new_handle='synthetic-private',resumable=True))
            await asyncio.Event().wait()
    @asynccontextmanager
    async def connect(**kwargs):yield Session()
    async def close():await asyncio.sleep(.02);closed.append(True)
    monkeypatch.setattr(bm,'WORKSPACES_ENABLED',True)
    monkeypatch.setattr(bm,'verify_staff',verified)
    monkeypatch.setattr(bm,'get_job_store',lambda:store)
    monkeypatch.setattr(bm,'LIVE_RECHECK_SECONDS',.02)
    monkeypatch.setattr(bm.genai,'Client',lambda **kwargs:NS(aio=NS(live=NS(connect=connect),aclose=close)))
    with TestClient(bm.app) as client:
        with client.websocket_connect('/api/live',headers={'origin':bm.ORIGINS[0]}) as socket:
            socket.send_json({'type':'authenticate','token':'synthetic','inspection_id':ID,'protocol_version':2,'capture_id':'f'*32})
            assert socket.receive_json()['type']=='ready'
            if change=='role':store.workspaces.update_member('owner','adr','estimator2',MemberUpdate(expected_version=1,role='office',status='active'))
            elif change=='company':store.workspaces.update_company('admin','adr',StatusUpdate(expected_version=1,status='suspended'))
            else:store.workspaces.coordination('owner',ID,CoordinationUpdate(expected_version=2))
            assert socket.receive_json()['type']=='error'
            with pytest.raises(WebSocketDisconnect):socket.receive_json()
    assert closed and '_live_resume/estimator2' not in store.db.records and '_live_sessions/estimator2' not in store.db.records


def test_permission_change_during_ai_prevents_commit(api,monkeypatch):
    client,current,store=api;store.create_inspection('estimator',ID,data());current['uid']='estimator'
    async def revoked(*args,**kwargs):
        store.workspaces.update_member('owner','adr','estimator',MemberUpdate(expected_version=1,role='office',status='active'))
        return AIResult(summary='Test',suggestions=[],unpriced_work=[])
    monkeypatch.setattr(bm,'generate',revoked)
    response=client.post('/api/audit',json={'inspection_id':ID,'expected_revision':1})
    assert response.status_code==403 and store.get_inspection('owner',ID)['audit'] is None


def test_firestore_transactions_finish_all_reads_before_writes(monkeypatch):
    from tests.fakes import Collection,Ref,Tx
    original_get=Ref.get
    def get(ref,transaction=None):
        assert not transaction or not getattr(transaction,'written',False),'Firestore forbids reads after transaction writes'
        return original_get(ref,transaction)
    class StrictTx(Tx):
        written=False
        def set(self,*args,**kwargs):self.written=True;return super().set(*args,**kwargs)
        def create(self,*args,**kwargs):self.written=True;return super().create(*args,**kwargs)
        def update(self,*args,**kwargs):self.written=True;return super().update(*args,**kwargs)
    class StrictStore(FakeCompanyStore):
        def _atomic(self,callback):
            with self.db.lock:return callback(StrictTx())
    monkeypatch.setattr(Ref,'get',get)
    store=seed(StrictStore());w=store.workspaces
    store.create_inspection('estimator',ID,data())
    w.coordination('owner',ID,CoordinationUpdate(expected_version=1,assigned_estimator_uid='estimator2'))
    invitation=w.invite('owner','adr','new@example.invalid','office');w.deliver('owner',invitation['invitation_id'],lambda *args:'message')
    w.accept(identity('new'),invitation['invitation_id'])
    record=store.get_inspection('estimator',ID)
    docs=make_documents(InspectionData.model_validate(record['data']),[],AIResult(summary='Test',suggestions=[],unpriced_work=[]),w.snapshot('estimator'))
    record=store.save_audit('estimator',ID,record['revision'],docs)
    store.authorize('estimator',dict(inspection_id=ID,expected_revision=record['revision'],auth_id='ADR-AUTH-strict123',proposal_hash=record['audit']['proposal_hash'],signature_png=png()))
    original_stream=Collection.stream
    def stream(collection,transaction=None):
        assert not transaction or not getattr(transaction,'written',False),'Firestore forbids reads after transaction writes'
        return original_stream(collection,transaction)
    monkeypatch.setattr(Collection,'stream',stream)
    w.invite('admin','adr','owner@example.invalid','owner');w.invite('owner','adr','new@example.invalid','office')
    w.update_member('owner','adr','new',MemberUpdate(expected_version=1,role='office',status='disabled'))
    w.accept(identity('a'),w.invite('admin','adr','a@example.invalid','owner')['invitation_id'])
    assert store.db.records['_memberships/owner']['status']=='disabled'


def test_competing_invitation_acceptance_has_one_owner(store):
    w=store.workspaces;a=w.invite('admin','adr','a@example.invalid','owner');b=w.invite('admin','adr','b@example.invalid','owner')
    def accept(invitation,name):
        try:w.accept(identity(name),invitation['invitation_id']);return True
        except Conflict:return False
    with ThreadPoolExecutor(2) as pool:
        futures=[pool.submit(accept,a,'a'),pool.submit(accept,b,'b')]
        assert sum(f.result() for f in futures)==1
    assert sum(m['role']=='owner' and m['status']=='active' for k,m in store.db.records.items() if k.startswith('_memberships/') and m['company_id']=='adr')==1


def test_migration_refreshes_old_writer_summaries_and_preserves_assignments():
    legacy=FakeStore();legacy.create_inspection('legacy',ID,data())
    secured=FakeCompanyStore(legacy.db,legacy.bucket);w=secured.workspaces
    migrate(w,{'legacy':'legacy@example.invalid'},'legacy',True)
    job=secured.db.records['_workspace_jobs/'+ID];job['office_notes']='Keep coordination';job['assigned_estimator_uid']='assigned'
    legacy.update_inspection('legacy',ID,1,data('Changed by old production writer'))
    migrate(w,{'legacy':'legacy@example.invalid'},'legacy',True)
    job=secured.db.records['_workspace_jobs/'+ID]
    assert job['address']=='Changed by old production writer' and job['office_notes']=='Keep coordination' and job['assigned_estimator_uid']=='assigned'
    secured.create_inspection('legacy',OTHER,data('New company-aware job'))
    assert migrate(w,{'legacy':'legacy@example.invalid'},'legacy',True)['create']==0


def test_company_documents_require_a_client_that_renders_saved_identity(api):
    client,current,store=api;store.create_inspection('estimator',ID,data());current['uid']='estimator'
    client.headers.pop('X-ADR-Workspace-Protocol')
    assert client.post('/api/audit',json={'inspection_id':ID,'expected_revision':1}).status_code==409
    client.headers['X-ADR-Workspace-Protocol']='1'
    record=client.post('/api/audit',json={'inspection_id':ID,'expected_revision':1}).json()
    client.headers.pop('X-ADR-Workspace-Protocol')
    assert client.get('/api/inspections/'+ID).status_code==409
    assert client.post('/api/authorize',json={}).status_code==409


def test_memberships_override_static_allowlist_and_token_role_claims(store,monkeypatch):
    from fastapi import HTTPException
    monkeypatch.setattr(bm,'WORKSPACES_ENABLED',True)
    monkeypatch.setattr(bm,'get_job_store',lambda:store)
    monkeypatch.setattr(bm.firebase_admin,'get_app',lambda name:object())
    claims={**identity('unknown'),'email':'nathanaelcnorman@gmail.com','role':'owner','superadmin':True}
    def verified(token,**kwargs):
        assert kwargs['check_revoked'] is True
        return claims
    monkeypatch.setattr(bm.firebase_auth,'verify_id_token',verified)
    with pytest.raises(HTTPException) as error:asyncio.run(bm.verify_staff('normal-client-token'))
    assert error.value.status_code==403
    claims.update(identity('office'))
    assert asyncio.run(bm.verify_staff('normal-client-token'))['uid']=='office'
    store.db.records['_memberships/office']['status']='disabled'
    with pytest.raises(HTTPException) as error:asyncio.run(bm.verify_staff('normal-client-token'))
    assert error.value.status_code==403


def verify_with(monkeypatch,enabled,changes):
    monkeypatch.setattr(bm,'WORKSPACES_ENABLED',enabled)
    monkeypatch.setattr(bm.firebase_admin,'get_app',lambda name:object())
    monkeypatch.setattr(bm.firebase_auth,'verify_id_token',lambda *args,**kwargs:{**identity('owner'),**changes})
    return asyncio.run(bm.verify_identity('normal-client-token'))


@pytest.mark.parametrize('provider',['google.com','password'])
def test_workspace_identity_accepts_verified_google_and_password(monkeypatch,provider):
    assert verify_with(monkeypatch,True,{'firebase':{'sign_in_provider':provider}})['uid']=='owner'


@pytest.mark.parametrize('changes',[{'email_verified':False},{'email_verified':False,'firebase':{'sign_in_provider':'password'}},
                                    {'firebase':{'sign_in_provider':'anonymous'}},{'firebase':{'sign_in_provider':'custom'}},{'firebase':{}},{'email':''}])
def test_workspace_identity_rejects_unverified_or_unknown_provider(monkeypatch,changes):
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as error:verify_with(monkeypatch,True,changes)
    assert error.value.status_code==403


@pytest.mark.parametrize('provider',['google.com','password','anonymous',None])
def test_legacy_identity_ignores_provider_and_requires_verified_allowlisted_email(monkeypatch,provider):
    from fastapi import HTTPException
    firebase={'sign_in_provider':provider} if provider else {}
    assert verify_with(monkeypatch,False,{'firebase':firebase})['uid']=='owner'
    with pytest.raises(HTTPException) as error:verify_with(monkeypatch,False,{'firebase':firebase,'email_verified':False})
    assert error.value.status_code==403
    monkeypatch.setattr(bm,'STAFF_EMAILS',{'staff@example.invalid'})
    with pytest.raises(HTTPException) as error:asyncio.run(bm.verify_staff('normal-client-token'))
    assert error.value.status_code==403
    bm.firebase_auth.verify_id_token=lambda *args,**kwargs:{**identity('staff'),'firebase':firebase}
    assert asyncio.run(bm.verify_staff('normal-client-token'))['email']=='staff@example.invalid'


def test_password_identity_accepts_only_its_exact_email_invitation(store):
    w=store.workspaces
    password=lambda uid:{**identity(uid),'firebase':{'sign_in_provider':'password'}}
    mine=w.invite('owner','adr','new@example.invalid','estimator')
    theirs=w.invite('owner','adr','someone@example.invalid','office')
    with pytest.raises(LookupError):w.accept(password('new'),theirs['invitation_id'])
    with pytest.raises(AccessDenied):w.accept({**password('new'),'email_verified':False},mine['invitation_id'])
    assert not w.principal('new')['role']
    assert w.accept(password('new'),mine['invitation_id'])['role']=='estimator'
    assert store.db.records['_invitations/'+theirs['invitation_id']]['status']=='pending'


@pytest.mark.parametrize('name', ['Alert Disaster Restoration','Other Company',"O'Brien & Sons (Kern) Co., Inc.",'Restauración Núñez 2','A'*80])
def test_company_names_accept_business_text(name):
    assert CompanyProfile(name=name).name==name and CompanyCreate(name=name,owner_email='x@example.invalid').name==name


@pytest.mark.parametrize('name', ['Visit https://evil.example','Go to WWW.evil.example','Line\nBreak','A'*81,'Win $500 now!','<b>Owner</b>','Pay@once'])
def test_company_names_reject_links_markup_and_long_text(api,name):
    with pytest.raises(ValidationError):CompanyProfile(name=name)
    with pytest.raises(ValidationError):CompanyCreate(name=name,owner_email='x@example.invalid')
    client,current,store=api
    response=client.put('/api/companies/adr',json={'expected_version':1,'profile':{**ADR_PROFILE,'name':name}})
    assert response.status_code==422 and 'Company name' in response.text
    assert store.db.records['_companies/adr']['profile']['name']=='Alert Disaster Restoration'


def test_invitation_subject_excludes_owner_text(mail):
    sent=mail[4]
    invite=dict(invitation_id='a'*32,send_attempt='b'*32,email='new@example.invalid',role='office')
    workspaces.send_invitation(invite,{'profile':{'name':'Owner Chosen Name'}})
    assert sent[0]['subject']=='Invitation to join a company on the ADR field app'
    assert 'Owner Chosen Name' in sent[0]['text']


def test_invitation_sends_and_resends_have_a_daily_company_cap(api,monkeypatch):
    client,current,store=api;w=store.workspaces
    monkeypatch.setattr(workspaces,'INVITATION_DAILY_LIMIT',3)
    first=w.invite('owner','adr','one@example.invalid','office')
    assert w.invite('owner','adr','one@example.invalid','office')==first
    w.invite('owner','adr','two@example.invalid','office')
    w.invitation_action('owner','adr',first['invitation_id'],'resend')
    with pytest.raises(Limited) as limited:w.invite('owner','adr','three@example.invalid','office')
    assert 86000<limited.value.retry_after<=86400
    with pytest.raises(Limited):w.invitation_action('owner','adr',first['invitation_id'],'resend')
    w.invite('other-owner','other','three@example.invalid','office')
    response=client.post('/api/companies/adr/invitations',json={'email':'four@example.invalid','role':'office'})
    assert response.status_code==429 and int(response.headers['Retry-After'])>86000
    assert not [r for r in store.db.records.values() if r.get('email') in ('three@example.invalid','four@example.invalid') and r.get('company_id')=='adr']


@pytest.fixture
def mail(api,monkeypatch):
    """Real send_invitation against fake Resend and fake Firebase Admin; records every Firestore write."""
    from tests import fakes
    sent=[];writes=[];accounts=fakes.FakeAuth()
    class Response:
        def __enter__(self):return self
        def __exit__(self,*args):return False
        def read(self,size):return b'{"id":"message"}'
    monkeypatch.setenv('RESEND_API_KEY','test-key');monkeypatch.setenv('INVITATION_FROM','ADR <invite@example.invalid>')
    monkeypatch.setattr(workspaces.urllib.request,'urlopen',lambda request,timeout:sent.append(json.loads(request.data)) or Response())
    monkeypatch.setattr(workspaces,'firebase_auth',accounts)
    monkeypatch.setattr(workspaces.firebase_admin,'get_app',lambda name:object())
    for cls,name in ((fakes.Tx,'set'),(fakes.Ref,'create')):
        def logged(self,*args,_original=getattr(cls,name),**kwargs):writes.append(json.dumps(args,default=str));return _original(self,*args,**kwargs)
        monkeypatch.setattr(cls,name,logged)
    client,current,store=api
    return client,current,store,accounts,sent,writes


def test_invitation_provisions_a_password_account_and_mails_only_its_set_password_link(mail):
    client,current,store,accounts,sent,writes=mail
    invited=client.post('/api/companies/adr/invitations',json={'email':'New@Example.invalid','role':'office'}).json()
    assert invited['delivery_status']=='sent'
    assert accounts.created==[{'email':'new@example.invalid','email_verified':False}]
    assert [(l['email'],l['url'],l['in_app']) for l in accounts.links]==[('new@example.invalid','https://alert-disaster-field-2026.web.app/',False)]
    link=accounts.links[0]['link']
    assert 'Set your password for the ADR field app: '+link in sent[0]['text']
    assert html.escape(link) in sent[0]['html'] and link not in sent[0]['html']
    assert '?invite='+invited['invitation_id'] in sent[0]['text']
    assert writes and not any('secret-oob' in w for w in writes)
    assert 'secret-oob' not in json.dumps(store.db.records,default=str) and 'secret-oob' not in json.dumps(invited)


def test_owner_invitation_for_a_new_company_provisions_the_owner_account(mail):
    client,current,store,accounts,sent,writes=mail;current['uid']='admin'
    result=client.post('/api/admin/companies',json={'name':'New California Restoration','owner_email':'boss@example.invalid'}).json()
    assert result['invitation']['delivery_status']=='sent'
    assert accounts.created==[{'email':'boss@example.invalid','email_verified':False}]
    assert accounts.links[0]['link'] in sent[0]['text'] and not any('secret-oob' in w for w in writes)


def test_google_invitee_gets_sign_in_instructions_without_link_or_new_account(mail):
    client,current,store,accounts,sent,writes=mail;accounts.add('google@example.invalid','google.com')
    assert client.post('/api/companies/adr/invitations',json={'email':'google@example.invalid','role':'office'}).json()['delivery_status']=='sent'
    assert not accounts.created and not accounts.links
    assert 'Sign in with Google using this email' in sent[0]['text'] and 'Set your password' not in sent[0]['text']+sent[0]['html']


def test_resend_reuses_the_existing_password_account_with_a_fresh_link(mail):
    client,current,store,accounts,sent,writes=mail;accounts.add('staff@example.invalid','password')
    invited=client.post('/api/companies/adr/invitations',json={'email':'staff@example.invalid','role':'office'}).json()
    resent=client.post('/api/companies/adr/invitations/'+invited['invitation_id']+'/resend',json={}).json()
    assert resent['delivery_status']=='sent' and not accounts.created
    assert [l['email'] for l in accounts.links]==['staff@example.invalid']*2
    assert [accounts.links[i]['link'] in sent[i]['text'] for i in (0,1)]==[True,True]
    assert not any('secret-oob' in w for w in writes)


def test_concurrent_account_creation_falls_back_to_the_existing_account(mail,monkeypatch):
    client,current,store,accounts,sent,writes=mail
    def created_elsewhere(email,email_verified,app=None):
        accounts.add(email,'password');raise accounts.EmailAlreadyExistsError('exists',None,None)
    monkeypatch.setattr(accounts,'create_user',created_elsewhere)
    assert client.post('/api/companies/adr/invitations',json={'email':'race@example.invalid','role':'office'}).json()['delivery_status']=='sent'
    assert accounts.links[0]['email']=='race@example.invalid' and accounts.links[0]['link'] in sent[0]['text']


def test_denied_or_rate_limited_invitations_create_no_account_and_send_nothing(mail,monkeypatch):
    client,current,store,accounts,sent,writes=mail
    monkeypatch.setattr(workspaces,'INVITATION_DAILY_LIMIT',1)
    assert client.post('/api/companies/adr/invitations',json={'email':'one@example.invalid','role':'office'}).status_code==200
    accounts.created.clear();accounts.links.clear();sent.clear()
    assert client.post('/api/companies/adr/invitations',json={'email':'two@example.invalid','role':'office'}).status_code==429
    current['uid']='office'
    assert client.post('/api/companies/adr/invitations',json={'email':'three@example.invalid','role':'office'}).status_code==403
    assert not accounts.created and not accounts.links and not sent and set(accounts.users)=={'one@example.invalid'}
