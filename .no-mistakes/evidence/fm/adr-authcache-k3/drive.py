"""Drives the running backend (uvicorn on :18765) against the Auth/Firestore emulators.
Counts Identity Toolkit accounts:lookup calls (the revoked/disabled-user check) via the proxy log."""
import json, os, sys, time, uuid, asyncio, urllib.request
os.environ['FIREBASE_AUTH_EMULATOR_HOST']='127.0.0.1:19099'
import firebase_admin
from firebase_admin import auth
import httpx, websockets
API='http://127.0.0.1:18765'; LOG='/tmp/adr-k3-emu/lookups.log'
app=firebase_admin.initialize_app(options={'projectId':'alert-disaster-field-2026'},name='driver')
def lookups(): return sum(1 for l in open(LOG) if 'accounts:lookup' in l) if os.path.exists(LOG) else 0
def p(*a): print(*a,flush=True)
def token(email):
    try: auth.delete_user(auth.get_user_by_email(email,app=app).uid,app=app)
    except auth.UserNotFoundError: pass
    auth.create_user(email=email,password='pw-123456',email_verified=True,app=app)
    r=urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:19099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake',data=json.dumps({'email':email,'password':'pw-123456','returnSecureToken':True}).encode(),headers={'Content-Type':'application/json'}))
    return json.load(r)['idToken']
c=httpx.Client(base_url=API,timeout=30)
def call(label,method,path,tok,**kw):
    before=lookups(); r=c.request(method,path,headers={'Authorization':f'Bearer {tok}'},**kw)
    d=lookups()-before; p(f'  {label:<44} -> HTTP {r.status_code:<3} lookups+{d}  {r.text[:90]!r}'); return r.status_code,d
async def ws_start(tok):
    before=lookups()
    async with websockets.connect('ws://127.0.0.1:18765/api/live',origin='https://alert-disaster-field-2026.web.app') as s:
        await s.send(json.dumps({'type':'authenticate','token':tok,'inspection_id':'ADR-INS-'+'0'*32,'protocol_version':1}))
        msgs=[]
        try:
            while True: msgs.append(await asyncio.wait_for(s.recv(),10))
        except Exception as e: close=getattr(e,'rcvd',None)
    d=lookups()-before; p(f'  {"WS /api/live walkthrough start":<44} -> msgs={[m[:90] for m in msgs]} close={close} lookups+{d}'); return msgs,d
inspection='ADR-INS-'+uuid.uuid4().hex
results={}
p('== Scenario 1-2: autosave + photo fetch reuse a passed revocation lookup ==')
t=token('tech@example.com')
s,d=call('POST /api/inspections (create, first use)','POST','/api/inspections',t,json={'inspection_id':inspection,'data':{'address':'1 Test St'}}); first=d
rev=c.get(f'/api/inspections/{inspection}',headers={'Authorization':f'Bearer {t}'}).json()['revision']
ok=True; total=0
for i in range(5):
    s,d=call(f'PUT /api/inspections/{{id}} autosave #{i+1}','PUT',f'/api/inspections/{inspection}',t,json={'expected_revision':rev,'data':{'address':f'1 Test St #{i}'}})
    ok&=s==200; total+=d
    if s==200: rev+=1
    time.sleep(1.5)
s,d=call('GET photo fetch (missing photo id)','GET',f'/api/inspections/{inspection}/photos/PHOTO-x',t); total+=d; photo_status=s
s,d=call('GET /api/session','GET','/api/session',t); total+=d
results['cached']=dict(first_lookups=first,autosaves_ok=ok,cached_lookups=total,photo_status=photo_status)
p('== Scenario 3-5: signing, evidence download, walkthrough start always check live ==')
live={}
for i in range(2):
    live.setdefault('authorize',[]).append(call('POST /api/authorize (signing)','POST','/api/authorize',t,json={}))
    live.setdefault('evidence',[]).append(call('GET evidence download','GET','/api/authorizations/ADR-AUTH-missing1/evidence/proposal.pdf',t))
    live.setdefault('ws',[]).append(asyncio.run(ws_start(t))[1])
results['live']=live
p('== Scenario 6: revoke the sign-in; sensitive routes reject at once, cached routes within the TTL only ==')
time.sleep(1.2); uid=auth.get_user_by_email('tech@example.com',app=app).uid
auth.revoke_refresh_tokens(uid,app=app); revoked_at=time.time(); p(f'  revoked refresh tokens for {uid} at {revoked_at:.0f}')
rv={}
rv['autosave_within_ttl']=call('PUT autosave right after revoke (cached)','PUT',f'/api/inspections/{inspection}',t,json={'expected_revision':rev,'data':{'address':'after revoke'}})
rv['authorize']=call('POST /api/authorize after revoke','POST','/api/authorize',t,json={})
rv['evidence']=call('GET evidence after revoke','GET','/api/authorizations/ADR-AUTH-missing1/evidence/proposal.pdf',t)
msgs,d=asyncio.run(ws_start(t)); rv['ws']=(msgs,d)
# A live failure drops the cache entry, so the next ordinary request also rejects.
rv['autosave_after_live_fail']=call('PUT autosave after a live route saw the revocation','PUT',f'/api/inspections/{inspection}',t,json={'expected_revision':rev+1,'data':{'address':'x'}})
results['revoked']=rv
p('== Scenario 7: revoked token on cached-only traffic expires within 45 s ==')
t2=token('tech@example.com')  # recreated user; fresh token
call('GET /api/session (prime cache)','GET','/api/session',t2)
time.sleep(1.2); auth.revoke_refresh_tokens(auth.get_user_by_email('tech@example.com',app=app).uid,app=app); t0=time.time()
seq=[]
while time.time()-t0<50:
    s,d=call(f'GET /api/session t+{time.time()-t0:4.1f}s','GET','/api/session',t2); seq.append((round(time.time()-t0,1),s,d))
    if s==401: break
    time.sleep(5)
results['ttl']=seq
p('== Scenario 8: disabled account blocked live at walkthrough start ==')
t3=token('tech@example.com'); call('GET /api/session (prime cache)','GET','/api/session',t3)
auth.update_user(auth.get_user_by_email('tech@example.com',app=app).uid,disabled=True,app=app)
results['disabled']=dict(session=call('GET /api/session after disable (cached)','GET','/api/session',t3),
                         authorize=call('POST /api/authorize after disable','POST','/api/authorize',t3,json={}),
                         ws=asyncio.run(ws_start(t3)))
p('== RESULTS =='); p(json.dumps(results,indent=1,default=str))
